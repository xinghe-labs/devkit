## ⚠️ 请先读这一段（早期版本 · 未签名）

- **安装包未签名** → Windows SmartScreen 会弹「Windows 已保护你的电脑」。
  这是预期行为，点「更多信息」→「仍要运行」即可。签名**暂缓申请**：
  SignPath Foundation 对可执行程序要求「一定的可验证声誉」，等项目积累一些实际使用。
  理由与触发条件见 [docs/CODE-SIGNING.md](https://github.com/xinghe-labs/devkit/blob/main/docs/CODE-SIGNING.md)。
- **还没在全新 Windows 机器上端到端验收过**，机器级安装（MSI/UAC）也没真机验证过。
  未验证清单见 [docs/VERIFICATION.md](https://github.com/xinghe-labs/devkit/blob/main/docs/VERIFICATION.md) §5。
- 只在 Windows 11（中文系统）上验证过；SPEC 声明的最低版本是 Windows 10 22H2。

**界面长什么样？**

| 主界面 | 环境体检 |
| --- | --- |
| ![主界面](https://github.com/xinghe-labs/devkit/raw/main/docs/images/screenshot-main.png) | ![环境体检](https://github.com/xinghe-labs/devkit/raw/main/docs/images/screenshot-doctor.png) |

**下载哪个？**

| 文件 | 用途 |
| --- | --- |
| `devkit-<版本>-setup.exe` | 安装版（有开始菜单/桌面快捷方式，支持将来接自动更新） |
| `devkit-<版本>-portable.exe` | 便携版（免安装，双击即用；不支持自动更新） |
| `latest.json` | 更新索引（含两个产物的 SHA-256 与体积，可用于校验下载是否完整） |

---

