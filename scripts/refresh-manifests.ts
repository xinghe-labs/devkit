/**
 * 清单数据刷新器（开发/维护工具，不参与打包）。
 *
 * 为什么需要它：
 *  清单里最容易过期也最容易写错的是 `versions` —— 版本号、下载地址、SHA-256、体积、发布日期。
 *  手工填这些字段的结果就是"清单看起来能装、实际装不了"（SPEC §7.1 明确反对）。
 *  这个脚本把这些字段全部**从官方渠道取**：
 *   · 有官方 API / 校验和文件的，直接取（Go、Adoptium、Gradle、VS Code、rustup、Deno、Bun）
 *   · 没有的，下载官方安装包后**本地算** SHA-256（Python、Maven、CMake、Git、pnpm、Ninja、SQLite、7-Zip）
 *  凡是算不出来的就报错并跳过，绝不写占位值。
 *
 * 用法：
 *   pnpm manifest:refresh            # 刷新全部
 *   pnpm manifest:refresh go nodejs  # 只刷新指定工具
 *   pnpm manifest:refresh --check    # 只检查当前清单里的 URL 是否可达，不写入
 */
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { requestStream } from '../src/main/core/downloader/http'
import { sha256File } from '../src/main/core/downloader/checksum'

const MANIFEST_DIR = resolve('resources/manifest/tools')
const CACHE_DIR = resolve('node_modules/.cache/devkit-manifest')
const WRITE = !process.argv.includes('--check')
const ONLY = process.argv.slice(2).filter((arg) => !arg.startsWith('--'))

/* ------------------------------------------------------------------ */
/* HTTP 小工具                                                         */
/* ------------------------------------------------------------------ */

async function fetchText(url: string, attempts = 3): Promise<string> {
  let lastError: Error | null = null

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      // sqlite.org 这类站点响应很慢，30 秒不够；60 秒 + 重试才稳
      const response = await requestStream(url, { timeoutMs: 60_000, maxRedirects: 6 })
      if (response.status !== 200) {
        response.stream.destroy()
        throw new Error(`HTTP ${response.status} ${url}`)
      }
      const chunks: Buffer[] = []
      for await (const chunk of response.stream) chunks.push(chunk as Buffer)
      return Buffer.concat(chunks).toString('utf8')
    } catch (error) {
      lastError = error as Error
    }
  }

  throw lastError ?? new Error(`fetchText 失败：${url}`)
}

async function fetchJson<T>(url: string): Promise<T> {
  return JSON.parse(await fetchText(url)) as T
}

/**
 * 取 GitHub 最新 release 的 tag。
 *
 * 刻意不用 api.github.com：未认证的 API 限额是每小时 60 次，刷新一轮清单就能撞上 403，
 * 而 `/releases/latest` 的 302 跳转本身就把 tag 写在 Location 里 —— 不限速、不需要 token。
 */
async function githubLatestTag(repo: string): Promise<string> {
  const errors: string[] = []

  // 两条路径都试：302 跳转不限速但网络不稳，API 稳但有每小时 60 次的限额
  for (let round = 0; round < 3; round += 1) {
    try {
      const response = await fetch(`https://github.com/${repo}/releases/latest`, {
        redirect: 'follow',
        signal: AbortSignal.timeout(20_000)
      })
      const tag = response.url.split('/').filter(Boolean).pop()
      if (tag && tag !== 'latest' && tag !== 'releases') return tag
      errors.push(`跳转解析失败（${response.url}）`)
    } catch (error) {
      errors.push(`跳转：${(error as Error).message}`)
    }

    try {
      const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
        headers: { 'User-Agent': 'devkit-manifest-refresh' },
        signal: AbortSignal.timeout(20_000)
      })
      if (response.ok) {
        const data = (await response.json()) as { tag_name?: string }
        if (data.tag_name) return data.tag_name
        errors.push('API 响应里没有 tag_name')
      } else {
        errors.push(`API HTTP ${response.status}`)
      }
    } catch (error) {
      errors.push(`API：${(error as Error).message}`)
    }

    await new Promise((resolve) => setTimeout(resolve, 1500))
  }

  throw new Error(`无法解析 ${repo} 的最新 tag：${errors.join(' | ')}`)
}

/**
 * 用一次 128 KB 的范围请求同时测速并读出总长度。
 */
interface Probe {
  url: string
  speed: number
  total: number | null
  error: string | null
}

async function probeCandidate(url: string): Promise<Probe> {
  const started = Date.now()
  try {
    const response = await requestStream(url, {
      headers: { Range: 'bytes=0-131071' },
      timeoutMs: 20_000,
      maxRedirects: 6
    })
    if (response.status >= 400) {
      response.stream.destroy()
      return { url, speed: -1, total: null, error: `HTTP ${response.status}` }
    }

    const contentRange = String(response.headers['content-range'] ?? '')
    const total = Number(contentRange.split('/')[1]) || null

    let bytes = 0
    for await (const chunk of response.stream) bytes += (chunk as Buffer).length
    const speed = bytes / Math.max(1, Date.now() - started)
    return { url, speed, total, error: null }
  } catch (error) {
    return { url, speed: -1, total: null, error: (error as Error).message }
  }
}

/**
 * 选一个下载源来算 SHA-256。
 *
 * 为什么必须测速：官方源实测慢到不可用（python.org 12 KB/s、archive.apache.org 25 KB/s、
 * sqlite.org 8 KB/s），一个 30 MB 的包要下 40 分钟；而国内镜像有 3~5 MB/s。
 *
 * 为什么敢用镜像算哈希：先对所有候选做范围请求，**要求它们报告的总字节数完全一致**，
 * 不一致就直接报错交人处理。体积一致 + SHA-256 校验，镜像返回了不同文件是拦得住的
 * —— 真不一致时安装阶段会以"校验失败"拒绝，而不是装上一个来源不明的文件。
 */
async function chooseHashSource(candidates: string[]): Promise<{ url: string; total: number | null }> {
  const probes = await Promise.all(candidates.map((url) => probeCandidate(url)))
  const usable = probes.filter((probe) => probe.speed > 0)

  if (usable.length === 0) {
    throw new Error(
      `所有候选地址都不可用：\n    ${probes.map((probe) => `${probe.url} → ${probe.error}`).join('\n    ')}`
    )
  }

  const totals = new Set(usable.map((probe) => probe.total).filter((total) => total !== null))
  if (totals.size > 1) {
    throw new Error(
      `候选源报告的体积不一致，拒绝用它算哈希：\n    ${usable
        .map((probe) => `${probe.url} → ${probe.total} 字节`)
        .join('\n    ')}`
    )
  }

  const best = usable.sort((a, b) => b.speed - a.speed)[0]
  for (const probe of usable) {
    if (probe.url === best.url) continue
    console.log(`  · 选 ${best.url.split('/')[2]}（${(best.speed / 1024).toFixed(0)} KB/s），跳过 ${probe.url.split('/')[2]}`)
  }
  return { url: best.url, total: best.total }
}

