import ts from "typescript";
import type { Inv1Config } from "./config.js";

/**
 * INV-1 write-site scanner (Proposal 006 A6). A PURE function of
 * `(filePath, content, config)` — no file I/O, no git, no TS type-checking.
 * It parses `content` with `ts.createSourceFile` (a pure in-memory syntax
 * parse) and walks the AST for drizzle guarded-column write expressions.
 *
 * Purity is load-bearing: it is the precondition for the B3 machine-level
 * cache, whose key is `hash(adapter_version, blob_oid, config_hash)` — same
 * bytes + same config ⇒ same result, so config is an explicit parameter, never
 * read from disk inside here.
 *
 * Why AST, not regex (acceptance (a) = no false-negatives): a regex can only
 * find the forms it anticipates, so an unrecognized guarded write becomes a
 * SILENT miss. Walking the AST classifies every guarded-table write chain, so
 * anything not confidently analyzable falls into `unanalyzable` by
 * construction — the conservative, human-review bucket. Chain SHAPE also
 * disambiguates drizzle `db.update(runs).set({...})` from lookalikes like
 * `hash.update(x).digest()` (no `.set`) without needing types.
 *
 * Recognized guarded-table transition-write forms:
 *   - `update(TABLE).set(...)`
 *   - `insert(TABLE)…onConflictDoUpdate({ set: {...} })` (an upsert IS a
 *     transition, so it is classified, not silently skipped)
 * TABLE is resolved from a bare identifier via: config.guardedTables →
 * config.aliases → file-local `const X = <guardedTable>` aliases (pre-scanned).
 *
 * Documented residual false-negatives (no data-flow/type analysis, on purpose,
 * to keep the parse pure and within T0's <5s budget): a guarded table reached
 * through a *renamed method* (`const u = db.update; u(runs)`) or a *reassigned /
 * parameter-passed* table binding is not resolved. Pure `insert(TABLE).values`
 * (row creation, i.e. INITIAL state, not a transition) is deliberately out of
 * INV-1's transition scope. None of these forms occur in the current target today (verified);
 * recorded here rather than left silent.
 */

export type WriteVerdict = "allowed" | "violation" | "unanalyzable";

export interface WritePoint {
  filePath: string;
  /** 1-based line, for a human reading the report — deliberately NOT used as a stable anchor. */
  line: number;
  /** Resolved guarded table identifier, or null for a dynamic (non-identifier) table expression. */
  table: string | null;
  columns: string[] | "opaque";
  verdict: WriteVerdict;
  reason: string;
  snippet: string;
}

type Columns = string[] | "opaque";

/** True if `filePath` is under (or equal to) one of the prefixes, matched at a path boundary. */
function underAnyPrefix(filePath: string, prefixes: string[]): boolean {
  const norm = filePath.replace(/\\/g, "/");
  return prefixes.some((p) => {
    const pfx = p.replace(/\\/g, "/").replace(/\/$/, "");
    return norm === pfx || norm.startsWith(`${pfx}/`);
  });
}

/** Columns named by an object literal's keys, or "opaque" for a spread / computed key / non-object. */
function columnsOfObjectLiteral(expr: ts.Expression | undefined): Columns {
  if (!expr || !ts.isObjectLiteralExpression(expr)) return "opaque"; // .set(variable) etc.
  const cols: string[] = [];
  for (const prop of expr.properties) {
    if (ts.isSpreadAssignment(prop)) return "opaque"; // {...base} may hide a guarded column
    if (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) {
      const name = prop.name;
      if (ts.isIdentifier(name) || ts.isStringLiteral(name)) cols.push(name.text);
      else return "opaque"; // computed property name — can't resolve statically
    } else {
      return "opaque"; // method / accessor — treat conservatively
    }
  }
  return cols;
}

/** The `set:` value inside an `onConflictDoUpdate({ target, set })` argument. */
function columnsOfOnConflictSet(arg: ts.Expression | undefined): Columns {
  if (!arg || !ts.isObjectLiteralExpression(arg)) return "opaque";
  for (const prop of arg.properties) {
    if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === "set") {
      return columnsOfObjectLiteral(prop.initializer);
    }
    // A shorthand `{ set }` means `set` is a variable reference — its columns
    // aren't visible, which is exactly "opaque". Fall through to the opaque
    // return below rather than special-casing to the same result.
  }
  return "opaque"; // no static `set: {…}` property found (absent, or shorthand/variable)
}

/**
 * Descends a `db.insert(T).values(...).onConflictDoUpdate(...)` / `db.update(T).set(...)`
 * receiver chain to the `insert`/`update` call and returns its first argument
 * (the table expression), or undefined if the chain has no such call.
 */
function tableArgInChain(node: ts.Node): ts.Expression | undefined {
  let cur: ts.Node = node;
  while (ts.isCallExpression(cur) && ts.isPropertyAccessExpression(cur.expression)) {
    const method = cur.expression.name.text;
    if (method === "insert" || method === "update") return cur.arguments[0];
    cur = cur.expression.expression;
  }
  return undefined;
}

