import type { Inv1Config } from "../validate/inv1/config.js";

/**
 * The kind of implementation signal a fact represents. An OPEN string, not a
 * closed union: each adapter names its own signal kinds (e.g. a pg-boss-backed
 * target might use `pg_boss_queue` / `setinterval_poller`; a Redis-backed one
 * `redis_channel` / …). The engine treats it opaquely — it never enumerates
 * every adapter's kinds — so a new adapter adds signals without the engine
 * changing.
 */
export type SignalKind = string;

/**
 * A fact's optional projection onto the topology graph (issue #23 P0). ADDITIVE
 * — carrying it does not bump `ADAPTER_INTERFACE_VERSION`, and an adapter that
 * predates this field simply produces facts with no `topology`, which the
 * `topology` command treats as "this fact draws no edge" rather than an error.
 *
 * The EDGE'S SOURCE is deliberately NOT here. An adapter knows what a call site
 * talks to (an env var name, a client constructor); it does not know how the
 * target repo carves itself into components — that partition is declared
 * config (`components.ts`), read by the engine, not the adapter. So the
 * `topology` command derives `from` itself via `componentOf(components,
 * fact.filePath)`, and this hint supplies only the other end.
 */
export interface TopologyHint {
  /** Target node id: another declared component, or an external dependency ("postgres" / "redis" / "gitlab" / …). */
  to: string;
  /**
   * Open string, not a closed union like `ComponentRole` — a dependency id
   * ("postgres") is adapter-invented vocabulary, not something the engine can
   * enumerate up front the way it does entry types. The `topology` renderer
   * groups by whatever value appears (`service` / `datastore` / `queue` /
   * `objectstore` / `external` are the ones the reference adapter emits).
   */
  toKind?: string;
  /** How the target was identified (env var name, client symbol) — surfaced when documenting the capability boundary. */
  via?: string;
}

/**
 * One extracted implementation signal (a "registerable" background unit the
 * behavioral model is supposed to account for). Lives here on the engine↔adapter
 * boundary — NOT inside any one adapter — so every adapter and the engine share
 * one contract instead of importing it from a sibling adapter.
 */
export interface ImplementationFact {
  signal: SignalKind;
  /** The queue/channel/… name, or the poller's enclosing function/file marker. */
  name: string;
  filePath: string;
  /** 1-based line for a human reading the report — not a stable anchor. */
  line: number;
  /** Extra context: e.g. "env-suffixed" for a templated name, or the interval. */
  detail?: string;
  /** true when the fact's key part (name / interval) couldn't be read statically. */
  unanalyzable?: boolean;
  /** Optional topology-graph projection — see `TopologyHint`. */
  topology?: TopologyHint;
}

/**
 * The Adapter interface's own version (Proposal 010 §4 — open infrastructure /
 * target-repo-owned adapters). NOT the same axis as an individual adapter's
 * `version` (which keys the B3 cache and bumps on extractor logic changes):
 * this is the shape of the interface itself. Bumping it is an explicit,
 * visible breaking change — adapters declare which shape they were built
 * against via `interfaceVersion`, and the registry rejects a mismatch loudly
 * (no silent degrade, no back-compat shim). See registry.ts.
 */
export const ADAPTER_INTERFACE_VERSION = "v2" as const;

/**
 * The engine↔adapter boundary (Proposal 006 E1 / 001 §2 三分离; Proposal 010 —
 * open infrastructure: adapters live in the TARGET repo, not this one). The
 * ENGINE (loader, T0, INV-1 scan primitive, query, cache, `--diff`, MCP, facts
 * runner) carries zero target-repo knowledge; an ADAPTER supplies the
 * target-stack-specific facts: how to read this codebase's implementation
 * signals, its version (part of the cache key), and its default INV-1 config.
 *
 * Formalizing this as an interface was the Phase 5 "通用化" — the 001 red line
 * still holds: this boundary must not degrade a target's analysis quality or
 * CI speed. Proposal 010 takes the next step: no adapter ships inside this
 * repo — a target repo's `.codeontic/adapter/index.ts` exports an object
 * satisfying this interface, discovered via `--adapter-path` or the
 * `.codeontic/adapter/` convention path (registry.ts), never bundled here.
 */
/**
 * Injected into `extractFacts` so an extractor can follow a reference into
 * ANOTHER file (e.g. resolve `` `${QUEUE_BASE}${SUFFIX}` `` to its literal by
 * reading the module that exports `QUEUE_BASE`) without breaking the purity
 * contract that makes results cacheable.
 *
 * The adapter never touches `fs` itself: it calls `readFile`, and the RUNNER —
 * which performed the read — records what was consulted and folds those files'
 * hashes into the cache entry. That is the whole point. If the adapter did its
 * own I/O, a fact derived from file B would sit in a cache entry keyed only by
 * file A's hash, and editing B alone would serve a stale fact — strictly worse
 * than not extracting it at all, because "invisible" becomes "confidently
 * wrong" (codeontic is advisory, so nobody would catch it).
 *
 * Still synchronous, for the same reason `extractFacts` is: the reconcile path
 * is sync-only by design (Proposal 010 §6).
 */