/** 下载到本地缓存并算 SHA-256 与体积（源由 chooseHashSource 选） */
async function downloadAndHash(candidates: string[]): Promise<{ sha256: string; sizeBytes: number }> {
  mkdirSync(CACHE_DIR, { recursive: true })
  const chosen = await chooseHashSource(candidates)
  const name = chosen.url.split('/').pop()?.split('?')[0] ?? 'blob'
  const target = join(CACHE_DIR, name)
  const errors: string[] = []

  // 实测 7-zip.org / GitHub release 资产会偶发 ECONNRESET，重试两次基本就过了
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await requestStream(chosen.url, { timeoutMs: 60_000, maxRedirects: 6 })
      if (response.status !== 200) {
        response.stream.destroy()
        throw new Error(`HTTP ${response.status}`)
      }
      await pipeline(response.stream, createWriteStream(target))

      const { statSync } = await import('node:fs')
      const sizeBytes = statSync(target).size
      if (sizeBytes === 0) throw new Error('下载到 0 字节')
      if (chosen.total !== null && sizeBytes !== chosen.total) {
        throw new Error(`下载体积 ${sizeBytes} 与探测到的 ${chosen.total} 不一致`)
      }

      const sha256 = await sha256File(target)
      await rm(target, { force: true })
      return { sha256, sizeBytes }
    } catch (error) {
      errors.push(`第 ${attempt} 次：${(error as Error).message}`)
      await rm(target, { force: true })
    }
  }

  throw new Error(`${chosen.url} → ${errors.join(' / ')}`)
}

/** 从 "hash  filename" 形式的校验和文本里取出指定文件名的哈希 */
function pickHash(text: string, fileName: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const match = line.trim().match(/^([a-f0-9]{64})\s+\*?(.+)$/i)
    if (match && match[2].trim() === fileName) return match[1].toLowerCase()
  }
  return null
}

/* ------------------------------------------------------------------ */
/* 解析结果的类型                                                      */
/* ------------------------------------------------------------------ */

interface ResolvedVersion {
  version: string
  channel: 'lts' | 'stable' | 'beta'
  recommended?: boolean
  releaseDate?: string
  sizeBytes?: number
  url: string
  sha256: string
  mirrors?: { name: string; url: string }[]
}

interface DiscoveredVersion {
  version: string
  /** 部分站点（sqlite / 7-Zip）的下载地址无法由版本号推导，由 discover 直接给出 */
  url?: string
}

interface VersionSource {
  /** 期望的版本号；'latest' 表示取官方最新 */
  want: string
  channel: 'lts' | 'stable' | 'beta'
  recommended?: boolean
  /** 返回该版本的下载地址；discover 提供了 url 时不会调用 */
  url: (version: string) => string
  /** 镜像地址（可选） */
  mirrors?: (version: string, url: string) => { name: string; url: string }[]
  /** 取 SHA-256 与体积的方式；candidates[0] 是官方地址，其后是镜像 */
  resolve: (version: string, candidates: string[]) => Promise<{ sha256: string; sizeBytes: number }>
  /** 该工具支持哪些版本 */
  discover?: () => Promise<DiscoveredVersion[]>
}

interface ToolSpec {
  id: string
  category: 'runtime' | 'build' | 'database' | 'container' | 'editor' | 'tool'
  tier: 'L1' | 'L2' | 'L3'
  name: { 'zh-CN': string; 'en-US': string }
  description: { 'zh-CN': string; 'en-US': string }
  homepage: string
  license: { spdx: string; redistributable: boolean }
  detect: unknown
  installScope: 'user' | 'machine'
  install: { type: string; template: string; params?: Record<string, string> }
  activate?: unknown
  verify?: unknown
  notes?: { 'zh-CN': string; 'en-US': string }
  versions: VersionSource[]
}

/* ------------------------------------------------------------------ */
/* 工具定义                                                            */
/* ------------------------------------------------------------------ */

