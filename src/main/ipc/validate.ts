/**
 * IPC 参数校验。
 *
 * 渲染进程理论上不可信（一旦 XSS 或恶意页面注入，它能调到的就是这些通道），
 * 所以每个 handler 都要先过一遍这里，绝不把原始 payload 直接喂给核心逻辑。
 */

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
