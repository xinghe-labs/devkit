import { createHash } from 'node:crypto'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MIRROR_URL_PATTERN, MIRROR_TARGETS, type MirrorSetting, type ToolManifest } from '@shared/types'
import { shouldFollowRedirect } from './downloader/http'
import { runJob } from './elevation/run-job'
import { assertSafeFileName } from './offline'
import { mergeHotUpdate } from './hotupdate/whitelist'
import { resolveEntryPath, ZipSlipError } from './installer/zip'
import { buildPlan, PlanBuildFailure } from './plan'

/**
 * 安全审查（docs/../work/devkit-security-review.md）发现的每个问题都固化一条回归测试。
 * 这些用例的共同点是：它们**曾经真的能通过**，不是想象的边界。
 */

const HASH = 'a'.repeat(64)

/* ---------------- H1：版本号逃逸安装目录 ---------------- */

function localManifest(): ToolManifest {
  return {
    id: 'nodejs',
    category: 'runtime',
    tier: 'L1',
    status: 'ready',
    name: { 'zh-CN': 'Node.js', 'en-US': 'Node.js' },
    description: { 'zh-CN': '运行时', 'en-US': 'Runtime' },
    detect: { commands: [{ cmd: 'node' }] },
    versions: [
      {
        version: '24.21.0',
        channel: 'lts',
        recommended: true,
        arch: 'x64',
        installScope: 'user',
        source: { url: 'https://nodejs.org/a.zip', sha256: HASH },
        install: { type: 'zip', template: 'zip-into-version-dir', params: { stripComponents: '1' } }
      }
    ]
  }
}

describe('H1 版本号不得逃逸安装目录', () => {
  it('热更新白名单拒绝以 . 开头的版本号', () => {
    for (const version of ['..', '.', '../x', '.hidden']) {
      const result = mergeHotUpdate(localManifest(), {
        id: 'nodejs',
        versions: [
          {
            version,
            channel: 'lts',
            recommended: true,
            installScope: 'user',
            source: { url: 'https://evil.example.com/a.zip', sha256: HASH }
          }
        ]
      })
      expect(result.accepted, `version=${version}`).toBe(0)
    }
  })

  it('buildPlan 拒绝任何会落到 versions 根目录之外的版本号', () => {
    const tools: ToolManifest[] = [
      {
        ...localManifest(),
        versions: [
          {
            version: '..',
            channel: 'lts',
            recommended: true,
            arch: 'x64',
            installScope: 'user',
            source: { url: 'https://evil.example.com/a.zip', sha256: HASH },
            install: { type: 'zip', template: 'zip-into-version-dir', params: { stripComponents: '1' } }
          }
        ]
      }
    ]

    expect(() =>
      buildPlan({
        selections: [{ toolId: 'nodejs', version: '..' }],
        tools,
        options: {
          concurrency: 1,
          mirrorPreference: 'official',
          proxy: null,
          createRestorePoint: false,
          dryRun: false
        },
        devkitVersion: '0.1.0',
        manifestRevision: '2026-10-12',
        versionsRoot: 'C:\\Users\\x\\.devkit\\versions'
      })
    ).toThrow(PlanBuildFailure)
  })

  it('正常版本号仍然可用', () => {
    const plan = buildPlan({
      selections: [{ toolId: 'nodejs', version: '24.21.0' }],
      tools: [localManifest()],
      options: {
        concurrency: 1,
        mirrorPreference: 'official',
        proxy: null,
        createRestorePoint: false,
        dryRun: false
      },
      devkitVersion: '0.1.0',
      manifestRevision: '2026-10-12',
      versionsRoot: 'C:\\Users\\x\\.devkit\\versions'
    })
    expect(plan.items[0].installDir).toBe('C:\\Users\\x\\.devkit\\versions\\nodejs\\24.21.0')
  })
})

/* ---------------- H2：镜像地址注入 ---------------- */

describe('H2 镜像地址字符集', () => {
  it('接受真实的镜像地址（含 Go proxy 的逗号写法）', () => {
    for (const url of [
      'https://registry.npmmirror.com',
      'https://pypi.tuna.tsinghua.edu.cn/simple',
      'https://goproxy.cn,direct',
      'https://maven.aliyun.com/repository/public',
      'https://mirrors.huaweicloud.com/repository/nuget/v3/index.json',
      'https://docker.mirrors.ustc.edu.cn'
    ]) {
      expect(MIRROR_URL_PATTERN.test(url), url).toBe(true)
    }
  })

  it('拒绝能拼进 gradle / cargo / xml / yaml 的注入载荷', () => {
    const payloads = [
      "https://x'\n}\nallprojects{exec 'cmd'};//",
      'https://x" ; registry = "evil',
      'https://x</url><url>https://evil',
      'https://x\n- evil',
      'https://x`whoami`',
      'https://x$(calc)',
      'https://x\\evil',
      'http://x',
      'https://x y',
      ''
    ]
    for (const url of payloads) {
      expect(MIRROR_URL_PATTERN.test(url), JSON.stringify(url)).toBe(false)
    }
  })

  it('每个内置目标的默认地址都通过校验', () => {
    // 默认值写错会让"应用镜像"直接失败，这里钉住
    const defaults: Record<string, string> = {
      npm: 'https://registry.npmmirror.com',
      pip: 'https://pypi.tuna.tsinghua.edu.cn/simple',
      go: 'https://goproxy.cn,direct',
      maven: 'https://maven.aliyun.com/repository/public',
      gradle: 'https://maven.aliyun.com/repository/public',
      cargo: 'https://mirrors.tuna.tsinghua.edu.cn/crates.io-index',
      conda: 'https://mirrors.tuna.tsinghua.edu.cn/anaconda',
      nuget: 'https://mirrors.huaweicloud.com/repository/nuget/v3/index.json',
      docker: 'https://docker.mirrors.ustc.edu.cn'
    }
    for (const target of MIRROR_TARGETS) {
      expect(MIRROR_URL_PATTERN.test(defaults[target]), target).toBe(true)
    }
    const setting: MirrorSetting = { target: 'npm', enabled: true, url: defaults.npm }
    expect(setting.url).toBe(defaults.npm)
  })
})