const SPECS: ToolSpec[] = [
  /* ---------------- 语言运行时 ---------------- */
  {
    id: 'python',
    category: 'runtime',
    tier: 'L1',
    name: { 'zh-CN': 'Python', 'en-US': 'Python' },
    description: {
      'zh-CN': '通用编程语言运行时，自带 pip。用户级安装，不改系统 PATH。',
      'en-US': 'General purpose language runtime with pip bundled. Per-user install, no system PATH edits.'
    },
    homepage: 'https://www.python.org',
    license: { spdx: 'PSF-2.0', redistributable: true },
    detect: {
      commands: [
        { cmd: 'python', args: ['--version'], expectRegex: 'Python \\d+\\.\\d+' },
        { cmd: 'py', args: ['-3', '--version'], expectRegex: 'Python \\d+\\.\\d+' }
      ],
      registry: [
        {
          hive: 'HKCU',
          view: '64',
          path: 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
          match: { DisplayName: '^Python \\d' },
          versionFrom: 'DisplayVersion'
        },
        {
          hive: 'HKLM',
          view: '64',
          path: 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
          match: { DisplayName: '^Python \\d' },
          versionFrom: 'DisplayVersion'
        }
      ]
    },
    installScope: 'user',
    install: { type: 'exe-custom', template: 'exe-python-silent', params: { includeLauncher: '1', includePip: '1' } },
    // 刻意不设 PYTHONHOME：它会让 Python 忽略自身的相对路径，还会干扰 venv 与 py 启动器
    activate: { pathEntries: ['{currentDir}', '{currentDir}\\Scripts'] },
    verify: { cmd: '{installDir}\\python.exe', args: ['--version'], expectRegex: 'Python \\d+\\.\\d+' },
    notes: {
      'zh-CN':
        '用官方 exe 安装器 + /quiet InstallAllUsers=0，装到版本目录里，不需要管理员。刻意传 PrependPath=0：PATH 交给 devkit 的激活机制统一管理，避免安装器和 devkit 抢着写 PATH。',
      'en-US':
        'Official exe installer with /quiet InstallAllUsers=0 into the version directory — no admin needed. PrependPath=0 is deliberate: PATH is owned by devkit activation so the installer and devkit never fight over it.'
    },
    versions: [
      {
        want: '3.14.8',
        channel: 'stable',
        recommended: true,
        url: (v) => `https://www.python.org/ftp/python/${v}/python-${v}-amd64.exe`,
        mirrors: (v) => [
          {
            name: 'huaweicloud',
            url: `https://mirrors.huaweicloud.com/python/${v}/python-${v}-amd64.exe`
          }
        ],
        resolve: async (_v, candidates) => downloadAndHash(candidates)
      },
      {
        want: '3.13.16',
        channel: 'stable',
        url: (v) => `https://www.python.org/ftp/python/${v}/python-${v}-amd64.exe`,
        mirrors: (v) => [
          { name: 'huaweicloud', url: `https://mirrors.huaweicloud.com/python/${v}/python-${v}-amd64.exe` }
        ],
        resolve: async (_v, candidates) => downloadAndHash(candidates)
      },
      {
        want: '3.15.0',
        channel: 'stable',
        url: (v) => `https://www.python.org/ftp/python/${v}/python-${v}-amd64.exe`,
        mirrors: (v) => [
          { name: 'huaweicloud', url: `https://mirrors.huaweicloud.com/python/${v}/python-${v}-amd64.exe` }
        ],
        resolve: async (_v, candidates) => downloadAndHash(candidates)
      }
    ]
  },
  {
    id: 'go',
    category: 'runtime',
    tier: 'L1',
    name: { 'zh-CN': 'Go', 'en-US': 'Go' },
    description: {
      'zh-CN': 'Go 语言工具链，自带 go mod。解压到版本目录，用户级。',
      'en-US': 'The Go toolchain with go mod bundled. Extracted into a per-user version directory.'
    },
    homepage: 'https://go.dev',
    license: { spdx: 'BSD-3-Clause', redistributable: true },
    detect: {
      commands: [{ cmd: 'go', args: ['version'], expectRegex: 'go\\d+\\.\\d+' }],
      files: ['%ProgramFiles%\\Go\\bin\\go.exe']
    },
    installScope: 'user',
    install: { type: 'zip', template: 'zip-into-version-dir', params: { stripComponents: '1' } },
    activate: { pathEntries: ['{currentDir}\\bin'], env: { GOROOT: '{currentDir}' } },
    verify: { cmd: '{installDir}\\bin\\go.exe', args: ['version'], expectRegex: 'go\\d+\\.\\d+' },
    notes: {
      'zh-CN': 'SHA-256 与体积直接取自官方 https://go.dev/dl/?mode=json，不下载、不猜。',
      'en-US': 'SHA-256 and size come straight from the official https://go.dev/dl/?mode=json feed.'
    },
    versions: [
      {
        want: 'latest',
        channel: 'stable',
        recommended: true,
        url: (v) => `https://go.dev/dl/go${v}.windows-amd64.zip`,
        mirrors: (v) => [
          { name: 'huaweicloud', url: `https://mirrors.huaweicloud.com/go/${v}/go${v}.windows-amd64.zip` },
          { name: 'aliyun', url: `https://mirrors.aliyun.com/golang/go${v}.windows-amd64.zip` }
        ],
        discover: async () => {
          const data = await fetchJson<{ version: string; stable: boolean }[]>('https://go.dev/dl/?mode=json')
          return data
            .filter((item) => item.stable)
            .map((item) => ({ version: item.version.replace(/^go/, '') }))
        },
        resolve: async (version) => {
          const data = await fetchJson<
            { version: string; stable: boolean; files: { filename: string; sha256: string; size: number }[] }[]
          >('https://go.dev/dl/?mode=json')
          const entry = data.find((item) => item.version === `go${version}`)
          const file = entry?.files.find((item) => item.filename === `go${version}.windows-amd64.zip`)
          if (!file) throw new Error(`go 官方源里找不到 go${version}.windows-amd64.zip`)
          return { sha256: file.sha256, sizeBytes: file.size }
        }
      }
    ]
  },
  {
    id: 'jdk-temurin',
    category: 'runtime',
    tier: 'L1',
    name: { 'zh-CN': 'Eclipse Temurin JDK', 'en-US': 'Eclipse Temurin JDK' },
    description: {
      'zh-CN': 'OpenJDK 的免费发行版，可自由分发（本项目不使用 Oracle JDK）。',
      'en-US': 'A freely redistributable OpenJDK build (this project does not use Oracle JDK).'
    },
    homepage: 'https://adoptium.net',
    license: { spdx: 'GPL-2.0-only WITH Classpath-exception-2.0', redistributable: true },
    detect: {
      commands: [
        { cmd: 'java', args: ['-version'], expectRegex: 'version "\\d+' },
        { cmd: 'javac', args: ['-version'], expectRegex: 'javac \\d+' }
      ],
      registry: [
        {
          hive: 'HKLM',
          view: '64',
          path: 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
          match: { DisplayName: '^Eclipse Temurin JDK' },
          versionFrom: 'DisplayVersion'
        }
      ]
    },
    installScope: 'user',
    install: { type: 'zip', template: 'zip-into-version-dir', params: { stripComponents: '1' } },
    activate: { pathEntries: ['{currentDir}\\bin'], env: { JAVA_HOME: '{currentDir}' } },
    verify: { cmd: '{installDir}\\bin\\java.exe', args: ['-version'], expectRegex: 'version "\\d+' },
    notes: {
      'zh-CN':
        '用 Adoptium 官方 API 取 ZIP 与 SHA-256（API 返回的 checksum 就是 sha256）。装两份 LTS 就能演示版本切换：激活 21 后 java -version 就是 21。',
      'en-US':
        'ZIP and SHA-256 come from the official Adoptium API. Installing two LTS releases demonstrates version switching: activate 21 and java -version reports 21.'
    },
    versions: [
      {
        want: '21',
        channel: 'lts',
        recommended: true,
        url: () => '',
        resolve: async () => ({ sha256: '', sizeBytes: 0 }),
        discover: async () => [{ version: '21' }, { version: '17' }]
      },
      {
        want: '17',
        channel: 'lts',
        url: () => '',
        resolve: async () => ({ sha256: '', sizeBytes: 0 })
      }
    ]
  },
  {
    id: 'rust',
    category: 'runtime',
    tier: 'L1',
    name: { 'zh-CN': 'Rust', 'en-US': 'Rust' },
    description: {
      'zh-CN': 'Rust 工具链（rustc / cargo），通过 rustup 安装到版本目录，不污染全局。',
      'en-US': 'The Rust toolchain (rustc / cargo) installed via rustup into the version directory.'
    },
    homepage: 'https://rustup.rs',
    license: { spdx: 'MIT OR Apache-2.0', redistributable: true },
    detect: {
      commands: [
        { cmd: 'rustc', args: ['--version'], expectRegex: 'rustc \\d+\\.\\d+' },
        { cmd: 'cargo', args: ['--version'], expectRegex: 'cargo \\d+\\.\\d+' }
      ]
    },
    installScope: 'user',
    install: {
      type: 'exe-custom',
      template: 'exe-rustup-init',
      params: { profile: 'minimal', defaultHost: 'x86_64-pc-windows-msvc' }
    },
    activate: {
      pathEntries: ['{currentDir}\\cargo\\bin'],
      env: { CARGO_HOME: '{currentDir}\\cargo', RUSTUP_HOME: '{currentDir}\\rustup' }
    },
    verify: { cmd: '{installDir}\\cargo\\bin\\rustc.exe', args: ['--version'], expectRegex: 'rustc \\d+\\.\\d+' },
    notes: {
      'zh-CN':
        'rustup-init 本身很小，真正下载工具链是在安装过程中（约 300 MB，取决于网络）。用 CARGO_HOME / RUSTUP_HOME 把工具链整个关进版本目录，--no-modify-path 保证它不去改 PATH。',
      'en-US':
        'rustup-init itself is tiny; the toolchain (~300 MB) is fetched during install. CARGO_HOME / RUSTUP_HOME keep everything inside the version directory and --no-modify-path stops it from touching PATH.'
    },
    versions: [
      {
        want: 'latest',
        channel: 'stable',
        recommended: true,
        url: () => 'https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe',
        mirrors: () => [
          {
            name: 'tuna',
            url: 'https://mirrors.tuna.tsinghua.edu.cn/rustup/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe'
          }
        ],
        // rustup 的下载地址不含版本号，所以版本标签取官方 release-stable.toml 里的 rustup 版本
        discover: async () => {
          const toml = await fetchText('https://static.rust-lang.org/rustup/release-stable.toml')
          // 行首锚定：否则会先匹配到 schema-version = '1'
          const match = toml.match(/^version\s*=\s*'([0-9.]+)'/m)
          if (!match) throw new Error('无法从 release-stable.toml 解析 rustup 版本')
          return [{ version: match[1] }]
        },
        resolve: async (_v, candidates) => {
          const text = await fetchText(`${candidates[0]}.sha256`)
          const hash = text.trim().split(/\s+/)[0]
          if (!/^[a-f0-9]{64}$/i.test(hash)) throw new Error(`rustup 校验和格式异常：${text.slice(0, 80)}`)
          return { sha256: hash.toLowerCase(), sizeBytes: 0 }
        }
      }
    ]
  },

  /* ---------------- 构建工具 ---------------- */
  {
    id: 'maven',
    category: 'build',
    tier: 'L1',
    name: { 'zh-CN': 'Apache Maven', 'en-US': 'Apache Maven' },
    description: {
      'zh-CN': 'Java 项目的依赖管理与构建工具。',
      'en-US': 'Dependency management and build tool for Java projects.'
    },
    homepage: 'https://maven.apache.org',
    license: { spdx: 'Apache-2.0', redistributable: true },
    detect: {
      commands: [{ cmd: 'mvn', args: ['-v'], expectRegex: 'Apache Maven \\d+' }],
      files: ['%ProgramFiles%\\apache-maven-*\\bin\\mvn.cmd']
    },
    installScope: 'user',
    install: { type: 'zip', template: 'zip-into-version-dir', params: { stripComponents: '1' } },
    activate: { pathEntries: ['{currentDir}\\bin'], env: { MAVEN_HOME: '{currentDir}' } },
    verify: { cmd: '{installDir}\\bin\\mvn.cmd', args: ['-v'], expectRegex: 'Apache Maven \\d+' },
    notes: {
      'zh-CN': 'Apache 只发布 .sha512，没有 .sha256，所以 SHA-256 由本地下载后计算（约 9 MB）。',
      'en-US': 'Apache only publishes .sha512, so the SHA-256 is computed locally after downloading (~9 MB).'
    },
    versions: [
      {
        want: 'latest',
        channel: 'stable',
        recommended: true,
        url: (v) => `https://archive.apache.org/dist/maven/maven-3/${v}/binaries/apache-maven-${v}-bin.zip`,
        mirrors: (v) => [
          {
            name: 'huaweicloud',
            url: `https://mirrors.huaweicloud.com/apache/maven/maven-3/${v}/binaries/apache-maven-${v}-bin.zip`
          }
        ],
        discover: async () => {
          const html = await fetchText('https://archive.apache.org/dist/maven/maven-3/')
          const found = [...html.matchAll(/href="(3\.\d+\.\d+)\/"/g)].map((match) => match[1])
          return [...new Set(found)]
            .sort(compareVersionsDesc)
            .slice(0, 1)
            .map((version) => ({ version }))
        },
        resolve: async (_v, candidates) => downloadAndHash(candidates)
      }
    ]
  },
  {
    id: 'gradle',
    category: 'build',
    tier: 'L1',
    name: { 'zh-CN': 'Gradle', 'en-US': 'Gradle' },
    description: {
      'zh-CN': 'JVM 生态的构建工具，Android 与 Java 项目常用。',
      'en-US': 'Build tool for the JVM ecosystem, common in Android and Java projects.'
    },
    homepage: 'https://gradle.org',
    license: { spdx: 'Apache-2.0', redistributable: true },
    detect: {
      commands: [{ cmd: 'gradle', args: ['-v'], expectRegex: 'Gradle \\d+' }],
      files: ['%USERPROFILE%\\.gradle\\wrapper\\dists']
    },
    installScope: 'user',
    install: { type: 'zip', template: 'zip-into-version-dir', params: { stripComponents: '1' } },
    activate: { pathEntries: ['{currentDir}\\bin'], env: { GRADLE_HOME: '{currentDir}' } },
    verify: { cmd: '{installDir}\\bin\\gradle.bat', args: ['-v'], expectRegex: 'Gradle \\d+' },
    notes: {
      'zh-CN': '版本、下载地址与 SHA-256 都取自官方 https://services.gradle.org/versions/current。',
      'en-US': 'Version, URL and SHA-256 all come from the official https://services.gradle.org/versions/current.'
    },
    versions: [
      {
        want: 'latest',
        channel: 'stable',
        recommended: true,
        url: (v) => `https://services.gradle.org/distributions/gradle-${v}-bin.zip`,
        mirrors: (v) => [
          { name: 'aliyun', url: `https://mirrors.aliyun.com/macports/distfiles/gradle/gradle-${v}-bin.zip` }
        ],
        discover: async () => {
          const data = await fetchJson<{ version: string }>('https://services.gradle.org/versions/current')
          return [{ version: data.version }]
        },
        resolve: async () => {
          const data = await fetchJson<{ version: string; downloadUrl: string; checksum: string }>(
            'https://services.gradle.org/versions/current'
          )
          return { sha256: data.checksum, sizeBytes: 0 }
        }
      }
    ]
  },
  {
    id: 'cmake',
    category: 'build',
    tier: 'L1',
    name: { 'zh-CN': 'CMake', 'en-US': 'CMake' },
    description: {
      'zh-CN': '跨平台构建系统生成器，C/C++ 项目常用。',
      'en-US': 'Cross-platform build system generator, common for C/C++ projects.'
    },
    homepage: 'https://cmake.org',
    license: { spdx: 'BSD-3-Clause', redistributable: true },
    detect: {
      commands: [{ cmd: 'cmake', args: ['--version'], expectRegex: 'cmake version \\d+' }],
      files: ['%ProgramFiles%\\CMake\\bin\\cmake.exe']
    },
    installScope: 'user',
    install: { type: 'zip', template: 'zip-into-version-dir', params: { stripComponents: '1' } },
    activate: { pathEntries: ['{currentDir}\\bin'] },
    verify: { cmd: '{installDir}\\bin\\cmake.exe', args: ['--version'], expectRegex: 'cmake version \\d+' },
    notes: {
      'zh-CN': 'cmake.org 官方目录里有 .sha256 文件，直接取，不下载整个压缩包。',
      'en-US': 'cmake.org publishes .sha256 files next to each archive, so no full download is needed.'
    },
    versions: [
      {
        want: 'latest',
        channel: 'stable',
        recommended: true,
        url: (v) => {
          const minor = v.split('.').slice(0, 2).join('.')
          return `https://cmake.org/files/v${minor}/cmake-${v}-windows-x86_64.zip`
        },
        discover: async () => {
          const index = await fetchText('https://cmake.org/files/')
          const dirs = [...index.matchAll(/href="(v3\.\d+)\/"/g)].map((match) => match[1].slice(1))
          const latestDir = dirs.sort(compareVersionsDesc)[0]
          if (!latestDir) throw new Error('cmake 目录列表里找不到 v3.x')
          const listing = await fetchText(`https://cmake.org/files/v${latestDir}/`)
          const zips = [...listing.matchAll(/href="cmake-(3\.\d+\.\d+)-windows-x86_64\.zip"/g)].map(
            (match) => match[1]
          )
          return [...new Set(zips)]
            .sort(compareVersionsDesc)
            .slice(0, 1)
            .map((version) => ({ version }))
        },
        resolve: async (_v, candidates) => {
          // cmake 发布的校验和文件叫 cmake-<ver>-SHA-256.txt（不是 .zip.sha256）
          const zipName = candidates[0].split('/').pop() ?? ''
          const version = zipName.match(/^cmake-(\d+\.\d+\.\d+)-/)?.[1]
          if (!version) throw new Error(`无法从 ${zipName} 解析 cmake 版本号`)
          const minor = version.split('.').slice(0, 2).join('.')
          const text = await fetchText(`https://cmake.org/files/v${minor}/cmake-${version}-SHA-256.txt`)
          const hash = pickHash(text, zipName)
          if (!hash) throw new Error(`cmake 的 SHA-256 清单里没有 ${zipName}`)
          return { sha256: hash, sizeBytes: 0 }
        }
      }
    ]
  },
  {
    id: 'ninja',
    category: 'build',
    tier: 'L1',
    name: { 'zh-CN': 'Ninja', 'en-US': 'Ninja' },
    description: {
      'zh-CN': '小而快的构建系统，CMake 生成器常用搭配。',
      'en-US': 'A small, fast build system, the usual partner of the CMake generator.'
    },
    homepage: 'https://ninja-build.org',
    license: { spdx: 'Apache-2.0', redistributable: true },
    detect: {
      commands: [{ cmd: 'ninja', args: ['--version'], expectRegex: '\\d+\\.\\d+' }]
    },
    installScope: 'user',
    install: {
      type: 'zip',
      template: 'zip-single-file-into-version-dir',
      params: { fileName: 'ninja.exe' }
    },
    activate: { pathEntries: ['{currentDir}'] },
    verify: { cmd: '{installDir}\\ninja.exe', args: ['--version'], expectRegex: '\\d+\\.\\d+' },
    notes: {
      'zh-CN': '官方 release 里只有一个 ninja.exe，用单文件模板只保留它。GitHub 不提供校验和，本地计算。',
      'en-US': 'The official release is a zip containing a single ninja.exe. GitHub publishes no checksum, so it is computed locally.'
    },
    versions: [
      {
        want: 'latest',
        channel: 'stable',
        recommended: true,
        url: (v) => `https://github.com/ninja-build/ninja/releases/download/v${v}/ninja-win.zip`,
        discover: async () => [{ version: (await githubLatestTag('ninja-build/ninja')).replace(/^v/, '') }],
        resolve: async (_v, candidates) => downloadAndHash(candidates)
      }
    ]
  },

  /* ---------------- 常用工具 ---------------- */
  {
    id: 'git',
    category: 'tool',
    tier: 'L1',
    name: { 'zh-CN': 'Git', 'en-US': 'Git' },
    description: {
      'zh-CN': '分布式版本控制，含 Git Bash 与 Git LFS（PortableGit 自解压版）。',
      'en-US': 'Distributed version control with Git Bash and Git LFS (PortableGit self-extracting build).'
    },
    homepage: 'https://git-scm.com',
    license: { spdx: 'GPL-2.0-only', redistributable: true },
    detect: {
      commands: [{ cmd: 'git', args: ['--version'], expectRegex: 'git version \\d+' }],
      files: ['%ProgramFiles%\\Git\\cmd\\git.exe'],
      registry: [
        {
          hive: 'HKLM',
          view: '64',
          path: 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
          match: { DisplayName: '^Git' },
          versionFrom: 'DisplayVersion'
        }
      ]
    },
    installScope: 'user',
    install: { type: 'exe-7zsfx', template: 'exe-7zsfx-extract' },
    activate: {
      pathEntries: ['{currentDir}\\cmd', '{currentDir}\\mingw64\\bin', '{currentDir}\\usr\\bin']
    },
    verify: { cmd: '{installDir}\\cmd\\git.exe', args: ['--version'], expectRegex: 'git version \\d+' },
    notes: {
      'zh-CN':
        '用 PortableGit 自解压包而不是安装器：它是 7-Zip 自解压格式，-o 指定目录即可，不写注册表、不需要管理员、不覆盖系统里已有的 Git。',
      'en-US':
        'Uses the PortableGit self-extracting archive instead of the installer: 7-Zip SFX with -o writes to a directory, touches no registry, needs no admin and never clobbers an existing Git.'
    },
    versions: [
      {
        want: 'latest',
        channel: 'stable',
        recommended: true,
        url: (v) => `https://github.com/git-for-windows/git/releases/download/v${v}.windows.1/PortableGit-${v}-64-bit.7z.exe`,
        mirrors: (v) => [
          {
            name: 'huaweicloud',
            url: `https://mirrors.huaweicloud.com/git-for-windows/v${v}.windows.1/PortableGit-${v}-64-bit.7z.exe`
          }
        ],
        discover: async () => {
          // tag 形如 v2.56.0.windows.1 → 版本号 2.56.0
          const tag = await githubLatestTag('git-for-windows/git')
          const version = tag.replace(/^v/, '').replace(/\.windows\.\d+$/, '')
          if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`无法从 tag ${tag} 解析 Git 版本号`)
          return [{ version }]
        },
        resolve: async (_v, candidates) => downloadAndHash(candidates)
      }
    ]
  },
  {
    id: 'pnpm',
    category: 'tool',
    tier: 'L1',
    name: { 'zh-CN': 'pnpm', 'en-US': 'pnpm' },
    description: {
      'zh-CN': '磁盘占用小、安装速度快的 Node 包管理器（独立二进制，不依赖 npm）。',
      'en-US': 'Fast, disk-efficient Node package manager shipped as a standalone binary.'
    },
    homepage: 'https://pnpm.io',
    license: { spdx: 'MIT', redistributable: true },
    detect: {
      commands: [{ cmd: 'pnpm', args: ['--version'], expectRegex: '^\\d+\\.\\d+' }]
    },
    installScope: 'user',
    install: {
      type: 'zip',
      template: 'zip-single-file-into-version-dir',
      params: { fileName: 'pnpm.exe' }
    },
    activate: { pathEntries: ['{currentDir}'] },
    verify: { cmd: '{installDir}\\pnpm.exe', args: ['--version'], expectRegex: '\\d+\\.\\d+' },
    notes: {
      'zh-CN':
        '用官方独立二进制而不是 npm i -g pnpm：独立二进制不依赖 Node，也就不会出现"还没装 Node 就装不了 pnpm"的死锁。',
      'en-US':
        'Uses the standalone binary instead of npm i -g pnpm: no Node dependency, so there is no chicken-and-egg problem.'
    },
    versions: [
      {
        want: 'latest',
        channel: 'stable',
        recommended: true,
        url: (v) => `https://github.com/pnpm/pnpm/releases/download/v${v}/pnpm-win32-x64.zip`,
        mirrors: (v) => [
          {
            name: 'ghproxy',
            url: `https://ghfast.top/https://github.com/pnpm/pnpm/releases/download/v${v}/pnpm-win32-x64.zip`
          }
        ],
        discover: async () => [{ version: (await githubLatestTag('pnpm/pnpm')).replace(/^v/, '') }],
        resolve: async (_v, candidates) => downloadAndHash(candidates)
      }
    ]
  },
  {
    id: 'deno',
    category: 'runtime',
    tier: 'L1',
    name: { 'zh-CN': 'Deno', 'en-US': 'Deno' },
    description: {
      'zh-CN': '安全的 TypeScript/JavaScript 运行时，单文件可执行程序。',
      'en-US': 'A secure TypeScript/JavaScript runtime shipped as a single executable.'
    },
    homepage: 'https://deno.com',
    license: { spdx: 'MIT', redistributable: true },
    detect: {
      commands: [{ cmd: 'deno', args: ['--version'], expectRegex: 'deno \\d+\\.\\d+' }]
    },
    installScope: 'user',
    install: { type: 'zip', template: 'zip-into-version-dir', params: { stripComponents: '0' } },
    activate: { pathEntries: ['{currentDir}'] },
    verify: { cmd: '{installDir}\\deno.exe', args: ['--version'], expectRegex: 'deno \\d+\\.\\d+' },
    notes: {
      'zh-CN': 'Deno 官方发布 .sha256sum 文件，直接取。',
      'en-US': 'Deno publishes .sha256sum files, used directly.'
    },
    versions: [
      {
        want: 'latest',
        channel: 'stable',
        recommended: true,
        url: (v) => `https://github.com/denoland/deno/releases/download/v${v}/deno-x86_64-pc-windows-msvc.zip`,
        mirrors: (v) => [
          { name: 'npmmirror', url: `https://registry.npmmirror.com/-/binary/deno/v${v}/deno-x86_64-pc-windows-msvc.zip` }
        ],
        discover: async () => [{ version: (await githubLatestTag('denoland/deno')).replace(/^v/, '') }],
        // GitHub release 资产在国内经常直接连不上，因此从 npmmirror 下载后本地算哈希
        resolve: async (_v, candidates) => downloadAndHash(candidates)
      }
    ]
  },
  {
    id: 'bun',
    category: 'runtime',
    tier: 'L1',
    name: { 'zh-CN': 'Bun', 'en-US': 'Bun' },
    description: {
      'zh-CN': '集运行时、包管理器、打包器与测试器于一体的 JavaScript 工具链。',
      'en-US': 'An all-in-one JavaScript runtime, package manager, bundler and test runner.'
    },
    homepage: 'https://bun.sh',
    license: { spdx: 'MIT', redistributable: true },
    detect: {
      commands: [{ cmd: 'bun', args: ['--version'], expectRegex: '^\\d+\\.\\d+' }]
    },
    installScope: 'user',
    install: { type: 'zip', template: 'zip-into-version-dir', params: { stripComponents: '0' } },
    activate: { pathEntries: ['{currentDir}'] },
    verify: { cmd: '{installDir}\\bun.exe', args: ['--version'], expectRegex: '\\d+\\.\\d+' },
    notes: {
      'zh-CN': '官方 release 附带 SHASUMS256.txt，直接取。',
      'en-US': 'The official release ships a SHASUMS256.txt, used directly.'
    },
    versions: [
      {
        want: 'latest',
        channel: 'stable',
        recommended: true,
        url: (v) => `https://github.com/oven-sh/bun/releases/download/bun-v${v}/bun-windows-x64.zip`,
        mirrors: (v) => [
          { name: 'npmmirror', url: `https://registry.npmmirror.com/-/binary/bun/bun-v${v}/bun-windows-x64.zip` }
        ],
        discover: async () => [{ version: (await githubLatestTag('oven-sh/bun')).replace(/^bun-v/, '') }],
        resolve: async (_v, candidates) => downloadAndHash(candidates)
      }
    ]
  },
  {
    id: 'sqlite',
    category: 'database',
    tier: 'L1',
    name: { 'zh-CN': 'SQLite', 'en-US': 'SQLite' },
    description: {
      'zh-CN': '单文件嵌入式数据库，附 sqlite3 命令行工具。',
      'en-US': 'A single-file embedded database with the sqlite3 command line tool.'
    },
    homepage: 'https://sqlite.org',
    license: { spdx: 'blessing', redistributable: true },
    detect: {
      commands: [{ cmd: 'sqlite3', args: ['--version'], expectRegex: '\\d+\\.\\d+' }]
    },
    installScope: 'user',
    install: { type: 'zip', template: 'zip-into-version-dir', params: { stripComponents: '0' } },
    activate: { pathEntries: ['{currentDir}'] },
    verify: { cmd: '{installDir}\\sqlite3.exe', args: ['--version'], expectRegex: '\\d+\\.\\d+' },
    notes: {
      'zh-CN': 'sqlite.org 只提供年份目录与版本号，没有校验和文件，因此本地下载后计算。',
      'en-US': 'sqlite.org provides no checksum file, so the SHA-256 is computed locally.'
    },
    versions: [
      {
        want: 'latest',
        channel: 'stable',
        recommended: true,
        // sqlite.org 的下载页里内嵌了 PRODUCT,<版本>,<路径>,<体积>,<sha256> 数据块，
        // 直接读它就能拿到校验和，不必慢速下载整个包（实测 sqlite.org 只有 8 KB/s）
        url: () => '',
        discover: async () => {
          const html = await fetchText('https://sqlite.org/download.html')
          const match = html.match(
            /PRODUCT,(\d+\.\d+\.\d+),([0-9]{4}\/sqlite-tools-win-x64-\d+\.zip),(\d+),([a-f0-9]{64})/i
          )
          if (!match) throw new Error('sqlite 下载页里找不到 win-x64 工具包的 PRODUCT 行')
          return [{ version: match[1], url: `https://sqlite.org/${match[2]}` }]
        },
        resolve: async (_v, candidates) => {
          const name = candidates[0].split('/').pop() ?? ''
          const html = await fetchText('https://sqlite.org/download.html')
          // 注意：模板字面量里的 \d 会被当成普通字符 d，所以这里用 [0-9] 并且用字符串拼接
          const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          const pattern = new RegExp(
            `PRODUCT,[0-9.]+,[^,]*${escaped},([0-9]+),([a-f0-9]{64})`,
            'i'
          )
          const match = html.match(pattern)
          if (!match) throw new Error(`sqlite 下载页里没有 ${name} 的校验和`)
          return { sha256: match[2].toLowerCase(), sizeBytes: Number(match[1]) }
        }
      }
    ]
  },
  {
    id: 'sevenzip',
    category: 'tool',
    tier: 'L1',
    name: { 'zh-CN': '7-Zip', 'en-US': '7-Zip' },
    description: {
      'zh-CN': '压缩/解压工具，命令行 7z.exe 常被构建脚本依赖。',
      'en-US': 'Archive tool; its 7z.exe CLI is commonly required by build scripts.'
    },
    homepage: 'https://www.7-zip.org',
    license: { spdx: 'LGPL-2.1-or-later', redistributable: true },
    detect: {
      commands: [{ cmd: '7z', args: ['i'], expectRegex: '7-Zip' }],
      files: ['%ProgramFiles%\\7-Zip\\7z.exe'],
      registry: [
        {
          hive: 'HKLM',
          view: '64',
          path: 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
          match: { DisplayName: '^7-Zip' },
          versionFrom: 'DisplayVersion'
        }
      ]
    },
    installScope: 'machine',
    install: { type: 'msi', template: 'msi-install', params: { dirProperty: 'INSTALLDIR' } },
    activate: { pathEntries: ['{currentDir}'] },
    verify: { cmd: '{installDir}\\7z.exe', args: ['i'], expectRegex: '7-Zip' },
    notes: {
      'zh-CN':
        '这是清单里唯一需要管理员的项目：7-Zip 的 MSI 是 per-machine 安装（要写 HKLM 卸载项），所以会弹一次 UAC。仍然装进版本目录，卸载走 devkit 自己的删除逻辑。',
      'en-US':
        'The only manifest needing admin: the 7-Zip MSI is per-machine (it writes an HKLM uninstall entry), so one UAC prompt appears. It still installs into the version directory.'
    },
    versions: [
      {
        want: 'latest',
        channel: 'stable',
        recommended: true,
        // 7-Zip 的版本号是 26.04 这种两位小数，直接由文件名反推（不能经过 Number，否则 04 会变成 4）
        url: (v) => {
          const [major, minor = '00'] = v.split('.')
          return `https://www.7-zip.org/a/7z${major}${minor.padStart(2, '0')}-x64.msi`
        },
        discover: async () => {
          const html = await fetchText('https://www.7-zip.org/download.html')
          const match = html.match(/href="[^"]*7z(\d{2})(\d{2})-x64\.msi"/)
          if (!match) throw new Error('7-Zip 下载页里找不到 x64 MSI')
          return [{ version: `${Number(match[1])}.${match[2]}` }]
        },
        resolve: async (_v, candidates) => downloadAndHash(candidates)
      }
    ]
  },
  {
    id: 'vscode',
    category: 'editor',
    tier: 'L2',
    name: { 'zh-CN': 'Visual Studio Code', 'en-US': 'Visual Studio Code' },
    description: {
      'zh-CN': '轻量级代码编辑器，用户级安装（不需要管理员）。',
      'en-US': 'Lightweight code editor, installed per-user (no admin required).'
    },
    homepage: 'https://code.visualstudio.com',
    license: { spdx: 'MIT', redistributable: false },
    detect: {
      commands: [{ cmd: 'code', args: ['--version'], expectRegex: '\\d+\\.\\d+' }],
      files: ['%LOCALAPPDATA%\\Programs\\Microsoft VS Code\\Code.exe']
    },
    installScope: 'user',
    install: {
      type: 'exe-inno',
      template: 'exe-inno-silent',
      params: { extraArgs: '-MERGETASKS=!runcode' }
    },
    activate: { pathEntries: ['{currentDir}\\bin'] },
    verify: { cmd: '{installDir}\\Code.exe', args: ['--version'], expectRegex: '\\d+\\.\\d+' },
    notes: {
      'zh-CN':
        '按 L2 处理：可以自动下载安装，但发行物走 Microsoft 产品许可，不再分发，因此不进离线包。用 User 安装器，无需管理员。',
      'en-US':
        'Treated as L2: auto-download and install are fine, but the shipped binaries are under a Microsoft product licence, so they are never redistributed and never included in offline packs.'
    },
    versions: [
      {
        want: 'latest',
        channel: 'stable',
        recommended: true,
        url: () =>
          'https://update.code.visualstudio.com/latest/win32-x64-user/stable',
        discover: async () => {
          const info = await fetchJson<{ productVersion: string }>(
            'https://update.code.visualstudio.com/api/update/win32-x64-user/stable/latest'
          )
          return [{ version: info.productVersion }]
        },
        resolve: async () => {
          const info = await fetchJson<{ productVersion: string; sha256hash: string }>(
            'https://update.code.visualstudio.com/api/update/win32-x64-user/stable/latest'
          )
          return { sha256: info.sha256hash.toLowerCase(), sizeBytes: 0 }
        }
      }
    ]
  }
]

