import type { ActivateSpec } from '@shared/types'

/**
 * 激活相关的**纯逻辑**：占位符展开、PATH 增删。
 *
 * 这个文件不 import electron、不碰文件系统 —— 因为 PATH 处理是「改坏用户环境」的
 * 高风险点，必须能用单测把边界情况钉死（含中文路径、含空格、大小写差异、
 * 尾随反斜杠、重复条目、PATH 超长）。
 */

export interface ActivateVars {
  installDir: string
  /** %USERPROFILE%\.devkit\current\<linkName> */
  currentDir: string
  version: string
  toolId: string
}

const PLACEHOLDER = /\{([a-zA-Z][a-zA-Z0-9]*)\}/g

export class ActivateSpecError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ActivateSpecError'
  }
}

export function renderActivatePath(input: string, vars: ActivateVars): string {
  return input.replace(PLACEHOLDER, (_match, name: string) => {
    switch (name) {
      case 'installDir':
        return vars.installDir
      case 'currentDir':
        return vars.currentDir
      case 'version':
        return vars.version
      case 'toolId':
        return vars.toolId
      default:
        throw new ActivateSpecError(`激活声明里的占位符 {${name}} 不被支持`)
    }
  })
}

export interface ActivateEntries {
  linkName: string
  pathEntries: string[]
  env: Record<string, string>
}

/**
 * 把清单里的 activate 声明展开成"要写进用户环境的最终值"。
 * 只支持 {installDir} / {currentDir} / {version} / {toolId} 四个占位符，
 * 出现别的就报错 —— 静默放行只会让用户拿到一条指向乱码目录的 PATH。
 */
export function buildActivateEntries(spec: ActivateSpec, vars: ActivateVars): ActivateEntries {
  const linkName = spec.linkName ?? vars.toolId

  const pathEntries = (spec.pathEntries ?? []).map((entry) => {
    const rendered = renderActivatePath(entry, vars)
    if (rendered.trim() === '') {
      throw new ActivateSpecError(`${vars.toolId} 的激活声明里有空路径`)
    }
    if (rendered.includes(';')) {
      throw new ActivateSpecError(`${vars.toolId} 的激活路径不能包含分号：${rendered}`)
    }
    return rendered
  })

  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(spec.env ?? {})) {
    if (!/^[A-Z][A-Z0-9_]{0,40}$/.test(name)) {
      throw new ActivateSpecError(`${vars.toolId} 的激活环境变量名不合法：${name}`)
    }
    env[name] = renderActivatePath(value, vars)
  }

  return { linkName, pathEntries, env }
}

/* ------------------------------------------------------------------ */
/* PATH 增删                                                           */
/* ------------------------------------------------------------------ */

/** 拆成条目并丢掉空段（PATH 里连续分号会解析出空条目） */
export function splitPath(value: string): string[] {
  return value
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part !== '')
}

/**
 * 条目比较用的规范形：小写 + 去掉尾随反斜杠/斜杠。
 * Windows 的 PATH 比较是大小写不敏感的，尾随反斜杠也无意义。
 */
export function normalizePathEntry(entry: string): string {
  return entry.replace(/[\\/]+$/, '').toLowerCase()
}

export interface MergeResult {
  value: string
  added: string[]
  alreadyPresent: string[]
}

/**
 * 把条目插到 PATH **最前面**（devkit 激活的版本优先于系统里已有的同名工具），
 * 已在 PATH 里的条目不会重复插入，但会被提到最前面。
 */
export function prependPathEntries(currentPath: string, entries: string[]): MergeResult {
  const existing = splitPath(currentPath)
  const existingNormalized = new Set(existing.map(normalizePathEntry))

  const added: string[] = []
  const alreadyPresent: string[] = []
  const wanted: string[] = []
  const wantedNormalized = new Set<string>()

  for (const entry of entries) {
    const key = normalizePathEntry(entry)
    if (wantedNormalized.has(key)) continue
    wantedNormalized.add(key)
    wanted.push(entry)
    if (existingNormalized.has(key)) alreadyPresent.push(entry)
    else added.push(entry)
  }

  const rest = existing.filter((entry) => !wantedNormalized.has(normalizePathEntry(entry)))
  return { value: [...wanted, ...rest].join(';'), added, alreadyPresent }
}

/** 精确移除给定条目（其余原样保留，顺序不变） */
export function removePathEntries(currentPath: string, entries: string[]): string {
  const doomed = new Set(entries.map(normalizePathEntry))
  return splitPath(currentPath)
    .filter((entry) => !doomed.has(normalizePathEntry(entry)))
    .join(';')
}

/**
 * 比较两次 PATH，列出"后来新增"的条目（大小写与尾随分隔符不敏感）。
 *
 * 用途：有些官方安装器会自己往用户 PATH 里写目录（实测 VS Code 的 Inno 安装器），
 * 这跟 devkit 的「安装 ≠ 激活」原则冲突。安装前后各取一次 PATH，用这个函数算出
 * 被加了什么，然后整体还原并告知用户。
 */
export function diffPathEntries(before: string, after: string): string[] {
  const known = new Set(splitPath(before).map(normalizePathEntry))
  return splitPath(after).filter((entry) => !known.has(normalizePathEntry(entry)))
}

/** PATH 里是否已经有某个条目 */
export function hasPathEntry(currentPath: string, entry: string): boolean {
  const key = normalizePathEntry(entry)
  return splitPath(currentPath).some((item) => normalizePathEntry(item) === key)
}
