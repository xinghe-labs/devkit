// Tauri 壳：全命令面（MIGRATION-RUST.md 附录 A 46 命令 + 2 事件）。
// R0-R3 的骨架保留；R5 接入安装执行器、激活、卸载、系统配置、体检、
// 档案、离线包、热更新、更新检查、预设与设置。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use devkit_core::elevation::ElevatedRunner;
use devkit_types::activation::{
    ActivateRequest, ActivationSnapshot, InstalledTool, UninstallRequest,
};
use devkit_types::detection::{DetectRequest, DetectionResult};
use devkit_types::doctor::{DoctorFixId, DoctorFixResult, DoctorReport};
use devkit_types::locale::Locale;
use devkit_types::manifest::ManifestLoadResult;
use devkit_types::plan::{PlanOptions, PlanPreparation, PlanSelection, StartInstallResult};
use devkit_types::profile::{
    ApplyProfileOptions, ApplyProfileResult, ExportProfileResult, ImportProfileResult,
};
use devkit_types::settings::{DataRootSource, MirrorApplyResult, MirrorSetting, UserConfigView};
use devkit_types::update::{
    DownloadUpdateResult, HotUpdateResultView, LogEntry, OfflinePackRequest, OfflinePackResult,
    UpdateInfo, VscodeExtension, VscodeInstallResult, VscodeStatus,
};
use devkit_types::{
    SystemConfigItem, SystemConfigRequest, SystemConfigResult, SystemConfigRevertRequest,
};
use std::collections::HashMap;
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{Emitter, State};
use tokio_util::sync::CancellationToken;

/* ------------------------------ R0/R3 基础 ------------------------------ */

#[tauri::command]
fn ping() -> &'static str {
    "pong"
}

#[tauri::command]
fn get_app_info() -> devkit_types::AppInfo {
    devkit_app::app_info()
}

/// renderer 挂载完成回执（对齐现状三端链路自检）。
#[tauri::command]
fn signal_ready() -> bool {
    println!("[devkit] renderer ready");
    SMOKE_READY.store(true, std::sync::atomic::Ordering::SeqCst);
    true
}

/// 冒烟看门狗（release.yml 用，对齐 TS 版 DEVKIT_SMOKE 机制）。
///
/// - `DEVKIT_SMOKE=1`：等到 signal_ready（渲染挂载回执）后延时 `DEVKIT_SMOKE_DELAY_MS`
///   （默认 12000ms）以退出码 0 结束；60s 内一直收不到 → 退出码 1（渲染没挂起来）。
/// - 与 Electron 版的差异（附录 E.11 偏离 4）：Tauri 拿不到渲染进程 console 错误流，
///   也没有 webContents.capturePage 截图等价物，判据收敛为「IPC 回执到达 + 无 panic」；
///   视觉核对交给 R7 真机手工清单（决策 D13）。
static SMOKE_READY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn start_smoke_watchdog() {
    if std::env::var("DEVKIT_SMOKE").as_deref() != Ok("1") {
        return;
    }
    std::thread::spawn(|| {
        let delay = std::env::var("DEVKIT_SMOKE_DELAY_MS")
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(12_000);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
        while !SMOKE_READY.load(std::sync::atomic::Ordering::SeqCst) {
            if std::time::Instant::now() >= deadline {
                eprintln!("[devkit] 冒烟失败：60s 内未收到 signal_ready（渲染未挂载）");
                std::process::exit(1);
            }
            std::thread::sleep(std::time::Duration::from_millis(250));
        }
        std::thread::sleep(std::time::Duration::from_millis(delay));
        println!("[devkit] 冒烟通过：界面已挂载，signal_ready 已到达");
        std::process::exit(0);
    });
}

fn load_manifests() -> ManifestLoadResult {
    devkit_manifest::load_manifests(
        &devkit_app::manifest_builtin_dir(),
        Some(&devkit_app::user_manifest_dir()),
        false,
    )
}

#[tauri::command]
fn list_manifests() -> ManifestLoadResult {
    load_manifests()
}

#[tauri::command]
async fn run_detection(request: Option<DetectRequest>) -> Result<Vec<DetectionResult>, String> {
    let manifests = load_manifests();
    let tool_ids = request.and_then(|req| req.tool_ids).unwrap_or_default();
    let targets: Vec<_> = if tool_ids.is_empty() {
        manifests.tools
    } else {
        manifests
            .tools
            .into_iter()
            .filter(|tool| tool_ids.contains(&tool.id))
            .collect()
    };

    devkit_core::logging::global().info("detect", &format!("开始检测 {} 个工具", targets.len()));

    let programs = match devkit_sys::registry::get_installed_programs() {
        Ok(programs) => programs,
        Err(error) => {
            devkit_core::logging::global().warn(
                "detect",
                &format!("注册表扫描失败，退化为仅用命令与文件检测：{error}"),
            );
            Vec::new()
        }
    };

    Ok(devkit_core::detect::detect_all(
        &targets,
        &programs,
        devkit_core::detect::DetectAllOptions { concurrency: None },
        None,
    )
    .await)
}

fn locale_tag(locale: Locale) -> &'static str {
    match locale {
        Locale::ZhCn => "zh-CN",
        Locale::EnUs => "en-US",
    }
}

#[tauri::command]
fn get_locale() -> Locale {
    devkit_core::settings::get_locale(&devkit_app::config_file(), devkit_app::ui_locale())
}