/* ---------------- H3：提权前重新校验安装包 ---------------- */

describe('H3 提权执行前重新校验安装包哈希', () => {
  it('哈希不匹配时拒绝执行（并且真的没执行）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'devkit-elev-hash-'))
    const marker = join(dir, 'should-not-exist.txt')
    const script = join(dir, 'payload.cmd')
    writeFileSync(script, `@echo off\r\necho ran > "${marker}"\r\n`, 'utf8')

    try {
      const outcome = await runJob({
        jobDir: dir,
        forceUnelevated: true,
        steps: [
          {
            kind: 'exec',
            label: '被篡改的安装包',
            cmd: script,
            args: [],
            timeoutMs: 20_000,
            verifySha256: createHash('sha256').update('something else').digest('hex')
          }
        ]
      })

      expect(outcome.ok).toBe(false)
      expect(outcome.steps[0]?.error).toContain('校验失败')
      expect(outcome.steps[0]?.error).toContain('拒绝以管理员身份执行')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 120_000)

  it('哈希匹配时正常执行', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'devkit-elev-hash-ok-'))
    // 用一个真实的 exe（复制一份 cmd.exe）当"安装包"，这样既验证哈希又验证执行。
    // 助手脚本的调用方本来就是 msiexec.exe / 安装器 exe，不是 .cmd。
    const payload = join(dir, 'payload.exe')
    copyFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'), payload)
    const expected = createHash('sha256').update(readFileSync(payload)).digest('hex').toUpperCase()

    try {
      const outcome = await runJob({
        jobDir: dir,
        forceUnelevated: true,
        steps: [
          {
            kind: 'exec',
            label: '正常安装包',
            cmd: payload,
            args: ['/d', '/s', '/c', 'exit 0'],
            timeoutMs: 20_000,
            verifySha256: expected
          }
        ]
      })

      expect(outcome.steps[0]?.error ?? null).toBeNull()
      expect(outcome.steps[0]?.ok).toBe(true)
      expect(outcome.ok).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 120_000)
})

/* ---------------- M1：不允许 https 降级到 http ---------------- */

describe('M1 重定向不得从 https 降级到 http', () => {
  const https = new URL('https://example.com/a')
  const http = new URL('http://example.com/a')

  it('生产模式（allowInsecure=false）拒绝降级', () => {
    expect(shouldFollowRedirect(https, http, false)).toBe(false)
    expect(shouldFollowRedirect(https, new URL('https://cdn.example.com/a'), false)).toBe(true)
    expect(shouldFollowRedirect(https, new URL('https://example.com/b'), false)).toBe(true)
  })

  it('测试模式（allowInsecure=true）才允许', () => {
    expect(shouldFollowRedirect(https, http, true)).toBe(true)
  })
})

/* ---------------- M3：离线包文件名 ---------------- */

describe('M3 离线包文件名必须是纯文件名', () => {
  it('接受正常文件名', () => {
    expect(assertSafeFileName('nodejs-24.21.0-node-v24.21.0-win-x64.zip', 'test')).toBe(
      'nodejs-24.21.0-node-v24.21.0-win-x64.zip'
    )
  })

  it('拒绝路径穿越与分隔符', () => {
    for (const name of ['../evil.exe', '..\\evil.exe', 'a/b.exe', 'a\\b.exe', '..', '', '.hidden']) {
      expect(() => assertSafeFileName(name, 'test'), JSON.stringify(name)).toThrow()
    }
  })

  it('拒绝非字符串', () => {
    expect(() => assertSafeFileName(undefined, 'test')).toThrow()
    expect(() => assertSafeFileName(123, 'test')).toThrow()
  })
})

/* ---------------- L1：NTFS 数据流 ---------------- */

describe('L1 ZIP 条目名里的冒号（NTFS 数据流）被拒绝', () => {
  it('拒绝 a.exe:hidden 这类条目', () => {
    expect(() => resolveEntryPath('C:\\dest', 'a.exe:hidden', 0)).toThrow(ZipSlipError)
    expect(() => resolveEntryPath('C:\\dest', 'dir/a.exe:$DATA', 0)).toThrow(ZipSlipError)
  })

  it('正常条目不受影响', () => {
    expect(resolveEntryPath('C:\\dest', 'bin/node.exe', 1)).toBe('C:\\dest\\node.exe')
  })
})