/* ------------------------------------------------------------------ */
/* 生成                                                                */
/* ------------------------------------------------------------------ */

function compareVersionsDesc(a: string, b: string): number {
  const left = a.split('.').map(Number)
  const right = b.split('.').map(Number)
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const l = left[i] ?? 0
    const r = right[i] ?? 0
    if (l !== r) return r - l
  }
  return 0
}

/** Adoptium 的版本需要走它自己的 API（ZIP + sha256 都在响应里） */
async function resolveTemurin(release: string): Promise<ResolvedVersion> {
  const url = `https://api.adoptium.net/v3/assets/latest/${release}/hotspot?architecture=x64&image_type=jdk&os=windows`
  const data = await fetchJson<
    {
      release_name?: string
      binary?: {
        package?: { link?: string; checksum?: string; size?: number; name?: string }
        updated_at?: string
      }
    }[]
  >(url)

  const entry = Array.isArray(data) ? data[0] : undefined
  const pkg = entry?.binary?.package
  if (!entry || !pkg?.link || !pkg.checksum) {
    throw new Error(
      `Adoptium API 没有返回 JDK ${release} 的 ZIP（响应条目数：${Array.isArray(data) ? data.length : 'n/a'}）`
    )
  }

  // Adoptium 的响应里没有 version_data，版本号在 release_name（如 jdk-21.0.12.1+1）里
  const version =
    entry.release_name?.replace(/^jdk-/, '').replace(/\+.*$/, '') ??
    pkg.name?.match(/_(\d+\.\d+\.\d+(?:\.\d+)?)_/)?.[1] ??
    release

  return {
    version,
    channel: 'lts',
    releaseDate: entry.binary?.updated_at?.slice(0, 10),
    url: pkg.link,
    sha256: pkg.checksum.toLowerCase(),
    sizeBytes: pkg.size ?? 0
  }
}

