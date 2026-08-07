# Loop Discovery 提示词套件(LLM 发现层)

给 agent 用的四遍扫描法:**假设都是 loop → 证伪 → 组合 → trace 升维**。
方法论提炼自 目标仓A 一个内部 PR 的实际分析过程 + codeontic C1 grounding 实践(两次真实误判被证伪救回:services.ts、orchestration 定时器)。

## 前置铁律(每一遍都适用)

1. **每条断言必须带 `文件路径#符号` 锚点,且 grep 对目标仓 HEAD 核实**。核实不到就不写——宁可标 unverified,不编造。
2. 产出直接写成 codeontic model YAML 草案(loop / junction / flow / debt),交 `codeontic check --strict-anchors` 机器核锚点、`codeontic reconcile` 反向对账机械信号——**LLM 负责发现,引擎负责核对**。
3. 运行数据只作实现状态证据,不反向改模型语义(001 §7)。

---

## Pass 1 — 穷举候选(假设都是 loop)

**心法:宁滥勿缺。举证责任在证伪端(Pass 2),这一遍只管召回。**

对目标仓库地毯式扫以下信号,**每个命中都先假设是一个 loop**:

| 信号族 | 例 |
|---|---|
| 状态列/枚举 | `status` / `state` / `phase` 列,`VALID_*_TRANSITIONS` 转移表 |
| 队列 | `*_QUEUE` const、`boss.work(` / `.send(` / `.schedule(` |
| 定时 | `setInterval` / **递归 `setTimeout` 自我重排**(leader 续租、退避重试常用此形态,只 grep setInterval 会漏——校准 001 实证) / cron 表达式 / `*_tick` / `*_sweep` |
| 主动循环 | `while (true)` / poll / watch / long-poll |
| 重试恢复 | retry / backoff / `:recover` 队列 / reconcile / cleanup |
| 协调原语 | lease / lock / fencing / singleton key |
| 保活 | heartbeat / keepalive / TTL renewal |
| 事务模式 | saga / outbox / 事件订阅带状态推进 |

每个候选记录:`草名 | 命中信号 | 锚点 | 疑似状态载体 | 疑似推进机制`。

**扫描完整性(v4)**:按子目录地毯扫完后,**必须单独扫所有未被子目录包含的顶层 .ts 文件**(`src/*.ts`、包根 `index.ts`、非 src 入口等——校准 003 中 49K 行包的旗舰状态机就因在根层被整体漏掉);输出 NOTES 必须**宣告未覆盖边界**(浏览器端代码、vendored 依赖、越界包),防"没报=没有"误读。

## Pass 2 — 证伪(杀死伪 loop)

对每个候选跑三判据,**任何一条找不到就不是独立 loop**:

1. **状态载体**:进度存在哪?(DB 列 / 队列位置 / 内存+lease)——找不到 → 无状态工具函数,杀。
2. **独立推进机制**:没有调用者时谁在推进它?(worker / poller / cron / 订阅)——只被动等调用 → 杀。
3. **恢复路径**:崩溃/错过之后谁接着推?(重试队列 / sweep / reconciler / **明确没有也行,但必须记录**)。

**杀前必答三问(v4:例外规则内联化——校准 003 实证"例外说明"会被长任务遗忘,故升格为每条 KILLED 记录的必填字段)**:
每杀一个候选,KILLED 记录必须显式回答:
- **Q1 推进器是否可能在范围外?**(被 dispatch/其他包的 worker/客户端驱动)是 → **stub 保留**,不杀(执行平面 loop 天然"推进器在别处",aw 场系统性过杀教训)。
- **Q2 是否跨组件闭环的接收端?**(回调/invalidate/webhook 收端)是 → 记 Pass 3 闭环候选,不杀。
- **Q3 归父时是否有独立状态子集与阶段边界?** 是 → 标 embedded 子机候选(`parent`+`embedded: true`),不无痕折叠。

**分歧类标注(v4)**:证伪杀掉以下四类时必须标 `divergence-class`,交模型维护者终审(既有分类学可能与三判据分歧,不算 agent 定论):单趟管线 / 有界重试链 / vendor 包裹机制 / 无推进 resolver。

