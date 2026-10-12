import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { MIRROR_URL_PATTERN, type MirrorApplyResult, type MirrorSetting, type MirrorTarget } from '@shared/types'
import { ensureDir } from '../../utils/fs'
import { logger } from '../report/logger'

/**
 * 镜像源配置（FR-5）。
 *
 * 刻意不走 `npm config set` / `pip config set` / `go env -w`：
 *  · 这些命令要求对应工具**已经装好且在 PATH 上**，而 devkit 的典型场景恰恰是「什么都还没装」
 *  · 直接写配置文件 / 环境变量是幂等的，失败可定位，也不需要拉起子进程
 *
 * 覆盖 6 个目标，各自的落点与写法都不一样：
 *
 * | 目标   | 落点                                  | 写法                       |
 * | ------ | ------------------------------------- | -------------------------- |
 * | npm    | %USERPROFILE%\.npmrc                  | 行级替换 registry=         |
 * | pip    | %APPDATA%\pip\pip.ini                 | [global] index-url         |
 * | go     | 用户环境变量 GOPROXY                  | 直接写变量                 |
 * | maven  | %USERPROFILE%\.m2\settings.xml        | 在 <mirrors> 里插一条      |
 * | gradle | %USERPROFILE%\.gradle\init.gradle     | 带标记的代码块             |
 * | cargo  | %USERPROFILE%\.cargo\config.toml      | 带标记的代码块             |
 *
 * 所有写操作都：
 *  1. 先备份原文件（`*.devkit-backup`，只在第一次备份时写）
 *  2. 只动自己的那一块（gradle/cargo 用 `devkit-begin` / `devkit-end` 标记，可幂等替换与移除）
 *  3. 保留文件里其它内容（用户可能还有 token、proxy、私服配置）
 */

/**
 * 写进任何配置文件之前都再校验一次地址。
 *
 * 纵深防御：IPC 层已经校验过，但 applyMirrors 也可能被别的调用方使用，
 * 而这里的后果是把不可信字符串拼进 gradle/cargo 的可执行配置文件里。
 */
function assertSafeUrl(url: string): string {
  if (!MIRROR_URL_PATTERN.test(url)) {
    throw new Error(
      `镜像地址不合法：${JSON.stringify(url.slice(0, 80))}。只允许 https 与 URL 安全字符集`
    )
  }
  return url
}

const BEGIN_MARK = '# devkit-begin'
const END_MARK = '# devkit-end'

export function npmrcPath(): string {
  return join(homedir(), '.npmrc')
}

export function pipIniPath(): string {
  const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
  return join(appData, 'pip', 'pip.ini')
}

export function mavenSettingsPath(): string {
  return join(homedir(), '.m2', 'settings.xml')
}

export function gradleInitPath(): string {
  return join(homedir(), '.gradle', 'init.gradle')
}

export function cargoConfigPath(): string {
  return join(homedir(), '.cargo', 'config.toml')
}

export function condarcPath(): string {
  return join(homedir(), '.condarc')
}

export function nugetConfigPath(): string {
  const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
  return join(appData, 'NuGet', 'NuGet.Config')
}

export function dockerDaemonPath(): string {
  return join(homedir(), '.docker', 'daemon.json')
}

/* ------------------------------------------------------------------ */
/* 通用文本工具                                                        */
/* ------------------------------------------------------------------ */

