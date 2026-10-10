# devkit

> 一键开发环境部署器 · One-click development environment deployer
>
> 在**一台什么都没装的新 Windows 电脑**上，用图形界面勾选需要的东西，一键把开发环境**装好、配好、验好**。

[![CI](https://github.com/REPLACE_ME/devkit/actions/workflows/ci.yml/badge.svg)](https://github.com/REPLACE_ME/devkit/actions/workflows/ci.yml)
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
| 装完自动配置（镜像源 / PATH / git / SSH / 代理） | ✗              | 部分           | ✓      |
| 安装后自检                                       | ✗              | ✗              | ✓      |
| 失败可定位、可续跑                               | ✗              | ✗              | ✓      |
| 多版本共存与切换                                 | 部分           | ✗              | ✓      |

---

## 当前状态

**M0 已完成**：应用骨架、清单体系、真实环境检测、中英双语界面。

| 里程碑 | 内容                                                  | 状态      |
| ------ | ----------------------------------------------------- | --------- |
| M0     | 骨架：窗口 + 清单加载与校验 + 真实环境检测 + i18n     | ✅ 已完成 |
| M1     | 单工具端到端：下载 → 校验 → 静默安装 → 配 PATH → 自检 | 🚧 进行中 |
| M2     | 清单扩到 ~20 项、预设、镜像源、系统配置、卸载、提权   | ⏳ 计划中 |
| M3     | 多版本切换、离线包制作器、并发安装                    | ⏳ 计划中 |
| M4     | NSIS + 便携版打包、自动更新、发布                     | ⏳ 计划中 |

> **M0 的清单是 `detect-only` 状态**：只能检测本机是否已安装，安装所需的下载地址与 SHA-256 尚未补齐（M1/M2 补）。
> 我们不填占位数据——Schema 会强制要求 `status: "ready"` 的清单必须带齐 `source.url`、`source.sha256`、`install.template`。

完整需求与设计见 [SPEC.md](./SPEC.md)。

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
pnpm manifest:check  # 校验所有清单是否符合 JSON Schema
pnpm build           # 构建（不打包）
pnpm dist            # 打包出 NSIS 安装版 + 便携版
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
  "status": "detect-only", // detect-only | ready
  "name": { "zh-CN": "Node.js", "en-US": "Node.js" },
  "description": { "zh-CN": "…", "en-US": "…" },
  "detect": {
    "commands": [{ "cmd": "node", "args": ["-v"], "expectRegex": "v\\d+\\.\\d+" }],
    "files": ["%ProgramFiles%\\nodejs\\node.exe"],
    "registry": [
      {
        "hive": "HKLM",
        "view": "64",
        "path": "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
        "match": { "DisplayName": "^Node\\.js" },
        "versionFrom": "DisplayVersion"
      }
    ]
  },
  "versions": [
    {
      "version": "24.21.0",
      "channel": "lts",
      "recommended": true,
      "arch": "x64",
      "installScope": "machine"
    }
  ]
}
```

### 两条硬性约定

1. **`installScope` 必须逐项声明**（`user` 或 `machine`）。
   不存在"全局用户级优先"——Node.js 的官方 MSI、PostgreSQL 的服务安装只支持系统级，一刀切会写错。
2. **安装参数只能引用代码内置的白名单模板**（`install.template`），清单无权自定义命令行。
   这是防止清单被投毒后变成任意命令执行的唯一有效手段。

---

## 许可证分级

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

## 设计上的几个刻意选择

| 决策                                   | 原因                                                          |
| -------------------------------------- | ------------------------------------------------------------- |
| 下载走官方安装包，而不是以 winget 为主 | winget 输出受系统语言影响、解析脆弱；无法控制校验和与镜像回退 |
| 主进程不整程序提权，用常驻提权助手     | 整程序提权会让拖拽失效、安全争议大；每项单独提权会反复弹 UAC  |
| **禁用 `setx`** 写 PATH                | `setx` 在 1024 字符处静默截断，会把用户的 PATH 写坏           |
| 清单热更新只允许改版本号/URL/校验和    | 否则热更新通道就是任意命令执行通道                            |
| 零遥测                                 | 开源工具的信任基础                                            |

---

## 参与贡献

- 提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/)（`feat:` / `fix:` / `docs:` / `chore:`）
- PR 必须通过 `pnpm manifest:check`、`pnpm typecheck`、`pnpm lint`、`pnpm test`
- 新增软件清单请附上**官方下载页链接**与**该版本的 SHA-256**

---

## English

**devkit** is a Windows desktop app that sets up a development environment on a fresh
machine in one click — installing, configuring (mirrors, PATH, git, SSH, proxy) and
verifying (post-install self-check) the tools you select.

- Status: **M0 done** (app shell, manifest system, real environment detection, zh-CN/en-US UI).
  Manifests are currently `detect-only`; install metadata lands in M1/M2.
- License: MIT
- Requirements: Windows 10 22H2+ x64, Node.js ≥ 20, pnpm ≥ 9
- See [SPEC.md](./SPEC.md) for the full specification (written in Chinese).

## License

[MIT](./LICENSE)