#[tauri::command]
fn set_locale(value: Option<String>) -> Locale {
    let locale = devkit_core::settings::set_locale(
        &devkit_app::config_file(),
        value.as_deref(),
        devkit_app::ui_locale(),
    );
    devkit_core::logging::global().info(
        "settings",
        &format!("界面语言切换为 {}", locale_tag(locale)),
    );
    locale
}

#[tauri::command]
fn tail_log(count: Option<f64>) -> Result<Vec<LogEntry>, String> {
    let count = devkit_app::bounded_log_count(count)?;
    Ok(devkit_core::logging::global().tail(count))
}

#[tauri::command]
fn open_log_dir() -> bool {
    let dir = devkit_app::log_dir();
    let _ = std::fs::create_dir_all(&dir);
    std::process::Command::new("explorer")
        .arg(dir.as_os_str())
        .spawn()
        .is_ok()
}

/* ------------------------------ 配置与镜像 ------------------------------ */

fn config_view() -> UserConfigView {
    let config =
        devkit_core::settings::load_config(&devkit_app::config_file(), devkit_app::ui_locale());
    // dataRoot 写进 override，让 app_paths 与配置保持一致（附录 G 优先级）
    devkit_core::app_paths::set_data_root_override(config.data_root.clone());
    let (effective, source) = devkit_core::app_paths::describe_data_root();
    let source = match source {
        "env" => DataRootSource::Env,
        "config" => DataRootSource::Config,
        _ => DataRootSource::Default,
    };
    UserConfigView {
        locale: config.locale,
        auto_update: config.auto_update,
        manifest_hot_update: config.manifest_hot_update,
        manifest_hot_update_url: config.manifest_hot_update_url,
        update_feed_url: config.update_feed_url,
        concurrency: config.concurrency,
        create_restore_point: config.create_restore_point,
        mirror_preference: config.mirror_preference,
        proxy: config.proxy,
        activate_after_install: config.activate_after_install,
        configure_mirrors: config.configure_mirrors,
        mirrors: config.mirrors,
        path_backup_file: {
            // 激活状态里的备份文件路径（有则展示）
            devkit_core::activate::index::read_activation_state().backup_file
        },
        data_root: config.data_root,
        effective_data_root: effective.to_string_lossy().to_string(),
        data_root_source: source,
    }
}

#[tauri::command]
fn get_settings() -> UserConfigView {
    config_view()
}

#[tauri::command]
fn save_settings(patch: Option<serde_json::Value>) -> UserConfigView {
    if let Some(patch) = patch {
        devkit_core::settings::save_config(
            &devkit_app::config_file(),
            &patch,
            devkit_app::ui_locale(),
        );
        devkit_core::logging::global().info("settings", "设置已保存");
    }
    config_view()
}

#[tauri::command]
fn apply_mirrors(settings: Option<Vec<MirrorSetting>>) -> MirrorApplyResult {
    let settings = settings.unwrap_or_default();
    let result = devkit_core::config::apply_mirrors(&settings);
    if result.ok {
        // 与 TS 一致：写成功后把镜像设置存进 config.json
        devkit_core::settings::save_config(
            &devkit_app::config_file(),
            &serde_json::json!({ "mirrors": serde_json::to_value(&settings).unwrap_or_default() }),
            devkit_app::ui_locale(),
        );
    }
    result
}

#[tauri::command]
fn open_external(url: Option<String>) -> bool {
    let Some(url) = url else { return false };
    // 只放行 http/https（防注入 explorer/start 参数）
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return false;
    }
    std::process::Command::new("cmd")
        .args(["/c", "start", "", &url])
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .spawn()
        .is_ok()
}

/* ------------------------------ 预设 ------------------------------ */

#[tauri::command]
fn list_presets() -> Vec<devkit_types::Preset> {
    devkit_core::presets::list_presets()
}

#[tauri::command]
fn save_preset(preset: Option<serde_json::Value>) -> Result<devkit_types::Preset, String> {
    devkit_core::presets::save_user_preset(&preset.unwrap_or(serde_json::Value::Null))
}

#[tauri::command]
fn delete_preset(id: Option<String>) -> Result<bool, String> {
    devkit_core::presets::delete_user_preset(&id.unwrap_or_default())
}

#[tauri::command]
fn import_preset(raw: Option<serde_json::Value>) -> Result<devkit_types::Preset, String> {
    devkit_core::presets::import_preset(&raw.unwrap_or(serde_json::Value::Null))
}

/* ------------------------------ 激活 / 已安装 / 卸载 ------------------------------ */

struct SandboxUserEnvIo;

impl devkit_core::activate::index::UserEnvIo for SandboxUserEnvIo {
    fn read_env(&self, name: &str) -> Result<Option<String>, String> {
        devkit_sys::user_env::read_user_env(name)
    }
    fn write_env(&self, name: &str, value: Option<&str>) -> Result<(), String> {
        devkit_sys::user_env::write_user_env(name, value)
    }
    fn read_path(&self) -> Result<String, String> {
        devkit_sys::user_env::read_user_path()
    }
    fn write_path(&self, value: &str) -> Result<(), String> {
        devkit_sys::user_env::write_user_path(value)
    }
}

#[tauri::command]
fn get_activation_snapshot() -> ActivationSnapshot {
    let io = SandboxUserEnvIo;
    devkit_core::activate::index::get_snapshot(&io)
}

