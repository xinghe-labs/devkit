# 贡献指南（Contributing）

谢谢愿意帮这个项目。devkit 是一个**会改用户机器**的工具 —— 它写 PATH、环境变量、
注册表，还走提权。所以这里的规矩比一般项目严一点，都是为了让改动**可验证、可回退**。

## 提交 issue 前

- 尽量用 [bug 模板](https://github.com/xinghe-labs/devkit/issues/new?template=bug_report.yml) ——
  里面的「这台机器的状态」一项最关键：在**全新 Windows** 上的失败案例价值最高
  （那正是本项目还没验收过的核心场景）
- 日志在 `%APPDATA%\devkit\logs\`；介意里面有本地路径的话，先自己替换再贴

## 本地开发

```bash
pnpm install        # Node 22+
pnpm dev            # 开发模式跑起来
pnpm typecheck      # 三份 tsconfig：主进程 / 渲染进程 / 测试
pnpm lint
pnpm test           # vitest，当前 44 文件 / 541 用例
pnpm build          # 三端产物
pnpm dist           # NSIS + portable 安装包（release/ 目录）
```

## 提交 PR 的门槛

CI 会跑：manifest 校验 → typecheck（三份配置）→ lint → 单测 → 打包冒烟。
本地先跑一遍，绿了再推：

```bash
pnpm manifest:check && pnpm typecheck && pnpm lint && pnpm test
```

提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/)：
`feat:` / `fix:` / `docs:` / `chore:` / `test:`。

## 这个项目的几条硬规矩（PR 审查会按这个来）

这些不是风格偏好，是从真实事故里长出来的规则，SPEC §13 有完整决策表：

1. **同一份知识只能有一处实现。**
   本项目出过一次确定性 bug：下载缓存的文件名规则在 `executor` 与 `offline`
   各写了一份且不一致，导致离线安装 VS Code 必然失败。改规则时先找它住在哪。

2. **写操作必须：先备份 → 写完复验 → 危险结果拒绝执行。**
   凡是改 PATH、环境变量、注册表的代码，这三条缺一条就不该合并。
   参考已有实现：`core/doctor/fix.ts`、`core/systemconfig/`、`core/activate/`。

3. **文档里的「✅ 已完成」必须是真的。**
   本项目修过四处虚假声明（`devkit` CLI、FR-15 自动拉取等）。
   没实现就写没实现，宁可标 🟡 也别标 ✅。

4. **清单是数据，不是代码。**
   `resources/manifest/tools/*.json` 里不能出现任意命令；安装方式只能引用
   `src/main/core/templates/index.ts` 里注册过的模板。新增工具跑
   `pnpm manifest:refresh <id>`，并附官方下载页链接与该版本 SHA-256。

5. **零遥测是承诺。**
   任何把数据发往网络的代码（除非用户显式发起的下载/更新）都不该出现。

6. **读不到原值就不改。**
   改注册表/环境变量前如果拿不到原值，宁可拒绝 —— 备份不了的东西没有还原路径。

## 新增一个软件清单

```bash
# 1. 在 scripts/refresh-manifests.ts 的 TOOL_SPECS 里加一个 spec
# 2. 生成清单（会自动下载并计算 SHA-256）
pnpm manifest:refresh <工具id>
# 3. 校验
pnpm manifest:check
```

清单必须包含：真实 SHA-256、至少 1 个镜像、detect 规则、verify 规则、
`installScope`、`license`、以及**隐藏前置依赖**（`dependsOn` —— 例如 Maven 要 JDK、
npm 类工具要 Node.js，漏了预检就拦不住）。

## 测试

- 新增**会写用户机器**的代码时，必须先写"拒绝规则"的测试（读不到就不改 /
  没有备份不还原 / 空值拒绝），而不是只测 happy path
- i18n：新 UI 文案要同时加进 `zh-CN.json` 与 `en-US.json`，
  `src/renderer/src/i18n/i18n.test.ts` 会自动检查缺漏
- 测试不能依赖系统语言、时区、已装软件或网络（CI 是英文 Windows）
