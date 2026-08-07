import type { ModelGraph } from "../loader/model-graph.js";
import type { Conformance, ConformanceVerdict } from "../query/conformance.js";

/**
 * Whole-model interactive graph, colored by IMPLEMENTATION CONFORMANCE. Unlike
 * `flow-mermaid` (one Flow, static), this renders the behavioral backbone —
 * Features, Flows, Loops, Junctions and the edges between them — and paints
 * every loop/junction by its `conformance` verdict (met/partial/gap), so the
 * red nodes ARE the reason the page exists: a modeled obligation the code
 * can't be shown to satisfy, visible at a glance.
 *
 * This is a PROJECTION, not a source of truth: like the mermaid view it is
 * regenerated into the gitignored `.codeontic/ws/` side-channel, never
 * committed (the committed artifact is the YAML model — a descriptive
 * code-graph commits its graph because the graph IS its product; codeontic's
 * product is the model, and this HTML is just a view of it).
 *
 * Design red lines held: the output is a SINGLE self-contained HTML string —
 * inline CSS + inline JS + inline JSON, ZERO external hosts (no CDN, no fonts,
 * no remote assets) — so it opens over `file://`, survives an Artifact CSP, and
 * needs no network. Layout is DETERMINISTIC (index-seeded, no RNG): the graph
 * structure and node positions regenerate identically for the same model, so
 * `renderGraphHtml` is a pure function of (model, meta). The only per-run
 * variation in the written file is the staleness timestamp in the header —
 * exactly as the mermaid `view` output already stamps, and by design (it
 * records WHEN the projection was generated, not model content).
 */

/** Visual class of a node: loop/junction verdicts, plus non-graded kinds. */
export type NodeClass = ConformanceVerdict | "dormant" | "structural";

export interface GraphNode {
  id: string;
  kind: "feature" | "flow" | "loop" | "junction";
  title: string;
  cls: NodeClass;
  /** Short gap labels for the tooltip (loops/junctions only). */
  gaps: string[];
}

export interface GraphEdge {
  source: string;
  target: string;
  /** solid = primary sequence/containment; dashed = guard/cross; dotted = junction span; thin = parent. */
  style: "solid" | "dashed" | "dotted" | "thin";
  label?: string;
}

export interface GraphModel {
  nodes: GraphNode[];
  edges: GraphEdge[];
  summary: { met: number; partial: number; gap: number; dormant: number; structural: number };
}

/**
 * Extract the render model from the loaded graph + a conformance result. Nodes
 * are Features, Flows, Loops (dormant ones included, styled apart) and
 * Junctions; Scenarios are deliberately NOT nodes — they are leaf evidence
 * reflected in each loop/junction's verdict color, and rendering one per GWT
 * would bury the backbone. Edges are emitted only when BOTH endpoints are in
 * the node set, so a dangling reference (T0's job to flag) never draws a line
 * to nowhere.
 */
export function computeGraphModel(graph: ModelGraph, conformance: Conformance): GraphModel {
  const verdictById = new Map<string, ConformanceVerdict>();
  const gapsById = new Map<string, string[]>();
  for (const n of conformance.nodes) {
    verdictById.set(n.id, n.verdict);
    gapsById.set(
      n.id,
      n.gaps.map((g) => g.kind),
    );
  }

  const nodes: GraphNode[] = [];
  const present = new Set<string>();
  const add = (n: GraphNode) => {
    nodes.push(n);
    present.add(n.id);
  };

  for (const f of graph.byKind.feature.values())
    add({ id: f.id, kind: "feature", title: f.title, cls: "structural", gaps: [] });
  for (const fl of graph.byKind.flow.values()) {
    // A flow is graded when it carries its own anchors (F1/F2a); a
    // composition-only flow is not in `conformance.nodes` at all and stays
    // `structural`, which is the honest color for it. Hardcoding `structural`
    // for every flow made a graded flow render grey and silently dropped its
    // gaps, so the graph summary contradicted the conformance headline.
    const cls: NodeClass = verdictById.get(fl.id) ?? "structural";
    add({ id: fl.id, kind: "flow", title: fl.title, cls, gaps: gapsById.get(fl.id) ?? [] });
  }
  for (const loop of graph.byKind.loop.values()) {
    const cls: NodeClass = loop.dormant ? "dormant" : (verdictById.get(loop.id) ?? "structural");
    add({ id: loop.id, kind: "loop", title: loop.title, cls, gaps: gapsById.get(loop.id) ?? [] });
  }
  for (const j of graph.byKind.junction.values()) {
    const cls: NodeClass = verdictById.get(j.id) ?? "structural";
    add({
      id: j.id,
      kind: "junction",
      title: j.title ?? j.id,
      cls,
      gaps: gapsById.get(j.id) ?? [],
    });
  }

  const edges: GraphEdge[] = [];
  const edge = (source: string, target: string, style: GraphEdge["style"], label?: string) => {
    if (present.has(source) && present.has(target))
      edges.push(label ? { source, target, style, label } : { source, target, style });
  };
  for (const f of graph.byKind.feature.values())
    for (const flowId of f.contains) edge(f.id, flowId, "solid");
  for (const fl of graph.byKind.flow.values()) {
    for (const loopId of fl.traverses) edge(fl.id, loopId, "solid");
    for (const loopId of fl.guarded_by) edge(fl.id, loopId, "dashed", "guards");
    for (const jId of fl.crosses) edge(fl.id, jId, "dashed");
  }
  for (const j of graph.byKind.junction.values())
    for (const loopId of j.between) edge(j.id, loopId, "dotted", j.risk_class);
  for (const loop of graph.byKind.loop.values())
    if (loop.parent) edge(loop.id, loop.parent, "thin", "parent");

  const summary = { met: 0, partial: 0, gap: 0, dormant: 0, structural: 0 };
  for (const n of nodes) summary[n.cls] += 1;

  return { nodes, edges, summary };
}

