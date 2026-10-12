/**
 * PATH 条目的**纯分析逻辑**。
 *
 * 抽成纯函数（把「目录是否存在」与「环境变量表」当参数传进来）是因为
 * 这段代码要处理的是用户机器上真实存在的脏数据 —— 只有能单测才能保证
 * 它不会把好的条目误判成坏的（误判会导致用户点"一键修复"删掉正确的东西）。
 *
 * 实测样本（开发机的机器级 PATH，33 条）：
 *   rogram Files\dotnet\     ← 被截断的 C:\Program Files\dotnet\
 *   v16.13.1                 ← 一个裸版本号
 *   node_global              ← 相对路径
 *   %NOODE_PATH%             ← 变量名拼错，且该变量不存在
 *   C:\P                     ← C:\Program Files\... 截断残留
 *   ogram Files\Git\cmd      ← 同上
 *   D:\MySQL\bin 与 D:\MySQL\\bin  ← 同一个目录的两种写法
 */

export type PathEntryKind =
  /** 正常：目录存在 */
  | 'ok'
  /** 目录不存在（工具卸载后残留） */
  | 'missing'
  /** 含 %VAR% 但该变量不存在（拼错或已被删除） */
  | 'unexpanded-var'
  /** 畸形：相对路径、裸版本号、截断片段 */
  | 'malformed'
  /** 与前面的条目重复 */
  | 'duplicate'

export interface PathEntryAnalysis {
  /** 在 PATH 里的位置（从 1 开始，方便用户对照） */
  index: number
  raw: string
  /** 展开 %VAR% 之后的路径 */
  expanded: string
  kind: PathEntryKind
  /** 人话说明（只在非 ok 时给出） */
  reason?: string
  /** 与哪一条重复（kind=duplicate 时给出，1-based） */
  duplicateOf?: number
}

export interface AnalyzeOptions {
  /** 判断目录是否存在（由调用方注入，便于测试） */
  exists: (path: string) => boolean
  /** 环境变量表（大小写不敏感查找由本函数负责） */
  env: Record<string, string | undefined>
}

/** 大小写不敏感地取环境变量 */
function lookupEnv(env: Record<string, string | undefined>, name: string): string | undefined {
  if (env[name] !== undefined) return env[name]
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase())
  return key ? env[key] : undefined
}

/**
 * 展开 %VAR%。与 utils/env-vars.ts 的 expandEnvVars 不同：
 * 那里"找不到就保留原文"，这里要**把找不到的变量识别出来**，
 * 所以额外返回 unresolved 列表。
 */
export function expandWithReport(
  input: string,
  env: Record<string, string | undefined>
): { expanded: string; unresolved: string[] } {
  const unresolved: string[] = []
  const expanded = input.replace(/%([^%]+)%/g, (whole, rawName: string) => {
    const name = String(rawName).trim()
    if (name === '') return whole
    const value = lookupEnv(env, name)
    if (value === undefined || value === '') {
      unresolved.push(name)
      return whole
    }
    return value
  })
  return { expanded, unresolved }
}

/** 条目比较用的规范形：小写 + 去掉尾随分隔符 + 把连续分隔符压成一个 */
export function normalizeEntry(entry: string): string {
  return entry
    .replace(/[\\/]+/g, '\\')
    .replace(/\\+$/, '')
    .toLowerCase()
}

/**
 * **结构性**问题的判定 —— 只覆盖"这条目根本不可能是有效路径"的情况。
 *
 * 刻意不在这里判"目录不存在"：那是事实问题，由调用方用 exists() 判断。
 * 更刻意的是**不在这里判"看起来像被截断"** —— 因为 `D:\go` 这种两字符的目录名
 * 是完全合法的。截断只能是"不存在 + 结构可疑"两个条件同时成立时的**提示**，
 * 不能单独作为判定依据（否则会误报，而误报会让用户不敢点"一键修复"）。
 */
export function classifyStructuralProblem(entry: string): string | null {
  const trimmed = entry.trim()
  if (trimmed === '') return '空条目'

  // 只有盘符：C: 或 C:\
  if (/^[a-zA-Z]:[\\/]?$/.test(trimmed)) {
    return `「${trimmed}」只有盘符，没有具体目录 —— 把整盘加进 PATH 会拖慢每一次命令查找`
  }

  // 驱动器绝对路径 或 UNC
  const isAbsolute = /^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.startsWith('\\\\')
  if (!isAbsolute) {
    if (/^v?\d+(\.\d+)+$/.test(trimmed)) {
      return `「${trimmed}」是个版本号，不是路径（多半是某个工具写 PATH 时漏了前缀）`
    }
    return `「${trimmed}」不是绝对路径。PATH 里的相对路径含义随当前目录变化，属于无效条目`
  }

  return null
}

