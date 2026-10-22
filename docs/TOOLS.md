# 软件清单（25 项 / 22 项可装）

> 版本号与 SHA-256 全部由 `pnpm manifest:refresh` 从**官方渠道**取：
> 有官方 API 的直接取（Node、Go、Adoptium、Gradle、VS Code、rustup），
> 有官方校验和文件的直接读（CMake、SQLite、Deno），
> 都没有的下载后本地计算（Python、Maven、Git、pnpm、Ninja、7-Zip）。

### 可安装清单（22 项）

9 个安装模板都已实现；MSI 与 NSIS 需要管理员，真机验收留待虚拟机。

| 工具 | 可选版本 | 安装方式 | 范围 |
| --- | --- | --- | --- |
| bun | 1.4.3 | ZIP 解压 | 用户级 |
| claude-code | 2.1.299 | npm 包装进版本目录 | 用户级 |
| cmake | 3.31.12 | ZIP 解压 | 用户级 |
| codex | 0.162.1 | ZIP 单文件 | 用户级 |
| copilot-cli | 1.0.97 | npm 包装进版本目录 | 用户级 |
| deno | 2.9.7 | ZIP 解压 | 用户级 |
| docker-desktop | (仅检测) | — | — |
| gemini-cli | 0.64.0 | npm 包装进版本目录 | 用户级 |
| git | 2.56.0 | 7zSFX 自解压 | 用户级 |
| go | 1.27.2 / 1.26.9 | ZIP 解压 | 用户级 |
| gradle | 9.8.1 / 8.14.6 | ZIP 解压 | 用户级 |
| jdk-temurin | 25.0.4.1 / 21.0.12.1 / 17.0.20.1 | ZIP 解压 | 用户级 |
| maven | 3.10.0 / 3.9.16 | ZIP 解压 | 用户级 |
| ninja | 1.13.2 | ZIP 单文件 | 用户级 |
| nodejs | 24.21.0 / 22.23.3 / 20.20.2 | ZIP 解压 | 用户级 |
| opencode | 1.19.0 | ZIP 单文件 | 用户级 |
| pnpm | 12.11.2 | ZIP 单文件 | 用户级 |
| postgresql | (仅检测) | — | — |
| python | 3.15.0 / 3.14.8 / 3.13.16 | 官方 exe 静默安装 | 用户级 |
| qwen-code | 0.25.1 | npm 包装进版本目录 | 用户级 |
| rust | 1.29.1 | rustup-init | 用户级 |
| sevenzip | 26.04 | MSI 静默安装 | 机器级（需管理员） |
| sqlite | 3.54.0 | ZIP 解压 | 用户级 |
| vscode | 1.141.0 | Inno Setup 静默安装 | 用户级 |
| wsl2 | (仅检测) | — | — |

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

### 环境体检

换机、装完东西跑不起来时，第一反应是"环境坏了"—— 而现在唯一的办法是人肉 `echo %PATH%` 一条条看。

体检会逐条判定 PATH（正常 / 目录不存在 / 变量不存在 / 结构畸形 / 重复），
并给出**人话解释 + 具体证据**。实测在一台真实开发机上抓到：

```
机器级 PATH 33 条 → 23 条正常、3 条目录不存在、1 条变量不存在、4 条结构畸形、2 条重复
  C:\P                    ← C:\Program Files\... 被截断写入的残留
  ogram Files\Git\cmd    ← 同上
  %NOODE_PATH%            ← 变量名拼错，且该变量不存在
  v16.13.1 / node_global  ← 裸版本号 / 相对路径

python → D:\Python\python.exe（实际生效）
python → C:\Program Files\LibreOffice\program\python.exe   ← 另一个也在 PATH 上
```

**诊断永远只读**；只有你点「修复」才会改动，而且改前备份、改完复验。
用户级修复直接做，机器级修复单独确认（一次 UAC）。

### 环境档案 / 换机迁移

重装系统最痛的不是装软件，是"恢复成原来那样"。导出一份 JSON 就能把
工具清单、自定义 PATH 条目、关键环境变量、镜像源、VS Code 插件带走。

- **不含任何密钥**：环境变量只收 `JAVA_HOME` 这类路径变量，不读 `.npmrc` 的 token、不碰 SSH 私钥
- 导入后**先看差异表再决定**：恢复 PATH / 环境变量 / 镜像 / git 四项默认全不勾
- 装软件复用现有安装流程（预检 → 下载 → 校验 → 安装 → 自检 → 激活）

### 前置依赖检查

有些工具装完之后能不能用，取决于别的工具 —— 预检会在开始前拦住：

| 工具 | 需要先有 |
| --- | --- |
| Maven · Gradle | **JDK**（自检 `mvn -v` 要起 JVM） |
| Claude Code · Gemini CLI · Copilot CLI · Qwen Code | **Node.js**（npm 随它提供） |
| Rust | MSVC 生成工具（**devkit 装不了**，会提示但不拦） |

没声明的话，干净机器上的表现是：下载成功、解压成功，然后自检报一句
`The JAVA_HOME environment variable is not defined correctly` —— 你根本猜不到是"该一起装 JDK"。

判定是「**计划里有 或 机器上已有**」：本机早就装了 JDK、这次只想装个 Maven 不会被误拦。
依赖一起勾选时，计划会自动把 JDK 排到 Maven 前面。

### 版本选择

多版本共存是设计目标（独立目录 + junction 切换），清单里现在给了常用版本：

| 工具 | 可选版本 |
| --- | --- |
| Node.js | 24 (Active LTS) · 22 (Maintenance LTS) · 20 |
| Python | 3.15 · **3.14** · 3.13 |
| JDK (Temurin) | 25 · 21 · 17 |
| Go | 1.27 · 1.26 |
| Gradle | 9.x · 8.x |
| Maven | 3.10 · 3.9 |

CLI 工具（AI 编码 agent、pnpm、deno…）只留最新版 —— 那些工具要的就是最新，
多放几个版本只会多出没人验证过的条目。

### 全局可用（可选）

默认**不**把工具写进机器级 PATH。要让管理员终端、服务也能找到它们，
在设置页点一次「同步到机器级 PATH」（一次 UAC，改前备份、改完复验，可整串还原）。

刻意不做自动同步：写 HKLM 要管理员权限，而且机器级 PATH 是所有账号共享的 ——
这台机器的机器级 PATH 里那 8 条坏条目（`C:\P`、`ogram Files\Git\cmd`、`%NOODE_PATH%`…）
就是历史上某个安装器用 `setx` 写、撞上 1024 字符静默截断留下的。默认开等于把那个错误再犯一遍。

**边界**：机器 PATH 里的条目是绝对路径，所以只有当批量产物根目录在共享位置时
「所有账号都能用」才成立；否则它只对**当前用户的提权进程**有效。

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

