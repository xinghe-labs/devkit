# devkit · Rust 化迁移方案（Tauri 2）

> 状态：**方案定稿，待执行** · 基线版本 v0.6.2（TS/Electron）· 2026-11
>
> 本文档是迁移的**唯一依据**：每个阶段做什么、验收什么、哪些不变式不能破，都以此为准。
> 与 SPEC.md 冲突时，迁移期间以本文档为准；迁移完成后本文档归档，SPEC 重写。

---

## 0. 为什么迁移、预期什么

已确认的动机（按权重）：

| 动机 | Rust 化后的实际收益 | 诚实评估 |
| --- | --- | --- |
| 包体积 / 内存 | 安装包 ~100MB → **~10–15MB**；常驻内存 ~150–300MB → **~40–80MB**（WebView2 共享进程另计） | 收益确定，Tauri 的主要卖点 |
| 健壮性 / 类型安全 | serde 强类型反序列化**替代**手写的 `validate.ts` 入参校验；`Result` 强制错误处理；所有权消灭一类资源泄漏 | 收益确定；但**不会自动变安全**——硬规矩（§12）仍需人力执行 |
| 学习 / 练手 | 一次覆盖 win32 API、异步 IO、进程提权、serde、Tauri 的实际项目 | 成本最高的一项：Rust 异步 + win32 的坑不少，预留返工时间 |
| 性能 | 下载校验更快（sha2 硬件加速）、文件操作更快 | **收益有限**：当前瓶颈在网络与磁盘 IO，用户可感知的提升主要在启动时间（Chromium 冷启动消失）和内存 |

一句话：**主要买「体积/内存 + 类型安全」，性能是顺带，学习价值是隐性收益。**

### 迁移不改变什么（兼容性承诺）

