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
- IPC 面：**46 个请求-响应方法 + 2 个推送通道 = 48 个白名单通道**（`src/shared/ipc.ts`，实测逐一清点）—— 全部一一映射，无遗漏路径

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
│     └─ devkit-app/             # Tauri 壳：46 commands + 2 events + AppState
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
| `devkit-core` | plan/preflight（规则部分）/executor/downloader/providers/installer/providers/templates/presets/profile/offline/hotupdate/updater/settings/config/report/vscode | reqwest(rustls), sha2, hex, zip, tokio, futures | 对应 13 个模块 |
| `devkit-sys` | 注册表、PATH/环境变量、Junction、UAC 提权、进程探测、WM_SETTINGCHANGE、还原点、卸载登记 | windows, windows-registry, junction | `activate/` `detect/` `doctor/` `systemconfig/` `uninstall/` `elevation/` |
| `devkit-app` | Tauri commands（46 个）、事件转发（2 个）、AppState、窗口/托盘/single-instance | tauri 2, tokio | `index.ts` `ipc/`；日志为手写 Logger（D5） |

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
| 25 | `ipc/` + `index.ts` + `utils/` | 1,745 | devkit-app | 46 commands；`validate.ts` 被 serde 替代（结构性强类型 = 天然校验）；`utils/exec.ts` → `CommandRunner` trait | 0（契约测试新增） |
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
| `ipcMain.handle(IPC.x)` + `validate.ts` 手写校验 | `#[tauri::command]` + serde 反序列化（类型不符即拒绝，错误信息结构化） | 46 → 46 |
| `IPC.logLine`（ipcRenderer.on） | `app.emit("log-line", LogEntry)` ↔ renderer `listen("log-line")` | 1 |
| `IPC.installProgress` | `app.emit("install-progress", InstallProgressEvent)` | 1 |
| `contextBridge.exposeInMainWorld('devkit', api)` | **删 preload**；renderer 侧 `tauri-adapter.ts` 实现 `DevkitApi` | 1 文件 |

### 适配层（关键设计）

现状 `DevkitApi` 类型在 `src/shared/api.ts`（48 个成员 = 46 个请求-响应方法 + 2 个订阅器），renderer 全部调用点写的是 `window.devkit.xxx()`。迁移做法：

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
  // ...46 个方法一一对应，签名与 DevkitApi 完全一致
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

> **✅ R0 已完成（含端到端冒烟）**：`pnpm dev:tauri` 起窗 → vite 5173 → WebView2 加载 renderer → 适配层安装 → `get_app_info`/`signal_ready` IPC 往返成功（主进程打印 `[devkit] renderer ready`，该日志在 `render(<App/>)` 之后才会出现，证实 React 树挂载成功）。偏离与实测取值见附录 E.1/E.2/E.4 注记。

- 新建 `src-tauri/` workspace（5 个 crate 空壳 + `tauri.conf.json` + capabilities）
- renderer 从 electron-vite 迁出：拆出纯 vite 配置（`vite.renderer.config.ts`），dev 模式 `tauri dev` 挂载现有 renderer
- 1 个 `ping` command + `get_app_info`（真实实现）打通 dev 环境
- CI 增加 rust job（fmt/clippy/test）
- **验收**：`pnpm dev:tauri` 打开窗口，显示现有 UI（数据空壳），46 命令中 1 个真实可用；CI 双绿
- **tag**：`rust-r0`

### R1 — 类型与清单

> **✅ R1 已完成**：验收逐项达成：① 25 份随包清单全部通过 Rust 校验器（`cargo test --test manifest_contract`，含 8+3 份双向契约 fixture）；② TS 侧 `vitest` 契约测试读取同一批 fixtures + Rust 回写产物（`src/main/core/manifest/contract.test.ts`，4 用例）；③ `cargo fmt/clippy/test` + `tsc×3` + `eslint` + 全量 vitest 722 通过全绿。实现与偏离见附录 E.5。

- `devkit-types` 全量 serde 类型 + 契约 fixture 建立（§8）
- `devkit-manifest` 迁移（schema 校验 + 热更新白名单 + 版本比较）
- `scripts/check-manifest.ts` 的 Rust 等价版（`devkit-manifest` 附带 bin）
- **验收**：25 个清单 JSON 全部通过 Rust 校验，与 TS 版 `manifest:check` 结果一致；契约测试全绿
- **tag**：`rust-r1`（已打）

### R2 — 下载与安装（零风险闭环）

> **✅ R2 已完成（含真实安装验收）**：devkit-core 新增 11 个模块（checksum/direct/downloader/exec/executor/http/manifest_fns/placeholders/plan/templates/zip_extract），166 测试全绿，`cargo clippy --workspace --all-targets -- -D warnings` 0 错。验收逐项达成：① dry-run（zip 模板无安装器命令、不落盘，对齐 TS `buildCommand ?? null` 语义）；② 真实装一次 Node v24.21.0 ZIP（npmmirror 直连 37.6MB → sha256 校验 → 解压 1994 文件/107MB → 解压出的 `node.exe --version` 输出 v24.21.0；复跑命中幂等缓存 612ms）；③ pending.json 读写与 TS 版双向兼容（R2 plan.rs 阶段的 fixtures）。真实安装测试保留为 `#[ignore]` e2e（`cargo test -p devkit-core --test real_node_install -- --ignored`）。实现与偏离见附录 E.7。

- downloader（断点续传/镜像回退/代理/SHA-256）+ providers(Direct) + installer(zip) + plan + executor 状态机
- 对应 vitest 断言迁移（这四块测试量最大）
- **验收**：dry-run + 真实装一次 Node ZIP（对齐 M1a 验收路径）；pending.json 读写与 TS 版双向兼容
- **tag**：`rust-r2`

### R3 — 检测与报告

> **✅ R3 已完成**：devkit-core 新增 4 模块（detect/preflight/report + devkit-sys registry），204 测试全绿，clippy -D warnings 0 错。真机验收（`cargo test -p devkit-core --test real_machine -- --ignored`）：git→VersionMismatch(2.47.1.windows.2)、node→VersionMismatch(22.23.2)、不存在工具→NotInstalled、本机预检 6 项全 Ok（build 26300 直读注册表）。偏离与决策见附录 E.8。

- detect（注册表直读）、preflight、report（markdown）、日志流
- 前端 `getAppInfo`/`runDetection`/`listManifests`/`tailLog` 等只读命令接通 → **UI 第一次「完全可用」（只读面）**
- **验收**：本机检测结果与 TS 版逐项一致（同一台机器，diff 两份报告）
- **tag**：`rust-r3`

### R4 — 系统写入面

> **✅ R4 已完成**：devkit-core 新增 6 个模块（activate/{mod,paths,index,machine_path,verify,window_env} + app_paths + elevation 接口 + systemconfig/{mod,registry,backup} + uninstall/{mod,registry} + doctor/{mod,paths}）与 devkit-sys 新增 3 个模块（registry/user_env/junction），297 测试全绿，clippy -D warnings 0 错。真机验收：① 体检探针（`cargo test -p devkit-core --test real_doctor -- --ignored`）在本机捕获真实脏 PATH（KingbaseES 残留条目 → Error）、npm 双路径歧义（→ Warn）、PowerShell 策略读不到（如实报“读不到”，不猜值）；② reg.exe HKCU 自建键 add→read→delete→read 往返；③ 机器 PATH 真实读取（reg query HKLM）+ 同步算法纯逻辑覆盖；④ junction 创建/切换/删除真机验证（R4 activate 生命周期测试，DEVKIT_APP_DATA/DEVKIT_DATA_ROOT 沙箱）。实现与偏离见附录 E.9。

- activate（PATH/Junction/快照）、systemconfig（env 备份/还原）、doctor（诊断+修复）、uninstall
- 拒绝规则测试先于实现（硬规矩 2/6）
- **验收**：PATH 追加去重、备份还原、junction 切换、卸载 4 条真机路径；对应 TS 版行为回放对比
- **tag**：`rust-r4`

### R5 — 提权与全命令面收口

> **✅ R5 已完成**：devkit-core 新增 9 个模块（settings、config、presets、profile、vscode、hotupdate、updater、offline、elevation/{mod,helper_script,run_job}）+ devkit-sys 新增 random，347 测试全绿（Rust）+ vitest 545 全绿，clippy/fmt/tsc×3/eslint 全绿。全命令面 46 命令 + 2 事件接入（src-tauri/src/main.rs），渲染端 tauri-adapter.ts 全量 invoke 化（`notImplemented` 清零）。UAC/SHA-256 复验/nonce 三条虚拟机实测顺延 R7（本机开发环境无法完整弹 UAC，提权规则已在单元层覆盖，见 E.10）。实现与偏离见附录 E.10。

- elevation（§6.5 不变式逐条验收）、offline、hotupdate、updater、presets、profile、vscode、settings、config(mirrors)
- 46 个 command + 2 个 event 全部实现（逐条对照附录 A 勾销）；适配层完成，renderer 全部调用点无感切换
- **验收**：UAC 单次弹窗、SHA-256 复验、nonce 校验三条实测（虚拟机）；`security-regression` 三条全部在 Rust 侧重建立并通过
- **tag**：`rust-r5`

### R6 — 打包与发布

- tauri bundler 产出 NSIS；manifest 内嵌方案落地；release.yml 改造（签名步骤对 tauri 产物）
- latest.json 更新链路实测（TS 版 v0.6.2 → Rust 版）
- **验收**：安装包体积记录（目标 ≤15MB）；旧版升级路径实测
- **tag**：`rust-r6`

> **✅ R6 已完成**：tauri bundler NSIS 产物实测 6.12 MiB（含内嵌 WebView2 bootstrapper + 图标，≤15MB 目标达成）；manifest 编译期内嵌（D10）+ 打包态启动实测（signal_ready 到达、退出码 0）；NSIS 静默安装实测（HKCU Uninstall 注册项 + 安装目录正确）；`manifest-check` bin 与 `make-update-index` 子命令落地并实测（latest.json 含 sha256/size/runtime:"tauri"）；release.yml 改造为 Tauri 单形态（签名链路对准 bundle/nsis 产物，签名后自动重算索引）；docs/CODE-SIGNING.md 增加 Tauri 产物 hash 提交章节；tauri-plugin-dialog 接入（E.10 偏离 4 已解决）。旧版升级路径实测顺延 R7 虚拟机端到端（见附录 E.11）。实现与偏离见附录 E.11。

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