/**
 * 结构上合法、但短得可疑 —— 只在"目录也不存在"时作为补充提示。
 *
 * 实测见过的 `C:\P` 就是 `C:\Program Files\...` 被 setx 截断后的残留。
 * 但 `D:\go` 是合法目录，所以这条规则**不能单独用来判坏**。
 */
export function looksTruncated(entry: string): boolean {
  return /^[a-zA-Z]:\\[^\\]{1,2}$/.test(entry.trim())
}

export interface PathAnalysis {
  entries: PathEntryAnalysis[]
  /** 需要处理的条目（非 ok） */
  problems: PathEntryAnalysis[]
  /** 去重并剔除坏条目之后的建议值 */
  suggested: string
  /** 建议值与原文不同则为 true */
  changed: boolean
  counts: Record<PathEntryKind, number>
}

/**
 * 分析一整条 PATH（用户级或机器级都可以）。
 *
 * 建议值的规则很保守：**只删两类东西** —— 重复条目、以及指向不存在目录/畸形/未解析变量的条目。
 * 顺序不动、大小写不动、尾随分隔符不动。用户点"修复"时看到的 diff 应该一眼能看懂。
 */
export function analyzePath(rawPath: string, options: AnalyzeOptions): PathAnalysis {
  const parts = rawPath.split(';').map((part) => part.trim())
  const entries: PathEntryAnalysis[] = []
  const seen = new Map<string, number>()
  const counts: Record<PathEntryKind, number> = {
    ok: 0,
    missing: 0,
    'unexpanded-var': 0,
    malformed: 0,
    duplicate: 0
  }

  parts.forEach((raw) => {
    if (raw === '') return

    const index = entries.length + 1
    const { expanded, unresolved } = expandWithReport(raw, options.env)

    let kind: PathEntryKind = 'ok'
    let reason: string | undefined
    let duplicateOf: number | undefined

    // 判定顺序很重要，这里踩过坑：
    //  · %NOODE_PATH% 展开不了、同时也不是绝对路径 —— 但用户需要知道的是
    //    "这个变量不存在"，所以 unresolved 要排在结构性判定**前面**
    //  · C:\P 结构上是合法绝对路径，只是目录不存在 —— 应该报 missing，
    //    再把"像被截断"作为补充提示，而不是直接判成 malformed
    if (raw.trim() === '') {
      kind = 'malformed'
      reason = '空条目'
    } else if (unresolved.length > 0) {
      kind = 'unexpanded-var'
      reason = `条目里的 %${unresolved.join('%、%')}% 这个环境变量不存在（可能是拼错了，或变量已被删除）`
    } else if (classifyStructuralProblem(expanded) !== null) {
      kind = 'malformed'
      reason = classifyStructuralProblem(expanded) ?? undefined
    } else if (!options.exists(expanded)) {
      kind = 'missing'
      reason = looksTruncated(expanded)
        ? '这个目录不存在，而且路径短得可疑 —— 很像 PATH 被截断写入时留下的残片（例如 C:\\Program Files\\... 只写进去一个 C:\\P）'
        : '这个目录不存在了（多半是工具卸载后留下的残渣）'
    } else {
      const key = normalizeEntry(expanded)
      const previous = seen.get(key)
      if (previous !== undefined) {
        kind = 'duplicate'
        duplicateOf = previous
        reason = `与第 ${previous} 条是同一个目录（写法不同，实际重复）`
      } else {
        seen.set(key, index)
      }
    }

    counts[kind] += 1
    entries.push({ index, raw, expanded, kind, reason, duplicateOf })
  })

  const suggested = entries
    .filter((entry) => entry.kind === 'ok')
    .map((entry) => entry.raw)
    .join(';')

  return {
    entries,
    problems: entries.filter((entry) => entry.kind !== 'ok'),
    suggested,
    changed: suggested !== rawPath.trim(),
    counts
  }
}

/** PATH 长度告警阈值：用户级 PATH 超过 2047、总 PATH 超过 8191 都会开始出问题 */
export const USER_PATH_WARN_LENGTH = 2047
export const TOTAL_PATH_WARN_LENGTH = 8191
