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
| `pnpm manifest:check` | 25 个清单文件，25 个通过校验；22 个 `ready`、3 个 `detect-only`；校验失败 0 |
| `pnpm typecheck` | 主进程 + 渲染进程，0 错误 |
| `pnpm lint` | ESLint 0 问题 |
| `pnpm test` | 28 个测试文件 / **354 个测试全部通过** |
| `pnpm build` | 三端产物生成成功（main / preload / renderer） |
| `pnpm dist` | `release/devkit-0.1.0-setup.exe`（111.9 MB）+ `release/devkit-0.1.0-portable.exe`（111.7 MB） |
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

**覆盖到的模板**（8 个模板里验证了 6 个）：

| 模板 | 真机验证过的工具 |
| --- | --- |
| `zip-into-version-dir` | Node.js、Deno |
| `zip-single-file-into-version-dir` | pnpm、Ninja |
| `exe-7zsfx-extract` | Git（PortableGit 自解压） |
| `exe-python-silent` | Python 3.14.8 |
| `exe-inno-silent` | VS Code 1.141.0（`/VERYSILENT /DIR=<版本目录>`） |
| `msi-install` | **未验证**（需要管理员） |
| `exe-nsis-silent` | **未验证**（当前清单里没有用它的可装项） |

安装并自检通过的工具（版本目录 `%USERPROFILE%\.devkit\versions\`）：
`nodejs 24.21.0` · `deno 2.9.7` · `pnpm 12.11.2` · `git 2.56.0` · `python 3.14.8` ·
`ninja 1.13.2` · `vscode 1.141.0` · `maven 3.10.0`

---

## 3. 界面冒烟（开发态 + 打包态）

`DEVKIT_SMOKE=1` 会把渲染进程的所有 `console.error`、`render-process-gone`、
`did-fail-load` 收进日志；**只要报过 error，退出码就是 1** —— 这样"界面白屏"不会被当成启动成功。

| 场景 | 命令 | 结果 |
| --- | --- | --- |
| VS Code 插件面板（VS Code 未安装） | 点击头部「VS Code 插件」 | 面板置灰、显示 `code --version 退出码 1：'code' 不是内部或外部命令…`、安装按钮禁用 —— 符合 FR-7「未安装时置灰并提示」 |
| 设置抽屉 | 点击头部「设置」 | 下载/安装完成后/镜像源/离线包/清单更新/系统配置/激活状态/关于 七个分区全部渲染正常 |
| 已安装抽屉 | 点击头部「已安装」 | 按工具分组、显示体积与安装时间、nodejs 正确标注「该版本未声明激活方式」、其余可激活/卸载 |
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

## 3.5 激活链路端到端（本机真实验证）

激活是旗舰功能，而且它会改用户 PATH，所以单独做了一轮「激活 → 检查 → 取消激活 → 校验还原」。
做法：用 `DEVKIT_SMOKE_JS` 在冒烟流程里调真实的 IPC（与界面点按钮走同一条路径）。

**第一步：记录改动前的用户 PATH**

```
D:\Python;D:\Python\Scripts;C:\Program Files\LibreOffice\program;D:\npm\npm-global
```

**第二步：激活 nodejs@24.21.0**

```
[activate] nodejs@24.21.0 切换链接：created → %USERPROFILE%\.devkit\versions\nodejs\24.21.0
[activate] 已备份用户 PATH 原文：%APPDATA%\devkit\backup\user-path-20261012-153737.txt
[activate] 用户 PATH 已更新：新增 1 条，已在 PATH 中 0 条

返回：{"ok":true,"note":"已写入用户 PATH；新开的终端里生效"}
PATH：%USERPROFILE%\.devkit\current\nodejs;D:\Python;D:\Python\Scripts;C:\Program Files\LibreOffice\program;D:\npm\npm-global
```

独立校验（不是应用自己报的）：

```
$ node -e "...lstatSync(junction).isSymbolicLink(), readlinkSync(junction)"
  junction exists: true | isLink: true | target: %USERPROFILE%\.devkit\versions\nodejs\24.21.0

$ %USERPROFILE%\.devkit\current\nodejs\node.exe -v
  v24.21.0
```

→ junction 已建立，**透过 junction 跑起来的确实是刚装的那一份**（v24.21.0，而系统里的是 22.23.2）。

**第二步（续）：加了「新终端验证」之后的第二轮实测**

PATH 条目已收敛成变量形式，并多了一步 `where` 校验：

```
[activate] 已设置 DEVKIT_HOME=%USERPROFILE%\.devkit
[activate] 用户 PATH 已更新：新增 1 条，已在 PATH 中 0 条
[WARN] [activate] nodejs 新终端验证：node 解析到了 D:\node\node.exe（不是 devkit 装的那份）

