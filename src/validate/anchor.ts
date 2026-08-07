/**
 * Two anchor shapes are allowed:
 *   - file-symbol: "packages/core/src/idle-watcher.ts#IdleWatcher"
 *                  "packages/schemas#EventSchema.warning"
 *                  "apps/web/app/(portal)/[id]/page.tsx#Page"
 *   - db-table:    "jobs_table.payload"  or bare "sandboxes"
 * The distinguishing feature is the "#" — file-symbol anchors always
 * have one, db-table anchors never do. This is intentionally lenient:
 * it is a syntax check, not a claim that the symbol/table exists.
 *
 * File-symbol paths are always relative to the target repo's checkout
 * root, never to codeontic's own CWD or the model
 * YAML's own location — `checkAnchorExistence(graph, repoRoot, ...)` in
 * checks.ts takes `repoRoot` as an explicit required parameter for
 * exactly this reason, so anchor resolution doesn't depend on which
 * directory the CLI happens to be invoked from.
 *
 * PARENTHESES AND BRACKETS ARE PATH CHARACTERS, NOT EXOTICA. Next.js route
 * groups (`app/(portal)/…`) and dynamic segments (`app/[projectId]/…`) are
 * ordinary directory names in any App Router repo. Rejecting them does not
 * make a model stricter — it makes a whole tier of the codebase unmodellable,
 * which reads as "nobody bothered to model the frontend" when the truth is
 * "the format would not accept the path". Measured on a real App Router target:
 * 16 of the 17 files under the app directory that run a poller sat under a
 * route group, so every frontend loop in that model carried zero anchors.
 *
 * `..` IS REJECTED AS A PATH SEGMENT, and that is a tightening this format
 * never had: `[\w./-]` always admitted `../../../etc/passwd#x`, and anchors
 * are handed to `access(join(repoRoot, filePath))`. The check is deliberately
 * segment-level rather than a substring ban — `foo..bar.ts` is a legal (if
 * odd) filename and stays legal; only a segment that IS `..` is refused.
 * Two notes on why this lives here AND in checks.ts:
 *   - a format rule is easy for the next edit to widen by accident;
 *   - `checkAnchorExistence` re-asserts containment right before it touches
 *     the filesystem, which is the only place the guarantee actually matters.
 * Neither is a security fix in any serious sense — anchors come from in-repo,
 * reviewed YAML and are only ever `access()`ed, never read or executed. It is
 * simply a shape that should never have been accepted.
 */
const FILE_SYMBOL_CHARS = /^[\w./()[\]-]+#[\w.]+$/;
const TABLE_ANCHOR = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)?$/;

/** True when any `/`-separated segment of `filePath` is exactly `..`. */
export function hasParentTraversalSegment(filePath: string): boolean {
  return filePath.split("/").includes("..");
}

export function isValidAnchorFormat(anchor: string): boolean {
  if (anchor.length === 0) return false;
  if (!anchor.includes("#")) return TABLE_ANCHOR.test(anchor);
  if (!FILE_SYMBOL_CHARS.test(anchor)) return false;
  return !hasParentTraversalSegment(anchor.slice(0, anchor.indexOf("#")));
}

/** For a file-symbol anchor, the file path portion (before "#"). Table anchors have none. */
export function anchorFilePath(anchor: string): string | undefined {
  if (!anchor.includes("#")) return undefined;
  return anchor.split("#")[0];
}

/** For a file-symbol anchor, the symbol portion (after "#"). Table anchors have none. */
export function anchorSymbol(anchor: string): string | undefined {
  if (!anchor.includes("#")) return undefined;
  return anchor.slice(anchor.indexOf("#") + 1);
}
