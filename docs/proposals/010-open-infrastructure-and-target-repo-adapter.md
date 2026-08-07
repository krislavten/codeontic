---
title: "Proposal 010: codeontic 转向开放基础设施——adapter 归目标仓 + `.codeontic/` 统一目录"
date: 2026-07-20
status: PROPOSED — 承接用户 2026-07-20 决策（"做开放基础设施，adapter 应在目标仓而非主仓"）；取代 006-gate1 中的"内置 A系统 adapter"接入路径；待 GATE-1 解冻重审后定稿
related:
  - docs/proposals/001-codeontic-bootstrap.md §2（三分离：模型数据放目标仓；本提案是其延伸——adapter 同属目标仓知识）
  - docs/proposals/006-gate1-目标仓A-integration.md（被本提案取代——adapter 物理位置变更使该决策材料的接入路径失效）
  - docs/proposals/006-full-execution-plan.md E1/E2（E1 已交付的 registry 接口保留；E2 的"n=2 不抽公共核心"立场不受影响——本提案是知识归属归位，不是抽公共核心）
  - docs/proposals/008-phase3-5-exit-report.md §5 决策项 4（GATE-2/GATE-3）
---

# Proposal 010：开放基础设施 + adapter 归目标仓

## 0. 背景：vision shift 与 GATE-1 解冻

006-gate1 决策材料的状态原为 `AWAITING USER DECISION`，基于"codeontic 引擎带内置 A系统 adapter，目标仓A 装 codeontic + 复制 model 种子"的接入路径写定。

用户 2026-07-20 明确两点：
1. **方向**：codeontic 要做开放基础设施，中立是核心约束（不再是"目标仓A-first 工具，通用性是 Phase 5 可选项"）
2. **物理归属**：adapter 代码 + model + config 应在**目标仓**（目标仓A / 目标仓B），不在 codeontic 主仓

这使 006-gate1 的接入路径整体失效——目标仓A 接入不再是"引入 codeontic + 用内置 adapter"，而是"目标仓A 自带 adapter + model + config，引入 codeontic 纯内核"。**GATE-1 状态变更为 `BLOCKED ON VISION CONFIRMATION → MATERIEL REWRITE`**：决策材料需按新路径重写后才能恢复决策流程。本提案即重写后的决策材料，**取代 006-gate1**。

## 1. 新接入路径（取代 006-gate1 决策 1/2/3）

### 1.1 codeontic 主仓形态（纯内核化）

主仓只保留：
- `src/` — engine core（loader / T0 / INV-1 原语 / query / cache / MCP / CLI 命令骨架）
- `src/adapters/types.ts` — `Adapter` interface（engine↔adapter 边界契约）
- `src/adapters/registry.ts` — **空 registry + 外部发现机制**（见 §2）
- 测试 — engine 单元测试 + **高保真合成 fixture**（不依赖真实目标仓模型，见 §4）

主仓移除：
- `src/adapters/A系统/`、`src/adapters/目标仓B/` — 整目录移到目标仓
- `examples/A系统/`、`examples/目标仓B/`（如有）— 种子归目标仓
- `src/cli/run.ts` 默认 `"A系统"`、USAGE 文案中的 default adapter
- `src/cli/commands/import.ts` 的 seed 路径注册（`import` 命令本身去留见 §3）
- `src/validate/unregistered.ts:125-133` 的 `pg_boss_queue` 硬编码 — 泛化为 adapter 声明

### 1.2 目标仓形态（目标仓A 示例）

目标仓A 仓内新增 `.codeontic/` 统一目录（内聚）：

```
目标仓A/.codeontic/
├── model/            # 行为模型（原 codeontic/examples/A系统/model/，GATE-1 决策 3 已规划 目标仓A 成权威）
│   ├── flows/
│   ├── loops/
│   ├── junctions/
│   ├── scenarios/
│   └── baseline/
├── config.json       # 原 codeontic.config.json（INV-1 guarded-table config）
├── adapter/          # 新——目标仓A 专属 adapter 代码
│   ├── index.ts      # 导出符合 Adapter interface 的对象（含 interfaceVersion + candidatePattern + extractFacts）
│   └── extract.ts    # pg-boss queue + setInterval poller 提取（原 src/adapters/A系统/extract.ts）
                        # 仅这两个文件——不含 facts.ts runner（runner 由主仓 src/facts/runner.ts generic 提供）
├── agent/            # init 已有——discovery prompts / PR template / GH Actions setup
│   ├── loop-discovery.md
│   ├── setup-pr-template.md
│   └── setup-github-actions.md
└── ws/               # side-channel 文件（query 命令产物）
```

