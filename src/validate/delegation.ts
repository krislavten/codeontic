import ts from "typescript";

/**
 * One-hop delegation resolution: given `file#symbol`, if that symbol's whole
 * body is a hand-off to another object's method, say which file the real
 * implementation lives in.
 *
 * WHY THIS EXISTS. Splitting a god-file is the single most common refactor in
 * a maturing codebase, and the polite way to do it leaves the old entry point
 * standing:
 *
 *     private startKeepAlive(id: string) {
 *       return this.lifecycle.startKeepAlive(id);   // ← what remains of a god-file
 *     }
 *
 * with the `setInterval` now in a freshly extracted service file. Every
 * file-level and name-level check stays green: the file exists, the symbol
 * exists, only the BEHAVIOUR moved. This is not hypothetical — a target repo
 * shipped exactly this shape and its model kept reporting healthy afterwards.
 *
 * SCOPE, DELIBERATELY SMALL:
 *  - one hop, no transitive chase (`visited` guards the trivial cycle anyway);
 *  - only a single-statement body — `return x.y(…)` or `x.y(…)`. A wrapper that
 *    does anything else is not a delegation, it is code, and its behaviour
 *    genuinely lives where the anchor says;
 *  - only relative imports. A hand-off into a workspace package is a real
 *    architectural boundary; following it would need module resolution, which
 *    is the road to false reds (see symbol.ts).
 * Anything it cannot resolve returns `undefined` — "no opinion" — never a
 * guess. A wrong hop would silence a real finding, which is worse than not
 * hopping at all.
 */

const RESOLVE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

/** Callback that reads a repo-relative path, or returns null when it does not exist. */
export type ReadRepoFile = (repoRelativePath: string) => string | null;

function scriptKindOf(filePath: string): ts.ScriptKind {
  if (filePath.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (filePath.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.(js|mjs|cjs)$/.test(filePath)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function parse(filePath: string, content: string): ts.SourceFile {
  return ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    false,
    scriptKindOf(filePath),
  );
}

/** `a/b/c.ts` + `./sub/x.js` → `a/b/sub/x.js` (POSIX-only; anchors are repo-relative). */
function joinRelative(fromFile: string, specifier: string): string {
  const segments = fromFile.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === "." || part === "") continue;
    if (part === "..") segments.pop();
    else segments.push(part);
  }
  return segments.join("/");
}

/**
 * TS source for a module specifier written the ESM way (`./x.js` on disk is
 * `./x.ts`), plus the bare and `/index` forms. Returns the first path the repo
 * actually has.
 */
function resolveModulePath(fromFile: string, specifier: string, read: ReadRepoFile): string | null {
  const base = joinRelative(fromFile, specifier);
  const withoutExt = base.replace(/\.(js|mjs|cjs|jsx)$/, "");
  // Deduped and .ts-first: an ESM specifier ending in `.js` produces the same
  // string twice otherwise, and on a case-insensitive filesystem a redundant
  // probe is a chance to match the wrong file, not just wasted I/O.
  const candidates = new Set([
    ...RESOLVE_EXTENSIONS.map((e) => `${withoutExt}${e}`),
    base,
    ...RESOLVE_EXTENSIONS.map((e) => `${withoutExt}/index${e}`),
  ]);
  for (const candidate of candidates) if (read(candidate) !== null) return candidate;
  return null;
}

