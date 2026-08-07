# Proposal 009 — LLM 发现层 + PR 期同步(设计)

状态:设计定稿,待实施。承接 Report 008 之后与用户的方向讨论。

## 0. 分工架构(总纲)

```
发现/建图  = LLM        ← 离线低频;读代码 + trace;四遍扫描法(docs/prompts/loop-discovery.md)
校验/防腐  = 确定性引擎  ← 每个 PR;零 LLM;锚点核实 + 对账 + INV-1
```

两层各守各的红线:**发现力全靠 LLM**(状态机/链路/风险点是语义判断,确定性提取只能扒队列/定时器这类机械信号,实测 clean-room 只能摸到 内部PR 的 ~41% 且是扁平无语义的);**门禁永不调 LLM**(001 §6,快/稳/可复现)。

方法论依据:内部PR 的 66 loop + 8 debt 就是"假设都是 loop → 证伪"的产物——debt.yaml 全部 6 条死状态机是被证伪杀掉的候选残渣;本 session 两次误判(services.ts 差点建 loop、orchestration 定时器差点建 loop)也均被证伪测试救回。四遍扫描法是把这套隐式实践显式化。

## 1. 左侧:LLM 发现层

提示词套件见 `docs/prompts/loop-discovery.md`:

1. **Pass 1 穷举**:按 8 族信号地毯扫,假设都是 loop,宁滥勿缺(召回优先)。
2. **Pass 2 证伪**:三判据(状态载体/独立推进/恢复路径),杀掉的按 6 种形态分流(debt / 归父 loop / consumes_queues / 不建模)。
3. **Pass 3 组合**:loop 之上的 loop——生产消费边、共享载体(junction)、看护边(guarded_by)、内嵌、端到端 flow。
4. **Pass 4 trace 升维**:octo/conso 拉拓扑与 span 链,发现静态串不出的链路与运行时才出现的 loop;双向对账(trace 活跃但模型无 → 新候选;模型有但 trace 无 → dormant 候选)。

每遍产出 YAML 草案后过引擎:`check --strict-anchors`(锚点真实性)+ `reconcile`(机械信号反向对账,LLM 漏队列/定时器会被机器抓)。**LLM 发现、机器核对**,互为纠错。

## 2. 右侧:PR 期同步(防腐,四条通道)

问题:一个重 PR 本身可能引入新 loop。确定性 reconcile 只能抓机械信号(新队列/定时器),**纯语义新 loop(如新状态机)对引擎不可见**。四条通道按确定性递减:

| 通道 | 性质 | 覆盖 | 状态 |
|---|---|---|---|
| ① reconcile 门禁 backstop | 确定性,PR 内 | 新队列/定时器无模型登记 → 警告(C3 数据攒够后可升 block) | **已实现** |
| ② PR template 声明 | 社会规范 | 模板加一栏:"本 PR 引入/修改 loop?**none / [ids] / uncertain**";与 ① 互证——引擎抓到新信号但模板写 none → 矛盾即拦、要求改声明 | 待 目标仓A 侧落地(GATE) |
| ③ LLM advisory lane | LLM,**永不进门禁** | 触发条件(默认值,目标仓A 侧可配):模板声明 yes/**uncertain 强制触发**,或 diff > 500 行,或命中默认基线——glob:`packages/db/src/schema/**`、`apps/control-worker/**`、`packages/control-plane/**`;diff 内容正则:`VALID_[A-Z_]*_TRANSITIONS|pgEnum\(|_QUEUE(_BASE)?\s*=|setInterval\(|\.work\(`。触发后 agent 对 diff 跑 Pass 1–3 → 生成 loop YAML 草案 → 作者随 PR 落地;形态为 comment bot / 非阻塞 check | 待实施 |
| ④ T2 nightly re-discovery | LLM,夜间 | 对当日变更文件重跑发现,diff 模型出"疑似新 loop"报告;走 D2 快照同通道,T2 永不门禁 | 待实施 |

设计要点:
- **③④ 的 LLM 产出永远是"草案+人审",不自动落库**——发现层的误判由证伪测试+人审兜住,不污染模型。
- ① 是唯一的强制层,且只强制它能确定性判断的子集——诚实分层:机器管得住的机器管,管不住的靠规范(②)+建议(③④)。
- **承认的残余逃逸**:开发者认知盲区(自己不知道写了个 loop、声明 none)且 diff 未触发 ③ 的纯语义新 loop,PR 期抓不到——这正是 ④ nightly re-discovery 存在的理由(最迟第二天浮出),不假装 PR 期全覆盖。
- ②③ 涉及 目标仓A 仓库(PR template、CI 配置),属 GATE 范畴,需用户在 目标仓A 侧落地。

## 3. 实施顺序建议

1. 提示词套件(已随本提案交付)——GATE-2 前即可用于模型维护与第二仓库评估。
2. ④ nightly re-discovery:纯 codeontic 侧可做(脚本调用 agent + 现有 snapshot 通道),无需动 目标仓A。
3. ②③:随 GATE-2 一起与用户在 目标仓A 侧落地(PR template 一行 + 一个非阻塞 CI job)。
