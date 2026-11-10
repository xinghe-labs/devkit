//! VS Code 插件（FR-7，镜像 `src/main/core/vscode/index.ts`）。
//!
//! 三条刻意的约束：
//!  1. **只做推荐列表，不自动全装** —— 插件会改编辑器行为，属于用户该自己决定的事
//!  2. **"一键执行安装"逐条跑 `code --install-extension`**，每条单独上报结果
//!  3. VS Code 不可用时面板置灰并说明原因
//!
//! 插件来源只有官方 Marketplace —— 不引入任何第三方插件源。

use crate::app_paths::get_current_root;
use crate::exec::{run_command, RunOptions};
use crate::logging;
use devkit_types::locale::LocalizedText;
use devkit_types::update::{VscodeCategory, VscodeExtension, VscodeInstallResult, VscodeStatus};

struct CatalogEntry {
    id: &'static str,
    category: VscodeCategory,
    name: (&'static str, &'static str),
    description: (&'static str, &'static str),
}

const CATALOG: &[CatalogEntry] = &[
    // AI 编码助手（放在最前面：这是现在最常被问"该装哪个"的一类）
    CatalogEntry {
        id: "saoudrizwan.claude-dev",
        category: VscodeCategory::Ai,
        name: ("Cline", "Cline"),
        description: (
            "在编辑器里自主读写文件、跑命令的 AI 助手",
            "Autonomous AI agent that edits files and runs commands in your editor",
        ),
    },
    CatalogEntry {
        id: "RooVeterinaryInc.roo-cline",
        category: VscodeCategory::Ai,
        name: ("Roo Code", "Roo Code"),
        description: (
            "Cline 的分支，支持自定义模式与多模型切换",
            "A Cline fork with custom modes and multi-model switching",
        ),
    },
    CatalogEntry {
        id: "kilocode.kilo-code",
        category: VscodeCategory::Ai,
        name: ("Kilo Code", "Kilo Code"),
        description: (
            "另一个开源 AI 编码 agent 扩展",
            "Another open-source AI coding agent extension",
        ),
    },
    CatalogEntry {
        id: "Continue.continue",
        category: VscodeCategory::Ai,
        name: ("Continue", "Continue"),
        description: (
            "可接自建/本地模型的补全与对话",
            "Completion and chat that can point at your own or local models",
        ),
    },
    CatalogEntry {
        id: "GitHub.copilot",
        category: VscodeCategory::Ai,
        name: ("GitHub Copilot", "GitHub Copilot"),
        description: (
            "行内代码补全（需订阅）",
            "Inline code completion (subscription required)",
        ),
    },
    CatalogEntry {
        id: "GitHub.copilot-chat",
        category: VscodeCategory::Ai,
        name: ("GitHub Copilot Chat", "GitHub Copilot Chat"),
        description: ("Copilot 的对话面板", "The Copilot chat panel"),
    },
    // 前端
    CatalogEntry {
        id: "dbaeumer.vscode-eslint",
        category: VscodeCategory::Frontend,
        name: ("ESLint", "ESLint"),
        description: (
            "在编辑器里直接看到 lint 错误",
            "See lint errors right in the editor",
        ),
    },
    CatalogEntry {
        id: "esbenp.prettier-vscode",
        category: VscodeCategory::Frontend,
        name: ("Prettier", "Prettier"),
        description: ("保存即格式化", "Format on save"),
    },
    CatalogEntry {
        id: "bradlc.vscode-tailwindcss",
        category: VscodeCategory::Frontend,
        name: ("Tailwind CSS IntelliSense", "Tailwind CSS IntelliSense"),
        description: (
            "Tailwind 类名补全与悬浮提示",
            "Class completion and hover previews",
        ),
    },
    CatalogEntry {
        id: "Vue.volar",
        category: VscodeCategory::Frontend,
        name: ("Vue - Official", "Vue - Official"),
        description: ("Vue 3 语言支持", "Vue 3 language support"),
    },
    // Java
    CatalogEntry {
        id: "redhat.java",
        category: VscodeCategory::Java,
        name: ("Language Support for Java", "Language Support for Java"),
        description: ("Java 语言服务（JDT）", "Java language server (JDT)"),
    },
    CatalogEntry {
        id: "vscjava.vscode-spring-boot-dashboard",
        category: VscodeCategory::Java,
        name: ("Spring Boot Dashboard", "Spring Boot Dashboard"),
        description: (
            "在本机管理 Spring Boot 应用",
            "Manage Spring Boot apps locally",
        ),
    },
    // Python
    CatalogEntry {
        id: "ms-python.python",
        category: VscodeCategory::Python,
        name: ("Python", "Python"),
        description: (
            "官方 Python 支持（含 venv 与调试）",
            "Official Python support incl. venv and debugging",
        ),
    },
    CatalogEntry {
        id: "charliermarsh.ruff",
        category: VscodeCategory::Python,
        name: ("Ruff", "Ruff"),
        description: (
            "极快的 Python linter 与 formatter",
            "Extremely fast Python linter and formatter",
        ),
    },
    // Go / Rust / C++
    CatalogEntry {
        id: "golang.go",
        category: VscodeCategory::Go,
        name: ("Go", "Go"),
        description: ("Go 语言支持（gopls）", "Go language support (gopls)"),
    },
    CatalogEntry {
        id: "rust-lang.rust-analyzer",
        category: VscodeCategory::Rust,
        name: ("rust-analyzer", "rust-analyzer"),
        description: ("Rust 语言支持", "Rust language support"),
    },
    CatalogEntry {
        id: "ms-vscode.cpptools",
        category: VscodeCategory::Cpp,
        name: ("C/C++", "C/C++"),
        description: ("C/C++ 智能提示与调试", "C/C++ IntelliSense and debugging"),
    },
    CatalogEntry {
        id: "ms-vscode.cmake-tools",
        category: VscodeCategory::Cpp,
        name: ("CMake Tools", "CMake Tools"),
        description: (
            "配置、构建与调试 CMake 工程",
            "Configure, build and debug CMake projects",
        ),
    },
    // 通用
    CatalogEntry {
        id: "eamodio.gitlens",
        category: VscodeCategory::General,
        name: ("GitLens", "GitLens"),
        description: ("每一行的 Git 责任信息", "Git blame on every line"),
    },
    CatalogEntry {
        id: "EditorConfig.EditorConfig",
        category: VscodeCategory::General,
        name: ("EditorConfig", "EditorConfig"),
        description: (
            "跨编辑器统一缩进与换行",
            "Consistent indentation across editors",
        ),
    },
    CatalogEntry {
        id: "usernamehw.errorlens",
        category: VscodeCategory::General,
        name: ("Error Lens", "Error Lens"),
        description: (
            "把错误直接显示在代码行尾",
            "Show errors inline next to the code",
        ),
    },
    CatalogEntry {
        id: "streetsidesoftware.code-spell-checker",
        category: VscodeCategory::General,
        name: ("Code Spell Checker", "Code Spell Checker"),
        description: (
            "拼写检查（含 camelCase 拆词）",
            "Spell checking that understands camelCase",
        ),
    },
    CatalogEntry {
        id: "yzhang.markdown-all-in-one",
        category: VscodeCategory::General,
        name: ("Markdown All in One", "Markdown All in One"),
        description: (
            "Markdown 快捷键、目录、预览",
            "Markdown shortcuts, TOC and preview",
        ),
    },
    CatalogEntry {
        id: "MS-CEINTL.vscode-language-pack-zh-hans",
        category: VscodeCategory::General,
        name: ("中文（简体）语言包", "Chinese (Simplified) Language Pack"),
        description: (
            "把 VS Code 界面变成中文",
            "Localise the VS Code UI to Chinese",
        ),
    },
];