用户 PATH：%DEVKIT_HOME%\current\nodejs;D:\Python;...;D:\npm\npm-global
```

→ 这一轮把「写进 PATH 就报成功」的假阳性揪出来了：系统级 PATH 里的 Node 抢在前面，
devkit 如实告警而不是宣称成功（详见下面「由 Windows 自身决定的限制」）。

**第三步：取消激活**

```
返回：{"removed":["切换链接 C:\\Users\\屈\\.devkit\\current\\nodejs","PATH C:\\Users\\屈\\.devkit\\current\\nodejs"],"error":null,
       "userPath":"D:\\Python;D:\\Python\\Scripts;C:\\Program Files\\LibreOffice\\program;D:\\npm\\npm-global",
       "records":0,"managed":[]}
```

独立校验：

```
junction exists: false
target 完好: true（%USERPROFILE%\.devkit\versions\nodejs\24.21.0\node.exe 仍在）
DEVKIT_HOME：<已删除>

PATH 还原校验：
  before: "D:\\Python;D:\\Python\\Scripts;C:\\Program Files\\LibreOffice\\program;D:\\npm\\npm-global"
  after : "D:\\Python;D:\\Python\\Scripts;C:\\Program Files\\LibreOffice\\program;D:\\npm\\npm-global"
  BYTE-IDENTICAL: true
```

→ **用户 PATH 逐字节还原**，junction 已移除且目标目录完好。本机没有留下任何激活痕迹
（`activated.json` 的 records 与 managedPathEntries 均为空）。

### 这轮实测抓到的真实缺陷（已修复并加了回归测试）

| 缺陷 | 现象 | 修复 |
| --- | --- | --- |
| `rmSync(path, { recursive: false })` 删不掉 junction | 取消激活在最后一步报 `Path is a directory`，PATH 已清理、链接残留，下次没人能清它 | 改用 `rmdirSync`（RemoveDirectoryW）并保留 recursive 兜底；新增 `junction.test.ts` 真实文件系统用例 |
| 取消激活的顺序不对 | 链接删失败时 PATH 已被改掉，留下半成品状态 | 先拆 junction（失败则不动 PATH），再清环境变量与 PATH |
| `toDevkitHomeVar` 前缀匹配过宽 | `C:\Users\x\.devkit-other` 这种“前缀相似的兄弟目录”会被误改成 `%DEVKIT_HOME%-other`，把一个无关条目指向 devkit | 要求剩余部分以路径分隔符开头（或为空）才算命中；已加单测 |
| Node.js 清单没有 `activate` | 界面上“激活”按钮不出现（截图里看到的），旗舰工具装完用不了 | 把 nodejs 纳入清单刷新器并补上 `activate`，重新生成清单 |
| 慢速源拖死安装 | GitHub 资产以 21.9 KB/s “慢慢滴”，空闲超时永不触发，整个安装卡住 | 新增速度哨兵：平均速度长期低于 32 KB/s 就放弃该源；实测后自动换镜像并成功 |
| PowerShell 脚本中文报语法错误 | `.ps1` 无 BOM 时 PS 5.1 按 cp936 解码，提权助手直接跑不起来 | 写脚本时加 UTF-8 BOM；结果文件用无 BOM UTF-8（否则 Node 的 JSON.parse 报错） |
| 预检只看首选源 | 首选源不可达就整体阻断，明明镜像可用 | 改为每个工具并行探多个源，只要有一个可用就通过，并在日志里说明用了哪个 |
| 激活验证只看版本号输出 | 系统里的 Node 22 输出也能匹配上 `v\d+\.\d+`，会把“没生效”报成成功（假阳性） | 改用 `where.exe` 看命令实际解析到哪个文件，必须落在 devkit 目录内才算通过 |

### 一个由 Windows 自身决定的限制（已如实告知，不掩饰）

实测输出：

```
[WARN] [activate] nodejs 新终端验证：node 解析到了 D:\node\node.exe（不是 devkit 装的那份）。
        系统级 PATH 里的同名工具优先级高于用户级 PATH；要改用 devkit 的版本，
        可以直接用 %USERPROFILE%\.devkit\current\nodejs\... 下的绝对路径，或先卸掉系统里那一份
