import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { VscodeExtension, VscodeInstallResult, VscodeStatus } from '@shared/types'
import { runCommand } from '../../utils/exec'
import { getCurrentRoot } from '../../utils/app-paths'
import { logger } from '../report/logger'

/**
 * VS Code 插件（FR-7）。
 *
 * 三条刻意的约束：
 *  1. **只做推荐列表，不自动全装** —— 插件会改编辑器行为，属于用户该自己决定的事
 *  2. **"一键执行安装"逐条跑 `code --install-extension`**，每条单独上报结果；
 *     一条失败不影响后面的（很多插件会因为网络或版本不兼容失败）
 *  3. VS Code 不可用时面板置灰并说明原因，而不是给一个点了没反应的按钮
 *
 * 插件来源只有官方 Marketplace —— 我们不引入任何第三方插件源。
 */

interface CatalogEntry {
  id: string
  category: VscodeExtension['category']
  name: { 'zh-CN': string; 'en-US': string }
  description: { 'zh-CN': string; 'en-US': string }
}

const CATALOG: CatalogEntry[] = [
  // 前端
  {
    id: 'dbaeumer.vscode-eslint',
    category: 'frontend',
    name: { 'zh-CN': 'ESLint', 'en-US': 'ESLint' },
    description: { 'zh-CN': '在编辑器里直接看到 lint 错误', 'en-US': 'See lint errors right in the editor' }
  },
  {
    id: 'esbenp.prettier-vscode',
    category: 'frontend',
    name: { 'zh-CN': 'Prettier', 'en-US': 'Prettier' },
    description: { 'zh-CN': '保存即格式化', 'en-US': 'Format on save' }
  },
  {
    id: 'bradlc.vscode-tailwindcss',
    category: 'frontend',
    name: { 'zh-CN': 'Tailwind CSS IntelliSense', 'en-US': 'Tailwind CSS IntelliSense' },
    description: { 'zh-CN': 'Tailwind 类名补全与悬浮提示', 'en-US': 'Class completion and hover previews' }
  },
  {
    id: 'Vue.volar',
    category: 'frontend',
    name: { 'zh-CN': 'Vue - Official', 'en-US': 'Vue - Official' },
    description: { 'zh-CN': 'Vue 3 语言支持', 'en-US': 'Vue 3 language support' }
  },
  // Java
  {
    id: 'redhat.java',
    category: 'java',
    name: { 'zh-CN': 'Language Support for Java', 'en-US': 'Language Support for Java' },
    description: { 'zh-CN': 'Java 语言服务（JDT）', 'en-US': 'Java language server (JDT)' }
  },
  {
    id: 'vscjava.vscode-spring-boot-dashboard',
    category: 'java',
    name: { 'zh-CN': 'Spring Boot Dashboard', 'en-US': 'Spring Boot Dashboard' },
    description: { 'zh-CN': '在本机管理 Spring Boot 应用', 'en-US': 'Manage Spring Boot apps locally' }
  },
  // Python
  {
    id: 'ms-python.python',
    category: 'python',
    name: { 'zh-CN': 'Python', 'en-US': 'Python' },
    description: { 'zh-CN': '官方 Python 支持（含 venv 与调试）', 'en-US': 'Official Python support incl. venv and debugging' }
  },
  {
    id: 'charliermarsh.ruff',
    category: 'python',
    name: { 'zh-CN': 'Ruff', 'en-US': 'Ruff' },
    description: { 'zh-CN': '极快的 Python linter 与 formatter', 'en-US': 'Extremely fast Python linter and formatter' }
  },
  // Go / Rust / C++
  {
    id: 'golang.go',
    category: 'go',
    name: { 'zh-CN': 'Go', 'en-US': 'Go' },
    description: { 'zh-CN': 'Go 语言支持（gopls）', 'en-US': 'Go language support (gopls)' }
  },
  {
    id: 'rust-lang.rust-analyzer',
    category: 'rust',
    name: { 'zh-CN': 'rust-analyzer', 'en-US': 'rust-analyzer' },
    description: { 'zh-CN': 'Rust 语言支持', 'en-US': 'Rust language support' }
  },
  {
    id: 'ms-vscode.cpptools',
    category: 'cpp',
    name: { 'zh-CN': 'C/C++', 'en-US': 'C/C++' },
    description: { 'zh-CN': 'C/C++ 智能提示与调试', 'en-US': 'C/C++ IntelliSense and debugging' }
  },
  {
    id: 'ms-vscode.cmake-tools',
    category: 'cpp',
    name: { 'zh-CN': 'CMake Tools', 'en-US': 'CMake Tools' },
    description: { 'zh-CN': '配置、构建与调试 CMake 工程', 'en-US': 'Configure, build and debug CMake projects' }
  },
  // 通用
  {
    id: 'eamodio.gitlens',
    category: 'general',
    name: { 'zh-CN': 'GitLens', 'en-US': 'GitLens' },
    description: { 'zh-CN': '每一行的 Git 责任信息', 'en-US': 'Git blame on every line' }
  },
  {
    id: 'EditorConfig.EditorConfig',
    category: 'general',
    name: { 'zh-CN': 'EditorConfig', 'en-US': 'EditorConfig' },
    description: { 'zh-CN': '跨编辑器统一缩进与换行', 'en-US': 'Consistent indentation across editors' }
  },
  {
    id: 'usernamehw.errorlens',
    category: 'general',
    name: { 'zh-CN': 'Error Lens', 'en-US': 'Error Lens' },
    description: { 'zh-CN': '把错误直接显示在代码行尾', 'en-US': 'Show errors inline next to the code' }
  },
  {
    id: 'streetsidesoftware.code-spell-checker',
    category: 'general',
    name: { 'zh-CN': 'Code Spell Checker', 'en-US': 'Code Spell Checker' },
    description: { 'zh-CN': '拼写检查（含 camelCase 拆词）', 'en-US': 'Spell checking that understands camelCase' }
  },
  {
    id: 'yzhang.markdown-all-in-one',
    category: 'general',
    name: { 'zh-CN': 'Markdown All in One', 'en-US': 'Markdown All in One' },
    description: { 'zh-CN': 'Markdown 快捷键、目录、预览', 'en-US': 'Markdown shortcuts, TOC and preview' }
  },
  {
    id: 'MS-CEINTL.vscode-language-pack-zh-hans',
    category: 'general',
    name: { 'zh-CN': '中文（简体）语言包', 'en-US': 'Chinese (Simplified) Language Pack' },
    description: { 'zh-CN': '把 VS Code 界面变成中文', 'en-US': 'Localise the VS Code UI to Chinese' }
  }
]

