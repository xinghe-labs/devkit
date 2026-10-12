/**
 * IPC 参数校验。
 *
 * 渲染进程理论上不可信（一旦 XSS 或恶意页面注入，它能调到的就是这些通道），
 * 所以每个 handler 都要先过一遍这里，绝不把原始 payload 直接喂给核心逻辑。
 */

import type { PlanSelection } from '@shared/types'

export class IpcValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IpcValidationError'
  }
}

export function asOptionalObject(value: unknown, label: string): Record<string, unknown> {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new IpcValidationError(`${label} 必须是对象`)
  }
  return value as Record<string, unknown>
}

export function asOptionalStringArray(value: unknown, label: string, maxLength = 500): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new IpcValidationError(`${label} 必须是字符串数组`)
  if (value.length > maxLength) throw new IpcValidationError(`${label} 数量超过上限 ${maxLength}`)

  return value.map((item) => {
    if (typeof item !== 'string') throw new IpcValidationError(`${label} 的元素必须是字符串`)
    if (item.length === 0 || item.length > 128) {
      throw new IpcValidationError(`${label} 的元素长度必须在 1~128 之间`)
    }
    return item
  })
}

export function asBoundedInt(
  value: unknown,
  label: string,
  fallback: number,
  min: number,
  max: number
): number {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new IpcValidationError(`${label} 必须是数字`)
  }
  const rounded = Math.trunc(value)
  if (rounded < min || rounded > max) {
    throw new IpcValidationError(`${label} 必须在 ${min}~${max} 之间`)
  }
  return rounded
}

export function asNonEmptyString(value: unknown, label: string, maxLength = 128): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new IpcValidationError(`${label} 必须是不超过 ${maxLength} 字符的非空字符串`)
  }
  return value
}

/** 工具 id：与清单 Schema 保持一致的小写字母/数字/连字符 */
export function asToolId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(value)) {
    throw new IpcValidationError(`${label} 不是合法的工具 id：${String(value)}`)
  }
  return value
}

/** 可选布尔：不传就用 fallback，传了必须是真布尔（不接受字符串 "true"） */
export function asBoolean(value: unknown, label: string, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'boolean') throw new IpcValidationError(`${label} 必须是布尔值`)
  return value
}

const TOOL_ID = /^[a-z0-9][a-z0-9-]{0,39}$/
const VERSION_TEXT = /^[0-9A-Za-z.\-_+]{1,40}$/

/** 校验用户勾选结果。工具 id 与版本号都按清单约定限制字符集，避免奇怪的值流进下游 */
export function asPlanSelections(value: unknown, label: string, maxLength = 200): PlanSelection[] {
  if (!Array.isArray(value)) throw new IpcValidationError(`${label} 必须是数组`)
  if (value.length > maxLength) throw new IpcValidationError(`${label} 数量超过上限 ${maxLength}`)

  return value.map((item) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new IpcValidationError(`${label} 的元素必须是对象`)
    }
    const record = item as Record<string, unknown>
    const toolId = record.toolId
    if (typeof toolId !== 'string' || !TOOL_ID.test(toolId)) {
      throw new IpcValidationError(`${label} 的元素缺少合法的 toolId`)
    }
    const version = record.version
    if (version === undefined || version === null) return { toolId }
    if (typeof version !== 'string' || !VERSION_TEXT.test(version)) {
      throw new IpcValidationError(`${label} 的元素 version 不合法：${String(version)}`)
    }
    return { toolId, version }
  })
}
