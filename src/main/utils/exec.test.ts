import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isFallbackSafe, runCommand } from './exec'

describe('runCommand', () => {
  it('执行命令并捕获 stdout', async () => {
    const result = await runCommand('node', ['-v'])
    expect(result.spawnError).toBeNull()
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toMatch(/^v\d+\.\d+/)
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('同时捕获 stderr', async () => {
    const result = await runCommand('node', ['-e', 'console.error("boom")'])
    expect(result.stderr).toContain('boom')
  })

  it('命令不存在时既不会抛异常，也不会被误判为成功', async () => {
    const result = await runCommand('devkit-definitely-not-a-real-command', [])
    const looksSuccessful = result.code === 0 && result.spawnError === null
    expect(looksSuccessful).toBe(false)
  })

  it('超时会被中断并标记 timedOut', async () => {
    const result = await runCommand('node', ['-e', 'setTimeout(() => {}, 10000)'], {
      timeoutMs: 500
    })
    expect(result.timedOut).toBe(true)
  })

  it('参数不会被 shell 解释（注入防护，NFR-1）', async () => {
    // node.exe 走直连路径；若走了 shell，& 与 | 会把命令拆开，输出就变成多行
    const payload = 'a & echo INJECTED | echo STILL'
    const result = await runCommand('node', ['-e', 'console.log(process.argv[1])', payload])
    expect(result.stdout.trim()).toBe(payload)
    expect(result.stdout.trim().split(/\r?\n/)).toHaveLength(1)
  })

  it('GBK 编码的中文输出不会变成乱码（中文 Windows 场景，NFR-5）', async () => {
    // 0xD6D0 0xCEC4 是「中文」两字的 GBK 字节；解码器应识别出它不是合法 UTF-8 并改用 GB18030
    const result = await runCommand('node', [
      '-e',
      'process.stdout.write(Buffer.from([0xd6, 0xd0, 0xce, 0xc4]))'
    ])
    expect(result.stdout).toBe('中文')
  })

  it('非 .exe 命令走 cmd.exe 回退路径（npm 是 .cmd）', async () => {
    const result = await runCommand('npm', ['--version'])
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+/)
  })
})

describe('cmd.exe 回退路径的注入防护', () => {
  /** 造一个把参数原样回显到文件的 .cmd，用来判定参数有没有被 cmd 解释 */
  function withEchoScript(run: (dir: string) => Promise<void>): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'devkit-exec-'))
    writeFileSync(join(dir, 'dk-echo.cmd'), '@echo off\r\necho %~1 > out.txt\r\n', 'utf8')
    return run(dir).finally(() => rmSync(dir, { recursive: true, force: true }))
  }

  it('含 cmd 元字符的参数被拒绝执行，而不是拼进命令行', async () => {
    await withEchoScript(async (dir) => {
      const result = await runCommand('dk-echo', ['a', '&', 'echo', 'INJECTED'], {
        cwd: dir,
        env: { PATH: `${dir};${process.env.PATH ?? ''}` }
      })

      // 必须报错，而不是"尽力执行"
      expect(result.spawnError).toContain('已拒绝执行')
      // 关键：脚本一次都没跑起来
      expect(() => readFileSync(join(dir, 'out.txt'))).toThrow()
    })
  })

  it('含空格的参数同样被拒绝（避免 Node 转义与 cmd 解析互相打架）', async () => {
    await withEchoScript(async (dir) => {
      const result = await runCommand('dk-echo', ['C:\\Program Files\\x'], {
        cwd: dir,
        env: { PATH: `${dir};${process.env.PATH ?? ''}` }
      })
      expect(result.spawnError).toContain('已拒绝执行')
      expect(() => readFileSync(join(dir, 'out.txt'))).toThrow()
    })
  })

  it('合法参数正常执行，且参数原样送达', async () => {
    await withEchoScript(async (dir) => {
      const result = await runCommand('dk-echo', ['--version'], {
        cwd: dir,
        env: { PATH: `${dir};${process.env.PATH ?? ''}` }
      })
      expect(result.spawnError).toBeNull()
      expect(result.code).toBe(0)
      expect(readFileSync(join(dir, 'out.txt'), 'utf8').trim()).toBe('--version')
    })
  })
})

