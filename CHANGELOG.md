# codeontic

## 0.11.0

### Minor Changes

- 68dbcad: overview 页面同时说中文和英文，右上角一键切换。

  `overview` 产出的是**一个自包含的 HTML 文件**，而 `docs/examples/pi-overview.html` 是这个项目递给全世界的那个链接（README 里直接指过去）。一个链接必须同时招待中文读者和英文读者——这正是这种交付形态存在的理由。所以语言做进页面里，不做成 `--lang` 参数：加参数会让每份生成的文件只服务其中一半人，同一页还得生成两遍，README 也得挑一半读者。

  - 默认跟浏览器走（`navigator.language`），手动切过就记住（localStorage，key 带页面标识，不会和别的页面串）。
  - 切换是原地重渲染：滚动位置、已经打开的详情栏都留着，只有字变了。
  - **只翻界面**。loop/链路/交接点的标题、状态流转、场景的给定/当/则、旧账正文、归属、代码路径、id——那些是用户自己写在模型里的字，两种语言下都原样显示。所以中文模型配英文外壳是**正确结果**，不是漏翻。

  漏翻这件事交给三道机器检查，不靠人过一遍：编译期 `EN: typeof ZH` 挡住缺 key，运行期比对两份字典的 key 集合、扫英文字典里残留的中文、再扫整页去掉字典和模型之后还有没有硬编码的中文。

- 68dbcad: overview 加系统全景图，并把版面重排成「先整体、再局部、最后账单」。

  - **① 系统全景**（新）：一张自包含 SVG，把所有建模节点按代码包分区画出来——圆角胶囊是入口链路、方块是 loop、颜色是落实程度，交接点画成连线（跨包的用虚线加重）。悬停一条入口会点亮它经过的 loop，点任何节点打开右侧详情栏。几何全部在 `computeArchitecture` 里确定性计算，只依赖已经算好的 `OverviewModel`，所以任何一份已生成的页面都能重新渲染。
  - **④ 建模细节**（新）：交接点清单、场景与测试覆盖统计、队列消费关系。这三样此前只能一个个点开抽屉才看得到。
  - **⑤ 欠账**移到最后，长文本折叠并写明真实字数——真实模型上一条旧账能到一千多字，三条排在开头就是一堵墙。

### Patch Changes

- 68dbcad: 修 overview 页面上一批「说了自己数据支持不了的话」的地方（深度审查确认 15 条）。

  统计口径：场景按 id 去重（一个场景被两个节点引用不再数两遍）、引用了不存在的场景不再算进「写下来的场景」、休眠 loop 和不打分的组合链路不再被列成「缺场景」的欠账、绑了测试但这次没核对存在性（不带 `--repo-root`）单独成一档而不是算作「绑到了真实存在的测试」、队列缺口按队列名标记而不是按 loop 整片标红。

  全景图：`（未归属）` 兜底桶不再被算成一个代码包；同一个包用 owner 短名和 anchor 路径两种写法不再画成两个盒子；`owner` 为空的 loop 在全景图和「不在任何链路里」两栏落到同一个模块名下；多端交接点画出了一段就不再被写成「没画出来」；盒宽和标签截断按显示宽度算，中文包名不再溢出。

  另外：`risk_class` 进字典（此前是页面上唯一直接把内部 enum 当界面信息给读者看的地方）；队列名走无原型对象（叫 `__proto__` 的队列会抛异常并让整页所有点击失效）；源码里两个字面 NUL 字节删掉（它让 grep 把整个视图文件当二进制跳过）。

## 0.10.2

### Patch Changes

- 502be95: overview 页面区块顺序调整：先展示用户旅程与后台 loop（系统建模本身），欠账列表放最后。此前欠账置顶，第一次打开页面的人在还没看过系统长什么样时就先看到一堆问题，缺乏上下文。

## 0.10.1

### Patch Changes

- cbc4fcb: package.json 补 `repository` / `homepage` / `bugs`——没有 repository 字段时，npm 包页无法把 README 里的相对图片路径重写到仓库，导致全部图片裂图。

## 0.10.0

### Minor Changes

- **项目更名：`loopgraph` → `codeontic`**（code + 本体论）。同一引擎、同一版本线的延续:0.10.0 之前的所有版本以 `loopgraph` 之名发布于 npm,旧包已 deprecate 并指向本包。全链同步更名:CLI bin、目标仓目录(`.codeontic/`)、skill 前门(`/codeontic`)、MCP server 名、缓存目录(`~/.cache/codeontic`)、守卫环境变量(`CODEONTIC_DENY_PATTERN` / `CODEONTIC_DENY_PATH_PATTERN`)。仓库同时重建以清除历史,此前的完整开发历史保存在私有归档仓中。

## 0.9.0

### Minor Changes

- bdcc868: overview:flow(用户旅程)补上抽屉——之前只有 loop 能点开,而 flow 恰恰是人读懂系统的入口,报告"这些机器怎么接起来"这一问只答了一半。

  - flow 卡片的 id+标题成为抽屉入口(不是整张卡片——卡片里的步骤/看门狗 chip 有自己的点击目标),复用 loop 抽屉的全部版式:verdict + code/test 两轴、自有 anchors(带 ✓/✗ 与 blob 链接)、自有 GWT 场景与绑定测试、穿过的交接点
  - 组合型 flow(自己不计分,由所属 loop 计分)在状态位说明这一点,而不是留一个读起来像"未评/坏了"的空框
  - 抽屉里的步骤按执行先后逐行列出,每步是该 loop 的 id + 标题 + verdict 圆点,点进去就是那个 loop 的抽屉——旅程可以一路走下去
  - 欠账区块里的 flow 行改成和 loop 行同样的可点 chip(此前是死文本)

  载荷变更:`OverviewFlow` 新增 `scenarios` 字段。flow 带自有 scenario 是既有能力(F2b),但载荷里根本没有这个字段,所以一条绑定完整的 flow 场景在页面上等于不存在。与 loop 共用同一个 scenario 构造器,两种测试锚形态(`path#symbol` 与 `{file,text}` 文本锚)一并解析。

  CLI:`overview` 摘要行的 `N background` 改为 `N 个未被任何链路引用`。该分组的唯一判据就是"没有任何链路引用它",与页面 ③ 栏文案对齐(016 D7)。