export interface GraphHtmlMeta {
  /** Repo-relative model dir or a display title for the page header. */
  title: string;
  /** Staleness banner text (already formatted by the caller), shown verbatim. */
  stalenessBanner: string;
  /** Whether conformance was resolved against a repo (drives an honesty note). */
  repoResolved: boolean;
}

// --- deterministic force-directed layout (no RNG — index-seeded) -------------

const CANVAS = { w: 1600, h: 1000, pad: 60 };
/** Above this node count, skip the O(n²) force sim and keep the circle layout. */
const FORCE_NODE_CAP = 400;

interface Pt {
  x: number;
  y: number;
}

/** A point plus accumulated force, for the layout sim. */
interface Body {
  x: number;
  y: number;
  fx: number;
  fy: number;
}

function layout(model: GraphModel): Map<string, Pt> {
  const ids = model.nodes.map((n) => n.id);
  const n = ids.length;
  const pos = new Map<string, Pt>();
  if (n === 0) return pos;

  // Seed on a circle by index — deterministic, no Math.random (so a
  // regenerated page is byte-identical, per the cold==warm red line).
  const cx = CANVAS.w / 2;
  const cy = CANVAS.h / 2;
  const R = Math.min(CANVAS.w, CANVAS.h) / 2 - CANVAS.pad;
  ids.forEach((id, i) => {
    const a = (2 * Math.PI * i) / n;
    pos.set(id, { x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) });
  });

  if (n > 1 && n <= FORCE_NODE_CAP) {
    const idx = new Map(ids.map((id, i) => [id, i]));
    // Operate on an array of force-carrying point objects, not parallel numeric
    // arrays: object property access is always `number` (no noUncheckedIndexedAccess
    // undefined), so the hot loop stays clean with a single guard per indexed read.
    const P: Body[] = ids.map((id) => {
      const p = pos.get(id) as Pt;
      return { x: p.x, y: p.y, fx: 0, fy: 0 };
    });
    const adj: Array<[Body, Body]> = [];
    for (const e of model.edges) {
      const a = idx.get(e.source);
      const b = idx.get(e.target);
      const ba = a === undefined ? undefined : P[a];
      const bb = b === undefined ? undefined : P[b];
      if (ba && bb) adj.push([ba, bb]);
    }

    const ITER = 260;
    const REP = 90_000; // repulsion strength
    const SPRING = 0.012; // edge attraction
    const REST = 180; // spring rest length
    for (let step = 0; step < ITER; step++) {
      const cool = 1 - step / ITER;
      for (const p of P) {
        p.fx = 0;
        p.fy = 0;
      }
      for (let i = 0; i < n; i++) {
        const a = P[i];
        if (!a) continue;
        for (let j = i + 1; j < n; j++) {
          const b = P[j];
          if (!b) continue;
          let dx = a.x - b.x;
          let dy = a.y - b.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 0.01) {
            // Deterministic nudge (parity-based), never RNG.
            dx = (i % 2 === 0 ? 1 : -1) * 0.1;
            dy = 0.1;
            d2 = dx * dx + dy * dy;
          }
          const f = REP / d2;
          const dist = Math.sqrt(d2);
          const ux = (dx / dist) * f;
          const uy = (dy / dist) * f;
          a.fx += ux;
          a.fy += uy;
          b.fx -= ux;
          b.fy -= uy;
        }
      }
      for (const [a, b] of adj) {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const f = SPRING * (dist - REST);
        const ux = (dx / dist) * f;
        const uy = (dy / dist) * f;
        a.fx += ux;
        a.fy += uy;
        b.fx -= ux;
        b.fy -= uy;
      }
      for (const p of P) {
        // Gentle gravity toward center keeps disconnected nodes on-canvas.
        p.fx += (cx - p.x) * 0.004;
        p.fy += (cy - p.y) * 0.004;
        p.x += Math.max(-40, Math.min(40, p.fx)) * cool;
        p.y += Math.max(-40, Math.min(40, p.fy)) * cool;
      }
    }
    ids.forEach((id, i) => {
      const p = P[i];
      if (p) pos.set(id, { x: p.x, y: p.y });
    });
  }

  // Normalize into the padded canvas box so the whole graph is visible.
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const p of pos.values()) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const sx = maxX - minX < 1 ? 1 : (CANVAS.w - 2 * CANVAS.pad) / (maxX - minX);
  const sy = maxY - minY < 1 ? 1 : (CANVAS.h - 2 * CANVAS.pad) / (maxY - minY);
  const s = Math.min(sx, sy);
  for (const p of pos.values()) {
    p.x = CANVAS.pad + (p.x - minX) * s;
    p.y = CANVAS.pad + (p.y - minY) * s;
  }
  return pos;
}