fn localized(pair: (&str, &str)) -> LocalizedText {
    [
        ("zh-CN".to_string(), pair.0.to_string()),
        ("en-US".to_string(), pair.1.to_string()),
    ]
    .into_iter()
    .collect()
}

/// 优先用 devkit 激活的那份 VS Code，其次是 PATH 上的
pub fn resolve_code() -> String {
    let activated = get_current_root().join(r"vscode\bin\code.cmd");
    if activated.exists() {
        return activated.to_string_lossy().to_string();
    }
    "code".to_string()
}

pub async fn get_vscode_status() -> VscodeStatus {
    let code = resolve_code();
    let result = run_command(
        &code,
        &["--version".to_string()],
        &RunOptions {
            timeout_ms: Some(20_000),
            ..Default::default()
        },
    )
    .await;

    if result.spawn_error.is_some() || result.code != Some(0) {
        let detail = if let Some(spawn_error) = result.spawn_error {
            spawn_error
        } else {
            format!(
                "code --version 退出码 {:?}：{}",
                result.code,
                if result.stdout.trim().is_empty() {
                    result.stderr.trim().to_string()
                } else {
                    result.stdout.trim().to_string()
                }
            )
        };
        return VscodeStatus {
            available: false,
            version: None,
            code_path: None,
            detail,
        };
    }

    let version = result
        .stdout
        .lines()
        .next()
        .map(|line| line.trim().to_string());
    let detail = format!("VS Code {}", version.clone().unwrap_or_default());
    VscodeStatus {
        available: true,
        version,
        code_path: Some(code),
        detail,
    }
}

