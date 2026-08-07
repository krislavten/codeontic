# 参与贡献

## 本地门禁 —— 按 CI 的真实顺序跑

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm run build:clean     # 必须在 test 之前
pnpm run verify:dist
pnpm test
```

**`build:clean` 必须排在 `test` 前面。** 有一个测试要走查构建出来的 `dist/`，证明发布包里
没有泄漏目标仓库的业务标识符——`dist/` 不存在它就没法查。新 clone 之后直接 `pnpm test`
会看到且只会看到一个失败：`the built dist/ leaks no target-repo business
identifiers`，报 `ENOENT … /dist`。那是缺构建，不是真缺陷。build 完重跑即可。

## Stacked PR —— 一个已修的坑，一个仍需人判断的坑

stacked PR（base 指向另一个 PR 的分支而非 `main`）有时是对的形状：它让评审可以否决一个
架构决策，而不连带丢掉底下那些不依赖该决策的修复。这个仓库允许这么做，但历史上它有两个
**不报错**的陷阱。

### 坑一：CI 不跑 —— 已在基础设施层修掉

`.github/workflows/ci.yml` 曾经只对 `pull_request: branches: [main]` 触发，于是 base 不是
main 的 PR **完全没有检查**——不是失败，是静默，而静默看起来很像通过。

现已改为对所有 `pull_request` 触发。**这条不再需要你记住。** 留在这里只作为背景：如果哪天
又看到某个 PR 没有 checks，先怀疑 trigger 被改窄了。

### 坑二：squash 合并 base，会把子 PR 送到别处 —— 仍需你判断

squash 合并会把一个分支压成 `main` 上的一个新 commit。**原分支从此不再是 `main` 的祖先**
——尽管内容一模一样，git 看不出任何关系。

所以如果你 squash 合并了 base PR，接着再合子 PR：

- 子 PR 合进的是**它自己的 base 分支**，而那个分支刚刚与 `main` 脱钩
- GitHub 把子 PR 标为 **MERGED**——这是准确的，它确实合并了，只是没合到 `main`
- `main` 永远收不到子 PR 的代码，且**没有任何地方报告异常**

#24 就是这么丢的：状态显示 `MERGED`，而它的代码（`Flow.shape`、放宽后的 `FlowId`、
agent-kit 发现指令更新、`test/anchor-fanout.test.ts`）根本不在 `main` 上。是靠 grep `main`
找一个本该存在的符号才发现的，随后由 #25 重放增量补上。

**合并 stack 之前三选一：**

1. **base 用 merge commit**（`gh pr merge <base> --merge`）——最省事。base 分支保持为
   `main` 的祖先，GitHub 会干净地把子 PR retarget 过去，之后子 PR 正常合入 `main`。
2. **先拆 stack**：把子 PR rebase 到 `main` 上、变成一个独立的普通 PR，然后两个各自合并。
   base 想用 squash 就用 squash。
3. **squash base，然后手动 retarget**：`gh pr edit <child> --base main`，并在合并前确认
   diff 里只剩子 PR 自己的改动。三种里最依赖人不忘事，非必要不选。

CI 现在会在 PR 页面给出一条 stacked 警告（不阻断，因为 stacked 本身是合法的）。

**按内容验证，不要按状态验证。** 合并完一个 stack 之后，确认只有子 PR 引入的东西确实到了
`main`：

```bash
git fetch origin && git show origin/main:path/to/file | grep <子PR新增的符号>
```

`MERGED` 徽章不构成代码已到达 `main` 的证据。

## 新增一个携带代码锚点的字段

锚点（`path#symbol`）有很多消费者。往 schema 加一个新的锚点字段、却只接进其中一部分，正是
`Flow.anchors` 当初的翻车方式——发布时只连了约 8 个消费者里的 2 个，产生 6 个用户可见缺陷：
`reconcile` 假阳性、`evidence` 对已锚定节点报 `0 anchor(s)`、履约着色图与自己的 headline
互相矛盾，等等。

`test/anchor-fanout.test.ts` 就是为防复发而存在的。它持有一份 `ANCHOR_SOURCES` 清单，枚举
每个能携带锚点的 schema 字段，并逐一断言它到达了每个消费者。**把你的新字段加进那份清单**，
失败项会直接告诉你还有哪些没接。为了让套件变绿而删掉清单里的一行，等于把这个机制整个废掉。

id → id 这类引用型字段的对应契约在 `src/validate/checks.ts` 的 `collectReferences`，
它的文档注释里有同样的告诫。

## 派生判断只定义一处

如果两个层都需要对模型节点做同一个判断，就把它定义一次——放在 schema 旁边——然后各自 import。
第二份拷贝正是两者开始分歧的起点。`src/schema/model.ts` 里的 `flowShape()` /
`isGradedFlow()` 是现成的例子：conformance 用它们决定一个节点是否参与评级，`check` 用它们
对这个决定所丢弃的东西发出警告。若各持一份，警告就会对着错误的节点响、或者对该响的保持沉默。

## changesets

发布走 [changesets](https://github.com/changesets/changesets)。影响已发布包的改动需要加一条：

```bash
pnpm changeset
```

纯文档、纯测试的改动不需要。

## 模型改动

确定性门禁是唯一会让 PR 失败的东西，它永不调用 LLM、不碰网络、不执行你的代码：

```bash
codeontic check . --repo-root . --strict-anchors
```

发现（找出值得建模的行为）是 LLM 的活，且永远只产出草案。草案在维护者拿真实代码核实过它的
锚点之前不落库。