```

Windows 的进程 PATH 是「机器级 + 用户级」，**机器级在前**。所以系统里已有的 Node（在机器级 PATH 里）
会抢在 devkit 的用户级条目前面。devkit 的选择是**不掩盖**：激活仍然成功（条目写进去了、
绝对路径可用），但把“跑到的不是 devkit 那份”明确报出来，并给出两种解法。
另一个选择是去改机器级 PATH，但那需要管理员、且会违背“不干扰已有环境”的设计原则。

---

## 3.6 完整 UI 流程端到端（选择 → 预检 → 安装 → 激活 → 报告）

前面的安装测试都是走 CLI（`pnpm install:tool`）。这里再走一遍**界面的真实路径**：
通过 `DEVKIT_SMOKE_JS` 调与按钮完全相同的 IPC（`prepareInstall` → `startInstall` → 轮询 `getPendingPlan` → `listInstalled`）。

工具选 Ninja（600 KB、`zip-single-file-into-version-dir` 模板，走完整链路但不占带宽）。

```
[preflight] 预检完成：通过，共 5 项检查
[install]   已准备安装计划 20261012-160523-f5eb：共 1 项
[executor]  开始处理 ninja@1.13.2
[executor]  ninja 安装完成：1 个文件 / 603648 字节 → %USERPROFILE%\.devkit\versions\ninja\1.13.2
[executor]  安装流程结束：成功 1，失败 0，跳过 0，取消 0，耗时 6967ms
[install]   计划 20261012-160523-f5eb 执行完毕：成功 1，失败 0

脚本返回：
{"preflightOk":true,"checks":5,"started":{"started":true},
 "ninja":[{"toolId":"ninja","version":"1.13.2",
           "installDir":"C:\\Users\\屈\\.devkit\\versions\\ninja\\1.13.2",
           "sizeBytes":603648,"active":true,"activatable":true}]}
```

`active: true` 说明**安装后自动激活**也生效了（`activateAfterInstall` 默认为开）。独立校验：

```
激活记录：ninja@1.13.2，pathEntries = ["%DEVKIT_HOME%\\current\\ninja"]
用户 PATH：%DEVKIT_HOME%\current\ninja;D:\Python;D:\Python\Scripts;C:\Program Files\LibreOffice\program;D:\npm\npm-global
DEVKIT_HOME：%USERPROFILE%\.devkit
junction：ninja → %USERPROFILE%\.devkit\versions\ninja\1.13.2

$ %USERPROFILE%\.devkit\current\ninja\ninja.exe --version
  1.13.2
```

随后取消激活，机器回到原样：

```
返回：{"removed":["切换链接 ...current\ninja","环境变量 DEVKIT_HOME","PATH %DEVKIT_HOME%\current\ninja"],
       "error":null,"userPath":"D:\Python;D:\Python\Scripts;C:\Program Files\LibreOffice\program;D:\npm\npm-global",
       "records":0}

PATH BYTE-IDENTICAL: true
DEVKIT_HOME 已删除: true
junction 已移除: true
ninja 安装目录完好: true
```

→ **一次界面操作**完成了「下载 → SHA-256 校验 → 解压 → 自检 → 激活 → 报告」，
并且激活是完全可逆的。

---

## 3.7 离线包端到端（FR-12）

通过界面路径调 `packOffline` / `importOfflinePack`：

```
[offline] 离线包已生成：D:\work\tmp\offline-test\devkit-offline-2026-10-12T08-09-04（1 个文件 / 291570 字节）
[offline] 离线包导入完成：1/1 个文件进入下载缓存

产出：
  archives/ninja-1.13.2-ninja-win.zip
  offline.json   ← {toolId, version, fileName, sha256, sizeBytes, url}
  README.json
```

→ 导入时会**逐个校验 SHA-256**，校验不过的文件不会进下载缓存（否则问题会拖到安装阶段才以
「校验失败」暴露）。离线安装复用在线流程：文件进了下载缓存后，正常安装会跳过下载。

---

## 3.8 打包内容核对

```
$ npx asar list release/win-unpacked/resources/app.asar
\out\main\index.js
\out\preload\index.js
\out\renderer\index.html
\out\renderer\assets\...
\package.json
（共 11 项）