#[tauri::command]
async fn activate_version(
    request: Option<ActivateRequest>,
) -> Result<devkit_types::activation::ActivateResult, String> {
    let Some(request) = request else {
        return Err("缺少激活参数".to_string());
    };
    let manifests = load_manifests();
    let Some(tool) = manifests
        .tools
        .iter()
        .find(|tool| tool.id == request.tool_id)
    else {
        return Err(format!("清单里没有工具 {}", request.tool_id));
    };
    // 找到对应的版本规格（安装目录必须存在才能激活）
    let Some(spec) = tool
        .versions
        .iter()
        .find(|spec| spec.version == request.version)
    else {
        return Err(format!("清单里没有版本 {}", request.version));
    };
    let install_dir = devkit_core::app_paths::get_versions_root()
        .join(&request.tool_id)
        .join(&request.version);
    let params = devkit_core::activate::index::ActivateParams {
        tool_id: &request.tool_id,
        version: &request.version,
        install_dir: &install_dir,
        spec: spec
            .activate
            .as_ref()
            .ok_or_else(|| "该版本声明为不可激活".to_string())?,
        verify_spec: None,
    };
    let io = SandboxUserEnvIo;
    let result = devkit_core::activate::index::activate_version(&io, &params).await;
    Ok(result)
}

#[tauri::command]
fn deactivate_tool(tool_id: Option<String>) -> Result<Vec<String>, String> {
    let io = SandboxUserEnvIo;
    devkit_core::activate::index::deactivate_tool(&io, &tool_id.unwrap_or_default())
}

fn activated_map() -> HashMap<String, String> {
    devkit_core::activate::index::read_activation_state()
        .records
        .into_iter()
        .map(|record| (record.tool_id, record.version))
        .collect()
}

#[tauri::command]
fn list_installed() -> Vec<InstalledTool> {
    let manifests = load_manifests();
    devkit_core::uninstall::list_installed(
        &manifests.tools,
        &devkit_core::app_paths::get_versions_root(),
        &activated_map(),
    )
}

#[tauri::command]
async fn uninstall_tool(
    request: Option<UninstallRequest>,
    state: State<'_, AppState>,
) -> Result<devkit_types::activation::UninstallResult, String> {
    let Some(request) = request else {
        return Err("缺少卸载参数".to_string());
    };
    let manifests = load_manifests();
    let tool = manifests
        .tools
        .iter()
        .find(|tool| tool.id == request.tool_id)
        .cloned();
    let io = SandboxUserEnvIo;
    let elevated = &state.elevation;
    Ok(devkit_core::uninstall::uninstall_version(
        &io,
        elevated.as_ref(),
        &request.tool_id,
        &request.version,
        &devkit_core::app_paths::get_versions_root(),
        tool.as_ref(),
    )
    .await)
}

/* ------------------------------ 安装执行器 ------------------------------ */

struct InstallRun {
    cancel: CancellationToken,
}

pub struct AppState {
    install: Arc<Mutex<Option<InstallRun>>>,
    elevation: Arc<devkit_core::elevation::RealElevation>,
}

struct ProgressEmitter {
    app: tauri::AppHandle,
}

impl ProgressEmitter {
    fn emit_progress(&self, event: &devkit_types::plan::InstallProgressEvent) {
        let _ = self.app.emit("install-progress", event);
    }
}

fn tools_map() -> HashMap<String, devkit_types::manifest::ToolManifest> {
    load_manifests()
        .tools
        .into_iter()
        .map(|tool| (tool.id.clone(), tool))
        .collect()
}

fn plan_options_from_config(config: &UserConfigView, dry_run: bool) -> PlanOptions {
    PlanOptions {
        concurrency: config.concurrency.clamp(1, 3),
        mirror_preference: config.mirror_preference,
        proxy: config.proxy.clone(),
        create_restore_point: config.create_restore_point,
        dry_run,
    }
}

fn prepare(selections: Vec<PlanSelection>, dry_run: bool) -> Result<PlanPreparation, String> {
    let manifests = load_manifests();
    let config = config_view();
    let options = plan_options_from_config(&config, dry_run);
    let params = devkit_core::plan::BuildPlanParams {
        selections: &selections,
        tools: &manifests.tools,
        options: &options,
        devkit_version: env!("CARGO_PKG_VERSION"),
        manifest_revision: &manifests.loaded_at,
        versions_root: &devkit_core::app_paths::get_versions_root(),
    };
    let plan = devkit_core::plan::build_plan(params).map_err(|failure| format!("{failure:?}"))?;
    let tool_map = tools_map();
    let preflight = tokio::runtime::Handle::current().block_on(
        devkit_core::preflight::run_preflight(devkit_core::preflight::PreflightInput {
            plan: &plan,
            tools: &tool_map,
            target_path: &devkit_core::app_paths::get_versions_root().to_string_lossy(),
            max_probes: Some(1),
            available_tool_ids: None,
        }),
    );
    Ok(PlanPreparation {
        plan,
        preflight,
        problems: Vec::new(),
    })
}

#[tauri::command]
async fn prepare_install(
    selections: Option<Vec<PlanSelection>>,
    dry_run: Option<bool>,
) -> Result<PlanPreparation, String> {
    prepare(selections.unwrap_or_default(), dry_run.unwrap_or(false))
}