- 6ccafef: 信任链：conformance 不再对失效锚点判 met（Proposal 016 T6，含 issue #48）

  - **P0 假 met**：`conformance` 过去只 stat 锚点文件，符号被改名后成绩单纹丝不动——`check` 已经在警告，分数还写着 `met code✓ test✓`。现在 `check` 与 `conformance` 共用同一次文件扫描（新增 `src/validate/presence.ts`）：节点自身锚点**全部**失配才降 `code`（文本匹配有假阴性，不因一个失配就否定整组），scenario 的任一 `verified_by` 失配则该 scenario 不计入 `test`，gap 原文点名失配的锚点。门禁维持宽松：`anchor-symbol` 仍是 warning，`--strict-anchors` 仍不提升它。
  - **`verified_by` 支持文本锚**：条目可写成 `{file, text}`，语义与 `crux` 完全一致（精确子串 + 去空白归一化两级匹配，恒为 warning）。此前 JS 测试标题（含空格）无法用 `path#symbol` 表达，使用者被迫下划线化，写出的锚点当天就是失效的——这两个缺陷叠成"越认真填 `verified_by` 越容易拿假分"的通路。
  - **执行强度可见**：每个节点行展示支撑它的 scenario level（`test✓ [unit,integration]`），证据全为 e2e 时标注 `(e2e-only evidence)`。只展示判据，不改判定。
  - **覆盖声明**：带 `--repo-root` 时报告首部输出模型锚定的唯一文件数，并写明这是"搜索彻底度"代理指标而非业务完整度。
  - **`--strict-anchors` 语义写进 help**：明确它提升哪两项为 error、哪两项恒为 warning 及原因。行为不变。
  - **issue #48**：`snapshot` 在 facts 扫描失败时不再输出 `topologyEdges: []`——改为 `null` 并带失败原因，使 `--drift-json` 落进 `edges.comparable: false`。此前"压根没扫"会被消费端读成"比过了、没有变化"。

- 6ccafef: Proposal 016 三层打动路径落地（外部三仓实测暴露的 D1–D11 全量修复）：

  **信模型（成绩单可信）**

  - conformance 消费符号级失配：锚点/verified_by 指向的符号不存在时不再判 met，降级 partial/gap 并点名失效锚点（D1 P0；含 novu 实测活样本回归）
  - scenario `verified_by` 支持 `{file, text}` 文本锚形态（复用 crux 两级匹配），JS 测试标题（含空格）可直接引用，消除"被迫下划线化 → 必然失配"通路（D2）
  - conformance 按节点展示测试证据 level，全 e2e 证据标注成色（D9）；`--strict-anchors` help 如实声明升级范围（D4）
  - snapshot：facts 扫描失败时 `edges.comparable` 不再假报 true（issue #48）

  **建模型（跨节点一致性 + 表达力）**

  - check 新增 anchor-duplicate：同一符号被多个 loop/flow 锚定 → warning（junction evidence 引用除外）（D8）
  - check 新增自由文本 id 引用校验：notes/boundary/summary 里提及不存在的节点 id → warning（D10）
  - `Junction.between` 接受 FlowId，可表达 Loop↔Flow 交接（D3）

  **用模型（判断界面）**

  - overview：覆盖声明进页头（锚定文件数/提交触达，注明代理指标口径）（D11）；欠账区块置顶（debt/gap/partial/test✗ junction）；"后台机器"改为判据式文案（D7）
  - conformance 报告首行输出覆盖声明

  **养模型（接入路径）**

  - init 出口指引 + 成本声明；新增 `.codeontic/agent/loop-discovery-parallel.md` 大仓分域并行建模指令（行为归属分域、id 号段、file-per-node 冲突解、行为语言规约、合并职责清单）；SKILL.md 增并行路由；id 前缀约定成文（D5）
  - init 生成 `.codeontic/adapter/package.json`（type: module），消除 Node ESM 警告（D6）

### Patch Changes

- 3f57945: 文案与定位：中文动词统一（锚点绑定用「绑定」、版本 pin 用「锁定」，全量去掉「钉」）；README 双语新增「想法从哪来（本体论）」与「coding agent 怎么用它」两节；包描述改为中文定位。

## 0.8.0

### Minor Changes