**关键内聚点**：目标仓A 里所有 codeontic 相关的东西都在 `.codeontic/` 下——模型、配置、adapter、agent kit、side-channel 全在一处。目标仓A 不再需要管"仓根放 model/、仓根放 codeontic.config.json、仓根放 .codeontic/agent/ ..."这种分散布局。

### 1.3 发现机制（目标仓A ↔ codeontic 主仓）

**契约（消除 §1.2 与 §2 §5 项的歧义）**：adapter 仅导出纯函数（`extractFacts(filePath, content)` + `candidatePattern` 字符串 + 可选 `nameMatchableSignalKinds` + 可选 `defaultInv1Config`），不导出 runner；runner 逻辑统一收归主仓 `src/facts/runner.ts`，adapter 不持有 runner 职责（避免循环依赖）。目标仓A `.codeontic/adapter/index.ts` 只导出符合 `Adapter` interface 的对象，不含 `facts.ts`。

MVP 阶段仅支持**同步路径**（与 §5 审计项 2 一致）：

1. `--adapter-path <相对/绝对路径>` 显式传入（最高优先级）
2. `.codeontic/adapter/index.{ts,js}` 文件存在则**同步** import（约定路径，等价于直接 `require`/`import`，无异步发现）
3. 以上都无 → 退化到"无 adapter 模式"（仅 T0 + schema 检查，不跑 facts/reconcile/INV-1）

**Phase 5+ 扩展（不在 MVP）**：`.codeontic/config.json` 的 `adapter` 字段声明的 npm 包名动态加载——异步发现机制，需配套 `unregistered.ts` reconcile 逻辑异步化重构，不属于本提案范围。

**铁律**：发现机制不得让主仓感知目标仓路径结构——主仓只接收"目标仓传来的 adapter 对象"，不反向查询目标仓目录。

## 2. 主仓代码改动清单

| # | 文件 | 改动 |
|---|---|---|
| 1 | `src/adapters/A系统/`、`src/adapters/目标仓B/` | 整目录删除（迁到目标仓 `.codeontic/adapter/`） |
| 2 | `src/adapters/registry.ts` | 清空 ADAPTERS 字面量；改为仅提供 `registerAdapter(adapter)` 动态注册 API（注册时三重校验：(1) `interfaceVersion === ADAPTER_INTERFACE_VERSION`；(2) `extractFacts.constructor.name === 'AsyncFunction'` 拒绝 async function；(3) 执行一次提取校验返回值 `result instanceof Promise` 为 false，封死返回 Promise 但未标 async 的情况。mismatch 抛错）；**registry 本身不含任何目标仓路径发现逻辑**——由 CLI 入口层（`run.ts`）根据 `--adapter-path` 或约定路径解析加载 adapter 对象后显式注入。保留 `getAdapter`/`adapterNames` 查询注册表 |
| 3 | `src/adapters/types.ts` | 加 `nameMatchableSignalKinds?: string[]` 字段（泛化 pg_boss_queue 硬编码） |
| 4 | `src/validate/unregistered.ts:125-133` | 用 adapter 声明的 `nameMatchableSignalKinds` 替代硬编码 `pg_boss_queue` |
| 5a | `src/facts/runner.ts`（新） | 新增——从 `A系统/facts.ts` 抽取 generic runner（git grep 候选 + 纯 AST 提取 + 内容寻址缓存），不依赖任何 A系统 特定约定 |
| 5b | `src/cli/run.ts:1` | `import { runFacts } from "../adapters/A系统/facts.js"` → `import { runFacts } from "../facts/runner.js"` |
| 6 | `src/cli/run.ts:52,122,271` | 去掉 `default "A系统"`；`--adapter-path` flag；USAGE 文案更新 |
| 7 | `src/cli/commands/import.ts` | 移除（种子归目标仓，import 命令失去意义）或改为"从其他仓复制"的通用工具 |
| 8 | `src/cli/commands/init.ts` | 生成 `.codeontic/` 统一目录（model/ + config.json 骨架 + adapter/ 骨架 + agent/） |
| 9 | `src/cli/commands/check.ts:56`、`view.ts:47`、`inspect.ts:42`、`coverage.ts:33`、`run.ts:313`、`side-channel.ts:44` | `join(targetDir, "model")` → `join(targetDir, ".codeontic", "model")` |
| 10 | `src/validate/inv1/config.ts:47,50` | `INV1_CONFIG_FILENAME` 路径从 `codeontic.config.json` → `.codeontic/config.json` |
| 11 | `src/cli/run.ts:384` | snapshot 默认输出路径 `.codeontic/snapshot.json` → 保持（已在 `.codeontic/` 下） |
| 12 | `examples/A系统/` | 删除（种子归 目标仓A `.codeontic/model/`） |
| 13 | `src/cache/content-cache.ts` | **条件项——依赖 §6 审计项 1 的 Phase 0 布尔结论**：若 true（需重构），接口设计已在 Phase 0 完成，本项仅执行已定稿的代码实现，作为 Phase 1 闭环清单第 15 项；若 false，不进清单 |