/** 把 "registry=..." 这一行替换掉；没有就追加。其它行原样保留。 */
export function upsertIniValue(content: string, key: string, value: string): string {
  const lines = content.split(/\r?\n/)
  const pattern = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=`, 'i')
  let replaced = false

  const next = lines.map((line) => {
    if (!replaced && pattern.test(line)) {
      replaced = true
      return `${key}=${value}`
    }
    return line
  })

  if (!replaced) {
    while (next.length > 0 && next[next.length - 1].trim() === '') next.pop()
    next.push(`${key}=${value}`)
    next.push('')
  }

  return next.join('\n')
}

/** 在 INI 的某个 section 下写入 key；section 不存在就创建 */
export function upsertIniSectionValue(
  content: string,
  section: string,
  key: string,
  value: string
): string {
  const lines = content.split(/\r?\n/)
  const header = `[${section}]`
  const headerIndex = lines.findIndex((line) => line.trim().toLowerCase() === header.toLowerCase())

  if (headerIndex === -1) {
    const base = content.trim() === '' ? [] : content.trimEnd().split(/\r?\n/)
    base.push(header, `${key} = ${value}`, '')
    return base.join('\n')
  }

  let end = lines.length
  for (let i = headerIndex + 1; i < lines.length; i += 1) {
    if (/^\s*\[/.test(lines[i])) {
      end = i
      break
    }
  }

  const keyPattern = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=`, 'i')
  for (let i = headerIndex + 1; i < end; i += 1) {
    if (keyPattern.test(lines[i])) {
      lines[i] = `${key} = ${value}`
      return lines.join('\n')
    }
  }

  lines.splice(headerIndex + 1, 0, `${key} = ${value}`)
  return lines.join('\n')
}

/** 用标记块替换/插入内容；block 为 null 表示只移除已有块 */
export function upsertMarkedBlock(content: string, block: string | null): string {
  const lines = content.split(/\r?\n/)
  const beginIndex = lines.findIndex((line) => line.trim() === BEGIN_MARK)
  const endIndex = lines.findIndex((line) => line.trim() === END_MARK)

  if (beginIndex !== -1 && endIndex > beginIndex) {
    const replacement = block === null ? [] : [BEGIN_MARK, ...block.split('\n'), END_MARK]
    const next = [...lines.slice(0, beginIndex), ...replacement, ...lines.slice(endIndex + 1)]
    return next.join('\n').replace(/\n{3,}/g, '\n\n')
  }

  if (block === null) return content

  const base = content.trim() === '' ? [] : content.trimEnd().split(/\r?\n/)
  base.push('', BEGIN_MARK, ...block.split('\n'), END_MARK, '')
  return base.join('\n')
}

/** 在 XML 里插入/替换 devkit 的 maven mirror 条目 */
export function upsertMavenMirror(content: string, url: string | null): string {
  const mirrorId = 'devkit-central'
  const entry = [
    '    <mirror>',
    `      <id>${mirrorId}</id>`,
    '      <name>devkit mirror</name>',
    `      <url>${url ?? ''}</url>`,
    '      <mirrorOf>central</mirrorOf>',
    '    </mirror>'
  ].join('\n')

  const existing = new RegExp(
    `\\s*<mirror>\\s*<id>${mirrorId}</id>[\\s\\S]*?</mirror>\\s*`,
    'i'
  )

  if (url === null) {
    // 移除：如果去掉后 <mirrors> 里空了，就一并收掉那个空标签
    return content
      .replace(existing, '\n')
      .replace(/<mirrors>\s*<\/mirrors>\s*/i, '')
      .replace(/\n{3,}/g, '\n\n')
  }

  if (existing.test(content)) return content.replace(existing, `\n${entry}\n`)

  if (/<mirrors\s*\/>/i.test(content)) {
    return content.replace(/<mirrors\s*\/>/i, `<mirrors>\n${entry}\n  </mirrors>`)
  }
  if (/<mirrors>/i.test(content)) {
    return content.replace(/<mirrors>/i, `<mirrors>\n${entry}`)
  }
  if (/<\/settings>/i.test(content)) {
    return content.replace(/<\/settings>/i, `  <mirrors>\n${entry}\n  </mirrors>\n</settings>`)
  }

  throw new Error(
    `${mavenSettingsPath()} 里既没有 <mirrors> 也没有 </settings>，无法安全插入镜像配置。请手工添加或先备份删除该文件。`
  )
}

/**
 * 生成 conda 的 .condarc 内容。
 *
 * 为什么只写自己那一块并且**发现用户已定义 channels 就拒绝**：
 * YAML 里同名顶层键重复是无效的，硬追加会直接把用户的 .condarc 写坏。
 * 宁可让用户手工合并，也不能毁掉他的配置。
 */
