/**
 * The agent kit `codeontic init` drops into a target repo (Proposal 009):
 * instruction files a coding agent in that repo reads and executes. Shipped as
 * embedded constants because the npm package publishes `dist/` only.
 *
 * PRIVACY: these constants compile into the PUBLIC npm package. They must stay
 * GENERIC — no target-repo internals (table names, file paths, loop ids). The
 * calibrated versions with real teaching examples live in docs/prompts/
 * (repo-private, excluded from the package). A structural test keeps the pass
 * skeleton in sync and asserts no target internals leak here.
 */

export const LOOP_DISCOVERY_PROMPT = `# Loop Discovery 提示词(四遍扫描法)

给 agent 用的行为发现方法:**两类候选召回 → 证伪 → 组合 → trace 升维**。

召回**两类**:自主推进的 **loop**(后台循环),以及被触发一次跑完的**执行路径**(CLI 命令、
构建管线、启动引导链)——后者建成 \`shape: anchored\` 的 flow。**只找 loop 会让零-loop 仓库
(CLI / 一次性管线)拿到一份空模型**,那不是"没什么好建模的",是建模方式选错了。

## 前置铁律(每一遍都适用)

1. **每条断言必须带 \`文件路径#符号\` 锚点,且 grep 对目标仓 HEAD 核实**。核实不到就标 unverified,不编造。
2. 产出写成 codeontic model YAML 草案(loop / junction / flow / debt),交 \`codeontic check --strict-anchors\` 核锚点、\`codeontic reconcile\` 反向对账——**LLM 负责发现,引擎负责核对**。
3. 运行数据只作实现状态证据,不反向改模型语义。

## Pass 1 — 穷举候选(loop 候选 + 路径候选)

**心法:宁滥勿缺。举证责任在证伪端,这一遍只管召回。**

扫**两类**候选。只扫 A 类是零-loop 仓库拿到空模型的根因——CLI / 构建工具 / 一次性管线的
主路径不会命中任何"自主推进"信号,但它们照样是该被钉住的行为。

### A 类 — loop 候选(自主推进)

按信号族地毯式扫,每个命中先假设是一个 loop:

| 信号族 | 例 |
|---|---|
| 状态列/枚举 | \`status\` / \`state\` / \`phase\` 列,\`VALID_*_TRANSITIONS\` 转移表 |
| 队列 | \`*_QUEUE\` const、消费注册(\`.work(\` 等)、入队调用 |
| 定时 | \`setInterval\` / **递归 \`setTimeout\` 自我重排**(leader 续租、退避重试常用此形态,只 grep setInterval 会漏) / cron / \`*_tick\` / \`*_sweep\` |
| 主动循环 | \`while (true)\` / poll / watch / long-poll |
| 重试恢复 | retry / backoff / \`:recover\` 队列 / reconcile / cleanup |
| 协调原语 | lease / lock / fencing / singleton key |
| 保活 | heartbeat / keepalive / TTL renewal |
| 事务模式 | saga / outbox / 带状态推进的订阅 |

每个候选记录:\`草名 | 命中信号 | 锚点 | 疑似状态载体 | 疑似推进机制\`。

### B 类 — 路径候选(被触发一次跑完,anchored flow 的来源)

| 信号族 | 例 |
|---|---|
| CLI 入口/子命令 | \`bin\` 声明、argv 解析、\`Command\`/\`yargs\`/\`commander\` 注册、\`--flag\` 分支 |
| 一次性管线 | build / compile / bundle / codegen / migrate-run / export / publish |
| 启动引导链 | 入口 \`main()\` → 初始化 → 装配 → 交出控制权(**每次调用都重跑的那种**) |
| 非交互模式 | pipe / \`-p\` / \`--print\` / stdin 驱动的一趟处理 |
| 请求-响应处理器 | 单个 handler 从入参到落盘的完整链路(无后台推进) |

每个候选记录:\`草名 | 入口锚点 | 途经关键符号 | 出口(落盘/输出/退出码)\`。

**A/B 不互斥**:一个仓库两类都有很正常(如 CLI 工具带后台 daemon)。**B 类候选不进 Pass 2 三判据**
(它们本来就不该通过"独立推进机制"),直接进 Pass 3 建 \`anchored\` flow。

**扫描完整性**:按子目录地毯扫完后,**必须单独扫所有未被子目录包含的顶层 .ts 文件**(\`src/*.ts\`、包根 \`index.ts\`、非 src 入口等——旗舰状态机常在根层被整体漏掉);输出 NOTES 必须**宣告未覆盖边界**(浏览器端代码、vendored 依赖、越界包),防"没报=没有"误读。

## Pass 2 — 证伪(杀死伪 loop)

对每个候选跑三判据,**任何一条找不到就不是独立 loop**:

1. **状态载体**:进度存在哪?(DB 列 / 队列位置 / 内存+lease)——找不到 → 无状态工具函数,杀。
2. **独立推进机制**:没有调用者时谁在推进它?(worker / poller / cron / 订阅)——只被动等调用 → 杀。
3. **恢复路径**:崩溃/错过之后谁接着推?(**明确没有也行,但必须记录**)。

**杀前必答三问(例外规则内联化——"例外说明"在长任务里会被遗忘,故升格为每条 KILLED 记录的必填字段)**:
每杀一个候选,KILLED 记录必须显式回答:
- **Q1 推进器是否可能在范围外?**(被 dispatch/其他包的 worker/客户端驱动)是 → **stub 保留**,不杀(执行平面 loop 天然"推进器在别处",极易系统性过杀)。
- **Q2 是否跨组件闭环的接收端?**(回调/invalidate/webhook 收端)是 → 记 Pass 3 闭环候选,不杀。
- **Q3 归父时是否有独立状态子集与阶段边界?** 是 → 标 embedded 子机候选(\`parent\`+\`embedded: true\`),不无痕折叠。

**分歧类标注**:证伪杀掉以下四类时必须标 \`divergence-class\`,交模型维护者终审(既有分类学可能与三判据分歧,不算 agent 定论):单趟管线 / 有界重试链 / vendor 包裹机制 / 无推进 resolver。

**KILLED 记录的固定字段(结构化防遗漏)**:
\`\`\`
- name / anchor / killed_by
  q1_advance_out_of_scope: <no | yes→改 stub 保留>
  q2_closed_loop_receiver: <no | yes→改 Pass3 候选>
  q3_embedded_state_subset: <no | yes→标 embedded 候选>
  divergence_class: <none | 单趟管线 | 有界重试链 | vendor包裹 | 无推进resolver>
  disposition: <debt死状态机|debt静态标志|审计账|归属父loop X|注册表|无状态工具|bootstrap>
\`\`\`
(三问是**防过杀**闸门,只挂在 KILLED 上;幸存者无需过。)

**被杀候选不是丢弃,按归宿分流**(这一步产出的 debt 和归属,和 loop 一样值钱):

| 证伪形态 | 归宿 |
|---|---|
| 有 status 列但全仓无 transition writer | **debt**(死状态机) |
| insert-once 静态标志,从不迁移 | **debt** |
| append-only 审计账(action 非 state) | 不建模 |
| 指针/不可变快照,无生命周期 | 不建模 |
| 父 loop 运行期内的支撑定时器(随某次执行启动/清理) | **锚点归入父 loop** |
| 队列名注册表(只定义无推进) | **消费 loop 的 \`consumes_queues\`** |
| boot 一次性任务(seed / migrate) | 不建模(bootstrap)——debt 只留给"假装有生命周期的死物" |
| **一次性执行路径**(CLI 命令、构建管线、启动引导链) | **anchored flow**(见 Pass 3)——**不是** bootstrap,别丢 |

> ⚠️ 上表最后一行是最容易误杀的一类。"没有独立推进机制"只说明它**不是 loop**,不说明它不值得建模。
> 一个 CLI 命令从入口到落盘是一条完整的、用户可见的、会出事故的执行路径,和后台循环一样需要
> 锚点和测试守护。**杀进 bootstrap 之前必问:这是"启动时跑一次就没人管的初始化",还是
> "每次用户调用都会重跑的主路径"?** 后者是 anchored flow。

## Pass 3 — loop 之上的 loop(组合)

在幸存 loop 之间找**边**,边聚成高阶结构:

- **生产/消费边**:A enqueue 的队列被 B consume(队列名匹配)→ 链路边。
- **共享状态载体**:两个 loop 写同一列 → **junction 候选**(并发/单写者风险,标 risk_class)。
- **看护边**:W 监测 X 的活性并触发恢复 → \`guarded_by\`。
- **内嵌**:子状态机共享父边界但有自己的状态 → \`parent\` + \`embedded: true\`。
- **端到端有序穿越**(一次用户可见的完整旅程)→ **flow**。flow 有**两种形态,必须显式声明 \`shape\`**:

| shape | 什么时候用 | 怎么写 |
|---|---|---|
| \`composed\` | 旅程由多个 loop 串起来,自己不持有实现 | \`traverses\`/\`guarded_by\`/\`crosses\`/\`references\` 组合别的节点,**不写 anchors** |
| \`anchored\` | 旅程**自己就是实现**——一次性执行路径,不由后台 loop 组成 | 写 \`anchors\`(\`path#symbol\`,同 Loop.anchors),可选 \`scenarios\` 绑测试 |

**\`anchored\` flow 是零-loop 仓库的主要建模手段。** 一个 CLI / 构建工具 / 一次性管线可能一个 loop 都没有,
但它照样有值得钉住的行为。这类仓库如果只找 loop,会得到一份空模型——那不是"这个仓库没什么好建模的",
是**建模方式选错了**。

- \`anchored\` flow **可以同时组合**:自己有 update 专属代码、又 \`references\` 另一条 flow,两者不冲突
  (锚点是它自己的贡献,不与被组合部分重复计分)。
- \`composed\` flow **不要挂 \`scenarios\`**:它不进评级,挂上去不会被评估(\`check\` 会 warn)。
  测试场景挂到它组合的那些 loop 上。
- 判据速记:**问"这条旅程的代码在哪"。答得出具体符号 → \`anchored\`;答"在它穿过的那些 loop 里" → \`composed\`。**

每条边给证据锚点;交接口(handoff)优先建 junction——跨 loop 交接是事故高发区。

**两条补充规则**:
- **越界端记 stub 边,不要丢**:边的对端在扫描范围外时,记 \`stub\` 悬空边并标注"对端未知,疑在 X"——拒绝编造是对的,但线索保留给跨范围下一轮,丢弃等于重查。**stub 只进报告的 NOTES/草案,绝不写进 model YAML**(模型里没有 edge 节点;边只在核实双端后物化为 junction/flow 引用)。
- **交接口附近挖事故注释**:对每个 handoff 候选,grep 附近注释的 incident / race / postmortem / 日期 / bug 引用——**有真实事故背书的 junction 优先级最高**(已付过学费的风险点)。

## Pass 4 — trace 升维(有运行时数据时)

- 拉**服务拓扑 + span 链**:跨服务闭环 → 验证/发现静态无法拼接的链路。
- **只在运行时出现的 loop**:客户端轮询、网关重试、外部回调闭环。
- **频率/延迟/重试率聚合** → junction 风险分级的量化证据。
- **双向对账**:trace 里活跃但模型没有 → 新发现候选(回 Pass 2 证伪);模型有但 trace 长期无 → dormant 候选(不是删除,标 dormant)。
- **降级规则(冷启动/低采样兜底)**:trace 缺失、采样率低或观测窗口不足时,**挂起 dormant 判定**(未被采样 ≠ 不活跃),只做正向发现,模型判定退回 Pass 1–3 纯静态。dormant 判定必须注明观测窗口与采样率。

## 输出与闭环

\`\`\`
LLM 四遍扫描 → model YAML 草案
  → codeontic check --strict-anchors   # 锚点真实性(机器)
  → codeontic reconcile                # 机械信号反向对账
  → 人审 → 落库
\`\`\`
`;