## 3. `import` 命令：删除（用户决策 2026-07-20）

原 `import` 从 codeontic 仓的 `examples/<adapter>/model/` 复制种子到目标仓 `model/`。开放基础设施下种子归目标仓、主仓 `examples/` 已删，`import` 失去输入源，删除。

删除范围：
- `src/cli/commands/import.ts`
- `src/cli/run.ts` 里 `case "import"` 分支 + USAGE 文案中的 `import` 提示
- `runImport` 的所有调用点（`run.ts`、测试中用 `runImport` 做 E2E fixture setup 的地方）
- 相关测试（`test/queries.test.ts`、`test/mcp.test.ts`、`test/view-cli.test.ts`、`test/coverage.test.ts`、`test/inspect.test.ts` 中用 `runImport(workDir, "A系统")` 的部分）——这些测试本身在 §5.1 已规划移到目标仓，删除 `import` 后其 setup 改为直接 `cp` 合成 fixture

目标仓A 接入用一次性 `rsync codeontic/examples/A系统/model/ 目标仓A/.codeontic/model/`，不需要 CLI 命令长期支持。

## 4. Adapter 接口版本协议（用户决策 2026-07-20）

不采用 peerDependencies 锁版本 + 兼容性矩阵方案。改用**显式版本号协议**：

- 当前 `Adapter` interface 形态命名为 **`v1`**（版本号在 `src/adapters/types.ts` 导出为 `ADAPTER_INTERFACE_VERSION = "v1"`）
- adapter 实现必须声明自己兼容的版本：`Adapter` interface 加 `interfaceVersion: "v1"` 必填字段
- codeontic 主仓改动 interface → bump 版本号（`v1` → `v2`），后续 adapter 升级跟上，不向后兼容旧版本
- 运行时 mismatch（adapter 声明的 `interfaceVersion` ≠ 主仓的 `ADAPTER_INTERFACE_VERSION`）→ **立即报错退出**，不静默降级；错误信息显式提示"adapter 是 v1，codeontic 已升级到 v2，请升级 adapter 或回退 codeontic"

这样：
- 主仓改 interface 是显式 breaking change，版本号可见
- adapter 知道自己兼容哪个版本，主动跟上
- 没有隐式兼容、没有静默降级、没有跨仓 CI 矩阵耦合

