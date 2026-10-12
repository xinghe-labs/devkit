import type { InstallSpec, InstallType } from '@shared/types'

/**
 * 安装参数模板白名单 —— 安全关键模块。
 *
 * 清单里的 `install.template` 只能引用这里定义的模板，`install.params` 只能填模板声明过的键，
 * 且值必须匹配模板给出的正则。清单**无权自定义命令行**。
 *
 * 为什么必须这样：清单支持热更新（FR-15），如果清单能自由指定命令与参数，
 * 那么热更新通道就等于任意命令执行通道。参数模板是唯一能触达命令行的入口，
 * 所以它必须写死在代码里、只能被引用、不能被覆盖。
 *
 * 模板分两类：
 *  · extract 类：压缩包直接解压到版本目录，没有命令行
 *  · command 类：跑一个安装器，命令行由这里的 build 函数拼出来（不是清单拼的）
 */

export interface TemplateParamRule {
  /** 值必须匹配此正则 */
  pattern: RegExp
  required?: boolean
  description: string
}

export interface InstallTemplate {
  id: string
  type: InstallType
  description: string
  params: Record<string, TemplateParamRule>
}

/** 拼命令行时能拿到的上下文；全部由主进程提供，清单无法影响 */
export interface CommandContext {
  archivePath: string
  installDir: string
  /** 安装器日志落盘位置（安装失败时要能翻日志） */
  logFile: string
  version: string
  toolId: string
}

export interface InstallerCommand {
  cmd: string
  args: string[]
  /** 需要管理员权限（安装范围是 machine 时为 true） */
  requiresAdmin: boolean
  /** 安装器会把文件放到 installDir 之外的地方（rustup 这类），自检要按实际位置来 */
  installsOutsideVersionDir?: boolean
  /** 安装器需要的额外环境变量 */
  env?: Record<string, string>
}

export type ExtractPlan =
  | { mode: 'zip'; stripComponents: number }
  | { mode: 'zip-single-file'; fileName: string; subDir: string | null }
  | { mode: '7zsfx' }

export interface ResolvedTemplate {
  template: InstallTemplate
  params: Record<string, string>
  /** extract 类模板的解析结果 */
  extract?: ExtractPlan
  /** command 类模板的命令行构造器 */
  buildCommand?: (context: CommandContext) => InstallerCommand
}

/* ------------------------------------------------------------------ */
/* 模板表                                                              */
/* ------------------------------------------------------------------ */

