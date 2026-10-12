# devkit 升级计划（Upgrade Plan）

> 状态：**待执行** · 编写时间：2026-10-12 · 基线提交：`aebd599`
> 来源：一次**只读**代码审查（未修改任何仓库文件）+ 前序市场调研
> 工作树当时状态：干净（`git status --porcelain` 为空）
>
> 本文档只列**有证据支撑**的事项。每条都给出可复现的验证命令。
> 推断或未验证的部分会显式标注。
>
> **执行进度**：P1-3 ✅ 已完成（2026-10-12）。其余梯队待执行。

---

## 0. 总览

| 梯队 | 编号 | 事项 | 类型 | 证据强度 |
| --- | --- | --- | --- | --- |
| **P0 发货阻塞** | P0-1 | 代码签名 | 流程 / 外部依赖 | 已核实（无签名步骤） |
| | P0-2 | 干净虚拟机跑 7-Zip MSI 验收 | 验收 | 已核实（文档自述未验证） |
| | P0-3 | `publish` 与 Release 端到端 | 配置 + 文档 | 已核实（3 处文档过时） |
| **P1 接线与回滚** | P1-1 | 诊断与修复入口（接线死代码） | 功能 | 已核实（调用点 = 0） |
| | P1-2 | `systemconfig` 备份与回滚 | 功能 | 已核实（backup 命中 = 0） |
| | P1-3 | 文档一致性修正（**实际 7 处**） | 文档 | ✅ 已完成 2026-10-12 |
| **P2 测试补齐** | P2-1 | `executor` 分支测试 | 测试 | 已核实（644 行 / 0 测试） |
| | P2-2 | `systemconfig` + `uninstall` 测试 | 测试 | 已核实（0 测试） |
| **P3 产品补齐** | P3-1 | 清单扩充（5 项） | 功能 | 已核实（清单缺失） |
| | P3-2 | Docker 的引导式出路 | 功能 | 已核实（detect-only） |
| | P3-3 | 机器级 PATH 冲突（**待决策**） | 设计决策 | 已核实（实测 WARN） |

**执行顺序建议**：P1-3 → P1-1 → P1-2 → P2-1 → P2-2 → P0-* → P3-*。
理由：P1 三项成本低、不碰架构、有现成模式可抄；P0 是外部依赖（等账号/等虚拟机），可与 P1 并行推进。

---

## 1. P0 发货阻塞项

### P0-1 代码签名