- 用户数据目录 `%USERPROFILE%\.devkit\`（versions/backups/downloads/pending.json）**结构不变**——装过 TS 版的机器升级到 Rust 版后，已装工具、版本、备份全部可继续用
- `resources/manifest/` 协议不变（25 个工具 JSON + schema + 热更新白名单规则）
- 更新协议 `latest.json` **不变**——现役 TS 版（v0.6.x）能检测到并升级到 Rust 版（见 §9）
- CONTRIBUTING 的 6 条硬规矩继续生效（§12 给出 Rust 落地方式）

---

## 1. 技术选型论证

| 方案 | 判定 | 理由 |
| --- | --- | --- |
| **Tauri 2（选定）** | ✅ | Rust 重写 `src/main` 全部业务逻辑；React 19 + antd 6 renderer **原样保留**（实测无任何 Electron 专有 API，`nodeIntegration:false`，纯 Web）；包体积/内存收益最大；Windows 能力全部有成熟 crate |
| 纯 Rust GUI（egui/iced/slint） | ❌ 否决 | 现有 11 个组件 + 4 个 store（~4000 行）+ i18next 全部重写；antd 的表格/抽屉/表单生态没有等价替代，工作量为 Tauri 路线的 2–3 倍，且偏离「迁移」本质 |
| Rust 核心库 + CLI | ❌ 否决（一个要点可回收） | 产品定位是 GUI 一键部署；改成 CLI+壳会引入进程间实时进度协议的新复杂度。但 §4 的 `devkit-core` 分层让未来加一个 `devkit-cli` 成为顺手之事（SPEC FR-11 里欠的 CLI 可以借机补上） |

关键事实支撑：

- `src/main`（core 16,832 + ipc 763 + utils 801 + preload 143 + index 181 = **约 18,700 行**）是重写对象；`src/shared` 1,649 行中约一半是渲染进程也要用的 TS 类型/常量（保留）
- renderer（components 2,424 + store 1,502 + i18n 132 + App/main ≈ **4,100 行**）**零重写**，只改 `main.tsx` 一行 + 删 preload
- IPC 面：**47 个类型化方法**（`src/preload/index.ts`）+ 2 个推送通道（`logLine` / `installProgress`）—— 全部一一映射，无遗漏路径

---

## 2. 迁移总原则

1. **UI 原地不动**：renderer 代码只允许改「API 来源」一处（`main.tsx` 挂适配层），组件/store 一行不碰
2. **数据格式双向兼容**：InstallPlan / pending.json / profile / preset / manifest / 目录布局，Rust 版必须能读 TS 版写的数据，反之亦然（用 golden fixture 验证，见 §8）
3. **安全不变式等价移植**：提权模型的三条不变式（§6.5）是**验收项**，不是参考项
4. **main 上增量推进**（用户已确认）：`src-tauri/` 为纯新增目录，TS 版在整个迁移期保持可构建可发布；最终切换用独立 commit 删除 TS 主进程。每阶段结束打 tag（`rust-r0`…`rust-r6`），切换前打 `ts-final-0.6.2`
5. **每阶段门禁全绿**：`pnpm typecheck && pnpm lint && pnpm test`（TS 侧，随模块迁移逐步缩小范围）+ `cargo fmt --check && cargo clippy -D warnings && cargo test`（Rust 侧，随阶段扩大范围）
6. **一份知识一处实现**（硬规矩 1）：迁移期规则住在 Rust 侧，TS 侧冻结不改；发现 TS bug 不修，记入「迁移遗留清单」随模块 port 时一并处理

---

## 3. 目标架构

```text
devkit/
├─ src/                          # TS 版：迁移期原样保留，R7 删除 main/preload
│  └─ renderer/                  #   渲染进程：永久保留（React 19 + antd 6）
├─ src-tauri/                    # 新增：Rust workspace
│  ├─ Cargo.toml                 #   workspace 根
│  ├─ tauri.conf.json
│  ├─ capabilities/              #   Tauri 2 权限声明（替代 preload 白名单）
│  ├─ icons/
│  └─ crates/
│     ├─ devkit-types/           # serde 类型 + 常量（对齐 src/shared）
│     ├─ devkit-manifest/        # 清单加载/Schema 校验/热更新白名单
│     ├─ devkit-core/            # 纯业务逻辑，不碰 OS（可单测）
│     ├─ devkit-sys/             # 唯一允许直接调 Windows API 的层
│     └─ devkit-app/             # Tauri 壳：47 commands + 2 events + AppState
├─ resources/manifest/           # 不变（R6 起打进二进制 + 运行时 override）
├─ scripts/                      # TS 脚本逐步被 Rust bin 替代（manifest:refresh 等）
└─ .github/workflows/            # 增加 rust job；发布流水线改造（§9）
```

依赖方向（单向，禁止反向）：

```text
devkit-types ◄── devkit-manifest ◄── devkit-core ◄── devkit-sys ◄── devkit-app
      ▲                  ▲                 ▲
      └──────────────────┴─────────────────┘
        （types 是叶子；core 不依赖 sys —— 通过 trait 注入系统能力）
