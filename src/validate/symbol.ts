/**
 * "Does this file still mention this name at all?" — the strongest claim a
 * syntax-only check can honestly make about an anchor's symbol.
 *
 * WHY NOT A DECLARATION LOOKUP. That was the first implementation, and the
 * first real model it met refuted it in one run: 14 warnings, every one a
 * false positive. Anchors do not follow a single convention, because the
 * things they point at do not:
 *   - a loop anchors a declaration       → `service.ts#startTimer`
 *   - a scenario anchors a test BLOCK    → `x.test.ts#doThing`, matching
 *                                          `describe("Svc.doThing (rule-3)")`
 *   - a scenario anchors a CALL SITE     → the name only ever appears as
 *                                          `svc.doThing(…)` inside the spec
 *   - a scenario anchors a DOCUMENTED    → the name appears once, in the doc
 *     behaviour                            comment explaining what is covered
 * A declaration-only rule calls the last three stale. They are not stale; they
 * are anchors to test coverage, which is what `verified_by` is FOR.
 *
 * So the rule is deliberately weak and provably quiet: whole-word presence in
 * the file's text. What it still catches is the case that actually rots — a
 * symbol renamed or deleted disappears from the file entirely, comments and
 * call sites included. What it gives up is detecting a symbol that survives
 * only in prose. That trade is the right way round: this tier is advisory, and
 * an advisory check that cries wolf gets muted, after which it detects nothing
 * at all.
 *
 * Behaviour that moved OUT of an anchored file while keeping its name — the
 * one-line delegating wrapper left behind by a god-file split — is invisible
 * here by construction. That is what the loop-mechanism check is for.
 */

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

/** True when the path looks like a TS/JS source file worth scanning. */
export function isParseableSource(filePath: string): boolean {
  const dot = filePath.lastIndexOf(".");
  if (dot === -1) return false;
  return SOURCE_EXTENSIONS.has(filePath.slice(dot).toLowerCase());
}

/** Whole-word match: "doThing" hits "doThing(41)" and "`doThing` re-seeds", not "doThingAll". */
export function mentionsWord(haystack: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`).test(haystack);
}

/**
 * Does `filePath`'s content still mention `symbol`?
 * `undefined` means "cannot tell" and MUST NOT be reported as missing.
 *
 * A dotted anchor symbol (`SessionEventSchema.idle_warning`) is matched on its
 * FIRST segment only: the tail names a member of a value — a zod field, an enum
 * case, an object key — and proving those exist means evaluating the module.
 * The head is the part a rename would break, so it is the part worth checking.
 */
export function fileMentionsSymbol(
  filePath: string,
  content: string,
  symbol: string,
): boolean | undefined {
  if (!isParseableSource(filePath)) return undefined;
  const head = symbol.split(".")[0];
  if (!head) return undefined;
  return mentionsWord(content, head);
}