/** 优先用 devkit 激活的那份 VS Code，其次是 PATH 上的 */
function resolveCode(): string | null {
  const activated = join(getCurrentRoot(), 'vscode', 'bin', 'code.cmd')
  if (existsSync(activated)) return activated
  return 'code'
}

export async function getVscodeStatus(): Promise<VscodeStatus> {
  const code = resolveCode()
  const result = await runCommand(code ?? 'code', ['--version'], { timeoutMs: 20_000 })

  if (result.spawnError || result.code !== 0) {
    return {
      available: false,
      version: null,
      codePath: null,
      detail:
        result.spawnError ??
        `code --version 退出码 ${result.code}：${result.stdout.trim() || result.stderr.trim() || '无输出'}`
    }
  }

  const version = result.stdout.split(/\r?\n/)[0]?.trim() ?? null
  return { available: true, version, codePath: code, detail: `VS Code ${version}` }
}

export function listVscodeExtensions(): VscodeExtension[] {
  return CATALOG.map((entry) => ({ ...entry, name: { ...entry.name }, description: { ...entry.description } }))
}

const EXTENSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/

export async function installVscodeExtensions(ids: unknown): Promise<VscodeInstallResult> {
  const requested = Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []
  const known = new Set(CATALOG.map((entry) => entry.id))

  // 只允许装推荐列表里的插件：这既防止渲染进程传任意 id 进来，
  // 也避免"一键安装"变成一条任意命令通道（插件 id 会进命令行）
  const targets = requested.filter((id) => EXTENSION_ID.test(id) && known.has(id))

  if (targets.length === 0) {
    return { ok: false, installed: [], failed: [], error: '没有可安装的插件（只接受推荐列表里的 id）' }
  }

  const status = await getVscodeStatus()
  if (!status.available) {
    return { ok: false, installed: [], failed: [], error: `找不到 code 命令：${status.detail}` }
  }

  const installed: string[] = []
  const failed: { id: string; error: string }[] = []

  for (const id of targets) {
    const result = await runCommand(status.codePath ?? 'code', ['--install-extension', id, '--force'], {
      timeoutMs: 180_000
    })

    if (result.spawnError) {
      failed.push({ id, error: result.spawnError })
      continue
    }
    if (result.code !== 0) {
      const output = `${result.stdout}\n${result.stderr}`.trim().split(/\r?\n/).slice(0, 2).join(' | ')
      failed.push({ id, error: `退出码 ${result.code}${output ? `：${output}` : ''}` })
      continue
    }

    installed.push(id)
    logger.info('vscode', `已安装插件 ${id}`)
  }

  logger.info('vscode', `插件安装结束：成功 ${installed.length}，失败 ${failed.length}`)
  return { ok: failed.length === 0, installed, failed, error: null }
}
