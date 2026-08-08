import type { ModelGraph } from "../loader/model-graph.js";
import type { AxisStatus, Conformance, ConformanceVerdict } from "../query/conformance.js";
import type { Junction } from "../schema/index.js";
import { testTextAnchorLabel } from "../schema/model.js";
import { anchorFilePath } from "../validate/anchor.js";
import { coveredFiles } from "../validate/unregistered.js";

/**
 * `overview` — an interactive, self-contained HTML map of the WHOLE system built
 * for developer comprehension (not drift-spotting like `graph`, not one-flow like
 * `view`). Every loop is clickable and expands to plain-language detail: what it
 * does, which package owns it, where the code is, which queues it consumes, its
 * GWT test scenarios with the bound test files, and its implementation status
 * (met / partial / gap) spelled out in words — all from the model, resolved
 * against the real checkout.
 *
 * Five sections, ordered the way a person actually meets a system — whole first,
 * parts second, receipts third (016 T7 asks the page to answer: what machinery
 * runs by itself, how is it wired together, and where is it unguarded):
 *
 *  1. the PANORAMA — one picture of every modeled node, grouped by module, with
 *     junctions drawn as the couplings they are (`computeArchitecture`). The
 *     page is called a system map and had no map on it; this is it.
 *  2. the flows (end-to-end journeys);
 *  3. the loops NO flow references. That is the literal and only criterion for
 *     this bucket, and the section says exactly that (016 D7): a loop lands here
 *     because nothing traverses/guards it, which may mean it really is
 *     standalone background machinery OR simply that no flow has picked it up
 *     yet. The section used to ASSERT the former ("the always-on machinery —
 *     renewals, sweeps, caches, pollers") — on a real 30-loop model 21 loops
 *     landed here including the main REPL loop, so the assertion was plainly
 *     false and the wording is now the criterion itself.
 *  4. the MODELING DETAIL — junctions, scenario/test coverage, and consumed
 *     queues. Each of these was previously reachable only by opening the right
 *     drawer, so no one could see the set: "which handoffs exist at all" and
 *     "how many behaviors have no scenario" were unanswerable from this page.
 *  5. the OUTSTANDING LEDGER — debt entries plus every non-`met` node.
 *
 * The ledger used to open the page, on the argument that these are the rows
 * needing a decision. On a real model it opened with a wall of 500-character
 * debt prose and the reader never reached the map — the punch list is what you
 * check AFTER you know what the system is, so it now closes the page (and its
 * long bodies are clamped with an expander).
 *
 * The flow/no-flow split exists because a flow-only view silently drops more
 * than half the control loops.
 *
 * Same posture as the other views: a PROJECTION regenerated into the gitignored
 * `.codeontic/ws/` side-channel, never committed (the model is the artifact).
 * Output is ONE self-contained HTML string — inline CSS + JS + JSON, zero external
 * hosts — so it opens over `file://` and survives an Artifact CSP.
 */

export interface RefStatus {
  ref: string;
  /** repo-relative file part of the anchor, or null for a table-style anchor. */
  file: string | null;
  /** true = file exists, false = missing, null = not resolved (no repo root). */
  ok: boolean | null;
}

export interface OverviewScenario {
  id: string;
  missing?: boolean;
  given?: string;
  when?: string;
  then?: string;
  level?: string;
  tests?: RefStatus[];
}

export interface OverviewJunctionRef {
  id: string;
  title: string;
  risk: string;
  between: string[];
  /**
   * Conformance verdict for this junction. Junctions ARE graded (they count
   * toward the met/partial/gap headline), so leaving it off meant the report
   * card could show a `gap` that no element on the page accounted for — the
   * same defect the flow cards had. `null` only if the junction is somehow not
   * in the conformance result.
   */
  verdict: ConformanceVerdict | null;
}

export interface OverviewLoop {
  id: string;
  title: string;
  boundary: string;
  owner: string | null;
  section: string | null;
  parent: string | null;
  embedded: boolean;
  dormant: boolean;
  notes: string | null;
  anchors: RefStatus[];
  queues: string[];
  verdict: ConformanceVerdict | "dormant" | "unknown";
  code: AxisStatus | null;
  test: AxisStatus | null;
  gaps: { kind: string; detail: string }[];
  scenarios: OverviewScenario[];
  junctions: OverviewJunctionRef[];
}

export interface OverviewFlow {
  id: string;
  title: string;
  summary: string | null;
  steps: string[];
  guards: string[];
  junctions: OverviewJunctionRef[];
  /**
   * Conformance verdict when this flow is GRADED (it carries its own anchors —
   * F1/F2a). `null` for a composition-only flow, which is deliberately not
   * graded (its constituent loops are) and must not be dressed up as a verdict.
   * Without these the report card could show "1 met / 1 partial" while no card
   * on the page explained either number — the zero-loop repo case.
   */
  verdict: ConformanceVerdict | null;
  code: AxisStatus | null;
  test: AxisStatus | null;
  gaps: { kind: string; detail: string }[];
  /**
   * The flow's OWN code anchors (F1). In a flow-shaped repo these are the only
   * substance the card has — `steps` is empty because there are no loops to
   * traverse — so without them a zero-loop repo renders empty flow cards.
   *
   * NOT either/or with `steps`: an `anchored` flow may also compose (see
   * `flowShape` in schema/model.ts), so both render.
   */
  anchors: RefStatus[];
  /**
   * The flow's OWN GWT scenarios (F2b) — the same mechanism `Loop.scenarios`
   * uses, resolved through the same builder so both anchor forms
   * (`path#symbol` and the `{file,text}` test-title anchor, 016 T6) reach the
   * page. Absent from this payload until the flow drawer existed: the flow card
   * had nowhere to put them, so a flow could carry a fully bound scenario and
   * the page would show nothing but a title — the "how is it wired" question
   * answered halfway. 13 of pi-full's 19 flows carry their own scenarios.
   */
  scenarios: OverviewScenario[];
}

/**
 * One row of the outstanding ledger (016 T7). Two row kinds share the block
 * because they answer the same question ("where is this system not holding up")
 * and a reader should not have to visit two places for it:
 *
 *  - `debt`: a baseline debt entry — something that LOOKS like behavior but was
 *    disqualified (dead state machine, static flag, deferred build). It has no
 *    verdict because it is not graded; `reality` is the finding.
 *  - `node`: a graded loop/flow/junction whose verdict is `gap` or `partial`.
 *
 * `met` nodes are deliberately absent: this block is the punch list, and the
 * stats row above already carries the totals.
 */
export interface OverviewFinding {
  row: "debt" | "node";
  id: string;
  /** debt: `subject`. node: the node title. */
  title: string;
  /** node only: which model kind, so a reader can tell a junction row from a loop row. */
  kind?: "loop" | "flow" | "junction";
  /** node only. Debt rows are ungraded by design and must not be dressed up with one. */
  verdict?: "gap" | "partial";
  /** node only: `missing` on either axis drives the ✗ badges. */
  code?: AxisStatus;
  test?: AxisStatus;
  /** node only: the concrete gap list, same vocabulary as the drawer. */
  gaps?: { kind: string; detail: string }[];
  /** debt only: category / what is actually true / who owns it / when it may leave. */
  category?: string;
  reality?: string;
  claim?: string | null;
  owner?: string | null;
  removalCondition?: string | null;
}

export interface OverviewModel {
  summary: {
    loops: number;
    inFlow: number;
    background: number;
    /**
     * Baseline debt entries. Counted here because nothing else on the page
     * would otherwise account for them — they are not graded, so the
     * met/partial/gap headline is silent about them.
     */
    debts: number;
    /**
     * Distinct repo files the model anchors into — the numerator of the
     * coverage declaration (016 T5). Identical to `backtest`'s
     * `anchoredFileCount` because both call `coveredFiles`. Stated on the page
     * so a PARTIAL map cannot be read as the whole system. It measures how
     * thoroughly the code was searched, NOT business completeness; see the
     * page's own wording, which must keep saying so.
     */
    anchoredFiles: number;
    /**
     * Dormant loops — counted, never graded, and shown as an explicit stat so the
     * exclusion is visible rather than silent (same discipline conformance.ts
     * applies when it reports "N dormant loop(s) excluded"). NOT a partition slot:
     * a dormant loop wired into a flow is counted here AND in `inFlow` (it still
     * renders as a chip there), so these fields must not be summed to the total.
     */
    dormant: number;
    flows: number;
    /**
     * Composition-only flows kept OUT of grading (their loops are already
     * graded). Surfaced for the same reason `dormant` is: an exclusion the
     * headline depends on must be visible, never silent.
     */
    flowsExcluded: number;
    junctions: number;
    met: number;
    partial: number;
    gap: number;
  };
  flows: OverviewFlow[];
  background: { owner: string; ids: string[] }[];
  loops: Record<string, OverviewLoop>;
  /** Outstanding ledger, already ordered debt → gap → partial. */
  findings: OverviewFinding[];
}

export interface OverviewMeta {
  title: string;
  repoResolved: boolean;
  /** Base URL to prefix a repo-relative file path with, e.g. `https://github.com/o/r/blob/<sha>/`. Absent → no code links. */
  blobBase?: string | null;
  /** Link to the repo root at the pinned ref, shown in the header. */
  repoHref?: string | null;
  /** Human label for the repo + ref, e.g. `owner/repo @ 1a2b3c4`. */
  repoLabel?: string | null;
  /** When this page was generated (ISO), shown as provenance in the footer. */
  generatedAt?: string | null;
  /**
   * Fingerprint of the model bytes this page was rendered from. `repoLabel` says
   * which CODE state was graded; this says which MODEL state produced the page —
   * the two move independently, so a saved copy needs both to be interpretable.
   */
  modelHash?: string | null;
  /**
   * Commit-side half of the coverage declaration (016 T5): of the last
   * `total` commits that touched a `.ts`/`.tsx` file, `hit` of them touched a
   * file this model anchors. Same computation `codeontic backtest` reports
   * (the CLI layer literally calls it), surfaced here because the coverage
   * number belongs next to the map it qualifies, not in a separate command.
   * Absent (null) whenever no repo root was given or git could not be walked —
   * a best-effort extra, never a reason for the page to fail.
   */
  commitTouch?: { hit: number; total: number } | null;
}

/**
 * Turn a git remote URL + ref into the base URL that makes each anchor a
 * clickable code link (so a human or agent jumps straight to the file). Pure and
 * host-aware: github/GHE use `/blob/<ref>/`, gitlab uses `/-/blob/<ref>/`. Returns
 * null for a remote it can't parse (links then simply stay off). The ref is
 * pinned (usually the HEAD sha) so links point at the exact state that was graded.
 */
export function repoLinks(
  remoteUrl: string,
  ref: string,
): { blobBase: string; repoHref: string; repoLabel: string } | null {
  const url = remoteUrl.trim().replace(/^git\+/, "");
  // scp-style (git@host:owner/repo), ssh://, and https:// remotes → (host, path)
  const forms = [
    /^git@([^:]+):(.+?)(?:\.git)?\/?$/,
    /^ssh:\/\/(?:[^@]+@)?([^/]+)\/(.+?)(?:\.git)?\/?$/,
    /^https?:\/\/(?:[^@]+@)?([^/]+)\/(.+?)(?:\.git)?\/?$/,
  ];
  let host: string | undefined;
  let path: string | undefined;
  for (const re of forms) {
    const m = re.exec(url);
    if (m) {
      host = m[1];
      path = m[2];
      break;
    }
  }
  if (!host || !path) return null;
  const repoHref = `https://${host}/${path}`;
  const blobBase = /gitlab/i.test(host) ? `${repoHref}/-/blob/${ref}/` : `${repoHref}/blob/${ref}/`;
  const shortRef = /^[0-9a-f]{40}$/i.test(ref) ? ref.slice(0, 7) : ref;
  return { blobBase, repoHref, repoLabel: `${path} @ ${shortRef}` };
}

/**
 * Build the overview render model from the loaded graph + a conformance result.
 * `existingFiles` is the set of repo-relative paths that exist under the checkout
 * (from the CLI layer); when undefined, file existence is unresolved and every
 * `ok` is null (structural mode, matching conformance's own repoResolved=false).
 */