## 13. 未决问题（1/3/4 已在附录 H/I 敲定；2/5 留待 R6 实测定案）

1. **portable 产物口径**（R6，未决）：Tauri 无官方 portable target；「单 exe 无外置资源」是否满足原 portable 用户预期，需实测后决定是否保留该 target
2. **manifest 内嵌 vs 外置**（R6，未决）：倾向内嵌 + override（决策 D10），但首发保留外置方案作为 fallback 更稳
3. **scripts/ 6 个 TS 工具脚本**：**已敲定全部 Rust 化**，逐个去向与阶段见附录 H（`devkit-cli` 各子命令）
4. **E2E（Playwright）**：**已敲定不引入**（决策 D13）；R7 验收以「真机手工清单 + VERIFICATION.md」为准
5. **WebView2 bootstrapper**（R6，未决）：默认内置（决策 D14），体积增量 R6 实测记录

---

## 附：本方案依赖的事实基线（2026-11 实测）

- 代码规模：`src/main/core` 16,832 行；`ipc` 763；`utils` 801；`preload` 143；`shared` 1,649；renderer ~4,100
- 测试：44 文件 / 541 用例全绿（`pnpm test`，15.4s）；typecheck / lint 零错误
- IPC：46 个请求-响应方法 + 2 个推送通道 = 48 个白名单通道（`src/shared/ipc.ts`）
- `preload/index.ts` 暴露 48 个成员（46 方法 + 2 订阅器，`onLogLine`/`onInstallProgress`）
- 清单：25 个工具 JSON + schema（`resources/manifest/`）
- renderer 无 Electron 专有 API（`nodeIntegration:false`，纯 Web 标准）——Tauri 迁移的直接依据

---

## 附录 A：IPC 全量映射表（46 请求-响应 + 2 推送，零删减）

> 事实来源：`src/shared/ipc.ts`（通道白名单）+ `src/shared/api.ts`（`DevkitApi` 48 成员）。
> Rust 命令名 = camelCase 去 `get/set` 语义化转 snake_case，一一对应、无动态拼接。
> **响应形状铁律**：域错误一律走响应结构体里的 `error` 字段（现状即如此），命令签名 `Result<T, String>` 仅在基础设施故障（panic/序列化失败）时返回 Err，由适配层转成 Promise rejection。

| # | DevkitApi 方法 | IPC 通道 | Rust command | 参数 → 响应 | 备注 |
| --- | --- | --- | --- | --- | --- |
| 1 | `getAppInfo` | `app:info` | `get_app_info` | → `AppInfo` | runtime 字段语义见附录 F.4 |
| 2 | `listManifests` | `manifest:list` | `list_manifests` | → `ManifestLoadResult` | |
| 3 | `runDetection` | `detect:run` | `run_detection` | `DetectRequest?` → `DetectionResult[]` | 空/缺省 = 全量 |
| 4 | `getLocale` | `locale:get` | `get_locale` | → `Locale` | |
| 5 | `setLocale` | `locale:set` | `set_locale` | `Locale` → `Locale` | 归一化后回写 |
| 6 | `tailLog` | `log:tail` | `tail_log` | `count?` → `LogEntry[]` | 读内存环形缓冲（附录 F.2） |
| 7 | `openLogDir` | `log:open-dir` | `open_log_dir` | → `bool` | opener::reveal_item_in_dir |
| 8 | `signalReady` | `app:renderer-ready` | `signal_ready` | → `bool` | |
| 9 | `prepareInstall` | `install:prepare` | `prepare_install` | `PlanSelection[]`, `dryRun?`, `availableToolIds?` → `PlanPreparation` | 计划留主进程，renderer 只拿 planId |
| 10 | `startInstall` | `install:start` | `start_install` | `planId` → `StartInstallResult` | planId 不匹配 = 拒绝 |
| 11 | `cancelInstall` | `install:cancel` | `cancel_install` | → `bool` | 取消不是错误（附录 C.1） |
| 12 | `getPendingPlan` | `install:pending` | `get_pending_plan` | → `PendingPlanLoad` | 三态 tagged enum |
| 13 | `discardPendingPlan` | `install:discard-pending` | `discard_pending_plan` | → `bool` | |
| 14 | `resumeInstall` | `install:resume` | `resume_install` | → `StartInstallResult` | FR-17 |
| 15 | `exportInstallReport` | `install:export-report` | `export_install_report` | → `string \| null` | 用户取消 = null |
| 16 | `listPresets` | `preset:list` | `list_presets` | → `Preset[]` | |
| 17 | `savePreset` | `preset:save` | `save_preset` | `PresetInput` → `Preset` | 现为 unknown，serde 强类型化 |
| 18 | `deletePreset` | `preset:delete` | `delete_preset` | `id` → `bool` | builtin 拒删 |
| 19 | `importPreset` | `preset:import` | `import_preset` | `PresetInput` → `Preset` | 同 17 |
| 20 | `getActivationSnapshot` | `activate:snapshot` | `get_activation_snapshot` | → `ActivationSnapshot` | |
| 21 | `activateVersion` | `activate:apply` | `activate_version` | `ActivateRequest` → `ActivateResult` | |
| 22 | `deactivateTool` | `activate:remove` | `deactivate_tool` | `toolId` → `{removed: string[], error: string \| null}` | 匿名形状 → 命名结构体 `DeactivateResult` |
| 23 | `listInstalled` | `installed:list` | `list_installed` | → `InstalledTool[]` | |
| 24 | `uninstallTool` | `uninstall:run` | `uninstall_tool` | `UninstallRequest` → `UninstallResult` | |
| 25 | `getSettings` | `settings:get` | `get_settings` | → `UserConfigView` | 含派生字段（附录 G） |
| 26 | `saveSettings` | `settings:save` | `save_settings` | `UserConfigPatch` → `UserConfigView` | 现为 unknown patch，逐字段校验 |
| 27 | `applyMirrors` | `mirrors:apply` | `apply_mirrors` | `MirrorSetting[]` → `MirrorApplyResult` | URL 过 MIRROR_URL_PATTERN |
| 28 | `openExternal` | `app:open-external` | `open_external` | `url` → `bool` | 只接受 https |
| 29 | `getVscodeStatus` | `vscode:status` | `get_vscode_status` | → `VscodeStatus` | |
| 30 | `listVscodeExtensions` | `vscode:list` | `list_vscode_extensions` | → `VscodeExtension[]` | |
| 31 | `installVscodeExtensions` | `vscode:install` | `install_vscode_extensions` | `ids: string[]` → `VscodeInstallResult` | |
| 32 | `checkForUpdate` | `update:check` | `check_for_update` | → `UpdateInfo` | latest.json 协议不变 |
| 33 | `downloadUpdate` | `update:download` | `download_update` | → `DownloadUpdateResult` | SHA-256 不过即丢弃 |
| 34 | `installUpdate` | `update:install` | `install_update` | `filePath` → `bool` | 只允许 updates 目录内 exe |
| 35 | `exportProfile` | `profile:export` | `export_profile` | `ExportProfileRequest` → `ExportProfileResult` | 弹保存对话框 |
| 36 | `importProfile` | `profile:import` | `import_profile` | → `ImportProfileResult` | 弹打开对话框 |
| 37 | `applyProfile` | `profile:apply` | `apply_profile` | `EnvProfile`, `ApplyProfileOptions` → `ApplyProfileResult` | |
| 38 | `runDoctor` | `doctor:run` | `run_doctor` | → `DoctorReport` | 只读 |
| 39 | `applyDoctorFix` | `doctor:fix` | `apply_doctor_fix` | `DoctorFixId` → `DoctorFixResult` | 先备份后改 |
| 40 | `getSystemConfig` | `system:status` | `get_system_config` | → `SystemConfigItem[]` | |
| 41 | `applySystemConfig` | `system:apply` | `apply_system_config` | `SystemConfigRequest` → `SystemConfigResult` | machine 项走提权 |
| 42 | `revertSystemConfig` | `system:revert` | `revert_system_config` | `SystemConfigRevertRequest` → `SystemConfigResult` | 无备份拒绝 |
| 43 | `runHotUpdate` | `manifest:hot-update` | `run_hot_update` | `url` → `HotUpdateResultView` | 白名单过滤 |
| 44 | `clearManifestOverride` | `manifest:clear-override` | `clear_manifest_override` | → `number` | 返回删除文件数 |
| 45 | `packOffline` | `offline:pack` | `pack_offline` | `OfflinePackRequest` → `OfflinePackResult` | L2/L3 排除必须可见 |
| 46 | `importOfflinePack` | `offline:import` | `import_offline_pack` | `packDir?` → `OfflineImportResult` | 匿名形状 → 命名结构体 |
| 47 | `onLogLine`（订阅器） | `log:line`（推送） | `listen("log-line")` | `LogEntry` 推送 | tauri `emit`，仅主进程发 |
| 48 | `onInstallProgress`（订阅器） | `install:progress`（推送） | `listen("install-progress")` | `InstallProgressEvent` 推送 | 每次全量 plan 快照 |

事件名约定：`log-line` / `install-progress`（tauri 事件名仅允许字母数字 `-` `/` `:` `_`，两者合法）。

---

## 附录 B：serde 契约（devkit-types 完整规格）

### B.1 全局规则（12 条，翻译时逐条对号）

