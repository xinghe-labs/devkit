# devkit — 一键开发环境部署器 · 需求与设计规格

> 状态：**v0.5 · M0~M4 主体功能已完成**（清单 19 项 / 16 项可装；端到端安装、激活、卸载、预设、离线包、热更新、提权均已实现）
> 定位：开源（MIT）· Windows x64 · Electron 桌面端 · 打包 exe 分发
> 最低支持：**Windows 10 22H2 (build 19045) x64** 及以上（含 Win11 全版本）
> 实测记录：[docs/VERIFICATION.md](./docs/VERIFICATION.md) · 市场调研：[docs/market-research.md](./docs/market-research.md)

---

## 1. 项目定位

**devkit** 是一个面向 Windows 开发者的桌面工具：在**一台什么都没装的新电脑**上，用图形界面勾选需要的东西，一键把开发环境装好、配好、验好。

它要解决的真实痛点不是"下载安装包"，而是这些：

1. 不知道装哪个版本、装到哪、装完还要配什么
2. 装完了但 PATH / 环境变量 / 镜像源没配，跑不起来或慢得离谱
3. 装到一半失败，不知道失败在哪、装了几成
4. 换一台电脑，整套流程再来一遍

因此 devkit 的核心价值是 **「安装 + 配置 + 自检」三件套的自动化**，而不是一个下载器。

### 1.1 与同类工具的差异

| 工具 | 差异 |
|---|---|
| winget / Chocolatey / Scoop | 只解决"装"，不解决"配"和"验"；命令行门槛高；不感知国内网络 |
| 各种"一键环境包"脚本 | 一次性、不可选择、无 UI、无日志、无自检 |
| devkit | 有 UI、可勾选、有预设、可配置、有自检、有报告、多版本可切换 |

---

## 2. 范围

### 2.1 In Scope（做）

- Windows x64 桌面 GUI（Electron）
- 常用开发软件的**检测 / 选择 / 下载 / 静默安装 / 配置 / 自检**
- **每个软件可选安装版本**（清单提供多个版本，默认推荐 LTS/稳定版）
- **卸载已装项**（仅卸载，不做回滚，见 FR-16）
- **清单热更新**（从 GitHub 拉取最新 manifest，默认开启、可关闭）
- **安装前统一预检**（磁盘 / 网络 / 系统版本 / 权限）
- **中断续跑**（重启或异常退出后可继续未完成的计划）
- 系统级配置：环境变量与 PATH、镜像源、git 全局配置、SSH key、系统代理、开发者模式、长路径、PowerShell 执行策略
- 预设方案（内置 + 用户自定义 + 导出/导入）
- 多版本共存与切换（实现顺序：JDK → Node → Python）
- 安装日志、失败报告导出、安装后自检
- 系统还原点（可选）
- 离线包**制作器**（见 §8 合规约束）
- 自动更新（GitHub Releases）
- 中英双语界面（i18n）

### 2.2 Out of Scope（不做）

- macOS / Linux（架构预留，不实现）
- arm64（架构预留，不实现）
- 无 GUI 的纯 CLI 版本（除一个给多版本切换用的 `devkit` 小命令）
- 软件破解、激活、序列号管理
- 任何形式的遥测、埋点、数据上报
- 再分发许可证不允许再分发的软件（见 §8）
- **回滚已完成的安装**（只提供卸载入口，见 FR-16；回滚成本远高于收益）

---

## 3. 目标用户与场景

**用户**：开源社区的 Windows 开发者、刚拿到新电脑的人、需要重置环境的人。

**主场景**：
1. 新电脑开箱 → 打开 devkit → 选"前端开发"预设 → 一键 → 若干分钟后 `node -v`、`pnpm -v`、`git config` 全部就绪
2. 老电脑补装 → 打开 devkit → 它已检测出装了什么 → 只勾缺的
3. 团队统一环境 → 一个人配好导出预设 JSON → 发给同事导入
4. 内网机器 → 在联网机器上制作离线包 → 拷进去装（仅限合规软件）
5. 装到一半要重启（如 WSL2）→ 重启后 devkit 提示"还有 3 项未完成，是否继续"

---

## 4. 功能需求（FR）

### FR-1 环境检测
- 启动即扫描本机，识别每个清单项的安装状态：
  `未安装 / 已安装(版本) / 已安装但版本不符 / 已安装但 PATH 未生效 / 需要重启生效`
- 检测手段优先级：① 注册表卸载项（按 `DisplayName` 正则匹配）② 已知安装路径 ③ `where` 命令 ④ 版本命令执行
- 检测结果驱动 UI：已装的默认不勾选，并显示"已安装 v22.12.0"
- **PATH 修复**：检测到"已装但 PATH 未生效"时，提供一键修复按钮，调用 FR-6 的环境变量写入流程（不重装）

### FR-2 软件清单与选择
- 左侧按分类浏览，右侧多选；每项显示名称、简介、目标版本、体积、是否需要管理员、是否需要重启、许可证标签
- 支持搜索、全选/反选、按分类全选
- 清单以 **JSON manifest** 驱动（见 §7.1），与代码解耦，新增软件不改代码
- **版本选择**：每项可展开选择要安装的具体版本（manifest 的 `versions` 数组），默认选中推荐版本（LTS/稳定版），并显示体积、发布时间、是否 LTS；只有一个版本时隐藏下拉
- 已装其他版本时给出提示：支持多版本的软件显示"将并存安装"，不支持的显示"将覆盖升级"
- 版本选择随自定义预设一起导出（`toolVersions` 字段）

### FR-3 预设方案
- 内置预设：前端 / 后端 Java / 后端 Node / Python 数据 / 全栈 / 移动端 / C++ 桌面
- 用户可"选完 → 另存为我的预设"
- 预设可**导出 / 导入 JSON**，用于团队共享
- 预设只做"勾选建议"，不锁定，用户可任意改

### FR-4 安装执行
- 默认**串行**执行，UI 提供"并发安装"开关（上限 3，默认关闭）
- 每个任务状态机：
  `等待 → 下载 → 校验 → 安装 → 配置 → 自检 → 成功 / 失败 / 跳过 / 待重启`