export function computeOverviewModel(
  graph: ModelGraph,
  conformance: Conformance,
  existingFiles?: Set<string>,
): OverviewModel {
  const cById = new Map(conformance.nodes.map((n) => [n.id, n]));
  const resolveRef = (ref: string): RefStatus => {
    const file = anchorFilePath(ref) ?? null;
    const ok = file === null ? null : existingFiles ? existingFiles.has(file) : null;
    return { ref, file, ok };
  };

  const junctionRef = (j: Junction): OverviewJunctionRef => ({
    id: j.id,
    title: j.title ?? j.id,
    risk: j.risk_class,
    between: j.between,
    verdict: cById.get(j.id)?.verdict ?? null,
  });

  /**
   * Junctions with `nodeId` as an endpoint. `between` accepts a FlowId as well
   * as a LoopId (Proposal 016 T4), so this is called for flows too — a
   * Flow↔Flow junction names no loop at all and, when junctions only ever hung
   * off loop cards, appeared NOWHERE on the page while still being graded into
   * the met/partial/gap headline.
   */
  const junctionsTouching = (nodeId: string): Junction[] =>
    [...graph.byKind.junction.values()].filter((j) => j.between.includes(nodeId));

  /**
   * Resolve a node's scenario ids into renderable GWT + bound tests. Shared by
   * loops AND flows: F2b gives a flow its own scenarios, and a second copy of
   * this is exactly where the `verified_by_text` omission (016 T6, "scenario
   * rendered as no-tests while conformance said test✓") would grow back.
   *
   * A dangling id returns exactly `{id, missing}` and nothing else, so "not
   * defined" stays distinguishable from "defined but empty".
   */
  const scenariosOf = (ids: string[]): OverviewScenario[] =>
    ids.map((sid) => {
      const s = graph.byKind.scenario.get(sid);
      if (!s) return { id: sid, missing: true };
      return {
        id: s.id,
        given: s.given,
        when: s.when,
        // biome-ignore lint/suspicious/noThenProperty: Given/When/Then is the GWT domain vocabulary, not a thenable
        then: s.then,
        level: s.level,
        // Both anchor forms (Proposal 016 T6): `path#symbol` strings resolve
        // through resolveRef; `{file, text}` text anchors carry their own file,
        // so existence resolves directly — omitting them here rendered a
        // text-anchored scenario as "no tests" while conformance said test✓.
        tests: [
          ...s.verified_by.map(resolveRef),
          ...s.verified_by_text.map((a) => ({
            ref: testTextAnchorLabel(a),
            file: a.file,
            ok: existingFiles ? existingFiles.has(a.file) : null,
          })),
        ],
      };
    });

  const loops: OverviewLoop[] = [...graph.byKind.loop.values()].map((l) => {
    const c = cById.get(l.id);
    const scenarios = scenariosOf(l.scenarios);
    return {
      id: l.id,
      title: l.title,
      boundary: l.boundary,
      owner: l.owner,
      section: l.section ?? null,
      parent: l.parent ?? null,
      embedded: !!l.embedded,
      dormant: !!l.dormant,
      notes: l.notes ?? null,
      anchors: l.anchors.map(resolveRef),
      queues: l.consumes_queues,
      verdict: c ? c.verdict : l.dormant ? "dormant" : "unknown",
      code: c ? c.code : null,
      test: c ? c.test : null,
      gaps: c ? c.gaps.map((x) => ({ kind: x.kind, detail: x.detail })) : [],
      scenarios,
      junctions: junctionsTouching(l.id).map(junctionRef),
    };
  });

  const flows: OverviewFlow[] = [...graph.byKind.flow.values()].map((f) => {
    const c = cById.get(f.id);
    // Two ways a junction belongs on a flow card, unioned (a junction can
    // qualify both ways and must still render once):
    //   1. the flow declares it in `crosses` — the original, explicit path;
    //   2. the junction names this flow in `between` — possible since T4 let
    //      `between` hold a FlowId. A Flow↔Flow junction has no loop card to
    //      fall back to, so without this it renders nowhere while still being
    //      graded into the headline.
    const crossed = f.crosses
      .map((jid) => graph.byKind.junction.get(jid))
      .filter((j): j is Junction => j !== undefined);
    const crossedIds = new Set(crossed.map((j) => j.id));
    const endpointOf = junctionsTouching(f.id).filter((j) => !crossedIds.has(j.id));
    return {
      id: f.id,
      title: f.title,
      summary: f.summary ?? null,
      steps: f.traverses,
      guards: f.guarded_by,
      junctions: [...crossed, ...endpointOf].map(junctionRef),
      verdict: c ? c.verdict : null,
      code: c ? c.code : null,
      test: c ? c.test : null,
      gaps: c ? c.gaps.map((x) => ({ kind: x.kind, detail: x.detail })) : [],
      anchors: f.anchors.map(resolveRef),
      scenarios: scenariosOf(f.scenarios),
    };
  });

  // Ids a flow references. May contain dangling ids (T0's referential-integrity
  // check fails the build on those, but `overview` runs ungated), so the
  // reported count below intersects with real loops rather than using this
  // set's raw size — otherwise a typo'd `traverses` entry inflates the stat and
  // breaks the inFlow + background = loops identity.
  const referencedByFlow = new Set<string>();
  for (const f of flows) {
    for (const id of f.steps) referencedByFlow.add(id);
    for (const id of f.guards) referencedByFlow.add(id);
  }

  const bg = loops.filter((l) => !referencedByFlow.has(l.id) && !l.dormant);
  const inFlowCount = loops.filter((l) => referencedByFlow.has(l.id)).length;
  const dormantCount = loops.filter((l) => l.dormant).length;
  const ownerMap = new Map<string, string[]>();
  for (const l of bg) {
    // Grouped by the SAME rule the panorama places a loop with (`moduleKeyOf`)
    // — two different normalizations would file one loop under two module
    // names on one page.
    const key = moduleKeyOf(l.owner) || "（无 owner）";
    const list = ownerMap.get(key) ?? [];
    list.push(l.id);
    ownerMap.set(key, list);
  }
  const background = [...ownerMap.entries()]
    .map(([owner, ids]) => ({ owner, ids }))
    .sort((a, b) => b.ids.length - a.ids.length);

  // Outstanding ledger (016 T7). Built from the DEBT entries plus conformance's
  // own node list rather than from the loop/flow maps above, because it must
  // cover junctions too — and because conformance is the authority on what
  // counts as short of `met`. Order is debt → gap → partial: debt is a standing
  // admission, a gap is a declared behavior with nothing holding it up, a
  // partial is held up on one axis only.
  //
  // A `test: "missing"` junction is NOT given its own bucket: on a real model
  // most such junctions are already `partial`, so a fourth section would print
  // the same row twice and the section counts would not reconcile with the
  // headline. It surfaces as a badge on the row instead.
  const findings: OverviewFinding[] = [
    ...[...graph.byKind.debt.values()].map(
      (d): OverviewFinding => ({
        row: "debt",
        id: d.id,
        title: d.subject,
        category: d.category,
        reality: d.reality,
        claim: d.claim ?? null,
        owner: d.owner ?? null,
        removalCondition: d.removal_condition ?? null,
      }),
    ),
    ...(["gap", "partial"] as const).flatMap((want) =>
      conformance.nodes
        .filter((n) => n.verdict === want)
        .map(
          (n): OverviewFinding => ({
            row: "node",
            id: n.id,
            title: n.title,
            kind: n.kind,
            verdict: want,
            code: n.code,
            test: n.test,
            gaps: n.gaps.map((g) => ({ kind: g.kind, detail: g.detail })),
          }),
        ),
    ),
  ];

  return {
    summary: {
      loops: loops.length,
      inFlow: inFlowCount,
      background: bg.length,
      debts: graph.byKind.debt.size,
      anchoredFiles: coveredFiles(graph).size,
      dormant: dormantCount,
      flows: flows.length,
      flowsExcluded: conformance.flowsExcluded,
      junctions: graph.byKind.junction.size,
      met: conformance.counts.met,
      partial: conformance.counts.partial,
      gap: conformance.counts.gap,
    },
    flows,
    background,
    loops: Object.fromEntries(loops.map((l) => [l.id, l])),
    findings,
  };
}

/* ---------------------------------------------------------------------------
 * The system panorama (`computeArchitecture`)
 *
 * The page's opening picture: what modules this system is made of, what runs
 * inside each one, and where two pieces hand off to each other. Everything is
 * derived from an already-computed `OverviewModel` and NOTHING else — no new
 * field on the payload, no config, no facts. That is a hard constraint, not a
 * preference: `docs/examples/*.html` embeds the computed model, so a diagram
 * that needed extra inputs could never be regenerated for a repo we do not
 * have a checkout of.
 *
 * Why modules-with-nodes rather than the obvious "boxes and arrows between
 * modules": measured on the pi model (30 loops, 19 flows, 7 junctions), only
 * TWO junctions cross a module boundary and NOT ONE composed flow does. A
 * module-to-module diagram would be six islands and one line — a picture that
 * looks like an architecture and says nothing. Putting the real nodes inside
 * their module boxes is what carries information at this scale: how much
 * machinery each module owns, which modules are entrances only, and where the
 * coupling actually is.
 *
 * `topology` is the other, unrelated picture (declared components + extracted
 * facts, `views/topology-html.ts`). It is deliberately NOT wired in here:
 * `overview`'s contract is that it renders from `.codeontic/model/` alone.
 */

/** Layout constants, in the SVG's own user units (the page scales the viewBox). */
const ARCH = {
  /** Canvas width the layout targets; the rendered SVG scales to its container. */
  W: 1200,
  PAD: 16,
  NODE_W: 62,
  NODE_H: 26,
  GAP: 7,
  MOD_PAD: 12,
  MOD_HEAD: 38,
  MOD_GAP: 14,
} as const;

/**
 * Base package of an `owner` free-text field: strip any parenthetical qualifier
 * ("pkg (仅 v1 退役窗口)" → "pkg") and any second package a comma-joined owner
 * names. The single source of this rule — `background`'s grouping and the
 * panorama MUST bucket a loop the same way, or the page would show one loop
 * under two different module names.
 */
