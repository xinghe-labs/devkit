//! 安装执行器（SPEC FR-4 的状态机，对齐 src/main/core/executor/index.ts）。
//!
//! 四条硬性约定：
//!  1. **单项失败不中断整体** —— 记下错误继续下一项，最后汇总
//!  2. **依赖未成功则跳过** —— 而不是带着半成品硬跑
//!  3. **机器级安装串行** —— MSI/服务类安装互斥，并发只会互相踩
//!  4. **安装 ≠ 激活** —— 安装只落版本目录；激活由注入的 activate 回调负责，
//!     这样不开界面跑脚本（scripts/install-tool.ts）时不会误改用户 PATH

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard};

use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

use devkit_types::download_name::{download_file_name, DownloadNameInput};
use devkit_types::manifest::{InstallType, ToolManifest, ToolVersionSpec};
use devkit_types::plan::{InstallPlan, InstallProgressDetail, PlanItem, PlanItemState};
use devkit_types::timeutil::iso8601_now;
use devkit_types::version::extract_version;

use crate::direct::{install_version, CommandLog, ElevatedRunner, InstallOutcome, InstallRequest};
use crate::downloader::{
    download_file, DownloadPhase, DownloadProgress, DownloadRequest, DownloadSource, PhaseCallback,
    ProgressCallback,
};
use crate::exec::{run_command, RunOptions};
use crate::manifest_fns::order_download_sources;
use crate::placeholders::{substitute_placeholders, PlaceholderVars};
use crate::plan::{summarize, unfinished_items};
use crate::templates::InstallerCommand;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActivateOutcome {
    pub ok: bool,
    pub note: Option<String>,
    pub error: Option<String>,
}

/// 安装成功后激活该版本的回调；不传表示不激活。
/// 参数：(item 快照, version 规格副本, tool 清单副本)。
pub type ActivateFn = Arc<
    dyn Fn(
            PlanItem,
            ToolVersionSpec,
            ToolManifest,
        ) -> Pin<Box<dyn Future<Output = ActivateOutcome> + Send>>
        + Send
        + Sync,
>;

/// 需要管理员的安装命令交给它执行（提权助手）；不传则直接执行。
/// 参数：(说明标签, 安装器命令, 期望 sha256)。
pub type RunElevatedFn = Arc<
    dyn Fn(
            &str,
            InstallerCommand,
            Option<String>,
        ) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send>>
        + Send
        + Sync,
>;

/// 进度回调（对齐 TS 的 onUpdate）：(plan 快照, 当前项 id, 进度细节)。
pub type OnUpdateFn =
    Arc<dyn Fn(InstallPlan, Option<String>, Option<InstallProgressDetail>) + Send + Sync>;

pub struct RunPlanOptions {
    pub plan: InstallPlan,
    pub tools: HashMap<String, ToolManifest>,
    pub download_dir: PathBuf,
    /// 安装器日志目录（%APPDATA%\devkit\logs）
    pub log_dir: PathBuf,
    /// pending.json 路径；None 表示不落盘（测试场景）
    pub pending_path: Option<PathBuf>,
    /// 只演练：不执行安装器、不激活，只把命令行算出来
    pub dry_run: bool,
    pub cancel: CancellationToken,
    /// 安装成功后激活该版本；不传表示不激活
    pub activate: Option<ActivateFn>,
    /// 需要管理员的安装命令交给它执行（提权助手）；不传则直接执行
    pub run_elevated_command: Option<RunElevatedFn>,
    /// 进度回调（对齐 TS 的 onUpdate）
    pub on_update: Option<OnUpdateFn>,
    /// npm 可执行文件路径（调用方用 [`resolve_npm_cmd`] 解析后传入）
    pub npm_cmd: String,
}

/// run_plan 期间不变的计划级元数据（emit 快照重建用）
struct PlanMeta {
    schema_version: devkit_types::plan::SchemaVersion,
    plan_id: String,
    created_at: String,
    devkit_version: String,
    manifest_revision: String,
    concurrency: u32,
    mirror_preference: devkit_types::plan::MirrorPreference,
    proxy: Option<String>,
    create_restore_point: bool,
    dry_run: bool,
}

/// 共享执行状态：一个任务一个 Arc，回调闭包再 clone
struct ExecutorShared {
    meta: PlanMeta,
    tool_by_id: HashMap<String, ToolManifest>,
    items: Vec<Arc<Mutex<PlanItem>>>,
    download_dir: PathBuf,
    log_dir: PathBuf,
    pending_path: Option<PathBuf>,
    cancel: CancellationToken,
    activate: Option<ActivateFn>,
    run_elevated: Option<RunElevatedFn>,
    on_update: Option<OnUpdateFn>,
    npm_cmd: String,
    /// 机器级安装互斥（MSI/服务类必须串行）
    admin_lock: Arc<tokio::sync::Mutex<()>>,
}

