/**
 * IPC 通道白名单。
 * 主进程只注册这里列出的通道，预加载只暴露这里列出的通道 —— 两侧共用同一份常量，
 * 避免出现"渲染进程调了一个主进程没实现的通道"这种运行时才发现的问题。
 */
export const IPC = {
  /** 应用与运行环境信息 */
  appInfo: 'app:info',

  /** 读取清单（含校验错误） */
  manifestList: 'manifest:list',

  /** 执行环境检测 */
  detectRun: 'detect:run',

  /** 读取/设置界面语言 */
  localeGet: 'locale:get',
  localeSet: 'locale:set',

  /** 读取日志尾部 / 打开日志目录 */
  logTail: 'log:tail',
  logOpenDir: 'log:open-dir',

  /** 渲染进程完成挂载后回执，主进程据此确认三端链路已通 */
  rendererReady: 'app:renderer-ready',

  /** 安装：构建计划 + 预检 */
  installPrepare: 'install:prepare',
  /** 安装：开始执行 */
  installStart: 'install:start',
  /** 安装：取消 */
  installCancel: 'install:cancel',
  /** 读取/丢弃上次未完成的计划（FR-17 续跑） */
  installPending: 'install:pending',
  installDiscardPending: 'install:discard-pending',
  /** 续跑上次未完成的计划（FR-17） */
  installResume: 'install:resume',
  /** 导出安装报告（FR-9） */
  installExportReport: 'install:export-report',

  /** 预设方案（FR-3） */
  presetList: 'preset:list',
  presetSave: 'preset:save',
  presetDelete: 'preset:delete',
  presetImport: 'preset:import',

  /** 激活 / 版本切换（FR-11） */
  activateSnapshot: 'activate:snapshot',
  activateApply: 'activate:apply',
  activateRemove: 'activate:remove',

  /** 已安装项与卸载（FR-16） */
  installedList: 'installed:list',
  uninstallRun: 'uninstall:run',

  /** 设置与镜像源（FR-5 / FR-6） */
  settingsGet: 'settings:get',
  settingsSave: 'settings:save',
  mirrorsApply: 'mirrors:apply',

  /** 用系统浏览器打开 https 链接 */
  appOpenExternal: 'app:open-external',

  /** VS Code 插件（FR-7） */
  vscodeStatus: 'vscode:status',
  vscodeList: 'vscode:list',
  vscodeInstall: 'vscode:install',

  /** 更新检查与半自动升级（FR-13） */
  updateCheck: 'update:check',
  updateDownload: 'update:download',
  updateInstall: 'update:install',

  /** 环境档案 / 换机迁移（FR-22） */
  profileExport: 'profile:export',
  profileImport: 'profile:import',
  profileApply: 'profile:apply',

  /** 环境体检（FR-21） */
  doctorRun: 'doctor:run',
  doctorFix: 'doctor:fix',

  /** 系统配置（FR-6） */
  systemStatus: 'system:status',
  systemApply: 'system:apply',

  /** 清单热更新（FR-15） */
  manifestHotUpdate: 'manifest:hot-update',
  manifestClearOverride: 'manifest:clear-override',

  /** 离线包制作与导入（FR-12） */
  offlinePack: 'offline:pack',
  offlineImport: 'offline:import',

  /** 主进程 → 渲染进程 推送日志 */
  logLine: 'log:line',

  /** 主进程 → 渲染进程 推送安装进度 */
  installProgress: 'install:progress'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

/** 只能由主进程主动推送、渲染进程只能监听的通道 */
export const IPC_PUSH_CHANNELS: readonly IpcChannel[] = [IPC.logLine, IPC.installProgress] as const