$ ls release/win-unpacked/resources/manifest/tools/ | wc -l
19
```

→ asar 里**只有构建产物与 package.json**（不含源码、不含 node_modules）；
19 个清单走 `extraResources` 放在 asar 外面，所以用户手工改清单或热更新都不需要重新打包。

| 产物 | 体积 |
| --- | --- |
| `release/devkit-0.1.0-setup.exe`（NSIS 安装版） | 111.9 MB |
| `release/devkit-0.1.0-portable.exe`（便携版） | 111.7 MB |
| `release/latest.json`（更新索引，含两个产物的 SHA-256 与体积） | 约 0.5 KB |

---

## 3.9 这一轮新抓到并修掉的问题

| 问题 | 现象 | 修复 |
| --- | --- | --- |
| 离线包输出目录用手拼分隔符 | 用户选到带尾随分隔符或相对路径的目录时，`mkdir` 会失败（实测报 `ENOENT ... AgentWork\tmpoffline-test`） | 改用 `path.join(outputDir, name)` |
| `.cmd` 自检在 Node 22 下全部失败 | Maven 的 `mvn.cmd`、Gradle 的 `gradle.bat`、VS Code 的 `code.cmd` 自检报 EINVAL —— Node 18.20.2 / 20.12.2 起（CVE-2024-27980 的修复）不带 shell 直接 spawn 批处理文件会抛 EINVAL，而回退条件只匹配了 ENOENT | 回退条件加上「EINVAL + 目标是 .cmd/.bat」；同时把命令路径的白名单从纯 ASCII 放宽为「只禁 cmd 元字符」—— 否则 devkit 自己的中文安装路径会被自己拒掉 |
| `cmd /s /c` 处理不了带空格的路径 | `cmd /d /s /c "C:\\a b\\x.cmd"` 里 `/s` 会剥掉首尾引号，空格变成参数分隔符，命令以 code=1 静默失败 | 回退改用 `cmd /d /c`（实测该写法能正确处理带空格路径） |
| VS Code 自检永远拿到空输出 | `Code.exe` 是 GUI 子系统程序，`Code.exe --version` 退出码 0 但**什么都不输出**，用 `\d+\.\d+` 匹配会一直失败 | 清单自检改用 `bin\\code.cmd --version`（实测输出 `1.141.0`） |
| 下载产物没有扩展名 | VS Code 的下载地址以 `/stable` 结尾，产物叫 `vscode-1.141.0-stable`（无扩展名），能不能被当程序跑全看运气 | URL 末段没有扩展名且不是 zip 时补 `.exe` |
| 官方安装器会**自己**写用户 PATH | 实测 VS Code 的 Inno 安装器在 `/VERYSILENT` 下仍然往用户 PATH 写了 `...\vscode\<版本>\bin`；试过 `/MERGETASKS=!addtopath` 阻止，**无效**。这与 devkit 的「安装 ≠ 激活」原则冲突：用户没点过激活，命令却能用了，而且那条 PATH 不受 devkit 的记录管理、卸载时也没人清 | 改成通用方案：安装前后各取一次用户 PATH，有变化就**整体还原**并把被移除的条目写进日志与报告。不依赖任何安装器的任务名，任何安装器都拦得住 |
| `.cmd` 回退的参数白名单也是纯 ASCII | 假安装器收到的 `/DIR=C:\Users\张三\AppData...` 被判为"不安全字符"直接拒执行 —— devkit 自己的中文路径会让回退彻底失效 | 参数白名单同样放宽为「只禁 cmd 元字符、通配符与空白」，不禁中文 |
| 预检拿"用不到的条件"拦人 | 所有项都已安装（本次根本不需要下载）时，网络探测失败仍会让预检阻断，重跑一个已装好的工具被卡住 | 预检先判断是否真有需要下载的项；全部已安装时跳过网络探测并给出 ok 级结论 |

---

## 3.10 GitHub Actions 实测（CI + Release）

仓库建在 `xinghe-labs/devkit`（私有），`main` 与 tag `v0.1.0` 都已推送。
两条流水线在 GitHub 的 Windows runner 上**真实跑通**：

| 流水线 | 触发 | 耗时 | 结果 |
| --- | --- | --- | --- |
| CI | push `main` | 4m9s | ✅ 两个任务全绿：`lint / typecheck / manifest / test`（1m58s）+ `界面冒烟`（1m44s） |
| Release | push tag `v0.1.0` | 4m58s | ✅ 完整门禁 → `pnpm dist` → 打包产物冒烟 → 发布 Release |

CI 冒烟任务的实测输出（说明 Electron 在 runner 上真的启动并渲染了）：

```
确保 Electron 运行时存在   electron.exe 就绪：D:\a\devkit\devkit\node_modules\electron\dist\electron.exe
启动应用并断言界面无报错   冒烟测试通过
```

发布产物（`gh release view v0.1.0`）：

| 资产 | 体积 |
| --- | --- |
| `devkit-0.1.0-setup.exe` | 105.8 MB |
| `devkit-0.1.0-portable.exe` | 105.6 MB |
| `latest.json` | 546 B |

### 首次上 GitHub 才暴露的 3 个问题（都已修）

| 问题 | 现象 | 原因 | 修法 |
| --- | --- | --- | --- |
| 测试依赖系统语言 | `expected '…退出码…' to match /找不到\|不是内部或外部命令/` | 断言了 cmd 的**中文**报错文案，GitHub runner 是英文 Windows | 只断言我们自己拼的那部分（命令名 + 退出码） |
| 冒烟任务起不来 Electron | `Start-Process: An error occurred trying to start process` | pnpm store 命中缓存（`reused 516 / downloaded 0`）时 electron 的 postinstall **不执行**，`node_modules/electron/dist` 是空的 | 冒烟任务显式检查 `electron.exe`，缺失就用官方源手动下载；`Start-Process` 改用绝对路径 + `-WorkingDirectory` |
| Release 在打包后失败 | `GitHub Personal Access Token is not set` | `package.json` 里的 `repository` 字段让 electron-builder 推断「要自动发布」，于是索要 `GH_TOKEN`（其实**打包已经成功**） | `dist` 显式加 `--publish never`，另加 `dist:publish`；发布交给 `action-gh-release` |

### 另外自己核对产物时发现的一个真实不一致（已修）

产物名里带空格（`devkit Setup 0.1.0.exe`）会被上传工具改写成 `devkit.Setup.0.1.0.exe`，
而 `latest.json` 里写的仍是带空格的名字 —— 更新检查会指向一个**不存在的文件名**。
已把 NSIS 产物改名成 `devkit-<version>-setup.exe`（无空格），索引与实际资产名现在一致。

---

## 3.11 AI 编码 agent 安装（6 个，全部真机跑通）

先做事实调研再动手：查了各家到底有没有**可校验的独立发行物**。结论是只有两家有 ——
Codex CLI 与 OpenCode 提供官方二进制，其余四家只有 npm 包。因此分两条路径实现。

| 工具 | 版本 | 发行方式 | 模板 | 自检输出 | 耗时 |
| --- | --- | --- | --- | --- | --- |
| Claude Code | 2.1.296 | npm 包 | `npm-global-into-version-dir` | `2.1.296 (Claude Code)` | 10.2s |
| Gemini CLI | 0.63.0 | npm 包 | `npm-global-into-version-dir` | `0.63.0` | 38.8s |
| GitHub Copilot CLI | 1.0.95 | npm 包 | `npm-global-into-version-dir` | `GitHub Copilot CLI 1.0.95.` | 35.5s |
| Qwen Code | 0.25.1 | npm 包 | `npm-global-into-version-dir` | `0.25.1` | 62.0s |
| OpenCode | 1.19.0 | 官方独立二进制 | `zip-single-file-into-version-dir` | `1.19.0` | 52.2s |
| Codex CLI | 0.162.1 | 官方独立二进制 | `zip-single-file-into-version-dir` | `codex-cli 0.162.1` | 65.0s |

安装后的版本目录体积：

```
claude-code    249M
gemini-cli     106M
copilot-cli    152M
qwen-code      167M
opencode       173M   （解出的 opencode.exe）
codex          319M   （zip 里叫 codex-x86_64-pc-windows-msvc.exe，asName 落成 codex.exe）
```

### 供应链差异的实测数字（写进了清单 notes，不是猜测）

```
@anthropic-ai/claude-code 顶层 tarball :      29,001 字节  ← devkit 固定的就是它（SHA-256）
装完版本目录                            : 249 MB          ← 多出来的部分由 npm 在安装时下载
                                                            （@anthropic-ai/claude-code-win32-x64 可选依赖）