impl ExecutorShared {
    fn lock_item(&self, index: usize) -> MutexGuard<'_, PlanItem> {
        self.items[index]
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn load_item(&self, index: usize) -> PlanItem {
        self.lock_item(index).clone()
    }

    fn write_item(&self, index: usize, item: &PlanItem) {
        *self.lock_item(index) = item.clone();
    }

    fn build_plan(&self, items: &[PlanItem]) -> InstallPlan {
        InstallPlan {
            schema_version: self.meta.schema_version,
            plan_id: self.meta.plan_id.clone(),
            created_at: self.meta.created_at.clone(),
            devkit_version: self.meta.devkit_version.clone(),
            manifest_revision: self.meta.manifest_revision.clone(),
            options: devkit_types::plan::PlanOptions {
                concurrency: self.meta.concurrency,
                mirror_preference: self.meta.mirror_preference,
                proxy: self.meta.proxy.clone(),
                create_restore_point: self.meta.create_restore_point,
                dry_run: self.meta.dry_run,
            },
            items: items.to_vec(),
            summary: summarize(items),
        }
    }

    /// 全量快照 + 回调（对齐 TS 的 emit）
    fn emit(&self, current_index: Option<usize>, detail: Option<InstallProgressDetail>) {
        let Some(on_update) = &self.on_update else {
            return;
        };
        let items: Vec<PlanItem> = (0..self.items.len())
            .map(|index| self.load_item(index))
            .collect();
        let plan = self.build_plan(&items);
        let current_item_id = current_index.map(|index| items[index].id.clone());
        on_update(plan, current_item_id, detail);
    }

    fn save_pending(&self, items: &[PlanItem]) {
        if let Some(path) = &self.pending_path {
            let plan = self.build_plan(items);
            if let Err(error) = crate::plan::save_pending_plan(path, &plan) {
                log::warn!(target: "executor", "pending.json 写入失败：{error}");
            }
        }
    }
}

/// TS 的 InstallType wire 值（download_file_name 要按它决定扩展名补齐）
fn install_type_tag(install_type: &InstallType) -> &'static str {
    match install_type {
        InstallType::Msi => "msi",
        InstallType::ExeNsis => "exe-nsis",
        InstallType::ExeInno => "exe-inno",
        InstallType::Exe7Zsfx => "exe-7zsfx",
        InstallType::ExeCustom => "exe-custom",
        InstallType::Zip => "zip",
        InstallType::Npm => "npm",
    }
}

struct VerifyOutcome {
    ok: bool,
    detail: String,
}

/// 运行清单里的自检命令。
/// 注意用 {installDir} 占位符指向刚装进去的那一份，而不是 PATH 上本来那一份 ——
/// 否则装了 Node 24 却跑到 Node 22，会得到假阳性（SPEC「安装 ≠ 激活」）。
async fn run_verify(item: &PlanItem, version: &ToolVersionSpec) -> VerifyOutcome {
    let Some(spec) = &version.verify else {
        return VerifyOutcome {
            ok: true,
            detail: "清单未定义自检命令".to_string(),
        };
    };
    let Some(install_dir) = &item.install_dir else {
        return VerifyOutcome {
            ok: false,
            detail: "没有安装目录，无法自检".to_string(),
        };
    };

    let vars = PlaceholderVars {
        install_dir: install_dir.clone(),
        version: item.version.clone(),
        tool_id: item.id.clone(),
    };

    let cmd = match substitute_placeholders(&spec.cmd, &vars) {
        Ok(cmd) => cmd,
        Err(error) => {
            return VerifyOutcome {
                ok: false,
                detail: format!("未知占位符 {{{}}}（出现在 {:?}）", error.name, error.input),
            };
        }
    };
    let args: Vec<String> = match &spec.args {
        Some(args) => match args
            .iter()
            .map(|arg| substitute_placeholders(arg, &vars))
            .collect::<Result<Vec<_>, _>>()
        {
            Ok(args) => args,
            Err(error) => {
                return VerifyOutcome {
                    ok: false,
                    detail: format!("未知占位符 {{{}}}（出现在 {:?}）", error.name, error.input),
                };
            }
        },
        None => Vec::new(),
    };

    if !tokio::fs::try_exists(&cmd).await.unwrap_or(false) {
        return VerifyOutcome {
            ok: false,
            detail: format!("自检目标不存在：{cmd}"),
        };
    }

    let options = RunOptions {
        cwd: Some(PathBuf::from(install_dir)),
        timeout_ms: Some(15_000),
        env: None,
        cancel: None,
    };
    let result = run_command(&cmd, &args, &options).await;
    if let Some(spawn_error) = &result.spawn_error {
        return VerifyOutcome {
            ok: false,
            detail: format!("自检命令无法执行：{spawn_error}"),
        };
    }

    let output = format!("{}\n{}", result.stdout, result.stderr)
        .trim()
        .to_string();
    let first_line = output.lines().next().unwrap_or("").to_string();

    if let Some(expect_regex) = &spec.expect_regex {
        let pattern = match regex::RegexBuilder::new(expect_regex)
            .case_insensitive(true)
            .build()
        {
            Ok(pattern) => pattern,
            Err(error) => {
                return VerifyOutcome {
                    ok: false,
                    detail: format!("自检正则非法：{error}"),
                };
            }
        };
        if !pattern.is_match(&output) {
            return VerifyOutcome {
                ok: false,
                detail: format!("自检输出不符合预期（{expect_regex}）：{first_line}"),
            };
        }
    } else if result.code != Some(0) {
        let code = result
            .code
            .map(|code| code.to_string())
            .unwrap_or_else(|| "无退出码".to_string());
        return VerifyOutcome {
            ok: false,
            detail: format!("自检命令退出码 {code}：{first_line}"),
        };
    }

    let detected = extract_version(Some(&output));
    let detail = match detected {
        Some(_) => format!("自检通过：{first_line}"),
        None => format!("自检通过（未识别出版本）：{first_line}"),
    };
    VerifyOutcome { ok: true, detail }
}