```

**关键分层决策**：`devkit-core` 不直接调任何 OS API，系统交互一律通过 trait（如 `trait CommandRunner`、`trait Registry`）由 `devkit-sys` 实现、`devkit-app` 组装。这对应 TS 版 `utils/exec.ts` 的注入模式，让 541 个用例里大部分「纯逻辑 + mock 系统」的测试可以低成本迁移（§8）。

---

## 4. Crate 划分

| crate | 职责 | 主要外部依赖（crate） | 对应 TS 模块 |
| --- | --- | --- | --- |
| `devkit-types` | 全部 serde 类型（InstallPlan、Manifest、Profile、Preset、Settings、ProgressEvent…）+ 错误类型（thiserror）+ 常量 | serde, serde_json, thiserror | `src/shared/types.ts` `ipc.ts` `version.ts` |
| `devkit-manifest` | 清单加载、JSON Schema 校验、热更新字段白名单、版本比较 | jsonschema（或自写校验）, serde_json | `core/manifest/` |
| `devkit-core` | plan/preflight（规则部分）/executor/downloader/providers/installer/providers/templates/presets/profile/offline/hotupdate/updater/settings/config/report/vscode | reqwest(rustls), sha2, hex, zip, tokio, futures, tracing | 对应 13 个模块 |
| `devkit-sys` | 注册表、PATH/环境变量、Junction、UAC 提权、进程探测、WM_SETTINGCHANGE、还原点、卸载登记 | windows, windows-registry, junction | `activate/` `detect/` `doctor/` `systemconfig/` `uninstall/` `elevation/` |
| `devkit-app` | Tauri commands（47 个）、事件转发（2 个）、AppState、窗口/托盘/single-instance | tauri 2, tokio, tracing-subscriber | `index.ts` `ipc/` |

> 备选：把 manifest 并进 core 省一个 crate。**建议保留独立 crate**——manifest 的 schema 校验与热更新白名单是安全关键，独立 crate 让 CI 可以单独跑它的测试矩阵（含 schema fixture）。

---

## 5. 模块 → Rust 对照表（全量）

行数为当前 TS 实现（含测试）。「测试」列给出该模块的 vitest 文件数 → 迁移目标。

| # | TS 模块 | 行数 | 目标 crate | 迁移要点 | 测试（文件数） |
| --- | --- | --- | --- | --- | --- |
| 1 | `core/activate/` | 1,681 | devkit-sys | PATH 切片/去重/还原；Junction 版本切换；`machine-path.ts` 写 HKLM（走提权）；激活快照 | 4 → cargo（拒绝规则优先） |
| 2 | `core/systemconfig/` | 1,395 | devkit-sys | HKCU/HKLM 环境变量读写；备份到 `backup/env-*.json`；还原；**禁 setx** 规则 | 4 |
| 3 | `core/doctor/` | 1,303 | devkit-sys + core（规则） | PATH 脏数据诊断（截断/拼错/重复/多副本）；fix 前备份后复验 | 4 |
| 4 | `core/preflight/` | 1,118 | devkit-core | 系统/磁盘/网络/权限/冲突检查；前置依赖探测（`prerequisite-probe` 走 trait 注入） | 5 |
| 5 | `core/downloader/` | 1,052 | devkit-core | 断点续传（Range）、镜像回退、SHA-256、代理、进度回调 → tokio + reqwest | 4 |
| 6 | `core/manifest/` | 944 | devkit-manifest | Schema 校验、热更新白名单过滤、AI agent 清单、前置依赖声明 | 4 |
| 7 | `core/config/` | 916 | devkit-core（mirrors）+ sys（少量） | npm/pip/maven 镜像源写入；git 全局配置 | 2 |
| 8 | `core/templates/` | 844 | devkit-core | **安装参数白名单模板**（安全关键）：模板注册表 + 占位符校验 | 2 |
| 9 | `core/elevation/` | 811 | devkit-sys | UAC 提权：见 §6.5，安全不变式原样保留 | 3 |
| 10 | `core/executor/` | 673 | devkit-core | 状态机、串行/并发≤3、取消、重试、续跑（pending.json） | 2 |
| 11 | `core/hotupdate/` | 656 | devkit-core | 清单热更新：字段白名单 + 签名/来源校验 | 2 |
| 12 | `core/installer/` | 644 | devkit-core | ZIP 解压（zip crate）、占位符、目录布局 | 2 |
| 13 | `core/profile/` | 565 | devkit-core | 环境档案导出/导入（JSON，不含密钥） | 1 |
| 14 | `core/uninstall/` | 536 | devkit-sys（registry）+ core | 按登记卸载；注册表登记读取 | 1 |
| 15 | `core/providers/` | 481 | devkit-core | DirectProvider（默认）、path-guard、scoop/winget 预留 trait | 2 |
| 16 | `core/offline/` | 473 | devkit-core | 离线包制作/导入（复用下载器缓存规则——**硬规矩 1 的原始事故点**，实现前先看 `offline/index.test.ts`） | 1 |
| 17 | `core/plan/` | 453 | devkit-core | InstallPlan 生成、待装项计算 | 1 |
| 18 | `core/detect/` | 421 | devkit-sys（registry）+ core（解析） | `registry-parse` 纯逻辑（现为 reg.exe 输出解析 → **改直读注册表后解析层简化**） | 2 |
| 19 | `core/report/` | 418 | devkit-core | 报告 markdown 渲染、日志、smoke 自检、renderer 错误上报 | 3 |
| 20 | `core/updater/` | 375 | devkit-core | **半自动更新**（刻意不用 electron-updater，见 SPEC §13.4——Rust 版同样**不引入 tauri-plugin-updater**，保持 latest.json 提示式协议，§9） | 2 |
| 21 | `core/presets/` | 285 | devkit-core | 内置 7 套预设 + 自定义预设导入导出 | 1 |
| 22 | `core/vscode/` | 266 | devkit-core | `code --list-extensions` / `--install-extension`（注入 CommandRunner） | 0 |
| 23 | `core/settings/` | 232 | devkit-core | 用户配置 `config.json` 读写 + 默认值 | 0 |
| 24 | `core/security-regression.test.ts` | — | 冻结为跨 crate 回归 | 提权/路径穿越/占位符注入等安全用例，**拆到对应 crate 逐一重建** | 1 |
| 25 | `ipc/` + `index.ts` + `utils/` | 1,745 | devkit-app | 47 commands；`validate.ts` 被 serde 替代（结构性强类型 = 天然校验）；`utils/exec.ts` → `CommandRunner` trait | 0（契约测试新增） |
| 26 | `preload/` | 143 | 删除 | 由 renderer 侧适配层（~80 行 TS）替代，见 §7 | 0 |

**总计**：重写 ~18.7k 行 TS → 预计 14–20k 行 Rust（业务逻辑密度更高，测试另计）。

---

## 6. Windows 能力映射

### 6.1 注册表

| 现状 | Rust 版 |
| --- | --- |
| `reg.exe query/add` 子进程 + 文本解析（`detect/registry-parse.ts`） | `windows-registry` crate 直读直写，类型化；消灭子进程与解析层一半代码 |
| HKLM 写入（需提权） | 提权 worker 内执行（§6.5），主进程只算值 |
| 备份原值到 JSON | 原样保留（`backup/env-*.json` 格式不变，两个版本互读） |

### 6.2 PATH / 环境变量

| 现状 | Rust 版 |
| --- | --- |
| `[Environment]::SetEnvironmentVariable(...,"User")`（禁 setx） | `HKCU\Environment` 直写 REG_EXPAND_SZ，**保留「追加并去重、绝不整体覆盖」语义** |
| 写前备份、写完复验、读不到原值就拒绝（硬规矩 2/6） | 同样的三步骤，写成 `devkit-sys` 里的一个可复用模块 + 拒绝规则测试 |
| `WM_SETTINGCHANGE` 广播（待实测项） | `SendMessageTimeoutW(HWND_BROADCAST, "Environment")` 原生调用，**顺手把 VERIFICATION §5 的待实测项验证掉** |

### 6.3 Junction / 版本切换

| 现状 | Rust 版 |
| --- | --- |
| PowerShell `New-Item -ItemType Junction`（`activate/windows.ts`） | `junction` crate（封装 `FSCTL_SET_REPARSE_POINT`）；或 `windows` crate 直接 DeviceIoControl。**先写「读回验证 + 拒绝覆盖非 junction 目录」的测试**（对应现有 `junction.test.ts`） |

### 6.4 进程探测与自检

| 现状 | Rust 版 |
| --- | --- |
| PowerShell `Get-Command` 探针 + 执行 `node -v` 类自检 | `std::process::Command` 直接执行目标 exe（自检本来就是绝对路径，不需 shell）；PATH 查找用 `where.exe` 语义自实现（`SearchPathW`）。**减少一层 PowerShell 依赖** |

### 6.5 UAC 提权（最高风险项，安全不变式必须原样保留）

现状实现（`core/elevation/`，此前安全审查修复过一版完整提权漏洞，模块头注释有完整教训）：

1. **不落盘**：助手脚本 + 作业数据一起内联进 `powershell -EncodedCommand`——提权进程除了命令行什么都不读
2. **一次 UAC 干完所有事**：所有需管理员的步骤（MSI 安装、写 HKLM、还原点）打包进一个提权进程顺序执行
3. **提权进程内复验 SHA-256**：`step.verifySha256` 在管理员侧再算一遍，防「下载后、提权前」调包
4. **nonce 校验结果**：结果只影响「成功/失败」结论，取得不到代码执行

Rust 版设计（**不变式 1–4 逐条对应**）：

```text
主进程（未提权）构造 ElevationJob（serde JSON）
  → ShellExecuteW(verb="runas", exe=自身, args="--elevated-worker <base64-json>")
  → 提权 worker 模式（同一 exe，入口分支）：只读 argv 里的作业，不读任何用户可写文件
  → 逐 step 执行：verifySha256 → exec(msiexec/installer) / 写 HKLM / Checkpoint-Computer
  → 结果写 %APPDATA%\devkit\elevation\result-<nonce>.json（nonce 由主进程生成并校验）
