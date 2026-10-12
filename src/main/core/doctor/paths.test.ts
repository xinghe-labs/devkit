import { describe, expect, it } from 'vitest'
import {
  analyzePath,
  classifyStructuralProblem,
  expandWithReport,
  looksTruncated,
  normalizeEntry
} from './paths'

/**
 * 这些测试的夹具**直接取自开发机真实的机器级 PATH**（33 条，实测输出见下）。
 * 用真实脏数据当夹具的价值：它保证判定规则是针对"真的会发生什么"设计的，
 * 而不是针对想象的边界 —— 而且一旦规则改宽到会误删好条目，这里立刻会红。
 */
const REAL_MACHINE_PATH = [
  'C:\\Program Files\\Microsoft SDKs\\Azure\\CLI2\\wbin',
  'D:\\KingbaseES\\V8\\KESRealPro\\V008R006C009B0014\\Interface\\compress\\v8r6_compress_win\\kb_x64\\release',
  'C:\\WINDOWS\\system32',
  'C:\\WINDOWS',
  'C:\\WINDOWS\\System32\\Wbem',
  'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\',
  'C:\\WINDOWS\\System32\\OpenSSH\\',
  'D:\\MySQL\\bin',
  'D:\\MySQL\\\\bin',
  'D:\\jdk\\jdk 17\\bin',
  'D:\\My\\apache-maven-3.9.2-bin\\apache-maven-3.9.2\\bin',
  'D:\\dev\\v16.13.1',
  'C:\\Users\\屈\\AppData\\Roaming\\npm',
  'rogram Files\\dotnet\\',
  'v16.13.1',
  'node_global',
  'C:\\Program Files\\dotnet\\',
  'D:\\My\\apache-tomcat-9.0.83\\bin',
  'D:\\My\\apache-tomcat-9.0.83\\lib',
  'D:\\MinGW-W64 GCC\\mingw64\\bin',
  'D:\\redis\\',
  '%NOODE_PATH%',
  'C:\\P',
  'ogram Files\\Git\\cmd',
  'D:\\IDEA\\微信web开发者工具\\dll',
  'C:\\Program Files\\Git\\cmd',
  'D:\\Program Files\\TortoiseSVN\\bin',
  'C:\\Program Files\\GitHub CLI\\',
  'C:\\Program Files\\Go\\bin',
  'C:\\Program Files\\PowerShell\\7\\',
  'D:\\node\\',
  'C:\\Program Files\\eSpeak NG\\',
  'C:\\Program Files\\PowerShell\\7\\'
].join(';')

/** 把上面那份真实 PATH 里"存在的目录"当成存在的，其余当成不存在 */
const EXISTING = new Set(
  [
    'C:\\Program Files\\Microsoft SDKs\\Azure\\CLI2\\wbin',
    'C:\\WINDOWS\\system32',
    'C:\\WINDOWS',
    'C:\\WINDOWS\\System32\\Wbem',
    'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0',
    'C:\\WINDOWS\\System32\\OpenSSH',
    'D:\\MySQL\\bin',
    'D:\\jdk\\jdk 17\\bin',
    'D:\\My\\apache-maven-3.9.2-bin\\apache-maven-3.9.2\\bin',
    'C:\\Users\\屈\\AppData\\Roaming\\npm',
    'C:\\Program Files\\dotnet',
    'D:\\My\\apache-tomcat-9.0.83\\bin',
    'D:\\My\\apache-tomcat-9.0.83\\lib',
    'D:\\MinGW-W64 GCC\\mingw64\\bin',
    'D:\\redis',
    'D:\\IDEA\\微信web开发者工具\\dll',
    'C:\\Program Files\\Git\\cmd',
    'D:\\Program Files\\TortoiseSVN\\bin',
    'C:\\Program Files\\GitHub CLI',
    'C:\\Program Files\\Go\\bin',
    'C:\\Program Files\\PowerShell\\7',
    'D:\\node',
    'C:\\Program Files\\eSpeak NG'
  ].map((p) => p.toLowerCase())
)

const options = {
  exists: (p: string) => EXISTING.has(normalizeEntry(p)),
  env: { SystemRoot: 'C:\\WINDOWS' } as Record<string, string | undefined>
}

