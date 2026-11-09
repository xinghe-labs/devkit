//! 直连安装提供者（对齐 `src/main/core/providers/direct.ts`，SPEC §6.3 的 DirectProvider）。
//!
//! 只负责"把已经下载并校验过的文件装到目标目录"这一件事。
//! 下载、校验、自检、状态机都在别处 —— 这样新增一种安装方式时只需要动这个文件
//! 与 templates 里的模板声明。
//!
//! 与 TS 的两处注入差异（同为依赖注入原则）：
//!  - `run_elevated`：需要管理员的安装命令交给提权助手（R5）；不传则直接执行
//!  - `path_hooks`：安装器自己改用户 PATH 的事后还原（R4 activate 模块提供）；
//!    不传则跳过比对 —— 等价 TS 里 `readUserPath().catch(() => null)` 的行为

use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;

use devkit_types::manifest::{InstallType, ToolManifest, ToolVersionSpec};
use tokio_util::sync::CancellationToken;

use crate::exec::{run_command, RunOptions};
use crate::templates::{build_command, resolve_install_template, CommandContext, InstallerCommand};
use crate::zip_extract::{
    extract_zip, extract_zip_single_file, ExtractOptions, ExtractSingleFileOptions,
};

/// 安装器最长允许跑 30 分钟（VS Code / Python 这类在慢机器上可能要几分钟）
pub const INSTALLER_TIMEOUT_MS: u64 = 30 * 60 * 1000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandLog {
    pub cmd: String,
    pub args: Vec<String>,
}

/// 命令行回调（dry-run 预览与日志用）
pub type CommandLogCallback = Arc<dyn Fn(&CommandLog) + Send + Sync>;

/// 安装器自己往用户 PATH 里加条目的事后还原钩子（R4 activate 模块提供实现）。
///
/// 为什么必须管这件事：devkit 的原则是「安装 ≠ 激活」，PATH 归激活机制统一管。
/// 但有些官方安装器（实测 VS Code 的 Inno 安装器）会**自己**往用户 PATH 写一条目录，
/// 于是用户没点过「激活」命令却能用了 —— 状态与界面不一致，而且那条 PATH 不受
/// devkit 的记录管理，将来卸载时也没人清它。
/// 试过用 /MERGETASKS=!addtopath 阻止，实测无效，所以改成"事后还原 + 明确告知"。
pub trait UserPathHooks: Send + Sync {
    /// 安装器运行前读用户 PATH 原文；None 表示读不到（跳过比对）
    fn read_before(&self) -> Option<String>;
    /// 安装器运行后读取，并返回相对 before 新增的条目
    fn added_entries(&self, before: &str) -> Vec<String>;
    /// 把用户 PATH 还原成 before
    fn restore(&self, before: &str) -> Result<(), String>;
}

/// 需要管理员的安装命令交给它执行（常驻提权助手，一次 UAC 干完所有事）。
/// Err(消息) 表示提权执行失败。
pub type ElevatedRunner = Arc<
    dyn Fn(
            &InstallerCommand,
            Option<&str>,
        ) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send>>
        + Send
        + Sync,
>;

