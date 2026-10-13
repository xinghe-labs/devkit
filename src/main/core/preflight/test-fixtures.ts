import type { InstallPlan, PlanItem, ToolManifest, ToolVersionSpec } from '@shared/types'

/** 预检测试共用的最小 fixture（两个测试文件都用，避免各写一份） */

export function makeVersion(dependsOn?: string[]): ToolVersionSpec {
  return {
    version: '1.0.0',
    channel: 'stable',
    arch: 'x64',
    installScope: 'user',
    sizeBytes: 1024,
    source: { url: 'https://example.invalid/a.zip', sha256: 'a'.repeat(64) },
    install: { type: 'zip', template: 'zip-into-version-dir' },
    ...(dependsOn ? { dependsOn } : {})
  }
}

export function makeTool(id: string, name: string, dependsOn?: string[]): ToolManifest {
  return {
    id,
    category: 'build',
    tier: 'L1',
    status: 'ready',
    name: { 'zh-CN': name, 'en-US': name },
    description: { 'zh-CN': 'x', 'en-US': 'x' },
    detect: { files: [`C:\\${id}.exe`] },
    versions: [makeVersion(dependsOn)]
  }
}

export function makeItem(id: string, dependsOn: string[]): PlanItem {
  return {
    id,
    version: '1.0.0',
    tier: 'L1',
    installScope: 'user',
    requiresAdmin: false,
    requiresReboot: false,
    dependsOn,
    state: 'pending',
    attempts: 0,
    error: null,
    note: null,
    startedAt: null,
    finishedAt: null,
    installDir: `C:\\Users\\x\\.devkit\\versions\\${id}\\1.0.0`,
    archivePath: null
  }
}

export function makePlan(items: PlanItem[]): InstallPlan {
  return {
    schemaVersion: 1,
    planId: '20261012-120000-aaaa',
    createdAt: new Date().toISOString(),
    devkitVersion: '0.5.0',
    manifestRevision: '2026-10-12',
    options: {
      concurrency: 1,
      mirrorPreference: 'official',
      proxy: null,
      createRestorePoint: false,
      dryRun: false
    },
    items,
    summary: { total: items.length, success: 0, failed: 0, skipped: 0, cancelled: 0 }
  }
}
