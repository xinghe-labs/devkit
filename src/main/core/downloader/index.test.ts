import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { downloadFile, type DownloadRequest, type DownloadResult, type DownloadSource } from './index'

/**
 * 下载器的测试全部打本地 HTTP 服务器，不打外网 —— 断点续传、镜像回退、校验失败
 * 这些分支靠真实 CDN 是测不稳的，本地服务器可以精确构造每种情况。
 */

const PAYLOAD = Buffer.from('devkit downloader test payload | '.repeat(5000))
const SHA = createHash('sha256').update(PAYLOAD).digest('hex')

let server: Server
let baseUrl = ''
let tmpDir = ''
let hits: { path: string; range?: string }[] = []

type Handler = (req: IncomingMessage, res: ServerResponse) => void
let routes: Record<string, Handler> = {}

function sendFull(res: ServerResponse): void {
  res.writeHead(200, { 'content-length': String(PAYLOAD.length) })
  res.end(PAYLOAD)
}

beforeEach(async () => {
  hits = []
  tmpDir = await mkdtemp(join(tmpdir(), 'devkit-dl-'))

  routes = {
    '/file': (_req, res) => sendFull(res),

    // 完整支持 Range
    '/range': (req, res) => {
      const match = req.headers.range ? /^bytes=(\d+)-$/.exec(String(req.headers.range)) : null
      if (!match) {
        sendFull(res)
        return
      }
      const start = Number(match[1])
      const slice = PAYLOAD.subarray(start)
      res.writeHead(206, {
        'content-length': String(slice.length),
        'content-range': `bytes ${start}-${PAYLOAD.length - 1}/${PAYLOAD.length}`
      })
      res.end(slice)
    },

    // 忽略 Range，永远返回 200 全量：验证"服务器不支持续传时必须从头写"
    '/ignore-range': (_req, res) => sendFull(res),

    '/missing': (_req, res) => {
      res.writeHead(404)
      res.end('not found')
    },
    '/forbidden': (_req, res) => {
      res.writeHead(403)
      res.end('forbidden')
    },
    '/corrupt': (_req, res) => {
      const bad = Buffer.from('totally different content'.repeat(100))
      res.writeHead(200, { 'content-length': String(bad.length) })
      res.end(bad)
    },

    // 声明了 Content-Length 却只发一部分 → 连接被判定为中断
    '/truncated': (_req, res) => {
      res.writeHead(200, { 'content-length': String(PAYLOAD.length) })
      res.end(PAYLOAD.subarray(0, 1000))
    },

    // 不声明长度，且发的比 sizeBytes 少 → 由大小后置校验兜住
    '/short-no-length': (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.end(PAYLOAD.subarray(0, 5000))
    },

    '/redirect': (_req, res) => {
      res.writeHead(302, { location: '/file' })
      res.end()
    },
    '/boom': (_req, res) => res.destroy()
  }

  server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]
    hits.push({ path, range: req.headers.range ? String(req.headers.range) : undefined })
    const handler = routes[path]
    if (!handler) {
      res.writeHead(404)
      res.end('no route')
      return
    }
    handler(req, res)
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('服务器未监听')
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterEach(async () => {
  // 兜底：断言失败时可能留下未消费的响应，强制断开避免 teardown 挂住
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await rm(tmpDir, { recursive: true, force: true })
})

function source(path: string, name = path): DownloadSource {
  return { name, url: `${baseUrl}${path}` }
}

function target(name = 'out.bin'): string {
  return join(tmpDir, name)
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file)
    return true
  } catch {
    return false
  }
}

/** 统一给测试用短超时，避免失败路径上等 30 秒 */
function download(
  overrides: Partial<DownloadRequest> & { sources: DownloadSource[]; targetFile: string }
): Promise<DownloadResult> {
  return downloadFile({
    sha256: SHA,
    allowInsecure: true,
    timeoutMs: 2000,
    idleTimeoutMs: 2000,
    retriesPerSource: 1,
    ...overrides
  })
}

