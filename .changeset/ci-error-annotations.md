---
"codeontic": minor
---

`report` / `drift-report`: `--format github` 现在会在**读数没跑成**时往 stdout 打一条 `::error` 注解。

这两条命令按设计永远 exit 0（会阻断的报告没人再看），代价是「管线坏了」在 PR 上看起来和「没查出问题」一模一样：步骤是绿的，唯一的痕迹是一段没人点开的 summary。注解是唯一能在不判红的前提下把它标出来的通道。

触发条件由引擎判定，不由调用方猜：`report` 是有小节没产出完整读数（`degraded`），`drift-report` 是比较没跑起来、或某一侧的边集合不可用（**不含**"边集合为空"——那是扫描跑了且合法地一条没找到，标红它等于让正常情况天天报警）。

在此之前接入方只能自己拼这条注解，而且拼不干净：引擎的 stdout 同时是给人读的正文，于是 workflow 把注解写进同一条流、再用一对 grep（`grep '^::error'` 进真 stdout、`grep -v '^::error'` 进 summary）拆回来。现在注解由引擎直接打在真 stdout 上、不进 summary 正文，那对 grep 和它两个方向的漏法一起消失。
