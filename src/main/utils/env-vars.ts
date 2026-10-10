/**
 * 环境变量展开。
 *
 * Windows 的 %VAR% 是大小写不敏感的，这里按不敏感匹配。
 * 找不到对应变量时保留原文（而不是替换成空串），这样日志里能看到是哪个变量没解析出来。
 */
const VAR_PATTERN = /%([^%]+)%/g

export function expandEnvVars(input: string, env: NodeJS.ProcessEnv = process.env): string {
  return input.replace(VAR_PATTERN, (whole, rawName: string) => {
    const name = String(rawName).trim()
    if (name === '') return whole

    const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase())
    const value = key ? env[key] : undefined
    return value === undefined || value === '' ? whole : value
  })
}

/** 判断是否是绝对路径（兼容 C:\ 与 UNC \\server\share） */
export function isAbsoluteWindowsPath(input: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(input) || input.startsWith('\\\\')
}
