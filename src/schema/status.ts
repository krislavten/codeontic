import { z } from "zod";

/**
 * Six consistency states a model node can be in, per proposal 001 §3.2.
 * Default for freshly-imported seed nodes is "unverified": the real
 * implementation exists in the target repo, but the model hasn't yet
 * attached enough Scenario/Evidence to call it conformant.
 */
export const ConsistencyStatus = z.enum([
  "conformant",
  "unimplemented",
  "unverified",
  "drifted",
  "unregistered",
  "deprecated",
]);
export type ConsistencyStatus = z.infer<typeof ConsistencyStatus>;

/**
 * The 5 junction risk classes (衔接点风险模式) — the frozen taxonomy for the seed.
 * Every Junction must classify itself under exactly one of these.
 */
export const RiskClass = z.enum([
  "handoff",
  "idempotency",
  "projection",
  "failure_propagation",
  "watchdog",
]);
export type RiskClass = z.infer<typeof RiskClass>;

export const DebtCategory = z.enum(["dead_state_machine", "deferred", "other"]);
export type DebtCategory = z.infer<typeof DebtCategory>;