export interface ExtractContext {
  /**
   * Read another repo-relative file, or `null` when it does not exist / cannot
   * be read. Every path passed here is recorded as a dependency of the facts
   * produced by this call.
   *
   * PROBING IS SAFE, and deliberately so. There is no module resolver here — an
   * extractor chasing `import … from "./queue-names"` has to try the candidate
   * paths itself (`.ts`, `/index.ts`, a tsconfig alias), missing most of them.
   * A path that returned `null` is recorded just like one that returned text,
   * so if a file later appears there the cached facts are invalidated. Without
   * that, a miss would leave no trace and the entry would keep serving a fact
   * that is missing rather than stale.
   *
   * Resolution rules stay on this side of the boundary on purpose (Proposal
   * 010): the engine holds no opinion about how a target repo's imports map to
   * paths. Probe as widely as you need.
   */
  readFile(repoRelativePath: string): string | null;
}

export interface Adapter {
  /**
   * Must equal `ADAPTER_INTERFACE_VERSION`. Runtime-checked at registration
   * (registry.ts) — a mismatch is a loud error, not a silent downgrade: "adapter
   * is v1, codeontic is v2, upgrade the adapter or pin codeontic back".
   */
  interfaceVersion: typeof ADAPTER_INTERFACE_VERSION;
  /** Stable adapter id, used to look it up and (with `version`) to key the cache. */
  name: string;
  /**
   * Bumped when extractor LOGIC changes — part of the B3 cache key so a bump
   * invalidates stale results even when file bytes are unchanged.
   */
  version: string;
  /**
   * `git grep -E` pattern selecting candidate files worth parsing (the cheap
   * pre-filter before the pure extractor confirms). Adapter-specific because it
   * encodes which call shapes this stack's signals appear in.
   */
  candidatePattern: string;
  /**
   * Extract implementation facts from one source file. PURE (no I/O), and
   * MUST be a plain synchronous function — registry.ts rejects an
   * `AsyncFunction` and (as a belt-and-suspenders check) a call whose result is
   * `instanceof Promise`, so a target's adapter can't quietly introduce
   * asynchronous discovery that `unregistered.ts`'s synchronous reconcile isn't
   * built for (Proposal 010 §6 audit item 2 — MVP is sync-only; async discovery
   * is an explicit Phase 5+ scope, not silently smuggled in via one adapter).
   */
  extractFacts(filePath: string, content: string, ctx?: ExtractContext): ImplementationFact[];
  /**
   * Signal kinds (from `ImplementationFact.signal`) this adapter opts into
   * NAME-level reconciliation for, in addition to the base FILE-level
   * reconciliation every fact gets for free (see unregistered.ts). Declared by
   * the adapter, not hardcoded in the engine — e.g. a queue-backed target's
   * adapter would declare `["pg_boss_queue"]` for its producer/consumer file
   * split (a queue defined in one file, consumed by a loop modeled elsewhere).
   */
  nameMatchableSignalKinds?: string[];
  /**
   * Signal kinds that reconciliation is ABOUT — the ones a model node is
   * expected to register. Absent (the default) means "all of them", which is
   * what every adapter written before this field meant, so nothing changes for
   * them.
   *
   * WHY THIS EXISTS. `reconcile` asks one question: "is there a background
   * unit running here that the model never accounted for?" That question only
   * makes sense for facts that DESCRIBE a background unit — a queue, a poller.
   * Once an adapter also emits facts of a different nature (a topology edge,
   * a dependency client — see `ImplementationFact.topology`), those facts are
   * not things any Loop is supposed to "register"; they are a projection of a
   * different dimension that happens to travel down the same pipe.
   *
   * Left undeclared, they land in `unregistered` anyway and swamp it. Measured
   * on a real target: 6 genuinely-unregistered facts became 69 the moment the
   * adapter started emitting topology hints — a 10x noise increase in the one
   * number the model is steered by. An advisory signal that cries wolf gets
   * ignored (see unregistered.ts), so this is not cosmetic: it is the
   * difference between a check people act on and one they learn to skip.
   *
   * Declaring this does NOT hide those facts — `facts`, `topology` and the
   * cache all still see every one of them. It only scopes what reconciliation
   * claims to be about.
   */
  reconcilableSignalKinds?: string[];
  /**
   * The default INV-1 guarded-column config for this target, if the adapter
   * ships one. A repo-level `.codeontic/config.json` still overrides it; this
   * is the fallback so a target doesn't have to re-declare what the adapter
   * knows.
   */
  defaultInv1Config?: Inv1Config;
  /**
   * Free-text caveat the `topology` command displays verbatim, next to the
   * edge count — e.g. "outbound_edge only fires for a named, mapped env var:
   * 17/62 (27%) of this repo's non-test fetch call sites are named-env-URL
   * reachable, so this graph covers a subset of even that 27%."
   *
   * ADDITIVE, like `TopologyHint` itself — an adapter without this field
   * still works; the `topology` command shows a generic fallback caveat
   * instead of silence. This field exists because the engine genuinely
   * cannot compute this number itself: "what fraction of real service calls
   * did the adapter's extractor actually tag" is adapter-specific domain
   * knowledge (the engine has no concept of "fetch call site" for any given
   * target stack) — exactly the kind of thing Proposal 010 keeps out of this
   * package. The adapter that wrote the extractor is the only party that
   * measured its own coverage, so the note travels with it.
   */
  topologyCoverageNote?: string;
}
