# devkit

> 一键开发环境部署器 · One-click development environment deployer
>
> 在**一台什么都没装的 Windows 电脑**上，用图形界面勾选需要的东西，一键把开发环境**装好、配好、验好**。

[![CI](https://github.com/xinghe-labs/devkit/actions/workflows/ci.yml/badge.svg)](https://github.com/xinghe-labs/devkit/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

---

## 它解决什么问题

不是"下载安装包"——那件事 winget / Chocolatey / Scoop 已经做了。devkit 解决的是后面那三件事：

1. **不知道装哪个版本、装到哪、装完还要配什么**
2. **装完了但 PATH / 环境变量 / 镜像源没配**，跑不起来，或者慢得离谱
3. **装到一半失败**，不知道失败在哪、装了几成

所以 devkit 的核心是 **「安装 + 配置 + 自检」三件套的自动化**。

|                                                  | winget / Scoop | 一键环境包脚本 | devkit |
| ------------------------------------------------ | -------------- | -------------- | ------ |
| 图形界面                                         | ✗              | ✗              | ✓      |
| 可自由勾选                                       | 部分           | ✗              | ✓      |
| 预设方案（前端 / Java / Python / Go …）          | ✗              | 部分           | ✓      |
| 装完自动配置（镜像源 / PATH / git / SSH）        | ✗              | 部分           | ✓      |
| 安装后自检                                       | ✗              | ✗              | ✓      |
| 失败可定位、可续跑                               | ✗              | ✗              | ✓      |
| 多版本共存与切换                                 | 部分           | ✗              | ✓      |
| 卸载只删自己装的东西                             | ✗              | ✗              | ✓      |
| 离线包                                           | ✗              | ✗              | ✓      |
| 镜像源一键配置（npm/pip/Go/Maven/Gradle/cargo/conda/NuGet/Docker） | ✗ | 部分 | ✓ |
| VS Code 插件推荐与一键安装                       | ✗              | ✗              | ✓      |
| AI 编码 agent 安装（Claude Code / Codex / …）    | ✗              | 部分           | ✓      |

---

## 当前状态

**M0 / M1a / M1b / M2 / M3 / M4 的主体功能已完成**，可以在真机上完整走完
「选预设 → 预检 → 下载 → 安装 → 激活 → 自检 → 报告 → 卸载」的全流程。

| 里程碑 | 内容                                                          | 状态                            |
| ------ | ------------------------------------------------------------- | ------------------------------- |
| M0     | 骨架：窗口 + 清单加载与校验 + 真实环境检测 + i18n             | ✅ 已完成                       |
| M1a    | 端到端：预检 → 下载 → 校验 → 解压安装 → 自检 → 报告           | ✅ 已完成                       |
| M1b    | 系统级安装：MSI/EXE 静默安装 + 常驻提权助手 + 还原点           | ✅ 已实现（需虚拟机验收 UAC）   |
| M2     | 清单 19 项、预设、镜像源、系统配置、卸载、报告导出            | ✅ 已完成                       |
| M3     | 多版本共存与切换、离线包、并发调度（≤3）                      | ✅ 已完成                       |
| M4     | NSIS + portable 双产物、CI/发布流水线、更新检查、文档         | ✅ 已完成（自动更新为提示式）   |

### 关键设计：安装 ≠ 激活

安装只把文件放进 `%USERPROFILE%\.devkit\versions\<tool>\<version>\`，
**不改 PATH、不写 Program Files、不需要管理员**。

只有用户（或"安装后自动激活"开关）明确要求时，才会把这份安装接到环境里：

```
%USERPROFILE%\.devkit\current\<tool>   ← junction，指向当前激活的版本
                     ↑
  用户 PATH 里加的是 %DEVKIT_HOME%\current\<tool>
```

切版本 = 只改 junction 指向。改 PATH 前会把原文备份到 `%APPDATA%\devkit\backup\`，
激活记录写在 `%APPDATA%\devkit\activated.json`，取消激活时按记录**精确移除**，
不靠"猜哪条 PATH 是脏数据"。

激活后会做一次**「新终端」验证**：用机器级 + 用户级 PATH 拼出一个新进程会看到的环境，
跑一次 `where` 和用户在终端里会敲的那条命令，确认命令确实能解析到 devkit 装的这份。
这一步是必要的 —— winget 的 PATH 相关 bug 几乎全是「写进去了但新终端还是找不到命令」。

> **PATH 收敛**：所有条目写成 `%DEVKIT_HOME%\current\<tool>`，而不是逐个写绝对路径。
> 十个工具就少几百字符，而且用户一眼能看出哪些条目是 devkit 管的。
> PATH 超过 2047 字符时会告警。
>
> **已知限制（重要）**：Windows 的进程 PATH 是「**机器级在前、用户级在后**」。
> 如果系统里已经装了同名工具且它在**机器级** PATH 里（例如 `D:\node`），
> 那么即使 devkit 把条目插在用户 PATH 最前面，新终端里敲 `node` 仍会跑到系统那份。
> devkit 会**在激活结果里如实告知**（“node 解析到了 D:\node\node.exe（不是 devkit 装的那份）
> …”），而不是给一个假阳性。要真正接管，需要卸掉系统里那一份，或者手动把 devkit 的
> 目录加到机器级 PATH（需要管理员）。这是 Windows 的 PATH 查找顺序决定的，不是实现问题。
>
> **禁用 `setx`**：`setx` 在 1024 字符处静默截断，而开发机的 PATH 经常远超这个长度。
> 改用注册表 `HKCU\Environment` 直接写 `REG_EXPAND_SZ`，并广播 `WM_SETTINGCHANGE`。

### 可安装清单（16 项）

真机验证过的安装模板（8 个里 6 个）：`zip-into-version-dir`（Node/Deno）、
`zip-single-file-into-version-dir`（pnpm/Ninja）、`exe-7zsfx-extract`（Git）、
`exe-python-silent`（Python）、`exe-inno-silent`（VS Code）。MSI 与 NSIS 需要管理员，
留待虚拟机验收。

| 工具              | 版本       | 安装方式                | 范围     |
| ----------------- | ---------- | ----------------------- | -------- |
| Node.js           | 24.20 / 24.21 | ZIP 解压             | 用户级   |
| Python            | 3.13.16 / 3.14.8 / 3.15.0 | 官方 exe 静默安装 | 用户级   |
| Go                | 1.27.2     | ZIP 解压                | 用户级   |
| Eclipse Temurin JDK | 17.0.20.1 / 21.0.12.1 | ZIP 解压    | 用户级   |
| Rust              | rustup     | rustup-init + CARGO_HOME | 用户级  |
| Apache Maven      | 3.10.0     | ZIP 解压                | 用户级   |
| Gradle            | 9.8.1      | ZIP 解压                | 用户级   |
| CMake             | 3.31.12    | ZIP 解压                | 用户级   |
| Ninja             | 1.13.2     | ZIP 单文件              | 用户级   |
| Git               | 2.56.0     | PortableGit 自解压      | 用户级   |
| pnpm              | 12.11.2    | ZIP 单文件              | 用户级   |
| Deno              | 2.9.7      | ZIP 解压                | 用户级   |
| Bun               | 1.4.3      | ZIP 解压                | 用户级   |
| SQLite            | 3.54.0     | ZIP 解压                | 用户级   |
| 7-Zip             | 26.04      | MSI 静默安装            | **机器级（需管理员）** |
| VS Code           | 1.141.0    | Inno Setup 静默安装     | 用户级   |

### AI 编码 agent（6 个）

| 工具 | 版本 | 发行方式 | 范围 |
| --- | --- | --- | --- |
| Claude Code | 2.1.296 | npm 包 → 装进版本目录 | 用户级 |
| Codex CLI | 0.162.1 | 官方独立二进制（zip） | 用户级 |
| OpenCode | 1.19.0 | 官方独立二进制（zip） | 用户级 |
| Gemini CLI | 0.63.0 | npm 包 → 装进版本目录 | 用户级 |
| GitHub Copilot CLI | 1.0.95 | npm 包 → 装进版本目录 | 用户级 |
| Qwen Code | 0.25.1 | npm 包 → 装进版本目录 | 用户级 |

**两种发行方式，供应链强度不同，必须说清楚：**

- **独立二进制**（Codex、OpenCode）：走「官方直链 + SHA-256」，与其它工具完全一致。
- **npm 包**（Claude Code、Gemini CLI、Copilot CLI、Qwen Code）：这些工具**只有 npm 发行物**。
  devkit 用 `npm install --global --prefix <版本目录>` 装进版本目录（**不污染你的全局 npm**），
  固定的是**顶层包 tarball 的版本与 SHA-256**；但 npm 在安装时仍会去 registry 解析该包的
  依赖与平台二进制 —— **这一部分不在 devkit 的校验范围内**。

  > 这不是猜测，是实测数字：`@anthropic-ai/claude-code` 顶层包只有 **29 KB**，
  > 但装完版本目录是 **249 MB** —— 多出来的可执行文件在平台专用可选依赖里，
  > 由 npm 在安装时下载。选之前请知悉这个差异。

安装 npm 类工具需要机器上有 Node.js（npm 随它一起提供）；devkit 会优先用它自己装过的
Node.js，其次才是 PATH 上的 npm。

另有 3 项仅支持检测（`detect-only`）：**WSL2**、**Docker Desktop**、**PostgreSQL** ——
它们的安装方式不适合"装进版本目录"（系统功能 / 需要重启 / 需要服务与密码），
**我们不给没验证过的安装信息，也不填占位数据**。

> 清单里的版本号、下载地址、SHA-256、体积全部由 `pnpm manifest:refresh` 从**官方渠道**取：
> 有官方 API 的直接取（Go、Adoptium、Gradle、VS Code、rustup），
> 有官方校验和文件的直接读（CMake、SQLite、Deno），
> 都没有的下载后本地计算（Python、Maven、Git、pnpm、Ninja、7-Zip）。

### 许可证分级

清单按**可再分发程度**分三级，直接决定能否进离线包：

| 级别   | 含义                             | 进离线包 | 例子                                                                           |
| ------ | -------------------------------- | -------- | ------------------------------------------------------------------------------ |
| **L1** | 许可证明确允许再分发             | ✅       | Node.js、Python、Git、7-Zip、CMake、Maven、PostgreSQL、Eclipse Temurin JDK、Go |
| **L2** | 可自动下载安装，但**不得再分发** | ❌       | Docker Desktop、VS Code、WSL2                                                  |
| **L3** | 仅跳转官网，不自动安装           | ❌       | 需要账号或序列号的商业软件                                                     |

具体说明：

- **不使用 Oracle JDK**：其 BCL 对再分发有限制，改用 **Eclipse Temurin**（GPLv2+CE）。
- **Docker Desktop** 受 Docker Subscription Service Agreement 约束，大企业/政府商业使用需付费订阅。本项目只引导官方下载，**不打包、不内置**。
- **VS Code** 源码是 MIT，但官方发行物走 Microsoft 产品许可，因此按 L2 处理。
- **Redis** 没有官方 Windows 原生版本，不会提供误导性的"Windows 原生 Redis"选项。

---

## 开发

### 环境要求

| 项       | 要求                               |
| -------- | ---------------------------------- |
| 操作系统 | Windows 10 22H2 (19045) x64 及以上 |
| Node.js  | ≥ 20（推荐 22 LTS）                |
| pnpm     | ≥ 9（`corepack enable`）           |

### 常用命令

```bash
pnpm install         # 安装依赖（.npmrc 已配好 Electron 国内镜像）
pnpm dev             # 开发模式，三端 HMR
pnpm typecheck       # 类型检查（主进程 + 渲染进程）
pnpm lint            # ESLint
pnpm test            # Vitest 单元测试
pnpm detect          # 在终端打印本机环境检测报告（不开界面，排查检测规则用）
pnpm install:tool    # 在终端真实安装一个工具（不开界面，排查安装失败用）
pnpm manifest:check  # 校验所有清单是否符合 JSON Schema
pnpm manifest:refresh # 从官方渠道刷新清单里的版本 / 地址 / SHA-256
pnpm build           # 构建（不打包）
pnpm dist            # 打包出 NSIS 安装版 + 便携版
```

排查界面问题：

```bash
# 启动后自动退出；渲染进程只要报过 error，退出码就是 1（界面白屏不会再算"成功"）
DEVKIT_SMOKE=1 DEVKIT_SMOKE_DELAY_MS=20000 node_modules/electron/dist/electron.exe .
```

> 若 `pnpm install` 卡在 Electron 下载：`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ pnpm install`

---

## 软件清单（manifest）

清单是纯数据，**新增一个软件 = 新增一个 JSON 文件，不需要改代码**。

位置：`resources/manifest/tools/<id>.json`，Schema 在 `resources/manifest/schema/tool.schema.json`。

```jsonc
{
  "id": "nodejs",
  "category": "runtime", // runtime | build | database | container | editor | tool
  "tier": "L1", // 许可证分级，决定能否进离线包
  "status": "ready", // detect-only | ready
  "name": { "zh-CN": "Node.js", "en-US": "Node.js" },
  "description": { "zh-CN": "…", "en-US": "…" },
  "detect": {
    "commands": [{ "cmd": "node", "args": ["-v"], "expectRegex": "v\\d+\\.\\d+" }],
    "files": ["%ProgramFiles%\\nodejs\\node.exe"]
  },
  "versions": [
    {
      "version": "24.21.0",
      "channel": "lts",
      "recommended": true,
      "arch": "x64",
      "installScope": "user",
      "source": { "url": "https://…", "sha256": "…" },
      "install": { "type": "zip", "template": "zip-into-version-dir", "params": { "stripComponents": "1" } },
      "activate": { "pathEntries": ["{currentDir}"], "env": {} },
      "verify": { "cmd": "{installDir}\\node.exe", "args": ["-v"], "expectRegex": "v24\\." }
    }
  ]
}
```

### 三条硬性约定

1. **`installScope` 必须逐项声明**（`user` 或 `machine`）。
   不存在"全局用户级优先"——Node.js 的官方 MSI、PostgreSQL 的服务安装只支持系统级，一刀切会写错。
2. **安装参数只能引用代码内置的白名单模板**（`install.template`），清单无权自定义命令行。
   这是防止清单被投毒后变成任意命令执行的唯一有效手段。可用模板：

   | 模板                                | 用途                              |
   | ----------------------------------- | --------------------------------- |
   | `zip-into-version-dir`              | ZIP 解压到版本目录                |
   | `zip-single-file-into-version-dir`  | 只取压缩包里的单个可执行文件      |
   | `exe-7zsfx-extract`                 | 7-Zip 自解压包（PortableGit）     |
   | `msi-install`                       | `msiexec /qn`（需管理员）         |
   | `exe-nsis-silent`                   | NSIS `/S`（需管理员）             |
   | `exe-inno-silent`                   | Inno `/VERYSILENT`                |
   | `exe-python-silent`                 | python.org 官方安装器             |
   | `exe-rustup-init`                   | rustup-init + CARGO_HOME          |
   | `npm-global-into-version-dir`       | npm 包装进版本目录（AI agent 用）  |

3. **自检必须用 `{installDir}` 绝对路径**。
   否则装了 Node 24、自检却跑到 PATH 上原有的 Node 22，会得到假阳性。

### 清单热更新（FR-15）

清单支持远程更新，但**只接受白名单字段**：

- 可来自远程：`version` / `channel` / `recommended` / `releaseDate` / `sizeBytes` / `installScope` / `source.url` / `source.sha256` / `mirrors`
- **永远来自本地**：`detect` / `install`（模板与参数）/ `activate` / `verify` / `uninstall` / `tier` / `name` …

合并结果还必须再通过同一套 JSON Schema + 语义校验才会落盘。
否则热更新通道就等于任意命令执行通道。

---

## 文件都放在哪

| 内容 | 位置 | 说明 |
| --- | --- | --- |
| **版本目录**（装好的工具） | `<数据根目录>\versions\<tool>\<version>\` | 默认 `%USERPROFILE%\.devkit`，实测可到几 GB |
| **下载缓存** | `<数据根目录>\downloads\` | 含 `.part` 断点文件；实测可到 1 GB |
| **切换链接** | `<数据根目录>\current\<tool>` | junction，指向当前激活的版本 |
| 配置 / 激活记录 / PATH 备份 / 日志 / 预设 | `%APPDATA%\devkit\` | 都很小（几百 KB） |
| Chromium 自己的缓存 | `%APPDATA%\devkit\Cache` 等 | **Electron 自动生成**（约 30 MB），不是 devkit 的选择 |

### 把批量产物挪到别的盘

版本目录与下载缓存是**批量产物**，默认落在系统盘。两种改法：

```bash
# 方式一：环境变量（优先级最高，适合脚本/CI）
set DEVKIT_DATA_ROOT=D:\devkit

# 方式二：设置 → 存储 → 数据根目录（界面里改）
```

改完之后，`versions` / `downloads` / `current` 全部跟着走，不会有一部分留在原处。

> **注意**：改根目录只影响**以后新装**的项。已经装在旧目录里的版本不会自动搬过去，
> 也不会被识别 —— 界面里会明确提示这一点。

## 设计上的几个刻意选择

| 决策                                        | 原因                                                             |
| ------------------------------------------- | ---------------------------------------------------------------- |
| 下载走官方安装包，而不是以 winget 为主      | winget 输出受系统语言影响、解析脆弱；无法控制校验和与镜像回退    |
| 主进程不整程序提权，用常驻提权助手          | 整程序提权会让拖拽失效、安全争议大；每项单独提权会反复弹 UAC     |
| **禁用 `setx`** 写 PATH                     | `setx` 在 1024 字符处静默截断，会把用户的 PATH 写坏              |
| 用 junction 而不是 shim 做版本切换          | junction 不需要管理员，切版本不用改 PATH                         |
| 镜像配置只写自己那一块（标记块/指定 id）     | 用户可能有私服、token、proxy 配置，整文件覆盖等于毁掉它          |
| VS Code 插件只做推荐列表、不自动全装         | 插件会改变编辑器行为，属于用户该自己决定的事                     |
| PATH 条目写成 `%DEVKIT_HOME%\current\<tool>` | 避免每装一个工具就把 PATH 拉长一截（PATH 过长是真实故障）        |
| 激活后跑一次「新终端」验证                  | 写进 PATH ≠ 生效；winget 的 PATH bug 几乎全在这里                  |
| 软件行里的「详情」展示下载域名与 SHA-256    | 用户没法验证二进制里装了什么，但至少能一眼看到它从哪来、校验和是多少 |
| 卸载只删 `%USERPROFILE%\.devkit\versions`   | 绝不诱导用户把系统里原有的 Node / Java 一起删掉                  |
| 更新检查是"提示"而不是"静默替换"            | 静默替换开发环境里的二进制本身就不是个安全行为                   |
| 批量产物与配置分开放                        | 配置很小、跟着应用走；版本目录与下载缓存能到几 GB，必须能挪到别的盘 |
| 零遥测                                      | 开源工具的信任基础                                               |

---

## 参与贡献

- 提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/)（`feat:` / `fix:` / `docs:` / `chore:`）
- PR 必须通过 `pnpm manifest:check`、`pnpm typecheck`、`pnpm lint`、`pnpm test`
- 新增软件清单请附上**官方下载页链接**与**该版本的 SHA-256**（可以直接跑 `pnpm manifest:refresh <id>`）

完整需求与设计见 [SPEC.md](./SPEC.md)，实测记录见 [docs/VERIFICATION.md](./docs/VERIFICATION.md)，
市场调研见 [docs/market-research.md](./docs/market-research.md)，
独立安全审查（含修法与回归测试）见 [docs/security-review.md](./docs/security-review.md)。

## English

**devkit** is a Windows desktop app that sets up a development environment on a fresh
machine in one click — installing, configuring (mirrors, PATH, git, SSH) and verifying
(post-install self-check) the tools you select.

- 19 manifests (16 installable, 3 detect-only), per-user by default, no admin required
  except for the single machine-scope MSI (7-Zip)
- **Install ≠ activate**: files land in `%USERPROFILE%\.devkit\versions\`; activation
  (junction + user PATH + env vars) is a separate, reversible step
- Presets, multi-version switching, offline packs, uninstall, manifest hot-update with a
  strict field whitelist, zero telemetry
- License: MIT · Requirements: Windows 10 22H2+ x64, Node.js ≥ 20, pnpm ≥ 9
- See [SPEC.md](./SPEC.md) for the full specification (written in Chinese)

## License

[MIT](./LICENSE)