describe('用真实机器数据验证 PATH 分析', () => {
  const analysis = analyzePath(REAL_MACHINE_PATH, options)

  it('把 8 条坏条目 + 2 条重复全部识别出来，一条不多一条不少', () => {
    // 注意 problems 里**包含重复项** —— 重复也要清理，所以它同样是「问题」
    expect(analysis.problems.map((entry) => entry.raw)).toEqual([
      'D:\\KingbaseES\\V8\\KESRealPro\\V008R006C009B0014\\Interface\\compress\\v8r6_compress_win\\kb_x64\\release',
      'D:\\MySQL\\\\bin',
      'D:\\dev\\v16.13.1',
      'rogram Files\\dotnet\\',
      'v16.13.1',
      'node_global',
      '%NOODE_PATH%',
      'C:\\P',
      'ogram Files\\Git\\cmd',
      'C:\\Program Files\\PowerShell\\7\\'
    ])
  })

  it('按种类分开：3 条目录不存在、4 条结构畸形、1 条变量不存在', () => {
    expect(analysis.counts.missing).toBe(3)
    expect(analysis.counts.malformed).toBe(4)
    expect(analysis.counts['unexpanded-var']).toBe(1)
    expect(analysis.counts.duplicate).toBe(2)
    expect(analysis.counts.ok).toBe(23)
    expect(Object.values(analysis.counts).reduce((a, b) => a + b, 0)).toBe(33)
  })

  it('C:\\P 报"目录不存在"，并附带"像被截断"的提示（而不是直接判成畸形）', () => {
    const entry = analysis.entries.find((e) => e.raw === 'C:\\P')
    expect(entry?.kind).toBe('missing')
    expect(entry?.reason).toContain('截断')
  })

  it('ogram Files\\Git\\cmd 是结构畸形（没有盘符，不可能是有效绝对路径）', () => {
    const entry = analysis.entries.find((e) => e.raw === 'ogram Files\\Git\\cmd')
    expect(entry?.kind).toBe('malformed')
    expect(entry?.reason).toContain('不是绝对路径')
  })

  it('v16.13.1 被判为"版本号不是路径"，node_global 被判为"不是绝对路径"', () => {
    const version = analysis.entries.find((e) => e.raw === 'v16.13.1')
    expect(version?.kind).toBe('malformed')
    expect(version?.reason).toContain('版本号')

    const relative = analysis.entries.find((e) => e.raw === 'node_global')
    expect(relative?.kind).toBe('malformed')
    expect(relative?.reason).toContain('不是绝对路径')
  })

  it('%NOODE_PATH% 报的是"变量不存在"（而不是"不是绝对路径"）', () => {
    const entry = analysis.entries.find((e) => e.raw === '%NOODE_PATH%')
    expect(entry?.kind).toBe('unexpanded-var')
    expect(entry?.reason).toContain('NOODE_PATH')
  })

  it('识别出两组重复：D:\\MySQL\\bin 与 PowerShell 7', () => {
    const mysql = analysis.entries.find((e) => e.raw === 'D:\\MySQL\\\\bin')
    expect(mysql?.kind).toBe('duplicate')
    expect(mysql?.duplicateOf).toBe(8)

    const ps = analysis.entries.filter(
      (entry) => normalizeEntry(entry.raw) === 'c:\\program files\\powershell\\7'
    )
    expect(ps).toHaveLength(2)
    expect(ps[1].kind).toBe('duplicate')
    expect(ps[1].duplicateOf).toBe(ps[0].index)
  })

  it('23 条好条目一个都不能被误判', () => {
    const okEntries = analysis.entries.filter((entry) => entry.kind === 'ok')
    expect(okEntries).toHaveLength(23)
    for (const entry of okEntries) {
      expect(EXISTING.has(normalizeEntry(entry.expanded)), `${entry.raw} 被误判为 ok`).toBe(true)
    }
  })

  it('建议值只删坏条目与重复，保留原顺序与原始写法', () => {
    const kept = analysis.suggested.split(';')
    expect(kept).toHaveLength(23)
    expect(kept[0]).toBe('C:\\Program Files\\Microsoft SDKs\\Azure\\CLI2\\wbin')
    // 原始写法保留（尾随反斜杠没有被规范化掉）
    expect(kept).toContain('C:\\WINDOWS\\System32\\OpenSSH\\')
    // MySQL 保留先出现的那一种写法
    expect(kept).toContain('D:\\MySQL\\bin')
    expect(kept).not.toContain('D:\\MySQL\\\\bin')
    // PowerShell 7 只保留一条
    expect(kept.filter((p) => p === 'C:\\Program Files\\PowerShell\\7\\')).toHaveLength(1)
  })

  it('changed=true', () => {
    expect(analysis.changed).toBe(true)
  })
})