pub struct InstallRequest {
    pub tool: ToolManifest,
    pub version: ToolVersionSpec,
    pub install_dir: PathBuf,
    pub archive_path: PathBuf,
    /// 安装器日志落盘位置
    pub log_file: PathBuf,
    /// 只演练不执行（VM 验收前的干跑）
    pub dry_run: bool,
    /// npm 可执行文件路径（由调用方解析；见 [`resolve_npm_cmd`]）
    pub npm_cmd: String,
    /// 需要管理员的安装命令交给它执行；不传时直接执行
    pub run_elevated: Option<ElevatedRunner>,
    /// 安装器改用户 PATH 的事后还原钩子；不传则跳过比对
    pub path_hooks: Option<Arc<dyn UserPathHooks>>,
    pub cancel: Option<CancellationToken>,
    /// 进度回调（参数：文件数, 当前文件字节数）
    pub on_progress: Option<Arc<dyn Fn(u64, u64) + Send + Sync>>,
    /// 命令行回调（dry-run 预览与日志用）
    pub on_command: Option<CommandLogCallback>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct InstallOutcome {
    pub install_dir: PathBuf,
    pub files: u64,
    pub bytes: u64,
    /// 安装器写日志的位置，失败时要提示用户去看
    pub log_file: Option<PathBuf>,
    /// 干跑模式没有真正执行任何安装器
    pub dry_run: bool,
    /// 安装器自己往用户 PATH 里加的条目（已被 devkit 还原）
    pub reverted_path_entries: Vec<String>,
}

#[derive(Debug, Clone, thiserror::Error)]
#[error("{message}")]
pub struct InstallError {
    pub message: String,
}

impl InstallError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl From<crate::templates::TemplateError> for InstallError {
    fn from(error: crate::templates::TemplateError) -> Self {
        InstallError::new(error.message)
    }
}

impl From<crate::zip_extract::ZipExtractError> for InstallError {
    fn from(error: crate::zip_extract::ZipExtractError) -> Self {
        InstallError::new(error.to_string())
    }
}

/// 解析 npm 可执行文件。
///
/// 顺序：devkit 激活的 Node.js → devkit 装过的最新 Node.js → PATH 上的 npm。
/// 为什么不能只用 PATH：devkit 的模型是「装进版本目录但不一定激活」，
/// 用户完全可能刚用 devkit 装了 Node.js 却没点激活，这时 PATH 上根本没有 npm。
///
/// 根路径由调用方传入（core 不依赖 app 层）；`current_root` 传 None 表示
/// 拿不到激活根目录（等价 TS 里 getCurrentRoot 抛错的场景）。
pub fn resolve_npm_cmd(current_root: Option<&Path>, versions_root: &Path) -> (String, bool) {
    // 1) 激活链接
    if let Some(root) = current_root {
        let activated = root.join("nodejs").join("npm.cmd");
        if activated.exists() {
            return (activated.to_string_lossy().into_owned(), true);
        }
    }

    // 2) 版本目录里最新的一个 Node.js
    //
    // 注意用 versions_root 而不是硬编码 join(homedir(), ".devkit", ...)：
    // 批量产物根目录是可配置的（DEVKIT_DATA_ROOT），硬编码用户主目录会让
    // 「装了 Node 但还没激活」+「自定义了根目录」这个组合找不到 npm，
    // 然后悄悄退回 PATH 上那份 —— 于是装的依赖跑到了别的 Node 下面。
    let root = versions_root.join("nodejs");
    if root.exists() {
        let mut versions: Vec<String> = std::fs::read_dir(&root)
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|entry| entry.file_name().into_string().ok())
            .filter(|name| name.chars().next().is_some_and(|c| c.is_ascii_digit()))
            .collect();
        versions.sort_by(|a, b| match devkit_types::version::compare_versions(b, a) {
            1 => std::cmp::Ordering::Greater,
            -1 => std::cmp::Ordering::Less,
            _ => std::cmp::Ordering::Equal,
        });
        for version in versions {
            let candidate = root.join(&version).join("npm.cmd");
            if candidate.exists() {
                return (candidate.to_string_lossy().into_owned(), true);
            }
        }
    }

    // 3) 交给 PATH
    ("npm.cmd".to_string(), false)
}

/// 报错里引用安装器输出时只取前 3 行（对齐 TS 的 slice(0, 3)）
fn first_lines(output: &str, limit: usize) -> String {
    output.lines().take(limit).collect::<Vec<_>>().join(" | ")
}

async fn run_installer(
    command: &InstallerCommand,
    request: &InstallRequest,
) -> Result<(Option<i32>, String, String), InstallError> {
    if let Some(on_command) = &request.on_command {
        on_command(&CommandLog {
            cmd: command.cmd.clone(),
            args: command.args.clone(),
        });
    }
    let display_args = command
        .args
        .iter()
        .map(|arg| {
            if arg.contains(' ') {
                format!("\"{arg}\"")
            } else {
                arg.clone()
            }
        })
        .collect::<Vec<_>>()
        .join(" ");
    log::info!(
        target: "installer",
        "执行安装器：{} {display_args}",
        file_name_of(&command.cmd)
    );

    let result = run_command(
        &command.cmd,
        &command.args,
        &RunOptions {
            timeout_ms: Some(INSTALLER_TIMEOUT_MS),
            env: Some(
                command
                    .env
                    .iter()
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect(),
            ),
            cancel: request.cancel.clone(),
            ..RunOptions::default()
        },
    )
    .await;

    if let Some(spawn_error) = &result.spawn_error {
        return Err(InstallError::new(format!("安装器无法启动：{spawn_error}")));
    }
    if result.timed_out {
        return Err(InstallError::new(format!(
            "安装器超时（{} 分钟）未结束，已终止",
            INSTALLER_TIMEOUT_MS / 60000
        )));
    }

    let output = format!("{}\n{}", result.stdout, result.stderr)
        .trim()
        .to_string();
    if result.code != Some(0) {
        return Err(InstallError::new(format!(
            "安装器退出码 {:?}。{}（安装器日志：{}）",
            result.code,
            if output.is_empty() {
                String::new()
            } else {
                format!("输出：{}；", first_lines(&output, 3))
            },
            request.log_file.display()
        )));
    }

    if !output.is_empty() {
        log::info!(target: "installer", "安装器输出：{}", first_lines(&output, 3));
    }
    Ok((result.code, result.stdout, result.stderr))
}