```

→ 所以 npm 类工具**不能**宣称与「官方直链 + SHA-256」等价。清单 `notes` 里写清了这一点，
`docs/UPGRADE-PLAN` 之外的读者也能在界面「详情」里看到。Codex / OpenCode 走的是直链 + SHA-256，
与其它工具完全一致。

### 没有污染全局 npm（独立核对）

用的是 `npm install --global --prefix <版本目录>`，bin 落在版本目录里：

```
$ ls %USERPROFILE%\.devkit\versions\claude-code\2.1.296
claude  claude.cmd  claude.ps1  node_modules
```

顺带查了一下 `%APPDATA%\npm`（那里确实有 `claude.cmd` / `codex.cmd` 等），结论是**与本次安装无关**：

```
$ ls -lad %APPDATA%/npm
lrwxrwxrwx ... C:\Users\张三\AppData\Roaming\npm -> /d/npm/npm-global

那些 .cmd 的时间戳：claude/codex/gemini = 10-10 16:45，copilot = 03-19（用户此前自己全局装的）
本次安装发生在 10-12 18:36~18:50，该目录里**没有任何 10-12 的文件**。
```

### 顺带修掉的一个许可证策略缺口

加 AI 清单时发现：`packOffline` **不按 tier 过滤**，用户能把 L2（不可再分发）的工具打进离线包 ——
这违反 SPEC §8 自己的规定，而且是许可证问题不是技术问题。已修：

- 抽出纯函数 `partitionByRedistributable()`，只让 L1 进离线包
- 被排除的项写进 `OfflinePackResult.skipped`，界面提示里列出来（`vscode(L2)` 这样）
- 4 个单测覆盖（含「全是 L2 时 packable 为空，而不是硬塞进去」）

### npm 模板的两条硬约束（都有单测）

1. `binName` 必填且拒绝路径穿越（`../evil`、`a/b`、`a b`、`a.exe;calc` 全部拒绝）
2. `extraArgs` 只接受白名单开关（`--registry=http://evil;calc` 被拒）

