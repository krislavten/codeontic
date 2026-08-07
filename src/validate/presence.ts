import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { TestTextAnchor } from "../schema/model.js";
import { testTextAnchorLabel } from "../schema/model.js";
import { anchorFilePath, anchorSymbol, hasParentTraversalSegment } from "./anchor.js";
import { fileContainsCruxText } from "./crux.js";
import { fileMentionsSymbol, isParseableSource } from "./symbol.js";

/**
 * Upper bound on a file scanned for an anchor's symbol/text. Generated bundles
 * and emitted schemas can run to megabytes; reading one to answer "is this name
 * still here?" costs more than the answer is worth, so oversized files are
 * treated as UNKNOWN (never as missing).
 */
export const MAX_SYMBOL_SCAN_BYTES = 2_000_000;

/**
 * One filesystem pass answering both questions an anchor can be wrong about:
 * does its file exist, and does that file still carry the thing it names.
 *
 * WHY THIS IS SHARED (Proposal 016 T6 / D1). `check` has asked the second
 * question since A7 (`anchor-symbol`), but `conformance` only ever stat'd the
 * file, so a renamed symbol left the report card untouched: on a real target,
 * the model's ONLY `met` node stood on 5 test anchors that named nothing in
 * their files, and `check` said so while the score said 1 met. Two modules
 * answering the same question two ways is how a report card ends up
 * contradicting the checker that runs beside it, so there is now one answer
 * and both consume it.
 *
 * FOUR WAYS TO NOT KNOW, and none of them is "stale":
 *   - the path is not a TS/JS source file (docs, SQL, config);
 *   - the file is over `MAX_SYMBOL_SCAN_BYTES`;
 *   - the file cannot be read (a directory, a permission);
 *   - `fileMentionsSymbol` declines to judge.
 * Every one of these leaves the anchor OUT of the stale sets, because the
 * whole design of this tier is that it may only say "definitely gone" (see
 * symbol.ts on why the rule is deliberately weak). An advisory signal that
 * guesses gets muted, and a muted signal detects nothing.
 */
export interface AnchorPresence {
  /** Repo-relative paths that exist on disk (the same set conformance stat'd before). */
  existingFiles: Set<string>;
  /** Anchor strings whose file exists but no longer mentions the symbol. */
  staleSymbolAnchors: Set<string>;
  /** `testTextAnchorLabel` keys whose file exists but no longer contains the text. */
  staleTextAnchors: Set<string>;
}

export interface AnchorPresenceRequest {
  /** `path#symbol` (or table) anchor strings. Table anchors are ignored — no file. */
  anchors: Iterable<string>;
  /** `{file, text}` test anchors, matched with the crux matcher. */
  textAnchors?: Iterable<TestTextAnchor> | undefined;
}

/**
 * Resolve every anchor's file existence and symbol/text presence under
 * `repoRoot`, reading each distinct file AT MOST ONCE.
 *
 * The dedup is what keeps this inside the deterministic tier's sub-second,
 * zero-LLM, zero-network budget: a model anchors N nodes into far fewer files
 * (a real 60-node model: 191 anchors over 96 files), and the previous
 * per-anchor `readFile` in `checkAnchorExistence` re-read the same worker file
 * once per anchor on it.
 */
export async function resolveAnchorPresence(
  repoRoot: string,
  request: AnchorPresenceRequest,
): Promise<AnchorPresence> {
  // file → the anchors/texts asking about it, so each file is opened once.
  const symbolsByFile = new Map<string, { anchor: string; symbol: string }[]>();
  const textsByFile = new Map<string, TestTextAnchor[]>();
  const files = new Set<string>();

  for (const anchor of request.anchors) {
    const file = anchorFilePath(anchor);
    if (file === undefined) continue; // table anchor — no file to resolve
    // Containment re-asserted right before the filesystem is touched, same as
    // checkAnchorExistence (see anchor.ts on why it lives in BOTH places).
    // This module goes further than access(): it READS matching files to grep
    // for the symbol/text, so a traversal segment would turn a malformed model
    // into a yes/no oracle over out-of-repo files. Skipped = unknown, not stale.
    if (hasParentTraversalSegment(file)) continue;
    files.add(file);
    const symbol = anchorSymbol(anchor);
    if (symbol === undefined || symbol.length === 0) continue;
    const bucket = symbolsByFile.get(file);
    if (bucket) bucket.push({ anchor, symbol });
    else symbolsByFile.set(file, [{ anchor, symbol }]);
  }
  for (const text of request.textAnchors ?? []) {
    if (hasParentTraversalSegment(text.file)) continue; // same containment rule
    files.add(text.file);
    const bucket = textsByFile.get(text.file);
    if (bucket) bucket.push(text);
    else textsByFile.set(text.file, [text]);
  }

  const existingFiles = new Set<string>();
  const staleSymbolAnchors = new Set<string>();
  const staleTextAnchors = new Set<string>();

  await Promise.all(
    [...files].map(async (file) => {
      const absolute = join(repoRoot, file);
      // A single `stat` answers existence AND the size gate, where the old
      // code paid an `access` + a `stat` for the same file. Existence is
      // "stat succeeds", NOT "is a regular file": `packages/schemas#Event`
      // (a directory path) is a documented anchor shape (see anchor.ts), and
      // it is filtered out below by `isParseableSource` anyway.
      const size = await stat(absolute)
        .then((s) => s.size)
        .catch(() => undefined);
      if (size === undefined) return; // does not exist → not in existingFiles
      existingFiles.add(file);

      const symbols = symbolsByFile.get(file) ?? [];
      const texts = textsByFile.get(file) ?? [];
      if (symbols.length === 0 && texts.length === 0) return;
      if (!isParseableSource(file)) return; // unknown, not stale
      if (size > MAX_SYMBOL_SCAN_BYTES) return; // unknown, not stale

      const content = await readFile(absolute, "utf8").catch(() => undefined);
      if (content === undefined) return; // unknown, not stale

      for (const { anchor, symbol } of symbols) {
        if (fileMentionsSymbol(file, content, symbol) === false) staleSymbolAnchors.add(anchor);
      }
      for (const text of texts) {
        if (!fileContainsCruxText(content, text.text))
          staleTextAnchors.add(testTextAnchorLabel(text));
      }
    }),
  );

  return { existingFiles, staleSymbolAnchors, staleTextAnchors };
}