async function buildTool(spec: ToolSpec): Promise<Record<string, unknown>> {
  const versions: Record<string, unknown>[] = []

  for (const source of spec.versions) {
    let resolved: ResolvedVersion

    if (spec.id === 'jdk-temurin') {
      resolved = await resolveTemurin(source.want)
      resolved.recommended = source.recommended
    } else {
      const discovered =
        source.want === 'latest' && source.discover ? (await source.discover())[0] : undefined
      const version = discovered?.version ?? source.want
      const url = discovered?.url ?? source.url(version)
      if (!url) throw new Error(`${spec.id} 的下载地址为空（discover 没有给出 url，url() 也返回了空）`)
      const mirrorList = source.mirrors?.(version, url) ?? []
      const hashed = await source.resolve(version, [url, ...mirrorList.map((item) => item.url)])
      resolved = {
        version,
        channel: source.channel,
        recommended: source.recommended,
        url,
        sha256: hashed.sha256,
        sizeBytes: hashed.sizeBytes,
        mirrors: source.mirrors?.(version, url)
      }
    }

    versions.push({
      version: resolved.version,
      channel: resolved.channel,
      ...(resolved.recommended ? { recommended: true } : {}),
      arch: 'x64',
      ...(resolved.releaseDate ? { releaseDate: resolved.releaseDate } : {}),
      ...(resolved.sizeBytes ? { sizeBytes: resolved.sizeBytes } : {}),
      installScope: spec.installScope,
      source: { url: resolved.url, sha256: resolved.sha256 },
      ...(resolved.mirrors && resolved.mirrors.length > 0 ? { mirrors: resolved.mirrors } : {}),
      install: spec.install,
      uninstall: spec.installScope === 'machine' ? { type: 'registry' } : { type: 'custom' },
      ...(spec.activate ? { activate: spec.activate } : {}),
      ...(spec.verify ? { verify: spec.verify } : {})
    })
  }

  const manifest: Record<string, unknown> = {
    id: spec.id,
    category: spec.category,
    tier: spec.tier,
    status: 'ready',
    provider: 'direct',
    name: spec.name,
    description: spec.description,
    homepage: spec.homepage,
    license: spec.license,
    detect: spec.detect,
    versions
  }
  if (spec.notes) manifest.notes = spec.notes
  return manifest
}