#[tauri::command]
async fn start_install(
    plan_id: Option<String>,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<StartInstallResult, String> {
    let Some(plan_id) = plan_id else {
        return Ok(StartInstallResult {
            started: false,
            error: Some("缺少 planId".to_string()),
        });
    };

    // 单飞：已有安装任务正在进行中
    {
        let guard = state.install.lock().unwrap();
        if let Some(run) = guard.as_ref() {
            let _ = run;
            return Ok(StartInstallResult {
                started: false,
                error: Some("已有安装任务正在进行中".to_string()),
            });
        }
    }

    // 计划归属主进程：按 planId 从 pending.json 里找（或内存里的 prepared）
    let pending =
        devkit_core::plan::load_pending_plan(&devkit_core::app_paths::get_pending_plan_file());
    let plan = match pending {
        devkit_types::plan::PendingPlanLoad::Ok { plan } if plan.plan_id == plan_id => plan,
        devkit_types::plan::PendingPlanLoad::Ok { plan } => plan, // pending 里只有这一份
        devkit_types::plan::PendingPlanLoad::None => {
            return Ok(StartInstallResult {
                started: false,
                error: Some("没有待执行的安装计划：请先在首页勾选并生成计划".to_string()),
            })
        }
        devkit_types::plan::PendingPlanLoad::Invalid { reason } => {
            return Ok(StartInstallResult {
                started: false,
                error: Some(reason),
            })
        }
    };

    let config = config_view();
    let cancel = CancellationToken::new();
    let emitter = ProgressEmitter { app: app.clone() };
    let app_for_cb = app.clone();

    let on_update: devkit_core::executor::OnUpdateFn =
        Arc::new(move |plan_snapshot, current_item_id, detail| {
            let event = devkit_types::plan::InstallProgressEvent {
                plan: plan_snapshot,
                current_item_id,
                detail,
            };
            emitter.emit_progress(&event);
        });
    let _ = app_for_cb;

    let activate: Option<devkit_core::executor::ActivateFn> = if config.activate_after_install {
        Some(Arc::new(|item, spec, tool| {
            Box::pin(async move {
                let io = SandboxUserEnvIo;
                let install_dir = devkit_core::app_paths::get_versions_root()
                    .join(&tool.id)
                    .join(&item.version);
                let Some(activate_spec) = spec.activate.clone() else {
                    return devkit_core::executor::ActivateOutcome {
                        ok: false,
                        note: None,
                        error: Some("该版本声明为不可激活".to_string()),
                    };
                };
                let params = devkit_core::activate::index::ActivateParams {
                    tool_id: &tool.id,
                    version: &item.version,
                    install_dir: &install_dir,
                    spec: &activate_spec,
                    verify_spec: None,
                };
                let result = devkit_core::activate::index::activate_version(&io, &params).await;
                devkit_core::executor::ActivateOutcome {
                    ok: result.ok,
                    note: result.note,
                    error: result.error,
                }
            })
        }))
    } else {
        None
    };

    let run_elevated_command: Option<devkit_core::executor::RunElevatedFn> = {
        let elevation = state.elevation.clone();
        Some(Arc::new(move |label: &str, command, sha256| {
            let elevation = elevation.clone();
            let label = label.to_string();
            Box::pin(async move {
                let step = match sha256 {
                    Some(hash) => devkit_core::elevation::ElevatedStep::exec_verified(
                        label,
                        command.cmd,
                        command.args,
                        hash,
                    ),
                    None => {
                        devkit_core::elevation::ElevatedStep::exec(label, command.cmd, command.args)
                    }
                };
                let outcome = elevation.run(vec![step]);
                match outcome.ok {
                    true => Ok(()),
                    false => Err(outcome.error.unwrap_or_else(|| "提权步骤失败".to_string())),
                }
            })
        }))
    };

    let npm_cmd = devkit_core::direct::resolve_npm_cmd(
        Some(&devkit_core::app_paths::get_current_root()),
        &devkit_core::app_paths::get_versions_root(),
    )
    .0;

    {
        let mut guard = state.install.lock().unwrap();
        *guard = Some(InstallRun {
            cancel: cancel.clone(),
        });
    }

    let manifest_dir = devkit_app::manifest_builtin_dir();
    let _ = manifest_dir;
    let state_clone = state.install.clone() /* for cleanup */;
    let plan_id_for_log = plan.plan_id.clone();
    tokio::spawn(async move {
        let tools = tools_map();
        let final_plan = devkit_core::executor::run_plan(devkit_core::executor::RunPlanOptions {
            plan,
            tools,
            download_dir: devkit_core::app_paths::get_download_dir(),
            log_dir: devkit_app::log_dir(),
            pending_path: Some(devkit_core::app_paths::get_pending_plan_file()),
            dry_run: false,
            cancel,
            activate,
            run_elevated_command,
            on_update: Some(on_update),
            npm_cmd,
        })
        .await;
        devkit_core::logging::global().info(
            "install",
            &format!(
                "安装任务 {} 结束：成功 {} 失败 {} 跳过 {}",
                plan_id_for_log,
                final_plan.summary.success,
                final_plan.summary.failed,
                final_plan.summary.skipped
            ),
        );
        // 任务结束清掉单飞标记
        *state_clone.lock().unwrap() = None;
    });

    Ok(StartInstallResult {
        started: true,
        error: None,
    })
}

#[tauri::command]
fn cancel_install(state: State<'_, AppState>) -> bool {
    if let Some(run) = state.install.lock().unwrap().as_ref() {
        run.cancel.cancel();
        return true;
    }
    false
}

#[tauri::command]
fn get_pending_plan() -> devkit_types::plan::PendingPlanLoad {
    devkit_core::plan::load_pending_plan(&devkit_core::app_paths::get_pending_plan_file())
}

#[tauri::command]
fn discard_pending_plan() -> bool {
    match std::fs::remove_file(devkit_core::app_paths::get_pending_plan_file()) {
        Ok(()) => true,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
        Err(_) => false,
    }
}

#[tauri::command]
async fn resume_install(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<StartInstallResult, String> {
    // 复用 start_install：pending.json 里存的就是待续跑的计划
    start_install(Some(get_pending_plan_id()), state, app).await
}

fn get_pending_plan_id() -> String {
    match get_pending_plan() {
        devkit_types::plan::PendingPlanLoad::Ok { plan } => plan.plan_id,
        _ => String::new(),
    }
}

#[tauri::command]
fn export_install_report() -> Option<String> {
    // 导出最近一次安装报告（pending.json 里的计划渲染成 markdown）
    match get_pending_plan() {
        devkit_types::plan::PendingPlanLoad::Ok { plan } => {
            let tools = tools_map();
            let locale = get_locale();
            let markdown = devkit_core::report::render_report(&plan, &tools, locale);
            let file = devkit_app::log_dir().join(format!("install-report-{}.md", plan.plan_id));
            std::fs::write(&file, markdown).ok()?;
            Some(file.display().to_string())
        }
        _ => None,
    }
}

/* ------------------------------ 系统配置 / 体检 ------------------------------ */

#[tauri::command]
async fn get_system_config() -> Result<Vec<SystemConfigItem>, String> {
    Ok(devkit_core::systemconfig::get_system_config_status().await)
}

#[tauri::command]
async fn apply_system_config(
    request: Option<SystemConfigRequest>,
    state: State<'_, AppState>,
) -> Result<SystemConfigResult, String> {
    let Some(request) = request else {
        return Err("缺少系统配置参数".to_string());
    };
    Ok(devkit_core::systemconfig::apply_system_config(&request, state.elevation.as_ref()).await)
}

#[tauri::command]
async fn revert_system_config(
    request: Option<SystemConfigRevertRequest>,
    state: State<'_, AppState>,
) -> Result<SystemConfigResult, String> {
    let Some(request) = request else {
        return Err("缺少还原参数".to_string());
    };
    Ok(devkit_core::systemconfig::revert_system_config(request.id, state.elevation.as_ref()).await)
}

fn doctor_inputs<'a>(
    user_path: &'a (dyn Fn() -> Result<String, String> + Send + Sync),
    machine_path: &'a (dyn Fn() -> Result<String, String> + Send + Sync),
    resolve: &'a (dyn Fn(&str) -> Vec<String> + Send + Sync),
    exists: &'a (dyn Fn(&str) -> bool + Send + Sync),
) -> devkit_core::doctor::DoctorInputs<'a> {
    devkit_core::doctor::DoctorInputs {
        read_user_path: user_path,
        read_machine_path: machine_path,
        resolve_command: resolve,
        env: std::env::vars().collect(),
        exists,
    }
}

