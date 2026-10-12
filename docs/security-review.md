# devkit 对抗性安全审查记录

> 审查方式：**独立子代理、只读**（不修改任何仓库文件），针对 devkit 自己声明的威胁模型逐条构造攻击。
> 审查时间：2026-10-12 · 被审查版本：v0.1.0（M1a~M4 完成后）
>
> 这份记录保留原始发现，并在每条后面附上**实际修法**与**回归测试位置**。
> 未修复或未验证的项会被明确标注 —— 一份只报好消息的审查记录没有价值。

---

## 审查范围与威胁模型

| 面 | 文件 | 威胁模型 |
| --- | --- | --- |
| 清单投毒 | `core/templates`、`core/providers/direct.ts`、`core/hotupdate`、`schema/tool.schema.json` | 清单可远程热更新，若远程内容能影响实际执行的命令，热更新通道即任意代码执行通道 |
| 压缩包投毒 | `core/installer/zip.ts` | zip-slip、符号链接、绝对路径、盘符、空字节、NTFS 数据流 |
| 破坏用户环境 | `core/activate` | 会改用户 PATH、写 HKCU 环境变量、创建/删除 junction |
| IPC 边界 | `main/ipc`、`preload` | 渲染进程理论上不可信（XSS），不能把未校验输入喂给文件系统/命令行/网络 |
| 提权 | `core/elevation` | job/result 文件协议、TOCTOU、路径可控、命令注入 |
| 下载器 | `core/downloader` | 是否存在"校验通过但拿到的不是官方文件"的路径 |

---

## 高危（已全部修复）

### H1 热更新版本号 `..` 使安装目录逃逸，可覆盖已装工具二进制

- **位置**：`core/hotupdate/whitelist.ts:82`、`schema/tool.schema.json`、`core/plan/index.ts:162`
- **问题**：版本号正则 `/^[0-9A-Za-z.\-_+]{1,40}$/` 接受 `..`；Schema 的 `version` 无 pattern；
  `join(versionsRoot, tool.id, version.version)` 会把 `..` 归一化掉。
- **触发**：投毒索引下发 `nodejs` 的 `{"version":"..","recommended":true,...}` —— 能通过白名单与
  Schema 校验并落盘，UI 默认选中该推荐版本，点安装即触发。
- **后果**：installDir 变成 `%USERPROFILE%\.devkit\versions`，直接覆盖真实 `node.exe` →
  用户敲 `node` 执行攻击者代码。这正是「热更新 ≠ 任意代码执行」要排除的场景。
- **修法**：Schema / 白名单 / IPC 三处版本号收紧为 `^[0-9A-Za-z][0-9A-Za-z._+-]{0,39}$`（必须以字母数字开头）；
  `buildPlan` 再算一次 `relative(versionsRoot, installDir)` 做纵深防御。
- **回归测试**：`core/security-regression.test.ts` →「H1 版本号不得逃逸安装目录」（3 条）

### H2 `mirrorsApply` 不校验 url → 配置文件注入

- **位置**：`main/ipc/index.ts`（mirrors 处理器）、`core/config/mirrors.ts`
- **问题**：IPC 层只检查 `typeof url === 'string'`，未复用设置页的 URL 正则。地址会被拼进
  gradle 的 `url '${url}'`、cargo 的 `registry = "${url}"`、maven 的 `<url>`、NuGet 的 `value="..."`、`.condarc`。
- **触发**：渲染进程 XSS 后提交
  `{target:'gradle',enabled:true,url:"https://x'\n}\nallprojects{...exec 'cmd','/c','calc'...};//"}`。
- **后果**：写入 `~/.gradle/init.gradle`、`~/.cargo/config.toml`，用户下次跑 gradle/cargo 即执行任意代码（持久化）。
- **修法**：新增共享白名单字符集 `MIRROR_URL_PATTERN`（`shared/types.ts`），IPC 层校验 target 与 url，
  `applyMirrors` 写入前再校验一次（纵深防御）。
- **回归测试**：`core/security-regression.test.ts` →「H2 镜像地址字符集」（3 条）

### H3 提权安装 TOCTOU（用户级 → 管理员）

- **位置**：`core/providers/direct.ts` → `core/elevation` → `helper-script.ts`
- **问题**：安装包落在用户可写的 `%APPDATA%\devkit\downloads`，只在下载时校验一次 SHA-256。
- **触发**：低权限恶意进程在 `.part` → 正式名 rename 之后替换 MSI/NSIS/Inno 包，等用户为「devkit 安装」点 UAC。
- **后果**：以管理员身份执行攻击者二进制。
- **修法**：把期望 SHA-256 写进提权 job，助手脚本在 `Start-Process` 之前**重新计算**并比对，不一致就拒绝执行。
- **回归测试**：`core/security-regression.test.ts` →「H3 提权执行前重新校验安装包哈希」（2 条）
- **附带发现**：本机 PowerShell 5.1 里 `Get-FileHash` **不存在**（`Microsoft.PowerShell.Utility` 不完整，
  实测 `Get-Command Get-FileHash` 报找不到）。提权助手的哈希校验一开始全部失败 ——
  改成用 `[System.Security.Cryptography.SHA256]` 直接算，不再依赖任何 cmdlet。

