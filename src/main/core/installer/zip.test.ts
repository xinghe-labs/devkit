import { crc32 } from 'node:zlib'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import yazl from 'yazl'
import { extractZip, isSymlinkEntry, resolveEntryPath, ZipSlipError } from './zip'

/**
 * 手工构造一个"stored"（不压缩）ZIP。
 * 用 yazl 造不出恶意条目（它会拒绝 ../），所以穿越测试必须自己拼字节。
 */
function makeStoredZip(
  entries: { name: string; data: Buffer; externalAttrs?: number }[]
): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const checksum = crc32(entry.data) >>> 0
    const size = entry.data.length

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0, 12)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(size, 18)
    local.writeUInt32LE(size, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    localParts.push(local, name, entry.data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0, 14)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(size, 20)
    central.writeUInt32LE(size, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(entry.externalAttrs ?? 0, 38)
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, name)

    offset += local.length + name.length + size
  }

  const centralBuf = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([...localParts, centralBuf, eocd])
}

/** 用 yazl 造一个带压缩的真实 ZIP（Node 官方包就是 deflate 的） */
function makeDeflatedZip(entries: { name: string; data: Buffer }[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile()
    for (const entry of entries) zip.addBuffer(entry.data, entry.name)
    const chunks: Buffer[] = []
    zip.outputStream.on('data', (chunk: Buffer) => chunks.push(chunk))
    zip.outputStream.on('error', reject)
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)))
    zip.end()
  })
}

let tmpDir = ''
let destDir = ''

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'devkit-zip-'))
  destDir = join(tmpDir, 'out')
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe('resolveEntryPath 路径穿越防护', () => {
  const dest = 'C:\\dest'

  it('正常条目落在目标目录内', () => {
    expect(resolveEntryPath(dest, 'a/b.txt', 0)).toBe(join(dest, 'a', 'b.txt'))
  })

  it('stripComponents 削掉顶层目录', () => {
    expect(resolveEntryPath(dest, 'node-v24.21.0-win-x64/node.exe', 1)).toBe(
      join(dest, 'node.exe')
    )
  })

  it('削完之后什么都不剩时返回 null（顶层目录项本身）', () => {
    expect(resolveEntryPath(dest, 'node-v24.21.0-win-x64/', 1)).toBeNull()
    expect(resolveEntryPath(dest, 'node-v24.21.0-win-x64', 1)).toBeNull()
  })

  it('反斜杠分隔也当作路径分隔符处理', () => {
    expect(resolveEntryPath(dest, 'a\\b.txt', 0)).toBe(join(dest, 'a', 'b.txt'))
  })

  it('拒绝 ../ 穿越', () => {
    for (const evil of [
      '../evil.txt',
      'a/../../evil.txt',
      '..\\evil.txt',
      'a/..',
      '../../Windows/System32/evil.dll'
    ]) {
      expect(() => resolveEntryPath(dest, evil, 0), evil).toThrow(ZipSlipError)
    }
  })

  it('拒绝绝对路径与盘符', () => {
    for (const evil of ['/etc/passwd', '\\Windows\\evil.dll', 'C:/Windows/evil.dll', 'c:\\x']) {
      expect(() => resolveEntryPath(dest, evil, 0), evil).toThrow(ZipSlipError)
    }
  })

  it('拒绝空字节', () => {
    expect(() => resolveEntryPath(dest, 'a\0b.txt', 0)).toThrow(ZipSlipError)
  })

  it('拒绝盘符相对路径（C:foo 这种 yauzl 不一定拦得住的形态）', () => {
    expect(() => resolveEntryPath(dest, 'C:evil.txt', 0)).toThrow(ZipSlipError)
  })

  it('空条目名返回 null', () => {
    expect(resolveEntryPath(dest, '', 0)).toBeNull()
    expect(resolveEntryPath(dest, './', 0)).toBeNull()
  })
})

describe('isSymlinkEntry', () => {
  it('识别符号链接模式位', () => {
    expect(isSymlinkEntry((0o120777 << 16) >>> 0)).toBe(true)
  })

  it('普通文件与目录不算', () => {
    expect(isSymlinkEntry((0o100644 << 16) >>> 0)).toBe(false)
    expect(isSymlinkEntry((0o040755 << 16) >>> 0)).toBe(false)
    expect(isSymlinkEntry(0)).toBe(false)
  })
})