describe('下载成功路径', () => {
  it('下载、校验并落盘', async () => {
    const file = target()
    const result = await download({ sources: [source('/file')], targetFile: file })

    expect(result.ok).toBe(true)
    expect(result.sha256).toBe(SHA)
    expect(result.bytes).toBe(PAYLOAD.length)
    expect(await readFile(file)).toEqual(PAYLOAD)
    // 未校验的 .part 与侧车文件都应该被清理掉
    expect(await exists(`${file}.part`)).toBe(false)
    expect(await exists(`${file}.part.json`)).toBe(false)
  })

  it('跟随重定向', async () => {
    const result = await download({ sources: [source('/redirect')], targetFile: target() })
    expect(result.ok).toBe(true)
    expect(hits.map((hit) => hit.path)).toEqual(['/redirect', '/file'])
  })

  it('目标文件已存在且校验通过时不发起任何请求（幂等）', async () => {
    const file = target()
    await writeFile(file, PAYLOAD)

    const result = await download({ sources: [source('/file')], targetFile: file })

    expect(result.ok).toBe(true)
    expect(hits).toHaveLength(0)
  })

  it('目标文件存在但校验不通过时重新下载', async () => {
    const file = target()
    await writeFile(file, 'stale garbage')

    const result = await download({ sources: [source('/file')], targetFile: file })

    expect(result.ok).toBe(true)
    expect(hits).toHaveLength(1)
    expect(await readFile(file)).toEqual(PAYLOAD)
  })
})

describe('镜像回退', () => {
  it('首个源 404 时自动换下一个源', async () => {
    const result = await download({
      sources: [source('/missing', 'tuna'), source('/file', 'huaweicloud')],
      targetFile: target()
    })

    expect(result.ok).toBe(true)
    expect(result.attempts).toHaveLength(1)
    expect(result.attempts[0].source).toBe('tuna')
    expect(result.attempts[0].error).toContain('镜像未同步')
  })

  it('404 不重试同一个源（那是镜像没有，重试也没用）', async () => {
    await download({
      sources: [source('/missing', 'tuna'), source('/file', 'huawei')],
      targetFile: target(),
      retriesPerSource: 3
    })
    expect(hits.filter((hit) => hit.path === '/missing')).toHaveLength(1)
  })

  it('403 同样视为源不可用，不重试', async () => {
    await download({
      sources: [source('/forbidden', 'blocked'), source('/file', 'good')],
      targetFile: target(),
      retriesPerSource: 3
    })
    expect(hits.filter((hit) => hit.path === '/forbidden')).toHaveLength(1)
  })

  it('连接被重置属于临时故障，会重试同一个源', async () => {
    await download({
      sources: [source('/boom', 'flaky')],
      targetFile: target(),
      retriesPerSource: 3
    })
    expect(hits.filter((hit) => hit.path === '/boom').length).toBeGreaterThan(1)
  })

  it('所有源都失败时返回聚合错误', async () => {
    const result = await download({
      sources: [source('/missing', 'a'), source('/forbidden', 'b')],
      targetFile: target()
    })

    expect(result.ok).toBe(false)
    expect(result.filePath).toBeNull()
    expect(result.attempts.map((item) => item.source)).toEqual(['a', 'b'])
    expect(result.error).toContain('所有下载源都失败了')
  })

  it('没有候选源时直接失败', async () => {
    const result = await download({ sources: [], targetFile: target() })
    expect(result.ok).toBe(false)
    expect(result.error).toBe('没有可用的下载源')
  })
})

describe('完整性校验', () => {
  it('SHA-256 不匹配时判定失败，且不留下最终文件', async () => {
    const file = target()
    const result = await download({ sources: [source('/corrupt')], targetFile: file })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('SHA-256 校验失败')
    expect(await exists(file)).toBe(false)
    expect(await exists(`${file}.part`)).toBe(false)
  })

  it('SHA-256 不匹配时换下一个源继续试', async () => {
    const result = await download({
      sources: [source('/corrupt', 'bad-mirror'), source('/file', 'good')],
      targetFile: target()
    })
    expect(result.ok).toBe(true)
    expect(result.attempts[0].error).toContain('SHA-256 校验失败')
  })

  it('服务器声明长度却提前断开时，报错要说清收到了多少', async () => {
    const result = await download({
      sources: [source('/truncated')],
      targetFile: target(),
      sizeBytes: PAYLOAD.length
    })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('下载不完整')
    expect(result.error).toContain('已收到')
  })

  it('响应没有长度声明时，由 sizeBytes 后置校验兜住', async () => {
    const result = await download({
      sources: [source('/short-no-length')],
      targetFile: target(),
      sizeBytes: PAYLOAD.length
    })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('文件大小不符')
  })
})

