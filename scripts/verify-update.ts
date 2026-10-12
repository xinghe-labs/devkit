/**
 * 手动验证更新包的下载与校验（不提交为单测，因为依赖网络）。
 *
 * 验证两件事：
 *  1. 哈希正确 → 落盘、verified=true
 *  2. 哈希错误 → **文件被丢弃**、verified=false、不返回路径
 *
 * 用一个真实的小文件（npmmirror 上的 npm 包）当"更新包"，
 * 因为 downloadUpdate 只关心 https + 哈希，不关心扩展名。
 */
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { downloadUpdate } from '../src/main/core/updater'
import { sha256File } from '../src/main/core/downloader/checksum'

const TARGET_DIR = 'D:\\AgentWork\\tmp\\update-verify'
const URL = 'https://registry.npmmirror.com/cowsay/-/cowsay-1.6.0.tgz'

async function main(): Promise<void> {
  rmSync(TARGET_DIR, { recursive: true, force: true })

  // 先拿到这个文件的真实哈希（用同一套下载器下载一次来算）
  console.log('步骤 1：先下载一次，算出真实 SHA-256')
  const probe = await downloadUpdate({
    url: URL,
    sha256: null,
    targetDir: join(TARGET_DIR, 'probe'),
    proxy: null
  })
  if (!probe.ok || !probe.filePath) throw new Error(`探测下载失败：${probe.error}`)
  const realHash = await sha256File(probe.filePath)
  console.log(`  ✔ 下载成功，${probe.bytes} 字节`)
  console.log(`  SHA-256 = ${realHash}`)
  console.log(`  verified = ${probe.verified}（索引没给哈希时应为 null，并且日志里有告警）`)

  // 用例 A：哈希正确
  console.log('\n步骤 2：哈希正确 → 应落盘且 verified=true')
  const good = await downloadUpdate({
    url: URL,
    sha256: realHash,
    targetDir: join(TARGET_DIR, 'good'),
    proxy: null
  })
  console.log(`  ok=${good.ok} verified=${good.verified} bytes=${good.bytes}`)
  console.log(`  filePath=${good.filePath}`)
  console.log(`  文件存在=${good.filePath ? existsSync(good.filePath) : false}`)
  if (!good.ok || good.verified !== true || !good.filePath || !existsSync(good.filePath)) {
    throw new Error('用例 A 失败：哈希正确却没落盘')
  }

  // 用例 B：哈希错误
  console.log('\n步骤 3：哈希错误 → 必须丢弃，不能留下文件')
  const bad = await downloadUpdate({
    url: URL,
    sha256: 'f'.repeat(64),
    targetDir: join(TARGET_DIR, 'bad'),
    proxy: null
  })
  console.log(`  ok=${bad.ok} verified=${bad.verified}`)
  console.log(`  error=${bad.error}`)
  const badFile = join(TARGET_DIR, 'bad', 'cowsay-1.6.0.tgz')
  const badPart = `${badFile}.part`
  console.log(`  最终文件存在=${existsSync(badFile)}（应为 false）`)
  console.log(`  断点文件存在=${existsSync(badPart)}（应为 false）`)
  if (bad.ok || bad.verified !== false || existsSync(badFile) || existsSync(badPart)) {
    throw new Error('用例 B 失败：校验失败却留下了文件')
  }

  console.log('\n全部通过：哈希正确才落盘，哈希错误一律丢弃。')
  rmSync(TARGET_DIR, { recursive: true, force: true })
}

void main()