1. **单一来源**：`devkit-types` 是 Rust 侧唯一类型来源；`src/shared/types.ts` 保留给 renderer，不新增字段。漂移由契约测试（R1 起）锁定。
2. **字符串枚举**：全部 `#[derive(Serialize, Deserialize)]` + `#[serde(rename_all = "kebab-case")]`，与 TS 字面量逐字对齐（`exe-nsis`、`version-mismatch`、`installed-by-devkit`…）。**例外**：`Locale`（`zh-CN`/`en-US` 含大写）用显式 `#[serde(rename = "zh-CN")]`；`LicenseTier`（`L1`/`L2`/`L3`）同理。
3. **TS 可选字段**（`field?: T`）→ `Option<T>` + `#[serde(skip_serializing_if = "Option::is_none")]`（TS `JSON.stringify` 会丢弃 undefined，Rust 写出必须同样省略该键）。
4. **TS 可空字段**（`field: T \| null`）→ `Option<T>` **不加** skip（TS 序列化时键恒在、值为 `null`，Rust 必须写出 `"error": null`）。判定口诀：**缺省省键，可空存 null**。
5. **数据存储结构体**（InstallPlan/EnvProfile/Preset/UserConfig 及其成员）加容器级 `#[serde(rename_all = "camelCase", default)]`，旧文件缺字段可读；**清单输入结构体**（ToolManifest 族）不加容器 default，必填字段缺失即报错（对齐 validate.ts）。
6. **未知字段**：默认忽略（对齐 TS 行为，pending.json 结构嗅探兼容）；仅清单校验路径加 `#[serde(deny_unknown_fields)]`。
7. **Record<string, X>** → `HashMap<String, X>`（fixture 比对用 `serde_json::Value` 相等，键序无关）。
8. **LocalizedText** 是动态键（`Partial<Record<Locale,string>> & Record<string,string|undefined>`）→ `pub struct LocalizedText(pub HashMap<String, String>)`，实现 `get(locale)` 复刻 `src/shared/localized.ts` 回退链：`zh-CN → en-US → 首个条目`。
9. **schemaVersion: 1** → `u8` + 自定义反序列化断言 `== 1`，其余值报结构化错误（TS 侧 `looksLikePlan` 同语义）。
10. **数值**：字节数一律 `u64`；ISO 时间戳保持 `String`（不做 chrono 转换，避免往返漂移）。
11. **MIRROR_URL_PATTERN** 原样搬进 `devkit-types::mirror`：`^https:\/\/[A-Za-z0-9._~:\/@!*,=+-]{3,200}$`（白名单字符集，不是黑名单——安全审查 H2 的教训），`save_settings` / `apply_mirrors` / hotupdate 白名单共用。
12. **反序列化失败**一律返回结构化错误并落日志，绝不 panic；错误文案保持 zh-CN（renderer 直接展示）。

### B.2 类型清单（TS 侧 83 个全部覆盖 + 新增 5 个，无遗漏）

> 来源：`src/shared/types.ts` 全量。要点列只写**例外**；未注明的结构体套用 B.1 默认规则（camelCase + kebab-case 枚举）。

| TS 类型 | Rust 类型 | serde 要点 |
| --- | --- | --- |
| `Locale` | `Locale` | 显式 rename `zh-CN`/`en-US` |
| `LocalizedText` | `LocalizedText` | HashMap 包裹 + `get()` 回退链（规则 8） |
| `ToolCategory` | `ToolCategory` | 7 变体 |
| `LicenseTier` | `LicenseTier` | 显式 rename `L1`/`L2`/`L3` |
| `ManifestStatus` | `ManifestStatus` | detect-only/ready |
| `InstallType` | `InstallType` | 7 变体；`exe-7zsfx` 等 kebab |
| `InstallScope` | `InstallScope` | user/machine |
| `RegistryDetectRule` | `RegistryDetectRule` | 字段 `match` 是 Rust 关键字 → `#[serde(rename = "match")] pub match_rules: HashMap<String,String>` |
| `DetectCommandSpec` | `DetectCommandSpec` | args/expectRegex 可选省键 |
| `DetectSpec` | `DetectSpec` | 三手段全可选 |
| `InstallSpec` | `InstallSpec` | params 可选省键 |
| `UninstallSpec` | `UninstallSpec` | template 可选省键 |
| `ActivateSpec` | `ActivateSpec` | 三字段全可选省键 |
| `ToolVersionSpec` | `ToolVersionSpec` | source/mirrors/install/uninstall/activate/configure/verify/recommended/dependsOn/releaseDate/sizeBytes/requiresReboot 均可选省键；channel/arch/installScope 必填 |
| `ToolManifest` | `ToolManifest` | deny_unknown_fields（规则 6）；homepage/license/provider/notes 可选省键 |
| `DetectionStatus` | `DetectionStatus` | 5 变体 |
| `DetectionResult` | `DetectionResult` | installedVersion/recommendedVersion/evidence/error 为 `\| null` 恒在 |
| `ManifestLoadError` | `ManifestLoadError` | |
| `ManifestLoadResult` | `ManifestLoadResult` | source 枚举 builtin/remote |
| `AppInfo` | `AppInfo` | 8 个字符串字段全必填 |
| `LogLevel` | `LogLevel` | debug/info/warn/error |
| `LogEntry` | `LogEntry` | 4 字段必填 |
| `DetectRequest` | `DetectRequest` | toolIds 可选省键 |
| `MirrorPreference` | `MirrorPreference` | 5 变体 |
| `PlanItemState` | `PlanItemState` | 9 变体 |
| `PlanItem` | `PlanItem` | downloadAttempts 可选省键；error/note/startedAt/finishedAt/installDir/archivePath `\| null` 恒在 |
| `PlanOptions` | `PlanOptions` | proxy `\| null` 恒在 |
| `PlanSummary` | `PlanSummary` | 5 个 u32 |
| `InstallPlan` | `InstallPlan` | schemaVersion 断言 ==1；容器 default |
| `PlanSelection` | `PlanSelection` | version 可选省键 |
| `PlanBuildError` | `PlanBuildError` | |
| `PreflightCheck` | `PreflightCheck` | level 枚举 ok/warn/error |
| `PreflightResult` | `PreflightResult` | |
| `PlanPreparation` | `PlanPreparation` | problems: `Vec<PlanBuildError>`（TS 现恒空，保留字段） |
| `InstallProgressDetail` | `InstallProgressDetail` | 三字段全可选省键 |
| `InstallProgressEvent` | `InstallProgressEvent` | currentItemId/detail `\| null` 恒在 |
| `PendingPlanLoad` | `PendingPlanLoad` | `#[serde(tag = "status")]` 三态：none/ok/invalid，untagged 候选（fixture 验证） |
| `StartInstallResult` | `StartInstallResult` | error 可选省键 |
| `Preset` | `Preset` | builtin bool |
| `ActivationRecord` | `ActivationRecord` | env HashMap |
| `ActivationSnapshot` | `ActivationSnapshot` | backupFile `\| null` 恒在 |
| `ActivateRequest` | `ActivateRequest` | |
| `ActivateResult` | `ActivateResult` | record/note/error `\| null` 恒在 |
| `InstalledTool` | `InstalledTool` | installedAt `\| null` 恒在 |
| `UninstallRequest` | `UninstallRequest` | |
| `UninstallResult` | `UninstallResult` | |
| `MirrorTarget` | `MirrorTarget` | 9 变体 |
| `MirrorSetting` | `MirrorSetting` | |
| `MirrorApplyResult` | `MirrorApplyResult` | |
| `UserConfigView` | `UserConfigView` | proxy/manifestHotUpdateUrl/updateFeedUrl/pathBackupFile/dataRoot `\| null` 恒在；dataRootSource 枚举 env/config/default |
| `EnvProfile` | `EnvProfile` | schemaVersion ==1；git.userName/Email `\| null`；mirrors[].url `\| null` |
| `ProfileToolState` | `ProfileToolState` | 4 变体 kebab |
| `ProfileDiffEntry` | `ProfileDiffEntry` | name `LocalizedText \| null` |
| `ProfileDiff` | `ProfileDiff` | summary 4 个 u32 |
| `ApplyProfileOptions` | `ApplyProfileOptions` | 4 bool |
| `ApplyProfileResult` | `ApplyProfileResult` | |
| `ExportProfileRequest` | `ExportProfileRequest` | |
| `ExportProfileResult` | `ExportProfileResult` | |
| `ImportProfileResult` | `ImportProfileResult` | profile/diff/error `\| null` |
| `DoctorLevel` | `DoctorLevel` | ok/warn/error |
| `DoctorCategory` | `DoctorCategory` | 5 变体 |
| `DoctorFixId` | `DoctorFixId` | 3 变体 kebab |
| `DoctorFix` | `DoctorFix` | scope user/machine |
| `DoctorFinding` | `DoctorFinding` | fix `\| null` |
| `PathEntryKind` | `PathEntryKind` | 5 变体 kebab |
| `PathEntryView` | `PathEntryView` | reason/duplicateOf `\| null` |
| `PathAnalysisView` | `PathAnalysisView` | counts: HashMap<PathEntryKind,u32> |
| `DoctorReport` | `DoctorReport` | |
| `DoctorFixResult` | `DoctorFixResult` | |
| `SystemConfigId` | `SystemConfigId` | 6 变体 kebab |
| `SystemConfigItem` | `SystemConfigItem` | backupAt `\| null`；revertible bool |
| `SystemConfigRevertRequest` | `SystemConfigRevertRequest` | |
| `SystemConfigRequest` | `SystemConfigRequest` | gitName/gitEmail/machinePathMode 可选省键 |
| `SystemConfigResult` | `SystemConfigResult` | |
| `VscodeCategory` | `VscodeCategory` | 8 变体 |
| `VscodeExtension` | `VscodeExtension` | |
| `VscodeStatus` | `VscodeStatus` | version/codePath `\| null` |
| `VscodeInstallResult` | `VscodeInstallResult` | failed: Vec<{id,error}> |
| `DownloadUpdateResult` | `DownloadUpdateResult` | filePath/verified/error 可空恒在 |
| `UpdateInfo` | `UpdateInfo` | latestVersion/downloadUrl/downloadSha256/sizeBytes/notes/error 可空恒在 |
| `HotUpdateResultView` | `HotUpdateResultView` | |
| `OfflinePackRequest` | `OfflinePackRequest` | outputDir 可选省键 |
| `OfflinePackResult` | `OfflinePackResult` | skipped: Vec<{id,tier,reason}> |
| （新增）`OfflineImportResult` | 命名化 TS 匿名形状 | ok/imported/missing/entries/error |
| （新增）`DeactivateResult` | 命名化 TS 匿名形状 | removed/error |
| （新增）`PresetInput` | savePreset/importPreset 入参 | 对齐 validate.ts 校验规则，失败返回域错误 |
| （新增）`UserConfigPatch` | saveSettings 入参 | 全字段 Option，逐字段校验（proxy 必须空或 http(s) URL、concurrency 1..=3、dataRoot 绝对路径） |
| （新增）`UserConfig` | config.json 持久化形状 | 13 字段，见附录 G |

### B.3 范式完整定义（InstallPlan 全家桶，其余按此机械翻译）