fn file_name_of(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

/// 统计目录占用（用于安装结果与卸载前的展示）
pub async fn directory_size(dir: &Path) -> u64 {
    fn walk(current: &Path, total: &mut u64) -> std::io::Result<()> {
        for entry in std::fs::read_dir(current)? {
            let entry = entry?;
            let file_type = entry.file_type()?;
            let path = entry.path();
            if file_type.is_dir() {
                walk(&path, total)?;
            } else if file_type.is_file() {
                // 文件在统计过程中被删掉，忽略
                if let Ok(meta) = std::fs::metadata(&path) {
                    *total += meta.len();
                }
            }
        }
        Ok(())
    }
    let mut total = 0u64;
    if walk(dir, &mut total).is_err() {
        return 0;
    }
    total
}

pub async fn install_version(request: &InstallRequest) -> Result<InstallOutcome, InstallError> {
    let resolved = resolve_install_template(request.version.install.as_ref())?;
    let Some(resolved) = resolved else {
        return Err(InstallError::new(format!(
            "{} 的版本 {} 没有声明安装模板，无法安装",
            request.tool.id, request.version.version
        )));
    };

    let npm = request.npm_cmd.clone();

    // npm 类模板的前置检查：给一条能直接照做的报错，而不是让用户看到
    // 「spawn npm.cmd ENOENT」这种无从下手的消息
    if resolved.template.install_type == InstallType::Npm && !request.dry_run {
        let probe = run_command(
            &npm,
            &["--version".to_string()],
            &RunOptions {
                timeout_ms: Some(30_000),
                ..RunOptions::default()
            },
        )
        .await;
        if probe.spawn_error.is_some() || probe.code != Some(0) {
            return Err(InstallError::new(format!(
                "{} 需要通过 npm 安装，但没找到可用的 npm。\n\
                 npm 随 Node.js 一起提供：请在 devkit 里把 Node.js 一起勾选安装（或先装好 Node.js 再回来）。\n\
                 已尝试的 npm 路径：{}{}",
                request.tool.id,
                npm,
                probe
                    .spawn_error
                    .map(|error| format!("（{error}）"))
                    .unwrap_or_default()
            )));
        }
    }

    let context = CommandContext {
        archive_path: request.archive_path.to_string_lossy().into_owned(),
        install_dir: request.install_dir.to_string_lossy().into_owned(),
        log_file: request.log_file.to_string_lossy().into_owned(),
        version: request.version.version.clone(),
        tool_id: request.tool.id.clone(),
        npm_cmd: npm,
    };

    if request.dry_run {
        // zip 类模板没有安装器命令（对应 TS 的 resolved.buildCommand 不存在 → null），
        // 预览为空是正常路径；安装器类模板才产出预览
        let preview = build_command(resolved.template.id, &resolved.params, &context).ok();
        if let Some(preview) = &preview {
            if let Some(on_command) = &request.on_command {
                on_command(&CommandLog {
                    cmd: preview.cmd.clone(),
                    args: preview.args.clone(),
                });
            }
        }
        log::info!(
            target: "installer",
            "[dry-run] 跳过实际安装：{}@{}",
            request.tool.id,
            request.version.version
        );
        return Ok(InstallOutcome {
            install_dir: request.install_dir.clone(),
            files: 0,
            bytes: 0,
            log_file: if preview.is_some() {
                Some(request.log_file.clone())
            } else {
                None
            },
            dry_run: true,
            reverted_path_entries: Vec::new(),
        });
    }

    // ---- 解压类模板 ----
    if let Some(plan) = &resolved.extract {
        match plan {
            crate::templates::ExtractPlan::Zip { strip_components } => {
                let mut options =
                    ExtractOptions::new(request.archive_path.clone(), request.install_dir.clone());
                options.strip_components = *strip_components as usize;
                options.cancel = request.cancel.clone();
                if let Some(on_progress) = &request.on_progress {
                    let callback = on_progress.clone();
                    options.on_progress = Some(Box::new(move |received, total| {
                        callback(received, total);
                    }));
                }
                let result = extract_zip(options).await?;
                return Ok(InstallOutcome {
                    install_dir: request.install_dir.clone(),
                    files: result.files,
                    bytes: result.bytes,
                    log_file: None,
                    dry_run: false,
                    reverted_path_entries: Vec::new(),
                });
            }
            crate::templates::ExtractPlan::ZipSingleFile {
                file_name,
                sub_dir,
                as_name,
            } => {
                let result = extract_zip_single_file(ExtractSingleFileOptions {
                    zip_file: request.archive_path.clone(),
                    dest_dir: request.install_dir.clone(),
                    file_name: file_name.clone(),
                    sub_dir: sub_dir.clone(),
                    as_name: as_name.clone(),
                    cancel: request.cancel.clone(),
                })
                .await?;
                return Ok(InstallOutcome {
                    install_dir: request.install_dir.clone(),
                    files: 1,
                    bytes: result.1,
                    log_file: None,
                    dry_run: false,
                    reverted_path_entries: Vec::new(),
                });
            }
            crate::templates::ExtractPlan::Sfx7z => {
                tokio::fs::create_dir_all(&request.install_dir)
                    .await
                    .map_err(|error| InstallError::new(format!("创建安装目录失败：{error}")))?;
                let command = InstallerCommand {
                    cmd: request.archive_path.to_string_lossy().into_owned(),
                    args: vec![
                        format!("-o{}", request.install_dir.display()),
                        "-y".to_string(),
                        "-bso0".to_string(),
                        "-bsp0".to_string(),
                    ],
                    requires_admin: false,
                    installs_outside_version_dir: false,
                    env: Default::default(),
                };
                if let Some(on_command) = &request.on_command {
                    on_command(&CommandLog {
                        cmd: command.cmd.clone(),
                        args: command.args.clone(),
                    });
                }
                log::info!(
                    target: "installer",
                    "7-Zip 自解压：{} → {}",
                    file_name_of(&command.cmd),
                    request.install_dir.display()
                );

                let result = run_command(
                    &command.cmd,
                    &command.args,
                    &RunOptions {
                        timeout_ms: Some(INSTALLER_TIMEOUT_MS),
                        cancel: request.cancel.clone(),
                        ..RunOptions::default()
                    },
                )
                .await;
                if let Some(spawn_error) = &result.spawn_error {
                    return Err(InstallError::new(format!(
                        "自解压包无法启动：{spawn_error}"
                    )));
                }
                // 7-Zip SFX 在部分版本上即使成功也返回非 0；以"目录里确实有文件"为准
                let size = directory_size(&request.install_dir).await;
                if size == 0 {
                    let output = format!("{}{}", result.stdout, result.stderr);
                    return Err(InstallError::new(format!(
                        "自解压失败：目标目录仍为空（退出码 {:?}）。{}",
                        result.code,
                        first_lines(output.trim(), 2)
                    )));
                }
                return Ok(InstallOutcome {
                    install_dir: request.install_dir.clone(),
                    files: 0,
                    bytes: size,
                    log_file: None,
                    dry_run: false,
                    reverted_path_entries: Vec::new(),
                });
            }
        }
    }

    // ---- 安装器类模板 ----
    let command = build_command(resolved.template.id, &resolved.params, &context)?;

    // 安装器可能不理会我们给的目录（rustup 这类靠环境变量），先建好目录并统计前后差异
    tokio::fs::create_dir_all(&request.install_dir)
        .await
        .map_err(|error| InstallError::new(format!("创建安装目录失败：{error}")))?;
    if let Some(parent) = request.log_file.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| InstallError::new(format!("创建日志目录失败：{error}")))?;
    }

    // 安装器类模板可能自己改用户 PATH，跑之前先留一份原文用于比对。
    // 只有 exe/msi 类需要；zip 解压不可能改环境变量。
    let path_before = request
        .path_hooks
        .as_ref()
        .and_then(|hooks| hooks.read_before());

    if command.requires_admin {
        if let Some(run_elevated) = &request.run_elevated {
            // 机器级安装（MSI / 写 HKLM）：交给提权助手，整个作业只弹一次 UAC
            run_elevated(
                &command,
                request
                    .version
                    .source
                    .as_ref()
                    .and_then(|s| s.sha256.as_deref()),
            )
            .await
            .map_err(InstallError::new)?;
        } else {
            run_installer(&command, request).await?;
        }
    } else {
        run_installer(&command, request).await?;
    }

    let mut reverted_path_entries: Vec<String> = Vec::new();
    if let (Some(hooks), Some(before)) = (&request.path_hooks, &path_before) {
        let added = hooks.added_entries(before);
        if !added.is_empty() {
            match hooks.restore(before) {
                Ok(()) => {
                    reverted_path_entries = added;
                    log::warn!(
                        target: "installer",
                        "{} 的安装器自己改了用户 PATH，已还原。被移除的条目：{}。需要让命令可用请在 devkit 里点「激活」。",
                        request.tool.id,
                        if reverted_path_entries.is_empty() {
                            "（无法定位具体条目，已整体还原）".to_string()
                        } else {
                            reverted_path_entries.join("、")
                        }
                    );
                }
                Err(error) => {
                    log::warn!(target: "installer", "检查/还原用户 PATH 失败：{error}");
                }
            }
        }
    }

    let size = directory_size(&request.install_dir).await;
    if command.installs_outside_version_dir && size == 0 {
        return Err(InstallError::new(format!(
            "安装器报告成功，但 {} 里没有任何文件。请查看安装器日志：{}",
            request.install_dir.display(),
            request.log_file.display()
        )));
    }

    Ok(InstallOutcome {
        install_dir: request.install_dir.clone(),
        files: 0,
        bytes: size,
        log_file: Some(request.log_file.clone()),
        dry_run: false,
        reverted_path_entries,
    })
}