/**
 * Parallel (multi-agent) modeling instructions for a LARGE repo — the second
 * discovery entry point next to `LOOP_DISCOVERY_PROMPT` (Proposal 016 T2).
 * `loop-discovery.md` says HOW to find behavior; this one says how to split that
 * work across agents and put it back together without duplicate or colliding
 * nodes.
 *
 * Every rule here is a fixed incident from one real full-repo run (5 domains,
 * 60 nodes), stated GENERICALLY — the privacy rule at the top of this file
 * applies verbatim: no target-repo package names, symbols, or loop ids. The
 * incident is named ("what this prevents") because a rule without its accident
 * reads as style advice and gets dropped by the next agent under time pressure.
 */
export const LOOP_DISCOVERY_PARALLEL_PROMPT = `# 并行建模指令(大仓分域建模)

\`loop-discovery.md\` 讲**怎么发现行为**;这一份讲**怎么把发现工作拆给多个 agent 并行做,再合回一张图**。
每条规约后面都标了它防的**真实事故**——一次 5 域并行、60 节点的全仓建模里真实踩过的坑。

## 何时用这一份

| 仓库规模 | 走哪条路 |
|---|---|
| 源文件 < ~150 | 单 agent 走 \`loop-discovery.md\`,一遍扫完。并行的协调成本大于收益 |
| 源文件 ≥ ~150 | 分域并行:主控切域 → N 个 agent 各自跑 \`loop-discovery.md\` → 主控合并裁决 |

阈值是经验值不是判据。真正的判据:**一个 agent 的上下文装不下整仓的候选清单时**就该分域。

主控(你,发起这次建模的那个 agent)负责三件事:**切域、发号段、合并裁决**。发现工作全部下放。

## 第一步:切域——按行为归属,不按包归属

**每个域是一组行为,不是一组目录。** 分域文书里必须逐条写清每个域**认领哪些行为**,目录只是它的取证范围。

**跨包行为必须在切域时显式指定唯一归属**:一个行为的触发点在 A 包、真正干活的实现在 B 包时,
在分域文书里点名"这个行为归 A 域(或 B 域),另一域只作为上游/下游提及,不建节点"。

> **防的事故**:按包切域时,两个域各自在自己的包里看见同一个行为的一半,各自认领、各自建了一个 loop
> ——同一行为在最终模型里以两个 id 出现,锚点重复、计分两次,靠人工 \`uniq -c\` 锚点才发现。

分域文书(建模开始前必须先写出来,它是并行的唯一契约)每个域一行:

\`\`\`
域名 | 取证目录 | 认领的行为(逐条) | 明确不归它的跨界行为 | id 号段
\`\`\`

## 第二步:分 id 号段——并行隔离只靠号段

模型是 **file-per-node**(一个节点一个文件,**文件名必须等于节点 id**)。
只要号段不重叠,多个 agent 同时写同一个目录**天然不冲突**——这就是全部的冲突解。

| 节点类型 | 切段方式 | 例 |
|---|---|---|
| loop | \`L\` / \`N\` 双前缀各自切段 | A 域 \`L1-L9\` + \`N1-N9\`,B 域 \`L10-L29\` + \`N10-N29\` |
| flow | \`C\` 切段 | A 域 \`C1-C9\`,B 域 \`C10-C29\` |
| junction | 不切号段,用**域名前缀** | \`J-<域名>-<短名>\` |
| scenario | 不切号段,**跟宿主节点 id 走** | \`GWT-L12-001\` |
| debt | 不切号段,用域名 | \`DEBT-<域名>-<短名>\` |

号段一次发够(每域留出实际预计数的 2-3 倍余量)。**中途扩号段要主控统一发,agent 不许自取。**

**禁止给文件名另加域前缀。** 文件名就是 id,不多一个字符。

> **防的事故**:有个域为"避免撞车"给自己所有文件名加了域前缀,结果 30 个节点全部触发
> filename-id 不一致告警——它想解决的问题号段早就解决了,加前缀纯属自造问题。

## 第三步:派发

每个建模 agent 收到的 prompt 必须包含:

1. **它的域**:取证目录 + 认领的行为清单 + 明确不归它的跨界行为(照抄分域文书那一行);
2. **它的 id 号段**;
3. \`loop-discovery.md\` 全文(方法论不重写,直接引用);
4. **行为语言规约**(下一节);
5. **产出要求**:model YAML(file-per-node,文件名 = id)+ 一份分域报告(建了什么、杀了什么、哪些边悬空、哪些地方它没敢建)。

**agent 之间不通信。** 需要跨域的信息一律走主控:悬空的边写进分域报告的 NOTES,由主控在合并阶段补建。

## 行为语言规约(所有域统一)

**\`title\` / \`boundary\` 用业务行为语言写"承诺了什么",实现机制进 \`notes\` / \`anchors\`。**

| | 例 |
|---|---|
| ✅ 正例 | \`title: 多次变更合并为一帧、刷新节奏有上限\` |
| ❌ 反例 | \`title: 渲染调度循环(requestRender → 节流 setTimeout 自我重排)\` |

反例错在:它写的是**调用链**,不是**行为**。调用链回答"代码怎么写的",行为回答"系统承诺了什么"
——只有后者能让一个不读代码的人做判断,而这正是这张图存在的理由。机制信息不丢,挪进 \`notes\`/\`mechanism\`/\`anchors\`。

> **防的事故**:一整轮建模的 title 全是调用链词汇,报告页"在做什么"那一栏直接暴露:
> 读者看到一串符号名,答不出这个系统在干什么。返工代价是逐节点重写。

自检一句话:**把 title 念给一个没读过这个仓库代码的人听,他能不能听懂系统承诺了什么。**

## id 前缀约定(引擎强制,写错直接报错)

| 类型 | 格式 | 例 |
|---|---|---|
| loop | \`L\` 或 \`N\` + 1-2 位数字 + 可选小写字母 | \`L1\` \`L12\` \`L3a\` \`N7\` |
| flow | \`C\` + 数字(无上限) | \`C1\` \`C42\` |
| junction | \`J-\` + 小写字母/数字/\`-\`/\`_\` | \`J-write-lease\` |
| scenario | \`GWT-<宿主>-<三位序号>\`,**中段只收字母数字** | \`GWT-L12-001\` \`GWT-C3-001\` |
| debt | \`DEBT-\` + 字母数字/\`-\` | \`DEBT-dead-state\` |

junction 的 id 带 \`-\`,而 scenario 的中段不收 \`-\`——给 junction 挂场景时把它的短名压成字母数字
(\`J-write-lease\` → \`GWT-WRITELEASE-001\`),并在 junction 的 \`scenarios\` 里引用这个 id。

> **防的事故**:这套约定此前只活在 schema 的报错正则里,没有一处文档写过。
> 一次建模里两个建模 agent 和主控各撞一次格式错误,全靠 \`check\` 报错反推。

## 第四步:合并与裁决(主控做,不下放)

并行的成本全在这一步。逐条走完,不许跳:

1. **重复锚点裁决**:把所有节点的 \`anchors\` 摊平数一遍,同一个 \`path#symbol\` 出现在两个节点上就是重复建模的信号。
   **人工确认保留谁**(通常保留行为描述更完整的那个),被留下的节点并入退场者的独有内容(锚点、场景、notes),
   然后**全量修正对退场 id 的引用**:\`traverses\` / \`guarded_by\` / \`crosses\` / \`between\` / \`parent\` / scenario 的宿主 / 自由文本里的提及,一个都不能漏。
   > **防的事故**:重复建模在合并时静默入库,同一行为计分两次,成绩单虚高。这一步**不许自动化合并**——
   > 自动 merge 会让"两个域看见同一行为的两个侧面"这种情况丢掉其中一半的信息。
2. **跨包 flow 补建**:各域报告里的悬空边(对端在别的域)在这里物化成 flow 的 \`traverses\` 或 junction。
   **跨域的端到端旅程只有主控能看见**——它是并行建模唯一必然缺失的部分,不补就等于没建。
3. **自由文本 id 引用核对**:\`notes\` / \`boundary\` / \`summary\` 里手写的 \`L12\`、\`C3\`、\`J-xxx\` 逐个对照节点表。
   > **防的事故**:一处"见 L4 ..."的错误引用活过了两轮——更糟的是后来 \`L4\` 真的被建出来了,
   > 这个引用从"指向不存在的节点"恶化成"指向一个毫不相关的节点",从此没人能靠肉眼发现。
4. **owner 口径统一**:各域填 \`owner\` 的粒度不一致会让报告分组碎掉。合并时统一成同一层级(通常是包名)。
5. **收口**:\`codeontic check . --repo-root . --strict-anchors\` **exit 0**。锚点不真实、引用悬空、图有环,一条都不许留。
   然后 \`codeontic conformance\` / \`overview\` 看一眼:成绩单和地图读起来是不是一个正常系统。

## 诚实优先于覆盖率

**不值得建模的部分,在报告里明确列出来并写清理由,不为凑数把 CRUD 包装成 loop。**

- 纯增删改查、无状态工具函数、一次性 bootstrap:不建,写进"未建模清单"并说明理由;
- 扫不到、看不懂、拿不准的:标 unverified 或直接列进未建模清单,**不编造锚点**;
- 每个域的报告必须**宣告它没覆盖的边界**(浏览器端代码、vendored 依赖、越界的包),防"没报=没有"的误读。

一张 60 个真节点 + 一份诚实的未建模清单,比 90 个注水节点有用得多:
**注水节点会让成绩单虚高,而成绩单虚高会让这张图在第一次被用来做判断时就失去信任。**
`;

