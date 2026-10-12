import { readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { PlanSelection, Preset } from '@shared/types'
import { getPresetDir } from '../../utils/app-paths'
import { readJsonFile, writeJsonFile } from '../../utils/fs'
import { logger } from '../report/logger'

/**
 * 预设方案（FR-3）。
 *
 * 内置预设写死在代码里（不能删），用户预设落在 %APPDATA%\devkit\presets\<id>.json。
 * 预设本身只是"勾选结果"，不含任何命令 —— 所以导入别人的预设不会带来额外风险，
 * 真正的安全边界仍在清单模板那一层。
 */

const BUILTIN_PRESETS: Preset[] = [
  {
    id: 'base',
    builtin: true,
    name: { 'zh-CN': '基础必备', 'en-US': 'Essentials' },
    description: {
      'zh-CN': '无论做什么开发都用得上的四件套：Git、7-Zip、Node.js、Python',
      'en-US': 'Four things every developer needs: Git, 7-Zip, Node.js, Python'
    },
    tools: [{ toolId: 'git' }, { toolId: 'sevenzip' }, { toolId: 'nodejs' }, { toolId: 'python' }]
  },
  {
    id: 'frontend',
    builtin: true,
    name: { 'zh-CN': '前端开发', 'en-US': 'Frontend' },
    description: {
      'zh-CN': 'Node.js + pnpm + Git + VS Code，开箱即用的前端工作台',
      'en-US': 'Node.js + pnpm + Git + VS Code — a ready-to-go frontend workbench'
    },
    tools: [{ toolId: 'git' }, { toolId: 'nodejs' }, { toolId: 'pnpm' }, { toolId: 'vscode' }]
  },
  {
    id: 'java',
    builtin: true,
    name: { 'zh-CN': 'Java 后端', 'en-US': 'Java backend' },
    description: {
      'zh-CN': 'Eclipse Temurin JDK + Maven + Gradle + Git + VS Code（不用 Oracle JDK）',
      'en-US': 'Eclipse Temurin JDK + Maven + Gradle + Git + VS Code (no Oracle JDK)'
    },
    tools: [
      { toolId: 'git' },
      { toolId: 'jdk-temurin' },
      { toolId: 'maven' },
      { toolId: 'gradle' },
      { toolId: 'vscode' }
    ]
  },
  {
    id: 'python',
    builtin: true,
    name: { 'zh-CN': 'Python 开发', 'en-US': 'Python' },
    description: {
      'zh-CN': 'Python + Git + VS Code，适合脚本、爬虫与数据方向',
      'en-US': 'Python + Git + VS Code for scripting, scraping and data work'
    },
    tools: [{ toolId: 'git' }, { toolId: 'python' }, { toolId: 'vscode' }]
  },
  {
    id: 'go',
    builtin: true,
    name: { 'zh-CN': 'Go 开发', 'en-US': 'Go' },
    description: {
      'zh-CN': 'Go 工具链 + Git + VS Code',
      'en-US': 'The Go toolchain + Git + VS Code'
    },
    tools: [{ toolId: 'git' }, { toolId: 'go' }, { toolId: 'vscode' }]
  },
  {
    id: 'rust',
    builtin: true,
    name: { 'zh-CN': 'Rust 开发', 'en-US': 'Rust' },
    description: {
      'zh-CN': 'rustup + Git + VS Code（工具链落在版本目录里，不污染全局）',
      'en-US': 'rustup + Git + VS Code, with the toolchain kept inside the version directory'
    },
    tools: [{ toolId: 'git' }, { toolId: 'rust' }, { toolId: 'vscode' }]
  },
  {
    id: 'cpp',
    builtin: true,
    name: { 'zh-CN': 'C/C++ 开发', 'en-US': 'C/C++' },
    description: {
      'zh-CN': 'CMake + Ninja + Git + VS Code，配合 MSVC 或 MinGW 使用',
      'en-US': 'CMake + Ninja + Git + VS Code, to pair with MSVC or MinGW'
    },
    tools: [{ toolId: 'git' }, { toolId: 'cmake' }, { toolId: 'ninja' }, { toolId: 'vscode' }]
  },
  {
    id: 'ai',
    builtin: true,
    name: { 'zh-CN': 'AI 编码', 'en-US': 'AI coding' },
    description: {
      'zh-CN': 'Claude Code（npm 发行）+ Codex CLI（独立二进制）+ Git + Node.js + VS Code',
      'en-US': 'Claude Code (npm) + Codex CLI (standalone binary) + Git + Node.js + VS Code'
    },
    tools: [
      { toolId: 'git' },
      { toolId: 'nodejs' },
      { toolId: 'vscode' },
      { toolId: 'claude-code' },
      { toolId: 'codex' }
    ]
  },
  {
    id: 'fullstack',
    builtin: true,
    name: { 'zh-CN': '全栈 Web', 'en-US': 'Full-stack web' },
    description: {
      'zh-CN': 'Node.js + pnpm + Python + SQLite + Git + VS Code',
      'en-US': 'Node.js + pnpm + Python + SQLite + Git + VS Code'
    },
    tools: [
      { toolId: 'git' },
      { toolId: 'nodejs' },
      { toolId: 'pnpm' },
      { toolId: 'python' },
      { toolId: 'sqlite' },
      { toolId: 'vscode' }
    ]
  }
]

const PRESET_ID = /^[a-z0-9][a-z0-9-]{1,39}$/

export function listBuiltinPresets(): Preset[] {
  return BUILTIN_PRESETS.map((preset) => ({ ...preset, tools: [...preset.tools] }))
}

function sanitizeUserPreset(raw: unknown, fallbackId: string): Preset | null {
  if (typeof raw !== 'object' || raw === null) return null
  const input = raw as Partial<Preset>

  const id = typeof input.id === 'string' && PRESET_ID.test(input.id) ? input.id : fallbackId
  if (typeof input.name !== 'object' || input.name === null) return null

  const tools: PlanSelection[] = Array.isArray(input.tools)
    ? input.tools
        .filter(
          (item): item is PlanSelection =>
            typeof item === 'object' &&
            item !== null &&
            typeof (item as PlanSelection).toolId === 'string' &&
            /^[a-z0-9][a-z0-9-]{0,39}$/.test((item as PlanSelection).toolId)
        )
        .map((item) =>
          typeof item.version === 'string' && /^[0-9A-Za-z.\-_+]{1,40}$/.test(item.version)
            ? { toolId: item.toolId, version: item.version }
            : { toolId: item.toolId }
        )
    : []

  return {
    id,
    builtin: false,
    name: input.name,
    description: input.description ?? {},
    tools
  }
}

export function listUserPresets(): Preset[] {
  const dir = getPresetDir()
  const presets: Preset[] = []

  for (const name of readdirSync(dir).filter((item) => item.endsWith('.json'))) {
    try {
      const preset = sanitizeUserPreset(readJsonFile(join(dir, name)), name.replace(/\.json$/, ''))
      if (preset) presets.push(preset)
    } catch (error) {
      logger.warn('preset', `预设 ${name} 解析失败，已跳过：${(error as Error).message}`)
    }
  }

  return presets.sort((a, b) => a.id.localeCompare(b.id))
}

export function listPresets(): Preset[] {
  return [...listBuiltinPresets(), ...listUserPresets()]
}

export function saveUserPreset(input: unknown): Preset {
  const preset = sanitizeUserPreset(input, '')
  if (!preset || preset.id === '') {
    throw new Error('预设格式不合法：需要一个 1~40 位的小写 id 和至少一个名称')
  }
  if (BUILTIN_PRESETS.some((item) => item.id === preset.id)) {
    throw new Error(`"${preset.id}" 是内置预设的 id，请换一个`)
  }

  writeJsonFile(join(getPresetDir(), `${preset.id}.json`), preset)
  logger.info('preset', `已保存预设 ${preset.id}（${preset.tools.length} 项）`)
  return preset
}

export function deleteUserPreset(id: string): boolean {
  if (!PRESET_ID.test(id)) throw new Error(`预设 id 不合法：${id}`)
  if (BUILTIN_PRESETS.some((item) => item.id === id)) {
    throw new Error('内置预设不能删除')
  }

  const file = join(getPresetDir(), `${id}.json`)
  try {
    rmSync(file, { force: true })
    logger.info('preset', `已删除预设 ${id}`)
    return true
  } catch (error) {
    logger.warn('preset', `删除预设 ${id} 失败：${(error as Error).message}`)
    return false
  }
}

/** 导入：接受一份预设 JSON（例如别人分享的文件内容） */
export function importPreset(raw: unknown): Preset {
  return saveUserPreset(raw)
}
