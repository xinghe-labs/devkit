import { existsSync } from 'node:fs'
import type { DoctorFinding, DoctorFixId, DoctorLevel, DoctorReport, PathAnalysisView } from '@shared/types'
import { getCurrentRoot, getDataRoot } from '../../utils/app-paths'
import { runCommand } from '../../utils/exec'
import { logger } from '../report/logger'
import { getSystemConfigStatus } from '../systemconfig'
import { analyzePath, TOTAL_PATH_WARN_LENGTH, USER_PATH_WARN_LENGTH } from './paths'
import { readMachinePath, readUserPath } from '../activate/windows'
import { readActivationState } from '../activate'

/**
 * 环境体检（只读优先）。
 *
 * 设计原则：
 *  1. **诊断阶段不写任何东西** —— 所有检查都是读注册表/读文件系统/跑 where
 *  2. 修复必须显式触发，而且**先备份**
 *  3. 用户级修复直接做；机器级修复要管理员，单独确认（提权助手）
 *  4. 每条发现都给「人话解释 + 具体证据（是哪一条、值是什么）」，而不是一句"环境有问题"
 *
 * 为什么这个功能值得做：实测这台机器的机器级 PATH 里有 7 条坏条目
 * （`C:\P`、`ogram Files\Git\cmd`、`%NOODE_PATH%`、裸版本号 `v16.13.1` …），
 * 全是历史上 PATH 被截断写入的残留 —— 而用户遇到"装完跑不起来"时，
 * 现在唯一的办法是人肉 `echo %PATH%` 一条条看。
 */

function analyzeToView(analysis: ReturnType<typeof analyzePath>): PathAnalysisView {
  return {
    entries: analysis.entries.map((entry) => ({
      index: entry.index,
      raw: entry.raw,
      kind: entry.kind,
      reason: entry.reason ?? null,
      duplicateOf: entry.duplicateOf ?? null
    })),
    suggested: analysis.suggested,
    changed: analysis.changed,
    counts: analysis.counts
  }
}

/** 每个工具在 PATH 上解析到几个目标（多于一个就说明"跑的不是你以为的那个"） */
async function resolveCommands(
  commands: string[]
): Promise<{ cmd: string; paths: string[] }[]> {
  const results: { cmd: string; paths: string[] }[] = []
  for (const cmd of commands) {
    const where = await runCommand('where.exe', [cmd], { timeoutMs: 15_000 })
    const paths =
      where.code === 0
        ? where.stdout
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line !== '')
        : []
    results.push({ cmd, paths })
  }
  return results
}

const COMMANDS_TO_PROBE = ['node', 'npm', 'python', 'java', 'git', 'code', 'go', 'docker']

/** 关键环境变量：值指向的目录必须存在 */
const ENV_VARS_TO_CHECK = ['JAVA_HOME', 'GOROOT', 'CARGO_HOME', 'RUSTUP_HOME', 'MAVEN_HOME', 'PYTHONHOME']

function envVar(env: Record<string, string | undefined>, name: string): string | undefined {
  if (env[name] !== undefined) return env[name]
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase())
  return key ? env[key] : undefined
}

