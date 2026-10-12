import type { InstallSpec, ToolManifest, ToolVersionSpec } from '@shared/types'

/**
 * 清单热更新的**字段白名单**（FR-15）—— 安全关键模块。
 *
 * 威胁模型：清单支持远程更新，如果远程内容可以自由改字段，那么热更新通道就等于
 * 任意命令执行通道（改 install.template / install.params / activate.env 都能达到目的）。
 *
 * 因此这里采用"**只接受白名单字段，其余一律从本地清单继承**"的策略：
 *
 *  可来自远程：version / channel / recommended / releaseDate / sizeBytes /
 *              installScope / source.url / source.sha256 / mirrors
 *  永远来自本地：detect / install（模板与参数）/ activate / verify / uninstall /
 *              category / tier / name / description / license / homepage
 *
 * 另外：新增一个本地没有的版本时，install / activate / verify 从本地清单的
 * **推荐版本**继承（同一个工具的安装方式不随补丁版本变化）。
 *
 * 结果还会被 JSON Schema 与语义校验再拦一道（见 manifest/validate.ts）。
 */

/** 远程版本条目里允许出现的键 */
export const HOT_UPDATE_ALLOWED_KEYS: readonly string[] = [
  'version',
  'channel',
  'recommended',
  'arch',
  'releaseDate',
  'sizeBytes',
  'installScope',
  'source',
  'mirrors'
]

/** 远程 source 里允许出现的键 */
const ALLOWED_SOURCE_KEYS = ['url', 'sha256'] as const

export interface HotUpdateEntry {
  id: string
  versions: unknown[]
}

export interface HotUpdateIndex {
  schemaVersion: 1
  generatedAt?: string
  tools: HotUpdateEntry[]
}

export interface MergeOutcome {
  manifest: ToolManifest
  accepted: number
  rejected: string[]
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 取本地清单里"安装信息最完整"的版本，用来给远程新增版本继承 install/activate/verify */
function templateSource(local: ToolManifest): ToolVersionSpec | null {
  return (
    local.versions.find((version) => version.recommended && version.install) ??
    local.versions.find((version) => version.install) ??
    local.versions[0] ??
    null
  )
}

function pickWhitelisted(
  raw: Record<string, unknown>,
  base: ToolVersionSpec | null,
  toolId: string,
  rejected: string[]
): ToolVersionSpec | null {
  for (const key of Object.keys(raw)) {
    if (!HOT_UPDATE_ALLOWED_KEYS.includes(key)) {
      rejected.push(`${toolId}: 远程条目里的 "${key}" 不在白名单内，已忽略`)
    }
  }

  const version = raw.version
  if (typeof version !== 'string' || !/^[0-9A-Za-z.\-_+]{1,40}$/.test(version)) {
    rejected.push(`${toolId}: 远程条目缺少合法版本号，已跳过`)
    return null
  }

  const source = isPlainObject(raw.source) ? raw.source : {}
  const url = typeof source.url === 'string' ? source.url : ''
  const sha256 = typeof source.sha256 === 'string' ? source.sha256 : ''

  if (!/^https:\/\//.test(url)) {
    rejected.push(`${toolId}@${version}: 下载地址不是 https，已跳过`)
    return null
  }
  if (!/^[a-f0-9]{64}$/i.test(sha256)) {
    rejected.push(`${toolId}@${version}: 缺少合法的 SHA-256，已跳过（没有校验和的版本不允许下发）`)
    return null
  }
  for (const key of Object.keys(source)) {
    if (!(ALLOWED_SOURCE_KEYS as readonly string[]).includes(key)) {
      rejected.push(`${toolId}@${version}: source 里的 "${key}" 不在白名单内，已忽略`)
    }
  }

  const channel =
    raw.channel === 'lts' || raw.channel === 'stable' || raw.channel === 'beta'
      ? raw.channel
      : (base?.channel ?? 'stable')

  const installScope = raw.installScope === 'machine' || raw.installScope === 'user' ? raw.installScope : null
  if (!installScope) {
    rejected.push(`${toolId}@${version}: installScope 必须是 user 或 machine，已跳过`)
    return null
  }

  const mirrors = Array.isArray(raw.mirrors)
    ? raw.mirrors
        .filter(
          (item): item is { name: string; url: string } =>
            isPlainObject(item) &&
            typeof item.name === 'string' &&
            item.name.length > 0 &&
            typeof item.url === 'string' &&
            /^https:\/\//.test(item.url)
        )
        .map((item) => ({ name: item.name, url: item.url }))
    : undefined

  const sizeBytes =
    typeof raw.sizeBytes === 'number' && Number.isFinite(raw.sizeBytes) && raw.sizeBytes >= 0
      ? Math.trunc(raw.sizeBytes)
      : undefined

  const releaseDate =
    typeof raw.releaseDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.releaseDate)
      ? raw.releaseDate
      : undefined