- c6ecad6: `coverage` 现在把 Flow 自带的 `anchors`/`scenarios` 计入报告，与 `conformance` 的口径对齐（issue #16）。

  **修的是同一份模型两个报告互相矛盾。** F1/F2a/F2b 给 Flow 加了自己的 `anchors`/`scenarios` 之后，`conformance` 的 `gradeFlow` 已经按这两个字段评级，但 `coverage` 里 flow 的覆盖仍然只数 `traverses`。后果在零-loop 仓库上最刺眼：一个 CLI 型仓库的行为全靠 flow 自有锚点撑着、`traverses` 是空的，于是 `conformance` 说有覆盖、`coverage` 说 0。而「零-loop 仓库也能有成绩单」正是 Flow 一等公民的卖点——卖点在自己的覆盖报告里不成立。用户可见的自相矛盾读数比缺失更伤信任，因为没人知道该信哪一半。

  **新增读数**：`Coverage.flowsWithAnchors` / `flowsWithScenarios`（与既有的 `loopsWithAnchors`/`loopsWithScenarios` 对称命名），以及每条 `FlowCoverage` 上的 `hasOwnAnchor` / `hasOwnScenario`。取值口径与 `conformance` 评分读的是同一批原始字段，同样只认**直接挂载**的 scenario（不解析 `applies_to`）。

  **刻意不合并进既有的 `X/Y`。** 自有锚点是一条独立的轴，从不并入基于 `traverses` 的 `loops`/`loopsWithScenarios`。CLI 里那个分数保持纯 `traverses` 语义，自有覆盖单独用 `[own: anchor✓ scenario✓]` 标注，且只在 flow 确实声明了才显示。这样任何读者都能拿分子分母把打印出来的比值除回来——本仓刚修过一次摘要行自相矛盾（打印 `C 82/40=0.85`，而 82/40 是 2.05），不再造第二个。悬空 `traverses` 引用「只压低、永不抬高」的既定性质也因此原样保持：两条轴的计算完全独立，不可能互相污染。

  顺带修正一处静默：「无行为建模」的判定从 `loopsWithScenarios===0 && loops>0` 改为 `loopsWithScenarios===0 && !hasOwnScenario`。零-loop 但有自有 scenario 的 flow 不再被误标；零-loop 且确实什么都没有的 flow 现在会被显式标出，而不是静默显示为 `0/0`。

- c6ecad6: Proposal 013（Graft survey adoption）B1–B5 落地发版。这批能力早已合入 `main`，但当时没带 changeset——按本仓的发布约定，没有 changeset 的 PR 不触发发版，于是 npm 上一直停在 0.7.0，这些能力对任何走 `npx codeontic@latest` 的目标仓等于不存在。本条补上那次遗漏。

  **B1 — owned-section 幂等 `init`。** 机器托管区用 HTML 注释标记（`<!-- codeontic:managed:start/end -->`）圈定，升级只重写标记内的内容，用户写在标记外的段落原样保留。没有标记的旧文件**不会**被自动重写，只打印迁移提示。

  **B2 — `crux` 文本锚。** Loop/Flow 新增 `crux` 字段：逐字的代码片段作为行为锚。两级匹配（精确子串 → 去空白后再比），接进 T0 检查（`--repo-root` 下与 anchor-existence 同一道门）。锚不上时是 warning、exit 0，`--strict-anchors` 也不升级为 error。

  **B3 — Claude Code hooks。** `codeontic hook post-edit` / `session-start`，按 Claude Code 的真实 schema（matcher 分组 + 嵌套 `hooks` 数组 + 秒计 timeout）合进 `.claude/settings.json`。fail-soft：畸形 stdin、无关文件、没有模型的仓库都静默 no-op 且 exit 0。

  **B4 — 多 agent host registry。** `init --agents auto|cursor,gemini,copilot,...`，按 host 写入各自的指令文件与 `mcpServers` 配置。

  **B5 — `model_search` MCP 工具。** camelCase 切分 + CJK、IDF 加权打分、经 `impactOf` 做 1-hop 扩展，命中 ≤3 时给出升级到 `model_inspect`/`model_overview` 的提示。

  **升级前请注意（本条 minor 会改动目标仓里的文件）**

  1. B1 的 managed-section 重写是 `init` 的**默认行为**，不是 opt-in；`--hooks claude` 和 `--agents <list>` / `--agents auto` 才是 opt-in。
  2. `--hooks claude` 会写 `.claude/settings.json`；`--agents` 会写 `AGENTS.md` / `GEMINI.md` / `.github/copilot-instructions.md` / `.cursor/rules/codeontic.mdc` 及对应 host 的 `mcpServers` 配置。**两类文件的语义不同，升级前必须分清**：

     - **section 型**（`AGENTS.md` / `GEMINI.md` / `.github/copilot-instructions.md`、agent kit、SKILL.md、`.claude/settings.json`、各 host 的 `mcpServers` JSON）：只动托管区/只做合并，用户写在托管区外的内容保留——已在真实升级路径上逐字节核实。
     - **owned 型（现在会保护你的改动）**：`.cursor/rules/codeontic.mdc` 在 registry 里是 `owned`。**发版前修掉的一处静默数据丢失**：它原本对内容不同的既有文件直接整文件重写、只输出一行 `instruction → updated`，手改过的内容会无声消失（未提交的话不可恢复）。现在改为**不写**，报 `instruction → skipped-modified` 并打印恢复步骤（删掉该文件再跑 init 才会取新版本）。姿态与 B1 对无标记 managed 文件的处理一致：跳过 + 提示，不重写。

     升级后仍建议先 `git diff` 再提交。

  3. 生成的 hook 命令是裸的 `npx codeontic hook post-edit`，假定 codeontic 已是目标仓的本地 devDependency。目标仓没装的话，每次编辑都会让 npx 去 registry 解析，带来网络依赖和版本漂移风险。
  4. `model_search` 的中文查询是**连续子串**匹配，不做词法切分：`tokenize()` 把连续 CJK 字符当成一个整体 token。完整短语或单个中文词能正常命中；把两个语义相关但在文本里不相邻的中文词组合起来查（如「订单取消」对应标题里的「订单…取消」）会得 0 hits。这是移植自 Graft 的既定分词语义，不是回归——真要改需要引入分词库，超出 013「确定性、零依赖」的范围。

  发版前已在打包产物（`npm pack`）上跑过完整的目标仓 E2E：真实旧版本（npm 上的 `codeontic@0.7.0`，pre-B1）产物升级到本版本后 7 个文件逐字节不变、双跑 `init` 零 diff、既有用户 settings 与 section 型 host 配置保留（owned 型的例外见上文第 2 条）、hooks 从 stdin 真实触发并产出 `hookSpecificOutput.additionalContext` 信封、`model_search` 经真实 MCP client 往返且同查询两次结果逐字节相同。详见 `docs/proposals/013-graft-survey-adoption-release-readiness-report.md`。

