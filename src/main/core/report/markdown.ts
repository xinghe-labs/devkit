import type { InstallPlan, PlanItem, ToolManifest } from '@shared/types'
import { localizedText } from '@shared/localized'

/**
 * 安装报告生成（FR-9）。
 *
 * 报告是用户唯一能带走的证据 —— 出了问题要能把"装了什么、哪一步失败了、
 * 自检输出了什么"原样贴给别人。所以这里不做任何美化，只求信息完整。
 */

const STATE_LABEL: Record<PlanItem['state'], string> = {
  pending: '未开始',
  downloading: '下载中',
  verifying: '校验中',
  installing: '安装中',
  checking: '自检中',
  success: '成功',
  failed: '失败',
  skipped: '跳过',
  cancelled: '已取消'
}

const STATE_ICON: Record<PlanItem['state'], string> = {
  pending: '·',
  downloading: '↓',
  verifying: '#',
  installing: '+',
  checking: '?',
  success: '✓',
  failed: '✗',
  skipped: '−',
  cancelled: '×'
}

function formatDuration(startedAt: string | null, finishedAt: string | null): string {
  if (!startedAt || !finishedAt) return '—'
  const delta = new Date(finishedAt).getTime() - new Date(startedAt).getTime()
  if (!Number.isFinite(delta) || delta < 0) return '—'
  return delta < 1000 ? `${delta}ms` : `${(delta / 1000).toFixed(1)}s`
}

/** 表格单元格里的 | 会破坏 Markdown 表格结构 */
function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

export function renderPlanReport(
  plan: InstallPlan,
  tools: Map<string, ToolManifest>,
  locale: 'zh-CN' | 'en-US'
): string {
  const lines: string[] = []
  const { summary } = plan

  lines.push('# devkit 安装报告')
  lines.push('')
  lines.push(`- 计划 ID：${plan.planId}`)
  lines.push(`- 生成时间：${new Date().toISOString()}`)
  lines.push(`- devkit 版本：${plan.devkitVersion}`)
  lines.push(`- 清单版本：${plan.manifestRevision}`)
  lines.push(`- 镜像偏好：${plan.options.mirrorPreference}`)
  lines.push(`- 代理：${plan.options.proxy ?? '跟随系统'}`)
  lines.push(
    `- 结果：成功 ${summary.success} · 失败 ${summary.failed} · 跳过 ${summary.skipped} · 取消 ${summary.cancelled}（共 ${summary.total}）`
  )
  lines.push('')

  lines.push('## 逐项结果')
  lines.push('')
  lines.push('| 状态 | 工具 | 版本 | 安装目录 | 耗时 | 说明 |')
  lines.push('| --- | --- | --- | --- | --- | --- |')

  for (const item of plan.items) {
    const tool = tools.get(item.id)
    const name = tool ? localizedText(tool.name, locale, item.id) : item.id
    const note = item.error ?? item.note ?? ''
    lines.push(
      `| ${STATE_ICON[item.state]} ${STATE_LABEL[item.state]} | ${escapeCell(name)} | ${item.version} | ` +
        `${escapeCell(item.installDir ?? '—')} | ${formatDuration(item.startedAt, item.finishedAt)} | ${escapeCell(note)} |`
    )
  }

  const problems = plan.items.filter((item) => item.state === 'failed' || item.state === 'skipped')
  if (problems.length > 0) {
    lines.push('')
    lines.push('## 需要关注')
    for (const item of problems) {
      lines.push('')
      lines.push(`### ${item.id}@${item.version} — ${STATE_LABEL[item.state]}`)
      lines.push('')
      lines.push(`- 错误：${item.error ?? '—'}`)
      if (item.note) lines.push(`- 说明：${item.note}`)
      if (item.archivePath) lines.push(`- 下载产物：${item.archivePath}`)
    }
  }

  lines.push('')
  lines.push('---')
  lines.push('')
  lines.push('> 本报告由 devkit 自动生成，未上传到任何服务器。')
  lines.push(
    '> 本次安装全部落在用户级版本目录（%USERPROFILE%\\.devkit\\versions\\），未修改系统 PATH、未写 Program Files。'
  )

  return lines.join('\n')
}
