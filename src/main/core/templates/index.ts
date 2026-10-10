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
  }
}

export class TemplateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TemplateError'
  }
}

export interface ResolvedTemplate {
  template: InstallTemplate
  params: Record<string, string>
}

export function listTemplateIds(): string[] {
  return Object.keys(INSTALL_TEMPLATES)
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

  const params: Record<string, string> = {}
  for (const [key, value] of Object.entries(spec.params ?? {})) {
    const rule = template.params[key]
    if (!rule) {
      throw new TemplateError(
        `安装模板 "${template.id}" 不接受参数 "${key}"。允许的参数：${
          Object.keys(template.params).join(', ') || '（无）'
        }`
      )
    }
    if (!rule.pattern.test(value)) {
      throw new TemplateError(
        `安装模板 "${template.id}" 的参数 "${key}" 值不合法：${JSON.stringify(value)}（要求：${rule.description}）`
      )
    }
    params[key] = value
  }

  for (const [key, rule] of Object.entries(template.params)) {
    if (rule.required && params[key] === undefined) {
      throw new TemplateError(`安装模板 "${template.id}" 缺少必填参数 "${key}"（${rule.description}）`)
    }
  }

  return { template, params }
}