- c6ecad6: `snapshot` 的漂移判定：拓扑边变化不再计入 `clean`，改为独立分组始终可见；新增 `--drift-json` 让 PR 档能当场把新增边报给作者（issue #38）。

  **为什么反转上一版的判断。** 上一版把边变化按边粒度计入 `clean`，比按调用点粒度算噪音小得多，但方向仍然错了：**新增一条服务间调用是正常开发行为，不是错误。** `clean` 是「有没有不该发生的事」的总开关，被正常开发行为频繁翻掉就等于废掉。代价不只是目标仓 adapter 接入后第一个 nightly 的一次性台阶，而是此后每一次调用点增删都会把 `clean` 翻成 false。这个仓已经踩过同一个失效形态一次——拓扑事实混进 `reconcile` 对账，未注册数从 6 冲到 69、真信号被淹，靠 `reconcilableSignalKinds` 才修掉。

  **`clean` 的范围，顺带说清（既有限制，不是本次引入）**：它比较的是 implementation facts、T0/INV-1 计数和判据 C 的聚合数，**不是模型图的等价性判定**——Snapshot 里没有节点身份与关系的稳定摘要，所以一处让全部计数保持不变的改动（比如把某条 Flow 的 `traverses` 从一个 loop 改指到另一个）仍然读作 `clean: true`。把它读成「被跟踪的信号都没动」，不是「模型没变」。补上这个缺口需要在 Snapshot 里存模型摘要并 bump schema，不在 issue #38 范围内，单独跟进。边移出 `clean` 之后这条判定成了主结论，所以在这里点明而不是留给人自己发现。

  **归类规则（写进 `SnapshotDrift.clean` 的文档注释，不再一事一议）**：会因非模型原因频繁变动的事实，一律不进 `clean`，改为在 `renderDrift` 里拿一个始终可见的独立分组。三个实例：`backtestDelta`（窗口天天动，排除）、`coverageRatioDelta`（只有模型真变才动，计入）、`addedEdges`/`removedEdges`（本次，排除）。

  **边变化没有被藏起来。** `renderDrift` 里新增一个无条件打印的 `topology edges` 分组（不管 `clean` 是 true 还是 false 都打）。`clean=true` 的收尾文案去掉了 "edges" 一词，且当边确实变过时会附一句说明，避免「收尾说没漂移」和「上面刚打印了边变化」两处互相矛盾。注意这里**不是**把 `snapshot` 的范围收窄——那等于直接看不见，是 issue #38 明确否掉的选项。

  **送达做在 PR 档：新增 `snapshot --drift-json`。** 既然边变化不再翻 `clean`，nightly 就是错误的送达处——它隔天、没有作者上下文、红了也没有具体的人认领。`--drift-json`（需与 `--drift` 同时给）在 stdout 上发出**恰好一个** JSON 值 `{ran: true, edges, drift} | {ran: false, skippedReason}`，PR job 拿 base snapshot 与本次 diff 后读 `drift.addedEdges` 即可当场提示作者，不阻塞。`edges` 是**必填**的可比较性状态（`{comparable: true} | {comparable: false, reason}`）：`addedEdges: []` 有三种成因——真的没加边、边比较被跳过、以及**压根没扫描**（漏给 `--repo-root`，或没解析到 adapter）。`Snapshot.topologyEdges` 只区分前两种，对 snapshot 是对的（「无 adapter」是正常的空结果），但对 PR 门禁那是配置错误，不区分就会在每个 PR 上永远报「没有新增边」——正是本次交付要消灭的静默通过。消费者必须先看 `edges.comparable` 再读 `addedEdges`。契约与 `backtest --json` 一致：绝不在同一个流上混排文本与 JSON，两种状态回同一个嵌套形状。`--drift-json` 时 adapter 状态横幅改道 stderr（`… --drift-json 2>debug.log | jq` 仍能看到），snapshot 产物照常写盘——这个 flag 只改变命令**说**什么，不改变它**产出**什么。不给 `--drift` 就给 `--drift-json` 是硬错误（exit 1）而不是永远回 `{ran:false}`：后者是一个在每个 PR 上都报「没有新增边」的静默通过。

  `SNAPSHOT_SCHEMA_VERSION` 保持 3：`Snapshot` 落盘形状没变，变的只是 `diffSnapshots` 怎么给它评分，而 `SnapshotDrift` 从不落盘。

  **过渡窗口，明确写出来而不是留给人自己发现**：本版本发布后、目标仓把 PR job 接上之前，边变化只出现在 nightly 的那个独立分组里——比之前"翻红"要轻。这是有意为之的排序，不是遗漏：

  - 引擎装不下目标仓的 CI 接线（取 base snapshot、跑 diff、发 PR 评论都在另一个仓），让引擎发版等下游 CI 会把开放基础设施的分工反过来。
  - 继续把边计入 `clean` 的代价是有日期的：目标仓的 adapter 一接入，第一个 nightly 就会出现约 37 条边的台阶，读报告的人多半判定 nightly 坏了；此后每次正常的调用点增删都会重复这个误导。
  - 过渡期不是静默的：那个分组无条件打印，标题就写着「currently the ONLY place edge changes are visible; see issue #38」，读者不会以为边没被检查。

  目标仓侧仍需接线（不在本仓范围）：PR job 怎么取到 base commit 的 snapshot、怎么在 CI 里跑 diff、怎么发 PR 评论。

## 0.7.0

### Minor Changes