fn mark_failed(item: &mut PlanItem, message: impl Into<String>) {
    item.state = PlanItemState::Failed;
    item.error = Some(message.into());
    item.finished_at = Some(iso8601_now());
}

/// 把提权回调适配成 direct::ElevatedRunner 的签名
fn assemble_elevated_runner(
    runner: Option<RunElevatedFn>,
    label: String,
) -> Option<ElevatedRunner> {
    runner.map(|runner| {
        Arc::new(move |command: &InstallerCommand, sha256: Option<&str>| {
            let runner = runner.clone();
            let label = label.clone();
            let command = command.clone();
            let sha256 = sha256.map(|value| value.to_string());
            Box::pin(async move { runner(&label, command, sha256).await })
                as Pin<Box<dyn Future<Output = Result<(), String>> + Send>>
        }) as ElevatedRunner
    })
}

/// 单项执行（对齐 TS 的 runItem）。返回 Err 时由调用方 mark_failed。
async fn run_item(shared: Arc<ExecutorShared>, index: usize) -> Result<(), String> {
    let item_id = shared.load_item(index).id.clone();
    let item_version = shared.load_item(index).version.clone();

    let Some(tool) = shared.tool_by_id.get(&item_id).cloned() else {
        let mut item = shared.load_item(index);
        mark_failed(&mut item, "清单里找不到这个工具");
        shared.write_item(index, &item);
        shared.emit(Some(index), None);
        return Ok(());
    };
    let Some(version) = tool
        .versions
        .iter()
        .find(|entry| entry.version == item_version)
        .cloned()
    else {
        let mut item = shared.load_item(index);
        mark_failed(&mut item, format!("清单里找不到版本 {item_version}"));
        shared.write_item(index, &item);
        shared.emit(Some(index), None);
        return Ok(());
    };

    {
        let mut item = shared.lock_item(index);
        item.started_at = Some(iso8601_now());
        item.attempts += 1;
    }
    log::info!(target: "executor", "开始处理 {item_id}@{item_version}");

    // 0. 幂等（NFR-2）：目录已存在且自检通过，就不重复下载安装
    let mut item = shared.load_item(index);
    if let Some(install_dir) = item.install_dir.clone() {
        if Path::new(&install_dir).exists() {
            let verify = run_verify(&item, &version).await;
            if verify.ok {
                item.state = PlanItemState::Success;
                item.note = Some(format!("已安装，跳过（{}）", verify.detail));
                item.finished_at = Some(iso8601_now());
                shared.write_item(index, &item);
                log::info!(target: "executor", "{item_id} 已安装且自检通过，跳过");
                if let (Some(activate), Some(_)) = (&shared.activate, version.activate.as_ref()) {
                    let outcome = activate(item.clone(), version.clone(), tool.clone()).await;
                    if !outcome.ok {
                        log::warn!(
                            target: "executor",
                            "{item_id} 已安装但激活失败：{:?}",
                            outcome.error
                        );
                    }
                }
                shared.emit(Some(index), None);
                return Ok(());
            }
            log::warn!(
                target: "executor",
                "{item_id} 目录已存在但自检未通过，将重新安装：{}",
                verify.detail
            );
        }
    }

    // 1. 下载（含 SHA-256 校验与镜像回退）
    let sources = order_download_sources(&version, &shared.meta.mirror_preference);
    if sources.is_empty() {
        return Err("清单没有给出任何下载源".to_string());
    }

    // 命名规则见 devkit_types::download_name —— 离线包制作走的是同一个函数，
    // 两边不一致会让离线安装必然失败（曾经就是这样：VS Code 那个 /stable 的 URL）。
    let archive_name = download_file_name(&DownloadNameInput {
        tool_id: &item.id,
        version: &item.version,
        url: &sources[0].url,
        install_type: version
            .install
            .as_ref()
            .map(|spec| install_type_tag(&spec.install_type)),
    })
    .map_err(|error| format!("下载文件名生成失败：{error}"))?;
    let archive_path = shared.download_dir.join(archive_name);
    item.archive_path = Some(archive_path.display().to_string());

    item.state = PlanItemState::Downloading;
    shared.write_item(index, &item);
    shared.emit(
        Some(index),
        Some(InstallProgressDetail {
            received: Some(0),
            total: Some(version.size_bytes),
            source: Some(sources[0].name.clone()),
        }),
    );

    let progress_callback: ProgressCallback = {
        let shared = shared.clone();
        Box::new(move |progress: &DownloadProgress| {
            shared.emit(
                Some(index),
                Some(InstallProgressDetail {
                    received: Some(progress.received),
                    total: Some(progress.total),
                    source: Some(progress.source.clone()),
                }),
            );
        })
    };
    let phase_callback: PhaseCallback = {
        let shared = shared.clone();
        Box::new(move |phase: DownloadPhase, _source: &str| {
            let state = match phase {
                DownloadPhase::Downloading => PlanItemState::Downloading,
                DownloadPhase::Verifying => PlanItemState::Verifying,
            };
            let mut item = shared.lock_item(index);
            item.state = state;
        })
    };

    let download_sources: Vec<DownloadSource> = sources
        .iter()
        .map(|source| DownloadSource {
            name: source.name.clone(),
            url: source.url.clone(),
        })
        .collect();
    let request = DownloadRequest {
        sources: download_sources,
        sha256: version
            .source
            .as_ref()
            .and_then(|source| source.sha256.clone())
            .unwrap_or_default(),
        size_bytes: version.size_bytes,
        target_file: archive_path.clone(),
        proxy: shared.meta.proxy.clone(),
        timeout_ms: None,
        idle_timeout_ms: None,
        min_speed_bytes_per_sec: None,
        speed_grace_ms: None,
        retries_per_source: None,
        allow_insecure: false,
        cancel: Some(shared.cancel.clone()),
        on_progress: Some(progress_callback),
        on_phase: Some(phase_callback),
    };
    let download = download_file(&request).await;

    // 无论成功失败都把尝试记录留下来，报告里要展示"试过哪些源、各自为什么失败"
    let mut item = shared.load_item(index);
    item.download_attempts = Some(
        download
            .attempts
            .iter()
            .map(|attempt| devkit_types::plan::DownloadAttempt {
                source: attempt.source.clone(),
                url: attempt.url.clone(),
                error: attempt.error.clone(),
            })
            .collect(),
    );
    shared.write_item(index, &item);

    if !download.ok {
        return Err(download.error.unwrap_or_else(|| "下载失败".to_string()));
    }

    // 2. 安装
    {
        let mut item = shared.lock_item(index);
        item.state = PlanItemState::Installing;
    }
    shared.emit(Some(index), None);

    let log_file = shared
        .log_dir
        .join(format!("installer-{item_id}-{item_version}.log"));
    let elevated = assemble_elevated_runner(
        shared.run_elevated.clone(),
        format!("安装 {item_id}@{item_version}"),
    );
    let on_command: Arc<dyn Fn(&CommandLog) + Send + Sync> = {
        let item_id = item_id.clone();
        Arc::new(move |command: &CommandLog| {
            log::info!(
                target: "executor",
                "[dry-run] {item_id} 将执行：{} {}",
                command.cmd,
                command.args.join(" ")
            );
        })
    };
    let install_request = InstallRequest {
        tool: tool.clone(),
        version: version.clone(),
        install_dir: PathBuf::from(item.install_dir.clone().unwrap_or_default()),
        archive_path: archive_path.clone(),
        log_file,
        dry_run: shared.meta.dry_run,
        npm_cmd: shared.npm_cmd.clone(),
        run_elevated: elevated,
        // R2 先不接 PATH 还原钩子（R4 activate 模块提供 UserPathHooks 实现后再穿线）
        path_hooks: None,
        cancel: Some(shared.cancel.clone()),
        on_progress: Some({
            let shared = shared.clone();
            Arc::new(move |files: u64, _bytes: u64| {
                shared.emit(
                    Some(index),
                    Some(InstallProgressDetail {
                        received: Some(files),
                        total: None,
                        source: None,
                    }),
                );
            })
        }),
        on_command: Some(on_command),
    };
    let outcome: InstallOutcome = install_version(&install_request)
        .await
        .map_err(|error| error.message)?;
    log::info!(
        target: "executor",
        "{item_id} 安装完成：{} 个文件 / {} 字节 → {}",
        outcome.files,
        outcome.bytes,
        outcome.install_dir.display()
    );

    if shared.meta.dry_run {
        let mut item = shared.lock_item(index);
        item.state = PlanItemState::Success;
        item.note = Some("干跑模式：只演练命令行，未真正安装".to_string());
        item.finished_at = Some(iso8601_now());
        drop(item);
        shared.emit(Some(index), None);
        return Ok(());
    }

    // 3. 自检 —— 自检不过等于失败，即使解压过程毫无问题
    {
        let mut item = shared.lock_item(index);
        item.state = PlanItemState::Checking;
    }
    shared.emit(Some(index), None);
    let item = shared.load_item(index);
    let verify = run_verify(&item, &version).await;
    if !verify.ok {
        return Err(format!("自检未通过：{}", verify.detail));
    }

    // 4. 激活（可选）：把这份安装接到用户 PATH / 环境变量里
    let mut note = verify.detail.clone();
    if !outcome.reverted_path_entries.is_empty() {
        note += &format!(
            "；安装器自己加的 PATH 条目已还原（{}），需要的话请点「激活」",
            outcome.reverted_path_entries.join("、")
        );
    }
    if let (Some(activate), Some(_)) = (&shared.activate, version.activate.as_ref()) {
        let activated = activate(item.clone(), version.clone(), tool.clone()).await;
        if activated.ok {
            note = format!(
                "{}；{}",
                verify.detail,
                activated.note.unwrap_or_else(|| "已激活".to_string())
            );
        } else {
            // 激活失败不算安装失败：文件已经装好且自检通过，用户仍可手动用绝对路径
            let activate_error = activated
                .error
                .clone()
                .unwrap_or_else(|| "未知原因".to_string());
            note = format!("{}；激活失败：{}", verify.detail, activate_error);
            log::warn!(target: "executor", "{item_id} 激活失败：{activate_error}");
        }
    }

    let mut item = shared.lock_item(index);
    item.state = PlanItemState::Success;
    item.note = Some(note);
    item.finished_at = Some(iso8601_now());
    drop(item);
    shared.emit(Some(index), None);
    Ok(())
}

