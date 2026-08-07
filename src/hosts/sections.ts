import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const MARKER_START = "<!-- codeontic:managed:start -->";
const MARKER_END = "<!-- codeontic:managed:end -->";

export type UpsertOutcome = "created" | "appended" | "replaced" | "unchanged";

export interface UpsertResult {
  outcome: UpsertOutcome;
}

/**
 * Detect the dominant line ending in existing content.
 * Any presence of \r\n → CRLF; otherwise LF.
 */
function detectEol(content: string): string {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

/**
 * Normalize body to LF before comparison/storage — prevents CRLF files
 * from getting double \r on round-trip.
 */
function stripCr(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * Check if a line is exactly one of our markers (after trimming whitespace).
 * This prevents inline occurrences of the marker text from being matched.
 */
function isStartMarker(line: string): boolean {
  return line.trim() === MARKER_START;
}
function isEndMarker(line: string): boolean {
  return line.trim() === MARKER_END;
}

/**
 * Idempotent managed-section upsert (Proposal 013 B1).
 *
 * - Both markers present → replace content between them, preserve content outside.
 * - File exists but no markers → append a new managed block.
 * - File does not exist → create with markers wrapping the body.
 * - Content identical → return "unchanged", no disk write.
 *
 * The body is always stored between markers. User content outside the markers
 * is never touched.
 */
export async function upsertManagedSection(filePath: string, body: string): Promise<UpsertResult> {
  const normalizedBody = stripCr(body);

  let existing: string | undefined;
  try {
    existing = await readFile(filePath, "utf8");
  } catch {
    // file does not exist
  }

  if (existing === undefined) {
    await mkdir(dirname(filePath), { recursive: true });
    const content = `${MARKER_START}\n${normalizedBody}\n${MARKER_END}\n`;
    await writeFile(filePath, content, "utf8");
    return { outcome: "created" };
  }

  const eol = detectEol(existing);
  const existingLf = stripCr(existing);
  const lines = existingLf.split("\n");

  const startIdx = lines.findIndex(isStartMarker);
  const endIdx = lines.findIndex(isEndMarker);

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    // Both markers found — extract current managed content and compare
    const currentManaged = lines.slice(startIdx + 1, endIdx).join("\n");
    if (currentManaged === normalizedBody) {
      return { outcome: "unchanged" };
    }
    // Replace content between markers
    const before = lines.slice(0, startIdx + 1);
    const after = lines.slice(endIdx);
    const newLines = [...before, normalizedBody, ...after];
    const result = newLines.join(eol);
    await writeFile(filePath, result, "utf8");
    return { outcome: "replaced" };
  }

  // No markers (or malformed) — append a managed block
  const block = `\n${MARKER_START}\n${normalizedBody}\n${MARKER_END}\n`;
  const appendContent = existingLf.endsWith("\n") ? existingLf + block : `${existingLf}\n${block}`;
  const finalContent = eol === "\r\n" ? appendContent.replace(/\n/g, "\r\n") : appendContent;
  await writeFile(filePath, finalContent, "utf8");
  return { outcome: "appended" };
}

export { MARKER_START, MARKER_END };