```

- 作业数据内联 argv：Windows 命令行上限 32767 字符。现状用 UTF-16LE base64（膨胀 2.67×）也受同一限制；Rust 版可直传 UTF-8 JSON（膨胀 1.33×，容量反而更大）。**超过阈值时拆成多个 job**（同现状 `run-job.ts` 的分片逻辑）
- 还原点 `Checkpoint-Computer` 没有原生 API → 提权 worker 内保留一次最小 PowerShell 调用（隔离在 `devkit-sys::elevation` 单文件）
- **验证基线**：`elevation/run-job.test.ts` + `helper-script.test.ts` 的断言逐条翻成 cargo test；再加一条「提权进程绝不打开 job 文件」的静态检查（clippy lint 或自定义测试扫源码）

### 6.6 其他

| 能力 | Rust 版 |
| --- | --- |
| HTTP 下载/镜像回退/代理 | reqwest（rustls，不依赖系统 OpenSSL）+ 断点续传 Range 语义原样保留 |
| SHA-256 | sha2（硬件加速） |
| ZIP | zip crate |
| 文件锁（single instance） | tauri-plugin-single-instance（可选，现状未见显式实现，机会补齐） |
| 托盘/通知 | tauri 内置 API（现状未用，不动） |

---

## 7. IPC 迁移（renderer 零改动方案）

### 契约映射

| 现状 | Rust 版 | 数量 |
| --- | --- | --- |
| `ipcMain.handle(IPC.x)` + `validate.ts` 手写校验 | `#[tauri::command]` + serde 反序列化（类型不符即拒绝，错误信息结构化） | 47 → 47 |
| `IPC.logLine`（ipcRenderer.on） | `app.emit("log-line", LogEntry)` ↔ renderer `listen("log-line")` | 1 |
| `IPC.installProgress` | `app.emit("install-progress", InstallProgressEvent)` | 1 |
| `contextBridge.exposeInMainWorld('devkit', api)` | **删 preload**；renderer 侧 `tauri-adapter.ts` 实现 `DevkitApi` | 1 文件 |

