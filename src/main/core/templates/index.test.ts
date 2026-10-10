import { describe, expect, it } from 'vitest'
import { INSTALL_TEMPLATES, resolveInstallTemplate, TemplateError } from './index'

describe('安装模板白名单', () => {
  it('解析合法引用', () => {
    const resolved = resolveInstallTemplate({
      type: 'zip',
      template: 'zip-into-version-dir',
      params: { stripComponents: '1' }
    })
    expect(resolved?.template.id).toBe('zip-into-version-dir')
    expect(resolved?.params.stripComponents).toBe('1')
  })

  it('不传 spec 时返回 null（不是所有工具都需要安装模板）', () => {
    expect(resolveInstallTemplate(undefined)).toBeNull()
  })

  it('拒绝未知模板名 —— 清单不能自带命令', () => {
    expect(() =>
      resolveInstallTemplate({ type: 'zip', template: 'run-whatever-i-want' })
    ).toThrow(TemplateError)
  })

  it('拒绝类型不匹配的模板', () => {
    expect(() =>
      resolveInstallTemplate({ type: 'msi', template: 'zip-into-version-dir' })
    ).toThrow(/类型是 zip/)
  })

  it('拒绝模板未声明的参数键', () => {
    expect(() =>
      resolveInstallTemplate({
        type: 'zip',
        template: 'zip-into-version-dir',
        params: { evilCommand: 'calc.exe' }
      })
    ).toThrow(/不接受参数 "evilCommand"/)
  })

  it('拒绝不合规的参数值', () => {
    for (const bad of ['3', '-1', '1; rm -rf /', '', '1 && calc']) {
      expect(() =>
        resolveInstallTemplate({
          type: 'zip',
          template: 'zip-into-version-dir',
          params: { stripComponents: bad }
        }),
        `参数值 ${JSON.stringify(bad)}`
      ).toThrow(TemplateError)
    }
  })

  it('允许省略可选参数', () => {
    const resolved = resolveInstallTemplate({ type: 'zip', template: 'zip-into-version-dir' })
    expect(resolved?.params).toEqual({})
  })

  it('模板表本身只包含声明了类型的条目', () => {
    for (const template of Object.values(INSTALL_TEMPLATES)) {
      expect(template.id).toBeTruthy()
      expect(template.type).toBeTruthy()
      expect(template.description).toBeTruthy()
    }
  })
})
