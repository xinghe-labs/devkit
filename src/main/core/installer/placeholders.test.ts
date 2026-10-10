import { describe, expect, it } from 'vitest'
import {
  isInstallableVersion,
  substitutePlaceholders,
  UnknownPlaceholderError
} from './placeholders'
import type { ToolVersionSpec } from '@shared/types'

const VARS = {
  installDir: 'C:\\Users\\屈\\.devkit\\versions\\nodejs\\24.21.0',
  version: '24.21.0',
  toolId: 'nodejs'
}

describe('substitutePlaceholders', () => {
  it('替换 installDir（这是"安装 ≠ 激活"的关键：自检要打绝对路径）', () => {
    expect(substitutePlaceholders('{installDir}\\node.exe', VARS)).toBe(
      'C:\\Users\\屈\\.devkit\\versions\\nodejs\\24.21.0\\node.exe'
    )
  })

  it('替换 version 与 toolId', () => {
    expect(substitutePlaceholders('{toolId}@{version}', VARS)).toBe('nodejs@24.21.0')
  })

  it('中文用户名路径不被破坏（NFR-5）', () => {
    expect(substitutePlaceholders('{installDir}\\npm.cmd', VARS)).toContain('屈')
  })

  it('没有占位符时原样返回', () => {
    expect(substitutePlaceholders('--version', VARS)).toBe('--version')
  })

  it('未知占位符直接报错，而不是原样传给命令行', () => {
    expect(() => substitutePlaceholders('{installDir}\\{evil}', VARS)).toThrow(
      UnknownPlaceholderError
    )
    expect(() => substitutePlaceholders('{installDir}\\{evil}', VARS)).toThrow(/evil/)
  })
})

describe('isInstallableVersion', () => {
  const base = {
    version: '1.0.0',
    channel: 'stable',
    arch: 'x64',
    installScope: 'user'
  } as const

  it('三要素齐全才算可安装', () => {
    expect(
      isInstallableVersion({
        ...base,
        source: { url: 'https://example.com/a.zip', sha256: 'a'.repeat(64) },
        install: { type: 'zip', template: 'zip-into-version-dir' }
      } as ToolVersionSpec)
    ).toBe(true)
  })

  it('缺 sha256 不可安装', () => {
    expect(
      isInstallableVersion({
        ...base,
        source: { url: 'https://example.com/a.zip' },
        install: { type: 'zip', template: 'zip-into-version-dir' }
      } as ToolVersionSpec)
    ).toBe(false)
  })

  it('缺安装模板不可安装', () => {
    expect(
      isInstallableVersion({
        ...base,
        source: { url: 'https://example.com/a.zip', sha256: 'a'.repeat(64) }
      } as ToolVersionSpec)
    ).toBe(false)
  })

  it('只有检测信息（detect-only 清单）不可安装', () => {
    expect(isInstallableVersion(base as ToolVersionSpec)).toBe(false)
  })
})