### 适配层（关键设计）

现状 `DevkitApi` 类型在 `src/shared/api.ts`，renderer 47 个调用点全部写的是 `window.devkit.xxx()`。迁移做法：

```ts
// src/renderer/src/api/tauri-adapter.ts（新增，~80 行）
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { DevkitApi } from '@shared/api'

const api: DevkitApi = {
  getAppInfo: () => invoke('get_app_info'),
  onLogLine: (cb) => {
    const un = listen<LogEntry>('log-line', (e) => cb(e.payload))
    return () => { void un.then((f) => f()) }
  },
  // ...47 个方法一一对应，签名与 DevkitApi 完全一致
}
export const installTauriBridge = (): void => { window.devkit = api }
```

```ts
// src/renderer/src/main.tsx 改动（唯一一处）
import { installTauriBridge } from './api/tauri-adapter'
installTauriBridge()
```

`DevkitApi` / `@shared/types` 全部保留（renderer 继续用）；Rust 侧 `devkit-types` 用 serde 结构体**对齐同一份 JSON**，靠 §8 的契约测试保证不漂移。命令命名：现 IPC 常量名（`appInfo`、`installPrepare`…）→ snake_case（`get_app_info`、`install_prepare`…），映射表 1:1 落在适配层，无动态拼接。

---

## 8. 测试迁移策略（541 用例 / 44 文件）

现状分布：**main 37 个测试文件 / shared 4 / renderer 3 / 541 用例**。目标：Rust 侧 `cargo test` 承接 41 个文件，renderer 3 个留 vitest。