async function main(): Promise<void> {
  const targets = ONLY.length > 0 ? SPECS.filter((spec) => ONLY.includes(spec.id)) : SPECS
  if (targets.length === 0) {
    console.error(`没有匹配的工具。可用：${SPECS.map((spec) => spec.id).join(', ')}`)
    process.exit(1)
  }

  const failures: string[] = []

  for (const spec of targets) {
    try {
      const manifest = await buildTool(spec)
      const versions = manifest.versions as { version: string; source: { sha256: string } }[]

      if (WRITE) {
        mkdirSync(MANIFEST_DIR, { recursive: true })
        writeFileSync(
          join(MANIFEST_DIR, `${spec.id}.json`),
          `${JSON.stringify(manifest, null, 2)}\n`,
          'utf8'
        )
      }

      console.log(
        `✔ ${spec.id.padEnd(14)} ${versions
          .map((v) => `${v.version}(${v.source.sha256.slice(0, 8)}…)`)
          .join(' ')}`
      )
    } catch (error) {
      failures.push(`${spec.id}: ${(error as Error).message}`)
      console.error(`✘ ${spec.id.padEnd(14)} ${(error as Error).message}`)
    }
  }

  if (failures.length > 0) {
    console.error(`\n有 ${failures.length} 个工具刷新失败：`)
    for (const failure of failures) console.error(`  · ${failure}`)
    process.exit(1)
  }

  console.log(`\n${WRITE ? '已写入' : '已检查'} ${targets.length} 个清单。`)
}

void main()