---

## 中危（已全部修复）

### M1 https 重定向不校验协议

- **位置**：`core/downloader/http.ts`
- **问题**：跟随重定向时用 `new URL(location, current)` 并按新协议选库，https → http 被静默跟随。
  热更新索引与更新检查走同一路径且索引无签名/哈希 → 能改 http 响应的人即可完全控制热更新清单（可串到 H1）。
- **修法**：抽出纯函数 `shouldFollowRedirect`，生产模式拒绝任何降级；只有测试用的 `allowInsecure` 才放行。
- **回归测试**：`core/security-regression.test.ts` →「M1 重定向不得从 https 降级到 http」（2 条）

### M2 用户已有的 `DEVKIT_HOME` 被覆盖后删除

- **位置**：`core/activate/index.ts`
- **问题**：激活时无条件写 `DEVKIT_HOME`，取消激活最后一个工具时又无条件删除 → 用户/其他工具预定义的值静默丢失。
- **修法**：写前先读；指向别处时**改用绝对路径**并在结果里告警，既不覆盖也不删除。

### M3 离线包 `fileName` 未校验

- **位置**：`core/offline/index.ts`
- **问题**：`join(archivesDir, entry.fileName)` 与 `copyFileSync(source, join(downloadDir, entry.fileName))`
  未校验 `fileName`，`path.join` 归一化 `..` 后可读写下载目录之外的文件。
  （完整任意写链未构造出 —— 需要源文件存在且哈希匹配，标注为**未验证**。）
- **修法**：只接受单层文件名（正则 + 显式拒绝 `..`）；离线包目录必须是绝对路径。
- **回归测试**：`core/security-regression.test.ts` →「M3 离线包文件名必须是纯文件名」（3 条）

---

## 低危（已修复）

### L1 ZIP 条目名含 `:`（NTFS 备用数据流）

- **位置**：`core/installer/zip.ts`
- **问题**：`a.exe:hidden` 会写到目标目录内的一个数据流上。逃不出目标目录，但在磁盘上"看不见"，无正当用途。
- **修法**：条目名含冒号一律拒绝。
- **回归测试**：`core/security-regression.test.ts` →「L1 ZIP 条目名里的冒号被拒绝」（2 条）

### L2 本地清单的 `activate.env` 可写任意 HKCU 环境变量

- **状态**：**不修，但记录在案**。
- **判断**：它确实是持久化原语，但需要本地清单写权限 —— 而拿到本地清单写权限时，
  攻击者本来就能直接改应用文件，威胁模型已经失守。热更新通道**不合并**该字段，所以远程投毒路径是关的。
- **边界**：清单是**受信任的本地内容**，这一点已写进 SPEC。

---

## 审查确认「未发现可利用问题」的部分

- **模板 / 命令行**：模板表写死，`resolveInstallTemplate` 校验模板存在 + 类型 + 参数键 + 正则；
  参数正则禁引号与 shell 元字符；`spawn(shell: false)`，`isFallbackSafe` 在 cmd.exe 回退前再收紧一次。
  **清单无法自定义命令。**
- **热更新白名单**：只接受 version / channel / recommended / arch / size / source(url,sha256) / mirrors /
  installScope；`detect` / `install` / `activate` / `verify` / `uninstall` 全部继承本地；
  缺 sha256 或非 https 一律丢弃。
- **IPC**：`validate.ts` 对 toolId / version / planId / count 有正则与上限；安装计划留在主进程，
  渲染进程只拿 planId；`appOpenExternal` 限 https；VS Code 插件 id 限推荐列表。
- **激活 / 卸载**：`createJunctionAt` / `removeJunctionAt` 先 `lstat` 确认是链接才删，真实目录一律拒绝；
  `removeInstallDir` 有 versionsRoot 前缀校验；PATH 只增删 devkit 自己记录的条目、首次备份、不用会截断的 setx。
  **未发现能删用户真实目录或截断 PATH 的路径。**
- **下载器**：`.part` + 哈希通过才 rename，复用前先校验，`sizeBytes` 兜底。

## 审查认为「值得保留」的设计

模板白名单「清单只引用、不定义命令」；zip 自行计算并校验最终路径而不依赖库；
junction 只删链接；PATH 改前备份 + 只动自有条目 + 注册表 ExpandString；
热更新不合并 detect/install/activate；提权脚本不混淆可审计、一次 UAC；
离线包复用在线下载与校验流程。

---

## 本记录之外：真机测试另发现的缺陷

安全审查是静态的，另有若干问题只能靠**真机跑**才能发现（PowerShell 缺少 `Get-FileHash`、
`.ps1` 缺 BOM 导致中文语法错误、Node 22 下 `.cmd/.bat` 自检 EINVAL、
VS Code 安装器擅自改用户 PATH、慢速源拖死安装等）。完整清单见
[docs/VERIFICATION.md](./VERIFICATION.md)。