#[tauri::command]
async fn run_doctor() -> Result<DoctorReport, String> {
    let read_user: &(dyn Fn() -> Result<String, String> + Send + Sync) =
        &|| devkit_sys::user_env::read_user_path();
    let read_machine: &(dyn Fn() -> Result<String, String> + Send + Sync) = &|| {
        let handle = std::thread::spawn(|| {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|error| error.to_string())?
                .block_on(devkit_core::activate::machine_path::read_machine_path_raw())
        });
        handle.join().map_err(|_| "线程崩溃".to_string())?
    };
    let resolve: &(dyn Fn(&str) -> Vec<String> + Send + Sync) = &|cmd: &str| -> Vec<String> {
        let output = std::process::Command::new("where.exe").arg(cmd).output();
        match output {
            Ok(out) if out.status.success() => String::from_utf8_lossy(&out.stdout)
                .lines()
                .map(|line| line.trim().to_string())
                .filter(|line| !line.is_empty())
                .collect(),
            _ => Vec::new(),
        }
    };
    let exists: &(dyn Fn(&str) -> bool + Send + Sync) =
        &|path: &str| std::path::Path::new(path).exists();
    let inputs = doctor_inputs(read_user, read_machine, resolve, exists);
    Ok(devkit_core::doctor::run_doctor(&inputs).await)
}

#[tauri::command]
fn apply_doctor_fix(fix_id: Option<DoctorFixId>, state: State<'_, AppState>) -> DoctorFixResult {
    let io = SandboxUserEnvIo;
    devkit_core::doctor::apply_doctor_fix(
        &io,
        state.elevation.as_ref(),
        fix_id.unwrap_or(DoctorFixId::CleanUserPath),
    )
}

/* ------------------------------ VS Code ------------------------------ */

#[tauri::command]
async fn get_vscode_status() -> VscodeStatus {
    devkit_core::vscode::get_vscode_status().await
}

#[tauri::command]
fn list_vscode_extensions() -> Vec<VscodeExtension> {
    devkit_core::vscode::list_vscode_extensions()
}

#[tauri::command]
async fn install_vscode_extensions(
    ids: Option<Vec<String>>,
) -> Result<VscodeInstallResult, String> {
    Ok(devkit_core::vscode::install_vscode_extensions(&ids.unwrap_or_default()).await)
}

/* ------------------------------ 更新 / 热更新 / 离线包 ------------------------------ */

#[tauri::command]
async fn check_for_update() -> Result<UpdateInfo, String> {
    let config = config_view();
    let Some(feed_url) = config.update_feed_url else {
        return Ok(UpdateInfo {
            has_update: false,
            current_version: env!("CARGO_PKG_VERSION").to_string(),
            latest_version: None,
            download_url: None,
            download_sha256: None,
            size_bytes: None,
            notes: None,
            error: Some("未配置更新源（设置里填 updateFeedUrl 后启用）".to_string()),
        });
    };
    Ok(
        devkit_core::updater::check_for_update(&devkit_core::updater::UpdateCheckParams {
            feed_url: &feed_url,
            current_version: env!("CARGO_PKG_VERSION"),
            proxy: config.proxy,
        })
        .await,
    )
}

