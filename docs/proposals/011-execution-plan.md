---
title: "Proposal 011: Proposal 010 执行计划——任务分解 + 验证门禁"
date: 2026-07-20
status: EXECUTING
related:
  - docs/proposals/010-open-infrastructure-and-target-repo-adapter.md（本计划的执行对象）
---

# Proposal 011：010 执行计划

## 0. Phase 0 审计结果（已完成）

| 审计项 | 结论 | 依据 |
|---|---|---|
| 1. content-cache 层耦合 | **false（不需要重构）** | `src/cache/content-cache.ts` 全文读完：`cacheKey(parts: string[])` 由调用方传入 key 组成部分，`withCache`/`pruneCache` 是纯通用原语，无任何 A系统/pg-boss 特定路径或状态引用 |
| 2. registry 同步契约 | **设计已锁定**（010 §6 项 2） | 三重校验：`interfaceVersion` 匹配 + `AsyncFunction` 拒绝 + 返回值非 Promise 断言 |
| 3. Adapter interface 版本协议 | **设计已锁定**（010 §4） | `ADAPTER_INTERFACE_VERSION = "v1"` + `interfaceVersion` 必填字段 |
| 4. 双仓 tag CI 交叉验证机制 | **本计划 §3 设计** | 见下 |

**Phase 1 清单项数确定：14 项**（content-cache 不进清单）。

## 1. Phase 1 任务清单（主仓代码改动，可立即执行）

按文件域拆分，标注依赖顺序（无依赖的可并行）：

### 1.1 独立任务（无依赖，可并行）

| 任务 ID | 内容 | 文件 | 验证 |
|---|---|---|---|
| T1 | `Adapter` interface 加版本字段 | `src/adapters/types.ts`（加 `ADAPTER_INTERFACE_VERSION`、`interfaceVersion: "v1"`、`nameMatchableSignalKinds?: string[]`） | `tsc --noEmit` 通过；新增单测断言导出值 |
| T2 | 新建 generic facts runner | `src/facts/runner.ts`（新，从 `adapters/A系统/facts.ts` 抽取，去掉 A系统 特定注释/默认值） | `test/facts.test.ts` 改为测这个新路径，逻辑不变（先跑通旧测试确认行为等价） |
| T3 | 新建合成 fixture | `test/fixtures/synthetic-model/`（新，最小但完整：≥1 flow/loop/junction/scenario/debt，覆盖 schema 全部必填字段 + 1 个边界用例如 dormant loop） | `loadModel()` 跑通，`runT0()` 全绿 |

### 1.1b 依赖 T3 的任务

| 任务 ID | 内容 | 文件 | 依赖 | 验证 |
|---|---|---|---|---|
| T4 | 静态依赖检查脚本 | `scripts/check-no-target-repo-refs.sh`（新，grep `test/` 目录禁止出现 `A系统`/`目标仓A`/`目标仓B` import） | T3（需要合成 fixture 才能建立有意义的违规基线——脚本首次运行时 `test/` 仍有大量 A系统 引用，此时先记录基线，T13 清理后归零） | 脚本对当前 `test/` 跑一次，记录当前违规数（预期非零，等 T13 清理后归零） |

### 1.2 依赖 T1 的任务

| 任务 ID | 内容 | 文件 | 依赖 | 验证 |
|---|---|---|---|---|
| T5 | registry 改为纯注册 API | `src/adapters/registry.ts`（清空 `ADAPTERS`；加 `registerAdapter(adapter)`；三重校验：interfaceVersion 匹配 + AsyncFunction 拒绝 + 返回值非 Promise 断言；`getAdapter`/`adapterNames` 改查动态注册表） | T1 | `test/adapter.test.ts` 中的 registry 单测部分改为测 `registerAdapter` 的校验逻辑（正常注册 / interfaceVersion mismatch 拒绝 / async 拒绝 / Promise 返回值拒绝，4 个用例） |
| T6 | unregistered.ts 泛化 | `src/validate/unregistered.ts:125-133`（`pg_boss_queue` 硬编码 → 读 adapter 声明的 `nameMatchableSignalKinds`） | T1 | `test/unregistered.test.ts` 改用合成 fixture + mock adapter 声明 `nameMatchableSignalKinds`，断言 name-match 逻辑不再硬编码信号种类 |

### 1.3 依赖 T2/T5 的任务（CLI 层）