export const SETUP_PR_TEMPLATE_PROMPT = `# 任务:给本仓库的 PR 模板加 Loop 声明栏(codeontic 同步通道 ②)

你是本仓库的 coding agent。目标:让每个 PR 显式声明它是否引入/修改控制循环(loop),与 codeontic 的确定性对账(通道 ①)互证。

## 步骤

1. **找到现有 PR/MR 模板**:GitHub 为 \`.github/pull_request_template.md\` 或 \`.github/PULL_REQUEST_TEMPLATE/*.md\`;GitLab 为 \`.gitlab/merge_request_templates/*.md\`。没有就新建平台对应的默认模板。
2. **幂等**:若模板已含 "Loop 声明" 节,不要重复添加。
3. **追加以下节**(不改动模板其余内容、不重排格式):

\`\`\`markdown
## Loop 声明

<!-- 本 PR 是否引入或修改后台控制循环(队列消费/定时器/状态机/轮询/重试链)? -->
- [ ] none — 不涉及任何 loop
- [ ] 引入/修改: <loop id 列表,如 L2 / 新 loop 描述>
- [ ] uncertain — 不确定(将触发 loop 发现 agent 分析本 PR)
\`\`\`

## 规则

- 声明为 \`uncertain\` 或"引入/修改"的 PR,会触发 advisory 分析(通道 ③);声明 none 但确定性对账抓到新队列/定时器信号 → 矛盾,要求改声明。
- 提交这个改动时说明:这是声明栏,不是门禁——门禁只有确定性的 \`codeontic check\`。
`;