**问题**
未签名的 `devkit Setup.exe` / `devkit-portable.exe` 会被 SmartScreen 拦截，用户第一次双击就流失。
`docs/market-research.md` 已记录同类教训：Scoop 因杀软误报被企业直接弃用（[#5730](https://github.com/ScoopInstaller/Scoop/issues/5730)）。

**证据**
```bash
grep -n "sign\|SIGNPATH\|certificate" .github/workflows/*.yml   # → 0 命中
```
`SPEC.md §12 风险清单` 已列出该风险，应对写的是"申请 SignPath（开源免费）做签名"，但尚未执行。

**修法**
1. 申请 [SignPath](https://signpath.io/)（开源项目免费）或 Azure Trusted Signing
2. `electron-builder.yml` 增加签名配置（`win.signtoolOptions` 或 SignPath 官方 action）
3. `release.yml` 增加签名步骤，凭据走 GitHub Secrets
4. **两个产物都要签**：NSIS 安装版 + portable 版

**验收标准**
```bash
signtool verify /pa /v "release/devkit-0.1.0-setup.exe"
signtool verify /pa /v "release/devkit-0.1.0-portable.exe"
```
两条都通过；在**未安装过 devkit 的机器**上双击不再弹 SmartScreen。

**涉及文件**：`.github/workflows/release.yml`、`electron-builder.yml`

**阻塞原因**：需要项目方账号与 CI 凭据 —— **外部依赖，非代码工作**。

---

### P0-2 干净虚拟机跑 7-Zip MSI 验收

**问题**
`msi-install` 模板至今**零真机验证**。这意味着 M1b（系统级安装 + 提权助手）是**纸面完成**。

**证据**
`docs/VERIFICATION.md §2` 自述：

```
| msi-install | **未验证**（需要管理员） |
| exe-nsis-silent | **未验证**（当前清单里没有用它的可装项） |
```

`sevenzip.json` 是清单里**唯一** `installScope: "machine"` 的项，用的正是 `msi-install`。

**修法**：无代码改动，纯验收。在干净虚拟机里跑一次 7-Zip。

**验收清单**（逐项打勾，结果回填 `VERIFICATION.md`）
- [ ] 只弹**一次** UAC
- [ ] `%USERPROFILE%\.devkit\versions\sevenzip\26.04\7z.exe` 存在
- [ ] 自检通过（`7z i` 输出含 `7-Zip`）
- [ ] 激活后**新开终端** `7z` 可用（该机器无系统级 7-Zip，所以这次应该真能生效）
- [ ] 卸载后：版本目录已删、PATH 已还原、`current` 下 junction 已移除
- [ ] 检查 HKLM 是否留下残留卸载项（`reg query "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall" /s /f "7-Zip"`）
- [ ] 检查机器级 PATH 未被改动

**涉及文件**：`docs/VERIFICATION.md`（回填）

---

### P0-3 `publish` 与 Release 端到端

**问题**
三处文档声称"仓库还没有远程地址"，但**远程其实已经存在**且已推送。

**证据**
```bash
git remote -v
# origin  https://github.com/xinghe-labs/devkit.git (fetch)
# origin  https://github.com/xinghe-labs/devkit.git (push)

git branch -a
# * main
#   remotes/origin/main
```

而过时的表述仍在：

| 位置 | 原文 |
| --- | --- |
| `SPEC.md:751` | "仓库目前没有远程地址，写一个假地址只会让用户看到一个永远失败的'自动更新'" |
| `SPEC.md:796` | "把 `publish` 指向真实仓库… \| 仓库还没有远程地址" |
| `docs/VERIFICATION.md:363` | "GitHub Release 发布 \| 仓库还没有远程地址" |

另外 `electron-builder.yml:2` 的注释仍写着：

```
# 说明：M0 阶段不配置 publish（自动更新在 M4 接入），避免出现假的仓库地址。
```

**修法**
1. 修正上述 4 处表述（远程已存在，缺的是"打 tag 触发过 release.yml"）
2. 决定 `publish` 策略。当前是**提示式更新**（`SPEC.md §13.4 #16` 已论证为什么不静默替换二进制）——这个决策**建议保留**
3. 若保留提示式：把 `latest.json` 托管到可访问的 https 地址（GitHub Release 附件即可），在设置里填默认值
4. 打一个 tag 触发 `release.yml`，验证整条链路

**验收标准**
```bash
curl -sI "<latest.json 的 https 地址>"        # → 200
```
devkit 设置里填入该 URL 后，"检查更新"能正确比较版本并给出下载地址。

**涉及文件**：`SPEC.md`、`docs/VERIFICATION.md`、`electron-builder.yml`、`src/main/core/updater/`

---

## 2. P1 接线与回滚

### P1-1 诊断与修复入口（接线死代码）

**问题**
`pruneDanglingLinks` 是**死代码**：定义了、但全项目零调用，无 IPC 通道，无 UI 入口。
这是项目里**唯一一处自修复逻辑**，却接不到用户手上。

**证据**
```bash
grep -rn "pruneDanglingLinks" src/
# src/main/core/uninstall/index.ts:139:export function pruneDanglingLinks(toolIds: string[]): string[] {

grep -rn "pruneDanglingLinks" src/ | grep -v 'export function' | wc -l   # → 0

grep -E "prune|repair|diagnose" src/shared/ipc.ts                        # → 0 命中（40 个通道里没有）
```

**修法**

新增 `src/main/core/diagnose/index.ts`，产出结构化报告。**检查项与修复能力分开**：

| # | 检查项 | 只读 | 可修复 | 修复是否可逆 |
| --- | --- | --- | --- | --- |
| 1 | 悬空 junction：`activated.json` 有记录，但目标版本目录不存在 | ✓ | ✓ 删链接 | 可逆（重新激活即可重建） |
| 2 | 孤儿 junction：`current/<tool>` 存在，但 `activated.json` 无记录 | ✓ | ✓ 删链接 | 可逆 |
| 3 | 反向缺失：`activated.json` 有记录，但 junction 不存在 | ✓ | ✓ 重建链接 | 可逆 |
| 4 | PATH 死条目：用户 PATH 含 `%DEVKIT_HOME%\current\<tool>`，但该 junction 不存在 | ✓ | ✓ 按记录移除 | 可逆（有备份） |
| 5 | 孤儿版本目录：`versions/<toolId>` 存在，但清单里无该 toolId | ✓ | ✗ **不修** | — |
| 6 | 空目录：`versions/<toolId>` 下无版本目录 | ✓ | ✓ 删空目录 | 可逆（本来就是空的） |

**关键设计约束**
- **诊断本身必须只读、0 风险**（对齐 M1a 的"零风险"原则）
- 第 5 项**不提供自动修复**：删版本目录不可逆，应引导用户去「已安装」抽屉走 FR-16 的卸载流程
- 第 4 项复用 `activate` 已有的备份机制（`backupUserPathOnce`）
- 保持 FR-16 的边界：**只动 devkit 自己记录的东西**，不猜"哪条 PATH 是脏数据"

**接口变更**
- `src/shared/ipc.ts`：新增 `diagnose:run`、`diagnose:repair`
- `src/preload/index.ts`：暴露 `runDiagnosis()` / `repairDiagnosis(ids)`
- `src/main/ipc/index.ts`：注册处理器（注意复用 `validate.ts` 的入参校验风格）
- `src/renderer/src/components/DiagnoseDrawer.tsx`：新增抽屉，`App.tsx` 头部加按钮
- `src/main/core/uninstall/index.ts`：`pruneDanglingLinks` 建议**迁移**到 diagnose 模块，
  `uninstall` 里保留 re-export 以免破坏既有引用

**测试**
- `pruneDanglingLinks` 真实文件系统单测（参照 `activate/junction.test.ts` 的写法）：
  建 junction → 删目标目录 → prune → 断言链接消失
- 诊断聚合的纯函数单测：给定 fixture 状态 → 期望的发现项集合

**验收标准**
手工造一个悬空 junction（激活某工具 → 手工删掉版本目录），UI 诊断能发现，点修复后消失，且用户 PATH 逐字节还原。

**涉及文件**：`core/diagnose/`（新）、`core/uninstall/index.ts`、`shared/ipc.ts`、`preload/index.ts`、`main/ipc/index.ts`、`renderer/src/components/`、`App.tsx`

---

### P1-2 `systemconfig` 备份与回滚

**问题**
`systemconfig` 会写 HKLM 注册表，但**零备份、零还原路径**。这与 devkit 自己反复强调的"可回退"原则直接冲突——
`activate` 有完整备份机制，`systemconfig` 完全没有。

**证据**
```bash
grep -rniE 'backup|restore|rollback|revert' src/main/core/systemconfig/ | wc -l   # → 0
```

对比 `activate`（`src/main/core/activate/index.ts:195-202`）：
```ts
function backupUserPathOnce(state: ActivationState, rawPath: string): ActivationState {
  if (state.backupFile && fileExists(state.backupFile)) return state
  ...
  return { ...state, backupFile: file }
}
```

`systemconfig` 写入的两处注册表（`src/main/core/systemconfig/index.ts:20-28`）：
```
HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem                  LongPathsEnabled
HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock     AllowDevelopmentWithoutDevLicense
```

**旁证**：`docs/VERIFICATION.md §6`「本机被改动了什么（可回退性）」那张表里**没有这两项** ——
因为当时只做了**读**（原文："SystemConfig 里只做了**读**"）。写路径从未被验证，也没有回退方式。

**修法**

新增 `%APPDATA%\devkit\backup\system-config-<timestamp>.json`，写前先读原值。

**记录结构**（关键：必须区分"原本不存在"与"原值为 0"）
```jsonc
{
  "createdAt": "2026-10-12T...",
  "entries": [
    {
      "id": "long-paths",
      "kind": "registry",
      "path": "HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem",
      "name": "LongPathsEnabled",
      "existed": false,          // ← 原本不存在
      "value": null,
      "valueType": "REG_DWORD"
    },
    {
      "id": "git-identity",
      "kind": "git-config",
      "key": "user.name",
      "existed": true,
      "value": "旧名字"
    }
  ]
}
```

新增 `revertSystemConfig(id)`，按记录**精确还原**：

| 类型 | `existed: false` | `existed: true` |
| --- | --- | --- |
| registry | `reg delete /v <name> /f` | `reg add` 写回原值 |
| git-config | `git config --global --unset <key>` | 写回原值 |

**明确的例外：`ssh-key` 不提供回滚。**
生成的私钥可能已被用户用于 GitHub / GitLab，删掉是破坏性操作。
只记录"本次生成了密钥"，并在报告里提示用户自行处理。

**其余约束**
- 注册表还原同样需要提权 → 复用 `runElevated` / `toExecStep`
- 对齐 `activate` 的原则：**只还原 devkit 自己改过的**，按记录精确还原
- UI：`SettingsDrawer.tsx` 的系统配置项旁显示"已由 devkit 修改，可还原"

**测试**
- 备份文件结构单测（`existed` 三态：不存在 / 存在且为 0 / 存在且为 1）
- 还原逻辑单测（用 fake 的 `runCommand`）

**验收标准**
```
改长路径 → revert → reg query 回到原值（原本不存在则查不到该值）
改 git 身份 → revert → git config --global --get user.name 回到原值（原本没有则返回退出码 1）
```

**涉及文件**：`core/systemconfig/index.ts`、`shared/ipc.ts`、`shared/types.ts`、`preload/index.ts`、`main/ipc/index.ts`、`renderer/src/components/SettingsDrawer.tsx`

---

### P1-3 文档一致性修正（6 处）

**问题**
文档之间存在自相矛盾与过时表述。这类问题会直接损害 `VERIFICATION.md` 的可信度——
那份文档的价值全部建立在"只记实际跑过的"之上。

**逐条修正清单**

| # | 位置 | 现状 | 应改为 |
| --- | --- | --- | --- |
| 1 | `docs/VERIFICATION.md:360`（§5 #4） | "用户 PATH 的真实写入 \| … \| 真机写入应在虚拟机里做" | **删除该行**。§3.5 已真机完成写入 + 备份 + 逐字节还原（见 `:109`、`:161`、`:238`） |
| 2 | `docs/VERIFICATION.md:298`（§3.9 表） | `\| 离线包输出目录用手拼分隔符 \|\| \`.cmd\` 自检…` 两行被合并 | 拆成两行，各补齐单元格 |
| 3 | `docs/VERIFICATION.md:363`（§5 #7） | "仓库还没有远程地址" | 远程已存在 `xinghe-labs/devkit`；改为"尚未打 tag 触发过 `release.yml`" |
| 4 | `docs/VERIFICATION.md` 头部（§1） | "23 个测试文件 / 266 个测试" | 实测 **27** 个测试文件；数字用 `pnpm test` 重新取 |
| 5 | `SPEC.md:751`（§13.4 #16） | "仓库目前没有远程地址" | 同上修正 |
| 6 | `SPEC.md:796`（§14 #4） | "仓库还没有远程地址" | 同上修正 |
| 7 | `electron-builder.yml:2` | 注释"M0 阶段不配置 publish" | 更新为当前决策（提示式更新）的说明 |

> 第 4 项的准确数字在写文档时实测为 27（见下），执行时应以当时的 `pnpm test` 输出为准。

**验收标准**
```bash
grep -n "还没有远程地址\|目前没有远程地址" SPEC.md docs/VERIFICATION.md   # → 0 命中
grep -c "个测试文件" docs/VERIFICATION.md                                  # 数字与实际一致
```

**涉及文件**：`docs/VERIFICATION.md`、`SPEC.md`、`electron-builder.yml`

#### 执行记录（2026-10-12）

标题写「6 处」但表里实际列了 **7 行**，按 7 处全部执行。

| # | 状态 | 实际改动 |
| --- | --- | --- |
| 1 | ✅ | `VERIFICATION.md` §5 删除「用户 PATH 的真实写入」一行（§3.5 已真机完成写入 + 备份 + 逐字节还原），其余行重编号为 1~6；末尾加「已从本清单移出」小节 |
| 2 | ✅ | `VERIFICATION.md` §3.9 表格拆开被合并的那一行，两行各自补齐单元格；清理了原残缺行的尾巴 |
| 3 | ✅ | §5 删除「GitHub Release 发布」一行，改为在**新增的 §3.10** 里记录 GitHub Actions 的实测证据（CI 两个任务全绿、Release 发布 3 个资产、首次上 GitHub 才暴露的 3 个问题、产物名不一致的修复） |
| 4 | ✅ | §1 门禁表：`23 个测试文件 / 266 个测试` → **`27 个测试文件 / 333 个测试`**（执行时实测） |
| 5 | ✅ | `SPEC.md` §13.4 #16 改为：仓库虽已存在（`xinghe-labs/devkit`，私有），但私有 Release 资产需鉴权、更新检查取不到 —— 不用 electron-updater 的核心理由仍然成立 |
| 6 | ✅ | `SPEC.md` §14 #4 改为：发布流水线已能产出 `latest.json`，缺的是**可匿名访问**的更新源 |
| 7 | ✅ | `electron-builder.yml` 头部注释改为当前决策：刻意不配 publish 的三条原因（repository 字段会让 electron-builder 索要 GH_TOKEN、更新走提示式方案、产物由 release.yml 上传） |

**验收（两条都通过）**：

```bash
grep -n "还没有远程地址\|目前没有远程地址" SPEC.md docs/VERIFICATION.md   # → 0 命中 ✓
grep -n "个测试文件" docs/VERIFICATION.md   # → 27 个测试文件 / 333 个测试全部通过 ✓
```

---

## 3. P2 测试补齐

### P2-1 `executor` 分支测试

**问题**
`executor/` **644 行、零测试**，而它是核心执行引擎（`runPlan` / `runItem`）。
跑得最多、分支最多的模块反而没有测试。

**证据**
```bash
ls src/main/core/executor/*.test.ts    # → 无此文件
cat src/main/core/executor/*.ts | wc -l  # → 644
```

**覆盖目标**（用注入的 fake，不打网络）

| 分支 | 位置 | 期望行为 |
| --- | --- | --- |
| 幂等跳过 | `index.ts:152` | `installDir` 存在且 verify 通过 → `state='success'`，note 含"跳过"，**不触发下载** |
| 幂等但自检失败 | `index.ts:167` | 走重新安装，日志有 WARN |
| 下载失败 | — | `state='failed'`，错误信息进 `item` |
| 安装失败 | — | `state='failed'` |
| **安装成功但自检失败** | — | 必须与"安装失败"区分开（错误信息不同） |
| **激活失败** | `index.ts:162` | **不回滚安装**，只 `logger.warn` + 继续（当前行为需用测试固化） |
| `dryRun` | — | 不落盘、不下载，但计划结构完整 |
| 取消（`AbortSignal`） | — | 已完成的项保持 `success`，未开始的保持 `pending` |
| 并发上限 ≤3 | — | M3 声称的能力，需实测断言 |

**验收标准**
`pnpm test` 全绿；新增用例覆盖上表全部分支；在 PR 描述里给出 `runItem` 的分支覆盖数字。

**涉及文件**：`src/main/core/executor/index.test.ts`（新）

---

### P2-2 `systemconfig` + `uninstall` 测试

**问题**
`systemconfig/`（248 行，写 HKLM）与 `uninstall/`（151 行，删文件）**均零测试**。
这两个模块一个写系统注册表、一个删用户文件，是破坏力最大的两块。

**证据**
```bash
ls src/main/core/systemconfig/*.test.ts src/main/core/uninstall/*.test.ts   # → 均无
```

**覆盖目标**

`systemconfig`：
- `readRegistryValue` 的三种形态：有值 / 无值 / 命令失败（`reg query` 输出解析）
- `applySystemConfig` 参数校验：`name` 含 `<>"`、`email` 格式错误、空值
- 回滚逻辑（依赖 P1-2）

`uninstall`：
- `listVersionDirs`：非目录、读不到、非法版本名被过滤
- `uninstallVersion`：`toolId` / `version` 校验、激活版本先取消激活、空目录回收、目录不存在
- `pruneDanglingLinks`（若迁移到 diagnose 则在那里测）

**验收标准**：`pnpm test` 全绿，新增用例覆盖上表全部条目。

**涉及文件**：`src/main/core/systemconfig/index.test.ts`（新）、`src/main/core/uninstall/index.test.ts`（新）

---

## 4. P3 产品补齐

### P3-1 清单扩充（建议先做 5 项）

**问题**
19 项清单里有 **3 项是 detect-only**（实际可装 16 项），且缺少若干高频开发工具。

**证据**
```bash
grep -l '"status": "detect-only"' resources/manifest/tools/*.json
# docker-desktop.json  postgresql.json  wsl2.json

# 以下均为"缺失"（清单里 0 命中）
dotnet  gh  ripgrep  fzf  jq  terminal  powershell  redis  mysql  neovim
```

**建议优先级**

| 工具 | 理由 | 预期模板 |
| --- | --- | --- |
| **.NET SDK** | Windows 原生开发第一梯队，当前完全缺席 | 待调研（有 zip 与 Inno 两种分发） |
| **GitHub CLI (`gh`)** | 现代工作流标配 | `zip-into-version-dir` |
| **ripgrep / fd / fzf / jq** | 现代 CLI 工具集，实际高频 | `zip-single-file-into-version-dir` |
| Windows Terminal | 装完 devkit 却没有终端 | **单独立项**：MSIX 分发，`installScope` 与静默安装方式需先调研，可能不适配现有 8 个模板 |

**每项必须提供**（对齐现有清单的完整度）
真实 `sha256` · 至少 2 个镜像 · `detect` 规则（commands / files / registry）· `verify` 规则 · `activate.pathEntries` · `installScope` · `license`

**验收标准**：每项真机走完「装 → 自检 → 激活 → 卸载」，结果回填 `VERIFICATION.md §2`。

**涉及文件**：`resources/manifest/tools/*.json`、`scripts/refresh-manifests.ts`（如需纳入刷新器）

---

### P3-2 Docker 的引导式出路

**问题**
`docker-desktop.json` 是 detect-only（`versions: []`）。原因是合规，**这个决定本身是对的**：

```
notes: Docker Subscription Service Agreement 限制商业/企业使用需付费订阅，
       本项目只做官方下载链接展示，不做静默安装
```

但它和产品定位冲突 —— README 写的是"在**一台什么都没装的 Windows 电脑**上…一键把开发环境装好"，
而新机器上最需要 Docker。结果：检测不到、也装不了。

**修法**（不做静默安装，做**引导闭环**）
1. 未安装时显示"打开官方下载页"按钮（复用已有的 `appOpenExternal`，已限 https）
2. 提供"我已安装，重新检测"按钮
3. 若用户是在**安装流程中途**去装 Docker，回来后能用 FR-17 的 pending 机制接着走
4. 保留清单 `notes` 里的合规说明

**验收标准**：Docker 项在 UI 上是一个有明确下一步的引导项，而不是一个灰掉的只读项。

**涉及文件**：`resources/manifest/tools/docker-desktop.json`、`renderer/src/components/ToolRow.tsx` / `ToolDetail.tsx`

---

### P3-3 机器级 PATH 冲突（**待决策，默认不做**）

**问题**
Windows 的进程 PATH 是「机器级 + 用户级」，**机器级在前**。因此系统里已有的同名工具会遮住 devkit 装的版本，
即使 devkit 把条目插在用户 PATH 最前面也没用。

**证据**
`docs/VERIFICATION.md §3.5` 的实测输出：

```
[WARN] [activate] nodejs 新终端验证：node 解析到了 D:\node\node.exe（不是 devkit 装的那份）。
        系统级 PATH 里的同名工具优先级高于用户级 PATH
```

devkit 当前的处理是"如实告知 + 建议用绝对路径" —— 诚实，但对用户等于**没解决**。

**可选方案（需要你决策）**

| 方案 | 做法 | 风险 |
| --- | --- | --- |
| **A. 只优化告知**（建议） | 一键复制绝对路径；在 UI 里明确显示"当前实际解析到 X，devkit 装的是 Y" | 无。不解决根因，但体验完整 |
| **B. 提权移除机器级条目** | 检测到冲突时，用已有提权助手移除机器级 PATH 里那条同名条目（先备份机器级 PATH） | **高**：改机器级 PATH 会影响该机器上**所有用户**；且可能破坏用户其他依赖 |
| **C. 反向写入** | 把 devkit 条目写进机器级 PATH | 同 B 的风险，且违背"不干扰已有环境"的设计原则 |

**建议**：先做 A（成本低、无风险），把 B 作为**默认关闭的高级选项**，并在 UI 上明确写出影响范围。
C 不建议。

**注意**：无论选哪个，**不能掩盖问题**。当前"如实告警"的行为是正确的，改动不得让它变成假阳性成功。

**涉及文件**：待决策后再定

---

## 5. 明确不做

| 事项 | 理由 |
| --- | --- |
| 做 CmdPal 扩展 | 会分散发货精力。等 P0 全部完成后再评估 |
| 做"环境医生"大模块 | P1-1 那个窄入口已经覆盖真实需求。PATH 清理在 uTools 上实测评分 2/806，是功能不是产品 |
| 把清单扩到 30 项 | 16 项能装 > 30 项半装。先让 Docker 和 MSI 有出路 |
| 改架构 | `docs/security-review.md` 结论是"设计站得住"，不动 |
| 自建包管理器 / 账号体系 / 静默自动更新 | `SPEC.md §2.2` 与 `§13.4 #16` 已论证 |

---

## 6. 每项完成后的门禁

任何一项完成后，必须全部通过：

```bash
pnpm manifest:check     # 清单校验
pnpm typecheck          # 主进程 + 渲染进程，0 错误
pnpm lint               # ESLint 0 问题
pnpm test               # 全绿
pnpm build              # 三端产物
```

涉及发布链路（P0-1 / P0-3）的额外要跑：

```bash
pnpm dist               # NSIS + portable 双产物
pnpm release:index      # 生成 release/latest.json
```

**回填要求**：涉及真机行为的项（P0-2、P3-1、P3-2），必须把**实测命令与输出**补进
`docs/VERIFICATION.md` —— 没有出现在那份文档里的结论，按该文档自己的定义只能算"设计上如此"。

---

## 7. 本次审查的方法与边界

**方法**：只读代码审查。未修改任何仓库文件。所有结论附可复现命令。

**已核实**（逐条命令验证）
- `pruneDanglingLinks` 调用点 = 0
- `systemconfig` 备份/回滚关键词命中 = 0
- `executor`(644) / `systemconfig`(248) / `uninstall`(151) / `vscode`(216) / `settings`(208) 测试文件 = 0
- 测试文件实际 27 个，`VERIFICATION.md` 声明 23 个
- `shared/ipc.ts` 通道数 = 40，其中无 diagnose/repair/prune
- detect-only 清单项 = 3（docker-desktop / postgresql / wsl2）
- 清单缺失：dotnet / gh / ripgrep / fzf / jq / terminal / powershell / redis / mysql / neovim
- `git remote` 已存在 `xinghe-labs/devkit`，工作树干净，HEAD = `aebd599`
- `release.yml` 无签名步骤
- 文档过时行号：`VERIFICATION.md:360`、`:298`、`:363`、`SPEC.md:751`、`:796`

**未核实 / 存疑**
1. **`vscode` 与 `settings` 模块的测试价值**：本次未逐行审查，是否值得补测未评估。
2. **P3-3 方案 B 的实际影响面**：未验证"移除机器级 PATH 条目"在真实多用户机器上的后果。
3. **清单数字**：`VERIFICATION.md` 声明的测试数（23/266）与实际（27 个文件）不一致，
   用例总数未重新统计，执行 P1-3 时应以当时的 `pnpm test` 输出为准。
4. **P3-1 的模板适配性**：.NET SDK 与 Windows Terminal 的分发方式未调研，
   现有 8 个模板能否覆盖是**推断，未验证**。

---

## 附录：变更记录

| 版本 | 变更 |
| --- | --- |
| v1.0 | 初稿。基于 `aebd599` 的只读审查，列 P0~P3 共 10 项 + 明确不做清单 + 门禁要求 |
