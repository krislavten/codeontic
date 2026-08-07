import { z } from "zod";
import { CODEONTIC_CONFIG_RELATIVE_PATH, readCodeonticConfig } from "./config-file.js";

/**
 * A target repo's COMPONENTS: the deployable/runnable units its source tree is
 * divided into, declared as data in `.codeontic/config.json`.
 *
 * WHY THIS IS CONFIG AND NOT INFERENCE. Two features need to say "which unit
 * does this file belong to":
 *  - the backtest metric (判据 A) reports coverage per partition, because one
 *    global number hides structural gaps — a model can look 36% healthy while
 *    being flatly 0% on every frontend;
 *  - the topology view labels each node by entry type, because a graph of
 *    unlabeled boxes "能看但答不了问题".
 * Both could be faked by hardcoding `apps/*` + `packages/*`. That would bake
 * one target repo's layout into an engine whose entire premise (Proposal 010)
 * is that it carries zero target knowledge — and it would silently mis-partition
 * any repo shaped differently, which is worse than not partitioning at all.
 * So: declared, or absent. Never guessed.
 */

/**
 * Entry-type vocabulary — CLOSED, and that is the point.
 *
 * The plan this implements requires every node to carry an entry type
 * (平台 API / 用户前端 / 后台进程). An open string would satisfy the schema
 * while letting a target write five spellings of "worker", and the legend a
 * reader relies on to interpret the graph degrades back to unlabeled. A closed
 * set is what makes the annotation mean the same thing in every repo.
 *
 * `library` is here for shared packages that are not processes at all: they own
 * files (so the partition report can attribute commits to them) but are not
 * topology entry points. Anything that genuinely does not fit is a signal the
 * vocabulary needs a considered addition, not a free-text escape hatch.
 */
export const COMPONENT_ROLES = ["frontend", "api", "worker", "sandbox", "library"] as const;
export type ComponentRole = (typeof COMPONENT_ROLES)[number];

export const Component = z
  .object({
    /** Stable id, used as the node id in topology and the partition key in reports. */
    id: z.string().min(1),
    /** Human label for views. Falls back to `id` when absent. */
    label: z.string().min(1).optional(),
    /** Entry type — see COMPONENT_ROLES. */
    role: z.enum(COMPONENT_ROLES),
    /** Repo-relative path prefixes this component owns (e.g. `apps/web`). */
    paths: z.array(z.string().min(1)).min(1),
    /**
     * What this component is called in OTel — `service.name`/`service`
     * attribute on its own traces/spans/logs, when it differs from `id`
     * (e.g. a component id `web-app` whose OTel service name is actually
     * `webapp`, no hyphen). OPTIONAL and PURELY DECLARATIVE: this engine
     * never reads or interprets the value itself (it has zero opinion on
     * OTel, or on any specific observability backend — same posture as
     * `paths`/`role` having no built-in notion of "npm workspace" or "k8s
     * deployment"). It exists so that mapping is declared ONCE, here,
     * instead of living only inside whatever external tool exports a
     * `--compare-edges` file (see `views/topology-html.ts`'s edge-diff
     * module doc) — a mapping kept only in an export script has no schema to
     * keep it honest and drifts silently as ids on either side get renamed.
     * Any tool that already depends on this engine's `loadComponents` can
     * read it back out instead of maintaining its own copy.
     */
    otelService: z.string().min(1).optional(),
  })
  // STRICT on purpose. This engine's own issue tracker records the failure mode
  // being defended against: a non-strict zod object silently DROPS an unknown
  // key, so a typo'd or newer field produces no error, no warning, and a check
  // that quietly does not run. A misspelled `path:` here must be a loud parse
  // error, not a component with no files.
  .strict();
export type Component = z.infer<typeof Component>;

export const ComponentsConfig = z.array(Component);
export type ComponentsConfig = z.infer<typeof ComponentsConfig>;

export interface LoadComponentsResult {
  /** Parsed components, or undefined when none are declared (feature simply off). */
  components?: Component[];
  /** Set when the config exists but its `components` section is malformed. */
  error?: string;
}

/**
 * `  ./apps//web/ ` → `apps/web`. Surrounding whitespace, a leading `./`,
 * repeated separators and a trailing one all carry no meaning in a path
 * prefix — but each of them, left alone, produces a string that compares
 * unequal to the same path written normally. That is a SILENT failure: the
 * component matches nothing, the partition reports zero, and the config looks
 * right. Normalizing both the declaration and the lookup is what keeps a
 * cosmetic difference from becoming a wrong number.
 */
