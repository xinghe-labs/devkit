import { request as httpRequest } from 'node:http'
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https'
import type { AgentOptions, IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { connect as tlsConnect } from 'node:tls'
import { URL } from 'node:url'

/**
 * 最小 HTTPS 客户端。
 *
 * 为什么不用全局 fetch：Node 22 的 fetch 不支持走代理（undici 的 ProxyAgent 属于另一个
 * undici 实例，混用不可靠），而 FR-19 明确要求支持代理。用 node:http/https 自己写
 * 反而更可控，也能精确控制超时、重定向与 Range 续传。
 *
 * 关于 socket 归属（踩过的坑）：不要自己 net.connect/tls.connect 出一个 socket
 * 再通过 createConnection 塞给请求 —— Node 不认为这个 socket 归它管，响应结束后不会销毁它，
 * 实测每次下载泄漏一个连接。正确做法是让 Node 通过 Agent 自己创建并管理 socket：
 * 直连用默认行为，走代理则用一个自定义 Agent 在 createConnection 里做 CONNECT 隧道。
 */

export interface HttpRequestOptions {
  headers?: Record<string, string>
  /** 预检探测源可达性时用 HEAD，避免真下载 */
  method?: 'GET' | 'HEAD'
  /** 形如 http://127.0.0.1:7890。只支持 http 代理（CONNECT 隧道），这也是本地代理软件的常见形态 */
  proxy?: string | null
  /** 等待响应头的超时 */
  timeoutMs?: number
  signal?: AbortSignal
  maxRedirects?: number
}

export interface HttpResponse {
  status: number
  headers: IncomingMessage['headers']
  stream: IncomingMessage
  /** 跟随重定向后的最终 URL */
  finalUrl: string
}

export class HttpError extends Error {
  readonly status: number | null
  constructor(message: string, status: number | null = null) {
    super(message)
    this.name = 'HttpError'
    this.status = status
  }
}

function connectTunnel(proxy: URL, target: string, timeoutMs: number): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const port = proxy.port ? Number(proxy.port) : 80
    const request = httpRequest({
      host: proxy.hostname,
      port,
      method: 'CONNECT',
      path: target,
      headers: { Host: target, 'Proxy-Connection': 'keep-alive' },
      timeout: timeoutMs
    })

    request.on('connect', (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy()
        reject(new HttpError(`代理 CONNECT 失败：HTTP ${response.statusCode}`, response.statusCode))
        return
      }
      resolve(socket)
    })
    request.on('timeout', () => request.destroy(new Error(`连接代理超时（${timeoutMs}ms）`)))
    request.on('error', reject)
    request.end()
  })
}

/** 让 Node 自己管理经过代理隧道的 socket，从而在响应结束后正常回收 */
class TunnelAgent extends HttpsAgent {
  private readonly proxyUrl: URL
  private readonly timeoutMs: number

  constructor(proxy: string, timeoutMs: number) {
    super({ keepAlive: false })
    this.proxyUrl = new URL(proxy)
    this.timeoutMs = timeoutMs
  }

  override createConnection(
    options: AgentOptions,
    callback?: (error: Error | null, stream: Duplex) => void
  ): Duplex | null | undefined {
    if (!callback) return undefined

    const host = options.host ?? ''
    const port = options.port ?? 443
    // AgentOptions 的类型定义里没有 servername（它属于 tls 选项），运行时是有的
    const servername = (options as { servername?: string }).servername ?? host
    // Node 在失败时只传 error，但类型签名要求两个参数，这里放宽一下
    const done = callback as (error: Error | null, stream?: Duplex) => void

    connectTunnel(this.proxyUrl, `${host}:${port}`, this.timeoutMs)
      .then((raw) => {
        if (options.protocol === 'https:') {
          done(null, tlsConnect({ socket: raw, servername }))
          return
        }
        done(null, raw)
      })
      .catch((error: Error) => done(error))

    return undefined
  }
}

function resolveAgent(options: HttpRequestOptions, timeoutMs: number): HttpsAgent | false {
  if (!options.proxy) return false // 交给 Node 用默认行为创建并回收 socket
  const proxyUrl = new URL(options.proxy)
  if (proxyUrl.protocol !== 'http:') {
    throw new HttpError(`暂不支持 ${proxyUrl.protocol} 代理，请使用 http:// 代理`)
  }
  return new TunnelAgent(options.proxy, timeoutMs)
}

/** 发起 GET 请求并返回响应流，自动跟随重定向。调用方负责消费或销毁返回的 stream。 */
export async function requestStream(
  rawUrl: string,
  options: HttpRequestOptions = {}
): Promise<HttpResponse> {
  const timeoutMs = options.timeoutMs ?? 30_000
  const maxRedirects = options.maxRedirects ?? 5
  let current = new URL(rawUrl)

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    if (options.signal?.aborted) throw new HttpError('请求已取消')

    const agent = resolveAgent(options, timeoutMs)

    const response = await new Promise<HttpResponse>((resolve, reject) => {
      const send = current.protocol === 'https:' ? httpsRequest : httpRequest

      const request = send(
        {
          protocol: current.protocol,
          host: current.hostname,
          port: current.port ? Number(current.port) : undefined,
          path: `${current.pathname}${current.search}`,
          method: options.method ?? 'GET',
          headers: { Connection: 'close', ...(options.headers ?? {}) },
          agent
        },
        (incoming) => {
          resolve({
            status: incoming.statusCode ?? 0,
            headers: incoming.headers,
            stream: incoming,
            finalUrl: current.toString()
          })
        }
      )

      request.setTimeout(timeoutMs, () => {
        request.destroy(new Error(`等待响应超时（${timeoutMs}ms）`))
      })
      request.on('error', reject)

      const onAbort = (): void => {
        request.destroy(new Error('请求已取消'))
      }
      options.signal?.addEventListener('abort', onAbort, { once: true })
      request.on('close', () => options.signal?.removeEventListener('abort', onAbort))

      request.end()
    })

    const location = response.headers.location
    const isRedirect = response.status >= 300 && response.status < 400 && location
    if (!isRedirect) return response

    // 跟随重定向：先释放当前连接，避免 socket 泄漏
    response.stream.resume()
    response.stream.destroy()
    if (hop === maxRedirects) {
      throw new HttpError(`重定向次数超过上限（${maxRedirects}）`, response.status)
    }
    current = new URL(String(location), current)
  }

  throw new HttpError('重定向处理异常')
}