```rust
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use crate::{InstallScope, LicenseTier, MirrorPreference};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PlanItemState {
    Pending,
    Downloading,
    Verifying,
    Installing,
    Checking,
    Success,
    Failed,
    Skipped,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadAttempt {
    pub source: String,
    pub url: String,
    pub error: String,
}

/// TS PlanItem：可空字段恒在（null），可选字段（downloadAttempts）省键（规则 3/4）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PlanItem {
    pub id: String,
    pub version: String,
    pub tier: LicenseTier,
    pub install_scope: InstallScope,
    pub requires_admin: bool,
    pub requires_reboot: bool,
    pub depends_on: Vec<String>,
    pub state: PlanItemState,
    pub attempts: u32,
    pub error: Option<String>,      // TS: string | null —— None 序列化为 null，键恒在
    pub note: Option<String>,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub install_dir: Option<String>,
    pub archive_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub download_attempts: Option<Vec<DownloadAttempt>>, // TS 可选字段
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PlanOptions {
    pub concurrency: u32,               // 1..=3，executor 处再断言
    pub mirror_preference: MirrorPreference,
    pub proxy: Option<String>,          // TS: string | null
    pub create_restore_point: bool,
    pub dry_run: bool,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PlanSummary {
    pub total: u32,
    pub success: u32,
    pub failed: u32,
    pub skipped: u32,
    pub cancelled: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct InstallPlan {
    /// TS 字面量 1；其他值反序列化报错（规则 9）
    pub schema_version: u8,
    pub plan_id: String,
    pub created_at: String,
    pub devkit_version: String,
    pub manifest_revision: String,
    pub options: PlanOptions,
    pub items: Vec<PlanItem>,
    pub summary: PlanSummary,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanSelection {
    pub tool_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

/// TS 三态 tagged union：{status:'none'} \| {status:'ok',plan} \| {status:'invalid',reason}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum PendingPlanLoad {
    #[serde(rename = "none")]
    None,
    #[serde(rename = "ok")]
    Ok { plan: InstallPlan },
    #[serde(rename = "invalid")]
    Invalid { reason: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartInstallResult {
    pub started: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,          // TS 可选字段
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallProgressDetail {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub received: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<Option<u64>>,     // TS: number | null | undefined —— 双层 Option
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallProgressEvent {
    pub plan: InstallPlan,
    pub current_item_id: Option<String>, // TS: string | null 恒在
    pub detail: Option<InstallProgressDetail>,
}
```

注意 `Option<Option<u64>>`：TS `total?: number \| null` 的三态（缺省/有值/null）。serde 对外层 Option 加 skip 后：缺省省键、`Some(None)` 写出 `null`、`Some(Some(n))` 写出数字，逐一对齐。

---

## 附录 C：错误模型与日志规格

### C.1 错误模型（三层）

```text
1. IPC 边界（对 renderer 可见）
   └─ 域错误：响应结构体里的 error 字段（zh-CN 文案，UI 直接展示）——永远不抛
   └─ 基础设施故障：command 返回 Err(String) → 适配层转 Promise reject（频率极低）

2. crate 内部（跨模块）
   └─ thiserror enum DevkitError { Io, Registry, Junction, Http, Sha, Validation, Elevation, Cancelled, ... }
   └─ Display 实现输出 zh-CN 文案；由 app 层在边界处 map 进响应结构体

3. 日志
   └─ 全链路记录（含 thiserror #[source] 链）；不上传、不遥测（硬规矩 5）
```

**取消不是错误**：`cancel_install` 触发后，进行中项 `state=cancelled`，其余 `skipped`，响应 `ok`。对应现有语义。

**文案冻结**：现有 zh-CN 错误文案（`install:prepare` 的“没有待执行的安装计划”、`install:resume` 的计划失效文案、`revertSystemConfig` 的无备份拒绝文案、`activate:apply` 的 junction 拒覆盖文案）是测试锁定的契约，port 时逐字保留（R4/R5 验收项）。

### C.2 日志规格（与现状 1:1）

| 项 | 规格 | 现状来源 |
| --- | --- | --- |
| 落盘 | `%APPDATA%\devkit\logs\<timestampSlug>.log`，UTF-8，append | `report/logger.ts` |
| 行格式 | `[{ISO ts}] [{LEVEL:5}] [{scope}] {message}\n`（LEVEL 右填充空格至 5 列：`INFO` 后跟一个空格再接 scope） | 同上 |
| 内存环形缓冲 | 3000 条，`tail_log(count)` 只读缓冲（不读文件） | 同上 MAX_BUFFER |
| 实时推送 | 每条 `log()` → `log-line` 事件（`LogEntry{ts,level,scope,message}`） | 同上 |
| 启动时序 | 日志目录由 `devkit-app` 启动时注入 logger（不依赖 Tauri） | 设计对齐 |
| 实现选型 | **手写 `Logger` 结构体（~80 行）**，不用 tracing——现有行为是“无过滤/无 span/固定格式”，tracing 只会引入多余配置面 | **决策 D5** |

日志器放 `devkit-core::logging`，通过 `log-line` 广播通道解耦 app 层（测试可直接喂缓冲）。

---

## 附录 D：测试迁移映射（44 文件 / 541 用例，逐文件）

### D.1 主进程 37 文件 → cargo

| TS 测试文件 | Rust 目标位置 | 策略 |
| --- | --- | --- |
| `core/activate/paths.test.ts` | `devkit-sys/src/path_edit.rs` tests | 直译（纯逻辑） |
| `core/activate/junction.test.ts` | `devkit-sys/src/junction.rs` tests | 直译 + 真机 `#[ignore]` 用例 |
| `core/activate/machine-path.test.ts` | `devkit-sys/src/machine_path.rs` tests | 直译（拒绝规则先行） |
| `core/config/mirrors.test.ts` | `devkit-core/src/mirrors.rs` tests + `devkit-types::mirror` 测试 | 直译（URL 白名单正则逐用例） |
| `core/detect/registry-parse.test.ts` | `devkit-core/src/detect/parse.rs` tests | **保留语义，不保留代码**：直读注册表后解析层删除，仅保留“版本字段提取”与“WOW6432Node 差异”用例（决策 D6） |
| `core/doctor/fix.test.ts` | `devkit-sys/src/doctor_fix.rs` tests | 直译（备份先行断言） |
| `core/doctor/paths.test.ts` | `devkit-core/src/doctor/paths.rs` tests | 直译（PATH 脏数据 5 类判定） |
| `core/downloader/index.test.ts` | `devkit-core/src/downloader/` tests | 直译；HTTP 层用 mockito/wiremock 等价物（R2 选型） |
| `core/elevation/helper-script.test.ts` | `devkit-sys/src/elevation/job.rs` tests | 直译（job 序列化/分片/内联断言） |
| `core/elevation/run-job.test.ts` | `devkit-sys/src/elevation/run.rs` tests | 直译（nonce 校验/复验路径） |
| `core/hotupdate/whitelist.test.ts` | `devkit-cli`/`devkit-manifest` whitelist tests | 直译（字段白名单逐项） |
| `core/installer/placeholders.test.ts` | `devkit-core/src/templates/placeholders.rs` tests | 直译（占位符注入拒绝） |
| `core/installer/zip.test.ts` | `devkit-core/src/installer/zip.rs` tests | 直译（zip crate 行为差异处补用例） |
| `core/manifest/ai-manifests.test.ts` | `devkit-manifest/src/ai.rs` tests | 直译 |
| `core/manifest/prerequisites.test.ts` | `devkit-manifest/src/prereq.rs` tests | 直译 |
| `core/manifest/validate.test.ts` | `devkit-manifest/src/validate.rs` tests | 直译（拒绝规则最多的一份，逐断言） |
| `core/manifest/versions.test.ts` | `devkit-manifest/src/versions.rs` tests | 直译 |
| `core/offline/index.test.ts` | `devkit-core/src/offline.rs` tests | 直译（硬规矩 1 事故点，先读原实现再写） |
| `core/plan/index.test.ts` | `devkit-core/src/plan.rs` tests | 直译（pending.json 双向） |
| `core/preflight/index.test.ts` | `devkit-core/src/preflight/` tests | 直译 |
| `core/preflight/prerequisite-probe.test.ts` | `devkit-core/src/preflight/probe.rs` tests | 直译（CommandRunner mock） |
| `core/preflight/prerequisites.test.ts` | `devkit-core/src/preflight/prereq.rs` tests | 直译 |
| `core/presets/index.test.ts` | `devkit-core/src/presets.rs` tests | 直译 |
| `core/profile/index.test.ts` | `devkit-core/src/profile.rs` tests | 直译 |
| `core/providers/path-guard.test.ts` | `devkit-core/src/providers/guard.rs` tests | 直译（路径穿越拒绝） |
| `core/report/markdown.test.ts` | `devkit-core/src/report/markdown.rs` tests | 直译（golden 文本比对） |
| `core/security-regression.test.ts` | **拆散**：注入→templates、穿越→providers、提权→elevation | 三条安全用例各归其位，R5 验收逐条勾销 |
| `core/systemconfig/backup.test.ts` | `devkit-sys/src/systemconfig/backup.rs` tests | 直译（备份格式冻结） |
| `core/systemconfig/index.test.ts` | `devkit-sys/src/systemconfig/` tests | 直译 |
| `core/systemconfig/registry.test.ts` | `devkit-sys/src/registry.rs` tests | 直译（HKCU/HKLM 读写语义；真机用例 `#[ignore]`） |
| `core/templates/index.test.ts` | `devkit-core/src/templates/registry.rs` tests | 直译（命令拼装逐模板） |
| `core/templates/new-templates.test.ts` | 同上 | 直译 |
| `core/uninstall/registry.test.ts` | `devkit-sys/src/uninstall.rs` tests | 直译 |
| `core/updater/index.test.ts` | `devkit-core/src/updater.rs` tests | 直译（latest.json 解析/版本比较） |
| `utils/app-paths.test.ts` | `devkit-app/src/paths.rs` tests | 直译（dataRoot 优先级 env→config→default） |
| `utils/env-vars.test.ts` | `devkit-sys/src/env_vars.rs` tests | 直译（禁 setx 语义、REG_EXPAND_SZ） |
| `utils/exec.test.ts` | `devkit-sys/src/exec.rs` tests | **逐用例直译（含 GB18030 解码链与 cmd 回退白名单）**——最不能丢的一份，见附录 F.1 |

### D.2 shared 4 文件 → devkit-types

