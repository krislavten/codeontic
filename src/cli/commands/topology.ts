import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Adapter } from "../../adapters/types.js";
import { loadComponents } from "../../config/components.js";
import { runFacts } from "../../facts/runner.js";
import {
  type EdgeDiffOutcome,
  type ObservedEdgePair,
  type TopologyModel,
  computeTopologyEdgeDiff,
  computeTopologyModel,
  renderTopologyHtml,
} from "../../views/topology-html.js";

/**
 * The `--compare-edges` file (issue #23 §4 / 阶段3 PR8, extended for the
 * post-merge queue-normalization + observability follow-up, then reframed
 * again for the "second co-equal fact source" pivot — see
 * `views/topology-html.ts`'s edge-diff module doc for why this diffs the
 * EXTRACTOR's own edges rather than a hand-authored model edge list).
 *
 * BREAKING SHAPE CHANGE from the original PR8 (bare `[{from,to}]` array):
 * this feature merged only hours before the first REAL trace data came back,
 * and that first run is what surfaced the need for `observableComponents` —
 * there is no real consumer of the old bare-array shape yet, so this widens
 * it to an object rather than carrying two supported shapes forward.
 *
 * `edges[].from`/`.to` share the SAME id namespace `topology` already uses:
 * `.codeontic/config.json`'s declared `component` ids, and/or any external-
 * dependency id a topology-tagged fact already names (e.g. `"postgres"`).
 * This engine has ZERO opinion on where the file comes from — an OTel trace
 * export, a service-mesh access log, a hand-curated list — same
 * engine/adapter separation `facts` already follows; whatever produces it
 * just needs to emit this shape:
 *
 * ```json
 * {
 *   "observableComponents": ["web", "api"],
 *   "edges": [
 *     { "from": "web", "to": "api" },
 *     { "from": "api", "to": "postgres" },
 *     { "from": "web", "to": "worker", "viaQueue": true, "spanName": "jobs.process web_jobs" }
 *   ]
 * }
 * ```
 *
 * `observableComponents` is OPTIONAL and is a list of declared component ids
 * whose telemetry is trustworthy enough that "no observed edge from this
 * component" is real evidence (see `computeTopologyEdgeDiff`'s `unobservable`
 * category doc for why: a component whose OTLP exporter can't reach the
 * collector at all — sandboxed processes are the real-world case that forced
 * this — will NEVER show up as an edge source no matter how live the edge
 * really is, and mislabeling that as a "dead path" is precisely the kind of
 * signal-lying-about-its-own-cause failure this whole engine exists to
 * catch elsewhere). Omitting it entirely is different from passing `[]`
 * only in audit trail, not in resulting classification — both make every
 * would-be "static-only" edge read as `unobservable` instead, the
 * conservative default (see that field's doc on `TopologyEdgeDiffSummary`).
 * An id here that never turns out to be an edge source is harmless.
 *
 * `edges[].viaQueue`/`.kind` are OPTIONAL and, when either says "this pair
 * was seen via a queue consumer" (`viaQueue: true` or `kind: "consumer"`),
 * route the pair to the dedicated `"queue-mediated"` category instead of the
 * confirmed/static-only/unobservable/observed-only comparison — see that
 * category's own doc on `EdgeDiffCategory` for why pairing a queue's
 * producer and consumer into one logical edge was tried and abandoned (it
 * would fabricate edges between components that never actually talk to each
 * other). `.edgeKind`/`.rawHosts`/`.spanName`/`.operation`/`.count`/
 * `.sampleTraceIds` are OPTIONAL, accepted for schema compatibility with a
 * real OTel trace export (see the real-world shape this was extended for)
 * but NOT currently read by any classification logic — purely descriptive
 * metadata a producer is free to include without having to strip its own
 * diagnostic fields first. In particular `edgeKind` (the producer's own
 * "internal service pair" vs "external host" label) is redundant with what
 * `computeTopologyEdgeDiff` already derives itself from whether both
 * endpoints are already known to the static side — see
 * `TopologyEdgeDiffEdge.observedOnlyKnownEndpoints`'s doc.
 *
 * `observableTargetKinds` is OPTIONAL and is the TARGET-side counterpart to
 * `observableComponents` — a list of `toKind` values (the same adapter-
 * invented vocabulary as `TopologyHint.toKind`) whose external targets this
 * dataset's collection method could actually see. Real incident that added
 * this: an observed-edges file built purely from HTTP client spans has zero
 * chance of ever seeing a direct Postgres/Redis connection (`toKind:
 * "datastore"`) — that protocol never produces an HTTP client span — but
 * without this field, those edges were landing in `static-only` ("maybe
 * dead") purely because the collection method never had a chance, not
 * because the edge is actually gone. Same conservative default as
 * `observableComponents`: omitted entirely → every external-target edge
 * defaults to `unobservable` rather than assuming full coverage. See
 * `computeTopologyEdgeDiff`'s `unobservable` category / `TopologyEdgeDiffOptions.observableTargetKinds`
 * for the full doc.
 *
 * STRICT (both the outer object and each edge row), for the same reason
 * `Component` (config/components.ts) is: a typo'd key must be a loud parse
 * error, not a row (or a whole scope declaration) that silently drops out of
 * the comparison. Every field a known real producer emits is explicitly
 * declared below for exactly this reason — widening the schema to accept a
 * real shape is not the same as loosening it to `.passthrough()`, which
 * would defeat the typo protection entirely.
 */
