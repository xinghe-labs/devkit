/**
 * `reg query` 输出解析。
 *
 * 典型输出（注意：键名顶格，值缩进）：
 *   HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{GUID}
 *       DisplayName    REG_SZ    Node.js
 *       DisplayVersion    REG_SZ    22.12.0
 *
 * 这个模块是纯函数，便于用真实输出样本做单测。
 */

export interface InstalledProgram {
  hive: 'HKLM' | 'HKCU'
  view: '32' | '64'
  /** 完整键路径，含 hive */
  keyPath: string
  /** 该键下的所有值，字段名原样保留 */
  fields: Record<string, string>
}

const KEY_LINE = /^(HKEY_[A-Z_]+\\[^\r\n]*)$/
const VALUE_LINE = /^\s{2,}(\S+)\s+(REG_[A-Z_]+)\s*(.*)$/

export function parseRegQueryOutput(
  output: string,
  hive: 'HKLM' | 'HKCU',
  view: '32' | '64'
): InstalledProgram[] {
  const programs: InstalledProgram[] = []
  let current: InstalledProgram | null = null

  const flush = (): void => {
    if (current && Object.keys(current.fields).length > 0) programs.push(current)
    current = null
  }

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '')
    if (line.trim() === '') continue

    const keyMatch = line.match(KEY_LINE)
    if (keyMatch) {
      flush()
      current = { hive, view, keyPath: keyMatch[1], fields: {} }
      continue
    }

    if (!current) continue

    const valueMatch = line.match(VALUE_LINE)
    if (valueMatch) {
      current.fields[valueMatch[1]] = valueMatch[3] ?? ''
    }
  }

  flush()
  return programs
}