describe('isFallbackSafe 参数白名单', () => {
  it('放行版本检测用的简单参数', () => {
    expect(isFallbackSafe('code', ['--version'])).toBe(true)
    expect(isFallbackSafe('mvn', ['-v'])).toBe(true)
    expect(isFallbackSafe('py', ['-3', '--version'])).toBe(true)
    expect(isFallbackSafe('pnpm', ['-v'])).toBe(true)
    expect(isFallbackSafe('npm', ['--version'])).toBe(true)
  })

  it('拒绝 cmd 元字符', () => {
    for (const bad of ['&', '|', '>', '<', '^', '(', ')', '%PATH%', 'a&b', 'a|b', 'a>b']) {
      expect(isFallbackSafe('dk-echo', [bad]), `参数 ${bad}`).toBe(false)
    }
  })

  it('拒绝空白、引号与通配符', () => {
    for (const bad of ['', ' ', 'a b', '"x"', 'a*b', 'a?b']) {
      expect(isFallbackSafe('dk-echo', [bad]), `参数 ${JSON.stringify(bad)}`).toBe(false)
    }
  })

  it('允许带空格与中文的命令路径（devkit 自己的安装目录就是中文）', () => {
    // 实测踩到：把命令路径也按纯 ASCII 白名单卡住，会让 devkit 自己装的
    // Maven / Gradle / VS Code 的自检（都是 .cmd）全部被拒。
    expect(isFallbackSafe('C:\\Program Files\\x.cmd', ['-v'])).toBe(true)
    expect(isFallbackSafe('C:\\Users\\屈\\.devkit\\versions\\maven\\3.10.0\\bin\\mvn.cmd', ['-v'])).toBe(
      true
    )
  })

  it('命令路径仍然拒绝 cmd 元字符与引号', () => {
    for (const bad of [
      'C:\\x&y.cmd',
      'C:\\x|y.cmd',
      'C:\\x>y.cmd',
      'C:\\x<y.cmd',
      'C:\\x^y.cmd',
      'C:\\x%PATH%y.cmd',
      'C:\\x!y.cmd',
      'C:\\"x".cmd',
      'C:\\x\ny.cmd'
    ]) {
      expect(isFallbackSafe(bad, ['-v']), bad).toBe(false)
    }
  })
})


describe('.cmd / .bat 的 cmd.exe 回退（Node 22 的 EINVAL）', () => {
  it('能真正跑起一个 .cmd，并且路径含中文与空格也行', async () => {
    // Node 18.20.2 / 20.12.2 起，不带 shell 直接 spawn 批处理文件会抛 EINVAL
    // （CVE-2024-27980 的修复）。实测这个改动之前，Maven 的 mvn.cmd、
    // Gradle 的 gradle.bat、VS Code 的 code.cmd 三个自检全部失败。
    const root = mkdtempSync(join(tmpdir(), 'devkit cmd 测试-'))
    const dir = join(root, 'bin dir')
    mkdirSync(dir, { recursive: true })
    const script = join(dir, 'dk-echo.cmd')
    writeFileSync(script, '@echo off\r\necho devkit-cmd-ok\r\n', 'utf8')

    try {
      const result = await runCommand(script, [], { timeoutMs: 30_000 })
      expect(result.spawnError).toBeNull()
      expect(result.code).toBe(0)
      expect(result.stdout).toContain('devkit-cmd-ok')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)

  it('.bat 同样能跑（Gradle 用的是 gradle.bat）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'devkit-bat-'))
    const script = join(dir, 'dk-echo.bat')
    writeFileSync(script, '@echo off\r\necho devkit-bat-ok\r\n', 'utf8')

    try {
      const result = await runCommand(script, [], { timeoutMs: 30_000 })
      expect(result.spawnError).toBeNull()
      expect(result.stdout).toContain('devkit-bat-ok')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
