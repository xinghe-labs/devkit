import { describe, expect, it } from 'vitest'
import { INSTALL_TEMPLATES, resolveInstallTemplate, TemplateError, type CommandContext } from './index'

const CONTEXT: CommandContext = {
  archivePath: 'C:\\Users\\屈\\.devkit\\downloads\\nodejs-24.21.0-node.zip',
  installDir: 'C:\\Users\\屈\\.devkit\\versions\\nodejs\\24.21.0',
  logFile: 'C:\\Users\\屈\\AppData\\Roaming\\devkit\\logs\\installer-nodejs-24.21.0.log',
  version: '24.21.0',
  toolId: 'nodejs',
  npmCmd: 'C:\\Users\\屈\\.devkit\\current\\nodejs\\npm.cmd'
}

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

describe('解压类模板', () => {
  it('zip-into-version-dir 解析出 stripComponents', () => {
    const resolved = resolveInstallTemplate({
      type: 'zip',
      template: 'zip-into-version-dir',
      params: { stripComponents: '1' }
    })
    expect(resolved?.extract).toEqual({ mode: 'zip', stripComponents: 1 })
  })

  it('zip-single-file 必须声明 fileName', () => {
    expect(() =>
      resolveInstallTemplate({ type: 'zip', template: 'zip-single-file-into-version-dir' })
    ).toThrow(/缺少必填参数 "fileName"/)

    const resolved = resolveInstallTemplate({
      type: 'zip',
      template: 'zip-single-file-into-version-dir',
      params: { fileName: 'pnpm.exe' }
    })
    expect(resolved?.extract).toEqual({ mode: 'zip-single-file', fileName: 'pnpm.exe', subDir: null })
  })

  it('zip-single-file 的 fileName 不接受路径穿越', () => {
    for (const bad of ['..\\evil.exe', '/etc/passwd', 'a/b.exe', '']) {
      expect(() =>
        resolveInstallTemplate({
          type: 'zip',
          template: 'zip-single-file-into-version-dir',
          params: { fileName: bad }
        }),
        `fileName=${JSON.stringify(bad)}`
      ).toThrow(TemplateError)
    }
  })

  it('exe-7zsfx-extract 没有参数', () => {
    const resolved = resolveInstallTemplate({ type: 'exe-7zsfx', template: 'exe-7zsfx-extract' })
    expect(resolved?.extract).toEqual({ mode: '7zsfx' })
    expect(() =>
      resolveInstallTemplate({
        type: 'exe-7zsfx',
        template: 'exe-7zsfx-extract',
        params: { anything: '1' }
      })
    ).toThrow(TemplateError)
  })
})