/** 路径类参数里允许出现的字符（绝对路径 + 盘符 + 反斜杠） */
const PATH_CHARS = /^[A-Za-z0-9_\-.:\\/ ]{0,200}$/
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,80}$/
const SUB_DIR = /^[A-Za-z0-9._\\-]{1,80}$/
const DIR_PROPERTY = /^[A-Z][A-Za-z0-9_]{0,40}$/
/** MSI 属性串：KEY=VALUE(;KEY=VALUE)*，值里不允许出现引号、分号与任何 shell 元字符 */
const MSI_PROPERTIES =
  /^[A-Za-z0-9_]{1,40}=[^;"'`|&<>$%^()!]{0,160}(;[A-Za-z0-9_]{1,40}=[^;"'`|&<>$%^()!]{0,160})*$/
/** 追加参数：只允许 -/ 开头的开关与等号取值，禁止 shell 元字符与引号 */
const EXTRA_ARGS = /^-{1,2}[A-Za-z0-9_][A-Za-z0-9_=.,!*-]{0,60}( -{1,2}[A-Za-z0-9_][A-Za-z0-9_=.,!*-]{0,60})*$/
/** NSIS 的 /D 开关（必须无引号且位于最后） */
const NSIS_DIR_SWITCH = /^\/D=$/

export const INSTALL_TEMPLATES: Readonly<Record<string, InstallTemplate>> = {
  'zip-into-version-dir': {
    id: 'zip-into-version-dir',
    type: 'zip',
    description:
      '把压缩包解压到该工具的版本目录 %USERPROFILE%\\.devkit\\versions\\<tool>\\<version>\\（用户级，不需要管理员）',
    params: {
      stripComponents: {
        pattern: /^[0-2]$/,
        description: '去掉压缩包顶部的目录层数（0~2）。Node 的 zip 有一层顶层目录，填 1'
      }
    }
  },

  'zip-single-file-into-version-dir': {
    id: 'zip-single-file-into-version-dir',
    type: 'zip',
    description:
      '压缩包里只有一个可执行文件时使用：把它放到版本目录（可选子目录），其余内容丢弃。pnpm / ninja 这类单文件发行版走这个模板',
    params: {
      fileName: {
        pattern: FILE_NAME,
        required: true,
        description: '解压后要保留的文件名，例如 pnpm.exe'
      },
      subDir: {
        pattern: SUB_DIR,
        description: '放到版本目录下的哪个子目录（如 bin）；不填表示直接放版本目录根'
      }
    }
  },

  'exe-7zsfx-extract': {
    id: 'exe-7zsfx-extract',
    type: 'exe-7zsfx',
    description:
      '7-Zip 自解压包（PortableGit 等）：用 -o<目录> -y 静默解压到版本目录，不写注册表、不需要管理员',
    params: {}
  },

  'msi-install': {
    id: 'msi-install',
    type: 'msi',
    description:
      'msiexec /qn 静默安装 MSI。安装目录通过 INSTALLDIR 类属性指定到版本目录；需要管理员权限',
    params: {
      dirProperty: {
        pattern: DIR_PROPERTY,
        description: '指定安装目录的 MSI 属性名，默认 INSTALLDIR'
      },
      properties: {
        pattern: MSI_PROPERTIES,
        description: '额外的 MSI 属性，KEY=VALUE 形式，多个用 ; 分隔'
      },
      extraArgs: {
        pattern: EXTRA_ARGS,
        description: '额外的 msiexec 开关（如 -norestart 之外的定制项）'
      }
    }
  },

  'exe-nsis-silent': {
    id: 'exe-nsis-silent',
    type: 'exe-nsis',
    description:
      'NSIS 安装器静默安装：/S 加上可选的 /D=<目录>。注意 /D 必须是最后一个参数且不能带引号（NSIS 的硬性规定），因此只在安装路径不含空格时使用',
    params: {
      silentArgs: {
        pattern: EXTRA_ARGS,
        description: '覆盖默认静默参数；不填则使用 /S'
      },
      dirSwitch: {
        pattern: NSIS_DIR_SWITCH,
        description: '是否追加 /D=<安装目录>；不填表示用安装器默认目录'
      }
    }
  },

  'exe-inno-silent': {
    id: 'exe-inno-silent',
    type: 'exe-inno',
    description:
      'Inno Setup 安装器静默安装：/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /DIR="<目录>"，用户级安装不需要管理员',
    params: {
      extraArgs: {
        pattern: EXTRA_ARGS,
        description: '额外的 Inno 开关，例如 -MERGETASKS=!runcode'
      }
    }
  },

  'exe-python-silent': {
    id: 'exe-python-silent',
    type: 'exe-custom',
    description:
      "python.org 官方安装器静默安装：/quiet InstallAllUsers=0 TargetDir=<目录>。用户级安装，不改 PATH（PATH 由 devkit 的激活机制统一管）",
    params: {
      includeLauncher: {
        pattern: /^[01]$/,
        description: '是否安装 py 启动器（1/0），默认 1'
      },
      includePip: {
        pattern: /^[01]$/,
        description: '是否安装 pip（1/0），默认 1'
      },
      extraProperties: {
        pattern: MSI_PROPERTIES,
        description: '额外的安装器属性，KEY=VALUE 形式'
      }
    }
  },

  'exe-rustup-init': {
    id: 'exe-rustup-init',
    type: 'exe-custom',
    description:
      'rustup-init.exe 静默安装：通过 CARGO_HOME / RUSTUP_HOME 把整个工具链放进版本目录，--no-modify-path 保证不改 PATH（由 devkit 激活机制接管）',
    params: {
      profile: {
        pattern: /^(minimal|default|complete)$/,
        description: 'rustup 安装档位，默认 minimal（只装 rustc/cargo/rust-std）'
      },
      defaultHost: {
        pattern: /^x86_64-pc-windows-(msvc|gnu)$/,
        description: '默认工具链 host，默认 x86_64-pc-windows-msvc'
      }
    }
  }
}

export class TemplateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TemplateError'
  }
}

export function listTemplateIds(): string[] {
  return Object.keys(INSTALL_TEMPLATES)
}

/** 校验一份参数对象是否符合模板声明；返回清洗后的参数 */
function validateParams(template: InstallTemplate, params: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {}

  for (const [key, value] of Object.entries(params)) {
    const rule = template.params[key]
    if (!rule) {
      throw new TemplateError(
        `安装模板 "${template.id}" 不接受参数 "${key}"。允许的参数：${
          Object.keys(template.params).join(', ') || '（无）'
        }`
      )
    }
    if (typeof value !== 'string' || !rule.pattern.test(value)) {
      throw new TemplateError(
        `安装模板 "${template.id}" 的参数 "${key}" 值不合法：${JSON.stringify(value)}（要求：${rule.description}）`
      )
    }
    result[key] = value
  }

  for (const [key, rule] of Object.entries(template.params)) {
    if (rule.required && result[key] === undefined) {
      throw new TemplateError(`安装模板 "${template.id}" 缺少必填参数 "${key}"（${rule.description}）`)
    }
  }

  return result
}

function buildExtractPlan(templateId: string, params: Record<string, string>): ExtractPlan {
  switch (templateId) {
    case 'zip-into-version-dir':
      return { mode: 'zip', stripComponents: Number.parseInt(params.stripComponents ?? '0', 10) || 0 }
    case 'zip-single-file-into-version-dir':
      return { mode: 'zip-single-file', fileName: params.fileName, subDir: params.subDir ?? null }
    case 'exe-7zsfx-extract':
      return { mode: '7zsfx' }
    default:
      throw new TemplateError(`模板 ${templateId} 不是解压类模板`)
  }
}