- e1af82a: `codeontic topology --compare-edges` 第四次修正对账口径：拿真实数据继续验证，发现上一轮修法（`observableTargetKinds`）解决了"分母灌水导致误导性低百分比"的问题后，产出了一个方向相反、同样误导的新问题；另修一处统计精度问题。

  **问题：小样本算出来的百分比一样会误导，只是方向反了。** `observableTargetKinds` 正确把分母从被灌水的 19 条缩小到 1 条之后，`staticCoverage` 变成了 `1/1 = 100%`——这个数字看起来跟一个真实满分完全一样，但样本量为 1 不携带任何统计意义上的信息。这和分母为 0 时的 "n/a" 处理是同一个原则，只是把边界从 0 推到一个小样本阈值：新增内部常量 `MIN_COVERAGE_SAMPLE = 5`（不开放调用方配置），分母非零但小于这个阈值时，`staticCoverage` 仍然是 `null`（`staticCoverageNaReason` 换成"可比样本过小"的说明），但渲染层/CLI 这时候展示的是**原始计数**（`confirmed/denominator`，不带百分号），既不是裸的 "n/a"（分母确实存在），也不是一个装作有代表性的百分比。`staticCoverageNaReason` 的原因枚举从 5 选 1 扩成 6 选 1。

  **新增字段 `TopologyEdgeDiffSummary.targetKindsUncheckable`**：统计"已经声明了 `observableTargetKinds`、来源组件也确实在 `observableComponents` 范围内、但因为适配器没给目标标注 `toKind` 而这个轴实际没能生效"的边数——只在这个组合条件下才计数（来源本来就不在范围内的边，不管目标有没有标注都会是 `unobservable`，声明的目标类型范围对它压根没机会起作用，不该被算进"声明未覆盖"里）。渲染层/CLI 新增一条独立警告，只在"已声明 + 计数 > 0"时出现，提醒调用方"你声明的范围没有覆盖到所有边，不是声明本身有问题，是适配器没给这些目标标类型"。

  `--compare-edges` 不传时零行为差异；不碰 `src/schema/model.ts`，不新增 model node kind，不 bump `ADAPTER_INTERFACE_VERSION`。

- e1af82a: `codeontic topology --compare-edges` 再次修正对账口径：拿到真实线上 trace 数据后发现两个新问题，都要求重新设计而不是小修小补。

  **问题 1：队列中介的边不该被硬凑成 confirmed 或 static-only。** 真实数据显示两个服务只通过队列通信（生产者发消息、消费者独立消费，从无直接调用）。队列的消费者侧通常是 `deps.boss.work(deps.queueName, handler)` 这种间接调用，队列名是运行时变量，静态提取器原理上无法把生产者和消费者配对成一条逻辑边（按队列名硬配对会在从不通信的组件间捏造假边，这条路线已调研并放弃）。现在新增独立的 **`queue-mediated`** 类别：观测边只要自带 `viaQueue: true` 或 `kind: "consumer"`，直接归这一类，完全不参与配对/比较——即使某个静态边恰好和这个 (source,target) 对同名，也不会被误报成 `confirmed`。

  **问题 2：覆盖率公式本身在"暗示静态是基准答案"。** 老公式 `confirmed ÷ observedTotal`（观测到的去重边总数）把观测边当成被比较的分母，隐含"静态提取器说的算数,观测数据只是用来验证"。现在改成 `confirmed ÷ (confirmed + staticOnly)`——静态提取和线上观测被当作两个同等地位、各有盲区的事实来源，这个数只回答"静态提取到的、且理论上可直接比较的边里，有多少条被观测证实了"。`unobservable`（遥测到不了采集端）和 `queue-mediated`（能看见但没法配对）都被排除在分子分母之外，但排除的**原因不同**，输出里分别说明，不合并成笼统的"其他"。

  **分母为 0 时**新增 `staticCoverageNaReason` 字段，给出三选一的具体原因（① 静态本身没边；② 可观测范围未声明，保守默认下所有静态边归 unobservable；③ 声明了但没覆盖到任何有静态边的来源组件），CLI 和 HTML 渲染都会显示这个原因，不再是裸的 "n/a"。

  **新增字段（每条边）**：

  - `origin: "static" | "observed" | "both"` —— 从 `category` 派生，把观测边从"只用来对账的输入"提升为和静态事实并列的第二事实来源，图上每条边都能看出来自哪一侧。
  - `observedOnlyKnownEndpoints: boolean`（仅 `observed-only` 边）—— 区分"两端在静态侧都已知，只是这条边本身没提取到"（提取器盲区）vs "至少一端是静态词表压根没见过的东西"（全新依赖，声明缺口，比如线上 trace 发现的配置服务/CAS/目标仓 B 这类静态完全未建模的外部依赖）。
  - `queueStaticEvidence: boolean`（仅 `queue-mediated` 边）—— 非权威辅助佐证：该 pair 两端组件是否各自有一条指向 `toKind==="queue"` 节点的静态边。不参与分类判断，false 不代表配对错误。

  **`--compare-edges` 文件 schema 再次放宽**（仍是 `.strict()`，不是 `.passthrough()`）：真实 trace 导出的行比 `{from,to}` 骨架丰富得多，新增可选字段 `viaQueue`/`kind`（驱动 queue-mediated 判定）、`edgeKind`/`rawHosts`/`spanName`/`operation`/`count`/`sampleTraceIds`（纯诊断性，不参与任何分类逻辑）。

  **`config/components.ts` 新增可选字段 `otelService?: string`**（声明该组件在 OTel 里叫什么——组件 id 与 OTel service name 不一致的场景）。纯声明性，引擎不读取/不解释这个值——替代之前只活在外部导出脚本里、容易随组件改名脱节的隐式映射。

  HTML 渲染新增第 5 类图例（`queue-mediated`，棕色虚线）+ 独立的"观测数据为空"警告横幅（和"未声明可观测范围"警告分开，两者触发条件不同）；CLI 输出同步新增 `queue-mediated` 计数、新覆盖率公式的分母、n/a 原因文案。

  `--compare-edges` 不传时零行为差异；不碰 `src/schema/model.ts`，不新增 model node kind，不 bump `ADAPTER_INTERFACE_VERSION`。