**KILLED 记录的固定字段(v4,结构化防遗漏——自由文本里标签极易被长任务丢掉)**:
```
- name: <草名>
  anchor: <file#symbol>
  killed_by: <三判据哪条>
  q1_advance_out_of_scope: <no | yes→改 stub 保留>
  q2_closed_loop_receiver: <no | yes→改 Pass3 候选>
  q3_embedded_state_subset: <no | yes→标 embedded 候选>
  divergence_class: <none | 单趟管线 | 有界重试链 | vendor包裹 | 无推进resolver>
  disposition: <debt死状态机|debt静态标志|审计账|归属父loop X|注册表|无状态工具|bootstrap>
```
(三问是**防过杀**闸门,只挂在 KILLED 上;幸存者无需过——校准 001–003 全 5 场中,维护者对每个幸存者逐一对照代码/ground truth 复核(逐幸存者证据见 calibration-001/002/003 文档的评分表,每条含 ground-truth 映射或代码锚点),**未发现一例应杀未杀**;观测到的失败模式全部在过杀侧。假幸存定义=幸存者经维护者对代码复核判定不满足三判据;一旦出现实例,该幸存者转 KILLED 重分流,并评估将三问扩展到幸存侧。)

**被杀候选不是丢弃,按归宿分流**(这一步产出 debt 和归属,和 loop 一样值钱):

| 证伪形态 | 归宿 | 真实教材(目标仓A) |
|---|---|---|
| 有 status 列但全仓无 transition writer | **debt**(死状态机) | `merge_requests.status` 零 writer |
| insert-once 静态标志,从不迁移 | **debt** | `sandboxes.status` v1 |
| append-only 审计账(action 非 state) | 不建模 | `*_rollout_events` |
| 指针/不可变快照,无生命周期 | 不建模 | profiles / revisions |
| 父 loop 运行期内的支撑定时器 | **锚点归入父 loop** | `startSandboxKeepAlive` → L2 |
| 队列名注册表(定义无推进) | **消费 loop 的 `consumes_queues`** | `services.ts` |
| boot 一次性任务(seed / migrate) | 不建模(bootstrap) | debt 只留给"假装有生命周期的死物",一次性引导不是(校准 001 修订) |

## Pass 3 — loop 之上的 loop(组合)

在幸存 loop 之间找**边**,边聚成高阶结构:

- **生产/消费边**:A enqueue 的队列被 B consume(队列名匹配)→ 链路边。
- **共享状态载体**:两个 loop 写同一列 → **junction 候选**(并发/单写者风险,标 risk_class)。
- **看护边**:W 监测 X 的活性并触发恢复(health watcher / leak reconciler)→ `guarded_by`。
- **内嵌**:子状态机共享父边界但有自己的状态 → `parent` + `embedded: true`。
- **端到端有序穿越**(一次用户可见的完整旅程跨多个 loop)→ **flow**(C1 式链路)。

每条边给证据锚点;交接口(handoff)优先建 junction——跨 loop 交接是事故高发区。

**两条补充规则(校准 002 修订)**:
- **越界端记 stub 边,不要丢**:边的对端在扫描范围外时,记 `stub` 悬空边并标注"对端未知,疑在 X"——拒绝编造是对的,但线索保留给跨范围下一轮,丢弃等于重查(Webhook 生产者教训)。**stub 只进报告的 NOTES/草案,绝不写进 model YAML**(模型里没有 edge 节点;边只在核实双端后物化为 junction/flow 引用)。
- **交接口附近挖事故注释**:对每个 handoff 候选,grep 附近注释的 incident / race / postmortem / 日期 / bug 引用——**有真实事故背书的 junction 优先级最高**(已付过学费的风险点;2026-04-28 finalize race 实证)。

## Pass 4 — trace 升维(有运行时数据时,octo/conso-cli)

静态串不出的,用 trace 补:

- 拉**服务拓扑 + span 链**:跨服务闭环 → 验证/发现静态无法拼接的 flow。
- **只在运行时出现的 loop**:客户端轮询、网关重试、外部回调闭环——代码里分散在多端,trace 里是一条链。
- **频率/延迟/重试率聚合** → junction 风险分级的量化证据。
- **双向对账**:trace 里活跃但模型没有 → 新发现候选(回 Pass 2 证伪);模型有但 trace 长期无 → dormant 候选(不是删除,标 dormant)。
- **降级规则(冷启动/低采样兜底)**:trace 缺失、采样率低或观测窗口不足时,**挂起 dormant 判定**(未被采样 ≠ 不活跃),只做正向发现(活跃→候选),模型判定退回 Pass 1–3 纯静态。dormant 判定必须注明观测窗口与采样率。

## 输出与闭环

每遍产出 → 引擎核对:

```
LLM 四遍扫描 → model YAML 草案
  → codeontic check --strict-anchors   # 锚点真实性(机器)
  → codeontic reconcile                # 机械信号反向对账,LLM 漏了队列/定时器会被抓
  → 人审 → 落库
```
