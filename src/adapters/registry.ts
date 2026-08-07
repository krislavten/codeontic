import { ADAPTER_INTERFACE_VERSION, type Adapter } from "./types.js";

/**
 * The adapter registry (Proposal 010 §6 audit item 2 / §2 item 2 — open
 * infrastructure). NO adapter ships inside this repo anymore (the previous
 * built-in target-stack adapters are gone, Proposal 010 §1.1) — the registry
 * is a pure, empty-by-default runtime registration table. The CLI entry point
 * (run.ts) resolves an adapter from `--adapter-path` or the target repo's
 * `.codeontic/adapter/` convention path, then calls `registerAdapter` with the
 * loaded object. This module itself carries ZERO target-repo path knowledge —
 * it only validates and stores what's handed to it.
 *
 * Three checks run at registration (all synchronous, all loud-fail — no silent
 * downgrade):
 *  1. `interfaceVersion` must equal this engine's `ADAPTER_INTERFACE_VERSION`
 *     (Proposal 010 §4) — a mismatch means the adapter was built against a
 *     different interface shape.
 *  2. `extractFacts` must not be an `AsyncFunction` — `typeof` alone can't
 *     distinguish sync/async (both report "function"), so the constructor name
 *     is checked instead.
 *  3. `extractFacts` is NOT invoked here (that would give registration I/O/CPU
 *     side effects and break its "pure registration" contract) — sync-ness is
 *     covered by check 2; a function that returns a Promise without being
 *     declared `async` is a residual gap the caller's own tests should catch
 *     for their adapter, not something the engine can statically rule out at
 *     registration time.
 *
 * MVP is sync-only (Proposal 010 §6 audit item 2): `unregistered.ts`'s
 * reconcile logic assumes a synchronous `extractFacts`. Async adapter discovery
 * is explicit Phase 5+ scope, not smuggled in via a lenient check here.
 */
export class AdapterRegistrationError extends Error {}

function isAsyncFunction(fn: unknown): boolean {
  return typeof fn === "function" && fn.constructor.name === "AsyncFunction";
}

/**
 * Pure validation — checks 1 and 2 above — with NO side effect (no Map, no
 * global state). This is what a single CLI invocation should call: each
 * invocation resolves exactly ONE adapter from a path (Proposal 010 §1.3) and
 * uses it directly, so there is no "multiple adapters coexist in one process,
 * looked up by name" scenario to serve with a shared registry — and a shared
 * mutable Map would make in-process test suites collide on repeated loads of
 * an adapter with the same `name` across unrelated test cases (each `run()`
 * call is meant to be independent). Throws `AdapterRegistrationError` on
 * failure; a caller (e.g. run.ts) surfaces the message as a CLI error.
 */
export function validateAdapter(adapter: Adapter): void {
  if (adapter.interfaceVersion !== ADAPTER_INTERFACE_VERSION) {
    throw new AdapterRegistrationError(
      `adapter "${adapter.name}" declares interfaceVersion "${adapter.interfaceVersion}" but this ` +
        `codeontic build is "${ADAPTER_INTERFACE_VERSION}" — upgrade the adapter or pin codeontic back`,
    );
  }
  if (isAsyncFunction(adapter.extractFacts)) {
    throw new AdapterRegistrationError(
      `adapter "${adapter.name}"'s extractFacts is an async function — extractFacts must be synchronous (Proposal 010 §6: MVP adapter discovery is sync-only)`,
    );
  }
}

/**
 * Stateful registry (Map-backed) kept for callers that DO want a shared,
 * name-keyed set of adapters within one process (e.g. a long-lived MCP server
 * process handling several target repos, or a test suite exercising the
 * registry's own collision semantics directly) — but the CLI's per-invocation
 * `--adapter-path` resolution uses `validateAdapter` above, not this. Throws on
 * validation failure (delegates to `validateAdapter`) or on re-registering an
 * already-registered name.
 */
const registry = new Map<string, Adapter>();

export function registerAdapter(adapter: Adapter): void {
  validateAdapter(adapter);
  if (registry.has(adapter.name)) {
    throw new AdapterRegistrationError(`adapter "${adapter.name}" is already registered`);
  }
  registry.set(adapter.name, adapter);
}

/** Test/CLI-reset helper — clears every registered adapter. Not used in production paths. */
export function clearRegistry(): void {
  registry.clear();
}

export function getAdapter(name: string): Adapter | undefined {
  return registry.get(name);
}

export function adapterNames(): string[] {
  return [...registry.keys()];
}