`src/adapters/types.ts` 加：
```ts
export const ADAPTER_INTERFACE_VERSION = "v1" as const;

export interface Adapter {
  /** 必须等于 ADAPTER_INTERFACE_VERSION，运行时校验。 */
  interfaceVersion: "v1";
  name: string;
  version: string;
  candidatePattern: string;
  /** 同步函数——返回 ImplementationFact[]，不允许返回 Promise（registry 注册时运行时校验） */
  extractFacts(filePath: string, content: string): ImplementationFact[];
  nameMatchableSignalKinds?: string[];
  defaultInv1Config?: Inv1Config;
}
```

`src/adapters/registry.ts` 注册时双重校验：(1) `interfaceVersion` 匹配 `ADAPTER_INTERFACE_VERSION`；(2) `extractFacts.constructor.name === 'AsyncFunction'` 拒绝 async function，**并执行一次提取校验返回值 `result instanceof Promise` 为 false**（封死返回 Promise 但未标 async 的情况）。不匹配直接抛错。

## 5. 测试归属拆分

### 5.1 移到目标仓的测试（目标仓A 仓 `.codeontic/adapter/` 或 目标仓A 自己的测试体系）

- `test/adapter.test.ts` — A系统 adapter 经接口逐字节回归
- `test/目标仓B-adapter.test.ts` — 目标仓B adapter 单元测试
- `test/unregistered.test.ts` — 用 A系统 model 做的 reconcile E2E（保留 engine 逻辑测试部分，移走用真实 seed 的部分）
- `test/seed.test.ts`、`test/validate-mermaid.test.ts`、`test/snapshot.test.ts`、`test/coverage.test.ts`、`test/view-cli.test.ts`、`test/inspect.test.ts`、`test/mcp.test.ts`、`test/queries.test.ts` — 用 A系统 seed 做 E2E 的部分

### 5.2 留在主仓的测试（改用合成 fixture）

- `test/schema.test.ts`、`test/loader.test.ts`、`test/t0.test.ts`、`test/inv1.test.ts`、`test/diff.test.ts`、`test/content-cache.test.ts`、`test/find-yaml-files.test.ts`、`test/drift.test.ts`、`test/effective-constraints.test.ts`、`test/anchor.test.ts`、`test/staleness.test.ts`、`test/facts.test.ts`
- 新增合成 fixture：`test/fixtures/synthetic-model/`（最小但完整的合成模型，覆盖所有 node kind + 边界情况，不依赖任何真实目标仓知识）

**铁律**（sparring reviewer CONCERNS 1）：
- 主仓 engine 测试基于**自带高保真合成 fixture 独立闭环**
- 目标仓A 仓负责真实模型回归（55 facts 逐字节）
- 两者**物理 + CI 完全解耦**，不得交叉引用
- **静态依赖检查强制执行**：主仓 `test/` 目录禁止 import 任何 `A系统`/`目标仓A`/`目标仓B` 相关路径；在主仓 CI 中强制运行此静态检查（如 grep + 失败即拒），确保解耦不被破坏

## 6. 前置审计项（动代码前必做）

按 sparring reviewer CONCERNS，以下四项在动代码前必须先审计确认，否则可能二次重构：

1. **content-cache 层耦合审计**：`src/cache/content-cache.ts` 是否引用 A系统 特定路径约定或 pg-boss 状态？若有，抽取为可注入接口；若无，直接迁移。
2. **registry 同步/异步契约**：外部发现机制若引入异步加载，`unregistered.ts` 的 reconcile 逻辑必须重构；MVP 阶段**强制同步注册**——`registry.ts` 注册时三重校验：(1) `interfaceVersion` 匹配；(2) `extractFacts.constructor.name === 'AsyncFunction'` 拒绝；(3) 执行一次提取校验返回值非 Promise（`result instanceof Promise === false`），封死返回 Promise 但未标 async 的情况。目标仓 `.codeontic/adapter/index.ts` 必须是同步可加载模块（顶层 `export const`，不允许 dynamic import 异步链）。异步发现属 Phase 5+ 范围，不在本提案。
3. **Adapter interface 版本协议**：见 §4，已完整定义；本项作为前置审计确认 `types.ts` 加 `ADAPTER_INTERFACE_VERSION` + `interfaceVersion` 字段后所有 adapter 实现同步更新。
4. **双仓 tag 对齐 CI 交叉验证**：双仓 tag（`pre-open-infra-A系统-seed` 与 `目标仓A-pre-codeontic-engine-v1`）建立时必须通过 CI 交叉验证——主仓 tag 快照 + 目标仓A tag 快照跑通全链路测试（目标仓A 55 facts 逐字节回归 + T0 全绿），确保回滚时双仓对齐可用，不靠手动约定。**主仓 CI 静态依赖检查作为交叉验证的前置门禁**——若主仓 `test/` 目录存在任何 `A系统`/`目标仓A`/`目标仓B` 相关 import，直接阻断 Phase 2 的双仓 tag 打包与交叉验证流程。