#[tauri::command]
async fn download_update() -> Result<DownloadUpdateResult, String> {
    let config = config_view();
    let Some(feed_url) = config.update_feed_url else {
        return Err("未配置更新源".to_string());
    };
    let info = devkit_core::updater::check_for_update(&devkit_core::updater::UpdateCheckParams {
        feed_url: &feed_url,
        current_version: env!("CARGO_PKG_VERSION"),
        proxy: config.proxy.clone(),
    })
    .await;
    let Some(url) = info.download_url else {
        return Err("更新源里没有可用的下载地址".to_string());
    };
    Ok(
        devkit_core::updater::download_update(&devkit_core::updater::DownloadUpdateParams {
            url: &url,
            sha256: info.download_sha256,
            target_dir: &devkit_core::app_paths::get_update_dir(),
            proxy: config.proxy,
        })
        .await,
    )
}

#[tauri::command]
fn install_update(file_path: Option<String>) -> bool {
    let Some(path) = file_path else { return false };
    let file = PathBuf::from(&path);
    if !file.exists() {
        return false;
    }
    std::process::Command::new("cmd")
        .args(["/c", "start", "", &path])
        .creation_flags(0x0800_0000)
        .spawn()
        .is_ok()
}

#[tauri::command]
async fn run_hot_update(url: Option<String>) -> Result<HotUpdateResultView, String> {
    let manifests = load_manifests();
    let config = config_view();
    let url = match url {
        Some(url) => Some(url),
        None => config.manifest_hot_update_url.clone(),
    };
    let Some(url) = url else {
        return Ok(HotUpdateResultView {
            ok: false,
            fetched: 0,
            applied: 0,
            rejected: Vec::new(),
            updated: Vec::new(),
            error: Some("未配置清单热更新地址（设置里填 manifestHotUpdateUrl 后启用）".to_string()),
        });
    };
    Ok(
        devkit_core::hotupdate::run_hot_update(&devkit_core::hotupdate::HotUpdateParams {
            url: &url,
            tools: &manifests.tools,
            proxy: config.proxy,
        })
        .await,
    )
}

#[tauri::command]
fn clear_manifest_override() -> usize {
    devkit_core::hotupdate::clear_user_manifests()
}

fn offline_dirs(output_dir: Option<String>) -> (PathBuf, PathBuf) {
    let pack_dir = match output_dir {
        Some(dir) => PathBuf::from(dir),
        None => devkit_core::app_paths::get_offline_dir(),
    };
    let download_dir = devkit_core::app_paths::get_download_dir();
    (pack_dir, download_dir)
}

#[tauri::command]
async fn pack_offline(request: Option<OfflinePackRequest>) -> Result<OfflinePackResult, String> {
    let Some(request) = request else {
        return Err("缺少离线打包参数".to_string());
    };
    let manifests = load_manifests();
    let config = config_view();
    let tools: HashMap<String, devkit_types::manifest::ToolManifest> = manifests
        .tools
        .into_iter()
        .map(|tool| (tool.id.clone(), tool))
        .collect();
    let (pack_dir, download_dir) = offline_dirs(request.output_dir);
    let mirror_preference = config.mirror_preference;
    let proxy = config.proxy;
    Ok(devkit_core::offline::pack_offline(
        &devkit_core::offline::PackOfflineOptions {
            tool_ids: &request.tool_ids,
            tools: &tools,
            pack_dir: &pack_dir,
            download_dir: &download_dir,
            devkit_version: env!("CARGO_PKG_VERSION"),
            mirror_preference: &mirror_preference,
            proxy,
        },
        |_progress| {},
    )
    .await)
}

#[tauri::command]
async fn import_offline_pack(
    pack_dir: Option<String>,
) -> Result<devkit_core::offline::ImportResult, String> {
    let dir = match pack_dir {
        Some(dir) => PathBuf::from(dir),
        None => devkit_core::app_paths::get_offline_dir(),
    };
    Ok(
        devkit_core::offline::import_offline_pack(
            &dir,
            &devkit_core::app_paths::get_download_dir(),
        )
        .await,
    )
}

/* ------------------------------ 环境档案 ------------------------------ */

#[tauri::command]
async fn export_profile(
    request: Option<devkit_types::profile::ExportProfileRequest>,
    app: tauri::AppHandle,
) -> Result<ExportProfileResult, String> {
    let manifests = load_manifests();
    let config = config_view();
    let programs = devkit_sys::registry::get_installed_programs().unwrap_or_default();
    let detections = devkit_core::detect::detect_all(
        &manifests.tools,
        &programs,
        devkit_core::detect::DetectAllOptions { concurrency: None },
        None,
    )
    .await;
    let installed = list_installed();
    let include_git = request
        .as_ref()
        .map(|request| request.include_git_identity)
        .unwrap_or(false);
    let profile = devkit_core::profile::collect_profile(
        &devkit_core::profile::CollectContext {
            detections: &detections,
            installed: &installed,
            mirrors: &config.mirrors,
        },
        &devkit_core::profile::ExportOptions {
            include_git_identity: include_git,
            selections: None,
        },
    );

    // 传了 filePath 就直接写（脚本化迁移用），否则弹保存对话框（TS 同语义）
    let direct = request
        .and_then(|request| request.file_path)
        .filter(|path| !path.trim().is_empty());
    let target: PathBuf = match direct {
        Some(path) => {
            let path = PathBuf::from(path.trim());
            if !path.is_absolute() {
                return Err("档案输出路径必须是绝对路径".to_string());
            }
            path
        }
        None => {
            use tauri_plugin_dialog::DialogExt;
            let picked = app
                .dialog()
                .file()
                .set_title("导出环境档案")
                .set_file_name(devkit_core::profile::default_profile_file_name())
                .add_filter("JSON", &["json"])
                .blocking_save_file();
            match picked {
                Some(file) => file.into_path().map_err(|error| error.to_string())?,
                None => {
                    return Ok(ExportProfileResult {
                        ok: false,
                        file_path: None,
                        profile: None,
                        error: Some("已取消".to_string()),
                    })
                }
            }
        }
    };

    let text = serde_json::to_string_pretty(&profile).map_err(|error| error.to_string())?;
    std::fs::write(&target, format!("{text}\n")).map_err(|error| format!("写档案失败：{error}"))?;
    devkit_core::logging::global().info("profile", &format!("档案已导出：{}", target.display()));
    Ok(ExportProfileResult {
        ok: true,
        file_path: Some(target.display().to_string()),
        profile: Some(profile),
        error: None,
    })
}

