# devkit 实测记录（Verification）

> 这份文档只记**实际跑过的命令与实际输出**。
> 没有在这里出现的结论，都只能算"设计上如此"，不算已验证。
>
> 环境：Windows 11（build 26300）x64 · Node.js v22.23.2 · pnpm 10.26.2 · 用户名 `屈`（中文路径）
> 记录时间：2026-10-12

---

## 1. 门禁（每次提交前都跑）

| 命令 | 结果 |
| --- | --- |
| `pnpm manifest:check` | 19 个清单文件，19 个通过校验；16 个 `ready`、3 个 `detect-only`；校验失败 0 |
| `pnpm typecheck` | 主进程 + 渲染进程，0 错误 |
| `pnpm lint` | ESLint 0 问题 |
| `pnpm test` | 23 个测试文件 / **266 个测试全部通过** |
| `pnpm build` | 三端产物生成成功（main / preload / renderer） |
| `pnpm dist` | `release/devkit Setup 0.1.0.exe`（111.9 MB）+ `release/devkit-0.1.0-portable.exe`（111.7 MB） |
| `pnpm release:index` | 生成 `release/latest.json`（含两个产物的 SHA-256 与体积） |

---

## 2. 真实安装（不是 mock，不是 dry-run）

命令形式：`pnpm install:tool <id>`，与界面走**完全相同**的代码路径
（预检 → 下载 → SHA-256 校验 → 安装 → 绝对路径自检）。

| 工具 | 版本 | 安装模板 | 下载源（实测） | 自检输出 | 耗时 |
| --- | --- | --- | --- | --- | --- |
| Node.js（M1a 阶段） | 24.21.0 | `zip-into-version-dir` | 华为云 8.2 MB/s | `v24.21.0` | — |
| Deno | 2.9.7 | `zip-into-version-dir` | 官方 GitHub 不可达 → **自动回退 npmmirror** | `deno 2.9.7 (stable, release, x86_64-pc-windows-msvc)` | 47.6s |
| pnpm | 12.11.2 | `zip-single-file-into-version-dir` | 官方 GitHub 21.9 KB/s → **速度哨兵放弃并换 ghproxy** | `10.26.2`（注 1） | 61.8s |
| Git | 2.56.0 | `exe-7zsfx-extract` | 华为云 11 MB/s | `git version 2.56.0.windows.1` | 22.9s |
| Python | 3.14.8 | `exe-python-silent` | 华为云 5 MB/s | `Python 3.14.8` | 36.4s |