const ObservedEdgeSchema = z
  .object({
    from: z.string().min(1),
    to: z.string().min(1),
    viaQueue: z.boolean().optional(),
    kind: z.string().min(1).optional(),
    edgeKind: z.string().min(1).optional(),
    rawHosts: z.array(z.string()).optional(),
    spanName: z.string().optional(),
    operation: z.string().optional(),
    count: z.number().optional(),
    sampleTraceIds: z.array(z.string()).optional(),
  })
  .strict();
/**
 * Strict, EXCEPT for `_`-prefixed keys, which pass through as free-form
 * annotation.
 *
 * JSON has no comments, and this file is one a human maintains and has to
 * justify: "why does `observableTargetKinds` list these three and not
 * `datastore`?" is exactly the kind of reasoning that is obvious the day it is
 * written and unrecoverable six months later. With strictness alone the only
 * way to record it is outside the file, where it drifts.
 *
 * This mirrors the convention `.codeontic/config.json` already uses in the
 * wild (`_comment`, `_components`). Strictness is here to catch TYPOS — a
 * misspelled `observableComponent` must still fail loudly — not to forbid
 * deliberate annotation, and the `_` prefix separates the two cleanly: no real
 * field starts with one.
 */
const OBSERVED_EDGES_FILE_SHAPE = {
  observableComponents: z.array(z.string().min(1)).optional(),
  observableTargetKinds: z.array(z.string().min(1)).optional(),
  edges: z.array(ObservedEdgeSchema),
};
const ObservedEdgesFileSchema = z
  .object(OBSERVED_EDGES_FILE_SHAPE)
  .catchall(z.unknown())
  .superRefine((value, ctx) => {
    // Known keys are READ OFF the shape above, never re-listed here: a
    // hand-written second copy is a field-addition trap — add `excludeEdges`
    // to the shape, forget this list, and a legitimate field starts failing as
    // a typo. One source of truth, so that cannot happen.
    const known = new Set(Object.keys(OBSERVED_EDGES_FILE_SHAPE));
    const unknown = Object.keys(value).filter((k) => !k.startsWith("_") && !known.has(k));
    if (unknown.length === 0) return;
    // ONE aggregated issue, matching what zod's own `.strict()` emits — a
    // consumer that reads `keys` as the full list of offenders keeps working.
    ctx.addIssue({
      code: z.ZodIssueCode.unrecognized_keys,
      keys: unknown,
      message: `Unrecognized key(s) in object: ${unknown
        .map((k) => `'${k}'`)
        .join(", ")} (annotations must start with '_')`,
    });
  });

export type LoadObservedEdgesResult =
  | {
      ok: true;
      edges: ObservedEdgePair[];
      observableComponents?: string[];
      observableTargetKinds?: string[];
    }
  | { ok: false; error: string };

/**
 * Reads + validates the `--compare-edges` file. Every failure mode (missing
 * file, invalid JSON, schema violation) returns `{ok:false}` with a message
 * — NEVER an empty edge list. This distinction matters: a caller that
 * silently treated "couldn't load" the same as "loaded, zero rows" would
 * make `computeTopologyEdgeDiff`'s `observedTotal` read 0 and
 * `staticCoverage` read `null` ("nothing to compare") instead of surfacing
 * that the comparison never ran at all — exactly the "假绿" (false green)
 * this feature exists to prevent (see the PR's own review brief).
 */