export function condaBlock(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  return [
    '# 由 devkit 写入（镜像源配置，FR-5）。删掉 devkit-begin/devkit-end 之间的内容即可还原。',
    'channels:',
    '  - defaults',
    'default_channels:',
    `  - ${trimmed}/pkgs/main`,
    `  - ${trimmed}/pkgs/r`,
    `  - ${trimmed}/pkgs/msys2`,
    'show_channel_urls: true'
  ].join('\n')
}

/** 用户已有 .condarc 时，检查里面是否已经定义了我们会写的顶层键 */
export function condarcHasConflicts(content: string): boolean {
  // 先把自己写的那一块摘掉，再看剩下部分有没有同名顶层键 —— 否则第二次应用会被自己拦住
  const begin = content.indexOf(BEGIN_MARK)
  const end = content.indexOf(END_MARK)
  const userPart =
    begin !== -1 && end > begin ? content.slice(0, begin) + content.slice(end + END_MARK.length) : content

  return /^\s*(channels|default_channels)\s*:/im.test(userPart)
}

/** 在 NuGet.Config 里插入/移除 devkit 的包源 */
export function upsertNugetSource(content: string, url: string | null): string {
  const key = 'devkit'
  const entry = `    <add key="${key}" value="${url ?? ''}" protocolVersion="3" />`
  const existing = new RegExp(`\\s*<add\\s+key="${key}"[^>]*/>\\s*`, 'i')

  if (url === null) {
    return content
      .replace(existing, '\n')
      .replace(/<packageSources>\s*<\/packageSources>\s*/i, '')
      .replace(/\n{3,}/g, '\n\n')
  }

  if (existing.test(content)) return content.replace(existing, `\n${entry}\n`)

  if (/<packageSources\s*\/>/i.test(content)) {
    return content.replace(/<packageSources\s*\/>/i, `<packageSources>\n${entry}\n  </packageSources>`)
  }
  if (/<packageSources>/i.test(content)) {
    return content.replace(/<packageSources>/i, `<packageSources>\n${entry}`)
  }
  if (/<\/configuration>/i.test(content)) {
    return content.replace(/<\/configuration>/i, `  <packageSources>\n${entry}\n  </packageSources>\n</configuration>`)
  }

  throw new Error(
    `${nugetConfigPath()} 里既没有 <packageSources> 也没有 </configuration>，无法安全插入包源。请手工添加或先备份删除该文件。`
  )
}

export function minimalNugetConfig(url: string): string {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<configuration>',
    '  <packageSources>',
    `    <add key="devkit" value="${url}" protocolVersion="3" />`,
    '  </packageSources>',
    '</configuration>',
    ''
  ].join('\n')
}

/** 在 Docker daemon.json 里设置/移除 registry-mirrors，保留其它键 */
export function upsertDockerRegistryMirrors(content: string, url: string | null): string {
  let parsed: Record<string, unknown> = {}
  if (content.trim() !== '') {
    try {
      parsed = JSON.parse(content) as Record<string, unknown>
    } catch (error) {
      throw new Error(`${dockerDaemonPath()} 不是合法 JSON，已拒绝修改：${(error as Error).message}`, {
        cause: error
      })
    }
  }

  if (url === null) delete parsed['registry-mirrors']
  else parsed['registry-mirrors'] = [url]

  return `${JSON.stringify(parsed, null, 2)}\n`
}

/** 生成一个最小可用的 settings.xml（文件不存在时用） */
export function minimalMavenSettings(url: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<settings xmlns="http://maven.apache.org/SETTINGS/1.0.0">',
    '  <mirrors>',
    '    <mirror>',
    '      <id>devkit-central</id>',
    '      <name>devkit mirror</name>',
    `      <url>${url}</url>`,
    '      <mirrorOf>central</mirrorOf>',
    '    </mirror>',
    '  </mirrors>',
    '</settings>',
    ''
  ].join('\n')
}

/* ------------------------------------------------------------------ */
/* 读写                                                                */
/* ------------------------------------------------------------------ */

function readIfExists(file: string): string {
  try {
    return existsSync(file) ? readFileSync(file, 'utf8') : ''
  } catch {
    return ''
  }
}