| 类别 | 文件数 | 去向 | 方法 |
| --- | --- | --- | --- |
| 纯逻辑（manifest/downloader/plan/executor/templates/…） | 28 | cargo 单测 | 逐断言翻译；`describe/it` → `mod` + `#[test]` |
| **拒绝规则**（读不到就不改 / 无备份不还原 / 空值拒绝）——硬规矩 2/6 | 7 | cargo 单测，**每个模块先行** | **先写测试再 port 实现**；这是安全底线，不接受「后补」 |
| 安全回归（security-regression） | 1 | 拆散到各 crate | 路径穿越、占位符注入、提权文件读取三条各归其位 |
| Windows 集成（junction/machine-path/registry） | 5 | cargo 单测（mock 文件系统）+ 标记 `#[ignore]` 的真机用例 | 提权与真机用例在 CI 跳过，本地手动跑，结果记入 VERIFICATION.md |
| shared 纯函数（version/download-name/localized/manifest） | 4 | cargo 单测 | 直接翻译 |
| **renderer（app-store/install-store/i18n）** | 3 | **留 vitest** | store 逻辑不变，仅 mock 的 `window.devkit` 由适配层注入 |

### 契约测试（新增，最重要的一类）

TS↔Rust 共存期，用一个 fixture 目录 `src-tauri/tests/contract/fixtures/*.json` 承载真实样例（InstallPlan、pending.json、profile、preset、manifest 变体、LogEntry、InstallProgressEvent）：

- Rust 侧：`serde` 反序列化 + 序列化回写 → 与 fixture 逐字段比对
- TS 侧：vitest 读同一 fixture 用现有类型校验器过一遍
- **双向写兼容**：Rust 写出的 pending.json 必须能被 TS 版读入（迁移中断回退时不丢进度）

这套 fixture 同时是 §2「数据格式双向兼容」的验收物。

---

## 9. 打包、更新与发布

| 项 | 现状（electron-builder） | Rust 版（tauri bundler） |
| --- | --- | --- |
| 主产物 | NSIS setup.exe + portable.exe | NSIS setup.exe（保留）；「portable」= 单 exe + 资源内嵌，**行为差异需实测**（首个便携口径：exe 同目录无外置资源） |
| 资源（25 个 manifest JSON） | extraResources → `process.resourcesPath/manifest` | R6 前评估两方案：① `include_dir!` 打进二进制（热更新 override 落 `%APPDATA%` 覆盖）；② 外置目录保持现状。**倾向 ①**，热更新与用户手改清单的语义不变（override 优先级最高） |
| 更新机制 | 刻意半自动：拉 `latest.json` → 横幅提示 → 一键下载 + SHA-256 → 拉起安装包（SPEC §13.4） | **协议不变，实现重写**；明确**不引入 tauri-plugin-updater**（静默替换二进制，违背项目「不静默」承诺与零遥测原则）。旧 TS 客户端 → 新 Rust 版升级路径因此天然打通 |
| 签名 | SignPath + release.yml（已就位，未启用） | 同一 SignPath 流程对 tauri 产物签名；`docs/CODE-SIGNING.md` 增加 tauri 产物的 hash 提交步骤 |
| CI | ci.yml：lint+typecheck+test+manifest:check | 增加 `rust` job：`cargo fmt --check` + `clippy -D warnings` + `cargo test` + 契约 fixture 校验；TS job 在迁移期保留，R7 删除 |

版本号策略：Rust 版首版 **v1.0.0**（语义化里程碑：Electron → Tauri 是运行时替换，用户可见能力不变）；`latest.json` 增加 `runtime: "tauri"` 字段供灰度判断（可选）。

---

## 10. 分阶段计划（每阶段 = 1 个 commit 系列 + 1 次 tag）

> 节奏参考：每个 R 阶段预计 **1–2 次会话**，总工期约 **8–12 次会话**。每阶段完成即 `cargo test` 全绿 + TS 侧门禁全绿。

### R0 — 骨架（本次会话之后第一件事）

- 新建 `src-tauri/` workspace（5 个 crate 空壳 + `tauri.conf.json` + capabilities）
- renderer 从 electron-vite 迁出：拆出纯 vite 配置（`vite.renderer.config.ts`），dev 模式 `tauri dev` 挂载现有 renderer
- 1 个 `ping` command + `get_app_info`（真实实现）打通 dev 环境
- CI 增加 rust job（fmt/clippy/test）
- **验收**：`pnpm dev:tauri` 打开窗口，显示现有 UI（数据空壳），47 命令中 1 个真实可用；CI 双绿
- **tag**：`rust-r0`

