# 内部状态与文档索引(不随 npm 包发布)

> 本文件承接原 README 中的内部上下文;README 已改为公开安全的通用版(npm 强制打包 README)。

早期在两个内部仓库上落地验证(文中称目标仓 A / 目标仓 B);通用化经 E1 adapter 接口落地。

## 文档

- [Proposal 001: 启动方案](proposals/001-codeontic-bootstrap.md) — 问题归因、形态、架构、数据模型、缓存设计、CI 分层、工作流、落地路线。
- [Decision record: 外部调研决策](proposals/004-external-survey-decisions.md)
- [Proposal 009: LLM 发现层 + PR 期同步](proposals/009-llm-discovery-and-pr-sync.md)
- [Proposal 010: 开放基础设施](proposals/010-open-infrastructure-and-target-repo-adapter.md) / [011: 执行计划](proposals/011-execution-plan.md) / [012: Flow 一等公民](proposals/012-flow-first-class-alignment.md) / [013: Graft 调研采纳](proposals/013-graft-survey-adoption-plan.md) / [014: 跨服务开关对齐](proposals/014-cross-service-switch-parity.md)
- [Proposal 016: 三层打动路径](proposals/016-three-layer-adoption-plan.md) — 定性(规范性本体/判断力)+ 首跑完整建模 + 可信门禁施工计划
- [发现提示词](prompts/loop-discovery.md)(经真实仓库校准)
- 接入验证与校准报告(003/005/006/007/008/013-验收/015、calibration-001~003、research/)通篇为内部仓库的架构证据,公开版面已撤下,git 历史保留。校准核心读数:Sonnet clean-room 全仓召回 68%(可达范围)/盲漏 13%/零幻觉。

## 状态(2026-08-07)

- 0.1.0–0.9.0 已发布 npm(2026-07-19 首发);CI/自动发版(changesets + Trusted Publishing)已接通。
- 外部真实仓实测完成:pi / open-design / novu 三仓 + pi 全仓 60 节点建模(30 loop/19 flow/7 junction/4 debt/51 scenario,191 锚点逐条核实),暴露 11 条缺陷(D1-D11,含 P0 假 met),清单见 Proposal 016。
- 0.9.0 已发布:Proposal 016 三层落地——conformance 可信度、check 跨节点一致性、并行建模 agent kit、overview 判断界面与 flow 抽屉、双语 README 与 showcase。