describe('断点续传', () => {
  it('存在有效断点时只请求剩余部分', async () => {
    const file = target()
    const cut = 40_000
    await writeFile(`${file}.part`, PAYLOAD.subarray(0, cut))
    await writeFile(
      `${file}.part.json`,
      JSON.stringify({ url: `${baseUrl}/range`, total: PAYLOAD.length })
    )

    const result = await download({ sources: [source('/range')], targetFile: file })

    expect(result.ok).toBe(true)
    expect(hits[0].range).toBe(`bytes=${cut}-`)
    expect(await readFile(file)).toEqual(PAYLOAD)
  })

  it('服务器忽略 Range 返回 200 时从头重写，结果仍然正确', async () => {
    const file = target()
    await writeFile(`${file}.part`, PAYLOAD.subarray(0, 40_000))
    await writeFile(
      `${file}.part.json`,
      JSON.stringify({ url: `${baseUrl}/ignore-range`, total: PAYLOAD.length })
    )

    const result = await download({ sources: [source('/ignore-range')], targetFile: file })

    expect(result.ok).toBe(true)
    expect(hits[0].range).toBe('bytes=40000-')
    // 关键：不能把 200 的完整内容追加到已有的 40000 字节后面
    expect(await readFile(file)).toEqual(PAYLOAD)
  })

  it('侧车文件记录的源与当前源不一致时不续传（避免拼接两个源的数据）', async () => {
    const file = target()
    await writeFile(`${file}.part`, PAYLOAD.subarray(0, 40_000))
    await writeFile(
      `${file}.part.json`,
      JSON.stringify({ url: `${baseUrl}/some-other-url`, total: PAYLOAD.length })
    )

    const result = await download({ sources: [source('/file')], targetFile: file })

    expect(result.ok).toBe(true)
    expect(hits[0].range).toBeUndefined()
    expect(await readFile(file)).toEqual(PAYLOAD)
  })
})

describe('取消与协议约束', () => {
  it('提前取消时返回失败且不抛异常', async () => {
    const controller = new AbortController()
    controller.abort()

    const result = await download({
      sources: [source('/file')],
      targetFile: target(),
      signal: controller.signal
    })

    expect(result.ok).toBe(false)
    expect(result.error).toBe('已取消')
  })

  it('默认拒绝 http 源（NFR-1 只允许 https）', async () => {
    const result = await downloadFile({
      sources: [source('/file')],
      sha256: SHA,
      targetFile: target()
    })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('拒绝非 https 下载地址')
    expect(hits).toHaveLength(0)
  })
})

describe('慢速源回退（SPEC 风险表：镜像速度差异巨大）', () => {
  it('源连得上但速度长期不达标时会放弃它，改用下一个源', async () => {
    // 每 400ms 只吐 200 字节：连接不断，但平均速度只有几百 B/s。
    // 这正是 GitHub release 资产在国内的典型表现 —— 空闲超时永远不会触发。
    routes['/trickle'] = (_req, res) => {
      res.writeHead(200, { 'content-length': String(PAYLOAD.length) })
      const timer = setInterval(() => {
        if (res.writableEnded) {
          clearInterval(timer)
          return
        }
        res.write(Buffer.alloc(200, 0x61))
      }, 400)
      res.on('close', () => clearInterval(timer))
    }

    const file = target('slow.bin')
    const startedAt = Date.now()

    const result = await download({
      sources: [source('/trickle', 'slow-github'), source('/file', 'fast-mirror')],
      targetFile: file,
      minSpeedBytesPerSec: 100_000,
      speedGraceMs: 800
    })

    expect(result.ok).toBe(true)
    // 第一个源被判定为太慢并记进 attempts
    expect(result.attempts[0]?.source).toBe('slow-github')
    expect(result.attempts[0]?.error).toContain('KB/s')
    // 最终落盘的是第二个源的文件，且内容正确
    expect((await readFile(file)).length).toBe(PAYLOAD.length)
    expect(Date.now() - startedAt).toBeLessThan(60_000)
  }, 90_000)

  it('速度达标时不会误杀（正常镜像不该被换掉）', async () => {
    const file = target('ok.bin')
    const result = await download({
      sources: [source('/file', 'fast')],
      targetFile: file,
      minSpeedBytesPerSec: 1024,
      speedGraceMs: 200
    })

    expect(result.ok).toBe(true)
    expect(result.attempts).toHaveLength(0)
  }, 60_000)
})