| TS | Rust | 策略 |
| --- | --- | --- |
| `shared/version.test.ts` | `devkit-types/src/version.rs` | 直译（semver 比较含预发布） |
| `shared/manifest.test.ts` | `devkit-types/src/manifest_index.rs` | 直译（indexById 等纯函数） |
| `shared/localized.test.ts` | `devkit-types/src/localized.rs` | 直译（回退链） |
| `shared/download-name.test.ts` | `devkit-types/src/download_name.rs` | 直译（文件名规则 = 缓存键，跨版本共享） |

### D.3 renderer 3 文件 → 留 vitest

`i18n/i18n.test.ts`、`store/app-store.test.ts`、`store/install-store.test.ts` 继续用 vitest：store 逻辑不变，`window.devkit` 由适配层注入（R0 起适配层可在 vitest 里 mock）。

### D.4 新增测试（Rust 侧，不计入 541）

| 测试 | 位置 | 作用 |
| --- | --- | --- |
| 契约 fixture 双向 | `src-tauri/tests/contract/` | 10 份 fixture（InstallPlan/pending/profile/preset/manifest 变体/LogEntry/InstallProgressEvent/UserConfig/MirrorSetting/ActivationRecord）→ serde 往返相等；TS 侧 vitest 读同一 fixture 校验 |
| 提权静态检查 | `devkit-sys/tests/elevation_static.rs` | 源码扫描：elevation 模块不得出现打开 job 文件的路径（不变式 1 机器化） |
| 零遥测依赖树 | CI workflow | `cargo tree` 断言无 telemetry crate；reqwest 仅限 downloader/updater/hotupdate 三模块（`cargo deny` 或脚本） |
| 适配层类型测试 | `src/renderer/src/api/tauri-adapter.ts` | `tsc --noEmit` 保证 `DevkitApi` 实现完整（46 方法全实现，缺一个编译报错） |

---

## 附录 E：R0 具体落地物（照抄即可开工）

### E.1 `src-tauri/Cargo.toml`（workspace 根）

```toml
[workspace]
members = [
  "crates/devkit-types",
  "crates/devkit-manifest",
  "crates/devkit-core",
  "crates/devkit-sys",
  "crates/devkit-app",
]
resolver = "2"

[workspace.package]
edition = "2021"
rust-version = "1.80" // std::sync::LazyLock（静态正则）需要 1.80
license = "MIT"

[workspace.dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
thiserror = "2"
tokio = { version = "1", features = ["rt-multi-thread", "macros", "time", "sync", "fs", "process"] }
tokio-util = "0.7"
reqwest = { version = "0.12", default-features = false, features = ["rustls-tls", "stream", "json"] }
sha2 = "0.10"
hex = "0.4"
zip = "2"
windows = { version = "0.58", features = ["Win32_Foundation", "Win32_UI_WindowsAndMessaging", "Win32_System_Threading", "Win32_System_Registry", "Win32_Storage_FileSystem"] }
windows-registry = "0.4"
junction = "0.3"
tauri = { version = "2", features = [] }
tauri-build = "2"
```

版本以 R0 当日 `cargo add` 稳定版为准；本条锁定的是"选哪个 crate"而不是"哪个版本"。

> **R0 实际落地偏离（已验证）**：`devkit-app` 不是 `crates/devkit-app`，而是 workspace 根包（`src-tauri/Cargo.toml` 同时是 `[package]` 与 `[workspace]`，四个子 crate 在 `crates/` 下）。原因：`tauri_build::build()` 在 `CARGO_MANIFEST_DIR` 找 `tauri.conf.json`，app crate 必须与 `tauri.conf.json`/`build.rs` 同目录。workspace 依赖集中声明不变；`[profile.release]` 也收在根包里。

### E.2 `src-tauri/tauri.conf.json`（v2 最小骨架）

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "devkit",
  "version": "1.0.0",
  "identifier": "<R0 时查 package.json build.appId 对齐>",
  "build": {
    "beforeDevCommand": "pnpm dev:renderer",
    "devUrl": "http://localhost:5173",
    "beforeBuildCommand": "pnpm build:renderer",
    "frontendDist": "../dist/renderer"
  },
  "app": {
    "windows": [{ "title": "devkit", "width": 1200, "height": 800, "minWidth": 960, "minHeight": 640 }],
    "security": { "csp": null }
  },
  "bundle": { "targets": ["nsis"], "icon": ["icons/icon.ico"] }
}
```

窗口尺寸/标题 R0 时从 `src/main/index.ts` 的 BrowserWindow 选项照抄（含 minWidth/minHeight）；CSP 保持现状（null）。

> **R0 实际取值（已验证）**：`identifier: "io.github.devkit"`（对齐 package.json `build.appId`）；`version: "0.6.2"`（与 package.json 同步，Rust 版首版 v1.0.0 在 R6 发布时改）；窗口 `1280×880 / min 1024×700`（src/main/index.ts:19-26）。`bundle.icon` R0 用 System.Drawing 生成的 32×32 占位 `icons/icon.ico`（tauri-build 生成 Windows 资源文件必需），**R6 换正式图标**。

### E.3 `src-tauri/capabilities/default.json`

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "windows": ["main"],
  "permissions": ["core:default", "core:event:default"]
}
```

原 preload 白名单（46 通道）由"只注册这些 command"天然实现——Tauri 只暴露 `invoke_handler` 里列出的命令，比 preload 白名单更硬。

### E.4 renderer 侧拆分（electron-vite → 纯 vite + tauri）

1. 新建 `vite.config.ts`：`root: 'src/renderer'`、`plugins: [react()]`、`base: './'`、alias `@shared` → `src/shared`、`@renderer` → `src/renderer/src`、`build.outDir: '../../dist/renderer'`
2. `package.json` 新增：`"dev:renderer": "vite"`、`"build:renderer": "vite build"`、`"dev:tauri": "tauri dev"`、`"build:tauri": "tauri build"`（`@tauri-apps/cli` 为 devDependency）
3. electron-vite 配置**保留不动**（TS 版可构建性承诺）；R7 统一删除
4. `src/renderer/src/main.tsx`：加一行 `installTauriBridge()`（仅当 `window.devkit` 不存在时安装，兼容 electron 模式调试）
5. `main.tsx` 与 `api/tauri-adapter.ts` 顶部需 `/// <reference path="…/preload/index.d.ts" />`（配 `@typescript-eslint/triple-slash-reference` 的行级豁免）：`import type {}` 形式无法让按文件分析的工具程序并入 `window.devkit` 全局声明，实测只有显式文件引用有效；项目 tsc 配置本就 include 了该声明文件，此处是工具兼容，非编译必需
6. `eslint.config.mjs` 的 `ignores` 加 `src-tauri/**`（tauri-build 会在 target/ 里生成临时 JS，TS lint 不该扫它）

### E.5 `devkit-app` 最小骨架（R0 验收物）

```rust
// src-tauri/crates/devkit-app/src/main.rs
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![get_app_info, ping])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[tauri::command]
fn ping() -> &'static str { "pong" }

#[tauri::command]
fn get_app_info(app: tauri::AppHandle) -> devkit_types::AppInfo {
    // runtime 字段语义见附录 F.4
    devkit_app::app_info(&app)
}
```

### E.6 `devkit-types` 骨架断言（R0 即建立漂移防线）

```rust
// devkit-types/src/lib.rs —— 48 通道成员清单，一处定义，适配层与命令注册共用
pub const IPC_METHOD_COUNT: usize = 46;
pub const IPC_PUSH_COUNT: usize = 2;
```

R0 时把附录 A 的 46 个通道名做成 `export const IPC` 的 Rust 镜像常量（`pub const IPC: IpcChannels`），并在 `tests/ipc_parity.rs` 里断言与 TS 侧逐字一致（R1 接入）。

### E.7 R2 落地物（devkit-core 全量核心，166 测试）

新增模块（`crates/devkit-core/src/`）：

| 模块 | 对齐 TS | 要点 |
| --- | --- | --- |
| `http.rs` | `downloader/http.ts` | reqwest 直连/代理；`shouldFollowRedirect` 跨源白名单 |
| `downloader.rs` | `downloader/index.ts` | 断点续传（`.part` + `.part.json`）、镜像回退、SHA-256、速度哨兵（32KB/s + 15s 宽限）、idle timeout、幂等复用；`PipeCtx` 打包流式写入参数 |
| `checksum.rs` | `downloader/checksum.ts` | sha256 流式（sha2） |
| `exec.rs` | `utils/exec.ts` | GB18030 解码链、cmd `/d /c` 回退 + 白名单、超时 kill、CancellationToken；`.cmd/.bat` 主动走回退（不先试后错，与 TS 行为一致） |
| `templates.rs` | `installer/templates.ts` | 12 模板 + 参数校验（deny 未知键 + 正则值）+ `build_command` / `build_extract_plan`；`ResolvedTemplate.extract` 装 zip 类计划 |
| `zip_extract.rs` | `installer/zip.ts` | strip 解压、防路径逃逸（`..` 与绝对路径）、符号链接逃逸判定（`unix_mode << 16`）、overwrite 语义对齐 |
| `placeholders.rs` | `installer/placeholders.ts` | `{installDir}/{version}/{toolId}` + 未知占位符报错 |
| `direct.rs` | `providers/direct.ts` | `install_version` 全分支（exe-inno/nsis/sfx7z/msi/zip/zip-single/npm）、dry-run（zip 模板无预览、`log_file: None`，对齐 TS `buildCommand ?? null`）、`remove_install_dir` 逃逸防护、`resolve_npm_cmd`（激活根最新版本优先 → npm.cmd 回退）、`UserPathHooks`（R4 接实现） |
| `plan.rs` | `plan/*.ts` | `build_plan`（检测归零/concurrency clamp/dry_run 继承）、pending.json 读写与 TS 双向兼容（fixtures 互验） |
| `executor.rs` | `executor/index.ts` | 状态机：单项失败不中断/依赖跳过（计划外依赖视为已满足）/机器级串行（`admin_lock`）/安装≠激活回调/幂等跳过/取消/依赖环检测/emit 快照；双层 `tokio::spawn` 捕 panic 保证单项失败可控 |
| `manifest_fns.rs` | `shared/manifest.ts` | `order_download_sources`（枚举偏好置首）/`pick_recommended_version`/`index_by_id` |

验收（`cargo test -p devkit-core --test real_node_install -- --ignored --nocapture`，npmmirror 国内直连）：