另外 AI 类清单加了一组**跨清单不变量测试**：每个 AI 工具必须有 `activate` 且指向 `{currentDir}`、
必须有 `verify`、npm 类必须是 L2、有官方二进制的必须是 L1、npm 类的 `notes` 必须写明供应链差异、
`verify` 必须指向 `binName.cmd`、每个版本必须有镜像回退。

---

## 3.12 批量产物根目录（修掉两个真实缺陷）

用户问「为什么都下载到 `%APPDATA%\devkit` 而不是 PATH 那里」时，核查后发现两个真缺陷：

**缺陷 1：下载缓存有两个，互不相通**

```bash
$ grep -rn "downloads" src/main/core/executor/service.ts scripts/install-tool.ts
src/main/core/executor/service.ts:  downloadDir: getDownloadDir()          # %APPDATA%\devkit\downloads
scripts/install-tool.ts:  const downloadDir = join(home, '.devkit', 'downloads')   # %USERPROFILE%\.devkit\downloads
```

同一个文件在两条路径下各下一份，缓存永远命中不了。实测两个目录里都有过内容
（脚本那份删之前是 982 MB，应用那份 288 KB）。

**缺陷 2：缓存在 C 盘且改不了**

下载缓存是批量产物（实测 1 GB 级），却硬编码在 `%APPDATA%`（C 盘），没有任何设置能改。

**修法**：抽出 `getDataRoot()`，优先级 `DEVKIT_DATA_ROOT` 环境变量 → 设置里的 `dataRoot` → 默认
`%USERPROFILE%\.devkit`；`versions` / `downloads` / `current` / `bin` 全部挂在它下面；
界面与命令行脚本走**同一套**解析。

**真机验证**（把根目录指到 D 盘，装一个工具）：

```bash
$ DEVKIT_DATA_ROOT=D:\work\work\devkit-root-test pnpm install:tool ninja
数据根目录  D:\work\work\devkit-root-test
  安装位置  D:\work\work\devkit-root-test\versions\ninja\1.13.2
  下载缓存  D:\work\work\devkit-root-test\downloads
  自检通过：1.13.2

$ find D:/AgentWork/work/devkit-root-test -type d
D:/AgentWork/work/devkit-root-test
D:/AgentWork/work/devkit-root-test/downloads
D:/AgentWork/work/devkit-root-test/logs
D:/AgentWork/work/devkit-root-test/versions
D:/AgentWork/work/devkit-root-test/versions/ninja
D:/AgentWork/work/devkit-root-test/versions/ninja/1.13.2
```

→ 版本目录、下载缓存、日志全部落在 D 盘，C 盘没有被写。

**7 个单测**覆盖优先级（默认 / 配置 / 环境变量 / 空白值当未设置 / trim）与"所有批量产物都跟着根目录走"。

---

## 3.14 环境体检与环境档案（真机验证）

### 体检：在一台真实开发机上跑出来的结果

```
[doctor] 体检完成：1 个问题、2 个注意、3 项正常

machinePath: 33 条 → ok 23 / missing 3 / unexpanded-var 1 / malformed 4 / duplicate 2
userPath:     4 条 → ok 4
findings: machine-path-problems(error, 10 条证据, 可修复)
          command-ambiguous(warn, 10 条证据)
          system-items(warn, 3 条证据)
```

