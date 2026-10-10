/**
 * 环境检测报告（不依赖 electron，可在终端直接跑）。
 *
 * 用途：
 *  · 开发时快速验证检测规则是否正确，不用每次开界面
 *  · 排查"为什么某个工具没被检测到"——它会把命中依据（命令/文件/注册表）打出来
 *  · 新增清单后自测
 */
import { readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { detectAll } from '../src/main/core/detect'
import {
  createManifestValidator,
  validateManifests,
  type RawManifestFile
} from '../src/main/core/manifest/validate'
import { readJsonFile } from '../src/main/utils/fs'
import type { DetectionStatus } from '../src/shared/types'

const STATUS_LABEL: Record<DetectionStatus, string> = {
  installed: '已安装',
  'version-mismatch': '版本不同',
  'path-missing': 'PATH 未生效',
  'not-installed': '未安装',
  error: '检测出错'
}

function pad(value: string, width: number): string {
  // 中文按 2 个宽度算，保证表格对齐
  const display = [...value].reduce((sum, char) => sum + (char.charCodeAt(0) > 0x2e80 ? 2 : 1), 0)
  return value + ' '.repeat(Math.max(0, width - display))
}

async function main(): Promise<void> {
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

  const results = await detectAll(tools)

  console.log('\n环境检测报告')
  console.log('─'.repeat(110))
  console.log(
    pad('工具', 16) + pad('状态', 14) + pad('已装版本', 20) + pad('推荐版本', 20) + '命中依据'
  )
  console.log('─'.repeat(110))

  for (const result of results) {
    console.log(
      pad(result.toolId, 16) +
        pad(STATUS_LABEL[result.status], 14) +
        pad(result.installedVersion ?? '—', 20) +
        pad(result.recommendedVersion ?? '—', 20) +
        (result.evidence ?? result.error ?? '—')
    )
  }

  console.log('─'.repeat(110))

  const byStatus = results.reduce<Record<string, number>>((acc, item) => {
    acc[item.status] = (acc[item.status] ?? 0) + 1
    return acc
  }, {})

  console.log(
    `合计 ${results.length} 个：` +
      Object.entries(byStatus)
        .map(([status, count]) => `${STATUS_LABEL[status as DetectionStatus]} ${count}`)
        .join(' · ')
  )
}

main().catch((error: unknown) => {
  console.error(`检测报告生成失败：${(error as Error).message}`)
  process.exit(1)
})