export async function runDoctor(): Promise<DoctorReport> {
  const findings: DoctorFinding[] = []

  const userRaw = await readUserPath().catch(() => '')
  const machineRaw = await readMachinePath().catch(() => '')

  const userAnalysis = analyzePath(userRaw, { exists: existsSync, env: process.env })
  const machineAnalysis = analyzePath(machineRaw, { exists: existsSync, env: process.env })

  /* ---------------- 1. 用户级 PATH ---------------- */
  if (userAnalysis.problems.length > 0) {
    findings.push({
      id: 'user-path-problems',
      level: userAnalysis.problems.some((entry) =>
        ['malformed', 'missing', 'unexpanded-var'].includes(entry.kind)
      )
        ? 'error'
        : 'warn',
      category: 'path',
      title: { 'zh-CN': '用户 PATH 里有无效条目', 'en-US': 'Your user PATH contains invalid entries' },
      detail: {
        'zh-CN':
          '这些条目指向不存在的目录、或者是相对路径/被截断的片段。它们不会让系统崩溃，' +
          '但会拖慢每一次命令查找，也会让"装了却跑不起来"变得难以排查。',
        'en-US':
          'These entries point at non-existent directories, or are relative/truncated fragments. ' +
          'They do not break Windows, but they slow down every command lookup and make ' +
          '"installed but not found" much harder to debug.'
      },
      evidence: userAnalysis.problems.map((entry) => `第 ${entry.index} 条：${entry.raw} —— ${entry.reason}`),
      fix: {
        id: 'clean-user-path',
        label: { 'zh-CN': '清理用户 PATH', 'en-US': 'Clean user PATH' },
        scope: 'user'
      }
    })
  } else {
    findings.push({
      id: 'user-path-ok',
      level: 'ok',
      category: 'path',
      title: { 'zh-CN': '用户 PATH 正常', 'en-US': 'User PATH is healthy' },
      detail: {
        'zh-CN': `共 ${userAnalysis.entries.length} 条，全部指向存在的目录，没有重复。`,
        'en-US': `${userAnalysis.entries.length} entries, all pointing at existing directories, no duplicates.`
      },
      evidence: [],
      fix: null
    })
  }

  /* ---------------- 2. 机器级 PATH（只读诊断） ---------------- */
  if (machineAnalysis.problems.length > 0) {
    findings.push({
      id: 'machine-path-problems',
      level: 'error',
      category: 'path',
      title: {
        'zh-CN': '机器级 PATH 里有无效条目',
        'en-US': 'The machine-level PATH contains invalid entries'
      },
      detail: {
        'zh-CN':
          '机器级 PATH 对所有用户生效，改它需要管理员权限。' +
          '下面这些条目多半是历史上某个安装器用 setx 之类写 PATH 时被截断留下的 —— ' +
          '`C:\\P`、`ogram Files\\Git\\cmd` 这种片段就是典型痕迹。' +
          'devkit **只做诊断，不会自动改机器级 PATH**；要清理请点修复并确认提权。',
        'en-US':
          'The machine PATH applies to every user and changing it needs admin rights. These entries are ' +
          'usually leftovers from an installer truncating PATH via setx — fragments like `C:\\P` or ' +
          '`ogram Files\\Git\\cmd` are the giveaway. devkit only diagnoses this; cleaning it is an ' +
          'explicit, elevated action.'
      },
      evidence: machineAnalysis.problems.map(
        (entry) => `第 ${entry.index} 条：${entry.raw} —— ${entry.reason}`
      ),
      fix: {
        id: 'clean-machine-path',
        label: { 'zh-CN': '清理机器级 PATH（需要管理员）', 'en-US': 'Clean machine PATH (needs admin)' },
        scope: 'machine'
      }
    })
  } else {
    findings.push({
      id: 'machine-path-ok',
      level: 'ok',
      category: 'path',
      title: { 'zh-CN': '机器级 PATH 正常', 'en-US': 'Machine PATH is healthy' },
      detail: {
        'zh-CN': `共 ${machineAnalysis.entries.length} 条，没有发现问题。`,
        'en-US': `${machineAnalysis.entries.length} entries, nothing wrong found.`
      },
      evidence: [],
      fix: null
    })
  }

  /* ---------------- 3. PATH 长度 ---------------- */
  if (userRaw.length > USER_PATH_WARN_LENGTH) {
    findings.push({
      id: 'user-path-too-long',
      level: 'warn',
      category: 'path',
      title: { 'zh-CN': '用户 PATH 过长', 'en-US': 'User PATH is too long' },
      detail: {
        'zh-CN':
          'PATH 越长，每敲一条命令系统就要多查一圈；而且不少老工具会在这个长度上出问题。' +
          '清理掉无效条目通常能缩短一大截。',
        'en-US':
          'The longer PATH gets, the more the shell has to scan for every command, and older tools ' +
          'start misbehaving. Cleaning invalid entries usually shortens it a lot.'
      },
      evidence: [`当前 ${userRaw.length} 字符，建议控制在 ${USER_PATH_WARN_LENGTH} 以内`],
      fix: null
    })
  }

  const totalLength = userRaw.length + machineRaw.length
  if (totalLength > TOTAL_PATH_WARN_LENGTH) {
    findings.push({
      id: 'total-path-too-long',
      level: 'error',
      category: 'path',
      title: { 'zh-CN': 'PATH 总长度接近系统上限', 'en-US': 'Total PATH is near the system limit' },
      detail: {
        'zh-CN': '用户级与机器级加起来已经接近 Windows 的实际可用上限，继续加条目会开始随机失效。',
        'en-US':
          'User and machine PATH combined are near what Windows can practically handle; adding more ' +
          'entries starts failing unpredictably.'
      },
      evidence: [`用户 ${userRaw.length} + 机器 ${machineRaw.length} = ${totalLength} 字符`],
      fix: null
    })
  }

  /* ---------------- 4. 命令解析（跑的是不是你以为的那个） ---------------- */
  const resolved = await resolveCommands(COMMANDS_TO_PROBE)
  const ambiguous = resolved.filter((entry) => entry.paths.length > 1)
  const found = resolved.filter((entry) => entry.paths.length > 0)

  if (ambiguous.length > 0) {
    findings.push({
      id: 'command-ambiguous',
      level: 'warn',
      category: 'command',
      title: {
        'zh-CN': '有命令解析到多个位置',
        'en-US': 'Some commands resolve to more than one location'
      },
      detail: {
        'zh-CN':
          '同一个命令在 PATH 上有多份时，实际跑的是**排在最前面**的那一个。' +
          '这经常造成"我明明装了新版本，跑的却是旧版本"。',
        'en-US':
          'When a command exists in several PATH entries, the one that runs is the **first** one. ' +
          'This is the usual cause of "I installed the new version but the old one runs".'
      },
      evidence: ambiguous.flatMap((entry) =>
        entry.paths.map((path, i) => `${entry.cmd} → ${path}${i === 0 ? '（实际生效）' : ''}`)
      ),
      fix: null
    })
  }

  if (found.length === 0) {
    findings.push({
      id: 'no-commands',
      level: 'warn',
      category: 'command',
      title: { 'zh-CN': 'PATH 上没有任何开发命令', 'en-US': 'No developer commands on PATH' },
      detail: {
        'zh-CN': 'node / python / git / java 等一个都找不到。如果这是一台新机器，这很正常。',
        'en-US': 'None of node / python / git / java were found. On a fresh machine that is expected.'
      },
      evidence: [],
      fix: null
    })
  } else {
    findings.push({
      id: 'commands-found',
      level: 'ok',
      category: 'command',
      title: { 'zh-CN': 'PATH 上的开发命令', 'en-US': 'Developer commands on PATH' },
      detail: {
        'zh-CN': `找到 ${found.length} 个命令。`,
        'en-US': `Found ${found.length} commands.`
      },
      evidence: found.map((entry) => `${entry.cmd} → ${entry.paths[0]}`),
      fix: null
    })
  }

  /* ---------------- 5. 关键环境变量 ---------------- */
  const badEnv: string[] = []
  for (const name of ENV_VARS_TO_CHECK) {
    const value = envVar(process.env, name)
    if (value === undefined) continue
    if (value.trim() === '') {
      badEnv.push(`${name} 是空值`)
      continue
    }
    if (!existsSync(value)) {
      badEnv.push(`${name} = ${value}（这个目录不存在）`)
    }
  }

  if (badEnv.length > 0) {
    findings.push({
      id: 'env-var-broken',
      level: 'warn',
      category: 'env',
      title: {
        'zh-CN': '有环境变量指向不存在的位置',
        'en-US': 'Some environment variables point at missing locations'
      },
      detail: {
        'zh-CN':
          '这类变量（JAVA_HOME / GOROOT 等）指向不存在的目录时，构建工具会报一些很难懂的错。' +
          '通常是工具卸载或换了安装位置之后忘了改。',
        'en-US':
          'When these variables (JAVA_HOME / GOROOT …) point at missing directories, build tools fail ' +
          'with confusing errors. Usually a leftover after uninstalling or relocating a tool.'
      },
      evidence: badEnv,
      fix: null
    })
  }

  /* ---------------- 6. devkit 自身一致性 ---------------- */
  const dangling: string[] = []
  const state = readActivationState()
  for (const record of state.records) {
    if (!existsSync(record.target)) {
      dangling.push(`${record.toolId}：激活记录指向 ${record.target}，但这个目录已经不在了`)
    }
  }
  // PATH 里还有 devkit 的条目、但记录里没有对应工具
  for (const entry of userAnalysis.entries) {
    if (!entry.raw.includes('DEVKIT') && !entry.raw.toLowerCase().includes('.devkit')) continue
    const stillManaged = state.records.some((record) =>
      record.pathEntries.some((path) => path.toLowerCase() === entry.raw.toLowerCase())
    )
    if (!stillManaged) {
      dangling.push(`PATH 里有 devkit 条目「${entry.raw}」，但激活记录里已经没有它了`)
    }
  }

  if (dangling.length > 0) {
    findings.push({
      id: 'devkit-dangling',
      level: 'warn',
      category: 'devkit',
      title: { 'zh-CN': 'devkit 激活状态有残留', 'en-US': 'Leftover devkit activation state' },
      detail: {
        'zh-CN': '激活记录与实际情况对不上，多半是手工删过版本目录。可以一键清理残留。',
        'en-US':
          'Activation records no longer match reality — usually because a version directory was deleted ' +
          'by hand. This can be cleaned up in one step.'
      },
      evidence: dangling,
      fix: {
        id: 'prune-devkit-state',
        label: { 'zh-CN': '清理 devkit 残留', 'en-US': 'Clean up devkit leftovers' },
        scope: 'user'
      }
    })
  }

  const activated = state.records.map((record) => `${record.toolId}@${record.version}`)
  findings.push({
    id: 'devkit-state',
    level: 'ok',
    category: 'devkit',
    title: { 'zh-CN': 'devkit 状态', 'en-US': 'devkit state' },
    detail: {
      'zh-CN':
        `数据根目录：${getDataRoot()}\n` +
        `当前激活：${activated.length > 0 ? activated.join('、') : '（没有激活任何工具）'}`,
      'en-US':
        `Data root: ${getDataRoot()}\n` +
        `Activated: ${activated.length > 0 ? activated.join(', ') : '(nothing activated)'}`
    },
    evidence: [
      `切换链接目录：${getCurrentRoot()}`,
      `PATH 备份：${state.backupFile ?? '（还没改过用户 PATH，所以没有备份）'}`
    ],
    fix: null
  })

  /* ---------------- 7. 系统项（复用 systemconfig 的只读检测） ---------------- */
  try {
    const systemItems = await getSystemConfigStatus()
    const notConfigured = systemItems.filter((item) => !item.configured)
    if (notConfigured.length > 0) {
      findings.push({
        id: 'system-items',
        level: 'warn',
        category: 'system',
        title: { 'zh-CN': '有系统项未配置', 'en-US': 'Some system settings are not configured' },
        detail: {
          'zh-CN': '这些不是"坏了"，但开了之后开发会顺很多。可以逐项在「设置 → 系统配置」里处理。',
          'en-US':
            'These are not broken, but enabling them makes development smoother. Handle them under ' +
            'Settings → System configuration.'
        },
        evidence: notConfigured.map((item) => `${item.label['zh-CN'] ?? item.id}：${item.detail}`),
        fix: null
      })
    }
  } catch (error) {
    logger.warn('doctor', `系统项检测失败：${(error as Error).message}`)
  }

  const summary = {
    ok: findings.filter((item) => item.level === 'ok').length,
    warn: findings.filter((item) => item.level === 'warn').length,
    error: findings.filter((item) => item.level === 'error').length
  }

  logger.info(
    'doctor',
    `体检完成：${summary.error} 个问题、${summary.warn} 个注意、${summary.ok} 项正常`
  )

  return {
    ranAt: new Date().toISOString(),
    findings,
    summary,
    userPath: analyzeToView(userAnalysis),
    machinePath: analyzeToView(machineAnalysis)
  }
}

export type { DoctorFixId, DoctorFinding, DoctorLevel }