## 7. GATE-1 新决策项（取代 006-gate1 决策 1/2/3）

### 决策 1：分发方式（不变，仍三选一）

| 方案 | 优点 | 代价 |
|---|---|---|
| A. git dependency（推荐 MVP） | 无需 registry；pin commit | codeontic 需 `prepare` 构建脚本或提交 dist/；目标仓A CI 需能拉私有 repo |
| B. npm 私有发布 | 干净语义化版本 | 需私有 registry + 发布流程 |
| C. vendored 产物 | 零依赖解析 | 手动同步、易漂移 |

### 决策 2：目标仓A PR 的内容与时机

新接入路径下的 PR 内容：
1. `目标仓A/.codeontic/model/` — 从 `codeontic/examples/A系统/model/` 一次性 rsync 进 目标仓A（66 loop / 9 flow / 5 junction / 44 GWT / 1 INV 场景 / 8 debt）
2. `目标仓A/.codeontic/config.json` — 从 `codeontic/examples/A系统/codeontic.config.json` 改名 + 内容迁移
3. `目标仓A/.codeontic/adapter/` — 从 `codeontic/src/adapters/A系统/` 迁移（extract.ts / index.ts，facts.ts runner 部分回归主仓 `src/facts/runner.ts`）
4. `目标仓A/.codeontic/agent/` — `codeontic init` 生成（或直接复制 agent kit）
5. `目标仓A` devDependency on codeontic（纯 engine 包，形式取决于决策 1）
6. `目标仓A` CI job：`codeontic check --repo-root . .codeontic`（T0 + 锚点 + INV-1，advisory 起步）

### 决策 3：事实源切换（已简化）

原 006-gate1 的"事实源切换 + 量化回滚预案"在 010 下不适用：本提案是**纯目录迁移**，engine 逻辑不变、事实源仍是同一套（只是物理位置从主仓迁到目标仓），不存在"效果不好要回滚"的语义。

合并后 目标仓A `.codeontic/model/` 成权威；codeontic 主仓 `examples/A系统/` 已删除（本提案 §1.1）。如需恢复主仓种子，从 git 历史即可——**回滚冷备兼容性**：在 Phase 1 删除 `examples/A系统/` 前打 git tag `pre-open-infra-A系统-seed`，该 tag 必须指向**删除 examples/ 前的最后一个绝对 green commit**（含当时的 engine + model + adapter 全部兼容状态 + 全测试通过）。回滚时**连同主仓代码一并 `git checkout` 到该 tag**，不只是恢复 model——否则用 0.4.0 缺陷版 engine + tag 时代的 model 无法跑通当时门禁。

**双仓回滚快照对齐**：开放基础设施下 adapter 物理位置已迁至 目标仓A 仓，仅 checkout 主仓 tag 无法恢复 目标仓A 仓中对应的 adapter 代码。目标仓A 仓首次迁移 adapter 时需打对应 git tag `目标仓A-pre-codeontic-engine-v1`，确保双仓回滚快照对齐——主仓回滚 engine + model，目标仓A 回滚 adapter，两者版本对齐才能跑通。

**npm 依赖回滚补充**：目标仓A 通过 `npm install` 引入 codeontic，主仓 git tag 回滚不影响 目标仓A `node_modules` 中的 0.4.0 产物。回滚时 目标仓A 仓需同步将 `package.json` 中 codeontic 依赖版本锁定为确切 `0.3.0`（不用 `^`，避免自动拉取更高版本）。**禁止将旧代码基线发布为更高版本号**——若主仓回退到 0.3.0 代码基线却发布为 0.4.1，会破坏语义化版本契约（目标仓A `^0.4.0` 自动拉 0.4.1 但实际能力是 0.3.0）。回滚修复版必须基于回滚目标基线的 patch 号（如 `0.3.1`），或直接由 目标仓A 仓锁定 `0.3.0`。