判定结果与手工逐条分析**完全一致**。机器级 PATH 里的
`C:\P` / `ogram Files\Git\cmd` 是 PATH 被截断写入（setx 的 1024 字符问题）的铁证。

`command-ambiguous` 抓到的是真正会让人困惑的东西：

```
python → D:\Python\python.exe（实际生效）
python → C:\Program Files\LibreOffice\program\python.exe
npm    → C:\Users\张三\AppData\Roaming\npm\npm（实际生效）
npm    → D:\node\npm  /  D:\npm\npm-global\npm
git    → ...\Git\mingw64\bin\git.exe（实际生效） / ...\Git\cmd\git.exe
```

**判定规则的一次自我修正**：第一版把「看起来像被截断」当独立判据，
结果 `D:\go` 这种合法的两字符目录被误报成坏条目。改成只有「目录不存在」时才提示「像被截断」。
误报会让用户不敢点修复，所以这条修正很重要 —— 测试里刻意留了一条断言把这件事钉住。

### 档案：真机导出的实际内容

```
$ exportProfile({ includeGitIdentity: true })
[profile] 已收集环境档案：25 个检测结果、0 个 devkit 安装、3 条自定义 PATH、2 个环境变量、0 个插件

文件 4041 字节，密钥扫描 0 命中
env     : {JAVA_HOME: D:\jdk\jdk 17, GOPATH: %USERPROFILE%\go}
path    : [D:\Python, D:\Python\Scripts, D:\npm\npm-global]
git     : {userName: ..., userEmail: ...}   ← 默认不带，这次是显式勾选的
selections: 15 项（bun / go / jdk-temurin / nodejs / python / maven / wsl2 / claude-code / ...）
```

**密钥扫描 0 命中**（`token|password|secret|apikey|credential|gho_|ghp_|sk-|PRIVATE KEY`）。
环境变量只收了白名单里的路径变量；`.npmrc` 的 token、SSH 私钥、git credential 都没碰。

8 个单测覆盖「外部档案当不可信输入」的场景：环境变量只收白名单名
（`NODE_OPTIONS` / `npm_config_registry` 这类会被丢弃）、PATH 条目必须是绝对路径、
工具 id 与版本号走清单字符集（`../evil`、`..` 被拒）、插件列表有上限。

### 顺带修掉的一个真 bug

提权助手里的注册表路径写在 TS 模板字符串里，`\S` 被当成转义吃掉，
PowerShell 收到的是 `HKLM:SYSTEM...` —— 脚本会直接失败，而且报错完全指不到原因。
加了 `helper-script.test.ts` 把生成的脚本内容钉死。

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
| junction 增删 | `core/activate/junction.test.ts` | 真实文件系统：创建/幂等/切目标/**删链接不动目标**/拒绝删真实目录/不存在路径空操作 |
| 离线包 | `core/offline/index.test.ts` | 校验通过才入缓存、被篡改的文件被拒绝、缺索引给出可读错误 |

---

## 4.5 独立安全审查（对抗性，只读）

用独立子代理对 `core/templates` / `core/zip` / `core/activate` / `core/ipc` / `core/elevation` /
`core/downloader` / `core/hotupdate` 做了一轮对抗性审查，完整记录见 [docs/security-review.md](./security-review.md)（含每条的修法与回归测试位置）。

**结论：设计站得住的部分**（审查原话）：模板白名单「清单只引用、不定义命令」；
zip 自行计算并校验最终路径而不依赖库；junction 只删链接；PATH 改前备份 + 只动自有条目 + 注册表
ExpandString；热更新不合并 detect/install/activate；提权脚本不混淆可审计、一次 UAC。

**发现并已修复 6 个真实问题**，每条都补了回归测试（`src/main/core/security-regression.test.ts`，
15 个用例）：

| 级别 | 问题 | 修法 | 回归测试 |
| --- | --- | --- | --- |
| 高 | 版本号 `..` 让安装目录逃逸到 versions 根目录，可覆盖其它工具的二进制 | Schema + 白名单 + IPC 三处收紧版本号；`buildPlan` 再算 `relative(versionsRoot, installDir)` 兜底 | 「H1 版本号不得逃逸安装目录」3 条 |
| 高 | `mirrorsApply` 未校验地址 → gradle/cargo 配置文件注入（持久化 RCE） | 共享白名单字符集 `MIRROR_URL_PATTERN`，IPC + 写入前双重校验 | 「H2 镜像地址字符集」3 条 |
| 高 | 提权安装 TOCTOU：包在用户可写目录，可在 UAC 前被替换 | 期望 SHA-256 进 job，助手脚本执行前用 .NET 重算 | 「H3 提权执行前重新校验安装包哈希」2 条 |
| 中 | https 重定向可降级到 http | `shouldFollowRedirect` 纯函数，生产模式拒绝降级 | 「M1」2 条 |
| 中 | 用户自定义的 `DEVKIT_HOME` 被覆盖后又删除 | 写前先读，指向别处则改用绝对路径并告警 | 逻辑见 `activate/index.ts` |
| 中 | 离线包 `fileName` 未校验，可读写下载目录之外 | 只接受单层文件名；离线包目录必须绝对路径 | 「M3」3 条 |
| 低 | ZIP 条目名含 `:`（NTFS 数据流） | 一律拒绝 | 「L1」2 条 |