- e1af82a: `codeontic topology --compare-edges` 第三次修正对账口径：拿真实观测边（服务间队列消费边 + 出站 HTTP 边）跑通全流程后，暴露两个新问题、加一处防御性加固。

  **问题 1：指向外部依赖的静态边被系统性误判成"死路径"。** 观测边的采集方法本质是"抓 HTTP client span 的目标主机"，这种方法结构性地看不到直连数据库/队列这类非 HTTP 协议的调用——不管这条边是不是真的在跑，都不可能出现在观测数据里。之前只有一条可观测性声明（`observableComponents`，判断来源组件的遥测是否可信），现在新增第二条：**`observableTargetKinds`**（`toKind` 值数组，比如 `datastore`/`objectstore`/`external`/`service`，判断这次的观测方法能不能看到某种目标类型）。一条静态边要同时满足"来源在 `observableComponents` 范围内"和"目标类型在 `observableTargetKinds` 范围内"才能进入 `static-only`；任一轴失败都归 `unobservable`，失败原因记在每条边新增的 `unobservableReason: "source" | "target-kind" | "both"` 字段上（桶数量不变，仍是 5 类，原因分开记在边级字段，不是新开桶）。**边界情况**：如果静态提取器压根没给某个目标标注 `toKind`，这个新轴不生效（没有证据可以拿来不信任），只对适配器明确标注了 `toKind` 的目标才会真的排除——避免悄悄改变所有从未采用 `toKind` 的旧适配器/测试的既有行为。

  `staticCoverageNaReason`（分母为 0 时的原因说明）现在按顺序检查 5 种情况（静态没有边 / 两条可观测性声明都没给 / 只给了一条 / 另一条没给 / 两条都给了但没覆盖到任何静态边），而不是原来的 3 种。

  **问题 2：观测侧和静态侧对同一个真实依赖用了不同 id，导致同一条边被同时误报"全新未知依赖"和"死路径"。** 例如观测导出用主机名短名 `sandbox`，静态适配器用 `internal-sandbox`——同一个依赖被拆成两条互相矛盾的信号。新增 `TopologyEdgeDiff.nameSimilarityHints`：只在 `observed-only` 目标 id 和 `static-only` 目标 id 之间做**大小写不敏感的子串包含检测**（不用编辑距离——短 id 上假阳性太多；不做任何自动合并——手工别名表本身就是这套机制要消灭的东西，猜错了会静默隐藏真实差异），命中就在渲染的 HTML 和 CLI 输出里提示"这两个名字很像，可能是同一个依赖叫法不同，需要你确认"，两个 id 依然各自作为独立节点存在。

  **加固：自环边防御。** 观测数据采集方法在极端情况下会把浏览器请求自己域名的 RUM span 误判成"服务调用自己"。现在静态侧和观测侧的自环边（`source === target`）在对账开始前就被排除，计入新字段 `TopologyEdgeDiff.selfLoopEdgesExcluded`，不进任何桶。静态侧这类 bug 的真实实例已经在适配器层修过（读自己环境变量当出站调用），这里是纵深防御。

  HTML 渲染新增 3 条横幅（target-kinds 未声明警告、自环排除提示、命名相似提示）；CLI 输出同步新增对应行。`--compare-edges` 不传时零行为差异；不碰 `src/schema/model.ts`，不新增 model node kind，不 bump `ADAPTER_INTERFACE_VERSION`。

- e1af82a: `codeontic topology --compare-edges` 修正对账口径：真实线上 trace 验证后发现，静态提取但观测里没出现的边（原 `static-only` 桶）会把"这个组件的遥测本来就上报不到采集端"和"这条边真的是死路径"混为一谈，是一种信号谎报自己成因的失效。

  现在拆出第 4 类 `unobservable`：`--compare-edges` 文件可以声明 `observableComponents`（哪些组件的 trace 是可信的），只有边的来源组件在这个范围内、观测里仍然没出现，才判 `static-only`（真实的死路径/未测路径信号）；范围外的一律判 `unobservable`（不代表死路径，只是看不见）。**未声明 `observableComponents` 时默认全部保守归为 `unobservable`**，绝不默认"全部可观测"——那正是这次真实数据暴露出的错误默认值。

  **破坏性变更**：`--compare-edges` 文件的顶层形状从裸数组 `[{from,to}]` 改成对象 `{observableComponents?: string[], edges: {from,to}[]}`（该功能刚合并几小时就被真实数据推翻了旧形状，尚无真实消费者，故不做双格式兼容）。HTML 渲染新增第 4 类图例（紫色点线）+ 未声明可观测范围时的显式警告横幅；CLI 输出新增 `unobservable` 计数和对应警告行。`staticCoverage`（confirmed÷ 观测边总数）公式本身不受影响。