/**
 * Machine-readable prefix of the version-pin marker burned into the generated
 * `setup-github-actions.md` (A3). `init` re-runs skip existing kit files (to
 * preserve a repo's edits), so on re-run after a codeontic upgrade this marker
 * is how init detects that the burned pin has gone stale and WARNS — without
 * clobbering the file. Shared here so the writer and the reader (init.ts) can't
 * drift on the exact text.
 */
export const GITHUB_ACTIONS_PIN_MARKER = "codeontic-pin:";

export function setupGithubActionsPrompt(versionPin: string): string {
  return `<!-- ${GITHUB_ACTIONS_PIN_MARKER} ${versionPin} — codeontic \`init\` 烧录的当时版本;升级 codeontic 后本文件不自动更新,重跑 init 会提示此处过期。CI 实际锁定以 workflow 文件为准。 -->

# 任务:为本仓库编写 codeontic 的两个 GitHub Actions(通道 ③ advisory + ④ nightly)

你是本仓库的 coding agent。**先读 \`.github/workflows/\` 下的现有 workflow**,沿用本仓库的 runner、Node 版本、缓存、secrets 命名等约定——不要凭空发明风格。

## 红线(两个 workflow 共同遵守)

- **锁定 codeontic 版本,绝不用 \`@latest\`**:workflow 里每一处调用都写固定版本——\`npx codeontic@${versionPin} <cmd>\`(本仓库 \`init\` 时的当前版本已填好)。引擎接口会随版本演进(适配器 \`interfaceVersion\`、门禁行为、报告格式),\`@latest\` 会让某天的自动升级悄悄改变门禁语义、或让本仓适配器版本不匹配而集体失效——**接入仓库"某天起 CI 一直绿但对账其实早停了"的静默失效,根因就是这个**。升级 codeontic 走显式流程:手动把版本号改到新值 → **在同一个 PR 里**重新跑全量校验(\`check\` + \`conformance\`,确认适配器仍加载、门禁仍通过)→ 再合并;绝不放任 CI 自动漂移。适配器接了 codeontic 的仓库,\`check\`/\`conformance\`/\`reconcile\` 建议加 \`--strict-adapter\`,让适配器加载失败直接红,而不是静默降级成"无适配器模式"。
- **永不阻塞 PR**:两个 job 都不得成为 required check;advisory job 失败不允许挂 PR(结论只以 comment/artifact 形式给出)。确定性门禁(\`codeontic check\`)是另一条独立通道,那里永不调 LLM。
- agent 的 API key 从仓库 secrets 读;若本仓库没有可用的 agent 运行器,生成带 TODO 注释的 workflow 骨架并在 PR 描述中说明缺什么。

## Workflow ③ — PR advisory(非门禁)

一个 workflow,两段:**确定性段永远跑**(零 LLM、几秒钟),**LLM 段条件跑**。两段都不阻塞 PR。

### ③-a 确定性段(每个 PR 都跑,零 LLM)

- \`npx codeontic@${versionPin} conformance . --repo-root .\` —— **不加 \`--strict\`**:成绩单是给人读的报告,不是门禁。
  输出贴成 **PR comment**(幂等:同一个 PR 更新同一条 comment,不每次 push 追加一条),同时作为 artifact 存档。
  读法写进 comment 正文:**每条 gap 是实现欠模型的一笔账**,不是"CI 挂了"。
- \`npx codeontic@${versionPin} snapshot . --repo-root . --drift <base-snapshot.json> --drift-json\` —— 把本 PR **新增的拓扑边**当场告诉作者。
  \`--drift-json\` 把 drift 作为**一个 JSON 值打到 stdout**(必须同时给 \`--drift <prior.json>\`,否则命令直接报错退出),
  管道进 \`jq\` 生成 comment 正文。\`<base-snapshot.json>\` 从 Workflow ④ 的 nightly artifact 取(见下),取不到就 skip 这一步,不要用空文件糊弄。

### ③-b LLM 段(条件执行,省算力)

- **触发条件**(不满足直接 skip):PR 模板 Loop 声明为"引入/修改"或 \`uncertain\`(解析 PR body);或 diff 超过约 500 行;或 diff 命中高风险路径/内容(状态列 schema 目录、队列 const、\`setInterval\`、消费注册调用——按本仓库实际目录结构定 glob)。
- 执行:调用 agent 运行器,输入 \`.codeontic/agent/loop-discovery.md\` 的 Pass 1–3,范围限定为本 PR 的 diff;产出 loop/junction YAML 草案。
- 输出:以 **PR comment** 发布发现摘要 + 草案文件路径;草案作为 artifact 上传,由作者决定是否随 PR 落入 \`model/\`。

## Workflow ④ — nightly(快照留存 + 漂移兜底)

- 触发:\`schedule\`(每日一次,选低峰时段)+ \`workflow_dispatch\`。
- **④-a 全量快照(确定性,零 LLM)**:\`npx codeontic@${versionPin} snapshot . --repo-root . --out snapshot.json\`,
  artifact 上传并**保留足够长的天数**(默认 90 天够用)。这份 artifact 就是 ③-a 的 \`--drift\` 基线——没有它,PR 期的拓扑边送达无从对比。
  \`snapshot\` 永远 exit 0、永远不进门禁(漂移是报告出来的,不是失败出来的)。
- **④-b re-discovery(LLM)**:对过去 24h 变更的源码文件跑 Pass 1–2,与 \`model/\` 现状 diff,产出"疑似新 loop / 疑似漂移"报告。
- 输出:报告作为 artifact;发现疑似新 loop 时开一个 issue(幂等:已有同名 open issue 则追加评论,不重复开)。
- 定位:这是认知盲区的兜底——PR 期声明 none 且未触发 ③ 的语义新 loop,最迟这里浮出。

## 验收

- 两个 workflow 语法有效(\`actionlint\` 或 dry-run 校验)。
- **codeontic 版本已锁定**:全文件搜不到浮动的 \`@latest\`,每处调用都是 \`codeontic@${versionPin}\`(或本仓当前锁定版本)。
- 在 PR 描述中逐条说明:触发条件、为什么不是 required check、secrets 依赖、锁定的 codeontic 版本与升级流程。
`;
}

