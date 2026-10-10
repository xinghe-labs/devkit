import type {
  AppInfo,
  DetectRequest,
  DetectionResult,
  Locale,
  LogEntry,
  ManifestLoadResult
} from './types'

/**
 * 预加载脚本暴露给渲染进程的 API 契约。
 * 主进程侧的实现与渲染进程侧的调用都以此为准，改这里编译器会同时报错两边。
 */
export interface DevkitApi {
  /** 应用与运行环境信息 */
  getAppInfo(): Promise<AppInfo>

  /** 读取清单（含校验错误列表） */
  listManifests(): Promise<ManifestLoadResult>

  /** 执行环境检测；不传 toolIds 表示全部 */
  runDetection(request?: DetectRequest): Promise<DetectionResult[]>

  getLocale(): Promise<Locale>
  setLocale(locale: Locale): Promise<Locale>

  /** 读取最近 count 条日志（渲染进程挂载时回填历史） */
  tailLog(count?: number): Promise<LogEntry[]>
  /** 在系统文件管理器中打开日志目录 */
  openLogDir(): Promise<boolean>

  /** 通知主进程渲染进程已挂载完成 */
  signalReady(): Promise<boolean>

  /** 订阅实时日志，返回取消订阅函数 */
  onLogLine(listener: (entry: LogEntry) => void): () => void
}
