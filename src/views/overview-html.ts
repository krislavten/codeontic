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
 * Three organizing sections, in the order a reader needs them (016 T7 — the page
 * must let someone who does not read code answer: what machinery runs by itself,
 * how is it wired together, and where is it unguarded):
 *
 *  1. the OUTSTANDING LEDGER — debt entries plus every non-`met` node. First,
 *     because these are the rows that need a human decision; the report card is
 *     the proof, not the point.
 *  2. the flows (end-to-end journeys);
 *  3. the loops NO flow references. That is the literal and only criterion for
 *     this bucket, and the section says exactly that (016 D7): a loop lands here
 *     because nothing traverses/guards it, which may mean it really is
 *     standalone background machinery OR simply that no flow has picked it up
 *     yet. The section used to ASSERT the former ("the always-on machinery —
 *     renewals, sweeps, caches, pollers") — on a real 30-loop model 21 loops
 *     landed here including the main REPL loop, so the assertion was plainly
 *     false and the wording is now the criterion itself.
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
    // group by the base package: strip any parenthetical qualifier the owner
    // free-text carries (e.g. "pkg (仅 v1 退役窗口)" → "pkg").
    const key = (l.owner ?? "（无 owner）").split(/[(（]/)[0]?.trim() || "（无 owner）";
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
  <p class="cov" id="cov"></p>
  <p class="intro">这张图把系统拆成一个个 <b>loop</b>——会自己往前走的循环：状态机、轮询、重试链、渲染循环都算。若干 loop 按执行先后接起来，就是一条<b>链路</b>：用户走完的一段完整旅程。</p>
  <p class="intro"><b>点开任何一条链路或一个 loop</b>，就能看到它的详情：在做什么、代码在哪、有没有测试守着、落实到了什么程度。链路详情里还能一步步点进它经过的每个 loop。</p>
  <div id="metawarn"></div>
  <div class="stats" id="stats"></div>
  <div class="legend">
    <span><i class="cd met"></i> 已落实：代码、测试都有</span>
    <span><i class="cd partial"></i> 半落实：有代码，缺测试</span>
    <span><i class="cd gap"></i> 有缺口：代码或测试没接上</span>
  </div>
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
    <section class="block" id="findBlock">
      <h2 id="findHead"></h2>
      <p class="sub">这里集中了图上所有没守住的地方——记录在案的旧账，和代码或测试还没接上的节点。每一条都在等一个人拍板：修掉、删掉，还是先认下。</p>
      <div id="findings"></div>
    </section>
  </div>
  <aside class="drawer" id="drawer">
    <div class="dhint" id="dhint">← 点一条链路或一个 loop<br>详情会在这里展开</div>
    <div class="dbody" id="dbody" style="display:none"></div>
  </aside>
</div>

<div class="foot" id="foot"></div>

<script id="data" type="application/json">${safeJson({ data: model, meta })}</script>
<script>
(function(){
  var P=JSON.parse(document.getElementById("data").textContent);
  var D=P.data, M=P.meta, L=D.loops;
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
  document.getElementById("flowsHead").textContent="① 用户旅程 —— "+D.flows.length+" 条端到端链路";
  // Criterion, not conclusion (016 D7): this bucket means "no flow references
  // it", which is not the same claim as "it is background machinery".
  document.getElementById("bgHead").textContent="② 不在任何链路里的 loop —— "+D.summary.background+" 个";
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

  // ---- outstanding ledger (016 T7) -------------------------------------
  var KIND={loop:"loop",flow:"链路",junction:"交接点"};
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
    "③ 欠账 —— "+(findParts.length?findParts.join(" · "):"已结清");
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
        d+='<p class="fsubj">'+esc(f.title)+'</p>';
        d+='<p class="fd"><b>实际情况：</b>'+esc(f.reality)+'</p>';
        if(f.claim) d+='<p class="fd">曾经声称：'+esc(f.claim)+'</p>';
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
  }
  window.__ovClose=function(){drawer.classList.remove("open");};
  document.addEventListener("click",function(e){
    if(!e.target.closest) return;
    // loop first: a step chip lives INSIDE the flow drawer, and both handles
    // would otherwise match a nested lookup.
    var b=e.target.closest(".chip[data-loop]");
    if(b){ showLoop(b.getAttribute("data-loop")); return; }
    var g=e.target.closest("[data-flow]");
    if(g) showFlow(g.getAttribute("data-flow"));
  });
})();
</script>`;
}