#[tauri::command]
async fn import_profile(app: tauri::AppHandle) -> Result<ImportProfileResult, String> {
    use tauri_plugin_dialog::DialogExt;
    let picked = app
        .dialog()
        .file()
        .set_title("导入环境档案")
        .add_filter("JSON", &["json"])
        .blocking_pick_file();
    let Some(file) = picked else {
        return Ok(ImportProfileResult {
            ok: false,
            file_path: None,
            profile: None,
            description: Vec::new(),
            diff: None,
            error: Some("已取消".to_string()),
        });
    };
    let path = file.into_path().map_err(|error| error.to_string())?;
    let file_path = path.display().to_string();

    let load = |file_path: &str| -> Result<ImportProfileResult, String> {
        let text =
            std::fs::read_to_string(file_path).map_err(|error| format!("读档案失败：{error}"))?;
        let raw: serde_json::Value =
            serde_json::from_str(&text).map_err(|error| format!("档案不是合法 JSON：{error}"))?;
        // 别人给的档案不能直接信：走一遍白名单清洗
        let profile = devkit_core::profile::sanitize_profile(&raw)?;
        let description = devkit_core::profile::describe_profile(&profile);
        Ok(ImportProfileResult {
            ok: true,
            file_path: Some(file_path.to_string()),
            profile: Some(profile),
            description,
            diff: None,
            error: None,
        })
    };

    match load(&file_path) {
        Ok(mut result) => {
            // 档案 vs 本机：缺什么、版本差什么（TS 同语义，给应用页先看清再决定）
            let manifests = load_manifests();
            let programs = devkit_sys::registry::get_installed_programs().unwrap_or_default();
            let detections = devkit_core::detect::detect_all(
                &manifests.tools,
                &programs,
                devkit_core::detect::DetectAllOptions { concurrency: None },
                None,
            )
            .await;
            let installed = list_installed();
            let profile = match result.profile.as_ref() {
                Some(profile) => profile,
                None => {
                    return Ok(ImportProfileResult {
                        ok: false,
                        file_path: Some(file_path),
                        profile: None,
                        description: Vec::new(),
                        diff: None,
                        error: Some("档案清洗后为空".to_string()),
                    })
                }
            };
            let diff = devkit_core::profile::diff_profile(
                profile,
                &devkit_core::profile::DiffContext {
                    tools: &manifests.tools,
                    detections: &detections,
                    installed: &installed,
                },
            );
            result.diff = Some(diff);
            devkit_core::logging::global().info("profile", &format!("档案已导入：{file_path}"));
            Ok(result)
        }
        Err(message) => Ok(ImportProfileResult {
            ok: false,
            file_path: Some(file_path),
            profile: None,
            description: Vec::new(),
            diff: None,
            error: Some(message),
        }),
    }
}

#[tauri::command]
fn apply_profile_command(
    profile: Option<devkit_types::profile::EnvProfile>,
    options: Option<ApplyProfileOptions>,
) -> ApplyProfileResult {
    let Some(profile) = profile else {
        return ApplyProfileResult {
            ok: false,
            changed: Vec::new(),
            selections: Vec::new(),
            error: Some("缺少档案".to_string()),
        };
    };
    let default_options = ApplyProfileOptions {
        restore_user_path: true,
        restore_env: true,
        restore_mirrors: true,
        restore_git: false,
    };
    devkit_core::profile::apply_profile(&profile, &options.unwrap_or(default_options))
}

/* ------------------------------ 日志推送事件 ------------------------------ */