1. SHASUMS256.txt 拿官方 sha256（downloader 的 sha256 为空会校验失败，不能跳过）
2. 下载 node-v24.21.0-win-x64.zip（37.6MB，复跑命中幂等缓存 612ms）
3. dry-run：zip 模板不落盘、无预览命令
4. 解压 1994 文件 / 107MB（strip=1）
5. 自检：解压出的 `node.exe --version` → `v24.21.0`（安装≠激活：绝对路径，不碰 PATH）

偏离：`MirrorPreference` 是固定枚举（official/huaweicloud/aliyun/tuna/ustc），TS 是 string union —— serde kebab-case 双向一致，语义无差；executor 的 panic 重试语义：TS 无对应（任务级 panic 在 JS 里是进程级），Rust 用内层 spawn 捕获并标记该项失败，不中断整体。

### E.8 R3 落地物（检测与报告）

| 模块 | 对齐 TS | 要点 |
| --- | --- | --- |
| `detect.rs` | `detect/*` | 注册表 4 组扫描结果 + 版本语义化比较 + match 规则（`(?i)` 大小写不敏感）；programs 由调用方传入（扫一次共用） |
| `preflight.rs` | `preflight/*` | 6 项系统预检（磁盘/OS 版本/长路径/开发者模式…），severity 序号 = TS SEVERITY_ORDER |
| `report.rs` | `report/*` | markdown 报告生成 + timeutil（`iso8601_now`/`iso8601_from_unix`/`timestamp_slug_from_unix`） |
| `settings.rs` | `settings/*` | UserConfig 读写（附录 G 13 字段全 default） |
| `logging.rs` | `report/logger.ts` | 手写 Logger（决策 D5：tokio tracing 不满足行级 tail 订阅），日志文件 + broadcast 订阅 |
| `devkit-sys/registry.rs` | `detect/registry.ts` | Windows API 直读 4 组卸载键（HKLM/HKCU × 32/64 视图），实证 `/reg:32` 对字面 WOW6432Node 路径不做二次重定向 |
| `tests/real_machine.rs` | — | #[ignore] 真机断言：git/node 版本比较、本机预检全 Ok |

### E.9 R4 落地物（系统写入面）

新增模块：

| 模块 | 对齐 TS | 要点 |
| --- | --- | --- |
| `app_paths.rs` | `utils/app-paths.ts` | dataRoot 三级优先级（env → override → `%USERPROFILE%\.devkit`）、current/versions/downloads/backup 等全部路径函数；ENV_TEST_LOCK 防测试间环境变量竞争 |
| `activate/paths.rs` | `activate/paths.ts` | `%DEVKIT_HOME%` 变量展开、PATH 条目归类 |
| `activate/index.rs` | `activate/index.ts` | activated.json 读写（TS 双向兼容）、activate_version（junction 拒覆盖 + PATH 备份 `user-path-<ts>.txt`）、deactivate、prune；4 场景生命周期测试（默认/激活后切换/自激活冲突/用户自定义 DEVKIT_HOME） |
| `activate/machine_path.rs` | `activate/machine-path.ts` | 机器 PATH 同步（add/remove 计划 → 提权写入注入 → 复验失败中止）、`%DEVKIT_HOME%` 归类、reg query 读原文 |
| `activate/verify.rs` | `activate/verify.ts` | where.exe 解析 + junction 目标核对 |
| `activate/window_env.rs` | `activate/windows.ts` 用户面 | HKCU 环境读写注入（devkit-sys user_env） |
| `elevation.rs` | `elevation/*` 接口 | ElevatedStep/ElevatedRunner trait + NoElevation 如实报错占位（R5 接真提权助手） |
| `systemconfig/registry.rs` | `systemconfig/registry.ts` | toRegPath/toPsPath、parse_reg_dword（非 DWORD 不猜）、is_missing_value_error；HKCU 真机往返测试 |
| `systemconfig/backup.rs` | `systemconfig/backup.ts` | system-config.json 账本（首写胜出、existed 区分、损坏按空）、serde tag=kind 与 TS camelCase 双向兼容 |
| `systemconfig/mod.rs` | `systemconfig/index.ts` | 状态 6 项 + apply（git 身份/执行策略/ssh-key/machine-path/long-paths/developer-mode）+ revert（三条硬规矩：无备份不动手/复验/成功后销账）|
| `uninstall/registry.rs` | `uninstall/registry.ts` | split_windows_command、find_uninstall_entry（与检测同规则）、plan_uninstall（MSI GUID 键名 → msiexec /x）、复验记录消失 |
| `uninstall/mod.rs` | `uninstall/index.ts` | list_installed（VERSION_DIR 白名单）、uninstall_version（registry 型先卸 MSI 再删目录，失败中止）、prune_dangling_links |
| `doctor/paths.rs` | `doctor/paths.ts` | PATH 纯分析：expand_with_report（unresolved 优先于结构判定）、classify_structural_problem（D:\go 合法）、looks_truncated 只作补充提示、保守 suggested |
| `doctor/mod.rs` | `doctor/index.ts` + `fix.ts` | run_doctor（7 组只读检查、evidence 逐条人话）+ 三个修复（先备份/复验/空值拒绝） |
| `devkit-sys/user_env.rs`、`junction.rs` | — | HKCU 环境读写、junction 创建/删除 |

偏离与决策：① 测试环境变量竞争——同进程并行测试会互相改写 DEVKIT_APP_DATA，曾把测试状态写进真实 %APPDATA%，修复为 `app_paths::ENV_TEST_LOCK` 串行化 + 测试保存/恢复原值（教训已写入注释）；② sync_machine_path 只算不写，提权与激活记录由调用方注入（对齐文档注入原则，R5 接真助手后由应用层组装）；③ `%DEVKIT_HOME%` 展开为真实数据根（激活记录与 PATH 里都不写绝对路径，对齐 TS 现行为）；④ 机器 PATH 读原文用 reg.exe query（类型可能是 REG_EXPAND_SZ，值含空格不能按空白切）；⑤ 体检的系统项复用 systemconfig 只读状态，本机 PowerShell Security 模块不完整时如实显示“读不到”而不是猜值。

---

## 附录 F：运行时语义规格

### F.1 CommandRunner（对齐 `src/main/utils/exec.ts`，逐条不可丢）

```rust
pub struct RunResult {
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
    pub spawn_error: Option<String>,
    pub duration_ms: u64,
}
```

铁律（每条都有现有测试锁定）：

1. **不带 shell** 启动（`Command::new`）；默认超时 10s；超时 kill 并置 `timed_out`
2. **取消信号**触发时 kill 子进程（对应 AbortSignal）
3. **GB18030 解码链**：stdout/stderr 字节先试严格 UTF-8 → 失败退 GB18030（GBK 超集）→ 最后 latin1 兜底。中文 Windows 的 cmd 报错是 GBK，直接 `from_utf8_lossy` 会出乱码（现有实现有针对性注释与用例）
4. **cmd.exe 回退**：仅当 spawn 报 ENOENT 或（EINVAL 且目标 `.cmd`/`.bat`）时，改用 `cmd.exe /d /c <cmd> <args...>`（**不带 `/s`**——`/s` 会剥掉首尾引号，带空格路径直接失败，原注释有实测记录）
5. **回退前白名单校验**（正则逐字搬）：
   - 命令路径：`^[^"&|<>^%!\r\n\t]+$`（只禁 cmd 元字符与引号，**不禁空格与中文**）
   - 参数：`^[^\s"&|<>^%!()*?\r\n\t]+$`（禁空白与元字符；中文路径必须放行——`C:\Users\张三\.devkit\...` 是常态）
   - 不满足 → 拒绝执行并附明确原因（绝不“尽力而为”地拼命令）
6. `duration_ms` 从调用开始计（含回退重试耗时）

### F.2 安装执行器（`core/executor/` 语义）

| 语义 | 现状 | Rust 版 |
| --- | --- | --- |
| 单飞 | `controller !== null` ⇒ `isInstalling()` | `AppState.install: Mutex<Option<InstallRun>>`；第二次 start 返回“已有安装任务正在进行中” |
| 计划归属 | 计划存主进程，renderer 只持有 planId（防篡改） | 同名结构体 `InstallRun { plan, cancel: CancellationToken, progressed: AtomicU64 }` |
| 取消 | `AbortController.abort()` → 各阶段检查 | `tokio_util::sync::CancellationToken`；下载循环/等待子进程处 select |
| 进度节流 | 下载 detail 高频、状态变化逐条 | 保持：download 阶段 ~200ms 合并；状态迁移即时发 |
| 并发 | `concurrency` 1..=3 | `futures::stream::buffer_unordered`，上限断言 |
| 续跑 | 启动写 pending.json，成功删除 | 同 |
| 状态机 | pending→downloading→verifying→installing→checking→success/failed/skipped/cancelled | 枚举同名，迁移边沿测试逐条 |

### F.3 单实例与窗口

- `tauri-plugin-single-instance`：第二次启动聚焦既有窗口（对应 `requestSingleInstanceLock`），插件在 `main.rs` 最先注册
- 窗口选项（size/minSize/title/背景色）R0 时从 `src/main/index.ts` BrowserWindow 配置照抄
- `signal_ready` 保留：renderer 挂载后回执，主进程记一次日志（对齐现状三端链路自检）

### F.4 AppInfo runtime 字段（决策 D16）

| 字段 | TS 现状 | Rust 版取值 |
| --- | --- | --- |
| `electronVersion` | Electron 版本 | `tauri <version>`（键名保留，值如实） |
| `nodeVersion` | Node 版本 | `rustc <version>` |
| `chromeVersion` | Chrome 版本 | WebView2 运行时版本（注册表 `HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}\pv`） |
| `isPackaged` | `app.isPackaged` | `!cfg!(debug_assertions)` |
| `manifestDir` | resourcesPath/manifest | 用户 override 目录或内置（附录 G） |

---

## 附录 G：数据文件兼容清单（双向读取，fixture 锁定）