- **单项失败不中断整体**，标记为失败并继续；最后汇总
- 支持**取消**：正在装的项等它收尾，未开始的直接取消
- **镜像回退顺序**：官方 → 清华 TUNA → 阿里云 → 华为云 → 中科大 USTC；**每个源最多重试 2 次，单次请求超时 30 秒**；全部失败才判定下载失败
- 下载器细节（见 FR-19）：断点续传（HTTP Range）、SHA-256 强校验、并发下载数上限 3、**支持系统代理与手动代理**
- 需要管理员权限的项（`installScope: "machine"`）：**默认不整程序提权**，由提权 helper 按需处理，见 §6.6；提权前必须明确告知用户将要做什么
- 安装前先跑 FR-18 预检，预检不通过直接整体拦截并说明原因

### FR-5 镜像源配置
- 内置源清单：官方 / 清华 TUNA / 阿里云 / 腾讯云 / 华为云 / 中科大 USTC
- 覆盖：npm、pip、Maven、Gradle、conda、Go proxy、Docker、Rust(cargo)、winget 源、NuGet 源
- 默认官方源，一键切国内；每项可单独设，也可"全部设为同一源"
- 切换前备份原配置文件（`.npmrc`、`pip.ini`、`settings.xml` 等），可一键还原

> **实现状态（v0.5）**：已覆盖 **npm / pip / Go proxy / Maven / Gradle / cargo / conda / NuGet / Docker**
> 九个目标（仅 winget 源未做 —— 它需要 winget CLI 且多数操作要管理员）。
> conda 有一处刻意的保守处理：如果用户 `.condarc` 里已经定义了 `channels` / `default_channels`，
> devkit **拒绝自动修改**并说明原因 —— YAML 不允许同名顶层键重复，硬追加会把配置写坏。
> 落点各不相同：`.npmrc` 行级替换、`pip.ini` 的 `[global]` 段、`GOPROXY` 用户环境变量、
> `.m2\settings.xml` 里带固定 id 的 `<mirror>`、`init.gradle` / `config.toml` 里带
> `devkit-begin`/`devkit-end` 标记的代码块。
> **一律只改自己那一块**：用户可能有私服、token、proxy 配置，整文件覆盖等于毁掉它。
> 关掉某一项 = 精确移除我们写进去的那一块，回到官方源。

### FR-6 系统配置
| 配置项 | 默认 | 说明 |
|---|---|---|
| 环境变量 / PATH | 自动配置全局 | JAVA_HOME、GOROOT、GOPATH、PYTHON_HOME 等；写入**用户级变量**（`HKCU\Environment`），不污染系统级 |
| 镜像源 | 官方，可改 | 见 FR-5 |
| 系统代理 | 可改 | 读取当前值，可设置/清除，保留原始值以便还原 |
| git 全局配置 | 可选 | user.name / user.email / core.autocrlf / 默认分支名 |
| SSH key | 可选 | 生成 ed25519 key，可选配置 GitHub / Gitee |
| Windows 开发者模式 | 可选 | 注册表项，需管理员（走 §6.6 helper） |
| 长路径支持（>260） | 可选 | 注册表项，需管理员（走 §6.6 helper） |
| PowerShell 执行策略 | 可选 | 建议 `RemoteSigned` |
| hosts | **不做** | 风险高，收益低 |

> **⚠️ 环境变量写入规范（必须遵守）**
> **禁止使用 `setx`** —— 它在 1024 字符处静默截断，会把用户的 PATH 写坏。
> 必须使用 `[Environment]::SetEnvironmentVariable(name, value, "User")` 或直接写 `HKCU\Environment`。
> 写入前先读取原值并备份到 `%APPDATA%\devkit\backup\env-<时间戳>.json`。
> 是否需要在写入后广播 `WM_SETTINGCHANGE` 才能让已打开的终端感知，**实现时需实测验证**（未验证）。

### FR-7 VS Code 插件
- 只做**推荐列表**，用户逐个勾选，不自动全装
- 提供"一键复制安装命令"和"一键执行安装"两种方式
- VS Code 未安装时，该面板置灰并提示"请先安装 VS Code"

> **实现状态（v0.5）**：✅ 已实现。18 个推荐插件按语言分类（通用/前端/Java/Python/Go/Rust/C++）；
> 一键安装逐条跑 `code --install-extension` 并逐条上报结果；VS Code 不可用时面板置灰并给出
> `code --version` 的真实报错。**只接受推荐列表里的插件 id** —— 这既挡住渲染进程传任意 id，
> 也避免"一键安装"变成一条任意命令通道。

### FR-8 安装后自检
- 每个已安装项执行 `verify` 命令（如 `node -v`），匹配预期正则
- 自检**不通过 = 该项失败**，即使安装器返回 0
- 最终生成"环境体检报告"：通过 / 失败 / 需要重启生效

### FR-9 日志与报告
- 日志目录：`%APPDATA%\devkit\logs\<时间戳>.log`，UTF-8，含每条命令、stdout/stderr、耗时
- UI 内实时滚动显示，可暂停自动滚动、可搜索
- 结束后可导出 **Markdown 报告** 和 **JSON 报告**
- **无任何网络上报**（NFR-3）

### FR-10 系统还原点
- 可选开关，默认关闭；开启后在任何写操作前创建还原点
- 创建前明确提示"需要管理员权限，可能耗时 10–60 秒"
- 失败不阻断安装，但要在报告里写明"还原点创建失败"