/// 启动一个后台任务：把日志环形缓冲的新条目推给 renderer（log-line 事件）。
/// 通过 broadcast 订阅日志通道。
fn start_log_forwarder(app: tauri::AppHandle) {
    let mut receiver = devkit_core::logging::global().subscribe();
    // 注意：setup 钩子不在 tokio runtime 上下文里，必须走 tauri 的 async_runtime，
    // 否则打包态启动即 panic（"there is no reactor running"，冒烟实测抓到）
    tauri::async_runtime::spawn(async move {
        loop {
            match receiver.recv().await {
                Ok(entry) => {
                    if app.emit("log-line", &entry).is_err() {
                        break;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => break,
            }
        }
    });
}

/* ------------------------------ 入口 ------------------------------ */

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let file = devkit_core::logging::global().init(&devkit_app::log_dir());
            devkit_core::logging::global().info("app", &format!("devkit 启动，日志文件：{file}"));
            // dataRoot 三级优先级：env → config.json → 默认（附录 G）
            let config = devkit_core::settings::load_config(
                &devkit_app::config_file(),
                devkit_app::ui_locale(),
            );
            devkit_core::app_paths::set_data_root_override(config.data_root);
            start_log_forwarder(app.handle().clone());
            start_smoke_watchdog();
            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            install: Arc::new(Mutex::new(None)),
            elevation: Arc::new(devkit_core::elevation::RealElevation),
        })
        .invoke_handler(tauri::generate_handler![
            ping,
            get_app_info,
            signal_ready,
            list_manifests,
            run_detection,
            get_locale,
            set_locale,
            tail_log,
            open_log_dir,
            get_settings,
            save_settings,
            apply_mirrors,
            open_external,
            list_presets,
            save_preset,
            delete_preset,
            import_preset,
            get_activation_snapshot,
            activate_version,
            deactivate_tool,
            list_installed,
            uninstall_tool,
            prepare_install,
            start_install,
            cancel_install,
            get_pending_plan,
            discard_pending_plan,
            resume_install,
            export_install_report,
            get_system_config,
            apply_system_config,
            revert_system_config,
            run_doctor,
            apply_doctor_fix,
            get_vscode_status,
            list_vscode_extensions,
            install_vscode_extensions,
            check_for_update,
            download_update,
            install_update,
            run_hot_update,
            clear_manifest_override,
            pack_offline,
            import_offline_pack,
            export_profile,
            import_profile,
            apply_profile_command
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn main() {
    run()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// R0 骨架自检：ping 通（附录 E.5）
    #[test]
    fn ping_returns_pong() {
        assert_eq!(ping(), "pong");
    }

    /// R0 骨架自检：AppInfo 字段语义（附录 F.4，决策 D16）
    #[test]
    fn get_app_info_fields() {
        let info = get_app_info();
        assert_eq!(info.version, env!("CARGO_PKG_VERSION"));
        assert_eq!(info.platform, "windows");
        assert_eq!(info.arch, std::env::consts::ARCH);
        assert!(!info.electron_version.is_empty());
        assert!(!info.node_version.is_empty());
        assert!(!info.chrome_version.is_empty());
    }

    /// R0 骨架自检：renderer 挂载回执（附录 F.3）
    #[test]
    fn signal_ready_returns_true() {
        assert!(signal_ready());
    }

    /// R3：list_manifests 走内置资源
    #[test]
    fn list_manifests_loads_builtin() {
        let result = list_manifests();
        assert!(!result.tools.is_empty(), "内置清单应加载出工具");
        assert!(result.tools.iter().any(|tool| tool.id == "nodejs"));
    }

    /// R3：run_detection 指定 toolIds 过滤
    #[tokio::test]
    async fn run_detection_filters_by_ids() {
        let results = run_detection(Some(DetectRequest {
            tool_ids: Some(vec!["nodejs".to_string()]),
        }))
        .await
        .expect("检测不应失败");
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].tool_id, "nodejs");
        assert_ne!(
            results[0].status,
            devkit_types::detection::DetectionStatus::Error
        );
        let all = run_detection(Some(DetectRequest {
            tool_ids: Some(Vec::new()),
        }))
        .await
        .expect("全量检测不应失败");
        assert!(all.len() > 5, "内置清单不止 5 个工具");
    }

    /// R3：语言读写
    #[test]
    fn locale_roundtrip_via_config_file() {
        let tmp = std::env::temp_dir().join("devkit-app-locale-test");
        let _ = std::fs::remove_dir_all(&tmp);
        std::env::set_var("DEVKIT_APP_DATA", &tmp);
        assert_eq!(set_locale(Some("en-US".to_string())), Locale::EnUs);
        assert_eq!(get_locale(), Locale::EnUs);
        assert_eq!(
            set_locale(Some("nope".to_string())),
            Locale::ZhCn,
            "未知语言回默认"
        );
        std::env::remove_var("DEVKIT_APP_DATA");
    }

    /// R3：tail_log 越界报错
    #[test]
    fn tail_log_rejects_out_of_range() {
        assert!(tail_log(Some(0.0)).is_err());
        assert!(tail_log(Some(9999.0)).is_err());
        let _ = tail_log(None).unwrap();
    }

    /// R5：预设列表包含全部内置
    #[test]
    fn list_presets_includes_builtins() {
        let presets = list_presets();
        assert!(presets.len() >= 9);
        assert!(presets
            .iter()
            .any(|preset| preset.id == "base" && preset.builtin));
    }

    /// R5：激活快照不 panic、list_installed 合法
    #[test]
    fn activation_snapshot_and_list_installed() {
        let tmp = std::env::temp_dir().join("devkit-app-commands-test");
        let _ = std::fs::remove_dir_all(&tmp);
        std::env::set_var("DEVKIT_APP_DATA", &tmp);
        let snapshot = get_activation_snapshot();
        assert!(!snapshot.user_path.is_empty(), "user PATH 应能读到");
        assert!(!snapshot.bin_dir.is_empty(), "bin 目录应有值");
        let installed = list_installed();
        // 本机 .devkit 可能有真实安装；只要求不 panic 且字段合法
        assert!(installed.iter().all(|item| !item.tool_id.is_empty()));
        std::env::remove_var("DEVKIT_APP_DATA");
    }

    /// R5：open_external 拒绝非 http(s)
    #[test]
    fn open_external_rejects_non_http() {
        assert!(!open_external(Some("file:///C:/Windows".to_string())));
        assert!(!open_external(Some("javascript:alert(1)".to_string())));
        assert!(!open_external(None));
    }
}