**顺带抓到一个环境级问题**：本机 PowerShell 5.1 里 `Get-FileHash` **不存在**
（`Microsoft.PowerShell.Utility` 不完整，实测 `Get-Command Get-FileHash` 报找不到）。
提权助手的哈希校验一开始全部失败 —— 改成 `[System.Security.Cryptography.SHA256]` 直接算，
不再依赖任何 cmdlet。这条如果没做真机验证是发现不了的。

---

## 5. 尚未验证的部分（诚实清单）

| # | 未验证项 | 为什么 | 怎么才能验证 |
| --- | --- | --- | --- |
| 1 | 机器级 MSI 真实安装（7-Zip） | 需要 UAC 与写 HKLM，不能在本机做 | 干净虚拟机里跑一次，确认只弹一次 UAC、装完能激活、卸载干净 |
| 2 | `exe-nsis-silent` 模板真机行为 | 当前清单里没有用这个模板的可装项 | 找一个 NSIS 发行版（如 7-Zip 的 `7z*-x64.exe`）在虚拟机里验证 |
| 3 | "新开终端 `node -v` 生效" | 需要一台原本没装过 Node 的机器 | 干净虚拟机 + 打开一个新的 cmd 窗口 |
| 4 | `Checkpoint-Computer` 还原点 | 需要管理员，且多数机器未启用系统保护 | 虚拟机里开启系统保护后验证 |
| 5 | 代码签名 | 需要 SignPath 账号与 CI 凭据 | 申请后接入 `release.yml` |
| 6 | 更新检查的端到端 | 需要一个**可匿名访问**的 https 更新源；私有仓库的 Release 资产需要鉴权，取不到 | 把 `latest.json` 放到任意可公开访问的 https 静态托管，填进设置即可验证 |

> 第 1~4 项都需要一台**干净虚拟机**。SPEC §12 已经确认过用户愿意安装
> VMware Workstation Player / VirtualBox 用于这类验收。

**已从本清单移出（本轮已实测）**：

- ~~用户 PATH 的真实写入~~ → §3.5 已真机完成「写入 + 备份 + 逐字节还原」
- ~~GitHub Release 发布~~ → §3.10 已在 GitHub 上跑通 `release.yml` 并发布 v0.1.0

---

## 6. 本机被改动了什么（可回退性）

为了验证，本机发生了这些变化：

| 变化 | 位置 | 怎么回退 |
| --- | --- | --- |
| 安装了 5 个工具到版本目录（约 843 MB） | `%USERPROFILE%\.devkit\versions\` | 删掉目录，或在界面「已安装」里逐个卸载 |
| 下载缓存 | `%USERPROFILE%\.devkit\downloads\` | 直接删 |
| 应用配置 / 日志 / 激活记录 | `%APPDATA%\devkit\` | 直接删（不会影响系统） |
| 用户 PATH（**已逐字节还原**） | `HKCU\Environment\Path` | 备份文件：`%APPDATA%\devkit\backup\user-path-20261012-153737.txt` |
| VS Code 安装器自己加的那条 PATH（**已移除**） | `...\versions\vscode\1.141.0\bin` | 已移除，PATH 与测试前逐字节一致（82 字符） |
| 一个 junction（**已删除**） | `%USERPROFILE%\.devkit\current\nodejs` | 已不存在 |

**没有发生的变化**（这是"安装 ≠ 激活"的直接结果）：

- 没有写 `Program Files`
- 没有写 `HKLM`
- 没有触发过 UAC
- 没有改任何系统设置（`SystemConfig` 里只做了**读**）
- 用户 PATH 在激活测试后与测试前**逐字节相同**

> 安装脚本 `scripts/install-tool.ts` 里没有注入 `activate` 回调，
> 所以它在结构上就不可能改 PATH —— 这不是"没做"，是"做不到"。
