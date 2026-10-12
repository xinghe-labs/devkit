import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { MirrorApplyResult, MirrorSetting, MirrorTarget } from '@shared/types'
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

  const go = readGoProxy()

  return {
    npm: npmMatch ? npmMatch[1].trim() : null,
    pip: pipMatch ? pipMatch[1].trim() : null,
    go,
    maven: mavenMatch ? mavenMatch[1].trim() : null,
    gradle: gradleMatch ? gradleMatch[1].trim() : null,
    cargo: cargoMatch ? cargoMatch[1].trim() : null
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

  const find = (target: MirrorTarget): MirrorSetting | undefined =>
    settings.find((item) => item.target === target)

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

    logger.info('mirrors', `镜像配置已应用：${changed.join('；') || '无变化'}`)
    return { ok: true, changed, backupFiles, error: null }
  } catch (error) {
    const message = (error as Error).message
    logger.error('mirrors', `应用镜像配置失败：${message}`)
    return { ok: false, changed, backupFiles, error: message }
  }
}