- a93165b: `codeontic topology` 新增 `--compare-edges <file.json>`：把提取器自己算出的边（不是新增一份手写的模型边声明）与一份调用方提供的「观测到的边」列表（`[{from, to}]`，来源不限——OTel trace、服务网格日志皆可，引擎对此零感知）做双向对账，分出「双向确认 / 仅静态提取 / 仅观测到」三类，并打印出这次 PR 存在的核心理由——静态覆盖率（confirmed ÷ 观测边总数）。观测文件损坏时响亮报错（从不静默当空列表），观测边引用的未知 id 会诚实降级为一个新节点而不是被丢弃或崩溃。不传该 flag 时行为与之前完全一致。
- a7b0852: `snapshot` 的 drift 判定新增拓扑边（(from, to) 粒度）比较，计入 `clean`：一个调用点（`outbound_edge`/`dependency_client`）在同一组件内换文件不再算漂移，但一个组件首次调用一个新目标会被正确识别为架构漂移。拓扑事实相应地不再重复喂给按调用点粒度比较的 `addedFacts`/`removedFacts`。`SNAPSHOT_SCHEMA_VERSION` 2→3。

  `.codeontic/config.json` 的 `components` 配置损坏（如 `role` 拼错）时，`topologyEdges` 记为 `null`（区别于「真的零条边」的 `[]`）并带上 `topologyEdgesUnavailable` 原因；`diffSnapshots` 遇到任一侧不可用会跳过边比较而不是把它当成"全删了"，`clean` 不因此判 false，`renderDrift` 会无条件打印一行说明跳过原因——一次真实的配置手误（`frontend` 拼成 `frontEnd`）曾让 36 条边的报告变成 43 条边改动、且完全没说明原因，此修复堵住了这个假阳性。

### Patch Changes

- e1af82a: `--compare-edges` 文件的 schema 放行 `_` 前缀的注释键，其余字段仍然严格校验。

  JSON 没有注释语法，但这份文件恰恰最需要记录"为什么这么配"——比如 `observableTargetKinds` 为什么只声明了 `service`/`objectstore`/`external` 三类、没有 `datastore`。之前的 `.strict()` 会把任何这类批注（比如 `_observableTargetKindsNote`）当成拼写错误一起拒收，逼着这类说明只能写在文件之外，容易和实际配置脱节。

  现在顶层对象里以 `_` 开头的键（例如 `_note`、`_observableTargetKindsNote`）会被当作注释接受、并在解析结果里被丢弃（引擎从不读取它们）；其它未声明的键依然响亮报错——严格性该抓的是拼写错误，不是有意的批注。这个约定和 `.codeontic/config.json` 已有的 `_comment`/`_components` 前缀注释是同一套。

  范围仅限文件顶层对象（`observableComponents`/`observableTargetKinds`/`edges` 之外的层级）；`edges` 数组里每一行的 schema 未改动，仍是纯 `.strict()`，不接受逐行注释。

## 0.6.0

### Minor Changes

- 0d88d17: 新增 `codeontic backtest` 命令（判据 A + 判据 C 产品化，issue #23 阶段 1）：

  - **判据 A**：回测最近 N 个改动 `.ts`/`.tsx` 的提交里,有多少命中了模型锚定的文件——衡量"人真正在改的地方,模型有没有话说"，与 `codeontic coverage`（模型侧：模型本身锚了多少）是互补但不同的两个数字。按 `.codeontic/config.json` 的 `components` 分两层输出：**按角色**(frontend/api/worker/sandbox/library)和**按组件**(各 app)，两层各自的行可能重叠计数(一个提交同时命中两个角色/组件时两边都计入)，不能横向求和。
  - **判据 C**：节点数(loop+flow+junction，dormant loop 单独标出)÷ 模型锚定的覆盖文件数，越接近 1:1 说明模型越像"目录列表"而非真正抽象——防止判据 A 被"灌节点"刷高。判据 C 只依赖模型，不需要 git，即使判据 A 的 git 侧失败(坏 ref、非 git 仓库)也依然可读。

  支持 `--window`/`--ref`/`--json`，并把两个判据的读数都并入 `codeontic snapshot` 的 nightly 产物（`SNAPSHOT_SCHEMA_VERSION` 因此从 1 升到 2，旧 artifact 会被版本门禁挡住而不是崩溃）；drift 里判据 A 展示但不计入 `clean`(窗口天然逐夜漂移)，判据 C 计入 `clean`(只在模型真的变化时才变)。

- b7566e2: `codeontic backtest` 现在会在 `anchoredFileCount` 旁边打印模型本身所在的 git ref（`--json` 里也带上 `modelRef: {head, dirty}`）：`--ref` 只钉住扫描的提交窗口，模型永远读磁盘当前状态，两个不同 checkout（或一个带未提交改动的 checkout）跑同一个 `--ref` 完全可能报出不同的 `anchoredFileCount`/判据 C 读数——这条 ref 是让这个差异可解释、而不是看起来像坏了的关键信息。另外修了 `renderSnapshotSummary` 里判据 C 分子与展示的比值不一致的 bug（`nodes.total` 误用成了显示分子，实际比值算的是 `nodes.anchored`），并把 `coverageRatioDelta` 的 drift 追踪从只看 `nodesTotal` 扩到同时看 `nodesAnchored`——只给已有节点补锚点（本计划下一步的健康动作，`nodesTotal` 不变）现在也会正确地被判定为 target drift。
- 6f4c7e7: 新增 `.codeontic/config.json` 的 `components` 段：目标仓声明自己的组件（id / label / role / paths），引擎据此把文件归属到组件。这是覆盖率分区报告与拓扑图节点入口类型标注的共同底座——两者都需要「这个文件属于哪个单元」，而硬编码 `apps/*` 会把一个目标仓的目录结构烧进声称零目标知识的引擎里。未声明即不分区，绝不猜测。
- 1e21d7e: adapter 新增可选 `reconcilableSignalKinds`：声明「reconcile 这个检查是关于哪些信号种类的」。不声明 = 全部（既有 adapter 行为不变）。

  起因是一个只有组合起来才暴露的问题：当一个 adapter 除了队列/轮询这类**可注册的后台单元**之外，还开始发拓扑边、依赖客户端这类**另一种性质**的事实时，后者会全部落进 `unregistered`——因为根本没有模型节点该去「注册」一条出站边。实测：6 条真正未注册的事实在拓扑提取器上线后变成 69 条，模型被引导所依据的那个数字瞬间 90% 是噪音。而一个到处喊狼来了的建议性检查，很快就没人看了。

  被排除的事实**照常提取、照常参与 `topology`**，只是不再被 reconcile 声称在管；排除了多少条会显式打印，绝不静默缩小分母。