describe('extractZip', () => {
  it('解压 deflate 压缩包并保持目录结构', async () => {
    const zipFile = join(tmpDir, 'a.zip')
    await writeFile(
      zipFile,
      await makeDeflatedZip([
        { name: 'top/hello.txt', data: Buffer.from('hello devkit') },
        { name: 'top/sub/deep.txt', data: Buffer.from('deep') }
      ])
    )

    const result = await extractZip({ zipFile, destDir })

    expect(result.files).toBe(2)
    expect(await readFile(join(destDir, 'top', 'hello.txt'), 'utf8')).toBe('hello devkit')
    expect(await readFile(join(destDir, 'top', 'sub', 'deep.txt'), 'utf8')).toBe('deep')
  })

  it('stripComponents=1 时把顶层目录的内容提到根上（Node 官方包的形态）', async () => {
    const zipFile = join(tmpDir, 'b.zip')
    await writeFile(
      zipFile,
      await makeDeflatedZip([
        { name: 'node-v24.21.0-win-x64/node.exe', data: Buffer.from('fake exe') },
        { name: 'node-v24.21.0-win-x64/npm.cmd', data: Buffer.from('fake cmd') }
      ])
    )

    await extractZip({ zipFile, destDir, stripComponents: 1 })

    expect(await readFile(join(destDir, 'node.exe'), 'utf8')).toBe('fake exe')
    expect(await readFile(join(destDir, 'npm.cmd'), 'utf8')).toBe('fake cmd')
    // 顶层目录不该残留
    await expect(stat(join(destDir, 'node-v24.21.0-win-x64'))).rejects.toThrow()
  })

  it('目录条目会被创建出来', async () => {
    const zipFile = join(tmpDir, 'c.zip')
    await writeFile(
      zipFile,
      makeStoredZip([{ name: 'empty/', data: Buffer.alloc(0) }])
    )

    await extractZip({ zipFile, destDir })
    expect((await stat(join(destDir, 'empty'))).isDirectory()).toBe(true)
  })

  it('遇到 ../ 条目时抛错，且不写到目标目录之外', async () => {
    const zipFile = join(tmpDir, 'evil.zip')
    await writeFile(
      zipFile,
      makeStoredZip([
        { name: 'good.txt', data: Buffer.from('fine') },
        { name: '../escaped.txt', data: Buffer.from('pwned') }
      ])
    )

    await expect(extractZip({ zipFile, destDir })).rejects.toThrow()

    // 关键断言：目标目录的上一级不能出现被穿越写出的文件。
    // 注：实测 yauzl 自己也会拒绝这类条目（invalid relative path），
    // 所以这里报的不一定是 ZipSlipError；resolveEntryPath 作为独立的第二层
    // 防线由上面的单测直接覆盖 —— 不依赖库的行为才是可靠的。
    await expect(stat(join(tmpDir, 'escaped.txt'))).rejects.toThrow()
  })

  it('遇到绝对路径条目时抛错', async () => {
    const zipFile = join(tmpDir, 'abs.zip')
    await writeFile(
      zipFile,
      makeStoredZip([{ name: 'C:/Windows/evil.dll', data: Buffer.from('pwned') }])
    )

    await expect(extractZip({ zipFile, destDir })).rejects.toThrow()
    await expect(stat(join(destDir, 'C:'))).rejects.toThrow()
  })

  it('遇到符号链接条目时拒绝解压', async () => {
    const zipFile = join(tmpDir, 'link.zip')
    await writeFile(
      zipFile,
      makeStoredZip([
        {
          name: 'link',
          data: Buffer.from('C:\\Windows\\System32'),
          externalAttrs: (0o120777 << 16) >>> 0
        }
      ])
    )

    await expect(extractZip({ zipFile, destDir })).rejects.toThrow(/符号链接/)
  })

  it('压缩包损坏时报错而不是静默产出半个目录', async () => {
    const zipFile = join(tmpDir, 'broken.zip')
    await writeFile(zipFile, Buffer.from('this is definitely not a zip file'))

    await expect(extractZip({ zipFile, destDir })).rejects.toThrow()
  })
})