### FR-11 多版本共存与切换
- 安装位置：`%USERPROFILE%\.devkit\versions\<tool>\<version>\`
- 通过 PATH shim 切换当前生效版本
- 附带轻量 `devkit` CLI：`devkit list` / `devkit use node 20.18.0` / `devkit current`
- 实现顺序：**JDK（纯目录 + JAVA_HOME，最简单）→ Node（fnm）→ Python（uv）**
- 单一版本的软件（Git、7-Zip 等）不进入版本管理

### FR-12 离线模式
- 提供**离线包制作器**：devkit 内置功能，在**有网的机器上**运行，按勾选项下载并打包成 `devkit-offline-<devkit版本>-<日期>.zip`
- 离线包内容：`manifest/`（快照）+ `packages/`（安装包）+ `checksums.json` + `pack.json`（元数据）
- 离线包内**只含合规软件**（§8 的 L1 类）；L2/L3 类在离线模式下显示为"不可用（需联网）"并给出原因
- 内网机器上打开 devkit → 选"从离线包安装" → 指向该 zip → 走本地文件流程（不再联网）
- **仓库不发布任何离线包**

### FR-13 自动更新
- `electron-updater` + GitHub Releases
- 启动时静默检查，有新版提示；用户可关闭自动检查
- 更新失败不影响主功能

### FR-14 国际化
- `i18next`，默认跟随系统语言，可手动切换
- 覆盖：UI 文案、清单项的 name/description/notes（manifest 内多语言字段）
- **语言回退规则**：`当前语言 → zh-CN → en-US → manifest 中第一个可用语言`
- 回退时不得出现空白或 `undefined`

### FR-15 清单热更新
- 启动时从 GitHub 拉取最新 manifest，**默认开启，可在设置中关闭**
- 拉取失败静默回退到内置清单，不阻断任何功能，不弹错误
- 拉取的清单必须通过 **JSON Schema 校验**，且**只接受 devkit 官方仓库来源**

> **⚠️ 安全边界（关键，防止清单投毒导致任意命令执行）**
> 热更新的清单**只允许修改以下字段**：
> `versions[].version`、`versions[].releaseDate`、`versions[].source.url`、`versions[].source.sha256`、`versions[].sizeBytes`、`versions[].mirrors[]`
> **禁止**从网络清单接受：`install.*`（安装参数）、`detect.*`、`configure.*`、`verify.*`、`homepage`、`license`。
> 这些字段一律以**内置清单为准**，热更新内容与之冲突时丢弃网络值。
> 安装参数只能引用**代码内置的白名单模板**（见 §7.1 的 `install.template`），清单无权自定义命令。
> 预留升级路径：未来对 manifest 做 Ed25519 签名校验，私钥只在维护者机器上。

### FR-16 卸载已装项
- 从"环境总览"或已装列表进入，可勾选已装项执行卸载
- 卸载方式按清单的 `uninstall` 字段：
  - 优先读取注册表卸载项拿到官方 UninstallString，静默执行（`msiexec /x {GUID} /qn` 或 `exe /S`）
  - 无注册表项时（如 ZIP 解压安装的 Temurin），执行 devkit 自己的删除逻辑（删目录 + 清 PATH）
- 卸载前**必须二次确认**，并列出"将被删除的路径"和"将被清理的环境变量"
- 卸载**不删除用户数据**（如 `.npmrc`、`~/.m2`、`~/.gradle` 缓存），只在报告里提示这些目录仍存在
- 不做回滚（见 §2.2）

### FR-17 中断续跑
- 每次开始安装前，把当前 InstallPlan 写入 `%APPDATA%\devkit\pending.json`
- 正常全部完成后删除该文件
- 异常退出或重启后，devkit 启动时若检测到 `pending.json`，弹提示：
  **"上次有 N 项未完成（已成功 M 项），是否继续？"**，可选"继续 / 查看详情 / 放弃"
- 继续时**跳过已成功项**（依赖 FR-1 重新检测），只跑未完成和失败的项
- `pending.json` 写入前做完整性校验（含 devkit 版本、planId），格式不匹配则提示"计划已失效，请重新选择"而不是静默执行

### FR-18 安装前预检
开始安装前统一跑一次，一次性报完所有问题，而不是逐个失败：
- **系统版本**：是否 ≥ Win10 22H2 (19045)
- **架构**：是否 x64
- **磁盘空间**：目标盘剩余空间 ≥ 本次计划总下载体积 × 2.5 + 500 MB
- **网络连通性**：探测官方源与所选镜像源的可达性（HEAD 请求，5 秒超时）
- **权限**：本次计划是否含 `installScope: "machine"` 项，若有则提前告知"稍后会弹出管理员授权"
- **冲突检查**：是否存在已知冲突（如同时勾选 Docker Desktop 与 Podman）
- **杀软**：检测是否运行已知会拦截静默安装的安全软件，给出预警（不阻断）
- 预检结果以清单形式展示，用户可选择"忽略并继续"

### FR-19 下载器
- 协议：仅 HTTPS（HTTP 一律拒绝）
- 断点续传：HTTP Range 请求，临时文件 `<name>.part` + 侧车 `<name>.part.json` 记录进度
- 校验：下载完成立即算 SHA-256，与清单不符则删除并回退下一个镜像
- 并发：同一时刻最多 3 个下载任务
- 代理：优先使用 devkit 内配置的代理，其次读系统代理（`HKCU\...\Internet Settings`），两者都没有则直连
- 重试：见 FR-4 的回退顺序与次数
- 磁盘保护：下载前检查剩余空间，不足则该项标记失败而不是写满磁盘

---

## 5. 非功能需求（NFR）

- **NFR-1 安全**：只从 HTTPS 下载；强制 SHA-256 校验（清单内固定）；**安装参数只能引用代码内置白名单模板**，清单无权自定义命令；不执行清单以外的任何命令
- **NFR-2 幂等**：重复运行不产生副作用；已装项跳过；配置项先读后写、先备份
- **NFR-3 隐私**：零遥测、零上报；日志只落本地
- **NFR-4 可维护**：新增软件 = 新增一个 JSON，不改代码
- **NFR-5 中文环境兼容**：**必须**处理中文用户名 / 含空格路径（本机就是 `C:\Users\张三`）——所有脚本用引号包裹路径、PowerShell 用 UTF-8 输出（`[Console]::OutputEncoding`）、避免 GBK/UTF-8 混用
- **NFR-6 健壮性**：网络中断、磁盘满、权限不足、安装器静默失败都要有明确错误信息，不能静默卡死
- **NFR-7 体积**：NSIS 安装包目标 < 120 MB（`asar` + 最大压缩 + 排除无用 locale）；portable 版不压缩，体积会明显更大，单独说明

---

## 6. 技术架构

### 6.1 技术栈（定稿）

| 层 | 选型 | 理由 |
|---|---|---|
| 桌面框架 | **Electron** | 用户已确认；自带 Chromium+Node，新电脑零依赖 |
| 构建 | **electron-vite** | 主/预加载/渲染三端 HMR，开发快 |
| 打包 | **electron-builder** | NSIS + portable 双 target，自动更新成熟 |
| 语言 | **TypeScript**（strict） | 主进程与 UI 共享类型 |
| UI | **React + Ant Design** | 表单/表格/进度/步骤条开箱即用 |
| 状态 | **Zustand** | 轻量，适合这种规模 |
| i18n | **i18next + react-i18next** | 中英双语 |
| 更新 | **electron-updater** | GitHub provider |
| 系统操作 | Node `child_process` + PowerShell | 实时流式输出 |
| 测试 | **Vitest** + Playwright(Electron) | 见 §11 |

### 6.2 进程模型

```
主进程 (Node)
 ├─ 清单加载与校验 (manifest)
 ├─ 环境检测 (detect)
 ├─ 下载器 (downloader: 断点续传/校验和/镜像回退/代理)
 ├─ 安装提供者 (providers: Direct / Scoop / Winget)
 ├─ 执行调度 (executor: 串行/并发/取消/重试/续跑)
 ├─ 配置器 (configure: 镜像源/PATH/git/ssh/代理/系统项)
 ├─ 自检 (verify)
 ├─ 卸载 (uninstall)
 ├─ 预检 (preflight)
 ├─ 版本管理 (version)
 ├─ 离线包 (offline)
 ├─ 提权助手 (elevate) ←→ 提权 PowerShell 子进程（仅白名单操作）
 └─ 日志与报告 (report)
        ↕ IPC (contextBridge, 白名单通道 + 参数校验)