/// 运行安装计划（对齐 TS 的 runPlan 主循环）。
pub async fn run_plan(options: RunPlanOptions) -> InstallPlan {
    let RunPlanOptions {
        plan,
        tools,
        download_dir,
        log_dir,
        pending_path,
        dry_run,
        cancel,
        activate,
        run_elevated_command,
        on_update,
        npm_cmd,
    } = options;

    let concurrency = plan.options.concurrency.clamp(1, 3);
    let meta = PlanMeta {
        schema_version: plan.schema_version,
        plan_id: plan.plan_id.clone(),
        created_at: plan.created_at.clone(),
        devkit_version: plan.devkit_version.clone(),
        manifest_revision: plan.manifest_revision.clone(),
        concurrency,
        mirror_preference: plan.options.mirror_preference,
        proxy: plan.options.proxy.clone(),
        create_restore_point: plan.options.create_restore_point,
        dry_run: dry_run || plan.options.dry_run,
    };
    let items: Vec<Arc<Mutex<PlanItem>>> = plan
        .items
        .iter()
        .map(|item| Arc::new(Mutex::new(item.clone())))
        .collect();
    let started_at = std::time::Instant::now();

    let shared = Arc::new(ExecutorShared {
        meta,
        tool_by_id: tools,
        items,
        download_dir,
        log_dir,
        pending_path,
        cancel,
        activate,
        run_elevated: run_elevated_command,
        on_update,
        npm_cmd,
        admin_lock: Arc::new(tokio::sync::Mutex::new(())),
    });

    shared.save_pending(&{
        (0..shared.items.len())
            .map(|index| shared.load_item(index))
            .collect::<Vec<_>>()
    });
    shared.emit(None, None);

    let id_to_index: HashMap<String, usize> = {
        let mut map: HashMap<String, usize> = HashMap::new();
        for (index, item) in shared.items.iter().enumerate() {
            map.insert(
                item.lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .id
                    .clone(),
                index,
            );
        }
        map
    };

    let mut remaining: Vec<usize> = (0..shared.items.len()).collect();
    let mut finished: HashSet<usize> = HashSet::new();
    let mut succeeded: HashSet<usize> = HashSet::new();
    let mut in_flight: JoinSet<(usize, PlanItemState)> = JoinSet::new();

    while !remaining.is_empty() || !in_flight.is_empty() {
        // 扫描一遍待办：能起的起，依赖已失败的直接跳过（对齐 TS 的 startReady）
        let mut launched: Vec<usize> = Vec::new();
        remaining.retain(|&index| {
            if in_flight.len() >= concurrency as usize {
                return true;
            }
            let item = shared.load_item(index);
            // 只看计划内的依赖；计划外依赖视为已满足（对齐 TS 的 inPlan 过滤）
            let deps_in_plan: Vec<usize> = item
                .depends_on
                .iter()
                .filter_map(|id| id_to_index.get(id).copied())
                .collect();
            if deps_in_plan.iter().any(|dep| !finished.contains(dep)) {
                return true;
            }

            let blocked: Vec<String> = item
                .depends_on
                .iter()
                .filter(|id| {
                    id_to_index
                        .get(*id)
                        .is_some_and(|dep| !succeeded.contains(dep))
                })
                .cloned()
                .collect();
            if !blocked.is_empty() {
                let mut item = shared.lock_item(index);
                item.state = PlanItemState::Skipped;
                item.note = Some(format!("依赖未成功：{}", blocked.join("、")));
                item.finished_at = Some(iso8601_now());
                log::warn!(target: "executor", "{} 已跳过：{}", item.id, item.note.clone().unwrap_or_default());
                drop(item);
                shared.emit(Some(index), None);
                finished.insert(index);
                return false;
            }

            if shared.cancel.is_cancelled() {
                let mut item = shared.lock_item(index);
                item.state = PlanItemState::Cancelled;
                item.note = Some("用户取消".to_string());
                item.finished_at = Some(iso8601_now());
                drop(item);
                shared.emit(Some(index), None);
                finished.insert(index);
                return false;
            }

            launched.push(index);
            false
        });

        for index in launched {
            let shared_inner = shared.clone();
            let shared = shared.clone();
            let requires_admin = shared.load_item(index).requires_admin;
            let admin_lock = shared.admin_lock.clone();
            in_flight.spawn(async move {
                // 内层 spawn 捕获 panic（JoinError），外层知道 index 能把该项标成失败
                let inner = tokio::spawn(async move {
                    let result = if requires_admin {
                        let _guard = admin_lock.lock().await;
                        run_item(shared_inner.clone(), index).await
                    } else {
                        run_item(shared_inner.clone(), index).await
                    };
                    match result {
                        Ok(()) => shared_inner.load_item(index).state,
                        Err(message) => {
                            let mut item = shared_inner.lock_item(index);
                            mark_failed(&mut item, message);
                            let state = item.state;
                            let id = item.id.clone();
                            let error = item.error.clone();
                            drop(item);
                            log::error!(target: "executor", "{id} 失败：{}", error.unwrap_or_default());
                            shared_inner.emit(Some(index), None);
                            state
                        }
                    }
                });
                match inner.await {
                    Ok(state) => (index, state),
                    Err(join_error) => {
                        log::error!(target: "executor", "任务 panic：{join_error}");
                        let mut item = shared.lock_item(index);
                        mark_failed(&mut item, "任务异常结束");
                        let state = item.state;
                        drop(item);
                        shared.emit(Some(index), None);
                        (index, state)
                    }
                }
            });
        }

        if in_flight.is_empty() {
            if remaining.is_empty() {
                break;
            }
            // 没有在跑的任务、也起不来新的 —— 只可能是依赖环；标记掉，别死循环
            for index in remaining.drain(..) {
                let mut item = shared.lock_item(index);
                item.state = PlanItemState::Skipped;
                item.note = Some("依赖无法满足（可能存在依赖环）".to_string());
                item.finished_at = Some(iso8601_now());
                drop(item);
                shared.emit(Some(index), None);
                finished.insert(index);
            }
            break;
        }

        if let Some(joined) = in_flight.join_next().await {
            let (index, state) = match joined {
                Ok(pair) => pair,
                Err(join_error) => {
                    log::error!(target: "executor", "任务异常退出：{join_error}");
                    continue;
                }
            };
            finished.insert(index);
            if state == PlanItemState::Success {
                succeeded.insert(index);
            }
            if state == PlanItemState::Failed {
                let mut item = shared.lock_item(index);
                if item.state != PlanItemState::Failed {
                    mark_failed(&mut item, "任务异常结束");
                }
            }
        }
    }

    let final_items: Vec<PlanItem> = (0..shared.items.len())
        .map(|index| shared.load_item(index))
        .collect();
    let remaining_items = unfinished_items(&shared.build_plan(&final_items));

    if remaining_items.is_empty() {
        if let Some(path) = &shared.pending_path {
            if let Err(error) = crate::plan::clear_pending_plan(path) {
                log::warn!(target: "executor", "pending.json 清理失败：{error}");
            }
        }
        let summary = summarize(&final_items);
        log::info!(
            target: "executor",
            "安装流程结束：成功 {}，失败 {}，跳过 {}，取消 {}，耗时 {}ms",
            summary.success,
            summary.failed,
            summary.skipped,
            summary.cancelled,
            started_at.elapsed().as_millis()
        );
    } else {
        shared.save_pending(&final_items);
        log::warn!(
            target: "executor",
            "安装流程结束，仍有 {} 项未完成，已保留 pending.json 供续跑",
            remaining_items.len()
        );
    }

    shared.emit(None, None);

    let mut plan = plan;
    plan.items = final_items;
    plan.summary = summarize(&plan.items);
    plan
}