describe('安装器类模板：命令行只能由代码拼', () => {
  it('msi-install 生成 msiexec 静默安装命令并指向版本目录', () => {
    const resolved = resolveInstallTemplate({
      type: 'msi',
      template: 'msi-install',
      params: { dirProperty: 'INSTALLDIR', properties: 'ALLUSERS=2;REBOOT=ReallySuppress' }
    })
    const command = resolved!.buildCommand!(CONTEXT)
    expect(command.cmd).toBe('msiexec.exe')
    expect(command.args).toContain('/qn')
    expect(command.args).toContain('/norestart')
    expect(command.args).toContain(`INSTALLDIR=${CONTEXT.installDir}`)
    expect(command.args).toContain('ALLUSERS=2')
    expect(command.args).toContain('REBOOT=ReallySuppress')
    expect(command.requiresAdmin).toBe(true)
  })

  it('msi-install 默认用 INSTALLDIR', () => {
    const resolved = resolveInstallTemplate({ type: 'msi', template: 'msi-install' })
    expect(resolved!.buildCommand!(CONTEXT).args).toContain(`INSTALLDIR=${CONTEXT.installDir}`)
  })

  it('msi-install 拒绝带引号/分号注入的 properties', () => {
    for (const bad of ['A=1"; calc; "', 'A=1 && calc', 'A=$(calc)', 'BAD']) {
      expect(() =>
        resolveInstallTemplate({
          type: 'msi',
          template: 'msi-install',
          params: { properties: bad }
        }),
        `properties=${bad}`
      ).toThrow(TemplateError)
    }
  })

  it('exe-nsis-silent 用 /S 并把 /D 放在最后', () => {
    const resolved = resolveInstallTemplate({
      type: 'exe-nsis',
      template: 'exe-nsis-silent',
      params: { dirSwitch: '/D=' }
    })
    const command = resolved!.buildCommand!(CONTEXT)
    expect(command.args[0]).toBe('/S')
    expect(command.args[command.args.length - 1]).toBe(`/D=${CONTEXT.installDir}`)
    expect(command.requiresAdmin).toBe(true)
  })

  it('exe-nsis-silent 在安装路径含空格时拒绝执行（NSIS 的 /D 不能带引号）', () => {
    const resolved = resolveInstallTemplate({
      type: 'exe-nsis',
      template: 'exe-nsis-silent',
      params: { dirSwitch: '/D=' }
    })
    expect(() =>
      resolved!.buildCommand!({ ...CONTEXT, installDir: 'C:\\Program Files\\tool' })
    ).toThrow(/不接受含空格的路径/)
  })

  it('exe-inno-silent 生成 Inno 静默参数，且不需要管理员', () => {
    const resolved = resolveInstallTemplate({
      type: 'exe-inno',
      template: 'exe-inno-silent',
      params: { extraArgs: '-MERGETASKS=!runcode' }
    })
    const command = resolved!.buildCommand!(CONTEXT)
    expect(command.args).toContain('/VERYSILENT')
    expect(command.args).toContain('/SUPPRESSMSGBOXES')
    expect(command.args).toContain('/NORESTART')
    expect(command.args).toContain(`/DIR=${CONTEXT.installDir}`)
    expect(command.args).toContain('-MERGETASKS=!runcode')
    expect(command.requiresAdmin).toBe(false)
  })

  it('exe-python-silent 强制用户级安装且不改 PATH', () => {
    const resolved = resolveInstallTemplate({ type: 'exe-custom', template: 'exe-python-silent' })
    const command = resolved!.buildCommand!(CONTEXT)
    expect(command.args).toContain('InstallAllUsers=0')
    expect(command.args).toContain('PrependPath=0')
    expect(command.args).toContain(`TargetDir=${CONTEXT.installDir}`)
    expect(command.requiresAdmin).toBe(false)
  })

  it('exe-rustup-init 把工具链指进版本目录且不碰 PATH', () => {
    const resolved = resolveInstallTemplate({
      type: 'exe-custom',
      template: 'exe-rustup-init',
      params: { profile: 'minimal' }
    })
    const command = resolved!.buildCommand!(CONTEXT)
    expect(command.args).toContain('--no-modify-path')
    expect(command.args).toContain('-y')
    expect(command.env?.CARGO_HOME).toBe(`${CONTEXT.installDir}\\cargo`)
    expect(command.env?.RUSTUP_HOME).toBe(`${CONTEXT.installDir}\\rustup`)
    expect(command.installsOutsideVersionDir).toBe(true)
  })

  it('exe-rustup-init 只接受白名单里的 profile', () => {
    expect(() =>
      resolveInstallTemplate({
        type: 'exe-custom',
        template: 'exe-rustup-init',
        params: { profile: 'custom;calc' }
      })
    ).toThrow(TemplateError)
  })

  it('解压类模板不暴露 buildCommand，安装器类模板不暴露 extract', () => {
    const zip = resolveInstallTemplate({ type: 'zip', template: 'zip-into-version-dir' })
    expect(zip!.buildCommand).toBeUndefined()
    expect(zip!.extract).toBeDefined()

    const msi = resolveInstallTemplate({ type: 'msi', template: 'msi-install' })
    expect(msi!.extract).toBeUndefined()
    expect(msi!.buildCommand).toBeDefined()
  })
})

describe('npm 类模板（AI 编码 agent 这类只发 npm 的工具）', () => {
  it('命令固定为 install --global --prefix <版本目录> <本地 tgz>', () => {
    const resolved = resolveInstallTemplate({
      type: 'npm',
      template: 'npm-global-into-version-dir',
      params: { binName: 'claude' }
    })
    const command = resolved!.buildCommand!(CONTEXT)

    expect(command.cmd).toBe(CONTEXT.npmCmd)
    expect(command.args).toContain('install')
    expect(command.args).toContain('--global')
    // 关键：装进版本目录，而不是全局 %APPDATA%\npm
    expect(command.args[command.args.indexOf('--prefix') + 1]).toBe(CONTEXT.installDir)
    // 装的是已经校验过哈希的本地 tgz
    expect(command.args).toContain(CONTEXT.archivePath)
    expect(command.args).not.toContain('-g')
    expect(command.requiresAdmin).toBe(false)
  })

  it('binName 是必填项', () => {
    expect(() =>
      resolveInstallTemplate({ type: 'npm', template: 'npm-global-into-version-dir' })
    ).toThrow(/缺少必填参数 "binName"/)
  })

  it('binName 拒绝路径穿越与奇怪字符', () => {
    for (const bad of ['../evil', 'a/b', 'a b', 'a.exe;calc', '']) {
      expect(() =>
        resolveInstallTemplate({
          type: 'npm',
          template: 'npm-global-into-version-dir',
          params: { binName: bad }
        }),
        `binName=${JSON.stringify(bad)}`
      ).toThrow(TemplateError)
    }
  })

  it('extraArgs 只接受白名单开关', () => {
    const ok = resolveInstallTemplate({
      type: 'npm',
      template: 'npm-global-into-version-dir',
      params: { binName: 'gemini', extraArgs: '--omit=optional' }
    })
    expect(ok!.buildCommand!(CONTEXT).args).toContain('--omit=optional')

    expect(() =>
      resolveInstallTemplate({
        type: 'npm',
        template: 'npm-global-into-version-dir',
        params: { binName: 'gemini', extraArgs: '--registry=http://evil;calc' }
      })
    ).toThrow(TemplateError)
  })

  it('类型不匹配会被拒绝', () => {
    expect(() =>
      resolveInstallTemplate({ type: 'zip', template: 'npm-global-into-version-dir' })
    ).toThrow(/类型是 npm/)
  })
})