describe('classifyStructuralProblem 的边界', () => {
  it('正常路径一律返回 null（包括两字符的真实目录名）', () => {
    for (const path of [
      'C:\\WINDOWS\\system32',
      'C:\\Program Files\\PowerShell\\7\\',
      'D:\\My\\apache-maven-3.9.2-bin\\apache-maven-3.9.2\\bin',
      '\\\\server\\share\\bin',
      'C:\\Users\\屈\\AppData\\Roaming\\npm',
      // 关键：D:\\go / D:\\git 是合法目录，不能被判成"截断"
      'D:\\go',
      'D:\\git',
      'C:\\P'
    ]) {
      expect(classifyStructuralProblem(path), path).toBeNull()
    }
  })

  it('相对路径与裸版本号被判为畸形', () => {
    expect(classifyStructuralProblem('node_global')).toContain('不是绝对路径')
    expect(classifyStructuralProblem('v16.13.1')).toContain('版本号')
    expect(classifyStructuralProblem('16.13.1')).toContain('版本号')
  })

  it('只有盘符被判为畸形', () => {
    expect(classifyStructuralProblem('C:')).toContain('只有盘符')
    expect(classifyStructuralProblem('C:\\')).toContain('只有盘符')
    expect(classifyStructuralProblem('D:/')).toContain('只有盘符')
  })

  it('空条目被判为畸形', () => {
    expect(classifyStructuralProblem('   ')).toContain('空条目')
  })
})

describe('looksTruncated 只作为提示，不作为判定依据', () => {
  it('识别 C:\\P 这种截断痕迹', () => {
    expect(looksTruncated('C:\\P')).toBe(true)
    expect(looksTruncated('D:\\ab')).toBe(true)
  })

  it('三字符以上不认为是截断', () => {
    expect(looksTruncated('D:\\go\\')).toBe(false)
    expect(looksTruncated('D:\\git')).toBe(false)
    expect(looksTruncated('C:\\WINDOWS')).toBe(false)
  })

  it('它对 D:\\go 也返回 true —— 所以不能单独用它判坏（见上面的边界测试）', () => {
    // 这条断言是刻意写下来的：它记录了"为什么这个函数只能当提示"
    expect(looksTruncated('D:\\go')).toBe(true)
    expect(classifyStructuralProblem('D:\\go')).toBeNull()
  })
})

describe('expandWithReport', () => {
  it('展开已知变量并报告未知变量', () => {
    const result = expandWithReport('%SystemRoot%\\System32;%NOODE_PATH%\\bin', options.env)
    expect(result.expanded).toBe('C:\\WINDOWS\\System32;%NOODE_PATH%\\bin')
    expect(result.unresolved).toEqual(['NOODE_PATH'])
  })

  it('大小写不敏感地匹配变量名', () => {
    const result = expandWithReport('%systemroot%\\x', options.env)
    expect(result.expanded).toBe('C:\\WINDOWS\\x')
    expect(result.unresolved).toEqual([])
  })

  it('变量值为空也当作未解析（空值写进 PATH 只会产生一条垃圾）', () => {
    const result = expandWithReport('%EMPTY%\\x', { EMPTY: '' })
    expect(result.unresolved).toEqual(['EMPTY'])
  })

  it('没有 % 的普通路径原样返回', () => {
    const result = expandWithReport('C:\\Windows\\System32', options.env)
    expect(result.expanded).toBe('C:\\Windows\\System32')
    expect(result.unresolved).toEqual([])
  })
})
