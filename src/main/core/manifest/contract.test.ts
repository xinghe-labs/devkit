import { readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readJsonFile } from '../../utils/fs'
import { createManifestValidator, validateManifests, type RawManifestFile } from './validate'

/**
 * TS ↔ Rust 清单契约测试（MIGRATION-RUST.md §8）。
 *
 * fixtures 在 `src-tauri/tests/contract/fixtures/`，两侧共用同一批文件：
 * - accept-*.json：TS/Ajv 必须接受，Rust serde 校验器也必须接受
 * - reject-*.json：TS/Ajv 拒绝，Rust 也必须拒绝
 * - pending-plan.json：TS 形态的 InstallPlan（Rust 侧已验证能读入并回写）
 * - generated-pending-plan.json：Rust 回写产物 —— 本测试验证 TS 能读入
 *   （由 `cargo test --test manifest_contract` 每次运行生成并保持最新）
 */

const fixturesDir = resolve('src-tauri/tests/contract/fixtures')

const manifestDir = resolve('resources/manifest')
const validate = createManifestValidator(
  readJsonFile<object>(join(manifestDir, 'schema', 'tool.schema.json'))
)

function loadFixtures(prefix: string): RawManifestFile[] {
  return readdirSync(fixturesDir)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
    .map((name) => ({
      file: name,
      data: readJsonFile(join(fixturesDir, name))
    }))
}

function looksLikePlan(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const plan = value as Record<string, unknown>
  return (
    plan.schemaVersion === 1 &&
    typeof plan.planId === 'string' &&
    (plan.planId as string).length > 0 &&
    Array.isArray(plan.items)
  )
}

describe('清单契约（TS ↔ Rust 共用 fixtures）', () => {
  it('accept 样本被 Ajv 接受（与 Rust 一致）', () => {
    const files = loadFixtures('accept-')
    expect(files.length).toBeGreaterThanOrEqual(3)
    const { tools, errors } = validateManifests(files, validate)
    expect(errors).toEqual([])
    expect(tools).toHaveLength(files.length)
  })

  it('reject 样本被 Ajv 拒绝（与 Rust 一致）', () => {
    const files = loadFixtures('reject-')
    expect(files.length).toBeGreaterThanOrEqual(8)
    for (const entry of files) {
      const { tools, errors } = validateManifests([entry], validate)
      expect(
        errors.length,
        `${entry.file} 应被 Ajv 拒绝（Rust 侧已拒绝）`
      ).toBeGreaterThan(0)
      expect(tools, entry.file).toHaveLength(0)
    }
  })

  it('Rust 回写的 pending.json 能被 TS 读入（双向写兼容）', () => {
    const generated = readJsonFile(join(fixturesDir, 'generated-pending-plan.json'))
    expect(looksLikePlan(generated)).toBe(true)
    const plan = generated as { planId: string; items: unknown[] }
    expect(plan.planId).toBe('plan-8f3c1d2e')
    expect(plan.items).toHaveLength(2)
  })

  it('TS 形态的 pending.json（fixture）也通过 looksLikePlan', () => {
    const original = readJsonFile(join(fixturesDir, 'pending-plan.json'))
    expect(looksLikePlan(original)).toBe(true)
  })
})