export function scanFileForGuardedWrites(
  filePath: string,
  content: string,
  config: Inv1Config,
): WritePoint[] {
  const src = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const points: WritePoint[] = [];

  const anyGuardedAllowlist = Object.values(config.guardedTables).flatMap((t) => t.allowlist);
  const inAnyAllowlist = underAnyPrefix(filePath, anyGuardedAllowlist);
  const inExceptions = underAnyPrefix(filePath, config.unanalyzableExceptions);

  const configResolve = (ident: string): string | undefined => {
    if (config.guardedTables[ident]) return ident;
    const canon = config.aliases[ident];
    return canon && config.guardedTables[canon] ? canon : undefined;
  };

  // Pre-scan file-local aliases: `const X = runs` (initializer is a guarded
  // table identifier). Bounded, pure; closes the local-alias gap without
  // flagging every non-guarded update as unanalyzable.
  const localAliases = new Map<string, string>();
  (function collectAliases(node: ts.Node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isIdentifier(node.initializer)
    ) {
      const resolved = configResolve(node.initializer.text);
      if (resolved) localAliases.set(node.name.text, resolved);
    }
    ts.forEachChild(node, collectAliases);
  })(src);

  const resolveTable = (ident: string): string | undefined =>
    configResolve(ident) ?? localAliases.get(ident);

  const lineOf = (node: ts.Node) => src.getLineAndCharacterOfPosition(node.getStart(src)).line + 1;
  const snippetOf = (node: ts.Node) =>
    content.slice(node.getStart(src), node.getEnd()).replace(/\s+/g, " ").trim().slice(0, 120);

  function classify(
    tableArg: ts.Expression | undefined,
    columns: Columns,
    at: ts.Node,
    form: string,
  ) {
    // Dynamic table (non-identifier): could be a guarded table via a variable.
    if (!tableArg || !ts.isIdentifier(tableArg)) {
      if (inExceptions || inAnyAllowlist) return; // db-generic primitive, or a canonical-writer file → not surfaced
      points.push({
        filePath,
        line: lineOf(at),
        table: null,
        columns: "opaque",
        verdict: "unanalyzable",
        reason: `dynamic table expression in ${form} outside every writer allowlist — cannot confirm it is not a guarded write`,
        snippet: snippetOf(at),
      });
      return;
    }

    const table = resolveTable(tableArg.text);
    if (!table) return; // a bare identifier that is not a guarded table → a write to some other table, ignore

    const guarded = config.guardedTables[table];
    if (!guarded) return; // unreachable (resolveTable guarantees it), guard not assertion

    // Two orthogonal facts, kept as distinct booleans for clarity: whether the
    // column set is knowable at all, and (if it is) whether it touches a
    // guarded column.
    const isOpaque = columns === "opaque";
    const guardedCols = isOpaque ? [] : columns.filter((c) => guarded.columns.includes(c));
    if (!isOpaque && guardedCols.length === 0) return; // writes only non-guarded columns → not an INV-1 concern

    const allowed = underAnyPrefix(filePath, guarded.allowlist);
    const base = { filePath, line: lineOf(at), table, columns, snippet: snippetOf(at) } as const;
    if (allowed) {
      points.push({
        ...base,
        verdict: "allowed",
        reason: isOpaque
          ? `opaque ${form} to guarded table ${table}, but writer file is in its allowlist`
          : `guarded column write to ${table} from an allowlisted canonical writer`,
      });
    } else if (!isOpaque) {
      points.push({
        ...base,
        verdict: "violation",
        reason: `writes guarded column(s) [${guardedCols.join(", ")}] of ${table} from outside its writer allowlist (${guarded.allowlist.join(", ")})`,
      });
    } else {
      points.push({
        ...base,
        verdict: "unanalyzable",
        reason: `opaque ${form} to guarded table ${table} outside its writer allowlist — may write a guarded column`,
      });
    }
  }

  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      // `<x>.update(TABLE).set(SET)` — the drizzle update chain. Lookalikes
      // (`hash.update(x).digest()`) have no `.set` and never reach here.
      if (method === "set") {
        const recv = node.expression.expression;
        if (
          ts.isCallExpression(recv) &&
          ts.isPropertyAccessExpression(recv.expression) &&
          recv.expression.name.text === "update"
        ) {
          classify(
            recv.arguments[0],
            columnsOfObjectLiteral(node.arguments[0]),
            recv,
            "update().set()",
          );
        }
      } else if (method === "onConflictDoUpdate") {
        // `<x>.insert(TABLE)…onConflictDoUpdate({ set: {...} })` — an upsert is a
        // conditional transition, so it is classified, not silently skipped.
        const tableArg = tableArgInChain(node);
        if (tableArg) {
          classify(
            tableArg,
            columnsOfOnConflictSet(node.arguments[0]),
            node,
            "onConflictDoUpdate()",
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(src);
  return points;
}