| 任务 ID | 内容 | 文件 | 依赖 | 验证 |
|---|---|---|---|---|
| T7 | CLI 去默认化 + adapter-path flag | `src/cli/run.ts`（去 `"A系统"` 默认；`import { runFacts } from "../facts/runner.js"`；加 `--adapter-path` 解析：同步 `import()` 目标路径，注入 `registerAdapter`；USAGE 文案更新） | T2, T5 | `test/cli.test.ts` 加用例：无 `--adapter-path` 时退化为"无 adapter 模式"（仅 T0）；给合成 fixture adapter 路径时 facts/reconcile/inv1 正常跑通 |
| T8 | 删除 import 命令 | `src/cli/commands/import.ts`（删）、`run.ts` 里 `case "import"`（删）、USAGE 里 import 提示（删） | T7 | `test/cli.test.ts` 移除 import 相关用例；grep 确认 `runImport` 无残留引用 |
| T9 | init 生成 `.codeontic/` 统一目录 | `src/cli/commands/init.ts`（`model/` → `.codeontic/model/`；同目录下生成 `config.json` 骨架 + `adapter/` 骨架 README + 保留 `.codeontic/agent/`） | 无（T3 的 fixture 是模型内容本身，与挂载路径无关，测试 setup 代码调用 `loadModel(path)` 时才决定路径，T9/T3 互不阻塞） | `test/*.test.ts` 里用 `runInit` 的部分（若有）断言新路径 |
| T10 | 路径改写：`model` → `.codeontic/model` | `src/cli/commands/check.ts:56`、`view.ts:47`、`inspect.ts:42`、`coverage.ts:33`、`run.ts:313`、`query/side-channel.ts:44`。**不涉及 config 加载路径**——`check.ts:93` 调 `loadInv1Config(targetDir)`，内部用 T11 改的 `INV1_CONFIG_FILENAME` 常量拼路径，T10 只改 `model` 相关的显式 `join(targetDir, "model")` 调用点，两者独立不冲突 | T9 | 全部用 T3 合成 fixture 跑一遍 CLI 命令，确认路径解析正确 |
| T11 | INV-1 config 路径改写 | `src/validate/inv1/config.ts:47`（`INV1_CONFIG_FILENAME` = `codeontic.config.json` → `.codeontic/config.json`） | T9 | `test/inv1.test.ts` 断言新路径下 config 加载；额外跑一次 `check.ts` 的 E2E 确认 `loadInv1Config` 自动拿到新路径（无需改 `check.ts` 代码） |

### 1.4 迁移材料导出（清理前必做——一旦 T12/T14b 删除，源文件不可从 tag 事后打捞给 目标仓A）

| 任务 ID | 内容 | 文件 | 依赖 | 验证 |
|---|---|---|---|---|
| T11.5 | 导出 目标仓A 迁移材料到独立位置 | 导出到**仓外绝对路径**（固定为 `~/codeontic-目标仓A-migration/`，不在 codeontic 仓内、不受 npm `files` 字段影响、不受 `.gitignore` 影响）：把 `src/adapters/A系统/extract.ts`、`src/adapters/A系统/index.ts`（**逐文件复制，不整目录复制**——源目录还有 `facts.ts` 不应导出）、`examples/A系统/model/`、`examples/A系统/codeontic.config.json` 复制进去，附一份 `MIGRATION-README.md` 说明目标路径映射（→ `目标仓A/.codeontic/adapter/`、`目标仓A/.codeontic/model/`、`目标仓A/.codeontic/config.json`） | 无（可在 T1-T11 任意时刻做，只要在 T12/T14b 之前） | (1) `[ -d ~/codeontic-目标仓A-migration ]` 显式存在性断言 + README 完整；(2) 逐文件 diff（不是整目录 diff，避免 `facts.ts` 造成假失败）：`diff src/adapters/A系统/extract.ts ~/codeontic-目标仓A-migration/adapter/extract.ts`、`diff src/adapters/A系统/index.ts ~/codeontic-目标仓A-migration/adapter/index.ts`、`diff -r examples/A系统/model/ ~/codeontic-目标仓A-migration/model/`、`diff examples/A系统/codeontic.config.json ~/codeontic-目标仓A-migration/config.json`，全部零差异；(3) **T12 执行删除前必须重新跑一遍上述 diff 校验**（硬性前置检查，不能只在 T11.5 当时跑一次就假设永远有效——防止 T11.5 之后有人手动改动了导出目录或源文件） |

### 1.5 清理任务（最后执行，依赖上面全部完成，且 T11.5 必须先完成）