/** 把 "a b c" 形式的追加参数切成数组；正则已保证不含引号与元字符 */
function splitArgs(input: string | undefined): string[] {
  return input ? input.split(' ').filter((part) => part !== '') : []
}

function buildCommandFactory(
  templateId: string,
  params: Record<string, string>
): (context: CommandContext) => InstallerCommand {
  switch (templateId) {
    case 'msi-install':
      return (context) => {
        const dirProperty = params.dirProperty ?? 'INSTALLDIR'
        const properties = params.properties ? params.properties.split(';').filter(Boolean) : []
        return {
          cmd: 'msiexec.exe',
          args: [
            '/i',
            context.archivePath,
            '/qn',
            '/norestart',
            '/l*v',
            context.logFile,
            `${dirProperty}=${context.installDir}`,
            ...properties,
            ...splitArgs(params.extraArgs)
          ],
          requiresAdmin: true
        }
      }

    case 'exe-nsis-silent':
      return (context) => {
        const silent = splitArgs(params.silentArgs)
        const args = silent.length > 0 ? silent : ['/S']
        // /D 必须是最后一个参数，且不能加引号。路径含空格时 Node 会自动加引号并破坏 NSIS 解析，
        // 所以这里显式拒绝 —— 宁可报错也不要装到错误的位置。
        if (params.dirSwitch) {
          if (/\s/.test(context.installDir)) {
            throw new TemplateError(
              `NSIS 的 /D 开关不接受含空格的路径，当前安装目录是 ${context.installDir}。` +
                '请把用户目录改到不含空格的路径，或改用该软件的 ZIP / MSI 发行版。'
            )
          }
          args.push(`${params.dirSwitch}${context.installDir}`)
        }
        return { cmd: context.archivePath, args, requiresAdmin: true }
      }

    case 'exe-inno-silent':
      return (context) => ({
        cmd: context.archivePath,
        args: [
          '/VERYSILENT',
          '/SUPPRESSMSGBOXES',
          '/NORESTART',
          '/SP-',
          `/LOG=${context.logFile}`,
          `/DIR=${context.installDir}`,
          ...splitArgs(params.extraArgs)
        ],
        requiresAdmin: false
      })

    case 'exe-python-silent':
      return (context) => {
        const includeLauncher = params.includeLauncher ?? '1'
        const includePip = params.includePip ?? '1'
        const extra = params.extraProperties ? params.extraProperties.split(';').filter(Boolean) : []
        return {
          cmd: context.archivePath,
          args: [
            '/quiet',
            'InstallAllUsers=0',
            'PrependPath=0',
            'AssociateFiles=0',
            'Shortcuts=0',
            'Include_test=0',
            `Include_launcher=${includeLauncher}`,
            `Include_pip=${includePip}`,
            `TargetDir=${context.installDir}`,
            ...extra
          ],
          requiresAdmin: false
        }
      }

    case 'exe-rustup-init':
      return (context) => ({
        cmd: context.archivePath,
        args: [
          '-y',
          '--no-modify-path',
          '--profile',
          params.profile ?? 'minimal',
          '--default-host',
          params.defaultHost ?? 'x86_64-pc-windows-msvc',
          '--default-toolchain',
          'stable'
        ],
        requiresAdmin: false,
        // rustup 只认 CARGO_HOME / RUSTUP_HOME，把这两个指到版本目录即可
        installsOutsideVersionDir: true,
        env: {
          CARGO_HOME: `${context.installDir}\\cargo`,
          RUSTUP_HOME: `${context.installDir}\\rustup`
        }
      })

    default:
      throw new TemplateError(`模板 ${templateId} 不是安装器类模板`)
  }
}

/**
 * 解析并校验清单给出的安装模板引用。
 * 任何不认识的模板名、类型不匹配、未声明的参数键、不合规的参数值，一律抛错 ——
 * 宁可安装失败，也不执行一条来路不明的命令。
 */
export function resolveInstallTemplate(spec: InstallSpec | undefined): ResolvedTemplate | null {
  if (!spec) return null

  const template = INSTALL_TEMPLATES[spec.template]
  if (!template) {
    throw new TemplateError(
      `未知的安装模板 "${spec.template}"。可用模板：${listTemplateIds().join(', ')}`
    )
  }

  if (template.type !== spec.type) {
    throw new TemplateError(
      `安装模板 "${template.id}" 的类型是 ${template.type}，但清单声明的是 ${spec.type}`
    )
  }

  const params = validateParams(template, spec.params ?? {})

  if (template.type === 'zip' || template.type === 'exe-7zsfx') {
    return { template, params, extract: buildExtractPlan(template.id, params) }
  }

  return { template, params, buildCommand: buildCommandFactory(template.id, params) }
}

/** 仅供测试与文档：列出模板的默认命令形状 */
export function describeTemplate(templateId: string): string {
  const template = INSTALL_TEMPLATES[templateId]
  if (!template) throw new TemplateError(`未知的安装模板 "${templateId}"`)
  return `${template.id} [${template.type}] ${template.description}`
}

export { PATH_CHARS }