export async function loadObservedEdges(path: string): Promise<LoadObservedEdgesResult> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    return {
      ok: false,
      error: `cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      error: `${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const parsed = ObservedEdgesFileSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      error: `${path} failed schema validation (expected {observableComponents?: string[], observableTargetKinds?: string[], edges: {from, to}[]}): ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    };
  }
  return {
    ok: true,
    edges: parsed.data.edges,
    ...(parsed.data.observableComponents !== undefined
      ? { observableComponents: parsed.data.observableComponents }
      : {}),
    ...(parsed.data.observableTargetKinds !== undefined
      ? { observableTargetKinds: parsed.data.observableTargetKinds }
      : {}),
  };
}

export type TopologyResult =
  | {
      ran: true;
      outputPath: string;
      model: TopologyModel;
      /** Present only when `--compare-edges` was passed — see `EdgeDiffOutcome`'s doc for the ok/error split. */
      edgeDiff?: EdgeDiffOutcome;
    }
  | {
      ran: false;
      skippedReason: string;
      /**
       * `config_error`: `.codeontic/config.json`'s `components` section
       * exists but failed validation — a real problem the CLI should surface
       * as an error, not a routine warning (mirrors `check`'s own
       * `inv1ConfigError`, which run.ts logs via `io.error` with a "✗"
       * prefix, not lumped in with an ordinary advisory skip).
       * `no_components`: nothing is declared — a normal, unconfigured state.
       * Kept as a discriminant rather than string-sniffing `skippedReason`
       * so the CLI's choice of log severity can never drift from the reason
       * text if either wording changes later.
       */
      skipKind: "config_error" | "no_components";
    };

export interface TopologyOptions {
  /**
   * Repo checkout root to extract facts from. Unlike `graph`/`overview` (which
   * always have the model to fall back on), `topology` has NO structural
   * source without facts — omitting this still renders (declared components,
   * zero edges), because the components legend alone is honest, useful output,
   * not nothing.
   */
  repoRoot?: string | undefined;
  adapter?: Adapter | undefined;
  /** Output path override; defaults to `<dir>/.codeontic/ws/topology.html`. */
  out?: string | undefined;
  cacheDir?: string | null | undefined;
  /**
   * Path to a `--compare-edges` file (see `loadObservedEdges`'s doc for the
   * shape) — diffs the extractor's own edges against it (issue #23 §4).
   * Omitted → no diff attempted, output identical to before this option
   * existed.
   */
  compareEdges?: string | undefined;
}

/**
 * `codeontic topology`: a self-contained HTML architecture diagram rendered
 * PURELY from declared `components` (§ config/components.ts) + facts carrying
 * a `topology` hint (§ adapters/types.ts) — issue #23 P0. See
 * `views/topology-html.ts`'s module doc comment for why this reads no
 * `.codeontic/model/` file and adds no model node kind: the whole point is to
 * ship the picture before any model decision about a topology dimension is
 * made, and let actual usage be the evidence for whether one is needed.
 *
 * Loud-skip discipline, same family as `graph`/`overview`/`snapshot`: a
 * malformed `components` config is a hard `ran: false` (never silently
 * treated as "no components" — see `loadComponents`'s own contract), and so
 * is a target with no components declared at all, because there is nothing
 * this command can meaningfully draw without at least one. Missing facts
 * (`--repo-root` absent, or the adapter chose not to run) is NOT a skip —
 * it degrades to a components-only render with zero edges and a banner that
 * says so, because the entry-type legend by itself already answers a
 * question ("what units does this repo have, and what kind is each").
 */
export async function runTopology(
  targetDir: string,
  options: TopologyOptions = {},
): Promise<TopologyResult> {
  const { components, error } = await loadComponents(targetDir);
  if (error) {
    return { ran: false, skippedReason: error, skipKind: "config_error" };
  }
  if (!components || components.length === 0) {
    return {
      ran: false,
      skippedReason:
        "no `components` declared in .codeontic/config.json — topology has nothing to attribute edges to. See `codeontic init` / config/components.ts.",
      skipKind: "no_components",
    };
  }

  let facts: Awaited<ReturnType<typeof runFacts>>["facts"] = [];
  let factsRan = false;
  if (options.repoRoot !== undefined && options.adapter) {
    const result = await runFacts(options.repoRoot, {
      ...(options.cacheDir !== undefined ? { cacheDir: options.cacheDir } : {}),
      adapter: options.adapter,
    });
    if (result.ran) {
      facts = result.facts;
      factsRan = true;
    }
  }

  const model = computeTopologyModel(facts, components, factsRan);

  // `--compare-edges` (issue #23 §4 / 阶段3 PR8): diffs the EXTRACTOR's own
  // edges (`model.edges`, just computed above) against a caller-supplied
  // observed-edge list — see `loadObservedEdges`'s doc for the file
  // contract and why a bad file is `{status:"error"}`, never silently
  // treated as "no observed edges".
  let edgeDiff: EdgeDiffOutcome | undefined;
  if (options.compareEdges !== undefined) {
    const loaded = await loadObservedEdges(options.compareEdges);
    edgeDiff = loaded.ok
      ? {
          status: "ok",
          diff: computeTopologyEdgeDiff(model, loaded.edges, {
            ...(loaded.observableComponents !== undefined
              ? { observableComponents: loaded.observableComponents }
              : {}),
            ...(loaded.observableTargetKinds !== undefined
              ? { observableTargetKinds: loaded.observableTargetKinds }
              : {}),
          }),
        }
      : { status: "error", message: loaded.error };
  }

  const html = renderTopologyHtml(
    model,
    {
      title: `${model.summary.components} component(s) · ${model.summary.external} external dependenc(y/ies) · ${model.summary.edges} edge(s) · generated ${new Date().toISOString()}`,
      ...(options.adapter?.topologyCoverageNote !== undefined
        ? { coverageNote: options.adapter.topologyCoverageNote }
        : {}),
    },
    edgeDiff,
  );

  const outputPath = options.out ?? join(targetDir, ".codeontic", "ws", "topology.html");
  await mkdir(join(targetDir, ".codeontic", "ws"), { recursive: true });
  await writeFile(
    outputPath,
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>codeontic topology</title>${html}`,
    "utf8",
  );

  return { ran: true, outputPath, model, ...(edgeDiff ? { edgeDiff } : {}) };
}