  const install: InstallSpec | undefined = base?.install

  return {
    version,
    channel,
    ...(raw.recommended === true ? { recommended: true } : {}),
    arch: 'x64',
    ...(releaseDate ? { releaseDate } : {}),
    ...(sizeBytes !== undefined ? { sizeBytes } : {}),
    installScope,
    source: { url, sha256: sha256.toLowerCase() },
    ...(mirrors && mirrors.length > 0 ? { mirrors } : {}),
    // 以下三样永远来自本地清单，远程无权修改
    ...(install ? { install } : {}),
    ...(base?.activate ? { activate: base.activate } : {}),
    ...(base?.verify ? { verify: base.verify } : {}),
    ...(base?.uninstall ? { uninstall: base.uninstall } : {}),
    ...(base?.dependsOn ? { dependsOn: base.dependsOn } : {}),
    ...(base?.requiresReboot ? { requiresReboot: true } : {})
  }
}

/**
 * 把远程条目合并进本地清单。
 *
 * 刻意不做的两件事：
 *  1. 不合并远程的 detect —— 检测规则被改掉后，用户可以装上一个"检测永远显示已安装"的假工具
 *  2. 不合并远程的 install/activate —— 那就是任意命令执行
 */
export function mergeHotUpdate(local: ToolManifest, remote: unknown): MergeOutcome {
  const rejected: string[] = []

  if (!isPlainObject(remote)) {
    return { manifest: local, accepted: 0, rejected: [`${local.id}: 远程条目不是对象`] }
  }
  if (remote.id !== local.id) {
    return { manifest: local, accepted: 0, rejected: [`${local.id}: 远程条目的 id 不匹配`] }
  }
  if (!Array.isArray(remote.versions)) {
    return { manifest: local, accepted: 0, rejected: [`${local.id}: 远程条目缺少 versions 数组`] }
  }

  const base = templateSource(local)
  if (!base?.install) {
    // 本地还没有任何带安装模板的版本 → 没有可继承的安装方式，拒绝整条
    return {
      manifest: local,
      accepted: 0,
      rejected: [`${local.id}: 本地清单没有可继承的安装模板，拒绝热更新`]
    }
  }

  const versions: ToolVersionSpec[] = []
  let accepted = 0

  for (const raw of remote.versions) {
    if (!isPlainObject(raw)) {
      rejected.push(`${local.id}: versions 里出现了非对象条目，已跳过`)
      continue
    }
    const picked = pickWhitelisted(raw, base, local.id, rejected)
    if (picked) {
      versions.push(picked)
      accepted += 1
    }
  }

  if (versions.length === 0) {
    return { manifest: local, accepted: 0, rejected: [...rejected, `${local.id}: 没有可用的远程版本`] }
  }

  // 一个工具最多只能有一个 recommended：远程没标就沿用本地的推荐版本号
  const recommendedCount = versions.filter((version) => version.recommended).length
  if (recommendedCount > 1) {
    rejected.push(`${local.id}: 远程给了 ${recommendedCount} 个 recommended 版本，已只保留第一个`)
    let seen = false
    for (const version of versions) {
      if (version.recommended) {
        if (seen) delete version.recommended
        seen = true
      }
    }
  } else if (recommendedCount === 0) {
    const localRecommended = local.versions.find((version) => version.recommended)?.version
    const match = versions.find((version) => version.version === localRecommended)
    if (match) match.recommended = true
    else versions[0].recommended = true
  }

  return { manifest: { ...local, versions }, accepted, rejected }
}