/**
 * The unified `/codeontic` skill front door (the single entry a coding agent —
 * Claude Code, and any agent that can read a SKILL.md — routes through). Ships
 * to `.claude/skills/codeontic/SKILL.md` in the target repo. Like the rest of
 * the kit it compiles into the PUBLIC npm package, so it must stay GENERIC — no
 * target-repo internals; example ids are the neutral L1/C1/J- forms only.
 */
export const CODEONTIC_SKILL = `---
name: codeontic
description: >-
  模型驱动工程控制(Model-Driven Engineering Control)的统一入口。当仓库里有
  .codeontic/ behavioral model,或你要:发现/建模后台控制循环(control loop /
  队列消费 / 定时器 / 状态机 / 轮询 / 重试链)、把一次改动对着模型做确定性门禁
  (check)、看实现相对模型欠了哪些账(conformance / gaps)、可视化整张模型
  (graph),或在改代码前查模型的影响面/执行计划/场景/证据时,使用本 skill。
  Triggers: codeontic, .codeontic/model, control loop, loop discovery,
  behavioral drift, a PR's Loop declaration.
---

# codeontic — 统一前门

**一句话**:结构化行为模型是规范事实源,代码/测试/可观测信号是它的投射与证据。方向永不反转——代码来对齐模型,不是反过来。发现靠 LLM(你),防腐靠引擎(确定性 CLI,永不调 LLM)。

**前置**:命令都在目标仓库根跑。\`.codeontic/model/\` 不存在就先 \`npx codeontic init\`。查询优先用 MCP(\`npx codeontic mcp .\`)拿任务相关的模型切片,别全量读 spec。

## 按意图路由

### 1. 改代码前先理解 → 查模型,别读全量 spec
- MCP 工具:\`model_search\`(自由文本找入口节点——不知道 id 时永远从这里开始)、\`model_inspect\`(切片定位)、\`model_impact\`(改这个牵动谁)、\`model_plan\`(一条 flow 怎么跑)、\`model_scenario\`(GWT 细节 + 验证测试)、\`model_evidence\`(节点的锚点/证据)、\`model_matrix\`(flow 的 GWT↔test 覆盖)。
- 或 CLI:\`codeontic search "<关键词>" .\`(找入口,多词加引号) / \`impact <id> .\` / \`plan\` / \`scenario\` / \`evidence\` / \`matrix\`。
- 铁律:动手前先 \`model_impact\` 看影响面。

### 2. 发现/建模新行为 → 四遍扫描
- 严格执行 \`.codeontic/agent/loop-discovery.md\`(两类候选召回 → 三判据证伪 → 组合 → trace 升维)。
- 产出 model YAML 草案:每条断言带 \`path#symbol\` 锚点并 grep 对 HEAD 核实;核实不到标 unverified,不编造。
- 闭环:\`check --strict-anchors\`(核锚点)→ \`reconcile\`(反向对账)→ 人审 → 落库。**草案未经维护者核实不落库。**

**先按仓库规模选路**(第一次给整个仓库建模时尤其重要):

- **源文件 < ~150(小仓)**:单 agent 直接跑 \`.codeontic/agent/loop-discovery.md\`,一遍扫完。
- **源文件 ≥ ~150(大仓)**:先读 \`.codeontic/agent/loop-discovery-parallel.md\` —— 分域(**按行为归属,不按包归属**)→ 发 id 号段 → 并行派发 → **主控合并裁决**。

分不清就看上下文装不装得下:一个 agent 的上下文放不下整仓候选清单时,就该分域并行。
并行的成本全在合并那一步(重复锚点裁决、跨域 flow 补建、id 引用核对),**不许自动合并**。

**如果这个仓库一个 loop 都没有(CLI / 构建工具 / 一次性管线):不要就此收工交空模型。**
零-loop 是常见形态,不是"没什么可建模的"。改用 \`shape: anchored\` 的 flow 给主执行路径建模——
每条用户可触发的完整路径一条 flow,\`anchors\` 钉入口和关键符号,\`scenarios\` 绑测试。
判据速记:**问"这条旅程的代码在哪"。答得出具体符号 → \`anchored\` flow;答"在它穿过的那些 loop 里" → \`composed\` flow。**

### 3. 门禁一次改动(确定性,零 LLM,唯一的 gate)
- \`codeontic check . --repo-root . --strict-anchors\`
- 检查 schema / 引用完整性 / 图无环 / 锚点存在性 / canonical-writer 不变量。亚秒级、零网络、可复现。这是唯一会 fail 一个 PR 的通道;发现层(LLM)永远只出草案、不进门禁。

### 4. 看实现欠模型哪些账 → 履约成绩单
- \`codeontic conformance . --repo-root .\`
- 每个 loop/junction 给 \`met\` / \`partial\` / \`gap\` + 缺口清单(no-anchor / anchor-missing / no-scenario / scenario-unverified / test-missing / queue-unmatched / evidence-missing)。
- 读法:**每条 gap 是实现欠模型的一笔账,不是模型的问题**。先看红的(gap)——模型声明了、代码没接住。加 \`--strict\` 让有缺口时非零退出。

### 5. 可视化整张模型 → 自包含 HTML
- \`codeontic graph . --repo-root .\` → 写 \`.codeontic/ws/graph.html\`(gitignore,离线可开),按履约状态上色,红节点一眼看到漂移。

### 6. advisory 对账 / 覆盖(不进门禁)
- \`codeontic reconcile . --repo-root .\`:代码→模型(代码里有模型漏登记的队列/定时器)。
- \`codeontic coverage .\`:模型自检(多少节点真被锚点/场景绑住)。
- \`codeontic snapshot . --repo-root .\`:nightly 全量快照 + 漂移报告(永不进门禁)。

## 红线(任何路径都遵守)
1. 每条模型断言带 \`path#symbol\` 锚点,对目标仓 HEAD 核实。
2. 模型是事实源,代码来对齐;运行数据只作实现状态证据,不反向改模型语义。
3. 发现靠 LLM,核实靠引擎;门禁零 LLM、零网络、零代码执行。
4. LLM 只产草案,落库须经人审。

## 不止 Claude Code
本文件是通用 agent 工作流指令。Cursor / Codex / Gemini CLI 等任何 coding agent 都可读 \`.claude/skills/codeontic/SKILL.md\` 照此执行;\`npx codeontic <cmd>\` CLI 与 \`codeontic mcp\` server 是统一接口。
`;
