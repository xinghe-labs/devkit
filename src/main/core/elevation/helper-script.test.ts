import { describe, expect, it } from 'vitest'
import {
  buildElevatedScript,
  ELEVATION_HELPER_SCRIPT,
  encodeForPowerShell,
  makeJobId,
  makeNonce,
  MAX_ENCODED_COMMAND_CHARS
} from './helper-script'

/**
 * 助手脚本是**拼在 TypeScript 模板字符串里**的，所以里面的反斜杠必须写两遍。
 *
 * 这里踩过一次真坑：写机器级 PATH 时路径写成 `'HKLM:\SYSTEM\...'`，
 * 模板字符串把 `\S` 当成转义吃掉，PowerShell 收到的是 `HKLM:SYSTEM...` ——
 * 脚本会直接失败，而且失败信息（找不到注册表路径）完全指不到真正的原因。
 * 所以用单测把生成的脚本内容钉死。
 */
const BS = String.fromCharCode(92)

describe('提权助手脚本的生成结果', () => {
  it('机器级 PATH 的注册表路径没有被模板字符串吃掉反斜杠', () => {
    const line = ELEVATION_HELPER_SCRIPT.split('\n').find((l) => l.includes('HKLM:'))
    expect(line, '脚本里应该有写机器级 PATH 的那一步').toBeTruthy()

    const expected = `HKLM:${BS}SYSTEM${BS}CurrentControlSet${BS}Control${BS}Session Manager${BS}Environment`
    expect(line).toContain(expected)
    // 被吃掉的样子：HKLM:SYSTEM（没有反斜杠）
    expect(line).not.toContain('HKLM:SYSTEM')
  })

  it('用 Set-ItemProperty 写 ExpandString，而不是 setx', () => {
    // setx 在 1024 字符处静默截断 —— 机器上那些 `C:\P`、`ogram Files\Git\cmd`
    // 的残留就是这么来的。助手脚本绝不能再用它。
    expect(ELEVATION_HELPER_SCRIPT).toContain('Set-ItemProperty')
    expect(ELEVATION_HELPER_SCRIPT).toContain('-Type ExpandString')

    // 注释里会提到 setx（解释为什么不用它），所以只检查**非注释行**里没有 setx 命令
    const commandLines = ELEVATION_HELPER_SCRIPT.split('\n').filter(
      (line) => !line.trim().startsWith('#')
    )
    for (const line of commandLines) {
      expect(line, `这行里出现了 setx：${line.trim()}`).not.toMatch(/\bsetx\b/i)
    }
  })

  it('写完之后广播 WM_SETTINGCHANGE', () => {
    expect(ELEVATION_HELPER_SCRIPT).toContain('SendMessageTimeout')
    expect(ELEVATION_HELPER_SCRIPT).toContain('0x1A')
  })

  it('脚本是纯文本、可审计（不混淆不加密）', () => {
    expect(ELEVATION_HELPER_SCRIPT).toContain('devkit 提权助手')
    // 不该出现 base64 解码执行这类可疑写法。
    // 注意：调用方确实会用 -EncodedCommand 传脚本（那是 PowerShell 的传输编码，
    // 不是脚本自己在解码），所以这里查的是**脚本内部**有没有解码执行。
    expect(ELEVATION_HELPER_SCRIPT).not.toContain('FromBase64String')
    expect(ELEVATION_HELPER_SCRIPT).not.toContain('Invoke-Expression')
  })

  it('**脚本自己不读任何文件**（读用户可写的文件 = 把管理员权限交出去）', () => {
    // 以前助手脚本用 param(-JobFile) + Get-Content 读作业文件，
    // 而那个目录用户可写、文件名只精确到秒 —— 同机器上的低权限进程
    // 可以在用户点 UAC 之前把内容换掉，从而以管理员身份执行任意命令。
    expect(ELEVATION_HELPER_SCRIPT).not.toContain('Get-Content')
    expect(ELEVATION_HELPER_SCRIPT).not.toContain('JobFile')
    // 作业数据由调用方以变量注入
    expect(ELEVATION_HELPER_SCRIPT).toContain('$JobJson')
  })

  it('结果里带 nonce（结果文件在用户可写目录，要能识别是不是本次作业写的）', () => {
    expect(ELEVATION_HELPER_SCRIPT).toContain('nonce = $Nonce')
  })

  it('三种步骤类型都有处理分支', () => {
    for (const kind of ['set-machine-path', 'restore-point']) {
      expect(ELEVATION_HELPER_SCRIPT).toContain(kind)
    }
    // 通用 exec 分支
    expect(ELEVATION_HELPER_SCRIPT).toContain('Start-Process')
  })
})

describe('内联脚本的构建与编码', () => {
  const payload = {
    jobId: 'job-1',
    nonce: 'n'.repeat(64),
    resultFile: `C:${BS}tmp${BS}result.json`,
    steps: [
      { kind: 'exec' as const, label: '打个招呼', cmd: 'cmd.exe', args: ['/d', '/c', 'echo hi'] }
    ]
  }

  it('把作业数据与助手脚本拼在一起，作业是字面量 here-string', () => {
    const script = buildElevatedScript(payload)
    expect(script).toContain('$JobJson = @\'')
    expect(script).toContain("'@")
    expect(script).toContain('cmd.exe')
    expect(script).toContain('devkit 提权助手')
    // 结果路径与 nonce 也注入了
    expect(script).toContain(payload.nonce)
  })

  it('作业 JSON 里的 $ 不会被 PowerShell 展开（here-string 是字面量）', () => {
    const script = buildElevatedScript({
      ...payload,
      steps: [
        {
          kind: 'set-machine-path' as const,
          label: '写 PATH',
          value: `%USERPROFILE%${BS}x;$env:PATH`
        }
      ]
    })
    expect(script).toContain('$env:PATH')
  })

  it('路径里的单引号被正确转义（PowerShell 单引号串里要写两遍）', () => {
    const script = buildElevatedScript({
      ...payload,
      resultFile: `C:${BS}it's${BS}result.json`
    })
    expect(script).toContain(`C:${BS}it''s${BS}result.json`)
  })

  it('编码成 UTF-16LE base64（PowerShell -EncodedCommand 的要求）', () => {
    const encoded = encodeForPowerShell('Write-Host 1')
    // 解回来应等于原文
    expect(Buffer.from(encoded, 'base64').toString('utf16le')).toBe('Write-Host 1')
  })

  it('id 与 nonce 都是随机的（不能可预测，否则结果文件可被预置）', () => {
    expect(makeJobId()).not.toBe(makeJobId())
    expect(makeNonce()).not.toBe(makeNonce())
    expect(makeNonce()).toHaveLength(64)
  })

  it('编码后的长度上限留了余量（Windows 命令行总长上限是 32767）', () => {
    expect(MAX_ENCODED_COMMAND_CHARS).toBeLessThan(32767)
  })
})
