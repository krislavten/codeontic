<p align="center">
  <img src="docs/assets/hero.svg" width="100%" alt="codeontic — the model is your system's skeleton; code is a projection you can rewrite freely while the skeleton stays true.">
</p>

<p align="center">
  <b>The model is your system's skeleton. Code is a projection — rewrite it freely; the skeleton stays true.</b><br>
  <sub>understand · refactor · never drift &nbsp;·&nbsp; deterministic, zero-LLM &nbsp;·&nbsp; <a href="README.zh-CN.md">中文</a></sub>
</p>

---

## The question this started from

At a deploy review, an ops engineer asked about a service an agent had written most of: **"do you still have control over this code?"**

The honest answer was no — not in the sense they meant. Nobody had read every line, and nobody was going to.

The wrong fix is to go back. Writing it by hand is slower, that gap is widening, and agents writing the code is a one-way door — this project takes that as settled and does not argue it. So "control" has to mean something else: not *someone has read all of it*, but **the system's intended behavior is written down somewhere a machine can hold the code to.**

## Why reading more code is not the fix

A real repo is hundreds of files and hundreds of thousands of lines. A person cannot read it all. An agent cannot either — it does not fit in the context window, retrieval returns fragments, and a fragment is enough to produce an answer that sounds right and is wrong. "Just read the codebase" is not an option for either of you.

And the question that matters is not whether one file is correct. It is: **what machinery in here runs on its own? How does a request get from A to B? Where is nothing guarding?** Those answers live in no single file — which is why nobody can look them up, and why everyone's mental picture of the system rots.

## The move: a layer above the code

Nobody controls a modern system by reading its machine code. We put a language above it and let a compiler keep the two in step. Do it once more, one level up: put a **behavioral model** above the source that states how the system is supposed to run, and let a deterministic checker keep the code honest to it.

That layer is not documentation — documentation has no way to be wrong out loud. It is a structured model, bound to real code symbols, checked on every pull request.

## What gets modeled

<p align="center">
  <img src="docs/assets/graph.svg" width="100%" alt="A small behavioral graph: loop and junction nodes colored by conformance status (met, partial, gap), with one loop node anchored by a dashed line to a real code symbol.">
</p>

A closed vocabulary of five node kinds, written as YAML, one node per file:

| | |
| --- | --- |
| **loop** | machinery that advances itself: state machines, pollers, retry chains, render loops |
| **flow** | an end-to-end journey — either composed of loops in execution order, or pinned straight to code (a CLI path, a one-shot pipeline) |
| **junction** | where two of them hand off — the seam things break at, graded on its own |
| **scenario** | one behavior in business language (given / when / then), pointing at a real test |
| **debt** | something that looks like behavior but was disqualified — a dead state machine, a declared-but-unbuilt capability |

```yaml
# .codeontic/model/loops/*.yaml — one background control loop (fictional example)
- id: L1
  kind: loop
  title: Order state machine
  boundary: "pending → processing → shipped/cancelled; cancelled is terminal"
  owner: packages/orders
  anchors: ["packages/orders/src/order-service.ts#OrderService"]  # pinned to a real symbol
  consumes_queues: ["order:process"]                              # producer/consumer split, matched by name
  scenarios: [GWT-A1-001]                                         # GWT scenarios, verified_by → real tests
```

A repo with no background loops at all — a CLI, a build tool, a one-shot pipeline — models its journeys directly instead:

```yaml
# .codeontic/model/flows/*.yaml — a journey that carries its own code binding
- id: C1
  kind: flow
  shape: anchored                            # pinned to code directly (vs `composed`: made of other nodes)
  title: Install a skill
  anchors: ["src/install.ts#install"]        # same pinning as a loop
  scenarios: [GWT-C1-001]
```

**Where the idea comes from.** The design borrows from **ontology** — the old practice of describing a domain as a fixed set of concepts and relations a machine can work with. These five kinds are a small ontology purpose-built for system behavior, with the direction reversed: a classical ontology is induced from reality, and reality is always right. This model is **normative** — write down how the system is supposed to run, then hold the code to it. An induced graph can only describe the present; a normative model can judge it.