/// 卸载时用：把一个目录整体删掉（只允许删版本目录之下的路径）
pub async fn remove_install_dir(
    install_dir: &Path,
    versions_root: &Path,
) -> Result<(), InstallError> {
    let normalized_root = versions_root
        .to_string_lossy()
        .trim_end_matches(['\\', '/'])
        .to_lowercase();
    let normalized_target = install_dir
        .to_string_lossy()
        .trim_end_matches(['\\', '/'])
        .to_lowercase();
    if normalized_target != normalized_root
        && !normalized_target.starts_with(&format!("{normalized_root}\\"))
    {
        return Err(InstallError::new(format!(
            "拒绝删除版本目录之外的路径：{}",
            install_dir.display()
        )));
    }
    tokio::fs::remove_dir_all(install_dir)
        .await
        .map_err(|error| InstallError::new(format!("删除目录失败：{error}")))
}

/// 把文件从临时位置搬到版本目录（离线包安装用）。语义对齐 `cp(from, to, {recursive:true})`：
/// from 是目录时整体复制成 to。
pub async fn copy_into_place(from: &Path, to: &Path) -> Result<(), InstallError> {
    if let Some(parent) = to.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| InstallError::new(format!("创建目录失败：{error}")))?;
    }
    copy_path_recursive(from, to).await
}

