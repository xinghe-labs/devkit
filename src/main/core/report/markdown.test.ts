import { describe, expect, it } from 'vitest'
import type { InstallPlan, PlanItem, ToolManifest } from '@shared/types'
import { renderPlanReport } from './markdown'

const TOOLS = new Map<string, ToolManifest>([
  [
    'nodejs',
    {
      id: 'nodejs',
      category: 'runtime',
      tier: 'L1',
      status: 'ready',
      name: { 'zh-CN': 'Node.js', 'en-US': 'Node.js' },
      description: { 'zh-CN': '运行时', 'en-US': 'Runtime' },
      detect: { commands: [{ cmd: 'node' }] },
      versions: []
    }
  ]
])

function item(overrides: Partial<PlanItem> = {}): PlanItem {
  return {
    id: 'nodejs',
    version: '24.21.0',
    tier: 'L1',
    installScope: 'user',
    requiresAdmin: false,
    requiresReboot: false,
    dependsOn: [],
    state: 'success',
    attempts: 1,
    error: null,
    note: '自检通过：v24.21.0',
    startedAt: '2026-10-12T07:00:00.000Z',
    finishedAt: '2026-10-12T07:00:30.000Z',
    installDir: 'C:\\Users\\屈\\.devkit\\versions\\nodejs\\24.21.0',
    archivePath: 'C:\\Users\\屈\\.devkit\\downloads\\nodejs-24.21.0-node.zip',
    ...overrides
  }
}

function plan(items: PlanItem[]): InstallPlan {
  return {
    schemaVersion: 1,
    planId: '20261012-070000-abcd',
    createdAt: '2026-10-12T07:00:00.000Z',
    devkitVersion: '0.1.0',
    manifestRevision: '2026-10-12',
    options: {
      concurrency: 1,
      mirrorPreference: 'huaweicloud',
      proxy: null,
      createRestorePoint: false,
      dryRun: false
    },
    items,
    summary: {
      total: items.length,
      success: items.filter((entry) => entry.state === 'success').length,
      failed: items.filter((entry) => entry.state === 'failed').length,
      skipped: 0,
      cancelled: 0
    }
  }
}

describe('安装报告', () => {
  it('包含计划元信息与逐项结果', () => {
    const report = renderPlanReport(plan([item()]), TOOLS, 'zh-CN')
    expect(report).toContain('# devkit 安装报告')
    expect(report).toContain('20261012-070000-abcd')
    expect(report).toContain('| ✓ 成功 | Node.js | 24.21.0 |')
    expect(report).toContain('30.0s')
  })

  it('下载尝试记录会逐条列出（这是"失败可诊断"的核心）', () => {
    const report = renderPlanReport(
      plan([
        item({
          downloadAttempts: [
            {
              source: 'official',
              url: 'https://nodejs.org/dist/v24.21.0/node-v24.21.0-win-x64.zip',
              error: '连接中断，下载不完整：已收到 351 KB，期望 36 MB'
            },
            {
              source: 'huaweicloud',
              url: 'https://mirrors.huaweicloud.com/nodejs/v24.21.0/node-v24.21.0-win-x64.zip',
              error: '下载速度只有 21.9 KB/s（低于 32 KB/s），已放弃这个源'
            }
          ]
        })
      ]),
      TOOLS,
      'zh-CN'
    )

    expect(report).toContain('## 下载尝试记录')
    expect(report).toContain('| 1 | official |')
    expect(report).toContain('| 2 | huaweicloud |')
    expect(report).toContain('下载速度只有 21.9 KB/s')
    expect(report).toContain('最终使用：C:\\Users\\屈\\.devkit\\downloads\\nodejs-24.21.0-node.zip')
  })

  it('失败项单独列出错误、说明与下载产物', () => {
    const report = renderPlanReport(
      plan([
        item({
          state: 'failed',
          error: '自检未通过：自检目标不存在：C:\\...\\node.exe',
          note: null,
          archivePath: 'C:\\cache\\node.zip'
        })
      ]),
      TOOLS,
      'zh-CN'
    )

    expect(report).toContain('## 需要关注')
    expect(report).toContain('### nodejs@24.21.0 — 失败')
    expect(report).toContain('自检未通过')
    expect(report).toContain('下载产物：C:\\cache\\node.zip')
  })

  it('表格单元格里的竖线与换行不会破坏 Markdown 结构', () => {
    const report = renderPlanReport(
      plan([item({ note: '第一行 | 第二行\n第三行' })]),
      TOOLS,
      'zh-CN'
    )
    // 换行被压成空格、竖线被转义
    expect(report).toContain('第一行 \\| 第二行 第三行')
  })

  it('没有问题的计划不会出现"需要关注"小节', () => {
    const report = renderPlanReport(plan([item()]), TOOLS, 'zh-CN')
    expect(report).not.toContain('## 需要关注')
  })
})