#[cfg(test)]
mod tests {
    use super::*;
    use devkit_types::detection::DetectCommandSpec;
    use devkit_types::manifest::{
        Arch, InstallScope, LicenseTier, ManifestStatus, ToolCategory, VersionChannel,
    };
    use devkit_types::plan::{PlanOptions, PlanSummary};

    fn names(pairs: &[(&str, &str)]) -> devkit_types::locale::LocalizedText {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    fn tool(id: &str, verify: Option<DetectCommandSpec>) -> ToolManifest {
        let version = ToolVersionSpec {
            version: "1.0.0".to_string(),
            channel: VersionChannel::Stable,
            recommended: None,
            arch: Arch::X64,
            release_date: None,
            size_bytes: None,
            install_scope: InstallScope::User,
            requires_reboot: None,
            depends_on: None,
            source: None,
            mirrors: None,
            install: None,
            uninstall: None,
            activate: None,
            configure: None,
            verify,
        };
        ToolManifest {
            id: id.to_string(),
            category: ToolCategory::Tool,
            tier: LicenseTier::L1,
            status: ManifestStatus::Ready,
            provider: None,
            name: names(&[("zh-CN", id), ("en-US", id)]),
            description: names(&[("zh-CN", id), ("en-US", id)]),
            homepage: None,
            license: None,
            detect: Default::default(),
            versions: vec![version],
            notes: None,
        }
    }

    fn item(id: &str, depends_on: &[&str], install_dir: Option<String>) -> PlanItem {
        PlanItem {
            id: id.to_string(),
            version: "1.0.0".to_string(),
            tier: LicenseTier::L1,
            install_scope: InstallScope::User,
            requires_admin: false,
            requires_reboot: false,
            depends_on: depends_on.iter().map(|value| value.to_string()).collect(),
            state: PlanItemState::Pending,
            attempts: 0,
            error: None,
            note: None,
            started_at: None,
            finished_at: None,
            install_dir,
            archive_path: None,
            download_attempts: None,
        }
    }

    fn make_plan(items: Vec<PlanItem>) -> InstallPlan {
        InstallPlan {
            schema_version: devkit_types::plan::SchemaVersion::One,
            plan_id: "plan-1".to_string(),
            created_at: iso8601_now(),
            devkit_version: "0.6.2".to_string(),
            manifest_revision: "test".to_string(),
            options: PlanOptions {
                concurrency: 2,
                mirror_preference: devkit_types::plan::MirrorPreference::Official,
                proxy: None,
                create_restore_point: false,
                dry_run: false,
            },
            items,
            summary: PlanSummary::default(),
        }
    }

    async fn run_for_test(plan: InstallPlan, tools: HashMap<String, ToolManifest>) -> InstallPlan {
        let dir = std::env::temp_dir().join(format!(
            "devkit-executor-{}-{}",
            plan.plan_id,
            std::process::id()
        ));
        let _ = tokio::fs::remove_dir_all(&dir).await;
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let options = RunPlanOptions {
            plan,
            tools,
            download_dir: dir.join("downloads"),
            log_dir: dir.join("logs"),
            pending_path: None,
            dry_run: false,
            cancel: CancellationToken::new(),
            activate: None,
            run_elevated_command: None,
            on_update: None,
            npm_cmd: "npm.cmd".to_string(),
        };
        let result = run_plan(options).await;
        let _ = tokio::fs::remove_dir_all(&dir).await;
        result
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn idempotent_skip_when_verify_passes() {
        // 目录已存在 + 自检命令（cmd /c echo）通过 → 直接跳过，不下载不安装
        let dir = std::env::temp_dir().join(format!("devkit-exec-idem-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let verify = DetectCommandSpec {
            // verify 要求 cmd 存在（与 TS existsSync 语义一致），所以用绝对路径
            cmd: r"C:\Windows\System32\cmd.exe".to_string(),
            args: Some(vec!["/c".to_string(), "echo 1.0.0".to_string()]),
            expect_regex: Some(r"1\.0\.0".to_string()),
        };
        let plan = make_plan(vec![item("a", &[], Some(dir.display().to_string()))]);
        let mut tools = HashMap::new();
        tools.insert("a".to_string(), tool("a", Some(verify)));

        let result = run_for_test(plan, tools).await;
        let entry = &result.items[0];
        assert_eq!(
            entry.state,
            PlanItemState::Success,
            "error = {:?}, note = {:?}, attempts = {}",
            entry.error,
            entry.note,
            entry.attempts
        );
        assert!(
            entry
                .note
                .as_deref()
                .unwrap_or_default()
                .contains("已安装，跳过"),
            "note = {:?}",
            entry.note
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn missing_tool_fails_and_dependents_are_skipped() {
        // a 不在工具表里 → a 失败；b 依赖 a → 跳过（单项失败不中断整体）
        let plan = make_plan(vec![item("a", &[], None), item("b", &["a"], None)]);
        let mut tools = HashMap::new();
        tools.insert("b".to_string(), tool("b", None));

        let result = run_for_test(plan, tools).await;
        assert_eq!(result.items[0].state, PlanItemState::Failed);
        assert!(result.items[0]
            .error
            .as_deref()
            .unwrap_or_default()
            .contains("清单里找不到这个工具"));
        assert_eq!(result.items[1].state, PlanItemState::Skipped);
        assert!(result.items[1]
            .note
            .as_deref()
            .unwrap_or_default()
            .contains("依赖未成功"));
    }

    #[tokio::test]
    async fn cancelled_plan_marks_items_cancelled() {
        let cancel = CancellationToken::new();
        cancel.cancel();
        let plan = make_plan(vec![item("a", &[], None), item("b", &["a"], None)]);
        let mut tools = HashMap::new();
        tools.insert("a".to_string(), tool("a", None));
        tools.insert("b".to_string(), tool("b", None));

        let dir = std::env::temp_dir().join(format!("devkit-exec-cancel-{}", std::process::id()));
        let _ = tokio::fs::remove_dir_all(&dir).await;
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let options = RunPlanOptions {
            plan,
            tools,
            download_dir: dir.join("downloads"),
            log_dir: dir.join("logs"),
            pending_path: None,
            dry_run: false,
            cancel,
            activate: None,
            run_elevated_command: None,
            on_update: None,
            npm_cmd: "npm.cmd".to_string(),
        };
        let result = run_plan(options).await;
        let _ = tokio::fs::remove_dir_all(&dir).await;
        assert_eq!(result.items[0].state, PlanItemState::Cancelled);
        // 与 TS 判定顺序一致：blocked（依赖未成功）先于 signal.aborted（取消）
        assert_eq!(result.items[1].state, PlanItemState::Skipped);
        assert!(
            result.items[1]
                .note
                .as_deref()
                .unwrap_or_default()
                .contains("依赖未成功"),
            "note = {:?}",
            result.items[1].note
        );
    }

    #[tokio::test]
    async fn dependency_cycle_is_detected_not_hanging() {
        // a → b → a 依赖环：标记跳过而不是死循环
        let plan = make_plan(vec![item("a", &["b"], None), item("b", &["a"], None)]);
        let mut tools = HashMap::new();
        tools.insert("a".to_string(), tool("a", None));
        tools.insert("b".to_string(), tool("b", None));

        let result = run_for_test(plan, tools).await;
        for entry in &result.items {
            assert_eq!(entry.state, PlanItemState::Skipped);
            assert!(
                entry
                    .note
                    .as_deref()
                    .unwrap_or_default()
                    .contains("依赖无法满足"),
                "note = {:?}",
                entry.note
            );
        }
    }

    #[tokio::test]
    async fn external_dependency_is_treated_as_satisfied() {
        // 依赖不在计划内（比如用户已手动装过）视为已满足，正常起跑
        // 这里 b 依赖 "external"（计划外），a 缺失失败不影响 b 起跑后自己失败
        let plan = make_plan(vec![item("b", &["external"], None)]);
        let mut tools = HashMap::new();
        tools.insert("b".to_string(), tool("b", None));

        let result = run_for_test(plan, tools).await;
        // b 起跑后因为没有下载源而失败（source: None → 清单没有给出任何下载源）
        assert_eq!(result.items[0].state, PlanItemState::Failed);
        assert!(
            result.items[0]
                .error
                .as_deref()
                .unwrap_or_default()
                .contains("下载源"),
            "error = {:?}",
            result.items[0].error
        );
    }
}