预加载 (preload)  — 仅暴露类型化 API，无 nodeIntegration
        ↕
渲染进程 (React)  — 纯 UI，不碰系统
```

### 6.3 安装提供者策略（重要决策）

**默认走 `DirectProvider`**：从官方地址下载安装包，用清单里引用的**内置白名单参数模板**执行。

理由：
- winget 的输出受**系统语言和版本**影响，解析脆弱，不同机器行为不一致
- winget 无法让我们控制校验和、镜像回退和下载进度
- 直接下载能精确控制版本，且与 FR-19 下载器共用一套能力
- winget 在部分环境下不可用（未安装 App Installer、被策略禁用），而 DirectProvider 只依赖 Node 的 HTTPS

`ScoopProvider`（用户级、免提权）与 `WingetProvider` 作为**可选**提供者，接口预留，MVP 不实现。

### 6.4 目录结构

```
devkit/
├─ SPEC.md
├─ package.json
├─ tsconfig.json
├─ electron.vite.config.ts
├─ electron-builder.yml
├─ .github/workflows/
│  ├─ ci.yml                         # PR: lint + typecheck + test + manifest schema 校验
│  └─ release.yml                    # 打 tag: 构建 NSIS + portable 并发布 Release
├─ resources/
│  ├─ manifest/
│  │  ├─ tools/                      # 每个软件一个 json（核心数据）
│  │  ├─ presets/                    # 内置预设
│  │  └─ schema/tool.schema.json     # manifest JSON Schema
│  └─ scripts/
│     ├─ elevate-helper.ps1          # 提权常驻助手
│     └─ env-broadcast.ps1           # 环境变量广播（若实测需要）
├─ src/
│  ├─ main/
│  │  ├─ index.ts
│  │  ├─ ipc/                        # 通道注册与参数校验
│  │  ├─ core/
│  │  │  ├─ manifest/                # 加载/校验/热更新（含字段白名单过滤）
│  │  │  ├─ providers/               # direct / scoop / winget
│  │  │  ├─ templates/               # 安装参数白名单模板（安全关键）
│  │  │  ├─ downloader/
│  │  │  ├─ executor/                # 状态机 + 并发 + 续跑
│  │  │  ├─ detect/
│  │  │  ├─ preflight/
│  │  │  ├─ configure/               # 镜像源/PATH/git/ssh/代理/系统项
│  │  │  ├─ elevate/                 # 提权 helper 客户端
│  │  │  ├─ uninstall/
│  │  │  ├─ verify/
│  │  │  ├─ version/
│  │  │  ├─ offline/
│  │  │  └─ report/
│  │  └─ utils/                      # 路径/编码/提权/进程
│  ├─ preload/index.ts
│  ├─ renderer/
│  │  ├─ pages/                      # 首页 / 选择 / 安装中 / 报告 / 设置 / 关于
│  │  ├─ components/
│  │  ├─ store/
│  │  └─ locales/{zh-CN,en-US}.json
│  └─ shared/                        # 主/渲染共享的类型与常量
└─ docs/
```

### 6.5 UI 主流程

```
[首页] 检测中… → 环境总览（已装 N 项 / 待装 M 项）
   ↓  （若有 pending.json：先弹"上次有 N 项未完成，是否继续？"）
[选择页] 顶部：预设下拉 + 我的预设(存/导出/导入)
        左侧：分类导航    右侧：可勾选清单（含已装标记 + 版本下拉）
        底部：已选 X 项 · 预计下载 Y MB · [开始安装]
   ↓
[预检页] 系统/磁盘/网络/权限/冲突 检查结果  [忽略并继续] [返回修改]
   ↓
[安装页] 总体进度条 + 任务列表（每项：状态/进度/耗时）
        日志面板（可暂停滚动/搜索）  [取消]
   ↓
[报告页] 成功 / 失败 / 需重启 / 自检未通过
        [导出 Markdown] [导出 JSON] [重启后继续]
```

### 6.6 提权模型（关键设计）

**devkit 主进程始终以普通用户权限运行**，不整程序提权。需要管理员权限时走**常驻提权助手**：

```
主进程（非提权）
   │  首次遇到 installScope="machine" 的操作
   ├─► Start-Process powershell -Verb RunAs -ArgumentList elevate-helper.ps1
   │        （此刻弹出一次 UAC，用户同意后 helper 常驻）
   │
   │  stdin/stdout 走 JSON Lines 协议，一条请求一条响应
   ├─► { "op": "writeRegistry", "params": {...} }   ──►
   │◄── { "ok": true, "data": {...} }
   │
   └─ helper 空闲 5 分钟自动退出；下次需要时再提权