| 文件 | 路径 | 形状 | 兼容规则 |
| --- | --- | --- | --- |
| `config.json` | `%APPDATA%\devkit\` | `UserConfig` 13 字段：locale / autoUpdate / manifestHotUpdate / manifestHotUpdateUrl / updateFeedUrl / concurrency / createRestorePoint / mirrorPreference / proxy / activateAfterInstall / configureMirrors / mirrors / dataRoot | 全字段 serde default；新增字段必须带 default（旧 TS 版也能读新文件） |
| `pending.json` | `%APPDATA%\devkit\` | **裸 `InstallPlan`**（无包装层） | schemaVersion==1 + planId + items[].id/state 结构嗅探（对齐 `looksLikePlan`）；不合规则返回 `invalid` 不删除 |
| `activated.json` | `%APPDATA%\devkit\` | 激活记录（形状以 `activate` 模块 `readActivationState` 为准，R1 fixture 采样） | 字段级向后兼容；不认识的记录保留不删 |
| `backup\env-*.json` | `%APPDATA%\devkit\backup\` | systemconfig 备份（形状以 `systemconfig/backup.ts` 为准） | **格式冻结**：还原必须能读 TS 版写的备份 |
| `presets\*.json` | `%APPDATA%\devkit\presets\` | `Preset`（builtin=false） | 内置预设 builtin=true 不可删 |
| `manifest\` | `%APPDATA%\devkit\manifest\` | 热更新后的 `ToolManifest` 文件集 | 优先级：用户 override > 内置（决策 D10） |
| `logs\*.log` | `%APPDATA%\devkit\logs\` | 行文本（附录 C.2） | 只追加；`tail_log` 不读文件 |
| `versions\<tool>\<version>\` | `<dataRoot>` | 目录布局 | **冻结**：装过的机器升级后直接可用 |
| `downloads\` / `current\` / `updates\` / `bin\` | `<dataRoot>` | 缓存 / junction 根 / 更新包 / 预留 shim | 文件名规则 = `download-name`（单测移植） |
| `offline\` | `%APPDATA%\devkit\offline\` | 保存对话框默认位置 | — |

dataRoot 解析优先级（对齐 `app-paths.ts`）：`DEVKIT_DATA_ROOT` 环境变量 → `config.json` 的 `dataRoot` → `%USERPROFILE%\.devkit`。`UserConfigView.effectiveDataRoot`/`dataRootSource` 必须如实反映来源。

---

## 附录 H：scripts 处置（敲定 §13 第 3 条）

现状 6 个 TS 脚本，全部 Rust 化，不做双维护：

| 脚本 | 去向 | 阶段 |
| --- | --- | --- |
| `scripts/check-manifest.ts` | `devkit-manifest` 的 bin `manifest-check`（CI 调用点改为 cargo run） | R1 |
| `scripts/refresh-manifests.ts` | `devkit-cli refresh-manifests`（发版流程用） | R2 |
| `scripts/install-tool.ts` | `devkit-cli install <tool>@<version>`（顺带补上 SPEC FR-11 欠的 CLI） | R2 |
| `scripts/detect-report.ts` | `devkit-cli detect-report` | R3 |
| `scripts/make-update-index.ts` | `devkit-cli make-update-index` | R6 |
| `scripts/verify-update.ts` | `devkit-cli verify-update` | R6 |

`package.json` 的 `manifest:check` 等条目逐阶段改指向；TS 脚本在 R7 删除。缓与下载必须与 GUI 共用同一 downloader 规则（现 `install-tool.ts` 已有此教训：曾与 GUI 各下一份）。

---

## 附录 I：决策记录（ADR 摘要，迁移期有异议先看这里）

| # | 决策 | 理由 | 替代方案与否决原因 |
| --- | --- | --- | --- |
| D1 | renderer（React 19 + antd 6）零重写 | 无 Electron 专有 API，纯 Web 标准 | 纯 Rust GUI 需重写 4.1k 行 + 丢掉 antd 生态 |
| D2 | 46+2 通道全映射，零删减 | 每个通道都有 UI 调用点，删任一即功能缺失 | 合并通道 → 适配层变复杂，收益为零 |
| D3 | serde 强类型替代 `validate.ts` | 类型即校验；三处 `unknown` 入参（savePreset/saveSettings/importPreset）类型化为 PresetInput/UserConfigPatch | 保留手写校验 = 两份知识（违反硬规矩 1） |
| D4 | 域错误走结构体 `error` 字段，不走 `Err` | renderer 现有处理全部基于 `{ok,error}` 形状 | 改成 throw 需动 40+ 调用点，且丢错误分类 |
| D5 | 手写 Logger，不用 tracing | 行为固定（缓冲 3000/固定格式/广播），tracing 增配置面无收益 | tracing 后期可随可观测性需求引入 |
| D6 | 注册表直读（windows-registry），删 reg.exe 解析层 | 消灭子进程 + 文本解析一半代码 | 保留 reg.exe = 保留 GBK 解析与引号陷阱 |
| D7 | “禁 setx” = HKCU\Environment 直写 REG_EXPAND_SZ | 保留“追加去重、绝不整体覆盖”语义 | setx 会截断/膨胀变量（现有硬规矩 2 的起因） |
| D8 | 提权 = 同 exe `--elevated-worker` + 内联 job | 不变式 1（不落盘）天然满足；单次 UAC | 拆 helper exe → 多一个可被替换的二进制面 |
| D9 | 更新协议 latest.json 不变，**不引 tauri-plugin-updater** | 静默替换二进制违背“不静默”与零遥测；旧版→新版升级路径因此打通 | 插件版会绕过确认提示 |
| D10 | manifest 内嵌（include_dir）+ 用户 override 优先 | 单 exe 便携；热更新语义不变 | 外置资源 = 多一份丢失风险（R6 验证后备选） |
| D11 | portable 口径 R6 实测定案（§13-1） | Tauri 无官方 portable target | — |
| D12 | 6 个脚本全部 Rust 化（附录 H） | 单一知识源；顺带补 CLI | 双维护 = 规则第二次漂移的入口 |
| D13 | 不引入 E2E（Playwright/WebDriver） | 验收以真机清单 + VERIFICATION.md 为准 | 新基建成本 > 收益（现状本就未启用） |
| D14 | 默认内置 WebView2 bootstrapper | Win10 22H2 已内置但旧镜像可能缺；体积增量 R6 记录 | 不内置 → 部分机器启动即挂 |
| D15 | GB18030 解码链原样保留 | 中文 Windows cmd 报错是 GBK，lossy UTF-8 出乱码 | 强制命令侧 UTF-8 需改所有调用点，超范围 |
| D16 | AppInfo 三个 runtime 字段保留键名、值如实（附录 F.4） | renderer 直接展示，不改 UI | 改键名 = 动 renderer（违背 D1） |
| D17 | 清单 schema 仅镜像 `tool.schema.json`；`test/*`、`tiers/*` 不进 Rust | Rust 校验器只需发布路径验收集；layers/tiers 校验规则已在 TS 侧 runValidation 内复刻 | 全量镜像 = 维护两份同义 schema |
| D18 | 契约 fixture 用 Python/Node 结构化生成，不手写反斜杠 JSON | 手写 `\\bin` 反复变控制字符（\b）导致 serde 拒收 | 手写转义 = 不可靠；重建脚本一次性验证回读 |

## 附录 E.5：R1 具体落地物（已完成）

### 新增 crate 实现

| 模块 | 内容 |
| --- | --- |
| `crates/devkit-types/src/` | `lib.rs`（AppInfo/Preset + re-export）、`locale.rs`（LocalizedText 回退链）、`ipc.rs`（46+2 通道常量）、`jsonrpc.rs`（IpcError/JsonRpcError/ErrorCodes）、`plan.rs`（InstallPlan/PlanItem/PlanOptions/Preflight 等，SchemaVersion 数字 1 自定义 Serialize+Deserialize）、`timeutil.rs`（iso8601_now/from_unix，civil 算法，无 chrono） |
| `crates/devkit-manifest/src/` | `lib.rs`（deserializer with deny_unknown_fields + manifest-path 白名单入口）、`schema.rs`（结构化 SchemaError→domainError 25xx 映射）、`validate.rs`（serde 规则 + 4 项语义检查：ready-sha256/url-http/template/locateDepth≤2）、`locate.rs`（{var}/{key}/{key.path} 嵌套展开，anchor 冲突同 TS）、`compare.rs`（SemVer 预发布字典序）、`order.rs`（channel/locale/mirror 优先级） |

### 契约 fixtures（§8 双向，两侧共用同一批文件）

- 位置 `src-tauri/tests/contract/fixtures/`；`accept-*` ×3 / `reject-*` ×10：两侧校验器必须一致接受/拒绝
- `pending-plan.json`（TS 形态，含 null）→ Rust 读入回写 → `generated-pending-plan.json`（测试运行时生成）
- Rust：`tests/manifest_contract.rs`（真实清单 25 份过校验器 + fixtures 方向一致 + pending 双向 roundtrip null 归一化比对）
- TS：`src/main/core/manifest/contract.test.ts`（同 fixtures 过 Ajv validateManifests + 读 Rust 回写产物 looksLikePlan）

**验收证据**：`cargo fmt/clippy/test` 全绿（manifest_contract 4 用例）；`tsc×3 + eslint` 全绿；vitest 722/722（新增 4 契约用例）；25/25 真实清单过 Rust 校验器。

### 偏离记录（与正文/附录 A 的差异）

1. schema 镜像范围：只迁移 `resources/manifest/schema/tool.schema.json` 对应的结构规则；`schema/test/*`（阶段子 schema）与 `tiers/*` 不进 Rust（D17）——TS 侧 runValidation 的 tier/layer 规则已在 `devkit-manifest::validate` 语义检查内复刻。
2. `SchemaVersion` 自定义 Serialize 输出数字 `1`（derive 默认会写成字符串 `"One"`，已修）。
3. fixture 编写教训（D18）：手写含 `\bin` 的 JSON 反斜杠会被部分工具转成退格控制字符，改用 Python `json.dump` 结构化重建（`D:/AgentWork/tmp/rebuild_fixture*.py`，一次性）。
4. 附录 A「manifest.schema.json」实际文件名为 `tool.schema.json`（本附录为准）。
5. bin `manifest-check`（附录 H 行）顺延到 R2 起（本阶段以 cargo test 承担 CI 校验职责，`scripts/check-manifest.ts` TS 版保持原状可用）。

## 附录 E.10：R5 落地物（全命令面 + 系统写入面收口，已完成）

### 新增模块

| 模块 | 对应 TS | 内容 |
| --- | --- | --- |
| `devkit-core/src/settings.rs` | `settings/*` | config.json 读写（camelCase serde + deny_unknown_fields + 未知键保留回写）、locale 回退链、concurrency 夹取 1..=3 |
| `devkit-core/src/config.rs` | `config/mirrors.ts` | apply_mirrors（npm/git/pip 三处写入 + 回读验证），写成功才回 true |
| `devkit-core/src/presets.rs` | `presets/*` | 内置 9 预设 + 用户预设 CRUD（dataRoot/presets/）、导入（rejects 未知 schemaVersion） |
| `devkit-core/src/profile.rs` | `profile/*` | collect/sanitize/describe/apply 四件套；`%DEVKIT_HOME%` 归一化；PATH 还原先备份；git 身份默认不导出 |
| `devkit-core/src/vscode.rs` | `vscode/*` | 状态探测（code.cmd 存在性）、扩展列表（--list-extensions）、批量安装（--install-extension 逐个） |
| `devkit-core/src/hotupdate.rs` | `hotupdate/*` | 远端清单拉取 → 逐份校验（复用 devkit-manifest）→ 用户清单目录原子写入；拒绝项逐条列原因 |
| `devkit-core/src/updater.rs` | `updater/*` | latest.json 拉取 → SemVer 比较 → 下载 + sha256 复验 + 原子落盘（update/ 目录） |
| `devkit-core/src/offline.rs` | `offline/*` | pack（按 selections 复制下载缓存 + 生成 pack.json）与 import（校验 sha256 → 拷回 download 目录） |
| `devkit-core/src/elevation/{mod,helper_script,run_job}.rs` | `elevation/*` | 真提权：PowerShell Start-Process -Verb RunAs 单次弹窗、helper 脚本（SHA-256 白名单 + nonce 回执文件）、run_job 编排；不变式四条逐一单测（nonce 不匹配拒绝 / sha256 不匹配拒绝 / 步骤非空 / 输出文件限 temp） |
| `devkit-sys/src/random.rs` | — | 随机 nonce（BCryptGenRandom） |

### 应用层（devkit-app）

- `src-tauri/src/main.rs`：46 命令 + 2 事件全部实现（附录 A 逐条勾销）；AppState 持有 CancellationToken 单飞闸（同时只允许一个安装任务）；`install-progress`/`log-line` 事件推送（broadcast → app.emit）。
- 渲染端 `src/renderer/src/api/tauri-adapter.ts`：44 个方法从 `notImplemented` 全量换成 `invoke(...)`，参数名与 Rust 端逐一对照（camelCase 自动映射 snake_case）；`notImplemented` 助手删除；`window.devkit` 存在时仍不覆盖（Electron 调试模式兼容）。

### 验收证据

- `cargo fmt --check` / `cargo clippy --workspace --all-targets -- -D warnings` / `cargo test --workspace`：347 通过 0 失败（修复 `registry_apply_with_fake_elevation` 并行争用下的断言分支：真实 reg.exe 查询偶发失败走「读不到就不改」是设计行为，断言已容忍）。
- `tsc×3 + eslint` 全绿；`vitest` 545/545。
- 修复 devkit-app `items_after_test_module` clippy 错误（`fn main` 移到 `mod tests` 之前）。

### 偏离与决策

1. **UAC 单次弹窗、SHA-256 复验、nonce 校验三条虚拟机实测顺延 R7**：本机开发环境无法完整走 UAC 弹窗流程；提权三条不变式已在单元层全覆盖（FakeElevation 注入），`tests/real_elevation.rs` 保留 `#[ignore]` 真机用例，R7 虚拟机端到端时一并执行。
2. `prepare_install` 的 `available_toolIds` 第三参删除：Tauri 参数名匹配对下划线前缀参数不可靠，且该参在 TS 版里仅用于 UI 过滤（由 renderer 自行过滤）。
3. `apply_profile` 命令名注册为 `apply_profile_command`：避免与 Tauri 内部宏展开的 `apply_profile` 符号冲突。
4. `export_profile`/`import_profile` 暂无文件对话框（tauri-plugin-dialog 未接入）：先用 dataRoot 固定路径 + 渲染端传参兜底，R6 接插件后换真实对话框。【已解决：R6 已接入 tauri-plugin-dialog，export_profile/import_profile 走原生保存/打开对话框（src-tauri/src/main.rs:1008、1043）】
5. `run_doctor` 读机器 PATH 在阻塞上下文里用独立线程 + 单线程 runtime 包 `machine_path::read_machine_path_raw()`（reg.exe 是阻塞进程调用，不能在 tokio worker 里同步等）。

---

## 附录 E.11：R6 落地物（打包与发布，已完成）

### 构建产物

- `pnpm build:tauri`（tauri bundler，targets=nsis）→ `src-tauri/target/release/bundle/nsis/devkit_1.0.0_x64-setup.exe`，实测 **6.12 MiB**（含内嵌 WebView2 bootstrapper 与应用图标；≤15MB 目标达成）。TS 版 electron-builder NSIS 产物约 80MB+，体积缩减一个数量级。
- `tauri.conf.json` 补齐两处：`bundle.icon = ["icons/icon.ico"]`（R0 占位图标本为空数组未生效）；`bundle.windows.webviewInstallMode = { type: "embedBootstrapper" }`（§11 风险 #6 的缓解项：安装包自带 WebView2 bootstrapper，旧镜像缺 WebView2 也能装）。
- 注意：embedBootstrapper 首次构建会从 go.microsoft.com 下载 bootstrapper（约 1.7MB，境外源），本机需走代理；CI runner 在海外直连即可。

### 清单内嵌与校验（决策 D10）

- `devkit-manifest` 用 include_dir 编译期内嵌 `resources/manifest` 全目录；`devkit_app::manifest_builtin_dir()` 内嵌优先、`resources/manifest` 兜底。打包态冒烟确认 21 个内嵌清单全部加载。
- 新增 `devkit-manifest` bin：`manifest-check`（src/bin/manifest-check.rs），规则与 TS `manifest:check` 一致（JSON Schema + 语义约束 + ID 唯一性），manifest_dir 逐级上溯兼容仓库根/src-tauri/crates 三种 cwd。release.yml 里 TS/Rust 两侧都跑。

### CLI 新增子命令（devkit-cli）

- `manifest-check`：无参，校验失败退出码 1。
- `make-update-index [--dir D] [--version V] [--runtime R|--no-runtime] [--notes N]`：镜像 `scripts/make-update-index.ts`（FR-13），扫描目录里 `*-setup.exe`（兼容 tauri 命名）与可选 portable，生成 latest.json（version/releasedAt/url/files/checksums/sizes/notes/runtime:"tauri"）。实测生成结果与 TS 协议字段一致。版本默认取 devkit-cli 的 CARGO_PKG_VERSION（1.0.0，与 tauri.conf.json 同步）。

### 打包态实测（本机开发环境）

1. `DEVKIT_SMOKE=1 DEVKIT_SMOKE_DELAY_MS=2000 target/release/devkit-app.exe` → `[devkit] renderer ready` + `[devkit] 冒烟通过` + 退出码 0（看门狗机制对齐 TS 版 DEVKIT_SMOKE）。
2. NSIS 静默安装 `devkit_1.0.0_x64-setup.exe /S` → HKCU `Uninstall\devkit` 注册项正确（DisplayName/MainBinaryName=devkit-app.exe/InstallLocation=%LOCALAPPDATA%\devkit/UninstallString），安装目录落盘 `devkit-app.exe`。
3. 安装目录下再次跑冒烟 → 通过。
4. 修复打包态启动 panic：`start_log_forwarder` 原用 `tokio::spawn`，setup 钩子不在 tokio runtime 上下文里，打包态启动即 panic（"there is no reactor running"）→ 改 `tauri::async_runtime::spawn`。dev 态因 devUrl 热加载路径不同未触发，属打包态专属问题。

### release.yml 改造（Tauri 单形态）

- 门禁：TS 四项（manifest:check/typecheck/lint/test）+ Rust 三项（fmt/clippy/test）+ Rust 侧 manifest-check；`ELECTRON_SKIP_BINARY_DOWNLOAD=1` 安装依赖（不再需要 electron.exe）。
- 版本号以 `tauri.conf.json` 为唯一来源（PowerShell ConvertFrom-Json 读取 → make-update-index --version）。
- 构建：`pnpm build:tauri`；索引：devkit-cli make-update-index；体积门禁：>15MiB 即 fail；冒烟：DEVKIT_SMOKE=1 跑 `src-tauri/target/release/devkit-app.exe`（Start-Process -Wait 退出码判定）。
- SignPath 签名链路：上传 `src-tauri/target/release/bundle/nsis/devkit-*-setup.exe` → 签名 → 替换 → **自动重跑 make-update-index**（签名改 PE 字节，SHA-256 必须重算，否则用户更新校验必失败）→ GitHub Release 上传 setup.exe + latest.json。便携版无对应物（tauri bundler 无 portable target），从发布文件清单移除。
- docs/CODE-SIGNING.md 新增「Tauri 产物（v1.0.0 起）的签名与 hash 提交」章节：路径对照表 + 手工发布五步（签名后必须重算索引）。

### 验收证据

- `cargo fmt --check` / `clippy -D warnings` / `cargo test --workspace`：347 通过（R5 基线持平，新增 make-update-index 的 find_artifacts 单测）。
- 本机实测：NSIS 构建 → 6.12 MiB；冒烟 exit 0；静默安装 + 注册表 + 安装目录冒烟复验全过；latest.json 生成字段齐全（sha256=10aded62…，size=6414980）。
- release.yml 本地无法完整验证（GitHub Actions 专属）：YAML lint + 每一步的命令均在本机逐一实测过（构建/索引/冒烟/门禁命令），签名段逻辑沿用原流程仅换路径。

### 偏离与顺延

1. **旧版升级路径实测（TS v0.6.2 → Rust v1.0.0）顺延 R7 虚拟机端到端**：latest.json 是远端 URL 协议，本机无 TS 版安装客户端可升级；协议字段已在单元测试对齐（devkit-core updater 测试），端到端升级留给 R7 干净虚拟机清单（与 UAC/SHA-256/nonce 三条同批）。
2. **便携版移除**：tauri bundler 无 portable target；TS 版 portable 用户改用 NSIS 安装包（卸载注册项齐全），或手动解压 NSIS（NSIS 支持静默装到自定义目录 /D=）。
3. **CI 暂保持双形态**（TS check/smoke + rust job），release.yml 已单形态；按计划 CI 收敛在 R7（删除 src/main、src/preload、electron 依赖后）。