```
# 主仓回滚（连同 engine 一起 checkout 到 tag 时代，不只是 model）
cd codeontic
git checkout pre-open-infra-A系统-seed   # 整仓回到 tag 时代，engine + model + adapter 全部兼容

# 目标仓A 仓回滚
cd 目标仓A
git checkout 目标仓A-pre-codeontic-engine-v1   # 整仓回到 tag 时代，adapter 与主仓 tag 对齐
# package.json 中 codeontic 依赖锁定为确切 "0.3.0"（不用 ^），npm install 拉取回滚前版本
```

不需要量化回滚阈值、不需要 nightly 监控触发。

## 8. 回归红线（口径锁定）

按 sparring reviewer CONCERNS 5，两条分开度量：

1. **主仓 CI T0 <5s** — PR 门禁路径，必须保持；engine 测试基于合成 fixture，不依赖目标仓
2. **目标仓A 仓 adapter 全链路 目标仓A 55 facts 逐字节回归** — 回归责任在 目标仓A 仓，不在 codeontic 主仓；adapter 包 CI 跑这项

缓存层接口化后的单次 facts 读写延迟偏差需 <5%，纳入 目标仓A 全链路度量。

## 9. 执行顺序（草案，待 GATE-1 决策后实例化）

```
Phase 0  前置审计（§6 四项）→ **必须输出布尔结论**：(a) content-cache 审计项 1 输出"需重构 true/false"——若 true，接口设计必须在 Phase 0 完成，Phase 1 仅执行已定稿的代码实现；(b) 其他三项同样得出明确通过/不通过结论。Phase 0 出口确定 Phase 1 清单项数（14 或 15），消除模糊中间态。
Phase 1  主仓代码改动（§2 清单——项数 Phase 0 已锁定）→ typecheck/lint/build 全绿 → engine 测试用合成 fixture 全绿 → 构建产物 `dist/` 生成 → **打 `pre-open-infra-A系统-seed` git tag（指向删除 examples/A系统/ 前的最后一个绝对 green commit）** → **npm 发版 0.4.0**
Phase 2  目标仓A 侧一次性迁移（决策 2 的 6 项）→ **立即打 `目标仓A-pre-codeontic-engine-v1` tag（与主仓 tag 严格对齐）** → **主仓 CI 静态依赖检查作为前置门禁（若主仓 `test/` 存在 A系统/目标仓A import 直接阻断交叉验证）** → **双仓 CI 交叉验证（55 facts 逐字节回归 + T0 全绿）** → 若交叉验证失败，立即发 0.4.1 修复版（基于 0.4.0 基线，不允许把旧基线发为更高版本号）→ 目标仓A 仓 adapter 测试全绿
Phase 3  GATE-1 决策完成 → 目标仓A PR 准备好 → 等 merge
Phase 4  事实源切换 + 目标仓A CI advisory 档挂上
```

## 10. 需要用户/团队决定的（GATE 出口）

1. **分发方式** —— ✅ B（npm 发布；codeontic 已发到 npm，0.3.0 为最新；下一发版号 **0.4.0**——开放基础设施转向是 minor bump，未到 1.0）
2. **目标仓A PR 时机与范围** —— ✅ 发到 main；21 个 PR 节奏（按 目标仓A 既定 PR 流程拆分，不一次性合并）
3. **回滚阈值** —— ✅ 删除该决策项（纯目录迁移无事实源切换，不适用 006-gate1 的回滚预案）
4. **`import` 命令去留** —— ✅ A（删除，见 §3）
5. **Adapter interface 版本协议** —— ✅ 显式版本号协议（见 §4），不用 peerDependencies 锁

决定后执行方据此实例化 目标仓A PR（仍不自行 merge），并继续 006 A9 + Milestone B。