function backupOnce(file: string): string | null {
  if (!existsSync(file)) return null
  const backup = `${file}.devkit-backup`
  if (existsSync(backup)) return backup
  try {
    writeFileSync(backup, readFileSync(file, 'utf8'), 'utf8')
    return backup
  } catch {
    return null
  }
}

function writeFileEnsured(file: string, content: string): void {
  ensureDir(dirname(file))
  writeFileSync(file, content, 'utf8')
}

/** 写用户环境变量（GOPROXY 这类）；value 为 null 表示删除 */
function writeUserEnvVar(name: string, value: string | null): void {
  // 与 activate/windows.ts 同样的做法：直接写注册表并保持 REG_EXPAND_SZ，
  // 不用 setx（1024 字符截断）。这里用同步的方式是为了让 applyMirrors 保持同步签名。
  const script =
    value === null
      ? `Remove-ItemProperty -Path 'HKCU:\\Environment' -Name '${name}' -ErrorAction SilentlyContinue`
      : `if (-not (Test-Path 'HKCU:\\Environment')) { New-Item -Path 'HKCU:\\Environment' -Force | Out-Null }; ` +
        `Set-ItemProperty -Path 'HKCU:\\Environment' -Name '${name}' -Value ${JSON.stringify(value)} -Type String`

  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64')
    ],
    { windowsHide: true, timeout: 20_000 }
  )
}

/* ------------------------------------------------------------------ */
/* 对外接口                                                            */
/* ------------------------------------------------------------------ */

export interface CurrentMirrors {
  npm: string | null
  pip: string | null
  go: string | null
  maven: string | null
  gradle: string | null
  cargo: string | null
  conda: string | null
  nuget: string | null
  docker: string | null
}

/** 读用户级 GOPROXY（没有则返回 null） */
function readGoProxy(): string | null {
  try {
    const output = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-Command', "[Environment]::GetEnvironmentVariable('GOPROXY','User')"],
      { windowsHide: true, timeout: 15_000, encoding: 'utf8' }
    )
    const value = output.trim()
    return value === '' ? null : value
  } catch {
    return null
  }
}

export function readCurrentMirrors(): CurrentMirrors {
  const npmContent = readIfExists(npmrcPath())
  const npmMatch = npmContent.match(/^\s*registry\s*=\s*(.+)$/im)

  const pipContent = readIfExists(pipIniPath())
  const pipMatch = pipContent.match(/^\s*index-url\s*=\s*(.+)$/im)

  const mavenContent = readIfExists(mavenSettingsPath())
  const mavenMatch = mavenContent.match(/<id>devkit-central<\/id>[\s\S]*?<url>(.*?)<\/url>/i)

  const gradleContent = readIfExists(gradleInitPath())
  const gradleMatch = gradleContent.match(/devkit-begin[\s\S]*?url\s*[=:]?\s*['"]?([^'"\n]+)['"]?[\s\S]*?devkit-end/i)

  const cargoContent = readIfExists(cargoConfigPath())
  const cargoMatch = cargoContent.match(/devkit-begin[\s\S]*?registry\s*=\s*"([^"]+)"[\s\S]*?devkit-end/i)

  const condaContent = readIfExists(condarcPath())
  const condaMatch = condaContent.match(/devkit-begin[\s\S]*?default_channels:\s*\r?\n\s*-\s*(.+?)\/pkgs\/main[\s\S]*?devkit-end/i)

  const nugetContent = readIfExists(nugetConfigPath())
  const nugetMatch = nugetContent.match(/<add\s+key="devkit"\s+value="([^"]+)"/i)

  let docker: string | null = null
  try {
    const dockerContent = readIfExists(dockerDaemonPath())
    if (dockerContent.trim() !== '') {
      const parsed = JSON.parse(dockerContent) as { 'registry-mirrors'?: string[] }
      docker = parsed['registry-mirrors']?.[0] ?? null
    }
  } catch {
    docker = null
  }

  const go = readGoProxy()

  return {
    npm: npmMatch ? npmMatch[1].trim() : null,
    pip: pipMatch ? pipMatch[1].trim() : null,
    go,
    maven: mavenMatch ? mavenMatch[1].trim() : null,
    gradle: gradleMatch ? gradleMatch[1].trim() : null,
    cargo: cargoMatch ? cargoMatch[1].trim() : null,
    conda: condaMatch ? condaMatch[1].trim() : null,
    nuget: nugetMatch ? nugetMatch[1].trim() : null,
    docker
  }
}

