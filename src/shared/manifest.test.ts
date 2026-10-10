import { describe, expect, it } from 'vitest'
import type { ToolManifest, ToolVersionSpec } from './types'
import { indexById, orderDownloadSources, pickRecommendedVersion } from './manifest'

const version: ToolVersionSpec = {
  version: '24.21.0',
  channel: 'lts',
  arch: 'x64',
  installScope: 'user',
  source: { url: 'https://nodejs.org/dist/v24.21.0/node-v24.21.0-win-x64.zip' },
  mirrors: [
    { name: 'huaweicloud', url: 'https://mirrors.huaweicloud.com/nodejs/v24.21.0/x.zip' },
    { name: 'aliyun', url: 'https://mirrors.aliyun.com/nodejs-release/v24.21.0/x.zip' },
    { name: 'tuna', url: 'https://mirrors.tuna.tsinghua.edu.cn/nodejs-release/v24.21.0/x.zip' }
  ]
}

describe('orderDownloadSources', () => {
  it('官方优先时保持清单顺序', () => {
    expect(orderDownloadSources(version, 'official').map((item) => item.name)).toEqual([
      'official',
      'huaweicloud',
      'aliyun',
      'tuna'
    ])
  })

  it('选中某个镜像时把它提到第一位，其余顺序不变', () => {
    expect(orderDownloadSources(version, 'aliyun').map((item) => item.name)).toEqual([
      'aliyun',
      'official',
      'huaweicloud',
      'tuna'
    ])
  })

  it('偏好指向清单里不存在的源时不改变顺序（不报错，静默回退）', () => {
    expect(orderDownloadSources(version, 'ustc').map((item) => item.name)).toEqual([
      'official',
      'huaweicloud',
      'aliyun',
      'tuna'
    ])
  })

  it('没有任何镜像时只剩官方源', () => {
    const onlyOfficial: ToolVersionSpec = { ...version, mirrors: [] }
    expect(orderDownloadSources(onlyOfficial, 'huaweicloud').map((item) => item.name)).toEqual([
      'official'
    ])
  })

  it('完全没有下载源时返回空数组（由上层判定失败）', () => {
    const nothing: ToolVersionSpec = { ...version, source: undefined, mirrors: [] }
    expect(orderDownloadSources(nothing, 'official')).toEqual([])
  })
})

describe('pickRecommendedVersion / indexById', () => {
  const tool = {
    id: 'nodejs',
    versions: [
      { version: '24.21.0', channel: 'lts', arch: 'x64', installScope: 'user' },
      { version: '24.20.0', channel: 'lts', arch: 'x64', installScope: 'user', recommended: true }
    ]
  } as unknown as ToolManifest

  it('优先取标记了 recommended 的版本', () => {
    expect(pickRecommendedVersion(tool)?.version).toBe('24.20.0')
  })

  it('没有 recommended 时取第一个', () => {
    const noFlag = { ...tool, versions: tool.versions.slice(0, 1) } as ToolManifest
    expect(pickRecommendedVersion(noFlag)?.version).toBe('24.21.0')
  })

  it('没有任何版本时返回 null', () => {
    expect(pickRecommendedVersion({ ...tool, versions: [] } as ToolManifest)).toBeNull()
  })

  it('indexById 建立 id 索引', () => {
    const map = indexById([tool])
    expect(map.get('nodejs')).toBe(tool)
    expect(map.get('nope')).toBeUndefined()
  })
})