- 6b6af35: reconcile 现在会跟随一跳委托解析（沿用 `#20` 的 `delegation.ts`）：当一个活跃 Loop 的锚点符号只是把实现转发给另一个对象的方法时，落在委托目标自身符号行区间内的实现事实也会被判定为 registered（严格锚定符号级粒度，不是文件级——避免把整个目标文件都算作已注册）。同时补齐可观测性：`checkLoopMechanism` 在通过委托验证时输出 `severity: "info"` 的 Violation（此前静默通过、和"检查未运行"无法区分），`Reconciliation` 新增 `delegationHits` 字段记录每次委托跳转及其注册的事实数，CLI `reconcile` 命令打印这些跳转并新增 `--no-follow-delegation` 开关用于两面验证。默认行为对已有调用方零影响（不传新参数即不启用委托跟随）。
- 727c3de: （追溯记录）锚点精度 —— 格式与存在性（#20，2026-07-26 合入）：锚点格式接受 Next.js 路由组与动态段（`(portal)` / `[id]`），并新增锚点符号的存在性校验。

  补记原因见下一条。

- 727c3de: （追溯记录）`Flow.shape` 显式化 + 派生判断集中化（#25，2026-07-26 合入）：Flow 同时承载「组合视图」与「持有实现的执行单元」两种语义，此前没有字段声明是哪一种，引擎靠 `anchors.length` 在每个消费者处各自推断一次——漏一个就错一个。现在 `shape` 是显式字段，推断收敛到一处。

  **向后兼容，故为 minor 而非 major**：`shape` 是可选字段，未声明时仍按原规则派生（`flow.shape ?? (anchors.length > 0 ? "anchored" : "composed")`），旧推断路径完整保留。既有模型无需改动。

  补记原因同 `mechanism` 那条：#25 合入时同样未带 changeset，故未发布，与 #20 一起随本版本首次到达 npm。

- 727c3de: （追溯记录）机制交叉校验：`Loop.mechanism` + 一跳委托追踪（#20，2026-07-26 合入）。Loop 可声明 `mechanism: [poller|queue]`，引擎拿适配器提取的实现事实去核对它；当锚点符号只剩一行转发时，能跟随**一跳委托**找到行为真正搬去的文件与符号，并要求事实落在该符号的行区间内才算数。

  关掉的缺口：巨石拆分后，入口点还在、符号还在，只有**行为**搬走了——文件级和符号级校验全绿，而模型指着一个空壳。

  **补记这两条的原因**：#20 合入时没有带 changeset，因此代码进了 `main` 却从未发布——目标仓 CI 跑的 `codeontic@latest` 一直停在 0.5.1。这个缺口本身就是 `mechanism` 要消灭的那类失效：它是新增字段，而 Loop schema 不是 `.strict()`（已核实 `src/schema/model.ts` 中无任何 `.strict()`），所以在 0.5.1 下声明它会被 zod **静默剥掉**，检查不跑、也不报错。

  **升级提示**：如果你已经在模型里写了 `mechanism` 却没看到任何效果，那不是你写错了——是它此前根本没有到达 npm。升级到本版本后这些声明会**开始真正生效**，可能因此浮出一批此前被静默吞掉的告警。这是预期行为，不是回归。

- abcf141: 新增 `codeontic topology` 命令：从声明的 `components` 配置 + 事实的 `topology` 提示（`ImplementationFact.topology: {to, toKind, via}`，additive，不动 schema、不加模型节点种类）纯渲染一张自包含的 HTML 架构图。节点按声明的入口类型（frontend / api / worker / sandbox / library）标注，外部依赖单独成节点，文件匹配不到任何声明组件的事实归入显式的「未归属」桶而不是被丢弃。`Adapter` 接口新增可选字段 `topologyCoverageNote`，供 adapter 说明自己的覆盖率边界，供页面显示；未提供时展示通用的诚实兜底文案，绝不假装图是完整的。

### Patch Changes

- 042431d: 修 `snapshot` 摘要行里判据 C 片段自相矛盾：它打印的分子是「声明的节点总数」，而比值是用「有锚点的节点数」算的，于是出现 `C 82/40=0.85`（82/40 实为 2.05）。读者按打印的数字自己除一遍会得到另一个答案，且无从判断哪一半错了——一个自相矛盾的摘要比没有摘要更糟。现在打印 `C 34/40=0.85`。

## 0.5.1

### Patch Changes

- a9101ae: 修复发版流程中一个静默失败：tsc 的 incremental 构建信息原本落在项目根目录，`rm -rf dist` 不会动它，于是下一次 build 认定一切都是最新的、不产出任何文件并以退出码 0 成功返回。而 `npm publish` 自身不跑构建、直接打包当前 `dist/`，两者组合会发出一个空包，且全流程绿灯。

  现在 `tsBuildInfoFile` 指向 `dist/.tsbuildinfo`，让构建产物与"已构建"的记忆同生共死；`prepublishOnly` 追加一道 clean build + 入口点校验作为兜底（`dist/.tsbuildinfo` 已排除出发布包）。

  同时首次为本仓接入 CI 与自动发版：PR/push 走 typecheck + lint + build + verify + test，main 上由 changesets 开版本 PR、合并即发布（npm Trusted Publishing，不使用长期 token）。
