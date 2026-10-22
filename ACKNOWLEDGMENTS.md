# Thanks / 致谢

devkit 站在这些项目的肩膀上。

## 工具链

| 项目 | 用在哪 |
| --- | --- |
| [Electron](https://www.electronjs.org/) | 桌面壳 |
| [electron-vite](https://electron-vite.org/) / [Vite](https://vite.dev/) | 构建 |
| [React](https://react.dev/) + [TypeScript](https://www.typescriptlang.org/) | 渲染进程 |
| [Ant Design](https://ant.design/) | UI 组件 |
| [Zustand](https://github.com/pmndrs/zustand) | 状态 |
| [i18next](https://www.i18next.com/) | 中英文案 |
| [Vitest](https://vitest.dev/) | 测试（541 用例） |
| [electron-builder](https://www.electron.build/) | NSIS / portable 打包 |
| [GitHub Actions](https://github.com/features/actions) | CI / 发布 / 签名流水线 |

## 思路上的参照与对照

devkit 的差异化（「配置 + 验证 + 可回滚」当主产品，安装只是副产物）来自对现有方案缺口的
调研，见 [docs/market-research.md](./market-research.md)。这些项目各自解决了一部分问题：

- [winget](https://github.com/microsoft/winget-cli) —— 微软官方包管理器；devkit 的镜像源、
  镜像探测、装后自检直接回应它的 PATH 写入 bug（[#3601](https://github.com/microsoft/winget-cli/issues/3601)、
  [#5557](https://github.com/microsoft/winget-cli/issues/5557)）
- [Chocolatey](https://chocolatey.org/) / [Scoop](https://scoop.sh/) —— devkit 不自建包仓库、
  只走官方直链 + SHA-256，是对它们供应链事件的回应
- [nvm-windows](https://github.com/coreybutler/nvm-windows) / [jenv](https://github.com/jenv/jenv) ——
  多版本切换的参照；devkit 用 junction + 固定 PATH 条目，切版本不用改 PATH
- [Ninite](https://ninite.com/) —— "选好就装"的交互原型；devkit 不做泛化装机，聚焦开发工具链
- Microsoft [Dev Home](https://learn.microsoft.com/en-us/windows/dev-home/) —— 已弃用。
  它的教训写进了 SPEC：功能面太宽、没有收敛到单一强痛点

## 数据来源

- Node.js / Python / Go / Adoptium(Temurin) / Gradle / Maven / Git for Windows 的
  **官方发布源**—— 清单里的版本号与 SHA-256 全部来自它们，镜像只用于加速下载
- [endoflife.date](https://endoflife.date/) —— 确定各工具"常用版本线"时参考
- V2EX / 博客园 / CSDN 上的装机痛点讨论 —— 需求验证的一手样本（见市场调研文档）

## 许可证

devkit 本身是 [MIT](./LICENSE)。清单里各软件的许可证逐项登记在
`resources/manifest/tools/*.json` 的 `license` 字段，并按「可再分发与否」分级（L1/L2/L3）——
离线包只包含 L1 类，就是这个分级在起作用。
