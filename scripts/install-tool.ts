/**
 * 真实安装一个工具（不走界面）。
 *
 * 用途：
 *  · M1a 的端到端验收 —— 真实下载、真实 SHA-256 校验、真实解压、真实自检
 *  · 排查"界面里装失败了但不知道哪一步"的问题，这里能看到完整日志
 *  · 新增清单后自测
 *
 * 安全边界（与界面完全一致）：
 *  · 只装到 %USERPROFILE%\.devkit\versions\<tool>\<version>\
 *  · 不改系统 PATH、不写 Program Files、不需要管理员
 *  · 自检用绝对路径，验证的是刚装进去的那一份
 *
 * 用法：pnpm install:tool [toolId] [version]
 */
import { mkdirSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { indexById } from '../src/shared/manifest'
import type { InstallPlan, PlanItem } from '../src/shared/types'
import { runPlan } from '../src/main/core/executor'
import { createManifestValidator, validateManifests, type RawManifestFile } from '../src/main/core/manifest/validate'
import { buildPlan } from '../src/main/core/plan'
import { runPreflight } from '../src/main/core/preflight'
import { renderPlanReport } from '../src/main/core/report/markdown'
import { readJsonFile } from '../src/main/utils/fs'

const STATE_LABEL: Record<PlanItem['state'], string> = {
  pending: '等待',
  downloading: '下载中',
  verifying: '校验中',
  installing: '安装中',
  checking: '自检中',
  success: '成功',
  failed: '失败',
  skipped: '跳过',
  cancelled: '已取消'
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

async function main(): Promise<void> {
  const toolId = process.argv[2] ?? 'nodejs'
  const versionArg = process.argv[3]

  const manifestDir = resolve('resources/manifest')
  const toolsDir = join(manifestDir, 'tools')
  const validate = createManifestValidator(
    readJsonFile<object>(join(manifestDir, 'schema', 'tool.schema.json'))
  )
  const files: RawManifestFile[] = readdirSync(toolsDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => ({ file: name, data: readJsonFile(join(toolsDir, name)) }))

  const { tools, errors } = validateManifests(files, validate)
  if (errors.length > 0) {
    console.error(`有 ${errors.length} 个清单未通过校验，请先执行 pnpm manifest:check`)
    process.exit(1)
  }

  const home = homedir()
  const versionsRoot = join(home, '.devkit', 'versions')
  const downloadDir = join(home, '.devkit', 'downloads')
  const logDir = join(home, '.devkit', 'logs')
  mkdirSync(logDir, { recursive: true })

  const plan = buildPlan({
    selections: [versionArg ? { toolId, version: versionArg } : { toolId }],
    tools,
    options: {
      concurrency: 1,
      mirrorPreference: (process.env.DEVKIT_MIRROR as never) ?? 'huaweicloud',
      proxy: process.env.DEVKIT_PROXY ?? null,
      createRestorePoint: false,
      dryRun: process.env.DEVKIT_DRY_RUN === '1'
    },
    devkitVersion: '0.1.0-dev',
    manifestRevision: new Date().toISOString().slice(0, 10),
    versionsRoot
  })

  console.log(`\n计划 ${plan.planId}`)
  console.log(`  安装位置  ${plan.items[0].installDir}`)
  console.log(`  下载缓存  ${downloadDir}`)

  const preflight = await runPreflight({
    plan,
    tools: indexById(tools),
    targetPath: versionsRoot,
    maxProbes: 3
  })

  console.log(`\n预检：${preflight.ok ? '通过' : '存在阻断问题'}`)
  for (const check of preflight.checks) {
    const mark = check.level === 'ok' ? '✓' : check.level === 'warn' ? '!' : '✗'
    console.log(`  ${mark} ${check.message}`)
  }

  if (!preflight.ok) {
    console.error('\n预检未通过，已中止（与界面行为一致）')
    process.exit(1)
  }

  console.log('\n开始安装…\n')

  const controller = new AbortController()
  let lastLine = ''

  await runPlan({
    plan,
    tools: indexById(tools),
    downloadDir,
    logDir,
    signal: controller.signal,
    dryRun: plan.options.dryRun,
    onUpdate: (event) => {
      const item = event.plan.items[0]
      const detail = event.detail
      const progress =
        detail?.received === undefined
          ? ''
          : detail.total
            ? ` ${formatBytes(detail.received)}/${formatBytes(detail.total)}`
            : ` ${formatBytes(detail.received)}`
      const line = `${item.id}@${item.version} ${STATE_LABEL[item.state]}${progress}`
      if (line !== lastLine) {
        lastLine = line
        process.stdout.write(`\r  ${line.padEnd(64)}`)
      }
    }
  })

  process.stdout.write('\r' + ' '.repeat(70) + '\r')

  const finished = plan.items[0]
  console.log(`结果：${STATE_LABEL[finished.state]}`)
  console.log(`  说明      ${finished.error ?? finished.note ?? '—'}`)
  console.log(`  耗时      ${finished.startedAt && finished.finishedAt ? `${((new Date(finished.finishedAt).getTime() - new Date(finished.startedAt).getTime()) / 1000).toFixed(1)}s` : '—'}`)

  console.log('\n──── 报告预览 ────\n')
  console.log(renderPlanReport(plan as InstallPlan, indexById(tools), 'zh-CN'))

  if (finished.state !== 'success') process.exit(1)
}

main().catch((error: unknown) => {
  console.error(`\n执行失败：${(error as Error).message}`)
  process.exit(1)
})
