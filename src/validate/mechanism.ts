import type { ImplementationFact } from "../adapters/types.js";
import type { ModelGraph } from "../loader/model-graph.js";
import { anchorFilePath, anchorSymbol } from "./anchor.js";
import { type ReadRepoFile, resolveDelegation, symbolLineSpan } from "./delegation.js";
import type { Violation } from "./types.js";

/**
 * "This loop says it is driven by a timer — is there still a timer where it
 * points?"
 *
 * THE GAP THIS CLOSES. File-existence and name-presence both pass on the
 * classic god-file split: the entry point stays, the `setInterval` moves to a
 * new service, the model keeps pointing at a one-line wrapper. Nothing in the
 * anchor tiers can see that, because nothing about the anchor changed — what
 * changed is that the behaviour left. The only evidence available is the
 * adapter's extracted facts, so this check lives with them (reconcile), not in
 * T0.
 *
 * OPT-IN, AND THAT IS THE DESIGN, NOT A COMPROMISE. `mechanism` is absent on
 * every existing node in every existing model, and an absent declaration is
 * checked against nothing. A model adopts this one batch at a time, on loops
 * whose anchors someone has actually looked at. Turning it on globally would
 * mean grading 39 paper loops against facts they never claimed to have, and a
 * check that opens with dozens of warnings is a check nobody reads again.
 *
 * NO SUPPRESSION FLAG. There is deliberately no `delegated: true` /
 * `skip: true` escape hatch: an opt-out that turns a warning green on request
 * rebuilds the exact false-green this whole change is about. If a warning here
 * is wrong, the fix is a better anchor (or one fewer mechanism claim), not a
 * mute button.
 */

/** Mechanism vocabulary a Loop may declare. Matched against adapter fact kinds by word. */
export const MECHANISMS = ["poller", "queue"] as const;
export type Mechanism = (typeof MECHANISMS)[number];

/**
 * A fact satisfies a mechanism when its signal kind CONTAINS the mechanism
 * word: `setinterval_poller` satisfies `poller`, `pg_boss_queue` satisfies
 * `queue`.
 *
 * Loose on purpose. Signal kinds are adapter vocabulary — a repo on a
 * different queue technology names its kinds differently, and the engine has
 * no business holding a table of them. Word containment lets any adapter opt
 * in by naming its kinds the obvious way, with no interface change and no
 * registry to keep in sync.
 */
function satisfies(fact: ImplementationFact, mechanism: Mechanism): boolean {
  return fact.signal.toLowerCase().includes(mechanism);
}

export interface MechanismCheckOptions {
  /** Reads a repo-relative file; used to follow one delegation hop. */
  readFile: ReadRepoFile;
  /** Follow one hop through a delegating wrapper. Default true. */
  followDelegation?: boolean | undefined;
}

/**
 * Advisory warnings for loops whose declared mechanism is not backed by any
 * fact in the files they anchor (after following at most one delegation hop).
 */
export function checkLoopMechanism(
  graph: ModelGraph,
  facts: readonly ImplementationFact[],
  options: MechanismCheckOptions,
): Violation[] {
  const followDelegation = options.followDelegation ?? true;
  const byFile = new Map<string, ImplementationFact[]>();
  for (const fact of facts) {
    const list = byFile.get(fact.filePath);
    if (list) list.push(fact);
    else byFile.set(fact.filePath, [fact]);
  }

  const violations: Violation[] = [];
  for (const loop of graph.byKind.loop.values()) {
    if (loop.dormant) continue;
    const declared = loop.mechanism;
    if (!declared || declared.length === 0) continue;

    for (const mechanism of declared) {
      const anchorFiles = loop.anchors
        .map((a) => ({ anchor: a, file: anchorFilePath(a), symbol: anchorSymbol(a) }))
        .filter((a): a is { anchor: string; file: string; symbol: string | undefined } => !!a.file);

      if (anchorFiles.length === 0) {
        violations.push({
          check: "loop-mechanism",
          severity: "warning",
          message: `${loop.id} declares mechanism "${mechanism}" but carries no anchors — nothing to verify it against`,
          nodeId: loop.id,
        });
        continue;
      }

      const direct = anchorFiles.some((a) =>
        (byFile.get(a.file) ?? []).some((f) => satisfies(f, mechanism)),
      );
      if (direct) continue;

      // Nothing here — did the behaviour move one hop away behind a wrapper?
      // A hop counts as evidence ONLY when the fact sits inside the delegated
      // method's own line span. Landing in the right file proves nothing: a
      // service file holds many methods, and accepting any timer in it would
      // re-open the same false green one hop further out.
      const hops: string[] = [];
      let viaDelegation = false;
      // The hop that actually satisfied the mechanism, for the info Violation
      // below — `hops` records every hop ATTEMPTED (useful in the failure
      // message), this records the one that WORKED.
      let satisfiedHop: string | undefined;
      if (followDelegation) {
        // Keyed by file#symbol, not by file: two anchors on one loop may delegate
        // into the SAME collaborator's different methods, and de-duping by file
        // alone would drop the second hop unexamined.
        const visited = new Set(anchorFiles.map((a) => `${a.file}#${a.symbol ?? ""}`));
        for (const a of anchorFiles) {
          if (!a.symbol) continue;
          const content = options.readFile(a.file);
          if (content === null) continue;
          const target = resolveDelegation(
            a.file,
            content,
            a.symbol.split(".")[0] ?? "",
            options.readFile,
          );
          if (!target) continue;
          const key = `${target.filePath}#${target.symbol}`;
          if (visited.has(key)) continue;
          visited.add(key);
          const hop = `${a.anchor} → ${key}`;
          hops.push(hop);

          const targetSource = options.readFile(target.filePath);
          if (targetSource === null) continue;
          const span = symbolLineSpan(target.filePath, targetSource, target.symbol);
          if (!span) continue;
          const inSpan = (byFile.get(target.filePath) ?? []).some(
            (f) => satisfies(f, mechanism) && f.line >= span.start && f.line <= span.end,
          );
          if (inSpan) {
            viaDelegation = true;
            satisfiedHop ??= hop; // first one that worked; more hops may still be scanned below
          }
        }
      }
      if (viaDelegation) {
        // Positive finding, not a defect — `severity: "info"` (never fails
        // anything, see types.ts). Without this, "verified via delegation"
        // and "this check never ran" both produce zero violations for this
        // loop, and a CI log can't tell them apart. The `--no-follow-
        // delegation` flag exists precisely so a reader CAN tell them apart:
        // flip it off and this line should turn into the "no X fact" warning.
        violations.push({
          check: "loop-mechanism",
          severity: "info",
          message: `${loop.id} mechanism "${mechanism}" verified via delegation: ${satisfiedHop}`,
          nodeId: loop.id,
        });
        continue;
      }

      const scanned = anchorFiles.map((a) => a.file).join(", ");
      const found = anchorFiles
        .flatMap((a) => byFile.get(a.file) ?? [])
        .map((f) => f.signal)
        .filter((s, i, all) => all.indexOf(s) === i);
      const hopNote = hops.length > 0 ? `; followed delegation ${hops.join(", ")}` : "";
      violations.push({
        check: "loop-mechanism",
        severity: "warning",
        message: `${loop.id} declares mechanism "${mechanism}" but no "${mechanism}" fact was found in its anchor file(s) [${scanned}]${hopNote} — found: ${found.length > 0 ? found.join(", ") : "no facts at all"}. Either the behaviour moved out of the anchored file (re-anchor it) or the declaration is wrong.`,
        nodeId: loop.id,
      });
    }
  }
  return violations;
}
