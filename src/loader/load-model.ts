import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import { parse as parseYaml } from "yaml";
import { ModelNode } from "../schema/index.js";
import { findYamlFiles } from "./find-yaml-files.js";
import { type DuplicateId, type ModelEntry, type ModelGraph, buildGraph } from "./model-graph.js";

export interface ParseError {
  file: string;
  message: string;
}

export interface LoadResult {
  graph: ModelGraph;
  entries: ModelEntry[];
  parseErrors: ParseError[];
  duplicateIds: DuplicateId[];
  /**
   * Files written as a SINGLE node (not a YAML array), mapped to that node's
   * id. This is exactly the set the file-per-node convention applies to
   * (Decision 004 技术点 3: filename must equal id) — array files that group
   * many nodes under a section name (the seed's loops/*.yaml) are deliberately
   * absent, so `checkFilenameMatchesId` doesn't false-flag them.
   */
  singleNodeFiles: Map<string, string>;
}

/**
 * Normalizes a raw YAML node before validation: a Scenario's `verified_by`
 * list may mix the two test-anchor forms (`"path#symbol"` strings and
 * `{file, text}` objects, see `TestTextAnchor`), and the schema keeps them in
 * two typed fields. Authors write ONE list; this moves the object entries into
 * `verified_by_text` so that stays an implementation detail of the loader.
 *
 * Deliberately permissive about what it does NOT understand: anything that is
 * not a plain object stays in `verified_by` and is judged by the schema, so a
 * number or a nested list still produces the normal validation error against
 * the field the author actually wrote. A MALFORMED object (say, no `text`) is
 * the one case where the error names `verified_by_text` instead — accepted
 * rather than remapped, because zod quotes the offending value verbatim, which
 * is what makes it findable, and rewriting zod's messages here would be a
 * second thing to keep in sync. Any `verified_by_text` already present is
 * preserved and appended to, so the transform is idempotent.
 */
function splitVerifiedBy(item: unknown): unknown {
  if (item === null || typeof item !== "object" || Array.isArray(item)) return item;
  const node = item as Record<string, unknown>;
  if (node.kind !== "scenario" || !Array.isArray(node.verified_by)) return item;
  const objectEntries = node.verified_by.filter(
    (e) => e !== null && typeof e === "object" && !Array.isArray(e),
  );
  if (objectEntries.length === 0) return item;
  const existingText = Array.isArray(node.verified_by_text) ? node.verified_by_text : [];
  return {
    ...node,
    verified_by: node.verified_by.filter((e) => !objectEntries.includes(e)),
    verified_by_text: [...existingText, ...objectEntries],
  };
}

/**
 * Loads every *.yaml/*.yml file under `dir`. A file may contain a single
 * node or an array of nodes; array elements are validated independently
 * so one malformed sibling doesn't take down the rest of the file's
 * otherwise-valid nodes (a whole-array `safeParse` would fail the entire
 * batch on a single bad element — that's the wrong blast radius for a
 * file that groups many unrelated loops together, see e.g.
 * test/fixtures/synthetic-model/loops/main.yaml). Parse/validation
 * failures are collected rather than thrown so `codeontic check` can
 * report every broken node in one pass instead of stopping at the first
 * one.
 */
export async function loadModel(dir: string): Promise<LoadResult> {
  const files = await findYamlFiles(dir);
  const entries: ModelEntry[] = [];
  const parseErrors: ParseError[] = [];
  const singleNodeFiles = new Map<string, string>();

  for (const absPath of files.sort()) {
    const relPath = relative(dir, absPath);
    let raw: unknown;
    try {
      const text = await readFile(absPath, "utf8");
      raw = parseYaml(text);
    } catch (err) {
      parseErrors.push({ file: relPath, message: `YAML parse error: ${(err as Error).message}` });
      continue;
    }

    const isArrayFile = Array.isArray(raw);
    const items: unknown[] = Array.isArray(raw) ? raw : [raw];

    items.forEach((item, index) => {
      const result = ModelNode.safeParse(splitVerifiedBy(item));
      if (!result.success) {
        const location = isArrayFile ? `${relPath} (item ${index})` : relPath;
        parseErrors.push({
          file: location,
          message: `schema validation failed: ${result.error.message}`,
        });
        return;
      }
      entries.push({ node: result.data, file: relPath });
      if (!isArrayFile) singleNodeFiles.set(relPath, result.data.id);
    });
  }

  const { graph, duplicateIds } = buildGraph(entries);
  return { graph, entries, parseErrors, duplicateIds, singleNodeFiles };
}
