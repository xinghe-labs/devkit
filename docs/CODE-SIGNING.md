# 代码签名（Code Signing）

> 现状：**安装包未签名**。`release.yml` 里已经写好签名步骤，但**没有配置密钥时会自动跳过** ——
> 所以流水线现在依然是绿的。你申请到账号后，按下面填几个 secret 就会自动开始签名。

---

## 为什么必须签

未签名的 exe 从网上下载后双击，Windows SmartScreen 会弹全屏红字「Windows 已保护你的电脑」。
对开发者工具来说这不只是"体验差一点"：

- 目标用户是**刚装完系统的开发者**，他们第一件事就是下载这个 exe
- 一个"帮你装环境"的工具，第一步被系统标成可疑程序 → 绝大多数人到这里就关了
- 有用户会去搜"devkit 是不是病毒"，搜到的只有负面印象

签名之后 SmartScreen 不再拦截，同时用户可以验证发布者身份、也能检出被篡改的安装包。

---

## 选哪个方案

| 方案 | 成本 | 适用 |
| --- | --- | --- |
| **[SignPath](https://signpath.org/)** | **开源项目免费** | ✅ 本项目推荐 |
| Azure Trusted Signing | 约 $10/月 | 需要企业主体 |
| OV/EV 代码签名证书 | $100~400/年 | 商业项目 |
| 不签 | 0 | 只能小范围内测 |

### 申请条件（逐条核对过官方 terms）

> 来源：<https://signpath.org/terms.html>（2026-10 核对）。
> **这里刻意不简化** —— 少列一条，你去申请就会被拒，而且不知道原因。

**基础资格**

| 条件 | devkit 现状 |
| --- | --- |
| 不含恶意代码 / 潜在不受欢迎程序 | ✅ |
| OSI 认可的开源许可证，且无商业双授权 | ✅ MIT |
| 不含专有组件（含维护者自己发布的闭源部分） | ✅ |
| **活跃维护** | ✅ |
| **已经发布过**（要签的那个形态） | ✅ 9 个 release |
| 下载页/应用商店页有功能说明 | ✅ README |

**证书条件（用 SignPath Foundation 的证书时额外要求）**

| 条件 | devkit 现状 |
| --- | --- |
| 只签自己的项目 / 只签自己源码构建的产物 | ✅ |
| 不是黑客工具（不做漏洞扫描/绕过安全机制） | ✅ |
| **尊重用户隐私**：不向非用户指定的系统传输数据 | ✅ 零遥测 |
| **公告系统变更**：不得在无提示的情况下改用户系统配置 | ✅ 会先说明并备份 |
| **提供卸载** | ✅ FR-16 |

**贡献者与仓库**

| 条件 | devkit 现状 |
| --- | --- |
| **GitHub 与 SignPath 账号都必须开 MFA** | ⚠️ **自己去 GitHub 设置里确认** —— 个人账号的 MFA 状态 API 查不到 |
| **仓库首页要有「Code signing policy」章节** | ✅ README 末尾（含署名、角色、隐私声明） |
| 其中要写明 **Authors / Reviewers / Approvers** 三个角色与成员 | ✅ 单人项目，三角色同一人 |
| 其中要有隐私政策，或指定那句固定表述 | ✅ 已写 |

**SignPath 侧配置**

| 条件 | 说明 |
| --- | --- |
| **Artifact Configuration 必须设置并强制 metadata** | 见下面「metadata 限制」一节 |
| 每次发布**需要人工批准** | 这是流程变化：签名请求发出后要有人在控制台点批准，不是全自动 |

**流程与耗时**：填表 → 官方审核 → 通常 **1~5 个工作日**。
官方对"项目声誉"有主观裁量权，也明确写了"我们没有义务接受你的项目"——
所以材料要写清楚（项目做什么、为什么需要签名、SmartScreen 对开发者工具的影响）。

> 转公开这件事本身就是"面向陌生人发布"的前置条件之一 —— 私有仓库的 Release 资产需要鉴权，
> 连更新检查都取不到。所以签名申请与"公开仓库"是同一件事的两面。

---

## 申请与配置步骤

### 1. 申请 SignPath 开源签名

1. 到 <https://signpath.org/> 点 "Apply for open source code signing"
2. 用 GitHub 账号登录并授权
3. 填项目信息（仓库地址、许可证、用途）
4. 等审批（官方说通常 1~5 个工作日）

> 申请材料建议写：项目做什么（在干净 Windows 上装好/配好/验好开发环境）、
> 为什么需要签名（目标用户是刚装完系统的开发者，一个"帮你装环境"的工具第一步被
> SmartScreen 标红，绝大多数人到这里就关了）、以及仓库地址与许可证。

### 2. 在 SignPath 控制台里建三样东西

| 要建的东西 | 建议 slug | 说明 |
| --- | --- | --- |
| Project | `devkit` | 对应本仓库 |
| Signing Policy | `release-signing` | 定义"打 tag 时用哪张证书签" |
| Artifact Configuration | `nsis-installer` | 告诉 SignPath **签包里的哪个文件** |

Artifact Configuration 的写法见 SignPath 官方文档：
<https://docs.signpath.io/artifact-configuration/>

> 这里刻意不抄一份 XML 过来 —— 它的 schema 会随版本变化，抄错了比没有更糟。
> 请以官方文档为准。要点是：对 NSIS 安装包，需要签的是**安装包本身**以及**它内嵌的
> `devkit.exe`**（`signpath.io` 的文档里叫 "nested PE files"）。

#### metadata 限制（容易漏，但官方是硬性要求）

官方要求：所有被签的二进制都必须**设置并强制**元数据属性 ——

- 所有 *product name* 属性设成项目名（`devkit`）
- 所有 *product version* 属性设成同一个值（每次构建都要一致）

对应官方文档的
[metadata restrictions](https://about.signpath.io/documentation/artifact-configuration/reference#metadata-restrictions)。
漏了这条，签名请求会失败或被拒 —— 而且报错通常只说"不满足策略"，指不到具体哪一项。

electron-builder 侧要保证 `productName` 与 `version` 稳定（`electron-builder.yml` +
`package.json` 的 `version` 已经是构建时注入的，与 tag 一致）。

### 3. 填 GitHub 的 secret 与 variable

**Settings → Secrets and variables → Actions**

Secrets（加密，不显示）：

| 名称 | 值 |
| --- | --- |
| `SIGNPATH_API_TOKEN` | SignPath 控制台里生成的 API token |

Variables（明文，可改）：

| 名称 | 值 | 不填时的默认值 |
| --- | --- | --- |
| `SIGNPATH_ORGANIZATION_ID` | SignPath 里的 organization id | — |
| `SIGNPATH_PROJECT_SLUG` | `devkit` | `devkit` |
| `SIGNPATH_POLICY_SLUG` | `release-signing` | `release-signing` |
| `SIGNPATH_ARTIFACT_CONFIG_SLUG` | `nsis-installer` | `nsis-installer` |

> **只要 `SIGNPATH_API_TOKEN` 没配，签名步骤就会整段跳过**，产物仍是未签名的 —— 流水线不会红。

### 4. 验证

打一个新 tag，看 Release 流水线的日志里有没有：

```
提交 SignPath 签名请求
...
签名完成，已替换 release/devkit-<版本>-setup.exe
```

然后本地核对（Windows PowerShell 7 里 `Get-AuthenticodeSignature` 可用）：

```powershell
Get-AuthenticodeSignature .\devkit-0.6.1-setup.exe | Format-List Status, SignerCertificate
# Status 应该是 Valid
```

---

## 代码里已经做好的部分

`release.yml` 里这些步骤**已经写好并接进流水线**：

1. `actions/upload-artifact@v4` 上传未签名的 NSIS 安装包
2. `signpath/github-action-submit-signing-request@v1` 提交签名请求并等待完成
3. 把签好名的文件拷回 `release/`（覆盖未签名的那份）
4. 后面 `action-gh-release` 上传的就是**签名后的**产物
5. 最后加一步：打印产物的签名状态，方便在日志里一眼确认

也就是说：**你只需要申请账号 + 填 secret，不需要改代码。**

---

## 顺带说明：便携版

`devkit-<版本>-portable.exe` 是 electron-builder 打的单文件自解压包，**也可以签**，
但需要在 SignPath 里再建一个 Artifact Configuration（它内嵌的文件层级与 NSIS 不同）。

如果只签一个，**优先签 NSIS 安装包** —— 那是绝大多数用户会下载的那个。
README 里也建议用户优先用安装版。