function normalizePath(path: string): string {
  return path
    .trim()
    .replace(/^\.\//, "")
    .replace(/\/{2,}/g, "/")
    .replace(/\/+$/, "");
}

/**
 * Cross-entry checks zod cannot express. Both are ambiguity, not style:
 * a duplicate id makes report rows collide, and the SAME path claimed by two
 * components makes `componentOf` depend on declaration order. Rejecting is the
 * only answer that keeps the output deterministic.
 *
 * NESTED paths are explicitly NOT a conflict — only byte-identical ones are.
 * `packages` and `packages/api` belonging to different components is the
 * carve-out feature `componentOf`'s longest-prefix rule exists to serve, and
 * rejecting it would forbid the most useful shape a monorepo has.
 */
function validateComponents(components: Component[]): string | undefined {
  const seenIds = new Set<string>();
  for (const c of components) {
    if (seenIds.has(c.id)) return `duplicate component id "${c.id}"`;
    seenIds.add(c.id);
  }
  const owner = new Map<string, string>();
  for (const c of components) {
    for (const raw of c.paths) {
      const path = normalizePath(raw);
      const existing = owner.get(path);
      // Same component listing a path twice is a typo, not a conflict, and
      // saying "claimed by both x and x" would read as a tool bug. Named for
      // what it is so the fix is obvious.
      if (existing === c.id) return `component "${c.id}" lists path "${path}" more than once`;
      if (existing) return `path "${path}" is claimed by both "${existing}" and "${c.id}"`;
      owner.set(path, c.id);
    }
  }
  return undefined;
}

/**
 * Loads the `components` section of `<dir>/.codeontic/config.json`.
 *
 * Absent file, or a file with no `components` key → `{}`: partitioning and
 * topology node labelling are opt-in, and a target that has not declared its
 * layout gets the honest degraded output (one "overall" partition) rather than
 * a guessed one.
 */
export async function loadComponents(dir: string): Promise<LoadComponentsResult> {
  const read = await readCodeonticConfig(dir);
  if (read.error) return { error: read.error };
  if (read.json === undefined) return {};

  const raw = (read.json as { components?: unknown } | null)?.components;
  if (raw === undefined) return {};

  const parsed = ComponentsConfig.safeParse(raw);
  if (!parsed.success) {
    return {
      error: `${CODEONTIC_CONFIG_RELATIVE_PATH} \`components\` failed schema validation: ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    };
  }
  const conflict = validateComponents(parsed.data);
  if (conflict) return { error: `${CODEONTIC_CONFIG_RELATIVE_PATH} \`components\`: ${conflict}` };

  const components = parsed.data.map((c) => ({ ...c, paths: c.paths.map(normalizePath) }));
  return { components };
}

/** True when `path` is `prefix` itself or sits under it — on a SEGMENT boundary. */
function isUnder(path: string, prefix: string): boolean {
  // Boundary-aware: `apps/web` must not swallow `apps/webhooks/route.ts`.
  // A plain `startsWith` is the classic version of this bug and it is silent —
  // the file lands in the wrong partition and every number stays plausible.
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * The component owning a repo-relative file, or `undefined`.
 *
 * LONGEST prefix wins, so a nested declaration can carve a sub-tree out of a
 * broader one (`packages` → a shared library component, `packages/api` → its
 * own component) without the outer one shadowing it.
 *
 * NO TIE-BREAK RULE IS NEEDED, and that is a property of the data rather than
 * an oversight: two matching prefixes of EQUAL length are necessarily the same
 * string (both are prefixes of the same path, cut at the same offset), and
 * `loadComponents` rejects the same path declared twice. So the strict `>`
 * below can never be reached with a genuine tie, and the result does not depend
 * on declaration order.
 */
export function componentOf(
  components: readonly Component[],
  repoRelativePath: string,
): Component | undefined {
  const path = normalizePath(repoRelativePath);
  let best: Component | undefined;
  let bestLength = -1;
  for (const c of components) {
    for (const prefix of c.paths) {
      if (isUnder(path, prefix) && prefix.length > bestLength) {
        best = c;
        bestLength = prefix.length;
      }
    }
  }
  return best;
}

/** Display name for a component: its `label`, or its `id`. */
export function componentLabel(component: Component): string {
  return component.label ?? component.id;
}
