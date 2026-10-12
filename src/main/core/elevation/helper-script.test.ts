import { describe, expect, it } from 'vitest'
import { ELEVATION_HELPER_SCRIPT } from './helper-script'

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
    expect(ELEVATION_HELPER_SCRIPT).toContain('param(')
    // 不该出现 base64 解码执行这类可疑写法
    expect(ELEVATION_HELPER_SCRIPT).not.toContain('FromBase64String')
    expect(ELEVATION_HELPER_SCRIPT).not.toContain('Invoke-Expression')
  })

  it('三种步骤类型都有处理分支', () => {
    for (const kind of ['set-machine-path', 'restore-point']) {
      expect(ELEVATION_HELPER_SCRIPT).toContain(kind)
    }
    // 通用 exec 分支
    expect(ELEVATION_HELPER_SCRIPT).toContain('Start-Process')
  })
})