/** Embed a JSON value in a <script> without letting `</script>` close the tag. */
function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/**
 * Render the whole self-contained HTML page. The server side embeds nodes (with
 * deterministic positions), edges and the summary as JSON; ALL SVG is built by
 * the inline script from that data — so free-text titles are escaped by the DOM
 * (createTextNode), never hand-concatenated into markup, and the server does no
 * SVG string escaping at all.
 */
export function renderGraphHtml(model: GraphModel, meta: GraphHtmlMeta): string {
  const pos = layout(model);
  const nodes = model.nodes.map((nd) => {
    const p = pos.get(nd.id) as Pt;
    return { ...nd, x: Math.round(p.x), y: Math.round(p.y) };
  });
  const data = safeJson({
    nodes,
    edges: model.edges,
    summary: model.summary,
    repoResolved: meta.repoResolved,
  });

  return `<div id="lg-root">
  <header id="lg-header">
    <h1>codeontic — model conformance graph</h1>
    <p class="lg-sub">${escapeText(meta.title)}</p>
    ${meta.stalenessBanner ? `<p class="lg-stale">${escapeText(meta.stalenessBanner)}</p>` : ""}
    ${
      meta.repoResolved
        ? ""
        : `<p class="lg-warn">⚠ not resolved against code (no --repo-root) — colors reflect DECLARED state, not verified</p>`
    }
    <div id="lg-summary"></div>
    <div id="lg-controls"></div>
  </header>
  <div id="lg-stage"><svg id="lg-svg" viewBox="0 0 ${CANVAS.w} ${CANVAS.h}" preserveAspectRatio="xMidYMid meet"><g id="lg-view"></g></svg></div>
  <div id="lg-tip" hidden></div>
  <script type="application/json" id="lg-data">${data}</script>
  <style>${STYLE}</style>
  <script>${SCRIPT}</script>
</div>`;
}

