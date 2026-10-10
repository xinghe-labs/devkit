/**
 * 版本号比较工具。
 *
 * 只做"主版本是否一致"这一件事，因为检测场景下追问到补丁号没有意义：
 * 装了 Node 22.23.2、清单推荐 22.12.0，这属于「同主版本，可用」，
 * 不应该报成"版本不符"去打扰用户。
 */

/** 把 "v22.23.2" / "3.13.15" / "2.47.1.windows.2" 解析成数字数组 */
export function parseVersion(input: string | null | undefined): number[] {
  if (!input) return []
  const match = input.match(/\d+(?:\.\d+)*/)
  if (!match) return []
  return match[0].split('.').map((part) => Number.parseInt(part, 10))
}

/** 从任意命令输出里抽出第一个版本号，抽不到返回 null */
export function extractVersion(output: string | null | undefined): string | null {
  if (!output) return null
  const match = output.match(/\d+\.\d+(?:\.\d+)?(?:[-.][0-9A-Za-z]+)*/)
  return match ? match[0] : null
}

/**
 * 主版本是否一致（只看第一段）。
 *
 * 这是一条刻意的宽松规则：装了 Node 22.23.2、清单推荐 22.12.0，
 * 补丁号不同不该去打扰用户；Python 3.13 与 3.14 在这里也算"同主版本"。
 * 取舍：宁可漏报"版本不同"，也不要误报 —— 误报会让用户对检测结果失去信任。
 *
 * 若将来需要更细的粒度（例如 Python 要求次要版本也一致），
 * 应该做成清单里的逐项策略（如 versionPolicy: "minor"），而不是改全局规则。
 *
 * 任一版本号解析失败时返回 true，同样是偏保守。
 */
export function sameMajor(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (left.length === 0 || right.length === 0) return true
  return left[0] === right[0]
}

/** a > b 返回 1，a < b 返回 -1，相等返回 0（逐段比较，缺失段按 0 处理） */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a)
  const right = parseVersion(b)
  const length = Math.max(left.length, right.length)
  for (let i = 0; i < length; i += 1) {
    const l = left[i] ?? 0
    const r = right[i] ?? 0
    if (l > r) return 1
    if (l < r) return -1
  }
  return 0
}