### R1 — 类型与清单

- `devkit-types` 全量 serde 类型 + 契约 fixture 建立（§8）
- `devkit-manifest` 迁移（schema 校验 + 热更新白名单 + 版本比较）
- `scripts/check-manifest.ts` 的 Rust 等价版（`devkit-manifest` 附带 bin）
- **验收**：25 个清单 JSON 全部通过 Rust 校验，与 TS 版 `manifest:check` 结果一致；契约测试全绿
- **tag**：`rust-r1`

### R2 — 下载与安装（零风险闭环）

- downloader（断点续传/镜像回退/代理/SHA-256）+ providers(Direct) + installer(zip) + plan + executor 状态机
- 对应 vitest 断言迁移（这四块测试量最大）
- **验收**：dry-run + 真实装一次 Node ZIP（对齐 M1a 验收路径）；pending.json 读写与 TS 版双向兼容
- **tag**：`rust-r2`

### R3 — 检测与报告

- detect（注册表直读）、preflight、report（markdown）、日志流
- 前端 `getAppInfo`/`runDetection`/`listManifests`/`tailLog` 等只读命令接通 → **UI 第一次「完全可用」（只读面）**
- **验收**：本机检测结果与 TS 版逐项一致（同一台机器，diff 两份报告）
- **tag**：`rust-r3`

### R4 — 系统写入面

- activate（PATH/Junction/快照）、systemconfig（env 备份/还原）、doctor（诊断+修复）、uninstall
- 拒绝规则测试先于实现（硬规矩 2/6）
- **验收**：PATH 追加去重、备份还原、junction 切换、卸载 4 条真机路径；对应 TS 版行为回放对比
- **tag**：`rust-r4`

### R5 — 提权与全命令面收口

- elevation（§6.5 不变式逐条验收）、offline、hotupdate、updater、presets、profile、vscode、settings、config(mirrors)
- 47 个 command + 2 个 event 全部实现；适配层完成，renderer 47 个调用点无感切换
- **验收**：UAC 单次弹窗、SHA-256 复验、nonce 校验三条实测（虚拟机）；`security-regression` 三条全部在 Rust 侧重建立并通过
- **tag**：`rust-r5`

### R6 — 打包与发布

- tauri bundler 产出 NSIS；manifest 内嵌方案落地；release.yml 改造（签名步骤对 tauri 产物）
- latest.json 更新链路实测（TS 版 v0.6.2 → Rust 版）
- **验收**：安装包体积记录（目标 ≤15MB）；旧版升级路径实测
- **tag**：`rust-r6`

### R7 — 切换与验收

- 干净虚拟机端到端（顺带清 VERIFICATION §5 全部欠账）
- 删除 `src/main/` `src/preload/` + electron 依赖；`pnpm` 脚本与 CI 收敛为 Tauri 单一形态；SPEC/README 重写
- **切换前 tag**：`ts-final-0.6.2`（回退锚点）；切换后 tag：`v1.0.0`
- **验收**：VERIFICATION.md 全表复跑；CI 单形态全绿；README 警告项更新（签名/干净机器两条若完成则移除警告）

---

## 11. 风险清单与回退

| # | 风险 | 等级 | 缓解 |
| --- | --- | --- | --- |
| 1 | 提权模型移植走样（安全不变式破坏） | **高** | §6.5 四条不变式写成验收项 + 拒绝规则测试先行 + R5 单独 gate；模块头注释的漏洞教训整段翻译进 Rust 注释 |
| 2 | 直接 main 上改的残余风险 | 中 | 增量目录 + 每阶段 tag；TS 主进程在 R7 前始终可发布；切换用独立 commit（`ts-final-0.6.2` 可一键回退） |
| 3 | 类型漂移（TS JSON ↔ serde） | 中 | 契约 fixture 双向测试进 CI（R1 起） |
| 4 | Junction/注册表边界 case | 中 | 现有 5 个 Windows 测试文件的断言逐条翻译；真机用例 `#[ignore]` 手动跑并记录 |
| 5 | 命令行长度限制（提权作业内联） | 中 | 分片逻辑原样保留 + 新增超限拒绝测试；超限报错文案明确 |
| 6 | WebView2 运行时依赖（Tauri 需系统 WebView2，Win10 22H2 已内置但旧镜像可能缺） | 中 | 安装包内置 WebView2 bootstrapper（tauri 提供）；列入 R6 验证项 |
| 7 | 杀软对提权行为的态度变化 | 低 | Rust 单 exe 通常比 PowerShell 提权更少告警；签名仍是最优解（CODE-SIGNING 不变） |
| 8 | Rust 学习曲线导致的返工 | 低–中 | `devkit-core` 全用「同步 trait + 注入」规避 async 传染；只有下载/调度用 tokio；clippy 强制 |