| 任务 ID | 内容 | 文件 | 依赖 | 验证 |
|---|---|---|---|---|
| T12 | 删除 A系统/目标仓B adapter 目录 | `src/adapters/A系统/`、`src/adapters/目标仓B/`（整删） | T5, T6, T7 全绿 + **T11.5 的 diff 校验通过**（迁移材料已导出且逐字节确认无遗漏，不是仅"目录存在"） | `tsc --noEmit` 全绿（确认无残留 import） |
| T13 | 测试归属迁移 | 按 010 §5.1/§5.2：把 A系统-seed 依赖的测试内容抽出（供 目标仓A 仓后续用，同样在 T11.5 已保证材料不丢的前提下），主仓测试改用 T3 合成 fixture | T12 | `pnpm test` 全绿，`scripts/check-no-target-repo-refs.sh` 归零违规 |
| T14a | 打回滚 tag + 触发 CI 验证 | `git tag pre-open-infra-A系统-seed`（打在 **T12/T13 完成之后、examples/A系统/ 仍未删除**的 green commit——这个 tag 的用途是"回滚锚点"，必须指向删除前的完整状态才能恢复；目标仓A 迁移材料已在 T11.5 独立导出，不依赖这个 tag） | T13 | CI 在该 tag 上全绿；结果写入 `docs/proposals/tag-verification/pre-open-infra-A系统-seed.md` |
| T14b | 删除 examples + commit（不立即发版） | 删除 `examples/A系统/`（此时 T11.5 已导出过种子并二次校验，删除安全）；commit | T14a CI 验证通过 | `git log` 确认该 commit 在 tag 之后 |
| T14c | 在删除后的 commit 上跑一次完整 CI + npm 发版 0.4.0 | CI 跑 `pnpm typecheck && pnpm lint && pnpm test && pnpm build`（对 T14b 的 commit，不是 tag 的 commit）；全绿后 `npm publish` | T14b CI 全绿 | `npm view codeontic versions` 含 0.4.0；确认 0.4.0 对应的 commit = T14b 的 commit（不是 T14a 的 tag commit——两者内容不同，tag 保留 examples 用于回滚，发版的代码已删除 examples） |

**Phase 1 出口门禁**：T1-T14c 全部完成，`pnpm typecheck && pnpm lint && pnpm test && pnpm build` 全绿，`scripts/check-no-target-repo-refs.sh` 零违规。

## 2. Phase 0 补充事项（sparring 残余 CONCERNS 1 的处理）

**接口设计 review 流程**：因 Phase 0 审计项 1 结论为 false（content-cache 不需重构），本项**不适用**——没有需要冻结 review 的接口设计。若未来审计结论翻转（不太可能，除非 content-cache 逻辑本身改变），届时补走"接口设计文档独立 review 并冻结"流程。

## 3. 双仓 tag CI 交叉验证机制设计（审计项 4 的具体落地）

因主仓 CI 和 目标仓A 仓 CI 是两个独立系统，"交叉验证"不能是单一 CI job，设计为**两步协议**：

1. **主仓侧**（Phase 1 T14 之后）：打 `pre-open-infra-A系统-seed` tag，CI 在打 tag 的 commit 上跑一次完整测试并把结果（pass/fail + 摘要）写入 tag 的 annotation 或一个 `docs/proposals/tag-verification/pre-open-infra-A系统-seed.md` 记录文件。
2. **目标仓A 侧**（Phase 2，需在 目标仓A 仓执行，本计划只能规划接口）：目标仓A 打 `目标仓A-pre-codeontic-engine-v1` tag 后，目标仓A CI 跑 `codeontic check --repo-root . .codeontic`（用主仓 tag 版本的 codeontic）+ adapter 测试（55 facts 逐字节回归），结果同样记录到 目标仓A 仓的等价文件。
3. **交叉验证判定**：两份记录都存在且都是 pass，视为双仓 tag 对齐验证通过；人工核对两份记录的 codeontic 版本号一致（主仓 tag 对应的 npm 版本 = 目标仓A `package.json` 锁定的版本）。

**失败时的 tag 处置协议**（sparring 残余 CONCERNS 2）：验证失败时，**原 tag 保留不删**（作为失败快照的溯源记录），在原 tag 名后追加 `-invalid-YYYYMMDD` 后缀重命名（`git tag pre-open-infra-A系统-seed-invalid-20260721 pre-open-infra-A系统-seed && git tag -d pre-open-infra-A系统-seed`），修复后基于新 commit 重打**同名**原 tag（`pre-open-infra-A系统-seed`）。目标仓A 侧同理。这样任何时刻至多一个"当前有效"同名 tag，历史失败快照可溯源但不占用有效 tag 名。

## 4. Phase 2+（目标仓A 仓执行，本计划仅列交付物，不在本仓执行）

Phase 2（目标仓A 迁移）、Phase 3（GATE-1 决策 + PR）、Phase 4（事实源切换）需要 目标仓A 仓访问权限和用户对 PR 时机的确认，不在本次执行范围。Phase 1 完成、npm 0.4.0 发布后，下一步动作是：

1. 向用户确认"现在开始 目标仓A 侧迁移"的时机（010 §7 决策 2 已定：发到 main，21 个 PR 节奏，但具体哪个 PR 先动需要用户在 目标仓A 侧协调）
2. 我这边准备好 目标仓A 迁移用的具体文件清单（从 `codeontic/examples/A系统/` 迁移到 `目标仓A/.codeontic/` 的映射表），供 目标仓A 侧 PR 使用

## 5. 立即可执行的下一步

T1-T4（独立任务，无依赖）可以立即开始。建议顺序：T1 → T2 → T3 → T4（T4 依赖 T3 提供的合成 fixture 才能有意义地跑一次基线检查）。

是否现在开始执行 T1？