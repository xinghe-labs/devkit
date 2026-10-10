/**
 * 清单校验脚本。
 *
 * 用途：本地 `pnpm manifest:check`，以及 CI 里阻断不合格清单合并。
 * 之所以单独写成脚本而不是塞进 vitest：它需要在没有 electron 运行时的环境下跑。
 */
import { readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  createManifestValidator,
  validateManifests,
  type RawManifestFile
} from '../src/main/core/manifest/validate'
import { readJsonFile } from '../src/main/utils/fs'

const manifestDir = resolve('resources/manifest')
const schemaFile = join(manifestDir, 'schema', 'tool.schema.json')
const toolsDir = join(manifestDir, 'tools')

function fail(message: string): never {
  console.error(`\n✖ ${message}\n`)
  process.exit(1)
}

let validate: ReturnType<typeof createManifestValidator>
try {
  validate = createManifestValidator(readJsonFile<object>(schemaFile))
} catch (error) {
  fail(`无法读取清单 Schema：${(error as Error).message}`)
}

let names: string[]
try {
  names = readdirSync(toolsDir).filter((name) => name.endsWith('.json'))
} catch (error) {
  fail(`无法读取清单目录 ${toolsDir}：${(error as Error).message}`)
}

const files: RawManifestFile[] = []
const readErrors: { file: string; message: string }[] = []

for (const name of names) {
  try {
    files.push({ file: name, data: readJsonFile(join(toolsDir, name)) })
  } catch (error) {
    readErrors.push({ file: name, message: (error as Error).message })
  }
}

const { tools, errors } = validateManifests(files, validate)
const allErrors = [...readErrors, ...errors]

const ready = tools.filter((tool) => tool.status === 'ready')
const detectOnly = tools.filter((tool) => tool.status === 'detect-only')
const missingVersions = tools.filter((tool) => tool.versions.length === 0)
const missingSha = tools.flatMap((tool) =>
  tool.versions
    .filter((version) => !version.source?.sha256)
    .map((version) => `${tool.id}@${version.version}`)
)

console.log('清单校验结果')
console.log('─'.repeat(60))
console.log(`目录            ${manifestDir}`)
console.log(`文件总数        ${names.length}`)
console.log(`通过校验        ${tools.length}`)
console.log(`  ├ ready       ${ready.length}（安装信息完整）`)
console.log(`  └ detect-only ${detectOnly.length}（仅支持检测）`)
console.log(`校验失败        ${allErrors.length}`)

if (missingVersions.length > 0) {
  console.log(`\n尚无版本信息的清单（${missingVersions.length}）：`)
  for (const tool of missingVersions) console.log(`  · ${tool.id}`)
}

if (missingSha.length > 0) {
  console.log(`\n已声明版本但缺少 SHA-256 的条目（${missingSha.length}）：`)
  for (const item of missingSha) console.log(`  · ${item}`)
}

if (allErrors.length > 0) {
  console.log('\n失败详情：')
  for (const error of allErrors) console.log(`  ✖ ${error.file}\n      ${error.message}`)
  fail(`${allErrors.length} 个清单未通过校验`)
}

console.log('\n✔ 全部清单通过 JSON Schema 与语义校验')