## The model is the truth; the code is a projection

This is the part that flips the usual order. The model is authoritative. Code is what currently projects it — and a projection can be rewritten, regenerated, or thrown away as long as the skeleton it projects stays intact. Which is exactly the property you want in a repo where agents do the writing.

So when the two disagree, the verdict is not "the model is out of date." It is **a debt the implementation owes the model** — the same direction of judgment a compiler has over the assembly it emits.

<p align="center">
  <img src="docs/assets/directions.svg" width="100%" alt="Three directions between the model and the code: conformance (model to code, graded), reconcile (code to model), and coverage (the model's own anchoring). Code aligns to the model, never the reverse.">
</p>

A descriptive **code graph** derives itself *from* the code, so it can never tell you the code is wrong — it only tells you what the code is. codeontic keeps an independent source of truth and checks it three ways, and the direction never reverses:

- **`conformance`** — model → code: the report card, grading each node and naming its gap.
- **`reconcile`** — code → model: signals the code has that the model forgot to register (a queue, a timer, a poller).
- **`coverage`** — the model's own self-check: how much of the model is actually bound to code.

## How the model is kept honest

A claim in the model is bound to reality in three places, and a deterministic gate checks all three on every pull request:

1. the behavior is **pinned to a real code symbol** (`anchors: path#symbol`);
2. it is **written down as a GWT scenario** (given / when / then, in business language);
3. the scenario **points at a real test** (`verified_by` — a symbol anchor, or `{file, text}` when the test's title is a sentence with spaces).

That is also how the model reports on your **tests** rather than just your code. It is a structural audit, not a semantic one: every modeled behavior — including each junction, where two components hand off — either has a scenario pointing at a test that exists, or it is named as a gap. On a real repo that surfaces the behaviors nobody wrote a scenario for and the scenarios whose test file no longer exists, which is the part a coverage percentage cannot see.

The engine verifies that these things *exist* and *point where they claim*. It does **not** judge whether a test truly asserts its scenario — proving that would mean running your code, and the gate never does. The line is deliberate, and the page says so wherever it reports a number.

<p align="center">
  <img src="docs/assets/report-card.svg" width="100%" alt="A conformance report card: each modeled behavior graded met, partial, or gap with the missing piece named, plus an 8-met / 3-partial / 1-gap summary bar.">
</p>

## What you get out of it

- **Refactor often, at low stakes.** Because code only projects the skeleton, you can rewrite or regenerate it freely; `conformance` proves the rewrite still honors the shape. The skeleton is stable; the code is fluid — even disposable.
- **A basis for architecture decisions.** Four independent implementations of one idea, machinery with no production consumer, one loop shape repeated across three packages — those are decisions, and they only become visible when the whole system is on one page.
- **An agent can look things up instead of guessing.** `codeontic mcp` serves model slices (impact, scenarios, evidence) so an agent answers from the model rather than from whatever the retriever happened to return.
- **Every PR checks the alignment.** The gate is sub-second and calls no model, so it costs nothing to run on every change — and drift gets caught in the PR that caused it, not two quarters later.

## A real map

[earendil-works/pi](https://github.com/earendil-works/pi) is a public agent-harness monorepo: 10 packages, ~670 TypeScript source files. Here is the whole repo modeled.

| | |
| --- | --- |
| model | 30 loops · 19 flows · 7 junctions · 4 debts · 51 scenarios |
| built by | 5 parallel agent sessions, then one human pass to merge and adjudicate |
| gate | `check --strict-anchors` → exit 0, zero warnings |
| coverage | 52 code files anchored; 13 of the last 26 commits touched one of them (50%) |
| conformance | 43 met · 7 partial · 2 gap |

<p align="center">
  <img src="docs/assets/showcase-pi.png" width="100%" alt="The pi system map: end-to-end journeys on the left, colored by conformance status, and one journey opened on the right — what it does, the loops it is composed of in execution order, its test coverage, and the junctions it crosses.">
</p>

**[Open the full interactive map](https://krislavten.github.io/codeontic/examples/pi-overview.html)** — it opens on one panorama of every modeled node grouped by package, then the journeys, the modeling detail, and the outstanding ledger last. Every node opens into a drawer, and code links point at pi's real files at `666d897`. It is one self-contained HTML file, committed at [`docs/examples/pi-overview.html`](docs/examples/pi-overview.html), so it also works offline after a download.

pi is healthy and actively developed — every large codebase carries a ledger like this one. The point is that the map put it where a person could see it:

- **Three implementations that are complete but not wired up** — finished machinery with no production consumer yet.
- **Four independent "check staleness → refresh" implementations** that share no code, in one package. Individually reasonable; as a set, a consolidation decision.
- **One loop *shape* — "a recursive `setTimeout` that re-arms itself" — living in three unrelated packages**: render throttling, a SQLite writer's lease heartbeat, and a WebSocket session pool's keepalive. Grep for `setInterval` and you miss the entire class.

The last one is the argument for modeling the whole repo rather than one subsystem: cross-cutting patterns only exist at full scale. Method and evidence: [Proposal 016](docs/proposals/016-three-layer-adoption-plan.md).

## Quick start

```bash
npx codeontic init          # model skeleton + agent kit + /codeontic skill front door
npx codeontic check . --repo-root . --strict-anchors   # deterministic gate (sub-second, zero-LLM)
npx codeontic conformance . --repo-root .              # met / partial / gap report card
npx codeontic overview . --repo-root .                 # the interactive system map above
```

`init` writes a `.codeontic/` skeleton and an **agent kit**: instructions a coding agent in your repo follows to discover behavior and draft the model. You review the drafts; nothing lands unverified.

### Commands

| command | what it does | fails a PR? |
| --- | --- | --- |
| `check` | Deterministic gate: schema, reference integrity, acyclic graph, anchor existence, canonical-writer (AST) invariants — plus cross-node consistency as warnings (two nodes claiming one symbol, dangling ids in free text). `--diff` for incremental runs. | **yes** — the only one |
| `conformance` | Model → code report card: per-node `met` / `partial` / `gap` + the missing piece | advisory |
| `reconcile` | Code → model: extracted signals no model node registered | advisory |
| `coverage` | Model self-coverage: how much of the model is anchored | advisory |
| `backtest` | Commit-side backtest: of the last N `.ts`/`.tsx`-touching commits, how many touched a model-anchored file | advisory |
| `overview` | Interactive system map — panorama, journeys, modeling detail, outstanding ledger | — |
| `graph` | Self-contained, conformance-colored HTML of the whole model | — |
| `topology` | Component/dependency diagram from declared components + extracted facts | — |
| `snapshot` | Nightly full scan + drift report | never a gate |
| `impact <id>` | What a change here would touch | — |
| `mcp` | stdio MCP server, so an agent can query model slices instead of reading the whole spec | — |

`--strict-anchors` promotes exactly the two checks that can be wrong with certainty — a malformed anchor, and an anchored **file** that no longer exists. A file that exists but no longer mentions the symbol stays a warning at any strictness (that check is whole-file text matching, not an AST, and a gate that cries wolf gets muted) — but `conformance` consumes it, so a node whose anchors went stale stops scoring `met`. The gate stays lenient; the report card stays honest.

## How a coding agent drives it

No training needed — `init` puts the manual inside your repo:

- **`.claude/skills/codeontic/SKILL.md`** — Claude Code picks it up as `/codeontic` and routes by intent: discovery (single-agent for small repos; `.codeontic/agent/loop-discovery-parallel.md` partitions large ones), the gate, gaps, maps, model queries. Cursor, Codex, or any agent that can read a file follows the same instructions.
- **`.codeontic/agent/`** — the four-pass discovery method, PR-template setup, CI setup in your repo's own conventions.
- **`codeontic mcp`** — an MCP server agents query for model slices (impact, scenarios, evidence) instead of reading the whole model.

Finding the behavior worth modeling is an LLM's job; keeping the model honest is the engine's. **The gate itself never calls an LLM, touches the network, or runs your code.**

### What it costs

Said up front, because this is a filter, not a sales pitch:

- **Discovery burns tokens.** The modeling is done by a coding agent inside your repo. One subsystem (8–15 nodes) is roughly one agent session; for whole-repo scale, see the numbers above — ~670 files took 5 parallel sessions plus one human merge pass.
- **The model is committed to your repo.** `.codeontic/model/` is file-per-node YAML and an asset — it belongs in git, reviewed like code. `.codeontic/ws/` holds generated reports and is disposable (gitignored).
- **The gate costs zero tokens.** `check` and `conformance` are deterministic and sub-second. The only ongoing cost is keeping the model current: an agent drafts the delta during a PR, a maintainer verifies it.

## Where it fits

**TypeScript / JavaScript repos are the first-class case.** Symbol-level anchor verification reads TS/JS source (`.ts .tsx .mts .cts .js .jsx .mjs .cjs`); the canonical-writer AST invariant scans `.ts`; `backtest` samples commits that touched a `.ts`/`.tsx` file.

**Other languages get the model but not the enforcement.** The model and the structural half of the gate are language-neutral — schema, reference integrity, acyclicity, GWT scenarios, the debt baseline — and so is anchor **file existence**, which is exactly what `--strict-anchors` promotes to an error. What degrades, precisely:

- **Symbol-level checks return "cannot tell"** outside TS/JS — never a false alarm, but never a verification either, so `conformance`'s stale-anchor downgrade never fires. The same holds for `crux` and `verified_by` text anchors.
- **`backtest` reports nothing**: it only counts commits that touched a `.ts`/`.tsx` file.
- **`reconcile` is TS-only today.** The adapter interface is open and your extractor can be anything, but the candidate pre-filter that feeds it is a hardcoded `git grep -- "*.ts"` — so a Python or Go extractor is never handed a file.

**Hard prerequisite: a git checkout.** `facts`, `backtest`, and `snapshot` all shell out to git.

**And some shapes don't need a model at all** — modeling costs real effort, and it does not pay off everywhere. codeontic earns its keep where behavior is hard to see and expensive to get wrong: background machinery, cross-component handoffs, multi-step journeys. It is a poor trade for **pure function libraries** (a date utility, a validator — the code states its own behavior and the tests already pin it), **thin CRUD or glue** with no cross-component handoff and no multi-step progression, and **code you are about to delete or rewrite wholesale**. The honest test: *would a newcomer get this wrong by reading the code?* If no, don't model it.

## Design guarantees

- The gate is **zero-LLM, zero-network, zero-code-execution** — fast, cheap, reproducible, explainable.
- The cache has **zero correctness dependence** (a cold run and a warm run are byte-for-byte identical).
- Snapshot / drift reports are **never** a PR gate.
- Discovery and anti-corrosion stay separated: the LLM only drafts, a maintainer verifies, and nothing lands without passing anchor verification.

## Adapters — open infrastructure

No adapter ships inside the package. Your repo owns a small, synchronous extractor at `.codeontic/adapter/` that reads *your* stack's implementation signals (queue names, timers, pollers). Pass `--strict-adapter` to make a missing adapter a hard CI failure instead of a silent skip, and let `init`'s generated CI pin the codeontic version rather than floating on `@latest` — so a future release can't quietly change gate semantics under a green build.

## Where the project is

**Early.** The engine, the gate and the maps are real and used daily on real repos — the pi map above is generated output, not a mockup — but this is a young project and the surface is still moving.

- **TypeScript / JavaScript is the supported case today**; other languages get the model and the structural gate, with the degradations named above.
- **Try it on a subsystem first**, not the whole repo: one agent session, 8–15 nodes, and you will know within an hour whether the map tells you something you did not already know.
- **Issues and reports are welcome** — especially "the model could not express X" and "the gate flagged something that was fine." Both are the kind of feedback that shapes what ships next.

The end state this is aimed at: **people review the model, agents write the code.**

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) (Chinese) — local gates in CI's order, the
stacked-PR trap (squash-merging a base can send the child PR somewhere that isn't `main`,
with no error anywhere), and the fan-out contract for adding an anchor-bearing schema field.

## License

See [package.json](package.json).
