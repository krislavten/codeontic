# 发版

发布由 CI 完成。本地不跑 `npm publish`，也不需要 npm token 或 OTP。

## 日常：改动附一个 changeset

改动会影响使用者时，在 PR 里带一个 changeset：

```bash
pnpm changeset
```

它会问改动级别（本仓在 0.x，`patch` 与 `minor` 的实际含义见下）和一句说明，生成
`.changeset/<随机名>.md`。这个文件要一起提交——它就是这次改动在 CHANGELOG 里的措辞，
写给读发布日志的人看，不是写给 reviewer 看的。

纯 CI/文档/重构可以不写。**代价是没有 changeset 就不会发版**，而且是安静地不发：
流水线全绿、什么都不发生。改了使用者能感知的东西时别忘。

### 0.x 下的级别怎么选

- `minor` — 破坏性变更。adapter 接口版本变了、CLI 行为或输出契约变了、
  已有用法需要改才能继续工作。（1.0 之前 `major` 不用。）
- `patch` — 其它一切：新功能、修复、性能。

这是本仓已有的节奏：0.3.0→0.4.0 移除全部内置 adapter、0.4.0→0.5.0 adapter 接口
v1→v2，都是破坏性变更走 minor。

## 发布：合并版本 PR

changeset 进 main 后，Release workflow 会开一个 **"chore: version packages"** PR，
里面是版本号和 CHANGELOG 的改动。

**合并它就会发布**——CI 重跑一遍 typecheck/lint/build/test，然后 publish 到 npm。

也就是说发版是一次独立的、可 review 的动作：想攒几个改动一起发，就先不合那个 PR，
它会随后续 changeset 自动更新。

## 认证

用 npm **Trusted Publishing**（OIDC）：npm 直接信任来自本仓 `release.yml` 的
GitHub Actions 身份，仓库里不存任何长期凭据，也没有会过期的 token。
发布产物自带 provenance signature。

配置在 npmjs.com 的包设置里（Trusted Publisher：仓库 `krislavten/codeontic`
+ workflow `release.yml`），改 workflow 文件名要同步改那里。

## 为什么 `prepublishOnly` 要做 clean build

`npm publish` 自己不跑构建，直接打包当前 `dist/`。曾经踩过一次：tsc 的 incremental
构建信息落在项目根目录，`rm -rf dist` 不会动它，于是下一次 build 认定一切最新、
**不产出任何文件并以退出码 0 成功返回**——组合起来会发出一个空包，且全程绿灯。

现在两道防线：

1. `tsBuildInfoFile` 指向 `dist/.tsbuildinfo`，让构建产物和"已构建"的记忆同生共死
   （见 `tsconfig.build.json` 里的注释——别把它移回默认位置）
2. `prepublishOnly` 做 clean build + `scripts/verify-dist.mjs` 校验 package.json
   声明的每个入口点真实存在且非空

第 2 条是兜底，防的是同一形状的失败换个来源再出现。它有测试
（`test/verify-dist.test.ts`），因为一个没人测过的守卫等于没人知道它还在不在。