function gradleBlock(url: string): string {
  return [
    `// 由 devkit 写入（镜像源配置，FR-5）。删掉 devkit-begin/devkit-end 之间的内容即可还原。`,
    'allprojects {',
    '  buildscript {',
    '    repositories {',
    '      maven {',
    `        url '${url}'`,
    '      }',
    '    }',
    '  }',
    '  repositories {',
    '    maven {',
    `      url '${url}'`,
    '    }',
    '  }',
    '}'
  ].join('\n')
}

function cargoBlock(url: string): string {
  return [
    `# 由 devkit 写入（镜像源配置，FR-5）。删掉 devkit-begin/devkit-end 之间的内容即可还原。`,
    '[source.crates-io]',
    "replace-with = 'devkit-mirror'",
    '',
    "[source.devkit-mirror]",
    `registry = "${url}"`
  ].join('\n')
}

/**
 * 应用镜像设置。enabled=false 的目标会被移除对应配置（回到官方源）。
 * 只改自己写进去的那一块，绝不整文件覆盖。
 */
export function applyMirrors(settings: MirrorSetting[]): MirrorApplyResult {
  const changed: string[] = []
  const backupFiles: string[] = []

  const find = (target: MirrorTarget): MirrorSetting | undefined => {
    const found = settings.find((item) => item.target === target)
    // 只在真的要写入时校验；enabled=false 是"移除"，不需要合法地址
    if (found?.enabled && found.url) assertSafeUrl(found.url)
    return found
  }

  try {
    const npm = find('npm')
    if (npm) {
      const file = npmrcPath()
      const backup = backupOnce(file)
      if (backup) backupFiles.push(backup)
      const content = readIfExists(file)

      if (npm.enabled && npm.url) {
        writeFileEnsured(file, upsertIniValue(content, 'registry', npm.url))
        changed.push(`npm registry → ${npm.url}`)
      } else if (/^\s*registry\s*=/im.test(content)) {
        writeFileEnsured(
          file,
          content
            .split(/\r?\n/)
            .filter((line) => !/^\s*registry\s*=/i.test(line))
            .join('\n')
        )
        changed.push('npm registry → 官方源（已移除自定义 registry）')
      }
    }

    const pip = find('pip')
    if (pip) {
      const file = pipIniPath()
      const backup = backupOnce(file)
      if (backup) backupFiles.push(backup)
      const content = readIfExists(file)

      if (pip.enabled && pip.url) {
        writeFileEnsured(file, upsertIniSectionValue(content, 'global', 'index-url', pip.url))
        changed.push(`pip index-url → ${pip.url}`)
      } else if (/^\s*index-url\s*=/im.test(content)) {
        writeFileEnsured(
          file,
          content
            .split(/\r?\n/)
            .filter((line) => !/^\s*index-url\s*=/i.test(line))
            .join('\n')
        )
        changed.push('pip index-url → 官方源（已移除自定义 index-url）')
      }
    }

    const go = find('go')
    if (go) {
      if (go.enabled && go.url) {
        writeUserEnvVar('GOPROXY', go.url)
        changed.push(`GOPROXY → ${go.url}`)
      } else {
        writeUserEnvVar('GOPROXY', null)
        changed.push('GOPROXY → 已移除（使用官方默认）')
      }
    }

    const maven = find('maven')
    if (maven) {
      const file = mavenSettingsPath()
      const backup = backupOnce(file)
      if (backup) backupFiles.push(backup)
      const content = readIfExists(file)

      if (maven.enabled && maven.url) {
        const next =
          content.trim() === '' ? minimalMavenSettings(maven.url) : upsertMavenMirror(content, maven.url)
        writeFileEnsured(file, next)
        changed.push(`Maven mirror → ${maven.url}`)
      } else if (content !== '') {
        writeFileEnsured(file, upsertMavenMirror(content, null))
        changed.push('Maven mirror → 官方源（已移除 devkit 的 mirror 条目）')
      }
    }

    const gradle = find('gradle')
    if (gradle) {
      const file = gradleInitPath()
      const backup = backupOnce(file)
      if (backup) backupFiles.push(backup)
      const content = readIfExists(file)
      const block = gradle.enabled && gradle.url ? gradleBlock(gradle.url) : null
      const next = upsertMarkedBlock(content, block)

      if (next.trim() !== content.trim()) {
        writeFileEnsured(file, next)
        changed.push(
          block ? `Gradle init.gradle → ${gradle.url}` : 'Gradle init.gradle → 已移除 devkit 的镜像块'
        )
      }
    }

    const cargo = find('cargo')
    if (cargo) {
      const file = cargoConfigPath()
      const backup = backupOnce(file)
      if (backup) backupFiles.push(backup)
      const content = readIfExists(file)
      const block = cargo.enabled && cargo.url ? cargoBlock(cargo.url) : null
      const next = upsertMarkedBlock(content, block)

      if (next.trim() !== content.trim()) {
        writeFileEnsured(file, next)
        changed.push(
          block ? `cargo config.toml → ${cargo.url}` : 'cargo config.toml → 已移除 devkit 的镜像块'
        )
      }
    }

    const conda = find('conda')
    if (conda) {
      const file = condarcPath()
      const backup = backupOnce(file)
      if (backup) backupFiles.push(backup)
      const content = readIfExists(file)

      if (conda.enabled && conda.url) {
        if (content.trim() !== '' && condarcHasConflicts(content)) {
          throw new Error(
            `${file} 里已经定义了 channels / default_channels。YAML 不允许同名顶层键重复，` +
              '为避免写坏你的配置，devkit 没有自动修改。请手工把镜像地址合并进去，' +
              '或先备份删除该文件后重试。'
          )
        }
        writeFileEnsured(file, upsertMarkedBlock(content, condaBlock(conda.url)))
        changed.push(`conda .condarc → ${conda.url}`)
      } else if (content.trim() !== '') {
        writeFileEnsured(file, upsertMarkedBlock(content, null))
        changed.push('conda .condarc → 已移除 devkit 的镜像块')
      }
    }

    const nuget = find('nuget')
    if (nuget) {
      const file = nugetConfigPath()
      const backup = backupOnce(file)
      if (backup) backupFiles.push(backup)
      const content = readIfExists(file)

      if (nuget.enabled && nuget.url) {
        const next =
          content.trim() === '' ? minimalNugetConfig(nuget.url) : upsertNugetSource(content, nuget.url)
        writeFileEnsured(file, next)
        changed.push(`NuGet 包源 → ${nuget.url}`)
      } else if (content.trim() !== '') {
        writeFileEnsured(file, upsertNugetSource(content, null))
        changed.push('NuGet 包源 → 已移除 devkit 的源')
      }
    }

    const docker = find('docker')
    if (docker) {
      const file = dockerDaemonPath()
      const backup = backupOnce(file)
      if (backup) backupFiles.push(backup)
      const content = readIfExists(file)

      if (docker.enabled && docker.url) {
        writeFileEnsured(file, upsertDockerRegistryMirrors(content, docker.url))
        changed.push(`Docker registry-mirrors → ${docker.url}（需要重启 Docker Desktop）`)
      } else if (content.trim() !== '') {
        writeFileEnsured(file, upsertDockerRegistryMirrors(content, null))
        changed.push('Docker registry-mirrors → 已移除')
      }
    }

    logger.info('mirrors', `镜像配置已应用：${changed.join('；') || '无变化'}`)
    return { ok: true, changed, backupFiles, error: null }
  } catch (error) {
    const message = (error as Error).message
    logger.error('mirrors', `应用镜像配置失败：${message}`)
    return { ok: false, changed, backupFiles, error: message }
  }
}