/** The declaration of `symbol` anywhere in the file (method, function, or property). */
function findDeclaration(src: ts.SourceFile, symbol: string): ts.Node | undefined {
  let found: ts.Node | undefined;
  const visit = (node: ts.Node): void => {
    if (found) return;
    const named = node as ts.Node & { name?: ts.Node };
    if (
      (ts.isMethodDeclaration(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isPropertyDeclaration(node) ||
        ts.isVariableDeclaration(node)) &&
      named.name &&
      ts.isIdentifier(named.name) &&
      named.name.text === symbol
    ) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(src, visit);
  return found;
}

/** For a single-statement body `return x.y(…)` / `x.y(…)`, the receiver+method names. */
function soleDelegationCall(node: ts.Node): { receiver: string; method: string } | undefined {
  const body = (node as ts.Node & { body?: ts.Node }).body;
  if (!body || !ts.isBlock(body) || body.statements.length !== 1) return undefined;
  const stmt = body.statements[0];
  if (!stmt) return undefined;
  const expr = ts.isReturnStatement(stmt)
    ? stmt.expression
    : ts.isExpressionStatement(stmt)
      ? stmt.expression
      : undefined;
  if (!expr) return undefined;
  const call = ts.isAwaitExpression(expr) ? expr.expression : expr;
  if (!ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression))
    return undefined;
  const target = call.expression; // <receiverExpr>.<method>
  const method = target.name.text;
  const recv = target.expression;
  if (ts.isPropertyAccessExpression(recv) && recv.expression.kind === ts.SyntaxKind.ThisKeyword)
    return { receiver: recv.name.text, method }; // this.<field>.<method>(…)
  if (ts.isIdentifier(recv)) return { receiver: recv.text, method }; // <ident>.<method>(…)
  return undefined;
}

/** Declared type name of a class field or constructor parameter property. */
function fieldTypeName(src: ts.SourceFile, field: string): string | undefined {
  let type: string | undefined;
  const visit = (node: ts.Node): void => {
    if (type) return;
    if (
      (ts.isPropertyDeclaration(node) || ts.isParameter(node) || ts.isVariableDeclaration(node)) &&
      ts.isIdentifier(node.name) &&
      node.name.text === field &&
      node.type &&
      ts.isTypeReferenceNode(node.type) &&
      ts.isIdentifier(node.type.typeName)
    ) {
      type = node.type.typeName.text;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(src, visit);
  return type;
}

/** Module specifier that brings `name` into this file, if any. */
function importSpecifierFor(src: ts.SourceFile, name: string): string | undefined {
  let spec: string | undefined;
  for (const stmt of src.statements) {
    if (spec) break;
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const bindings = stmt.importClause?.namedBindings;
    const matchesNamed =
      bindings &&
      ts.isNamedImports(bindings) &&
      bindings.elements.some((e) => e.name.text === name || e.propertyName?.text === name);
    const matchesDefault = stmt.importClause?.name?.text === name;
    if (matchesNamed || matchesDefault) spec = stmt.moduleSpecifier.text;
  }
  return spec;
}

export interface DelegationTarget {
  /** Repo-relative file the implementation was handed off to. */
  filePath: string;
  /** Method name on the far side (usually, but not always, the same name). */
  symbol: string;
}

/**
 * If `symbol` in `filePath` is a one-line hand-off to a method on an imported
 * collaborator, return where that collaborator lives. `undefined` otherwise —
 * including every case this cannot read confidently.
 */
export function resolveDelegation(
  filePath: string,
  content: string,
  symbol: string,
  read: ReadRepoFile,
): DelegationTarget | undefined {
  const src = parse(filePath, content);
  const decl = findDeclaration(src, symbol);
  if (!decl) return undefined;
  const call = soleDelegationCall(decl);
  if (!call) return undefined;

  // `this.sandbox.start(…)` → what type is `sandbox`? `foo.start(…)` → what is `foo`?
  const typeName = fieldTypeName(src, call.receiver) ?? call.receiver;
  const specifier = importSpecifierFor(src, typeName);
  if (!specifier || !specifier.startsWith(".")) return undefined; // bare/package import: not ours to follow
  const target = resolveModulePath(filePath, specifier, read);
  if (!target) return undefined;
  return { filePath: target, symbol: call.method };
}

/**
 * The 1-based line span of `symbol`'s declaration in a file, or `undefined`
 * when it is not declared there.
 *
 * This is what makes a delegation hop mean something. Landing in the right
 * FILE is not evidence: a service file typically holds several methods, and if
 * any unrelated one happens to start a timer, a file-level check would call the
 * loop verified while the method we actually followed does nothing of the kind
 * — the same false green this whole change exists to remove, reintroduced one
 * hop further out. Pairing the span with a fact's line pins the evidence to the
 * method the wrapper actually delegates to.
 */
export function symbolLineSpan(
  filePath: string,
  content: string,
  symbol: string,
): { start: number; end: number } | undefined {
  const src = parse(filePath, content);
  const decl = findDeclaration(src, symbol);
  if (!decl) return undefined;
  const start = src.getLineAndCharacterOfPosition(decl.getStart(src)).line + 1;
  const end = src.getLineAndCharacterOfPosition(decl.getEnd()).line + 1;
  return { start, end };
}