export function moduleKeyOf(owner: string | null | undefined): string {
  return (owner ?? "").split(/[(（,，]/)[0]?.trim() ?? "";
}

/**
 * Monorepo container directories: `packages/client/src/x.ts` belongs to
 * `packages/client`, not to `packages`. Anything else falls back to the first
 * path segment, so a single-package repo collapses to one module (`src`) —
 * degraded, but honest, and the box still carries its nodes.
 */
const CONTAINER_DIRS = new Set(["packages", "apps", "services", "libs", "modules", "plugins"]);

/**
 * Module a repo-relative file belongs to. `known` (the module names owners
 * already produced) wins by longest prefix, so a package whose loops declare an
 * owner keeps that exact spelling; only files outside every known module fall
 * back to the path heuristic. That fallback is what puts a package with flows
 * but no loops (pi's `packages/client`, `packages/evals`) on the map at all.
 */
function moduleOfPath(file: string, known: string[]): string | null {
  const hit = known.filter((m) => file.startsWith(`${m}/`)).sort((a, b) => b.length - a.length)[0];
  if (hit) return hit;
  const segs = file.split("/");
  if (segs.length < 2) return null;
  const depth = CONTAINER_DIRS.has(segs[0] ?? "") && segs.length > 2 ? 2 : 1;
  return segs.slice(0, depth).join("/");
}

export interface ArchNode {
  id: string;
  kind: "loop" | "flow";
  /** Full title — the hover tooltip, since the node itself only fits the id. */
  title: string;
  verdict: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** For a flow: the loop ids it traverses/guards, highlighted on hover. */
  links: string[];
}

export interface ArchModule {
  key: string;
  /** `key` with the repo-wide common prefix stripped — what the box shows. */
  label: string;
  loops: number;
  flows: number;
  met: number;
  partial: number;
  gap: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ArchEdge {
  id: string;
  title: string;
  risk: string;
  verdict: string | null;
  /** Crosses a module boundary — the structurally interesting kind. */
  cross: boolean;
  /** SVG path data (a flat quadratic arc, so parallel edges stay tellable apart). */
  d: string;
}

export interface Architecture {
  w: number;
  h: number;
  /** Common path prefix stripped from every module label (may be ""). */
  prefix: string;
  modules: ArchModule[];
  nodes: ArchNode[];
  edges: ArchEdge[];
  /** Junction endpoints that reference no node on the map (dangling ids). */
  droppedEdges: number;
}

/** Fallback bucket for a node no owner and no anchor path can place. */
const UNPLACED = "（未归属）";

/**
 * Lay the panorama out. Pure and deterministic — same model in, byte-identical
 * SVG geometry out, which is what keeps `renderOverviewHtml` idempotent.
 */
export function computeArchitecture(model: OverviewModel): Architecture {
  const loops = Object.values(model.loops);
  const known = [...new Set(loops.map((l) => moduleKeyOf(l.owner)).filter(Boolean))];

  const placeLoop = (l: OverviewLoop): string =>
    moduleKeyOf(l.owner) ||
    (l.anchors[0]?.file ? moduleOfPath(l.anchors[0].file, known) : null) ||
    UNPLACED;

  // A flow carries no owner, so its module comes from its own anchors first
  // (an `anchored` flow IS code) and from the loops it traverses second (a
  // `composed` flow has no code of its own). Neither → the unplaced bucket.
  const placeFlow = (f: OverviewFlow): string => {
    for (const a of f.anchors) {
      const m = a.file ? moduleOfPath(a.file, known) : null;
      if (m) return m;
    }
    for (const id of [...f.steps, ...f.guards]) {
      const l = model.loops[id];
      if (l) {
        const m = moduleKeyOf(l.owner);
        if (m) return m;
      }
    }
    return UNPLACED;
  };

  const members = new Map<string, { flows: OverviewFlow[]; loops: OverviewLoop[] }>();
  const bucket = (key: string) => {
    const b = members.get(key) ?? { flows: [], loops: [] };
    members.set(key, b);
    return b;
  };
  for (const f of model.flows) bucket(placeFlow(f)).flows.push(f);
  for (const l of loops) bucket(placeLoop(l)).loops.push(l);

  const sizeOf = (k: string) =>
    (members.get(k)?.flows.length ?? 0) + (members.get(k)?.loops.length ?? 0);

  // Junctions are attached to every node they name, so the same junction
  // arrives many times — dedupe by id, or a 2-endpoint junction would be
  // stroked twice and read as two couplings.
  const junctions = new Map<string, OverviewJunctionRef>();
  for (const l of loops) for (const j of l.junctions) junctions.set(j.id, j);
  for (const f of model.flows) for (const j of f.junctions) junctions.set(j.id, j);

  const homeOf = new Map<string, string>();
  for (const [key, b] of members) {
    for (const f of b.flows) homeOf.set(f.id, key);
    for (const l of b.loops) homeOf.set(l.id, key);
  }
  // How strongly two modules are coupled, used only to decide who sits next to
  // whom. A cross-module junction drawn across the whole canvas is the one
  // thing that turns this picture into spaghetti, so placement fights it.
  const affinity = new Map<string, number>();
  const pairKey = (a: string, b: string) => (a < b ? `${a} ${b}` : `${b} ${a}`);
  for (const j of junctions.values()) {
    for (let i = 0; i + 1 < j.between.length; i++) {
      const ma = homeOf.get(j.between[i] ?? "");
      const mb = homeOf.get(j.between[i + 1] ?? "");
      if (!ma || !mb || ma === mb) continue;
      const k = pairKey(ma, mb);
      affinity.set(k, (affinity.get(k) ?? 0) + 1);
    }
  }

  // Biggest module first, then greedily pull in whichever remaining module is
  // most coupled to what is already placed (size breaks ties). Unplaced is a
  // residue, not a peer, so it is always last.
  const bySize = [...members.keys()]
    .filter((k) => k !== UNPLACED)
    .sort((a, b) => sizeOf(b) - sizeOf(a) || a.localeCompare(b));
  const order: string[] = [];
  const pending = new Set(bySize);
  while (pending.size) {
    let pick = "";
    let best = -1;
    for (const k of bySize) {
      if (!pending.has(k)) continue;
      let bond = 0;
      for (const placed of order) bond += affinity.get(pairKey(k, placed)) ?? 0;
      if (bond > best) {
        best = bond;
        pick = k;
      }
    }
    order.push(pick);
    pending.delete(pick);
  }
  if (members.has(UNPLACED)) order.push(UNPLACED);

  // Every module under one repo tree shares a prefix ("packages/") that costs
  // width in every single box and tells the reader nothing. Stripped for
  // display; the page states what was stripped.
  const prefix = ((): string => {
    const real = order.filter((k) => k !== UNPLACED).map((k) => k.split("/"));
    if (real.length < 2) return "";
    let i = 0;
    while (real.every((s) => s.length > i + 1 && s[i] === real[0]?.[i])) i++;
    return i ? `${real[0]?.slice(0, i).join("/")}/` : "";
  })();
  const labelOf = (key: string) =>
    key !== UNPLACED && prefix && key.startsWith(prefix) ? key.slice(prefix.length) : key;

  const modules: ArchModule[] = [];
  const nodes: ArchNode[] = [];
  const nodeById = new Map<string, ArchNode>();
  const moduleOfNode = new Map<string, string>();

  // Flow-and-loop rows share a column count so every box reads as one grid; a
  // box also widens far enough for its own name, because a truncated module
  // name ("packages/session-…") is the one label on this picture a reader
  // cannot reconstruct from context.
  const colsFor = (n: number): number => (n <= 2 ? 2 : n <= 6 ? 3 : n <= 12 ? 4 : 5);
  const rowsOf = (n: number, cols: number) => Math.ceil(n / cols);

  // Pass 1 — how big each box is.
  const plans = order.flatMap((key) => {
    const b = members.get(key);
    if (!b) return [];
    const nameCols = Math.ceil((labelOf(key).length * 7.1 + 8) / (ARCH.NODE_W + ARCH.GAP));
    const cols = Math.max(colsFor(b.flows.length + b.loops.length), Math.min(nameCols, 5));
    const rows = rowsOf(b.flows.length, cols) + rowsOf(b.loops.length, cols);
    // Entrances and loops are two groups, not one grid — an extra gap between
    // them is what makes the capsule/square distinction read as a grouping.
    const split = b.flows.length && b.loops.length ? ARCH.GAP : 0;
    return [
      {
        key,
        b,
        cols,
        split,
        w: cols * ARCH.NODE_W + (cols - 1) * ARCH.GAP + 2 * ARCH.MOD_PAD,
        h: ARCH.MOD_HEAD + rows * (ARCH.NODE_H + ARCH.GAP) - ARCH.GAP + split + ARCH.MOD_PAD,
      },
    ];
  });

  // Pass 2 — pack into rows, then lay the rows BOUSTROPHEDON (every other row
  // right-to-left). The affinity ordering above puts coupled modules next to
  // each other in `order`, and plain left-to-right wrapping then throws the
  // pair that straddles a line break to opposite corners — which is exactly
  // what happened to pi's coding-agent/agent pair, the only coupled pair it
  // has. Serpentine rows keep neighbours in `order` neighbours on the canvas.
  const rows: (typeof plans)[] = [];
  let cur: typeof plans = [];
  let curW = 0;
  for (const p of plans) {
    if (cur.length && curW + p.w > ARCH.W - 2 * ARCH.PAD) {
      rows.push(cur);
      cur = [];
      curW = 0;
    }
    cur.push(p);
    curW += p.w + ARCH.MOD_GAP;
  }
  if (cur.length) rows.push(cur);

  // Pass 3 — place boxes and their nodes.
  let cy = ARCH.PAD;
  rows.forEach((row, ri) => {
    const seq = ri % 2 === 1 ? [...row].reverse() : row;
    // Boxes in a row share the tallest one's height: ragged bottoms read as
    // sloppiness, not as information (the node count is already stated).
    const rowH = Math.max(...row.map((p) => p.h));
    let cx = ARCH.PAD;
    for (const p of seq) {
      const box: ArchModule = {
        key: p.key,
        label: labelOf(p.key),
        loops: p.b.loops.length,
        flows: p.b.flows.length,
        met: 0,
        partial: 0,
        gap: 0,
        x: cx,
        y: cy,
        w: p.w,
        h: rowH,
      };
      let ny = cy + ARCH.MOD_HEAD;
      const lay = (list: (OverviewFlow | OverviewLoop)[], kind: "loop" | "flow") => {
        list.forEach((item, i) => {
          const col = i % p.cols;
          if (col === 0 && i > 0) ny += ARCH.NODE_H + ARCH.GAP;
          const verdict =
            (kind === "flow" ? ((item as OverviewFlow).verdict ?? "unknown") : item.verdict) ||
            "unknown";
          if (verdict === "met") box.met++;
          else if (verdict === "partial") box.partial++;
          else if (verdict === "gap") box.gap++;
          const node: ArchNode = {
            id: item.id,
            kind,
            title: item.title,
            verdict,
            x: cx + ARCH.MOD_PAD + col * (ARCH.NODE_W + ARCH.GAP),
            y: ny,
            w: ARCH.NODE_W,
            h: ARCH.NODE_H,
            links:
              kind === "flow"
                ? [...(item as OverviewFlow).steps, ...(item as OverviewFlow).guards].filter(
                    (id) => model.loops[id],
                  )
                : [],
          };
          nodes.push(node);
          nodeById.set(node.id, node);
          moduleOfNode.set(node.id, p.key);
        });
        if (list.length) ny += ARCH.NODE_H + ARCH.GAP;
      };
      lay(p.b.flows, "flow");
      ny += p.split;
      lay(p.b.loops, "loop");
      modules.push(box);
      cx += p.w + ARCH.MOD_GAP;
    }
    cy += rowH + ARCH.MOD_GAP;
  });
  cy -= ARCH.MOD_GAP;

  /**
   * Where a line leaves a node: the point on its border facing the other end,
   * not its centre. Drawn centre-to-centre, a junction between two adjacent
   * nodes is entirely hidden underneath them — which on a real model is most
   * of them, since same-module couplings are the common case.
   */
  const border = (n: ArchNode, tx: number, ty: number) => {
    const cx = n.x + n.w / 2;
    const cy = n.y + n.h / 2;
    const dx = tx - cx;
    const dy = ty - cy;
    if (!dx && !dy) return { x: cx, y: cy };
    const s = Math.min(
      dx ? n.w / 2 / Math.abs(dx) : Number.POSITIVE_INFINITY,
      dy ? n.h / 2 / Math.abs(dy) : Number.POSITIVE_INFINITY,
    );
    return { x: cx + dx * s, y: cy + dy * s };
  };

  const edges: ArchEdge[] = [];
  let droppedEdges = 0;
  for (const j of junctions.values()) {
    let missing = 0;
    // `between` is usually a pair but the schema allows more; chain them, so a
    // 3-way junction shows as two segments rather than silently losing one.
    // A ONE-sided junction (`between` is `.min(1)`, so that is a legal model)
    // has no segment to draw and is NOT a dangling reference — counting it as
    // one made the page state, in words, that its id does not exist.
    for (let i = 0; i + 1 < j.between.length; i++) {
      const a = nodeById.get(j.between[i] ?? "");
      const b2 = nodeById.get(j.between[i + 1] ?? "");
      if (!a || !b2) {
        missing++;
        continue;
      }
      const from = border(a, b2.x + b2.w / 2, b2.y + b2.h / 2);
      const to = border(b2, a.x + a.w / 2, a.y + a.h / 2);
      // Bow the arc perpendicular to the segment so two junctions between the
      // same pair of neighbours do not land on top of each other.
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const len = Math.max(1, Math.hypot(dx, dy));
      const bow = Math.min(38, 11 + len * 0.12);
      const qx = Math.round((from.x + to.x) / 2 - (dy / len) * bow);
      const qy = Math.round((from.y + to.y) / 2 + (dx / len) * bow);
      edges.push({
        id: j.id,
        title: j.title,
        risk: j.risk,
        verdict: j.verdict,
        cross: moduleOfNode.get(a.id) !== moduleOfNode.get(b2.id),
        d: `M${Math.round(from.x)} ${Math.round(from.y)}Q${qx} ${qy} ${Math.round(to.x)} ${Math.round(to.y)}`,
      });
    }
    if (missing) droppedEdges++;
  }

  return {
    w: ARCH.W,
    h: Math.round(cy + ARCH.PAD),
    prefix,
    modules,
    nodes,
    edges,
    droppedEdges,
  };
}

/** Embed a JSON value in a <script> without letting `</script>` close the tag. */
function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/**
 * Render the whole self-contained interactive page. The model + meta are embedded
 * as one inline JSON island; ALL DOM (chips, detail panel) is built by the inline
 * script from that data, so free-text (titles, scenario prose) is escaped by the
 * DOM, never hand-concatenated into markup. The script uses only string
 * concatenation (no template literals / `${}`), so this whole file drops in with a
 * single interpolation — the data — and no escaping surprises.
 */
export function renderOverviewHtml(model: OverviewModel, meta: OverviewMeta): string {
  return `<title>系统地图 · codeontic overview</title>
<style>
  :root{
    --bg:#f4f6fa;--surface:#fff;--surface-2:#eef1f7;--ink:#1a2032;--ink-soft:#515a70;
    --ink-faint:#828da3;--line:#dce2ec;--accent:#3b5bdb;--accent-soft:#e9edfb;
    --met:#0e9c6c;--met-bg:#e2f4ec;--partial:#c07d0c;--partial-bg:#f7efdb;
    --gap:#c2495f;--gap-bg:#f6e6ea;--grey:#8892a6;--grey-bg:#eceff5;
    --mono:ui-monospace,"SF Mono","SFMono-Regular",Menlo,Consolas,monospace;
    --sans:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  }
  @media (prefers-color-scheme:dark){:root{
    --bg:#0d111c;--surface:#151b29;--surface-2:#1b2233;--ink:#e7ecf6;--ink-soft:#9aa5bd;
    --ink-faint:#6b7690;--line:#273049;--accent:#7c88ff;--accent-soft:#1b2340;
    --met:#33c795;--met-bg:#0f2a23;--partial:#e0a63f;--partial-bg:#2b2413;
    --gap:#e07d92;--gap-bg:#2c1a20;--grey:#8892a6;--grey-bg:#1c2333;}}
  :root[data-theme="dark"]{--bg:#0d111c;--surface:#151b29;--surface-2:#1b2233;--ink:#e7ecf6;
    --ink-soft:#9aa5bd;--ink-faint:#6b7690;--line:#273049;--accent:#7c88ff;--accent-soft:#1b2340;
    --met:#33c795;--met-bg:#0f2a23;--partial:#e0a63f;--partial-bg:#2b2413;--gap:#e07d92;
    --gap-bg:#2c1a20;--grey:#8892a6;--grey-bg:#1c2333;}
  :root[data-theme="light"]{--bg:#f4f6fa;--surface:#fff;--surface-2:#eef1f7;--ink:#1a2032;
    --ink-soft:#515a70;--ink-faint:#828da3;--line:#dce2ec;--accent:#3b5bdb;--accent-soft:#e9edfb;
    --met:#0e9c6c;--met-bg:#e2f4ec;--partial:#c07d0c;--partial-bg:#f7efdb;--gap:#c2495f;
    --gap-bg:#f6e6ea;--grey:#8892a6;--grey-bg:#eceff5;}
  *{box-sizing:border-box;}
  body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);line-height:1.6;
    -webkit-font-smoothing:antialiased;}
  .top{max-width:1280px;margin:0 auto;padding:40px 24px 20px;}
  .eyebrow{font-family:var(--mono);font-size:12px;letter-spacing:.14em;text-transform:uppercase;
    color:var(--accent);font-weight:600;}
  h1{font-size:clamp(24px,4vw,36px);letter-spacing:-.02em;margin:12px 0 4px;font-weight:750;}
  .subttl{font-family:var(--mono);font-size:13px;color:var(--ink-faint);margin:0 0 12px;}
  .intro{font-size:16px;color:var(--ink-soft);max-width:74ch;margin:0 0 6px;}
  .intro b{color:var(--ink);font-weight:650;}
  .warn{margin:14px 0 0;font-size:13px;color:var(--partial);background:var(--partial-bg);
    border-radius:9px;padding:9px 13px;max-width:74ch;}
  .cov{margin:14px 0 0;font-size:13.5px;color:var(--ink-soft);background:var(--surface);
    border:1px solid var(--line);border-radius:10px;padding:10px 13px;max-width:74ch;}
  .cov b{color:var(--ink);font-weight:700;font-variant-numeric:tabular-nums;}
  .cov .cal{display:block;margin-top:5px;font-size:12.5px;color:var(--ink-faint);}
  .stats{display:flex;flex-wrap:wrap;gap:10px;margin:22px 0 4px;}
  .stat{background:var(--surface);border:1px solid var(--line);border-radius:11px;padding:11px 16px;
    display:flex;flex-direction:column;gap:1px;min-width:96px;}
  .stat .n{font-size:22px;font-weight:750;font-variant-numeric:tabular-nums;line-height:1.1;}
  .stat .k{font-size:12px;color:var(--ink-faint);}
  .stat.met .n{color:var(--met);}.stat.partial .n{color:var(--partial);}.stat.gap .n{color:var(--gap);}
  .legend{display:flex;flex-wrap:wrap;gap:8px 18px;margin-top:14px;font-size:13px;color:var(--ink-soft);}
  .legend span{display:inline-flex;align-items:center;gap:7px;}
  .cd{width:10px;height:10px;border-radius:50%;flex:none;}
  .cd.met{background:var(--met);}.cd.partial{background:var(--partial);}.cd.gap{background:var(--gap);}
  .cd.dormant,.cd.unknown{background:var(--grey);}
  .app{max-width:1280px;margin:0 auto;padding:8px 24px 60px;display:grid;
    grid-template-columns:1fr 430px;gap:26px;align-items:start;}
  @media (max-width:980px){.app{grid-template-columns:1fr;}}
  section.block{margin-bottom:30px;}
  .block h2{font-size:15px;font-weight:700;margin:0 0 3px;}
  .block .sub{font-size:13.5px;color:var(--ink-soft);margin:0 0 14px;max-width:70ch;}
  .flow{background:var(--surface);border:1px solid var(--line);border-radius:13px;padding:16px 17px;
    margin-bottom:13px;}
  .flow .fh{display:flex;align-items:baseline;gap:9px;margin-bottom:3px;flex-wrap:wrap;}
  .flow .fid{font-family:var(--mono);font-size:12.5px;font-weight:700;color:var(--accent);}
  .flow .ft{font-size:15px;font-weight:700;}
  .flow .fd{font-size:13px;color:var(--ink-soft);margin:0 0 11px;}
  /* the flow's id+title is the drawer handle. Deliberately NOT the whole card:
     the card already contains step/guard chips with their own click targets. It
     keeps the card's own typography (a chip here would read as a step). */
  .fhead{display:inline-flex;align-items:baseline;gap:9px;flex-wrap:wrap;background:none;border:0;
    padding:0;margin:0;font-family:inherit;color:inherit;cursor:pointer;text-align:left;}
  .fhead .fchev{color:var(--ink-faint);font-size:13px;font-weight:400;}
  .fhead:hover .ft,.fhead.sel .ft,.fhead:hover .fchev{color:var(--accent);}
  .fhead:hover .ft{text-decoration:underline;text-underline-offset:3px;}
  .chain{display:flex;flex-wrap:wrap;align-items:center;gap:6px 4px;}
  .arrow{color:var(--ink-faint);font-size:13px;padding:0 1px;flex:none;}
  .chip{display:inline-flex;align-items:center;gap:7px;background:var(--surface-2);
    border:1px solid var(--line);border-radius:9px;padding:6px 10px;cursor:pointer;
    font-size:13px;color:var(--ink);font-family:inherit;transition:border-color .12s,transform .05s;
    max-width:230px;text-align:left;}
  .chip:hover{border-color:var(--accent);}
  .chip:active{transform:translateY(1px);}
  .chip.sel{border-color:var(--accent);box-shadow:0 0 0 2px var(--accent-soft);}
  .chip .cid{font-family:var(--mono);font-weight:650;font-size:12px;flex:none;}
  .chip .ct{color:var(--ink-soft);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  .guards,.juncs{margin-top:9px;font-size:12.5px;color:var(--ink-soft);display:flex;
    flex-wrap:wrap;gap:6px;align-items:center;}
  .guards .lbl,.juncs .lbl,.fanchors .lbl{font-size:11.5px;color:var(--ink-faint);font-family:var(--mono);flex:none;}
  .fanchors{margin-top:9px;font-size:12.5px;display:flex;gap:8px;align-items:flex-start;}
  .fanchors>div{min-width:0;flex:1;}
  /* junction chips carry their conformance verdict; a junction is a risk POINT,
     not automatically a problem, so a met one must not read as red. */
  .jchip{font-family:var(--mono);font-size:11.5px;background:var(--grey-bg);color:var(--ink-soft);
    padding:2px 8px;border-radius:7px;}
  .jchip.met{background:var(--met-bg);color:var(--met);}
  .jchip.partial{background:var(--partial-bg);color:var(--partial);}
  .jchip.gap{background:var(--gap-bg);color:var(--gap);}
  /* outstanding-ledger rows reuse the flow card's shell so the page keeps one
     visual language; only the left rule marks severity. */
  .fnd{background:var(--surface);border:1px solid var(--line);border-left:3px solid var(--grey);
    border-radius:13px;padding:13px 15px;margin-bottom:10px;}
  .fnd.gap{border-left-color:var(--gap);}
  .fnd.partial{border-left-color:var(--partial);}
  .fnd.debt{border-left-color:var(--ink-faint);}
  .fnd .fh{display:flex;align-items:baseline;gap:9px;flex-wrap:wrap;margin-bottom:2px;}
  .fnd .fsubj{font-size:13.5px;color:var(--ink);margin:6px 0 0;font-weight:600;}
  .fnd .fd{font-size:13px;color:var(--ink-soft);margin:5px 0 0;}
  .fnd .fmeta{font-size:12.5px;color:var(--ink-faint);margin:5px 0 0;}
  .fbadge{font-family:var(--mono);font-size:11.5px;background:var(--grey-bg);color:var(--ink-soft);
    padding:2px 8px;border-radius:7px;}
  .fbadge.miss{background:var(--gap-bg);color:var(--gap);}
  .owners{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px;}
  .owner{background:var(--surface);border:1px solid var(--line);border-radius:13px;padding:14px 15px;}
  .owner .oh{font-family:var(--mono);font-size:12.5px;font-weight:600;margin-bottom:9px;
    padding-bottom:9px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;}
  .owner .oh .oc{color:var(--ink-faint);}
  .drawer{position:sticky;top:16px;background:var(--surface);border:1px solid var(--line);
    border-radius:15px;max-height:calc(100vh - 32px);overflow:hidden;display:flex;flex-direction:column;}
  @media (max-width:980px){.drawer{position:fixed;inset:auto 0 0 0;top:auto;max-height:82vh;
    border-radius:16px 16px 0 0;transform:translateY(101%);transition:transform .2s ease;z-index:40;
    box-shadow:0 -8px 30px rgba(0,0,0,.25);}.drawer.open{transform:none;}}
  .dhint{padding:40px 22px;color:var(--ink-faint);font-size:14px;text-align:center;}
  .dbody{overflow-y:auto;padding:20px 22px 26px;}
  .dclose{display:none;}
  @media (max-width:980px){.dclose{display:inline-flex;position:absolute;right:12px;top:12px;
    background:var(--surface-2);border:1px solid var(--line);border-radius:8px;width:30px;height:30px;
    align-items:center;justify-content:center;cursor:pointer;font-size:16px;color:var(--ink-soft);z-index:2;}}
  .dtop{display:flex;align-items:flex-start;gap:10px;flex-wrap:wrap;margin-bottom:4px;}
  .did{font-family:var(--mono);font-size:13px;font-weight:700;color:var(--accent);padding-top:4px;}
  .dtitle{font-size:19px;font-weight:750;line-height:1.25;flex:1;min-width:150px;}
  .pill{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:650;
    padding:3px 10px;border-radius:999px;font-family:var(--mono);}
  .pill.met{background:var(--met-bg);color:var(--met);}
  .pill.partial{background:var(--partial-bg);color:var(--partial);}
  .pill.gap{background:var(--gap-bg);color:var(--gap);}
  .pill.dormant,.pill.unknown{background:var(--grey-bg);color:var(--grey);}
  .drow{margin-top:17px;}
  .dk{font-size:11.5px;font-family:var(--mono);text-transform:uppercase;letter-spacing:.06em;
    color:var(--ink-faint);margin-bottom:6px;font-weight:600;}
  .dv{font-size:14px;color:var(--ink);}
  .dv.soft{color:var(--ink-soft);}
  .statusbox{border-radius:10px;padding:12px 13px;font-size:13.5px;line-height:1.55;}
  .statusbox.met{background:var(--met-bg);}.statusbox.partial{background:var(--partial-bg);}
  .statusbox.gap{background:var(--gap-bg);}.statusbox.dormant,.statusbox.unknown{background:var(--grey-bg);}
  .statusbox .st{font-weight:700;}
  .gaplist{list-style:none;margin:9px 0 0;padding:0;display:flex;flex-direction:column;gap:6px;}
  .gaplist li{font-size:13px;display:flex;gap:7px;color:var(--ink-soft);}
  .gaplist li::before{content:"·";color:var(--gap);font-weight:700;flex:none;}
  .file{font-family:var(--mono);font-size:12px;background:var(--surface-2);border-radius:6px;
    padding:6px 9px;display:flex;gap:8px;align-items:center;word-break:break-all;margin-bottom:5px;}
  .file .ex{flex:none;font-weight:700;}.file .ex.y{color:var(--met);}.file .ex.n{color:var(--gap);}
  .file a{color:var(--accent);text-decoration:none;}
  .file a:hover{text-decoration:underline;}
  .repo{margin:2px 0 0;font-family:var(--mono);font-size:12.5px;}
  .repo a{color:var(--ink-soft);text-decoration:none;}
  .repo a:hover{color:var(--accent);text-decoration:underline;}
  .scn{border:1px solid var(--line);border-radius:10px;padding:11px 12px;margin-bottom:9px;}
  .scn .sid{font-family:var(--mono);font-size:11.5px;color:var(--ink-faint);margin-bottom:6px;
    display:flex;justify-content:space-between;}
  .gwt{font-size:13px;line-height:1.5;margin:0 0 3px;}
  .gwt .g{font-weight:700;color:var(--accent);font-family:var(--mono);font-size:11px;margin-right:6px;}
  .none{font-size:13.5px;color:var(--partial);background:var(--partial-bg);border-radius:9px;padding:10px 12px;}
  .queue{font-family:var(--mono);font-size:12px;background:var(--accent-soft);color:var(--accent);
    padding:2px 8px;border-radius:6px;margin:0 5px 5px 0;display:inline-block;}
  /* the flow drawer's step list: one loop per row so the order reads top-down
     (the card's inline chain is horizontal and wraps; 430px is too narrow for
     that). Chips drop their card-width cap here — there is no neighbour to
     crowd. */
  .dsteps{display:flex;flex-direction:column;gap:6px;}
  .dstep{display:flex;align-items:center;gap:8px;}
  .dstep .stepn{font-family:var(--mono);font-size:11.5px;color:var(--ink-faint);flex:none;
    min-width:16px;text-align:right;}
  .dsteps .chip,.dguards .chip{max-width:none;min-width:0;flex:1;}
  .dguards{display:flex;flex-wrap:wrap;gap:6px;}
  /* ---- panorama ---------------------------------------------------------
     Full-bleed above the two-column app grid: the picture needs the width, and
     it is the first thing the page says. Every colour comes from the same
     verdict vars the chips use, so light/dark and the theme toggle need no
     second palette. */
  .arena{max-width:1280px;margin:0 auto;padding:6px 24px 0;}
  .archbox{background:var(--surface);border:1px solid var(--line);border-radius:15px;
    padding:14px 16px 10px;overflow-x:auto;}
  svg.arch{display:block;width:100%;min-width:760px;height:auto;}
  .arch .mod{fill:var(--surface-2);stroke:var(--line);stroke-width:1;}
  .arch .modname{font-family:var(--mono);font-size:12.5px;font-weight:600;fill:var(--ink);}
  .arch .modmeta{font-family:var(--sans);font-size:11px;fill:var(--ink-faint);}
  .arch .an{cursor:pointer;}
  .arch .an rect{stroke-width:1.5;}
  .arch .an text{font-family:var(--mono);font-size:11.5px;font-weight:650;text-anchor:middle;}
  .arch .an.met rect{fill:var(--met-bg);stroke:var(--met);} .arch .an.met text{fill:var(--met);}
  .arch .an.partial rect{fill:var(--partial-bg);stroke:var(--partial);} .arch .an.partial text{fill:var(--partial);}
  .arch .an.gap rect{fill:var(--gap-bg);stroke:var(--gap);} .arch .an.gap text{fill:var(--gap);}
  .arch .an.dormant rect,.arch .an.unknown rect{fill:var(--grey-bg);stroke:var(--grey);}
  .arch .an.dormant text,.arch .an.unknown text{fill:var(--grey);}
  .arch .an:hover rect{stroke-width:2.6;}
  .arch .an.sel rect{stroke-width:3;}
  .arch .an.sel text{text-decoration:underline;}
  /* a junction is a coupling, not a verdict on the pair — colour says how it
     scored, weight says whether it crosses a module boundary (the rare, and
     therefore interesting, kind). */
  .arch .ed{fill:none;stroke:var(--grey);stroke-width:1.8;opacity:.5;}
  .arch .ed.met{stroke:var(--met);} .arch .ed.partial{stroke:var(--partial);}
  .arch .ed.gap{stroke:var(--gap);opacity:.9;}
  .arch .ed.cross{stroke-width:2.8;opacity:.95;stroke-dasharray:7 4;}
  .arch.dim .an{opacity:.22;} .arch.dim .an.hl{opacity:1;}
  .arch.dim .ed{opacity:.12;}
  .alegend{display:flex;flex-wrap:wrap;gap:7px 16px;margin-top:11px;font-size:12.5px;
    color:var(--ink-soft);align-items:center;}
  .alegend .k{display:inline-flex;align-items:center;gap:6px;}
  /* Swatches are inline SVG, not styled boxes, so the legend and the map are
     literally the same shape — a CSS box could drift from the rect it explains. */
  .alegend .sw{width:26px;height:13px;flex:none;overflow:visible;}
  .alegend .sw rect{fill:var(--grey-bg);stroke:var(--grey);stroke-width:1.5;}
  .alegend .sw .xline{stroke:var(--gap);stroke-width:2.6;stroke-dasharray:7 4;fill:none;}
  .prefixnote{margin:8px 0 0;font-size:12.5px;color:var(--ink-faint);}
  .prefixnote .mono{font-family:var(--mono);}
  /* ---- modeling detail --------------------------------------------------- */
  .dcards{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px;}
  .dcard{background:var(--surface);border:1px solid var(--line);border-radius:13px;padding:14px 15px;}
  .dcard h3{font-size:13px;margin:0 0 3px;font-weight:700;}
  .dcard .note{font-size:12.5px;color:var(--ink-faint);margin:0 0 10px;}
  .jrow{border-top:1px solid var(--line);padding:9px 0 0;margin-top:9px;}
  .jrow:first-of-type{border-top:0;padding-top:0;margin-top:0;}
  .jrow .jt{font-size:13px;font-weight:600;}
  .jrow .jm{font-size:12px;color:var(--ink-faint);font-family:var(--mono);margin-top:3px;
    display:flex;flex-wrap:wrap;gap:6px;align-items:center;}
  .bar{display:flex;height:9px;border-radius:5px;overflow:hidden;background:var(--surface-2);margin:8px 0 6px;}
  .bar i{display:block;height:100%;}
  .bar i.met{background:var(--met);} .bar i.partial{background:var(--partial);}
  .bar i.gap{background:var(--gap);} .bar i.none{background:var(--grey);}
  .kv{display:flex;justify-content:space-between;gap:10px;font-size:13px;padding:4px 0;
    border-bottom:1px dashed var(--line);}
  .kv:last-child{border-bottom:0;}
  .kv b{font-variant-numeric:tabular-nums;}
  .kv .warnv{color:var(--gap);}
  /* Debt bodies routinely run past 500 characters. Clamped, with the expander
     stating the real length so nothing looks shorter than it is. */
  .clamp{display:-webkit-box;-webkit-line-clamp:4;line-clamp:4;-webkit-box-orient:vertical;overflow:hidden;}
  .more{background:none;border:0;padding:2px 0 0;font:inherit;font-size:12.5px;color:var(--accent);
    cursor:pointer;text-decoration:underline;text-underline-offset:3px;}
  .foot{max-width:1280px;margin:0 auto;padding:20px 24px 60px;font-size:12.5px;color:var(--ink-faint);
    border-top:1px solid var(--line);}
  .foot .mono{font-family:var(--mono);background:var(--surface-2);padding:1px 5px;border-radius:4px;}
  :focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:6px;}
</style>

<div class="top">
  <div class="eyebrow">system map · codeontic overview</div>
  <h1>系统地图——每条链路、每个 loop 都能点开</h1>
  <p class="subttl" id="subttl"></p>
  <p class="repo" id="repo"></p>
  <p class="intro">系统被拆成两种东西：<b>loop</b>——会自己往前走的循环（状态机、轮询、重试链、渲染循环）；<b>链路</b>——用户走完的一段完整旅程，可能自己就绑着代码，也可能由若干 loop 按执行先后接起来。<b>图上和文中的任何一个方块、一条链路都能点开</b>，看它在做什么、代码在哪、有没有测试守着。</p>
  <div id="metawarn"></div>
  <div class="stats" id="stats"></div>
  <p class="cov" id="cov"></p>
</div>

<div class="arena">
  <section class="block">
    <h2 id="archHead"></h2>
    <p class="sub">整个系统一张图：按代码包分区，每个方块是一个建模过的东西——圆角胶囊是<b>入口链路</b>，方块是<b>loop</b>，颜色是落实程度。连线是<b>交接点</b>：两个东西交棒的位置，虚线的那条跨了包。鼠标停在一条入口上，会点亮它经过的 loop；点任何一个方块，右下详情栏展开它的全部信息。</p>
    <div class="archbox"><div id="arch"></div></div>
    <div class="alegend">
      <span class="k"><svg class="sw" viewBox="0 0 30 15" aria-hidden="true"><rect x="1" y="1" width="28" height="13" rx="6.5"/></svg> 入口链路</span>
      <span class="k"><svg class="sw" viewBox="0 0 30 15" aria-hidden="true"><rect x="1" y="1" width="28" height="13" rx="2"/></svg> loop</span>
      <span class="k"><i class="cd met"></i> 已落实：代码、测试都有</span>
      <span class="k"><i class="cd partial"></i> 半落实：有代码，缺测试</span>
      <span class="k"><i class="cd gap"></i> 有缺口：代码或测试没接上</span>
      <span class="k"><i class="cd unknown"></i> 灰的不打分：组合链路，分数在它每一步的 loop 上</span>
      <span class="k"><svg class="sw" viewBox="0 0 30 15" aria-hidden="true"><path class="xline" d="M1 7.5H29"/></svg> 跨包交接点</span>
    </div>
    <p class="prefixnote" id="prefixnote"></p>
  </section>
</div>

<div class="app">
  <div class="main">
    <section class="block">
      <h2 id="flowsHead"></h2>
      <p class="sub">每条链路里的 loop 按执行先后排列。链路下方的小签是「交接点」——两个 loop 交棒的位置，最容易出问题，所以模型把它们单独记录、单独打分。</p>
      <div id="flows"></div>
    </section>
    <section class="block" id="bgBlock">
      <h2 id="bgHead"></h2>
      <p class="sub">进这一栏只有一个原因：<b>没有任何链路用到它</b>。它可能真是独立运转的后台机器，也可能只是还没被画进某条旅程——归在这里不代表它不重要。按代码包分组；<span style="font-family:var(--mono);font-size:12px">↳</span> 表示内嵌在别的 loop 里的子循环。</p>
      <div class="owners" id="owners"></div>
    </section>
    <section class="block" id="detailBlock">
      <h2 id="detailHead"></h2>
      <p class="sub">模型里除了 loop 和链路之外的东西，集中在这里：交接在哪、行为有没有被场景写下来、场景有没有真的绑到测试。</p>
      <div class="dcards" id="details"></div>
    </section>
    <section class="block" id="findBlock">
      <h2 id="findHead"></h2>
      <p class="sub">最后是这张图上所有没守住的地方——记录在案的旧账，和代码或测试还没接上的节点。每一条都在等一个人拍板：修掉、删掉，还是先认下。</p>
      <div id="findings"></div>
    </section>
  </div>
  <aside class="drawer" id="drawer">
    <div class="dhint" id="dhint">← 点一条链路或一个 loop<br>详情会在这里展开</div>
    <div class="dbody" id="dbody" style="display:none"></div>
  </aside>
</div>

<div class="foot" id="foot"></div>

<script id="data" type="application/json">${safeJson({ data: model, meta, arch: computeArchitecture(model) })}</script>
<script>
(function(){
  var P=JSON.parse(document.getElementById("data").textContent);
  var D=P.data, M=P.meta, L=D.loops, A=P.arch;
  // Flows are shipped as an ARRAY (order is the model's), but three places need
  // them BY ID. Built here at the top rather than beside the flow renderer
  // because the outstanding ledger renders FIRST and makes its flow rows
  // clickable from this map.
  var F={}; for(var fq=0;fq<D.flows.length;fq++) F[D.flows[fq].id]=D.flows[fq];
  var VERDICT={met:"已落实",partial:"半落实",gap:"有缺口",dormant:"休眠",unknown:"未评"};
  // Debt categories are a schema enum; the page shows people words. Same
  // discipline as VERDICT/GAP below — an internal slug is never the primary
  // information a reader gets. Falls back to the raw value so a future enum
  // member degrades to visible-but-untranslated rather than blank.
  var DEBTCAT={dead_state_machine:"死状态机",deferred:"已声明、未兑现",other:"其他"};
  var GAP={
    "no-anchor":"还没绑定到具体代码",
    "anchor-missing":"绑定的代码文件已经不在了",
    "no-scenario":"还没有场景描述它的行为",
    "scenario-unverified":"写了场景，但没绑定测试",
    "test-missing":"绑定的测试文件找不到了",
    "queue-unmatched":"声明消费的队列，在代码里没找到",
    "evidence-missing":"证据指向的文件不存在"
  };
  // Text-node serialization escapes & < > but NOT double quotes, so the extra
  // replace is what makes esc() safe in an ATTRIBUTE context too (e.g. the
  // data-loop below). Without it, any free-text value placed in an attribute
  // would be an injection point.
  function esc(s){var d=document.createElement("div");d.textContent=s==null?"":String(s);
    return d.innerHTML.replace(/"/g,"&quot;");}
  function shortTitle(t){return String(t).replace(/^↳\\s*/,"");}

  document.getElementById("subttl").textContent=M.title||"";
  var repoEl=document.getElementById("repo");
  if(M.repoLabel&&M.repoHref){
    repoEl.innerHTML='仓库 <a href="'+encodeURI(M.repoHref)+'" target="_blank" rel="noopener">'+esc(M.repoLabel)+' ↗</a>';
  }else{ repoEl.style.display="none"; }
  // A module box is drawn per code package; the unplaced bucket is one too, so
  // the count is of boxes on the map and never disagrees with the picture.
  document.getElementById("archHead").textContent=
    "① 系统全景 —— "+A.modules.length+" 个代码包 · "+D.flows.length+" 个入口链路 · "+D.summary.loops+" 个 loop";
  document.getElementById("flowsHead").textContent="② 用户旅程 —— "+D.flows.length+" 条端到端链路";
  // Criterion, not conclusion (016 D7): this bucket means "no flow references
  // it", which is not the same claim as "it is background machinery".
  document.getElementById("bgHead").textContent="③ 不在任何链路里的 loop —— "+D.summary.background+" 个";
  if(!D.background.length) document.getElementById("bgBlock").style.display="none";
  if(!M.repoResolved){
    document.getElementById("metawarn").innerHTML='<p class="warn">本页没有对照真实代码生成（缺 --repo-root）：落实状态只反映模型自己的声明，锚点和测试文件是否真的存在，并没有核实过。</p>';
  }
  var prov='';
  if(M.generatedAt) prov+='生成于 <span class="mono">'+esc(M.generatedAt)+'</span>';
  if(M.modelHash) prov+=(prov?' · ':'')+'模型指纹 <span class="mono">'+esc(String(M.modelHash).slice(0,12))+'</span>';
  document.getElementById("foot").innerHTML='本页由 codeontic 从行为模型直接生成：所有 loop、链路、场景、锚点都来自 <span class="mono">.codeontic/model</span>，落实状态对照真实代码算出。改了模型或代码，重新生成这页就跟着变。'+
    (prov?'<br>'+prov:'');

  var s=D.summary;
  // Coverage declaration (016 T5). Stated before the map itself so a partial
  // model cannot be read as the whole system — and stated WITH its caliber,
  // because "how many files the model touched" is a proxy for how thoroughly
  // the code was searched, never a measure of business completeness.
  var cov='这张图绑定了 <b>'+s.anchoredFiles+'</b> 个代码文件';
  if(M.commitTouch&&M.commitTouch.total>0){
    cov+='；最近 <b>'+M.commitTouch.total+'</b> 次提交里，有 <b>'+M.commitTouch.hit+
      '</b> 次改到了它们（'+Math.round(M.commitTouch.hit/M.commitTouch.total*100)+'%）';
  }
  cov+='。<span class="cal">这两个数字只说明这张图翻过了多少代码。<b>该建模的行为有没有漏画，机器数不出来</b>——要人对着业务自己清点。</span>';
  document.getElementById("cov").innerHTML=cov;

  var stats=[["loop 总数",s.loops,""],["在链路里",s.inFlow,""],["不在任何链路里",s.background,""],
    ["已落实",s.met,"met"],["半落实",s.partial,"partial"],["有缺口",s.gap,"gap"]];
  if(s.debts) stats.push(["旧账",s.debts,""]);
  // dormant loops are registered-but-unwired placeholders: never graded, so the
  // exclusion is stated outright instead of leaving them silently missing.
  if(s.dormant) stats.push(["休眠 · 不打分",s.dormant,""]);
  // composition-only flows are graded through their loops, never on their own —
  // stated outright for the same reason dormant loops are.
  if(s.flowsExcluded) stats.push(["组合链路 · 不单独打分",s.flowsExcluded,""]);
  document.getElementById("stats").innerHTML=stats.map(function(x){
    return '<div class="stat '+x[2]+'"><span class="n">'+x[1]+'</span><span class="k">'+x[0]+'</span></div>';}).join("");

  function chip(id){
    var l=L[id]; if(!l) return '<span class="chip"><span class="cid">'+esc(id)+'</span></span>';
    var v=l.verdict||"unknown";
    return '<button class="chip" data-loop="'+esc(id)+'"><i class="cd '+v+'"></i>'+
      '<span class="cid">'+esc(id)+'</span><span class="ct">'+esc(shortTitle(l.title))+'</span></button>';
  }
  function chainHtml(ids){return ids.map(function(id,i){return (i?'<span class="arrow">→</span>':'')+chip(id);}).join("");}
  // Same chip shell as a loop's, carrying data-flow instead of data-loop — a
  // ledger row for a flow must click exactly like a ledger row for a loop.
  // A composed flow has no verdict of its own, so its dot reads "unknown"
  // rather than borrowing a colour it did not earn.
  function flowChip(id){
    var f=F[id]; if(!f) return '<span class="chip"><span class="cid">'+esc(id)+'</span></span>';
    return '<button class="chip" data-flow="'+esc(id)+'"><i class="cd '+(f.verdict||"unknown")+'"></i>'+
      '<span class="cid">'+esc(id)+'</span><span class="ct">'+esc(f.title)+'</span></button>';
  }

  // ---- ⑤ outstanding ledger (016 T7) -----------------------------------
  var KIND={loop:"loop",flow:"链路",junction:"交接点"};
  /**
   * A debt body is unbounded free prose — on a real model these run past 900
   * characters and three of them in a row turned this section into a wall.
   * Clamped to a few lines, with the expander stating the true length so a long
   * entry can never LOOK short. The lead is our own markup, never model text.
   */
  var CLAMP_AT=170;
  function prose(text,cls,lead){
    var s=text==null?"":String(text);
    if(s.length<=CLAMP_AT) return '<p class="'+cls+'">'+(lead||"")+esc(s)+'</p>';
    return '<div class="'+cls+'">'+(lead||"")+'<span class="clamp">'+esc(s)+'</span>'+
      '<button class="more" data-open="展开全文（'+s.length+' 字）" data-shut="收起">展开全文（'+
      s.length+' 字）</button></div>';
  }
  document.addEventListener("click",function(e){
    var mb=e.target.closest?e.target.closest(".more"):null;
    if(!mb) return;
    var box=mb.parentNode.querySelector("span");
    if(!box) return;
    var open=box.classList.toggle("clamp");
    mb.textContent=open?mb.getAttribute("data-open"):mb.getAttribute("data-shut");
  });
  var nGap=0,nPartial=0;
  for(var fi=0;fi<D.findings.length;fi++){
    if(D.findings[fi].verdict==="gap") nGap++;
    else if(D.findings[fi].verdict==="partial") nPartial++;
  }
  var findParts=[];
  if(s.debts) findParts.push(s.debts+" 笔旧账");
  if(nGap) findParts.push(nGap+" 个有缺口");
  if(nPartial) findParts.push(nPartial+" 个半落实");
  document.getElementById("findHead").textContent=
    "⑤ 欠账 —— "+(findParts.length?findParts.join(" · "):"已结清");
  if(!D.findings.length){
    document.getElementById("findings").innerHTML=
      '<div class="owner"><div class="dv soft">没有欠账——打过分的节点全部已落实。</div></div>';
  }else{
    document.getElementById("findings").innerHTML=D.findings.map(function(f){
      if(f.row==="debt"){
        // A debt subject is free prose and routinely runs to a paragraph, so
        // it is the card's opening SENTENCE rather than a bolded heading — a
        // 200-character bold title is unreadable and crowds out the verdict.
        var d='<div class="fnd debt"><div class="fh"><span class="fid">'+esc(f.id)+'</span>'+
          '<span class="fbadge">旧账 · '+esc(DEBTCAT[f.category]||f.category)+'</span></div>';
        d+=prose(f.title,"fsubj","");
        d+=prose(f.reality,"fd","<b>实际情况：</b>");
        if(f.claim) d+=prose(f.claim,"fd","曾经声称：");
        var meta=[];
        if(f.owner) meta.push("归属 "+f.owner);
        if(f.removalCondition) meta.push("退场条件："+f.removalCondition);
        if(meta.length) d+='<p class="fmeta">'+esc(meta.join(" · "))+'</p>';
        return d+'</div>';
      }
      // Loop and flow rows are clickable chips, so the drawer opens straight
      // from the ledger; a junction has no drawer of its own, so it stays text.
      var head=L[f.id]?chip(f.id):(F[f.id]?flowChip(f.id)
        :'<span class="fid">'+esc(f.id)+'</span><span class="ft">'+esc(shortTitle(f.title))+'</span>');
      var h='<div class="fnd '+f.verdict+'"><div class="fh">'+head+
        '<span class="pill '+f.verdict+'"><i class="cd '+f.verdict+'"></i>'+VERDICT[f.verdict]+'</span>'+
        '<span class="fbadge">'+esc(KIND[f.kind]||f.kind)+'</span>';
      if(f.code==="missing") h+='<span class="fbadge miss">代码 ✗</span>';
      if(f.test==="missing") h+='<span class="fbadge miss">测试 ✗</span>';
      h+='</div>';
      if(f.gaps&&f.gaps.length)
        h+='<ul class="gaplist">'+f.gaps.map(function(g){
          return '<li>'+esc(GAP[g.kind]||g.kind)+(g.detail?' —— '+esc(g.detail):'')+'</li>';}).join("")+'</ul>';
      return h+'</div>';
    }).join("");
  }

  document.getElementById("flows").innerHTML=D.flows.map(function(f){
    var h='<div class="flow"><div class="fh"><button class="fhead" data-flow="'+esc(f.id)+
      '"><span class="fid">'+esc(f.id)+'</span><span class="ft">'+esc(f.title)+
      '</span><span class="fchev">›</span></button>';
    // A flow with its own anchors is graded and shows its verdict. A
    // composition-only flow is graded THROUGH its loops — say that rather than
    // leave the reader guessing why this card has no verdict.
    if(f.verdict) h+='<span class="pill '+f.verdict+'"><i class="cd '+f.verdict+'"></i>'+VERDICT[f.verdict]+'</span>';
    else h+='<span class="pill unknown">组合链路</span>';
    h+='</div>';
    if(f.summary) h+='<p class="fd">'+esc(f.summary)+'</p>';
    if(f.verdict&&f.verdict!=="met")
      h+='<div class="statusbox '+f.verdict+'"><span class="st">'+VERDICT[f.verdict]+'。</span> '+esc(statusText(f))+
         ((f.gaps&&f.gaps.length)?'<ul class="gaplist">'+f.gaps.map(function(g){
           return '<li>'+esc(GAP[g.kind]||g.kind)+'</li>';}).join("")+'</ul>':'')+'</div>';
    if(f.anchors&&f.anchors.length)
      h+='<div class="fanchors"><span class="lbl">代码</span><div>'+f.anchors.map(fileRow).join("")+'</div></div>';
    if(f.steps&&f.steps.length) h+='<div class="chain">'+chainHtml(f.steps)+'</div>';
    if(f.guards&&f.guards.length)
      h+='<div class="guards"><span class="lbl">看门狗</span>'+f.guards.map(chip).join("")+'</div>';
    if(f.junctions&&f.junctions.length)
      h+='<div class="juncs"><span class="lbl">交接点</span>'+f.junctions.map(function(j){
        return '<span class="jchip '+(j.verdict||'')+'">'+esc(j.title)+' · '+esc(j.risk)+' ('+esc(j.between.join("→"))+')'+
          (j.verdict?' · '+VERDICT[j.verdict]:'')+'</span>';}).join("")+'</div>';
    return h+'</div>';
  }).join("");

  document.getElementById("owners").innerHTML=D.background.map(function(o){
    return '<div class="owner"><div class="oh"><span>'+esc(o.owner)+'</span><span class="oc">'+o.ids.length+
      '</span></div><div class="chain">'+o.ids.map(chip).join("")+'</div></div>';}).join("");

  // ---- ① the panorama --------------------------------------------------
  // Geometry is computed in TS (computeArchitecture) and shipped in the JSON
  // island; this only turns it into markup, so free text still goes through
  // esc() and the page stays layout-deterministic (no measuring, nothing that
  // depends on when fonts load or whether the drawer is open).
  function trunc(s,n){s=String(s);return s.length>n?s.slice(0,n-1)+"…":s;}
  (function(){
    var g=[],i,m,e,n;
    for(i=0;i<A.modules.length;i++){ m=A.modules[i];
      var cap=Math.floor((m.w-24)/7.1);
      var bits=[]; if(m.flows) bits.push(m.flows+" 入口"); if(m.loops) bits.push(m.loops+" loop");
      var sc=[]; if(m.met) sc.push(m.met+" 已落实"); if(m.partial) sc.push(m.partial+" 半落实");
      if(m.gap) sc.push(m.gap+" 有缺口");
      g.push('<rect class="mod" x="'+m.x+'" y="'+m.y+'" width="'+m.w+'" height="'+m.h+'" rx="11"/>'+
        '<text class="modname" x="'+(m.x+12)+'" y="'+(m.y+19)+'">'+esc(trunc(m.label,cap))+
        '<title>'+esc(m.key)+'</title></text>'+
        '<text class="modmeta" x="'+(m.x+12)+'" y="'+(m.y+32)+'">'+
        esc(trunc(bits.join(" · ")+(sc.length?"  ·  "+sc.join(" / "):""),Math.floor(cap*1.25)))+'</text>');
    }
    // Edges before nodes: a coupling line must never cover the thing it couples.
    for(i=0;i<A.edges.length;i++){ e=A.edges[i];
      g.push('<path class="ed '+esc(e.verdict||"")+(e.cross?" cross":"")+'" d="'+esc(e.d)+'">'+
        '<title>'+esc("交接点 "+e.id+"："+e.title+" · "+e.risk+(e.cross?" · 跨包":"")+
        (e.verdict?" · "+VERDICT[e.verdict]:""))+'</title></path>');
    }
    for(i=0;i<A.nodes.length;i++){ n=A.nodes[i];
      var isFlow=n.kind==="flow";
      g.push('<g class="an '+esc(n.kind)+' '+esc(n.verdict)+'" tabindex="0" role="button" data-'+
        (isFlow?"flow":"loop")+'="'+esc(n.id)+'"'+(n.links.length?' data-hl="'+esc(n.links.join(" "))+'"':'')+'>'+
        '<rect x="'+n.x+'" y="'+n.y+'" width="'+n.w+'" height="'+n.h+'" rx="'+(isFlow?n.h/2:3)+'"/>'+
        '<text x="'+(n.x+n.w/2)+'" y="'+(n.y+n.h/2+4)+'">'+esc(trunc(n.id,8))+'</text>'+
        '<title>'+esc(n.id+" · "+shortTitle(n.title)+" · "+(isFlow?"入口链路":"loop")+" · "+
        (VERDICT[n.verdict]||n.verdict))+'</title></g>');
    }
    document.getElementById("arch").innerHTML=
      '<svg class="arch" viewBox="0 0 '+A.w+' '+A.h+'" role="img" aria-label="系统全景图">'+g.join("")+'</svg>';
  })();
  var pn=document.getElementById("prefixnote"),pnBits=[];
  if(A.prefix) pnBits.push('包名省略了共同前缀 <span class="mono">'+esc(A.prefix)+'</span>');
  // A junction whose endpoints are not on the map is a dangling reference, not
  // a drawing limit — say so rather than letting the count quietly disagree
  // with ④'s list.
  if(A.droppedEdges) pnBits.push(A.droppedEdges+' 个交接点没画出来：它连的 id 在模型里不存在');
  if(pnBits.length) pn.innerHTML=pnBits.join('；'); else pn.style.display="none";
  // An empty model would render an empty frame that looks like a broken page.
  if(!A.nodes.length) document.querySelector(".arena").style.display="none";
  // Hovering an entrance lights the loops it walks through — the one relation
  // the static picture cannot draw without turning into spaghetti (a flow
  // touches up to 3 loops and 19 flows would mean ~30 more lines).
  var archWrap=document.getElementById("arch");
  function archClear(){
    var svgEl=archWrap.firstChild; if(!svgEl||!svgEl.classList) return;
    svgEl.classList.remove("dim");
    var hl=svgEl.querySelectorAll(".hl"); for(var i=0;i<hl.length;i++) hl[i].classList.remove("hl");
  }
  archWrap.addEventListener("mouseover",function(ev){
    var svgEl=archWrap.firstChild; if(!svgEl||!svgEl.classList) return;
    var t=ev.target.closest?ev.target.closest(".an[data-hl]"):null;
    archClear();
    if(!t) return;
    // Attribute lookup by scan, not by selector string: a model id is free text
    // and would break (or inject into) a querySelector.
    var want={},ids=t.getAttribute("data-hl").split(" "),i;
    for(i=0;i<ids.length;i++) want[ids[i]]=1;
    var all=svgEl.querySelectorAll(".an");
    for(i=0;i<all.length;i++){
      var id=all[i].getAttribute("data-loop");
      if(id&&want[id]) all[i].classList.add("hl");
    }
    t.classList.add("hl");
    svgEl.classList.add("dim");
  });
  archWrap.addEventListener("mouseleave",archClear);

  // ---- ④ modeling detail ------------------------------------------------
  // Junctions arrive attached to every node they name, so they are deduped by
  // id here exactly as the panorama does — one junction, one row.
  var JX={},jn=0;
  for(var lj in L) for(var ja=0;ja<L[lj].junctions.length;ja++){ JX[L[lj].junctions[ja].id]=L[lj].junctions[ja]; }
  for(var jf=0;jf<D.flows.length;jf++) for(var jb=0;jb<D.flows[jf].junctions.length;jb++){
    JX[D.flows[jf].junctions[jb].id]=D.flows[jf].junctions[jb]; }
  for(var jk in JX) jn++;
  // Scenario/test tally over BOTH node kinds — a flow carries its own scenarios
  // (F2b), so counting only loops would under-report by a third on a real model.
  var scn={total:0,tested:0,noTest:0,undef:0,broken:0},noScn=[],graded=0;
  function tallyScn(node,isFlow){
    if(isFlow&&node.verdict===null&&(!node.scenarios||!node.scenarios.length)&&node.steps&&node.steps.length) return;
    graded++;
    if(!node.scenarios||!node.scenarios.length){ noScn.push(node.id); return; }
    for(var i=0;i<node.scenarios.length;i++){
      var sc=node.scenarios[i]; scn.total++;
      if(sc.missing){ scn.undef++; continue; }
      if(!sc.tests||!sc.tests.length){ scn.noTest++; continue; }
      // A binding whose file is gone is NOT a test. Counting it as one put the
      // dead binding inside the biggest, greenest number on the card — the
      // exact shape of lie this page exists to prevent.
      var bad=0;
      for(var t=0;t<sc.tests.length;t++) if(sc.tests[t].ok===false) bad++;
      if(bad) scn.broken++; else scn.tested++;
    }
  }
  for(var ln in L) tallyScn(L[ln],false);
  for(var fn=0;fn<D.flows.length;fn++) tallyScn(D.flows[fn],true);
  var QX={},qn=0,qUnmatched={};
  for(var lq in L){
    var qs=L[lq].queues||[];
    for(var qi=0;qi<qs.length;qi++){ (QX[qs[qi]]=QX[qs[qi]]||[]).push(lq); }
    for(var gq=0;gq<(L[lq].gaps||[]).length;gq++)
      if(L[lq].gaps[gq].kind==="queue-unmatched") qUnmatched[lq]=1;
  }
  for(var qk in QX) qn++;
  document.getElementById("detailHead").textContent=
    "④ 建模细节 —— "+jn+" 个交接点 · "+scn.total+" 个场景（loop 和链路上的）"+(qn?" · "+qn+" 个队列":"");
  var cards=[];
  if(jn){
    var jrows=[];
    for(var jj in JX){ var j=JX[jj];
      var ends=j.between.map(function(id){
        var t=L[id]?shortTitle(L[id].title):(F[id]?F[id].title:null);
        return t?id+" "+t:id; });
      jrows.push('<div class="jrow"><div class="jt">'+esc(j.title||j.id)+'</div><div class="jm">'+
        '<span class="jchip '+(j.verdict||'')+'">'+esc(j.risk)+(j.verdict?' · '+VERDICT[j.verdict]:'')+'</span>'+
        esc(ends.join("  ↔  "))+'</div></div>');
    }
    cards.push('<div class="dcard"><h3>交接点 · '+jn+' 个</h3>'+
      '<p class="note">两个东西交棒的位置。模型单独记录、单独打分，因为出问题最多的就是这里。</p>'+
      jrows.join("")+'</div>');
  }
  var scnBar=[],pct=function(n){return n/Math.max(1,scn.total)*100;};
  if(scn.tested) scnBar.push('<i class="met" style="width:'+pct(scn.tested)+'%"></i>');
  if(scn.noTest) scnBar.push('<i class="partial" style="width:'+pct(scn.noTest)+'%"></i>');
  if(scn.broken+scn.undef) scnBar.push('<i class="gap" style="width:'+pct(scn.broken+scn.undef)+'%"></i>');
  cards.push('<div class="dcard"><h3>场景与测试覆盖</h3>'+
    '<p class="note">场景就是用业务的话写下的一条行为：给定…当…则…。它必须指向一个真实存在的测试文件，机器才认。</p>'+
    '<div class="bar">'+(scnBar.join("")||'<i class="none" style="width:100%"></i>')+'</div>'+
    '<div class="kv"><span>写下来的场景</span><b>'+scn.total+'</b></div>'+
    '<div class="kv"><span>绑到了真实存在的测试</span><b>'+scn.tested+'</b></div>'+
    '<div class="kv"><span>写了场景、没绑测试</span><b'+(scn.noTest?' class="warnv"':'')+'>'+scn.noTest+'</b></div>'+
    (scn.broken?'<div class="kv"><span>绑了测试、文件已不在</span><b class="warnv">'+scn.broken+'</b></div>':'')+
    (scn.undef?'<div class="kv"><span>引用了不存在的场景</span><b class="warnv">'+scn.undef+'</b></div>':'')+
    '<div class="kv"><span>一个场景都没有的节点</span><b'+(noScn.length?' class="warnv"':'')+'>'+
      noScn.length+' / 共 '+graded+' 个</b></div>'+
    // Clickable, not a bare id list: an id alone tells a reader nothing, and
    // "which behaviors have nothing written down" is exactly the question you
    // want to follow into the drawer.
    (noScn.length?'<div class="chain" style="margin-top:9px">'+
      noScn.map(function(id){return L[id]?chip(id):flowChip(id);}).join("")+'</div>':'')+
    // Scope, stated: junctions can carry scenarios too and are NOT counted
    // here (the drawer payload does not carry them). Their own shortfalls are
    // graded and land in ⑤, so nothing is lost — but a number whose scope is
    // unstated is a number that will be read as the whole model's.
    '<p class="note" style="margin:10px 0 0">以上只数 loop 和链路自己的场景；交接点也能带场景，这里没有计入——它们缺什么，看 ⑤ 欠账。<br>另外，机器只核对测试文件在不在、指得对不对。<b>它不判断这个测试是否真的测到了场景说的事</b>——那要跑你的代码，门禁永远不跑。</p>'+
    '</div>');
  if(qn){
    var qrows=[];
    for(var qq in QX){
      var owners=QX[qq],bad=0;
      for(var oi=0;oi<owners.length;oi++) if(qUnmatched[owners[oi]]) bad++;
      qrows.push('<div class="jrow"><div class="jt">'+esc(qq)+(bad?' <span class="fbadge miss">代码里没找到</span>':'')+
        '</div><div class="jm">'+owners.map(function(id){return esc(id+" "+shortTitle(L[id].title));}).join("  ·  ")+
        '</div></div>');
    }
    cards.push('<div class="dcard"><h3>队列与消费关系 · '+qn+' 个</h3>'+
      '<p class="note">模型声明「这个 loop 消费这个队列」，适配器再去代码里找同名的队列对账。</p>'+
      qrows.join("")+'</div>');
  }
  document.getElementById("details").innerHTML=cards.join("");

  var drawer=document.getElementById("drawer"),hint=document.getElementById("dhint"),body=document.getElementById("dbody");
  function fileRow(r){
    var ex=r.ok===null?'':'<span class="ex '+(r.ok?'y':'n')+'">'+(r.ok?'✓ 存在':'✗ 缺失')+'</span>';
    var label=esc(r.ref);
    // link to the real file on the git host when a blob base is known and this
    // is a file-symbol anchor (table anchors have no file → plain text).
    var inner=(M.blobBase&&r.file)
      ? '<a href="'+encodeURI(M.blobBase+r.file)+'" target="_blank" rel="noopener">'+label+' ↗</a>'
      : '<span>'+label+'</span>';
    return '<div class="file">'+ex+inner+'</div>';
  }
  function statusText(l){
    if(l.verdict==="met") return "代码和测试都接上了：这个行为绑定在真实代码上，也有测试守着。";
    if(l.verdict==="partial") return "代码接上了，测试还有缺口。缺什么，列在下面。";
    if(l.verdict==="gap") return "模型写下了这个行为，但代码或测试还没接上。这笔账记在实现那边——不是模型写错了，是代码还没兑现。";
    if(l.verdict==="dormant") return "休眠：登记了但还没接线，不参与打分。";
    return "";
  }
  function showLoop(id){
    var l=L[id]; if(!l) return;
    var v=l.verdict||"unknown";
    var h='<button class="dclose" onclick="__ovClose()">✕</button>';
    h+='<div class="dtop"><span class="did">'+esc(l.id)+'</span><span class="dtitle">'+esc(shortTitle(l.title))+'</span></div>';
    h+='<div><span class="pill '+v+'"><i class="cd '+v+'"></i>'+VERDICT[v]+'</span>'+
       (l.embedded&&l.parent?' <span class="pill unknown">内嵌于 '+esc(l.parent)+'</span>':'')+'</div>';
    h+='<div class="drow"><div class="dk">在做什么</div><div class="dv">'+esc(shortTitle(l.title))+
       '</div><div class="dv soft" style="margin-top:6px">状态流转：'+esc(l.boundary)+'</div></div>';
    h+='<div class="drow"><div class="dk">落实到什么程度</div><div class="statusbox '+v+'">'+
       '<span class="st">'+VERDICT[v]+'。</span> '+esc(statusText(l));
    if(l.gaps&&l.gaps.length)
      h+='<ul class="gaplist">'+l.gaps.map(function(g){return '<li>'+esc(GAP[g.kind]||g.kind)+'</li>';}).join("")+'</ul>';
    h+='</div></div>';
    h+='<div class="drow"><div class="dk">归属</div><div class="dv soft">'+esc(l.owner||"（未标归属）")+'</div></div>';
    h+='<div class="drow"><div class="dk">代码在哪</div>';
    h+=(l.anchors&&l.anchors.length)?l.anchors.map(fileRow).join(""):'<div class="none">还没绑定到具体代码。</div>';
    h+='</div>';
    if(l.queues&&l.queues.length)
      h+='<div class="drow"><div class="dk">消费的队列</div><div>'+
         l.queues.map(function(q){return '<span class="queue">'+esc(q)+'</span>';}).join("")+'</div></div>';
    h+=scenarioRows(l.scenarios,"还没有场景描述它的行为。");
    h+=junctionRows(l.junctions,"相关交接点");
    if(l.notes)
      h+='<div class="drow"><div class="dk">维护者备注</div><div class="dv soft" style="white-space:pre-wrap;font-size:13px">'+esc(l.notes)+'</div></div>';
    openDrawer(h,'[data-loop="'+id+'"]');
  }
  /**
   * The flow drawer (a flow is a user JOURNEY — the entry point a human reads
   * the system through, so it gets the same depth a loop gets, not a card and
   * a shrug). Deliberately mirrors showLoop section for section: same verdict
   * pill, same status box, same fileRow anchors, same GWT scenario rows, same
   * junction rows — a reader should not have to learn a second layout.
   *
   * Two things only a flow has: the STEP list (each step opens that loop's own
   * drawer, which is how a journey stays walkable) and the composed-flow
   * explanation where a loop would show a verdict.
   */
  function showFlow(id){
    var f=F[id]; if(!f) return;
    var v=f.verdict||"unknown";
    var h='<button class="dclose" onclick="__ovClose()">✕</button>';
    h+='<div class="dtop"><span class="did">'+esc(f.id)+'</span><span class="dtitle">'+esc(f.title)+'</span></div>';
    h+='<div><span class="pill '+v+'">'+(f.verdict?'<i class="cd '+v+'"></i>'+VERDICT[v]:'组合链路')+'</span>'+
       ' <span class="fbadge">链路</span>';
    // The two conformance axes, spelled out. The card only ever showed the
    // combined verdict, so "partial" left the reader to guess WHICH half is
    // missing — the drawer is where that stops being a guess.
    if(f.code) h+=' <span class="fbadge'+(f.code==="missing"?' miss':'')+'">代码 '+(f.code==="missing"?'✗':'✓')+'</span>';
    if(f.test) h+=' <span class="fbadge'+(f.test==="missing"?' miss':'')+'">测试 '+(f.test==="missing"?'✗':'✓')+'</span>';
    h+='</div>';
    if(f.summary) h+='<div class="drow"><div class="dk">在做什么</div><div class="dv">'+esc(f.summary)+'</div></div>';
    h+='<div class="drow"><div class="dk">落实到什么程度</div><div class="statusbox '+v+'">';
    if(f.verdict){
      h+='<span class="st">'+VERDICT[v]+'。</span> '+esc(statusText(f));
      if(f.gaps&&f.gaps.length)
        h+='<ul class="gaplist">'+f.gaps.map(function(g){return '<li>'+esc(GAP[g.kind]||g.kind)+'</li>';}).join("")+'</ul>';
    }else{
      // A composed flow is NOT ungraded-by-oversight: its parts carry the score
      // and double-counting them here would inflate the headline. Say which,
      // and point at where the score actually lives.
      h+='<span class="st">这是一条组合链路。</span>它只负责把下面几个 loop 串起来，自己不单独打分。'+
         '它落实到什么程度，看每一步 loop 自己的圆点。';
    }
    h+='</div></div>';
    h+='<div class="drow"><div class="dk">链路自己的代码</div>';
    // An anchored flow MAY also compose, so anchors and steps are never
    // either/or — both render, and the empty case says which kind this is.
    h+=(f.anchors&&f.anchors.length)?f.anchors.map(fileRow).join("")
      :'<div class="none">链路本身没有代码锚点'+((f.steps&&f.steps.length)?'——实现都在下面的步骤里。':'。')+'</div>';
    h+='</div>';
    if(f.steps&&f.steps.length)
      h+='<div class="drow"><div class="dk">步骤 · 按执行先后</div><div class="dsteps">'+
         f.steps.map(function(sid,i){
           return '<div class="dstep"><span class="stepn">'+(i+1)+'</span>'+chip(sid)+'</div>';}).join("")+'</div></div>';
    if(f.guards&&f.guards.length)
      h+='<div class="drow"><div class="dk">看门狗 · 不在步骤里，但盯着这条链路</div><div class="dguards">'+
         f.guards.map(chip).join("")+'</div></div>';
    h+=scenarioRows(f.scenarios,"链路本身还没有场景"+
      ((f.steps&&f.steps.length)?"——每一步 loop 可能各自有，点进去看。":"。"));
    h+=junctionRows(f.junctions,"穿过的交接点");
    openDrawer(h,'[data-flow="'+id+'"]');
  }
  /** GWT scenario block — identical for loops and flows (F2b gives both). */
  function scenarioRows(list,emptyText){
    var h='<div class="drow"><div class="dk">测试覆盖 · '+list.length+' 个场景</div>';
    if(!list.length) return h+'<div class="none">'+esc(emptyText)+'</div></div>';
    return h+list.map(function(sc){
      if(sc.missing) return '<div class="scn"><div class="sid">'+esc(sc.id)+' · 未定义</div></div>';
      var t='<div class="scn"><div class="sid"><span>'+esc(sc.id)+'</span><span>'+esc(sc.level)+'</span></div>';
      t+='<p class="gwt"><span class="g">给定</span>'+esc(sc.given)+'</p>';
      t+='<p class="gwt"><span class="g">当</span>'+esc(sc.when)+'</p>';
      t+='<p class="gwt"><span class="g">则</span>'+esc(sc.then)+'</p>';
      t+=(sc.tests&&sc.tests.length)?'<div style="margin-top:8px">'+sc.tests.map(fileRow).join("")+'</div>'
         :'<div class="none" style="margin-top:8px">这个场景还没绑定测试。</div>';
      return t+'</div>';
    }).join("")+'</div>';
  }
  /** Junction block — same jchip vocabulary the cards use. */
  function junctionRows(list,label){
    if(!list||!list.length) return '';
    return '<div class="drow"><div class="dk">'+esc(label)+'</div>'+list.map(function(j){
      return '<div class="dv soft" style="margin-bottom:5px"><span class="jchip '+(j.verdict||'')+'">'+esc(j.title)+
      (j.verdict?' · '+VERDICT[j.verdict]:'')+'</span> '+esc(j.risk)+' · '+esc(j.between.join(" ↔ "))+'</div>';}).join("")+'</div>';
  }
  /**
   * Swap the drawer body and move the selection highlight. Selection is cleared
   * across BOTH handle kinds: opening a loop after a flow used to leave the
   * flow's header lit, so the page claimed two things were open at once.
   */
  function openDrawer(html,selector){
    hint.style.display="none"; body.style.display="block"; body.innerHTML=html;
    drawer.classList.add("open"); body.scrollTop=0;
    var sel=document.querySelectorAll(".sel"); for(var i=0;i<sel.length;i++) sel[i].classList.remove("sel");
    var m=document.querySelectorAll(selector); for(var k=0;k<m.length;k++) m[k].classList.add("sel");
    // The panorama sits ABOVE the drawer's column, so a click up there would
    // otherwise fill a drawer nobody can see. Only scrolls when the drawer is
    // actually off-screen, and only on the wide layout (narrow puts the drawer
    // in a bottom sheet that is already in view).
    if(window.innerWidth>980){
      var r=drawer.getBoundingClientRect();
      if(r.top<0||r.top>window.innerHeight-160) drawer.scrollIntoView({behavior:"smooth",block:"start"});
    }
  }
  window.__ovClose=function(){drawer.classList.remove("open");};
  function openFrom(t){
    // loop first: a step chip lives INSIDE the flow drawer, and both handles
    // would otherwise match a nested lookup. The selector is deliberately NOT
    // scoped to .chip — the panorama's SVG nodes carry the same data-loop /
    // data-flow attributes and must click exactly like a chip does.
    var b=t.closest("[data-loop]");
    if(b){ showLoop(b.getAttribute("data-loop")); return true; }
    var g=t.closest("[data-flow]");
    if(g){ showFlow(g.getAttribute("data-flow")); return true; }
    return false;
  }
  document.addEventListener("click",function(e){ if(e.target.closest) openFrom(e.target); });
  // The SVG nodes are focusable (role=button); without this they would be the
  // only handles on the page a keyboard cannot open.
  document.addEventListener("keydown",function(e){
    if(e.key!=="Enter"&&e.key!==" ") return;
    if(!e.target||!e.target.closest||!e.target.closest("svg.arch")) return;
    if(openFrom(e.target)) e.preventDefault();
  });
})();
</script>`;
}