async fn copy_path_recursive(from: &Path, to: &Path) -> Result<(), InstallError> {
    copy_path_inner(from.to_path_buf(), to.to_path_buf()).await
}

fn copy_path_inner(
    from: PathBuf,
    to: PathBuf,
) -> Pin<Box<dyn Future<Output = Result<(), InstallError>> + Send>> {
    Box::pin(async move {
        let from_display = from.display().to_string();
        let meta = tokio::fs::symlink_metadata(&from)
            .await
            .map_err(|error| InstallError::new(format!("读取 {from_display} 失败：{error}")))?;
        if meta.is_file() {
            tokio::fs::copy(from, to)
                .await
                .map_err(|error| InstallError::new(format!("复制文件失败：{error}")))?;
            return Ok(());
        }
        if meta.is_dir() {
            tokio::fs::create_dir_all(&to)
                .await
                .map_err(|error| InstallError::new(format!("创建目录失败：{error}")))?;
            let mut entries = tokio::fs::read_dir(&from)
                .await
                .map_err(|error| InstallError::new(format!("读目录失败：{error}")))?;
            while let Some(entry) = entries
                .next_entry()
                .await
                .map_err(|error| InstallError::new(format!("读目录失败：{error}")))?
            {
                copy_path_inner(entry.path(), to.join(entry.file_name())).await?;
            }
            return Ok(());
        }
        // 符号链接照搬（离线包里不应有，防御性处理）
        let target = tokio::fs::read_link(&from)
            .await
            .map_err(|error| InstallError::new(format!("读链接失败：{error}")))?;
        #[cfg(windows)]
        let _ = tokio::fs::copy(&target, &to).await;
        #[cfg(not(windows))]
        tokio::fs::symlink(&target, &to)
            .await
            .map_err(|error| InstallError::new(format!("建链接失败：{error}")))?;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use devkit_types::detection::DetectSpec;
    use devkit_types::locale::LocalizedText;
    use devkit_types::manifest::{
        Arch, InstallScope, InstallSpec, InstallType, LicenseTier, ManifestStatus, SourceSpec,
        ToolCategory, ToolVersionSpec, VersionChannel,
    };

    fn names(pairs: &[(&str, &str)]) -> LocalizedText {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    fn tool(id: &str) -> ToolManifest {
        ToolManifest {
            id: id.to_string(),
            category: ToolCategory::Tool,
            tier: LicenseTier::L1,
            status: ManifestStatus::Ready,
            provider: None,
            name: names(&[("zh-CN", "假工具"), ("en-US", "Fake")]),
            description: names(&[("zh-CN", "x"), ("en-US", "x")]),
            homepage: None,
            license: None,
            detect: DetectSpec {
                commands: None,
                files: None,
                registry: None,
            },
            versions: Vec::new(),
            notes: None,
        }
    }

    fn install_spec(
        template: &str,
        install_type: InstallType,
        params: &[(&str, &str)],
    ) -> InstallSpec {
        InstallSpec {
            install_type,
            template: template.to_string(),
            params: Some(
                params
                    .iter()
                    .map(|(k, v)| (k.to_string(), v.to_string()))
                    .collect(),
            ),
        }
    }

    fn version(spec: Option<InstallSpec>) -> ToolVersionSpec {
        ToolVersionSpec {
            version: "1.0.0".to_string(),
            channel: VersionChannel::Stable,
            recommended: None,
            arch: Arch::X64,
            release_date: None,
            size_bytes: None,
            install_scope: InstallScope::User,
            requires_reboot: None,
            depends_on: None,
            source: Some(SourceSpec {
                url: "https://example.com/pkg.exe".to_string(),
                sha256: Some("a".repeat(64)),
            }),
            mirrors: None,
            install: spec,
            uninstall: None,
            activate: None,
            configure: None,
            verify: None,
        }
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("devkit-direct-{}-{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn resolve_npm_prefers_newest_version_in_root() {
        let root = temp_dir("npm");
        let node = root.join("nodejs");
        std::fs::create_dir_all(node.join("24.21.0")).unwrap();
        std::fs::create_dir_all(node.join("22.12.0")).unwrap();
        std::fs::write(node.join("22.12.0").join("npm.cmd"), b"fake").unwrap();
        std::fs::write(node.join("24.21.0").join("npm.cmd"), b"fake").unwrap();

        let (cmd, from_devkit) = resolve_npm_cmd(None, &root);
        assert!(from_devkit);
        assert!(cmd.contains("24.21.0"), "应选最新版本：{cmd}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn resolve_npm_falls_back_to_path() {
        let root = temp_dir("npm-empty");
        let (cmd, from_devkit) = resolve_npm_cmd(None, &root);
        assert!(!from_devkit);
        assert_eq!(cmd, "npm.cmd");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn dry_run_previews_without_executing() {
        let dir = temp_dir("dryrun");
        let install_dir = dir.join("install");
        let log_file = dir.join("installer.log");
        let commands = Arc::new(std::sync::Mutex::new(Vec::new()));
        let captured = commands.clone();

        let request = InstallRequest {
            tool: tool("fake-tool"),
            version: version(Some(install_spec(
                "exe-inno-silent",
                InstallType::ExeInno,
                &[],
            ))),
            install_dir: install_dir.clone(),
            archive_path: dir.join("pkg.exe"),
            log_file,
            dry_run: true,
            npm_cmd: "npm.cmd".to_string(),
            run_elevated: None,
            path_hooks: None,
            cancel: None,
            on_progress: None,
            on_command: Some(Arc::new(move |log: &CommandLog| {
                captured.lock().unwrap().push(log.clone());
            })),
        };

        let outcome = install_version(&request).await.unwrap();
        assert!(outcome.dry_run);
        assert_eq!(outcome.files, 0);
        assert_eq!(commands.lock().unwrap().len(), 1);
        // dry-run 不建目录
        assert!(!install_dir.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn zip_install_extracts_with_strip() {
        let dir = temp_dir("zip");
        let zip_path = dir.join("pkg.zip");
        // 顶层 pkg/ 一层 → stripComponents=1
        let file = std::fs::File::create(&zip_path).unwrap();
        let mut writer = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        writer.start_file("pkg/bin/tool.exe", options).unwrap();
        std::io::Write::write_all(&mut writer, b"hello-tool").unwrap();
        writer.finish().unwrap();

        let install_dir = dir.join("install");
        let request = InstallRequest {
            tool: tool("fake-tool"),
            version: version(Some(install_spec(
                "zip-into-version-dir",
                InstallType::Zip,
                &[("stripComponents", "1")],
            ))),
            install_dir: install_dir.clone(),
            archive_path: zip_path,
            log_file: dir.join("installer.log"),
            dry_run: false,
            npm_cmd: "npm.cmd".to_string(),
            run_elevated: None,
            path_hooks: None,
            cancel: None,
            on_progress: None,
            on_command: None,
        };

        let outcome = install_version(&request).await.unwrap();
        assert!(!outcome.dry_run);
        assert_eq!(outcome.files, 1);
        assert_eq!(outcome.bytes, 10);
        let installed = install_dir.join("bin").join("tool.exe");
        assert!(installed.exists(), "应落到 {installed:?}");
        assert_eq!(std::fs::read(&installed).unwrap(), b"hello-tool");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn missing_template_is_an_error() {
        let dir = temp_dir("notpl");
        let request = InstallRequest {
            tool: tool("fake-tool"),
            version: version(None),
            install_dir: dir.join("install"),
            archive_path: dir.join("pkg.exe"),
            log_file: dir.join("installer.log"),
            dry_run: false,
            npm_cmd: "npm.cmd".to_string(),
            run_elevated: None,
            path_hooks: None,
            cancel: None,
            on_progress: None,
            on_command: None,
        };
        let error = install_version(&request).await.unwrap_err();
        assert!(
            error.message.contains("没有声明安装模板"),
            "{}",
            error.message
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn remove_install_dir_rejects_outside_paths() {
        let root = temp_dir("rm-root");
        let error = remove_install_dir(Path::new("D:\\elsewhere\\tool"), &root)
            .await
            .unwrap_err();
        assert!(error.message.contains("拒绝删除"), "{}", error.message);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn remove_install_dir_allows_inside_paths() {
        let root = temp_dir("rm-inside");
        let target = root.join("tool").join("1.0.0");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("x.txt"), b"x").unwrap();
        remove_install_dir(&target, &root).await.unwrap();
        assert!(!target.exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn copy_into_place_copies_tree() {
        let dir = temp_dir("copy");
        let from = dir.join("staging").join("sub");
        std::fs::create_dir_all(&from).unwrap();
        std::fs::write(from.join("a.txt"), b"aaa").unwrap();
        std::fs::write(from.join("b.txt"), b"bbb").unwrap();
        let to = dir.join("versions").join("tool").join("1.0.0");
        copy_into_place(&from, &to).await.unwrap();
        assert_eq!(std::fs::read(to.join("a.txt")).unwrap(), b"aaa");
        assert_eq!(std::fs::read(to.join("b.txt")).unwrap(), b"bbb");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn directory_size_counts_files_recursively() {
        let dir = temp_dir("size");
        std::fs::create_dir_all(dir.join("a").join("b")).unwrap();
        std::fs::write(dir.join("a").join("x.txt"), vec![0u8; 100]).unwrap();
        std::fs::write(dir.join("a").join("b").join("y.txt"), vec![0u8; 50]).unwrap();
        let size = directory_size(&dir).await;
        assert_eq!(size, 150);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