pub fn list_vscode_extensions() -> Vec<VscodeExtension> {
    CATALOG
        .iter()
        .map(|entry| VscodeExtension {
            id: entry.id.to_string(),
            category: entry.category,
            name: localized(entry.name),
            description: localized(entry.description),
        })
        .collect()
}

/// 与 TS `EXTENSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/` 一致
fn extension_id_valid(id: &str) -> bool {
    let bytes = id.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 81
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// 安装推荐列表里的插件。**只允许装推荐列表里的 id**：
/// 既防止渲染进程传任意 id 进来，也避免"一键安装"变成任意命令通道。
pub async fn install_vscode_extensions(ids: &[String]) -> VscodeInstallResult {
    let known: std::collections::HashSet<&str> = CATALOG.iter().map(|entry| entry.id).collect();
    let targets: Vec<&String> = ids
        .iter()
        .filter(|id| extension_id_valid(id) && known.contains(id.as_str()))
        .collect();

    if targets.is_empty() {
        return VscodeInstallResult {
            ok: false,
            installed: Vec::new(),
            failed: Vec::new(),
            error: Some("没有可安装的插件（只接受推荐列表里的 id）".to_string()),
        };
    }

    let status = get_vscode_status().await;
    if !status.available {
        return VscodeInstallResult {
            ok: false,
            installed: Vec::new(),
            failed: Vec::new(),
            error: Some(format!("找不到 code 命令：{}", status.detail)),
        };
    }

    let code_path = status.code_path.unwrap_or_else(|| "code".to_string());
    let mut installed: Vec<String> = Vec::new();
    let mut failed: Vec<devkit_types::update::VscodeInstallFailure> = Vec::new();

    for id in targets {
        let result = run_command(
            &code_path,
            &[
                "--install-extension".to_string(),
                id.clone(),
                "--force".to_string(),
            ],
            &RunOptions {
                timeout_ms: Some(180_000),
                ..Default::default()
            },
        )
        .await;

        if let Some(spawn_error) = result.spawn_error {
            failed.push(devkit_types::update::VscodeInstallFailure {
                id: id.clone(),
                error: spawn_error,
            });
            continue;
        }
        if result.code != Some(0) {
            let output = format!("{}\n{}", result.stdout, result.stderr)
                .trim()
                .lines()
                .take(2)
                .collect::<Vec<_>>()
                .join(" | ");
            failed.push(devkit_types::update::VscodeInstallFailure {
                id: id.clone(),
                error: format!(
                    "退出码 {:?}{}",
                    result.code,
                    if output.is_empty() {
                        String::new()
                    } else {
                        format!("：{output}")
                    }
                ),
            });
            continue;
        }

        installed.push(id.clone());
        logging::global().info("vscode", &format!("已安装插件 {id}"));
    }

    logging::global().info(
        "vscode",
        &format!(
            "插件安装结束：成功 {}，失败 {}",
            installed.len(),
            failed.len()
        ),
    );
    VscodeInstallResult {
        ok: failed.is_empty(),
        installed,
        failed,
        error: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_matches_ts_24_entries() {
        let extensions = list_vscode_extensions();
        assert_eq!(extensions.len(), 24);
        // AI 类在前
        assert!(matches!(extensions[0].category, VscodeCategory::Ai));
        // id 唯一
        let ids: std::collections::HashSet<&str> =
            extensions.iter().map(|item| item.id.as_str()).collect();
        assert_eq!(ids.len(), extensions.len());
        // 双语名称
        assert!(extensions
            .iter()
            .all(|item| item.name.contains_key("zh-CN") && item.name.contains_key("en-US")));
    }

    #[test]
    fn extension_id_validation() {
        assert!(extension_id_valid("ms-python.python"));
        assert!(extension_id_valid("MS-CEINTL.vscode-language-pack-zh-hans"));
        assert!(!extension_id_valid(""));
        assert!(!extension_id_valid("-lead"));
        assert!(!extension_id_valid("has space.x"));
        assert!(!extension_id_valid(&"a".repeat(82)));
    }

    #[test]
    fn install_rejects_unknown_ids_without_running_code() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            // 任意 id 全部被过滤 → 不跑 code，直接报错
            let result = install_vscode_extensions(&["evil.id".to_string()]).await;
            assert!(!result.ok);
            assert!(result
                .error
                .as_deref()
                .unwrap_or_default()
                .contains("只接受推荐列表里的 id"));

            // 合法 id 但本机没装 code（或装了）—— 不 panic 即可
            let result = install_vscode_extensions(&["ms-python.python".to_string()]).await;
            let _ = result;
        });
    }

    #[test]
    fn resolve_code_prefers_activated() {
        // 只验证不 panic 与返回非空
        assert!(!resolve_code().is_empty());
    }
}
