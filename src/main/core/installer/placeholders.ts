import type { ToolVersionSpec } from '@shared/types'

/**
 * 安装/自检命令里的占位符替换。
 *
 * 为什么需要：装到用户级版本目录后，`verify` 不能写 `node -v` —— 那会命中 PATH 上
 * 本来就有的 Node，得到假阳性。必须让清单写成 `{installDir}\node.exe`，
 * 验证的才是刚装进去的那一份（见 SPEC「安装 ≠ 激活」）。
 */

export interface PlaceholderVars {
  installDir: string
  version: string
  toolId: string
}

const PLACEHOLDER = /\{([a-zA-Z][a-zA-Z0-9]*)\}/g

export class UnknownPlaceholderError extends Error {
  constructor(name: string, input: string) {
    super(`未知占位符 {${name}}（出现在 ${JSON.stringify(input)}）`)
    this.name = 'UnknownPlaceholderError'
  }
}

export function substitutePlaceholders(input: string, vars: PlaceholderVars): string {
  return input.replace(PLACEHOLDER, (_match, name: string) => {
    switch (name) {
      case 'installDir':
        return vars.installDir
      case 'version':
        return vars.version
      case 'toolId':
        return vars.toolId
      default:
        // 宁可报错也不要原样传给命令行 —— 未知占位符通常意味着清单写错了，
        // 静默放行只会让用户看到一个莫名其妙的"命令找不到"
        throw new UnknownPlaceholderError(name, input)
    }
  })
}

/** 判断某个版本是否具备完整安装信息（status=ready 的清单由 Schema 保证，这里是运行期兜底） */
export function isInstallableVersion(version: ToolVersionSpec): boolean {
  return Boolean(version.source?.url && version.source?.sha256 && version.install?.template)
}