安装位置全部为 `%USERPROFILE%\.devkit\versions\<tool>\<version>\`：

```
93M  .../.devkit/versions/deno/2.9.7
354M .../.devkit/versions/git/2.56.0
213M .../.devkit/versions/nodejs/24.21.0
48M  .../.devkit/versions/pnpm/12.11.2
135M .../.devkit/versions/python/3.14.8
```

**注 1**：pnpm 的 `--version` 会遵循项目里的 `packageManager` 字段自动切到 10.26.2，
所以自检输出是 10.26.2 而不是 12.11.2。自检规则（`\d+\.\d+`）只看"能不能跑出版本号"，
这是刻意的宽松设计；此处记录以免日后误判。

**覆盖到的模板**：`zip-into-version-dir`、`zip-single-file-into-version-dir`、
`exe-7zsfx-extract`、`exe-python-silent`。
**未在真机验证**：`msi-install`、`exe-nsis-silent`、`exe-inno-silent`（见第 5 节）。

---

## 3. 界面冒烟（开发态 + 打包态）

`DEVKIT_SMOKE=1` 会把渲染进程的所有 `console.error`、`render-process-gone`、
`did-fail-load` 收进日志；**只要报过 error，退出码就是 1** —— 这样"界面白屏"不会被当成启动成功。

| 场景 | 命令 | 结果 |
| --- | --- | --- |
| 开发构建 | `DEVKIT_SMOKE=1 DEVKIT_SMOKE_DELAY_MS=22000 node_modules/electron/dist/electron.exe .` | 19 个清单加载、检测 19 项、`冒烟通过：界面已渲染且渲染进程无报错`、**exit 0** |
| 打包产物 | `DEVKIT_SMOKE=1 DEVKIT_SMOKE_DELAY_MS=22000 "release/win-unpacked/devkit.exe"` | 清单从 `resources\manifest` 加载成功、`打包模式：是`、检测 19 项、**exit 0** |

打包态日志摘录：

```
[INFO] [app] 打包模式：是
[INFO] [manifest] 从 ...\release\win-unpacked\resources\manifest 加载清单：成功 19 个，失败 0 个
[INFO] [detect] 检测完成：19 个工具，耗时 7330ms，已装 5 个
[INFO] [app] 冒烟通过：界面已渲染且渲染进程无报错
```

---

## 4. 安全相关的专项测试

| 项 | 测试文件 | 覆盖内容 |
| --- | --- | --- |
| 参数模板白名单 | `core/templates/index.test.ts`、`new-templates.test.ts` | 未知模板名、类型不匹配、未声明参数键、非法参数值、NSIS `/D` 含空格拒绝、MSI 属性注入字符拒绝 |
| ZIP 投毒（zip slip） | `core/installer/zip.test.ts` | `..`、绝对路径、盘符、空字节、符号链接条目全部拒绝 |
| 清单热更新投毒 | `core/hotupdate/whitelist.test.ts` | 远程改 `install`/`activate`/`verify`/`detect` 一律无效；非 https、缺 SHA-256、缺 installScope、多 recommended 全部拒绝 |
| PATH 写入 | `core/activate/paths.test.ts` | 中文路径、含空格路径、大小写/尾随斜杠、重复条目、**超长 PATH 不截断**、反复激活取消无残留 |
| 下载器 | `core/downloader/index.test.ts` | SHA-256 不符、镜像 404 回退、断点续传、服务器忽略 Range、截断、**慢速源换源** |
| 提权作业协议 | `core/elevation/run-job.test.ts` | 成功 / 失败退出码 / 命令不存在 / 多步骤 / 空步骤 / 脚本明文可审计 |
| 离线包 | `core/offline/index.test.ts` | 校验通过才入缓存、被篡改的文件被拒绝、缺索引给出可读错误 |

---

## 5. 尚未验证的部分（诚实清单）

| # | 未验证项 | 为什么 | 怎么才能验证 |
| --- | --- | --- | --- |
| 1 | 机器级 MSI 真实安装（7-Zip） | 需要 UAC 与写 HKLM，不能在本机做 | 干净虚拟机里跑一次，确认只弹一次 UAC、装完能激活、卸载干净 |
| 2 | `exe-nsis-silent` / `exe-inno-silent` 模板真机行为 | 当前清单里没有用这两个模板的可装项（7-Zip 走 MSI，VS Code 走 Inno 但需要 1.4 GB 下载） | 虚拟机里装一次 VS Code 用户版（`exe-inno-silent`） |
| 3 | "新开终端 `node -v` 生效" | 需要一台原本没装过 Node 的机器 | 干净虚拟机 + 打开一个新的 cmd 窗口 |
| 4 | 用户 PATH 的真实写入 | 会改用户环境变量，属于系统级改动 | 已用单测覆盖全部计算逻辑；真机写入应在虚拟机里做 |
| 5 | `Checkpoint-Computer` 还原点 | 需要管理员，且多数机器未启用系统保护 | 虚拟机里开启系统保护后验证 |
| 6 | 代码签名 | 需要 SignPath 账号与 CI 凭据 | 申请后接入 `release.yml` |
| 7 | GitHub Release 发布 | 仓库还没有远程地址 | `git remote add` 后打 tag 触发 `release.yml` |
| 8 | 更新检查的端到端 | 需要一个可访问的 `latest.json` | 把 `release/latest.json` 传到任意 https 静态托管，填进设置即可验证 |

> 第 1~5 项都需要一台**干净虚拟机**。SPEC §12 已经确认过用户愿意安装
> VMware Workstation Player / VirtualBox 用于这类验收。

---

## 6. 本机被改动了什么（可回退性）

为了验证，本机发生了这些变化：

| 变化 | 位置 | 怎么回退 |
| --- | --- | --- |
| 安装了 5 个工具到版本目录（约 843 MB） | `%USERPROFILE%\.devkit\versions\` | 删掉目录，或在界面「已安装」里逐个卸载 |
| 下载缓存 | `%USERPROFILE%\.devkit\downloads\` | 直接删 |
| 应用配置 / 日志 / 激活记录 | `%APPDATA%\devkit\` | 直接删（不会影响系统） |

**没有发生的变化**（这是"安装 ≠ 激活"的直接结果）：

- 没有修改用户 PATH（`activated.json` 不存在）
- 没有写 `Program Files`
- 没有写 `HKLM`
- 没有触发过 UAC
- 没有改任何系统设置（`SystemConfig` 里只做了**读**）

> 安装脚本 `scripts/install-tool.ts` 里没有注入 `activate` 回调，
> 所以它在结构上就不可能改 PATH —— 这不是"没做"，是"做不到"。
