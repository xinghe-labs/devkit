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

SignPath 对开源项目提供免费签名（含时间戳）。申请时需要：

- 一个公开的源码仓库（**注意：目前 `xinghe-labs/devkit` 是私有的，需要先转为公开**）
- MIT 之类的开源许可证（本项目是 MIT ✅）
- 项目简介 + 为什么需要签名

> 转公开这件事本身就是"面向陌生人发布"的前置条件之一 —— 私有仓库的 Release 资产需要鉴权，
> 连更新检查都取不到。所以签名申请与"公开仓库"是同一件事的两面。

---

## 申请与配置步骤

### 1. 申请 SignPath 开源签名

1. 到 <https://signpath.org/> 点 "Apply for open source code signing"
2. 用 GitHub 账号登录并授权
3. 填项目信息（仓库地址、许可证、用途）
4. 等审批（官方说通常几个工作日）

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
Get-AuthenticodeSignature .\devkit-0.3.0-setup.exe | Format-List Status, SignerCertificate
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
