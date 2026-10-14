import type { RegistryDetectRule, ToolManifest } from '@shared/types'
import { getInstalledPrograms } from '../detect/registry'
import type { InstalledProgram } from '../detect/registry-parse'
import { runElevated, toExecStep } from '../elevation'
import { logger } from '../report/logger'

/**
 * 用**注册表登记的卸载程序**卸载（清单里 `uninstall.type === 'registry'`）。
 *
 * ## 为什么需要它
 *
 * 机器级 MSI（7-Zip 是唯一一个）装完之后会在
 * `HKLM\...\Uninstall\{ProductCode}` 留一条卸载记录，还会写开始菜单快捷方式。
 * devkit 原来的卸载**只删版本目录**，于是：
 *
 * - 「应用和功能」里留着一条指向不存在目录的幽灵条目
 * - 开始菜单里留着快捷方式
 * - MSI 自己写的那部分（文件关联、注册表项）都没清
 *
 * 用户看到的是"卸载了，但控制面板里还在" —— 这比"卸不掉"更让人困惑。
 *
 * ## 做法
 *
 * 优先走 MSI 的标准卸载：注册表键名本身就是 ProductCode（`{GUID}`），
 * 直接 `msiexec /x {GUID} /qn /norestart`。这比解析 `UninstallString`
 * 可靠得多 —— 那串东西的引号与参数格式五花八门。
 *
 * 非 MSI 才回退到 `UninstallString`，并且用一个懂引号的切分器。
 */

export interface RegistryUninstallTarget {
  /** 「应用和功能」里显示的名字，用于日志与提示 */
  displayName: string
  /** 卸载命令的 argv（不含 exe 路径的部分已切好） */
  cmd: string
  args: string[]
  kind: 'msi' | 'exe'
  /** 定位到的那条注册表键；卸载完要复查它没了 */
  keyPath: string
}

const GUID_KEY = /^\{[0-9A-Fa-f-]{36}\}$/

/**
 * 把 Windows 命令行切成 argv。
 *
 * 规则简单但够用：双引号包裹的片段保留空格，其余按空白切。
 * `UninstallString` 常见形态：
 *   `"C:\Program Files\Foo\uninst.exe" /S`
 *   `MsiExec.exe /I{90160000-...}`
 */
export function splitWindowsCommand(command: string): string[] {
  const out: string[] = []
  let current = ''
  let quoted = false

  for (const char of command.trim()) {
    if (char === '"') {
      quoted = !quoted
      continue
    }
    if (!quoted && /\s/.test(char)) {
      if (current !== '') {
        out.push(current)
        current = ''
      }
      continue
    }
    current += char
  }
  if (current !== '') out.push(current)
  return out
}

/** 按清单的 detect.registry 规则找出对应的卸载条目（与检测用同一套匹配逻辑） */
export function findUninstallEntry(
  rules: RegistryDetectRule[] | undefined,
  programs: InstalledProgram[]
): InstalledProgram | null {
  if (!rules || rules.length === 0 || programs.length === 0) return null

  for (const rule of rules) {
    for (const program of programs) {
      if (program.hive !== rule.hive || program.view !== rule.view) continue
      if (!program.keyPath.toLowerCase().includes(rule.path.toLowerCase())) continue

      let matched = true
      for (const [field, pattern] of Object.entries(rule.match)) {
        const value = program.fields[field]
        if (value === undefined) {
          matched = false
          break
        }
        let expression: RegExp
        try {
          expression = new RegExp(pattern, 'i')
        } catch {
          matched = false
          break
        }
        if (!expression.test(value)) {
          matched = false
          break
        }
      }
      if (matched) return program
    }
  }
  return null
}

/** 从一条卸载记录推导出该怎么卸 */
export function planUninstall(program: InstalledProgram): RegistryUninstallTarget | null {
  const displayName = program.fields.DisplayName ?? program.keyPath
  const lastSegment = program.keyPath.split('\\').pop() ?? ''

  // MSI：键名就是 ProductCode
  if (GUID_KEY.test(lastSegment)) {
    return {
      displayName,
      cmd: 'msiexec.exe',
      args: ['/x', lastSegment, '/qn', '/norestart'],
      kind: 'msi',
      keyPath: program.keyPath
    }
  }

  // 非 MSI：优先 QuietUninstallString（无界面），否则 UninstallString
  const raw = program.fields.QuietUninstallString ?? program.fields.UninstallString
  if (!raw) return null

  const parts = splitWindowsCommand(raw)
  if (parts.length === 0) return null

  return {
    displayName,
    cmd: parts[0] as string,
    args: parts.slice(1),
    kind: 'exe',
    keyPath: program.keyPath
  }
}

export interface RegistryUninstallResult {
  ok: boolean
  /** 定位到的目标；null 表示这台机器上没找到对应卸载记录 */
  target: RegistryUninstallTarget | null
  detail: string | null
  error: string | null
}

/**
 * 执行注册表卸载。
 *
 * 走提权（MSI 卸载要管理员），**卸载后重新扫一遍注册表确认那条记录真的没了** ——
 * 与 devkit 其他地方一致：写操作之后必须复验，不能只看命令退出码。
 */
export async function uninstallByRegistry(tool: ToolManifest): Promise<RegistryUninstallResult> {
  let entry: InstalledProgram | null
  try {
    entry = findUninstallEntry(tool.detect.registry, await getInstalledPrograms(true))
  } catch (error) {
    return {
      ok: false,
      target: null,
      detail: null,
      error: `读取注册表卸载记录失败：${(error as Error).message}`
    }
  }

  if (!entry) {
    // 没有记录不算失败：可能本来就不是走注册表装的（比如用户手工解压的）
    return { ok: true, target: null, detail: null, error: null }
  }

  const target = planUninstall(entry)
  if (!target) {
    return {
      ok: false,
      target: null,
      detail: null,
      error: `「${entry.fields.DisplayName ?? entry.keyPath}」有卸载记录，但既不是 MSI 也没有可用的 UninstallString，无法自动卸载`
    }
  }

  const outcome = await runElevated([
    toExecStep(`卸载 ${target.displayName}`, {
      cmd: target.cmd,
      args: target.args,
      requiresAdmin: true
    })
  ])

  if (!outcome.ok) {
    return {
      ok: false,
      target,
      detail: null,
      error: outcome.cancelled
        ? '用户取消了管理员授权，注册表卸载未执行'
        : `卸载 ${target.displayName} 失败：${outcome.error ?? '未知原因'}`
    }
  }

  // 复验：那条卸载记录必须消失
  try {
    const after = await getInstalledPrograms(true)
    const stillThere = findUninstallEntry(tool.detect.registry, after)
    if (stillThere) {
      return {
        ok: false,
        target,
        detail: null,
        error: `卸载命令已执行，但「${target.displayName}」的卸载记录仍在（${stillThere.keyPath}）—— 可能被安装器忽略了`
      }
    }
  } catch (error) {
    logger.warn('uninstall', `复验注册表卸载结果失败：${(error as Error).message}`)
  }

  logger.info('uninstall', `已通过注册表卸载 ${target.displayName}（${target.kind}）`)
  return {
    ok: true,
    target,
    detail: `已卸载「${target.displayName}」（${target.kind === 'msi' ? 'MSI' : '自带卸载程序'}）`,
    error: null
  }
}