回退路径（按粒度）：

1. 单个阶段出问题：删该阶段 commit（tag 粒度清晰）
2. 整体放弃：`git checkout ts-final-0.6.2 -- .` 或直接 `git reset --hard ts-final-0.6.2`（**破坏性，需显式确认**）
3. 已发布 Rust 版发现问题：旧 TS 末版安装包仍在 Release 里，`latest.json` 指回旧版即回滚分发（注意：需保留旧产物）

---

## 12. 六条硬规矩的 Rust 落地

| # | 规矩（CONTRIBUTING） | Rust 工程约束 |
| --- | --- | --- |
| 1 | 一份知识一处实现 | 共享规则全部收进 `devkit-core`：下载缓存命名、路径规范化、占位符展开各恰好一个模块；CR 检查「有没有第二份」 |
| 2 | 写操作：备份 → 复验 → 危险拒绝 | `devkit-sys` 提供 `write_with_backup()` 唯一入口，签名上强制三步骤；clippy 自定义 lint（或源码扫描测试）禁止裸写注册表函数 |
| 3 | 「已完成」必须是真的 | 本方案每个 tag 的验收标准即记录模板；VERIFICATION.md 条目必须附命令与输出 |
| 4 | 清单是数据不是代码 | `devkit-manifest` 校验器拒绝任意命令字段；模板注册表 = `devkit-core::templates` 里的显式 match（编译期穷尽） |
| 5 | 零遥测 | 依赖树审查：reqwest 只允许出现在 downloader/updater/hotupdate 三个模块（CI 用 `cargo tree` + 源码扫描断言）；无 telemetry crate |
| 6 | 读不到原值就不改 | `devkit-sys` 的写入 API 签名要求先 `read_original() -> Option<T>`，`None` 时返回 `Err`——类型系统层面强制 |

---

## 13. 未决问题（执行到对应阶段前必须敲定）

1. **portable 产物口径**（R6）：Tauri 无官方 portable target；「单 exe 无外置资源」是否满足原 portable 用户预期，需实测后决定是否保留该 target
2. **manifest 内嵌 vs 外置**（R6）：倾向内嵌 + override，但首发保留外置方案作为 fallback 更稳
3. **`scripts/` 下 5 个 TS 工具脚本**（manifest:refresh/detect-report/install-tool 等）是否一并 Rust 化：建议随 R1/R2 用同一套 crate 实现为 `devkit-admin` bin（顺带补上 SPEC FR-11 欠的 CLI）
4. **E2E（Playwright）**：现状未启用；Tauri 有 WebDriver 方案，但建议 R7 验收以「真机手工清单 + VERIFICATION.md」为准，不引入新 E2E 基建
5. **WebView2 bootstrapper**（R6）：按 tauri 官方 NSIS 集成方式评估体积增量

---

## 附：本方案依赖的事实基线（2026-11 实测）

- 代码规模：`src/main/core` 16,832 行；`ipc` 763；`utils` 801；`preload` 143；`shared` 1,649；renderer ~4,100
- 测试：44 文件 / 541 用例全绿（`pnpm test`，15.4s）；typecheck / lint 零错误
- IPC：47 个类型化方法（`src/preload/index.ts`）+ 2 推送通道（`src/shared/ipc.ts`）
- 清单：25 个工具 JSON + schema（`resources/manifest/`）
- renderer 无 Electron 专有 API（`nodeIntegration:false`，纯 Web 标准）——Tauri 迁移的直接依据