```

约束：
- helper **只接受白名单操作**：写注册表指定键、创建还原点、执行指定的 MSI/EXE 安装、写系统级环境变量、装 Windows 服务。**不接受任意命令行字符串**
- 所有请求带 `planId`，helper 只处理属于当前 InstallPlan 的操作
- 用户**拒绝 UAC** → 该项直接标记失败并写入报告，**不重复弹窗**（避免骚扰）
- helper 退出或崩溃 → 主进程检测到管道断开，把依赖它的剩余项标记为失败，已完成的项不受影响
- 已知风险：提权 PowerShell 可能被杀软重点关注，见 §12

### 6.7 环境变量写入规范

见 FR-6 下方的警示框。要点：
1. **禁用 `setx`**（1024 字符截断）
2. 用 `[Environment]::SetEnvironmentVariable(name, value, "User")` 或直写 `HKCU\Environment`
3. 写前备份原值到 `%APPDATA%\devkit\backup\env-<时间戳>.json`
4. 修改 PATH 时用"追加并去重"，**绝不整体覆盖**
5. 是否需要广播 `WM_SETTINGCHANGE` 让已开终端感知 —— **待实测**（未验证）

---

## 7. 数据格式

### 7.1 软件清单 manifest（`resources/manifest/tools/<id>.json`）

```jsonc
{
  "id": "nodejs",
  "category": "runtime",
  "tier": "L1",                          // 许可证分级，见 §8
  "provider": "direct",                  // direct | scoop | winget
  "name": { "zh-CN": "Node.js", "en-US": "Node.js" },
  "description": {
    "zh-CN": "JavaScript 运行时，自带 npm",
    "en-US": "JavaScript runtime with npm bundled"
  },
  "homepage": "https://nodejs.org",
  "license": { "spdx": "MIT", "redistributable": true },

  "detect": {
    "commands": [{ "cmd": "node", "args": ["-v"], "expectRegex": "^v\\d+" }],
    "files": ["C:\\Program Files\\nodejs\\node.exe"],
    "registry": [
      {
        "hive": "HKLM",
        "view": "64",
        "path": "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
        "match": { "DisplayName": "^Node\\.js" },   // 按 DisplayName 正则匹配
        "versionFrom": "DisplayVersion"
      }
    ]
  },

  "versions": [
    {
      "version": "22.12.0",
      "channel": "lts",                  // lts | stable | beta
      "recommended": true,
      "arch": "x64",
      "releaseDate": "2024-12-03",
      "sizeBytes": 30000000,
      "installScope": "machine",         // user | machine —— 决定是否需要提权
      "requiresReboot": false,
      "dependsOn": [],                   // 如 docker-desktop 依赖 wsl2
      "source": {
        "url": "https://nodejs.org/dist/v22.12.0/node-v22.12.0-x64.msi",
        "sha256": "<填写实际值>"
      },
      "mirrors": [
        { "name": "tuna",   "url": "https://mirrors.tuna.tsinghua.edu.cn/nodejs-release/v22.12.0/node-v22.12.0-x64.msi" },
        { "name": "aliyun", "url": "https://mirrors.aliyun.com/nodejs-release/v22.12.0/node-v22.12.0-x64.msi" }
      ],
      "install": {
        "type": "msi",                   // msi | exe-nsis | exe-inno | zip
        "template": "msi-silent",        // ← 只能引用代码内置白名单模板，禁止自定义命令
        "params": { "ADDLOCAL": "ALL" }  // 只能填模板声明的占位符
      },
      "uninstall": {
        "type": "registry",              // registry | custom | none
        "template": "msi-uninstall-silent"
      },
      "configure": ["npm-mirror", "npm-global-prefix"],
      "verify": { "cmd": "node", "args": ["-v"], "expectRegex": "^v22\\." }
    }
  ],

  "notes": { "zh-CN": "安装后可另选 pnpm / yarn" }
}
```

**安全说明**：`install.template` 与 `install.params` 是唯一允许触达命令行的字段，模板本身写死在 `src/main/core/templates/`，清单只能选模板名并填受限占位符。热更新的清单**不得覆盖** `install.*`（见 FR-15）。

### 7.2 预设格式（可导出分享）

```jsonc
{
  "schemaVersion": 1,
  "id": "frontend",
  "name": { "zh-CN": "前端开发", "en-US": "Frontend" },
  "builtin": true,
  "tools": ["git", "nodejs", "pnpm", "vscode", "chrome"],
  "config": ["npm-mirror", "git-global", "path-env"],
  "toolVersions": { "nodejs": "22.12.0" }
}
```

### 7.3 用户配置（`%APPDATA%\devkit\config.json`）

保存：语言、镜像源选择、并发开关、还原点开关、代理设置、自动更新开关、清单热更新开关、自定义预设、上次勾选。

### 7.4 安装计划 InstallPlan（UI 与 executor 之间的唯一契约）

```jsonc
{
  "schemaVersion": 1,
  "planId": "20250101-120000-a1b2",     // 唯一标识，提权 helper 用它校验归属
  "createdAt": "2025-01-01T12:00:00+08:00",
  "devkitVersion": "0.1.0",
  "manifestRevision": "2025-01-01",     // 内置或热更新清单的版本标识

  "options": {
    "concurrency": 1,                    // 1 = 串行；最大 3
    "createRestorePoint": false,
    "mirrorPreference": "official",      // official | tuna | aliyun | huawei | ustc
    "proxy": null                        // null = 跟随系统
  },

  "items": [
    {
      "id": "nodejs",
      "version": "22.12.0",
      "tier": "L1",
      "installScope": "machine",
      "requiresAdmin": true,
      "requiresReboot": false,
      "dependsOn": [],
      "state": "pending",                // pending|downloading|verifying|installing|configuring|verifying_result|success|failed|skipped|reboot_required|cancelled
      "attempts": 0,
      "error": null,
      "startedAt": null,
      "finishedAt": null
    }
  ],

  "configs": ["npm-mirror", "git-global"],
  "summary": { "total": 1, "success": 0, "failed": 0, "rebootRequired": 0 }
}
```

**持久化**：安装开始时写入 `%APPDATA%\devkit\pending.json`（同结构）；全部完成或用户放弃时删除。FR-17 靠它续跑。

---

## 8. 安全与合规（关键约束）

清单项按**可再分发程度**分三级，这直接决定离线包内容：

| 级别 | 含义 | 是否进离线包 | 例子 |
|---|---|---|---|
| **L1** | 许可证明确允许再分发 | ✅ 可以 | Node.js、Python、Git、7-Zip、VS Code、Windows Terminal、PowerShell 7、CMake、Ninja、**Eclipse Temurin JDK**、Go、Rust、Maven、Gradle、PostgreSQL、SQLite、DBeaver、Podman、MongoDB(SSPL，需标注) |
| **L2** | 可自动下载安装，但**不得再分发** | ❌ 不进 | Docker Desktop、JetBrains Toolbox、微信开发者工具、Cursor、Apifox、Navicat(试用版) |
| **L3** | 仅跳转官网，不自动安装 | ❌ | 需要账号/序列号的商业软件（Navicat 正式版、IDEA Ultimate 等） |

已核实的合规结论：
- **Docker Desktop**：受 Docker Subscription Service Agreement 约束，大企业/政府商业使用需付费；本工具只做"引导官方下载"，不打包、不内置。
- **Oracle JDK**：BCL 对再分发有限制 → **不使用 Oracle JDK，改用 Eclipse Temurin**（GPLv2+CE，可自由分发）。
- **Redis**：官方**没有 Windows 原生版本** → 清单中 Redis 走 WSL2 或 Podman 容器方案，不提供"Windows 原生 Redis"误导性选项。
- **MongoDB**：SSPL 许可证，需在 UI 上标注许可证类型。

另外：
- 所有下载强制 HTTPS + SHA-256 校验
- 提权操作前必须明确告知用户"将要做什么、需要管理员权限"
- 写注册表前先备份原值
- **禁止 `setx`**（见 §6.7）

---

## 9. 关键设计决策与取舍

| 决策 | 选择 | 否决的方案 | 原因 |
|---|---|---|---|
| 包管理来源 | DirectProvider 官方安装包为主 | winget 为主 | winget 输出受系统语言影响、解析脆弱；无法控制校验和与镜像回退；部分环境不可用 |
| 权限模型 | 主进程不提权 + **常驻提权 helper**（§6.6） | 整程序提权 / 每项单独提权 | 整程序提权会让拖拽失效、安全争议大；每项单独提权会反复弹 UAC |
| 安装范围 | **由 manifest 的 `installScope` 逐项决定** | 全局"用户级优先" | 事实错误：Node/PostgreSQL/7-Zip 官方只支持系统级安装，没有用户级选项 |
| PATH 写入 | `[Environment]::SetEnvironmentVariable` | `setx` | `setx` 在 1024 字符处静默截断，会写坏 PATH |
| 清单热更新 | 只允许改版本/URL/校验和/镜像；参数模板写死代码 | 全字段热更新 | 否则可被投毒成任意命令执行 |
| 离线包 | 提供"制作器"，仓库不发离线包 | 仓库直接发离线包 | 再分发合规风险 |
| 回滚 | 不做回滚，只做卸载入口（FR-16） | 完整回滚 | 回滚成本远高于收益，MVP 不做 |
| 并发 | 默认串行，可选 ≤3 | 默认并发 | MSI 安装有互斥锁，并发易失败 |
| JDK 发行版 | Temurin | Oracle JDK | 许可证 |
| 多版本 | 独立目录 + PATH shim，实现顺序 JDK→Node→Python | 只装单版本 | 用户要求可切换；按实现难度排序 |
| 遥测 | 零 | 匿名统计 | 开源项目信任基础 |

---

## 10. 里程碑与验收标准

### M0 — 骨架（可运行的空壳）
**状态**：✅ 已完成（提交 `e61c761`）

**产出**：仓库初始化、Electron+React+TS+AntD 跑起来、三端 IPC 打通（含参数校验）、i18n 骨架（含回退规则）、日志模块、manifest 加载与 JSON Schema 校验、真实环境检测、列表展示（含版本下拉）
**验收**：`pnpm dev` 能打开窗口，看到真实检测出的本机已装软件列表（含版本号），中英可切换且无 `undefined`，manifest 校验失败能被 CI 拦截

### M1a — 端到端闭环（零风险，不碰系统）
**状态**：✅ 已完成（提交 `b7ceeb9`）

**产出**：DirectProvider + 内置参数模板机制 + 下载器（FR-19 全量）+ ZIP 安装到用户级版本目录 + 流式日志 + 预检（FR-18）+ 自检 + 单项失败跳过 + InstallPlan 与 pending.json

> **关键设计：安装 ≠ 激活。**
> 安装只把文件放到 `%USERPROFILE%\.devkit\versions\<tool>\<version>\`，
> **不改 PATH、不写系统目录、不需要管理员**。自检用绝对路径跑，验证的是刚装进去的那一份，
> 而不是 PATH 上本来那一份（否则装了 Node 24、自检却跑到 Node 22，会得到假阳性）。
> 激活与版本切换属于 M3 的 FR-11。

**验收**：以 **Node.js 官方 ZIP** 为样本（本机已有 Node 22，故不装 MSI、不覆盖现有环境）：
点击安装 → 预检 → 下载（约 36 MB）→ SHA-256 校验 → 解压到版本目录 → 绝对路径 `node.exe -v` 自检通过 → 报告成功。
全程 UI 实时日志；中途强杀 devkit 再启动能提示并继续；卸载 = 删目录。

### M1b — 系统级安装（需提权，虚拟机验收）
**状态**：🟡 已实现并通过协议级测试；UAC 与 MSI 真机验收仍需干净虚拟机

**产出**：MSI / EXE 静默安装 + §6.6 常驻提权 helper + 系统级 PATH 写入 + 安装前还原点
**验收**：在干净虚拟机里装 Node.js MSI（系统级），需要 UAC 时只弹一次；装完新开终端 `node -v` 生效

**为什么拆开**：M1b 会改系统目录、写 HKLM、要管理员权限，风险等级与 M1a 完全不同。
M1a 可以先在开发机上真实验证，M1b 必须在干净环境里做。

### M2 — 清单扩充 + 预设 + 配置 + 卸载
**状态**：✅ 已完成（清单 19 项 / 16 项可装；预设、镜像、系统配置、卸载、报告均已实现）

**产出**：L1 类软件清单补齐到 ~20 项（逐项实测 `installScope`）、版本选择 UI、清单热更新（含字段白名单过滤）、内置 7 套预设、自定义预设导出导入、镜像源切换、环境变量/PATH、git 全局配置、SSH key、系统代理、开发者模式、长路径、PowerShell 策略、还原点、提权 helper、卸载（FR-16）、报告导出
**验收**：选"前端开发"预设一键跑通全部项；镜像源切换后 `npm config get registry` 生效；导出预设 JSON 能在另一台机器导入并复现；卸载 Node 后 `node -v` 报 command not found

### M3 — 多版本 + 离线 + 并发
**状态**：✅ 已完成（junction 版本切换、离线包制作与导入、并发调度 ≤3）

**产出**：JDK/Node/Python 多版本安装与 `devkit use` 切换、并发调度（≤3）、取消/重试、离线包制作器与离线安装流程
**验收**：同机装 JDK 17 与 21，`devkit use java 21` 后 `java -version` 变化；离线包在断网环境能装完 L1 项

### M4 — 发布
**状态**：✅ 已完成（NSIS + portable 实测产出；CI/发布流水线；更新检查为提示式，见 §13.4）

**产出**：NSIS + portable 双产物、GitHub Actions 自动构建发布、electron-updater 自动更新、README 与使用文档、双语补全、贡献指南
**验收**：GitHub Release 下载 exe 能在干净机器运行；旧版本能检测到并更新

---

## 11. 开发环境与工程规范

### 11.1 开发环境要求
| 项 | 要求 |
|---|---|
| Node.js | ≥ 20（推荐 22 LTS，与本机一致） |
| pnpm | ≥ 9，通过 `corepack enable` 启用 |
| Git | ≥ 2.40 |
| 操作系统 | Windows 10 22H2+ / Windows 11 |
| 编辑器 | 推荐 VS Code（仓库内提供 `.vscode/extensions.json` 推荐插件） |

### 11.2 标准命令
```bash
pnpm install      # 安装依赖
pnpm dev          # 开发模式（三端 HMR）
pnpm build        # 构建（不打包）
pnpm dist         # 打包出 NSIS + portable
pnpm lint         # ESLint
pnpm typecheck    # tsc --noEmit
pnpm test         # Vitest 单元测试
pnpm test:e2e     # Playwright Electron 端到端（M2 之后启用）
pnpm manifest:check  # 校验所有 manifest 是否符合 JSON Schema
```

### 11.3 测试策略
- **单元测试（Vitest）**，优先覆盖高风险纯逻辑：
  - 下载器：SHA-256 校验、镜像回退顺序、断点续传状态
  - manifest：Schema 校验、热更新字段白名单过滤（**重点**，防投毒）
  - 参数模板：非法占位符必须被拒绝
  - executor：状态机流转、并发上限、取消语义、续跑时跳过已成功项
  - 路径工具：中文路径 / 含空格路径 / 长路径
- **端到端（Playwright + Electron）**：M2 之后覆盖"选择 → 预检 → 安装 → 报告"主流程（用 mock provider，不真装软件）
- **真实安装测试**：只能在虚拟机里做，见 §12

### 11.4 CI（GitHub Actions）
- `ci.yml`（PR / push 触发）：`pnpm lint` → `pnpm typecheck` → `pnpm manifest:check` → `pnpm test`。任一失败阻断合并
- `release.yml`（打 tag 触发）：构建 NSIS + portable，上传 GitHub Release，生成 `latest.yml` 供 electron-updater 使用

### 11.5 代码与提交规范
- ESLint + Prettier；TypeScript `strict: true`
- 提交信息遵循 **Conventional Commits**（`feat:` / `fix:` / `docs:` / `chore:`），便于自动生成 changelog
- 主进程代码不得直接 `eval` / 拼接 shell 字符串；一律用参数数组形式调用 `spawn`

---

## 12. 风险清单

| 风险 | 影响 | 应对 |
|---|---|---|
| **中文用户名路径**（本机就是 `C:\Users\张三`） | 部分工具/脚本因编码炸掉 | 全路径加引号、PowerShell 强制 UTF-8 输出、单测专门覆盖 |
| 家庭版无 Windows Sandbox（Hyper-V 亦不可用） | 无法用系统原生沙箱验证 | 已确认装 **VMware Workstation Player / VirtualBox** 建干净虚拟机，配合 dry-run 模式 |
| 静默安装参数随版本变化 | 安装失败 | manifest 与代码解耦；参数模板集中管理；**清单热更新已由 FR-15 覆盖** |
| **提权 helper 被杀软拦截** | 提权功能整体不可用 | helper 脚本不混淆、可读、开源；文档说明；M2 在多款杀软下实测 |
| **清单热更新被投毒** | 任意命令执行 | FR-15 字段白名单 + 内置参数模板；预留 manifest 签名 |
| 未签名 exe 被杀软/SmartScreen 拦截 | 用户流失 | 文档说明；申请 SignPath（开源免费）做签名 |
| 镜像站/下载地址失效 | 安装失败 | 多镜像回退 + 清单可更新 |
| **镜像版本滞后** | 镜像返回 404，用户以为工具坏了 | 实测发现 TUNA 只到 v24.1.0 而没有 v24.21.0，USTC 根本没有 nodejs 镜像。下载器必须把 404 当作可回退错误而不是致命错误，并在日志里说清"哪个源没有这个版本" |
| 镜像速度差异巨大 | 用户等几分钟 | 实测：华为云 8.2 MB/s、官方源 191 KB/s、阿里云 162 KB/s，相差 40 倍。镜像偏好必须可选，且要能一键切 |
| Docker Desktop 需 WSL2 + 重启 | 体验断点 | 依赖检查 + pending.json 续跑（FR-17）+ 明确提示 |
| 并发安装 MSI 互斥 | 失败 | 默认串行 |
| Electron 包体积大 | 下载慢 | 接受；或用 NSIS web installer 变体 |
| `installScope` 判断错误 | 用户级/系统级装错位置 | M2 逐项实测并修正 manifest（**当前清单中的 scope 值尚未逐项验证**） |

---

### 13.4 更新机制确认（v0.5）

| # | 问题 | 结论 |
|---|---|---|
| 15 | 清单热更新的安全边界 | 只接受「版本 / 地址 / SHA-256 / 体积 / 发布日期 / 安装范围 / 镜像」七类字段；`detect`、`install`、`activate`、`verify` **永远来自本地清单**，远程无权修改。合并结果必须再通过同一套 Schema 与语义校验才落盘 |
| 16 | 为什么不用 electron-updater 做自动更新 | 它要求构建期固定 `publish` 地址。仓库目前没有远程地址，写一个假地址只会让用户看到一个永远失败的"自动更新"。改为**提示式更新**：从用户配置的更新源拉一个索引（支持 `latest.json` 与 `latest.yml`），比较版本后把下载地址交给用户。对开发者工具来说，静默替换二进制本身也不是个安全行为 |
| 17 | 提权模型的落地形态 | job/result **文件协议**：主进程把所有需要管理员的步骤写成一个 job 文件，由一个提升后的 PowerShell 进程顺序执行完再写结果。装 3 个 MSI 从弹 3 次 UAC 变成弹 1 次；提权进程与主进程不共享任何状态 |

## 13. 已确认决策

### 13.1 需求确认（v0.2）

| # | 问题 | 结论 |
|---|---|---|
| 1 | 最低 Windows 版本 | **Win10 22H2 (19045) x64** 及以上，不向下兼容更老系统 |
| 2 | 清单热更新 | **默认开启，可在设置中关闭**；同时**用户可为每个软件选择安装哪个版本**（FR-2） |
| 3 | 测试环境 | 用户愿意安装 **VMware Workstation Player / VirtualBox**，建干净虚拟机用于验收 |
| 4 | 仓库初始化 | 已在 `D:/code/actionhub/devkit` 执行 `git init`（本地仓库，未建远程、未推送） |

### 13.2 架构确认（v0.3）

| # | 问题 | 结论 |
|---|---|---|
| 5 | UAC 提权 | **常驻提权 helper**（§6.6），主进程不提权，只弹一次 UAC |
| 6 | 安装范围策略 | **由 manifest 的 `installScope` 逐项决定**，废除"全局用户级优先" |
| 7 | PATH 写入 | **禁用 `setx`**，改用 `[Environment]::SetEnvironmentVariable`（§6.7） |
| 8 | 热更新安全 | **字段白名单**：只允许改版本/URL/校验和/镜像；参数模板写死代码（FR-15） |
| 9 | 卸载 | 新增 **FR-16**，只卸载不回滚 |
| 10 | 中断续跑 | 新增 **FR-17**，靠 `%APPDATA%\devkit\pending.json` |
| 11 | InstallPlan | 新增 **§7.4** 定义 UI 与 executor 的契约结构 |

### 13.3 架构确认（v0.4）

| # | 问题 | 结论 |
|---|---|---|
| 12 | 安装与激活的关系 | **安装 ≠ 激活**。安装只落到用户级版本目录，不改 PATH；激活/切换留给 M3 的 FR-11。这样安装动作对本机现有环境零影响 |
| 13 | M1 是否拆开 | 拆成 **M1a**（ZIP + 用户级，免提权，开发机可真实验证）与 **M1b**（MSI/EXE + 提权 helper，必须虚拟机验收） |
| 14 | Node.js 样本用 ZIP 而非 MSI | 开发机已装 Node 22 且 devkit 自己跑在它上面，装 MSI 会覆盖并可能弄坏开发环境 |

---

## 14. 下一步

M0~M4 的主体功能已完成，剩余的是**必须在干净环境里做**的验收，以及发布相关的收尾：

| # | 事项 | 为什么还没做 |
|---|---|---|
| 1 | 在干净虚拟机里跑一遍 7-Zip（机器级 MSI）：只弹一次 UAC、装完能激活、卸载干净 | 需要 UAC 与写 HKLM，不能在本机做 |
| 2 | 在干净虚拟机里验证"新开终端 `node -v` 生效" | 需要一台没装过 Node 的机器 |
| 3 | 为 exe 申请代码签名（SignPath，开源免费） | 需要项目方账号与 CI 凭据 |
| 4 | 把 `publish` 指向真实仓库，让更新检查有可用的 `latest.json` | 仓库还没有远程地址 |
| 5 | 逐项实测并修正清单里的 `installScope`（当前只有 7-Zip 是机器级，其余均已在真机验证为用户级） | 需要多台干净机器 |

> 每完成一项，把实测命令与输出补进 [docs/VERIFICATION.md](./docs/VERIFICATION.md)。

---

## 附录：变更记录

| 版本 | 变更 |
|---|---|
| v0.1 | 初稿：定位、范围、FR-1~FR-14、技术架构、manifest 格式、里程碑、风险 |
| v0.2 | 最低系统定为 Win10 22H2；新增 FR-2 版本选择、FR-15 清单热更新；确认测试环境与 git init |
| v0.3 | **修复 7 个架构级缺口**：新增 §6.6 提权模型、§6.7 环境变量规范、FR-16 卸载、FR-17 续跑、FR-18 预检、FR-19 下载器、§7.4 InstallPlan；manifest 补 `installScope`/`provider`/`releaseDate`/`uninstall`/`template` 并修正 registry 检测示例；FR-15 增加安全边界；**修正 14 处自相矛盾**（winget 理由、Homebrew、Choco、20 分钟、FR-11 顺序、i18n 回退、镜像回退次数、压缩说明等）；新增 §11 开发环境与工程规范（含测试与 CI 策略） |
| v0.4 | M0 完成。新增 **13.3 架构确认**：确立「安装 ≠ 激活」原则；把 M1 拆成 M1a（ZIP + 用户级，免提权）与 M1b（MSI/EXE + 提权，虚拟机验收）；风险表补充镜像版本滞后与镜像速度差异（均为实测数据） |
| v0.5 | **M1a~M4 主体完成**。清单扩到 19 项（16 项可装）；安装模板扩到 8 个（zip / zip 单文件 / 7zSFX / MSI / NSIS / Inno / Python / rustup）；新增激活机制（junction + 用户 PATH/环境变量 + 精确回滚）、预设、卸载、镜像源、离线包、系统配置（FR-6）、清单热更新（FR-15，字段白名单）、提权助手（§6.6，一次 UAC）、更新检查（FR-13，提示式）、CI + 发布流水线。新增 **13.4 更新机制确认**。实测记录见 docs/VERIFICATION.md |
