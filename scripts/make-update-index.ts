/**
 * 生成更新索引 release/latest.json（FR-13）。
 *
 * 更新检查（core/updater）会拉这个文件，比较版本号后把下载地址交给用户。
 * 支持两种格式：本脚本生成的 JSON，或 electron-builder 的 latest.yml ——
 * 两种都能被 parseUpdateIndex 解析。
 *
 * 用法：pnpm dist && pnpm release:index
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'

const RELEASE_DIR = resolve('release')

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function main(): void {
  const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { version: string }
  const version = pkg.version

  const files = readdirSync(RELEASE_DIR)
  const setup = files.find((name) => name === `devkit Setup ${version}.exe`)
  const portable = files.find((name) => name === `devkit-${version}-portable.exe`)

  if (!setup) throw new Error(`在 ${RELEASE_DIR} 里找不到 devkit Setup ${version}.exe，请先执行 pnpm dist`)
  if (!portable) throw new Error(`在 ${RELEASE_DIR} 里找不到 devkit-${version}-portable.exe，请先执行 pnpm dist`)

  const index = {
    version,
    releasedAt: new Date().toISOString(),
    url: setup,
    files: [setup, portable],
    checksums: {
      [setup]: sha256(join(RELEASE_DIR, setup)),
      [portable]: sha256(join(RELEASE_DIR, portable))
    },
    sizes: {
      [setup]: statSync(join(RELEASE_DIR, setup)).size,
      [portable]: statSync(join(RELEASE_DIR, portable)).size
    },
    notes: '见 GitHub Release 说明'
  }

  const target = join(RELEASE_DIR, 'latest.json')
  writeFileSync(target, `${JSON.stringify(index, null, 2)}\n`, 'utf8')

  console.log(`已生成 ${target}`)
  console.log(`  version  ${version}`)
  console.log(`  url      ${setup}`)
  console.log(`  sha256   ${index.checksums[setup].slice(0, 16)}…`)
}

main()