function escapeText(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Theme-aware; light + dark both styled. Verdict colors are colorblind-safe
// (blue/amber/red), not the naive green/yellow/red.
const STYLE = `
#lg-root{font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1c2333;background:#f7f8fb;margin:0;min-height:100vh}
#lg-header{padding:14px 18px;border-bottom:1px solid #e2e6ef}
#lg-header h1{font-size:15px;margin:0 0 2px;font-weight:650}
.lg-sub{margin:0;font-size:12px;color:#5b6577}
.lg-stale{margin:6px 0 0;font-size:11px;color:#7a8394}
.lg-warn{margin:6px 0 0;font-size:12px;color:#b45309;font-weight:600}
#lg-summary{margin-top:10px;display:flex;flex-wrap:wrap;gap:8px}
#lg-controls{margin-top:8px;display:flex;flex-wrap:wrap;gap:6px;font-size:12px}
.lg-pill{display:inline-flex;align-items:center;gap:6px;padding:3px 9px;border-radius:999px;font-size:12px;border:1px solid transparent;cursor:pointer;user-select:none}
.lg-pill .lg-dot{width:9px;height:9px;border-radius:50%}
.lg-pill.off{opacity:.35;text-decoration:line-through}
.lg-count{font-variant-numeric:tabular-nums;font-weight:650}
#lg-stage{position:relative;height:calc(100vh - 130px);overflow:hidden;cursor:grab}
#lg-stage.drag{cursor:grabbing}
#lg-svg{width:100%;height:100%;display:block}
.lg-edge{stroke:#aab2c2;fill:none;stroke-width:1.4}
.lg-edge.dashed{stroke-dasharray:6 4}
.lg-edge.dotted{stroke-dasharray:2 4;stroke:#c58a3a}
.lg-edge.thin{stroke:#c8cedb;stroke-width:1}
.lg-edge.dim{opacity:.08}
.lg-node{cursor:pointer}
.lg-node circle{stroke:#fff;stroke-width:2}
.lg-node text{font-size:12px;fill:#1c2333;paint-order:stroke;stroke:#f7f8fb;stroke-width:3px}
.lg-node.dim{opacity:.12}
.met{--c:#2563eb}.partial{--c:#d97706}.gap{--c:#dc2626}.dormant{--c:#9aa3b2}.structural{--c:#6b7280}
.lg-node circle{fill:var(--c)}
.lg-node.flow circle,.lg-node.feature circle{fill:#fff;stroke:var(--c);stroke-width:2.5}
.lg-node.feature text,.lg-node.flow text{font-weight:600}
#lg-tip{position:absolute;pointer-events:none;background:#111827;color:#f3f4f6;font-size:12px;line-height:1.5;padding:8px 10px;border-radius:8px;max-width:280px;box-shadow:0 6px 20px rgba(0,0,0,.25);z-index:5}
#lg-tip b{color:#fff}
#lg-tip .k{color:#fca5a5}
@media (prefers-color-scheme:dark){
 #lg-root{color:#e5e9f0;background:#0e1117}
 #lg-header{border-color:#232a36}
 .lg-sub{color:#9aa4b5}.lg-stale{color:#6b7688}
 .lg-edge{stroke:#3a4354}.lg-edge.thin{stroke:#2c3444}
 .lg-node text{fill:#e5e9f0;stroke:#0e1117}
 .lg-node.flow circle,.lg-node.feature circle{fill:#0e1117}
}
:root[data-theme="dark"] #lg-root{color:#e5e9f0;background:#0e1117}
:root[data-theme="dark"] #lg-header{border-color:#232a36}
:root[data-theme="dark"] .lg-node text{fill:#e5e9f0;stroke:#0e1117}
:root[data-theme="dark"] .lg-node.flow circle,:root[data-theme="dark"] .lg-node.feature circle{fill:#0e1117}
:root[data-theme="light"] #lg-root{color:#1c2333;background:#f7f8fb}
`;

// No template literals / ${} inside — kept as plain concatenation so this whole
// string drops into the page verbatim with no escaping surprises.
const SCRIPT = `
(function(){
 var data=JSON.parse(document.getElementById("lg-data").textContent);
 var CLS=[["met","met"],["partial","partial"],["gap","gap"],["dormant","dormant"],["structural","flow/feature"]];
 var COLOR={met:"#2563eb",partial:"#d97706",gap:"#dc2626",dormant:"#9aa3b2",structural:"#6b7280"};
 var R={feature:16,flow:13,loop:11,junction:12};
 var off={};
 var byId={}; data.nodes.forEach(function(n){byId[n.id]=n;});
 var NS="http://www.w3.org/2000/svg";
 var view=document.getElementById("lg-view");
 var svg=document.getElementById("lg-svg");
 var stage=document.getElementById("lg-stage");
 var tip=document.getElementById("lg-tip");

 // summary chips
 var sum=document.getElementById("lg-summary");
 var s=data.summary;
 [["gap",s.gap],["partial",s.partial],["met",s.met],["dormant",s.dormant],["structural",s.structural]].forEach(function(p){
   var el=document.createElement("span"); el.className="lg-pill"; el.style.background="rgba(0,0,0,.04)";
   var dot=document.createElement("span"); dot.className="lg-dot"; dot.style.background=COLOR[p[0]]; el.appendChild(dot);
   var lab=document.createElement("span"); lab.textContent=p[0]; el.appendChild(lab);
   var c=document.createElement("span"); c.className="lg-count"; c.textContent=p[1]; el.appendChild(c);
   sum.appendChild(el);
 });

 // filter controls
 var ctrl=document.getElementById("lg-controls");
 CLS.forEach(function(p){
   var el=document.createElement("span"); el.className="lg-pill"; el.dataset.cls=p[0];
   var dot=document.createElement("span"); dot.className="lg-dot"; dot.style.background=COLOR[p[0]]; el.appendChild(dot);
   var lab=document.createElement("span"); lab.textContent="show "+p[1]; el.appendChild(lab);
   el.onclick=function(){ off[p[0]]=!off[p[0]]; el.classList.toggle("off",off[p[0]]); apply(); };
   ctrl.appendChild(el);
 });

 // edges first (under nodes)
 var edgeEls=[];
 data.edges.forEach(function(e){
   var a=byId[e.source], b=byId[e.target]; if(!a||!b) return;
   var ln=document.createElementNS(NS,"line");
   ln.setAttribute("x1",a.x);ln.setAttribute("y1",a.y);ln.setAttribute("x2",b.x);ln.setAttribute("y2",b.y);
   ln.setAttribute("class","lg-edge "+e.style);
   ln.__e=e; view.appendChild(ln); edgeEls.push(ln);
 });

 // nodes
 var nodeEls=[];
 data.nodes.forEach(function(n){
   var g=document.createElementNS(NS,"g"); g.setAttribute("class","lg-node "+n.cls+" "+n.kind);
   g.setAttribute("transform","translate("+n.x+","+n.y+")");
   var c=document.createElementNS(NS,"circle"); c.setAttribute("r",R[n.kind]||11); g.appendChild(c);
   var t=document.createElementNS(NS,"text"); t.setAttribute("x",(R[n.kind]||11)+4); t.setAttribute("y",4);
   t.appendChild(document.createTextNode(n.id)); g.appendChild(t);
   g.__n=n; view.appendChild(g); nodeEls.push(g);
   g.addEventListener("mouseenter",function(ev){showTip(n,ev);});
   g.addEventListener("mousemove",function(ev){moveTip(ev);});
   g.addEventListener("mouseleave",function(){tip.hidden=true;});
   g.addEventListener("click",function(ev){ev.stopPropagation();focus(n);});
 });

 var neigh={}; data.nodes.forEach(function(n){neigh[n.id]={};});
 data.edges.forEach(function(e){ if(neigh[e.source]&&neigh[e.target]){neigh[e.source][e.target]=1;neigh[e.target][e.source]=1;} });
 var focused=null;

 function apply(){
   nodeEls.forEach(function(g){
     var n=g.__n; var hidden=off[n.cls];
     var dim=focused && focused!==n.id && !neigh[focused][n.id];
     g.style.display=hidden?"none":"";
     g.classList.toggle("dim",!!dim);
   });
   edgeEls.forEach(function(ln){
     var e=ln.__e; var hid=off[byId[e.source].cls]||off[byId[e.target].cls];
     var dim=focused && e.source!==focused && e.target!==focused;
     ln.style.display=hid?"none":"";
     ln.classList.toggle("dim",!!dim);
   });
 }
 function focus(n){ focused=(focused===n.id)?null:n.id; apply(); }
 svg.addEventListener("click",function(){ if(focused){focused=null;apply();} });

 function showTip(n,ev){
   var h="<b>"+n.id+"</b> · "+n.kind+" · "+n.cls+"<br>"+esc(n.title);
   if(n.gaps&&n.gaps.length){ h+="<br><span class=k>gaps:</span> "+n.gaps.join(", "); }
   tip.innerHTML=h; tip.hidden=false; moveTip(ev);
 }
 function moveTip(ev){
   var r=stage.getBoundingClientRect();
   tip.style.left=(ev.clientX-r.left+14)+"px"; tip.style.top=(ev.clientY-r.top+14)+"px";
 }
 function esc(s){var d=document.createElement("div");d.textContent=s;return d.innerHTML;}

 // pan + zoom
 var tx=0,ty=0,scale=1,dragging=false,sx=0,sy=0;
 function xform(){ view.setAttribute("transform","translate("+tx+","+ty+") scale("+scale+")"); }
 stage.addEventListener("mousedown",function(ev){ if(ev.target.closest(".lg-node"))return; dragging=true;stage.classList.add("drag");sx=ev.clientX-tx;sy=ev.clientY-ty; });
 window.addEventListener("mousemove",function(ev){ if(!dragging)return; tx=ev.clientX-sx;ty=ev.clientY-sy;xform(); });
 window.addEventListener("mouseup",function(){ dragging=false;stage.classList.remove("drag"); });
 stage.addEventListener("wheel",function(ev){ ev.preventDefault(); var f=ev.deltaY<0?1.1:0.9; var ns=Math.max(0.2,Math.min(4,scale*f));
   var r=svg.getBoundingClientRect(); var mx=ev.clientX-r.left, my=ev.clientY-r.top;
   tx=mx-(mx-tx)*(ns/scale); ty=my-(my-ty)*(ns/scale); scale=ns; xform(); },{passive:false});
 apply();
})();
`;
