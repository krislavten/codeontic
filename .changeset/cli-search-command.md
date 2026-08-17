---
"codeontic": minor
---

新增 CLI `search` 命令：`codeontic search "<query>" [dir]`，模型自由文本 IDF 检索，`model_search` MCP 工具的 CLI 孪生。此前入口检索只存在于 MCP——经 shell/AGENTS.md 通用面接入的 agent 有全部查询命令、唯独没有找入口的那条，只能手工 grep 节点标题。行为与 MCP 完全一致（同一 `runSearchCommand`）：计分命中 + 1-hop 关联、side-channel 落盘带 staleness 戳、模型有 parse error 时拒绝检索而非静默搜残图。多词查询需引号，未加引号时报可复制粘贴的纠正示例。
