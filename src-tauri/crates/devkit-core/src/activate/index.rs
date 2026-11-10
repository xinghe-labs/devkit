//! 激活（FR-11）编排层。镜像 `src/main/core/activate/index.ts`。
//!
//! 把「已经装进版本目录的文件」接到用户环境里：
//! 1. 每工具一个 junction：`%USERPROFILE%\.devkit\current\<linkName>` → 版本目录
//! 2. bin 目录（指向 junction）插到**用户 PATH 最前面**
//! 3. 写用户环境变量（JAVA_HOME / GOROOT / CARGO_HOME …）
//! 4. 全部改动记到 activated.json，回滚按记录精确移除
//!
//! 切版本 = 只改 junction 指向，PATH 一个字都不动。
//!
//! 可测试性：注册表 IO 通过 [`UserEnvIo`] 注入（TS 里对应 vi.mock windows 模块），
//! 单测用内存假后端，绝不动真实用户环境。

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use devkit_types::activation::{ActivateResult, ActivationRecord, ActivationSnapshot};
use devkit_types::manifest::ActivateSpec;
use devkit_types::timeutil::iso8601_now;

use crate::activate::paths::{
    build_activate_entries, prepend_path_entries, remove_path_entries, ActivateVars,
};
use crate::activate::verify::{effective_paths, verify_activation, ActivationVerifySpec};
use crate::app_paths::{
    get_activation_file, get_backup_dir, get_current_root, get_devkit_home, get_shim_dir,
};
use crate::logging::timestamp_slug;
use devkit_sys::junction;

/// 用户环境 IO 抽象（真实实现走 devkit-sys 的 Registry 用户视图）。
pub trait UserEnvIo: Send + Sync {
    fn read_env(&self, name: &str) -> Result<Option<String>, String>;
    fn write_env(&self, name: &str, value: Option<&str>) -> Result<(), String>;
    fn read_path(&self) -> Result<String, String>;
    fn write_path(&self, value: &str) -> Result<(), String>;
}

/// 真实后端：直接读写 HKCU 环境。
pub struct RealUserEnvIo;

impl UserEnvIo for RealUserEnvIo {
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

/* ------------------------------------------------------------------ */
/* 激活状态（activated.json）                                          */
/* ------------------------------------------------------------------ */

/// PATH 条目里用这个变量代替 `%USERPROFILE%\.devkit`。
///
/// 为什么：每装一个工具就往 PATH 加一条绝对路径，10 个工具就多 400+ 字符，
/// 而 PATH 过长是 winget 那边被反复投诉的真实故障（#3601 / #5557）。
pub const DEVKIT_HOME_VAR: &str = "%DEVKIT_HOME%";

/// PATH 超过这个长度就告警（Windows 路径相关 API 普遍以 2047/2048 为界）。
pub const PATH_LENGTH_WARN: usize = 2047;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ActivationState {
    pub schema_version: u32,
    pub records: Vec<ActivationRecord>,
    /// 当前由 devkit 管理的全部 PATH 条目（并集）
    pub managed_path_entries: Vec<String>,
    /// 首次改动用户 PATH 前的备份文件
    pub backup_file: Option<String>,
    /// DEVKIT_HOME 这个用户变量是不是 devkit 自己创建的（决定取消激活时删不删）
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub owns_devkit_home_var: bool,
}

impl Default for ActivationState {
    fn default() -> Self {
        ActivationState {
            schema_version: 1,
            records: Vec::new(),
            managed_path_entries: Vec::new(),
            backup_file: None,
            owns_devkit_home_var: false,
        }
    }
}

/// 读激活记录；损坏/不认识的结构一律重置为空（TS readActivationState 同语义）。
pub fn read_activation_state() -> ActivationState {
    let file = get_activation_file();
    if !file.exists() {
        return ActivationState::default();
    }
    let raw = match std::fs::read_to_string(&file) {
        Ok(text) => text,
        Err(error) => {
            log::warn!(target: "activate", "激活记录损坏，已重置：{error}");
            return ActivationState::default();
        }
    };
    match serde_json::from_str::<ActivationState>(&raw) {
        Ok(state) if state.schema_version == 1 => state,
        _ => {
            log::warn!(target: "activate", "激活记录损坏，已重置：schemaVersion 不是 1 或结构不认识");
            ActivationState::default()
        }
    }
}

pub fn save_activation_state(state: &ActivationState) -> Result<(), String> {
    let file = get_activation_file();
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let json = serde_json::to_string_pretty(state).map_err(|error| error.to_string())?;
    std::fs::write(&file, json).map_err(|error| error.to_string())
}

/// 激活状态文件的落点（测试/快照用）。
pub fn activation_file_path() -> PathBuf {
    get_activation_file()
}

/* ------------------------------------------------------------------ */
/* %DEVKIT_HOME% 改写                                                  */
/* ------------------------------------------------------------------ */

/// 把绝对路径改写成 `%DEVKIT_HOME%` 形式（只改 devkit 自己的目录）。
///
/// 必须校验剩下的部分以路径分隔符开头：否则 `C:\Users\x\.devkit-other`
/// 这种"前缀相似的兄弟目录"会被误改。
pub fn to_devkit_home_var(entry: &str) -> String {
    let home = get_devkit_home();
    let home_text = home.to_string_lossy();
    if !entry.to_lowercase().starts_with(&home_text.to_lowercase()) {
        return entry.to_string();
    }
    let rest = &entry[home_text.len()..];
    if !rest.is_empty() && !rest.starts_with('\\') && !rest.starts_with('/') {
        return entry.to_string();
    }
    format!("{DEVKIT_HOME_VAR}{rest}")
}

/* ------------------------------------------------------------------ */
/* junction                                                            */
/* ------------------------------------------------------------------ */

pub fn get_link_path(link_name: &str) -> PathBuf {
    get_current_root().join(link_name)
}

/// 创建/替换 junction。安全关键：**只删除确认是链接的路径**。
/// 位置已存在但不是链接（真实目录）→ 拒绝，绝不递归删掉它。
pub fn ensure_junction(link_path: &Path, target: &Path) -> Result<&'static str, String> {
    let outcome = junction::ensure_junction(&get_current_root(), link_path, target)?;
    Ok(outcome.as_str())
}

/// 删除 junction（只删链接本身，绝不动目标目录）；不是链接返回 false。
pub fn remove_junction(link_path: &Path) -> Result<bool, String> {
    Ok(junction::remove_junction(link_path))
}

/* ------------------------------------------------------------------ */
/* PATH 同步                                                           */
/* ------------------------------------------------------------------ */

/// 首次改动用户 PATH 之前先留一份原文。
fn backup_user_path_once(state: &mut ActivationState, raw_path: &str) {
    if let Some(file) = &state.backup_file {
        if Path::new(file).exists() {
            return;
        }
    }
    let dir = get_backup_dir();
    let file = dir.join(format!("user-path-{}.txt", timestamp_slug()));
    if let Err(error) = std::fs::write(&file, raw_path) {
        log::warn!(target: "activate", "备份用户 PATH 失败（继续激活）：{error}");
        return;
    }
    log::info!(target: "activate", "已备份用户 PATH 原文：{}", file.display());
    state.backup_file = Some(file.to_string_lossy().to_string());
}

/// 把 PATH 同步成「新的管理条目并集 + 其余原样」。
/// 每次都先摘掉**已知全部管理条目**，再把新并集插到最前面 —— 反复激活不会留重复项。
fn sync_user_path(
    io: &dyn UserEnvIo,
    state: &mut ActivationState,
) -> Result<Option<String>, String> {
    let raw = io.read_path()?;
    backup_user_path_once(state, &raw);

    let mut desired: Vec<String> = Vec::new();
    for record in &state.records {
        for entry in &record.path_entries {
            if !desired.contains(entry) {
                desired.push(entry.clone());
            }
        }
    }

    let mut known: Vec<String> = state.managed_path_entries.clone();
    known.extend(desired.iter().cloned());
    let stripped = remove_path_entries(&raw, &known);
    let merged = prepend_path_entries(&stripped, &desired);

    let mut warning: Option<String> = None;
    if merged.value.len() > PATH_LENGTH_WARN {
        let message = format!(
            "用户 PATH 已经 {} 个字符（超过 {PATH_LENGTH_WARN}），建议清理一些不再使用的条目",
            merged.value.len()
        );
        log::warn!(target: "activate", "{message}");
        warning = Some(message);
    }

    if merged.value != raw {
        io.write_path(&merged.value)?;
        log::info!(
            target: "activate",
            "用户 PATH 已更新：新增 {} 条，已在 PATH 中 {} 条",
            merged.added.len(),
            merged.already_present.len()
        );
    }

    state.managed_path_entries = desired;
    Ok(warning)
}

/* ------------------------------------------------------------------ */
/* 激活 / 取消激活                                                     */
/* ------------------------------------------------------------------ */

pub struct ActivateParams<'a> {
    pub tool_id: &'a str,
    pub version: &'a str,
    pub install_dir: &'a Path,
    pub spec: &'a ActivateSpec,
    /// 用"新终端环境"验证时跑的命令（取自清单 detect.commands[0]）
    pub verify_spec: Option<ActivationVerifySpec>,
}

/// 激活某个版本；重复激活同一工具等于切换版本。
pub async fn activate_version(io: &dyn UserEnvIo, params: &ActivateParams<'_>) -> ActivateResult {
    let tool_id = params.tool_id;
    let version = params.version;
    let install_dir = params.install_dir;

    if !install_dir.exists() {
        return ActivateResult {
            ok: false,
            record: None,
            note: None,
            error: Some(format!("版本目录不存在：{}", install_dir.display())),
        };
    }

    let link_name_default = params
        .spec
        .link_name
        .clone()
        .unwrap_or_else(|| tool_id.to_string());
    let entries = match build_activate_entries(
        params.spec,
        &ActivateVars {
            install_dir: &install_dir.to_string_lossy(),
            current_dir: &get_link_path(&link_name_default).to_string_lossy(),
            version,
            tool_id,
        },
    ) {
        Ok(entries) => entries,
        Err(error) => {
            return ActivateResult {
                ok: false,
                record: None,
                note: None,
                error: Some(error.0),
            }
        }
    };

    // PATH 条目收敛到 %DEVKIT_HOME%。但用户已自定义 DEVKIT_HOME 指向别处时退回绝对路径
    //（否则 %DEVKIT_HOME%\current\<tool> 解析到他那个目录，激活等于没生效——安全审查 M2）。
    let mut path_entries: Vec<String> = entries
        .path_entries
        .iter()
        .map(|entry| to_devkit_home_var(entry))
        .collect();
    let mut user_owned_devkit_home: Option<String> = None;
    match io.read_env("DEVKIT_HOME") {
        Ok(Some(existing)) => {
            if !existing.eq_ignore_ascii_case(&get_devkit_home().to_string_lossy()) {
                user_owned_devkit_home = Some(existing.clone());
                path_entries = entries.path_entries.clone();
                log::warn!(
                    target: "activate",
                    "检测到用户已自行定义 DEVKIT_HOME={existing}，本次激活改用绝对路径，不覆盖该变量"
                );
            }
        }
        Ok(None) => {}
        Err(error) => {
            log::warn!(target: "activate", "读取 DEVKIT_HOME 失败，按未定义处理：{error}")
        }
    }

    let uses_devkit_home = path_entries
        .iter()
        .any(|entry| entry.contains(DEVKIT_HOME_VAR));

    let link_name = entries.link_name.clone();
    let mut state = read_activation_state();
    let previous = state
        .records
        .iter()
        .find(|record| record.tool_id == tool_id)
        .cloned();

    let link_path = get_link_path(&link_name);

    // 先建 junction 再动环境：junction 失败概率最低，失败就早退，PATH 还没动
    let link_result = match ensure_junction(&link_path, install_dir) {
        Ok(result) => result,
        Err(error) => {
            return ActivateResult {
                ok: false,
                record: None,
                note: None,
                error: Some(error),
            }
        }
    };
    log::info!(
        target: "activate",
        "{tool_id}@{version} 切换链接：{link_result} → {}",
        install_dir.display()
    );

    let record = ActivationRecord {
        tool_id: tool_id.to_string(),
        version: version.to_string(),
        link_name: link_name.clone(),
        link_path: link_path.to_string_lossy().to_string(),
        target: install_dir.to_string_lossy().to_string(),
        path_entries: path_entries.clone(),
        env: entries.env.clone(),
        activated_at: iso8601_now(),
    };
    state.records.retain(|item| item.tool_id != tool_id);
    state.records.push(record);

    // 先写环境变量再改 PATH：环境变量写失败时 PATH 还没动，回滚成本最低
    if uses_devkit_home && !state.owns_devkit_home_var {
        if let Err(error) = io.write_env("DEVKIT_HOME", Some(&get_devkit_home().to_string_lossy()))
        {
            return ActivateResult {
                ok: false,
                record: None,
                note: None,
                error: Some(error),
            };
        }
        state.owns_devkit_home_var = true;
    }
    for (name, value) in &entries.env {
        if let Err(error) = io.write_env(name, Some(value)) {
            return ActivateResult {
                ok: false,
                record: None,
                note: None,
                error: Some(error),
            };
        }
    }

    let synced = match sync_user_path(io, &mut state) {
        Ok(warning) => warning,
        Err(error) => {
            return ActivateResult {
                ok: false,
                record: None,
                note: None,
                error: Some(error),
            }
        }
    };
    if let Err(error) = save_activation_state(&state) {
        return ActivateResult {
            ok: false,
            record: None,
            note: None,
            error: Some(error),
        };
    }

    // 关键一步：用"新终端会看到的环境"验证命令真的能找到、且解析到 devkit 这一份
    let mut notes: Vec<String> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();
    if let Some(verify_spec) = &params.verify_spec {
        let (machine, user) = effective_paths();
        let verified =
            verify_activation(verify_spec, &machine, &user, &link_path.to_string_lossy()).await;
        if verified.ok && verified.resolved_from_devkit {
            notes.push(format!("新终端验证通过（{}）", verified.detail));
        } else if verified.ok {
            warnings.push(verified.detail);
        } else {
            warnings.push(format!("新终端验证未通过：{}", verified.detail));
        }
    }

    let head = match &previous {
        Some(prev) if prev.version != version => {
            format!("已从 {} 切换到 {}", prev.version, version)
        }
        _ => "已写入用户 PATH".to_string(),
    };
    if let Some(warning) = synced {
        warnings.push(warning);
    }
    if let Some(owned) = user_owned_devkit_home {
        warnings.push(format!(
            "你已自行定义 DEVKIT_HOME={owned}，devkit 没有覆盖它，本次激活写入的是绝对路径（不影响使用）"
        ));
    }

    let mut note = format!("{head}；新开的终端里生效");
    if !notes.is_empty() {
        note.push_str(&format!("；{}", notes.join("；")));
    }
    if !warnings.is_empty() {
        note.push_str(&format!("。注意：{}", warnings.join("；")));
    }

    ActivateResult {
        ok: true,
        record: state.records.last().cloned(),
        note: Some(note),
        error: None,
    }
}

/// 取消激活：移除 PATH 条目、环境变量与 junction；**不删安装文件**。
pub fn deactivate_tool(io: &dyn UserEnvIo, tool_id: &str) -> Result<Vec<String>, String> {
    let state = read_activation_state();
    let record = match state.records.iter().find(|item| item.tool_id == tool_id) {
        Some(record) => record.clone(),
        None => return Ok(Vec::new()),
    };

    let mut removed: Vec<String> = Vec::new();

    // 先拆 junction：失败概率最低；拆不掉宁可不动 PATH（避免"PATH 已清理、链接还在"的半成品）
    if remove_junction(Path::new(&record.link_path))? {
        removed.push(format!("切换链接 {}", record.link_path));
    }

    for name in record.env.keys() {
        io.write_env(name, None)?;
        removed.push(format!("环境变量 {name}"));
    }

    let mut next = state.clone();
    next.records.retain(|item| item.tool_id != tool_id);
    sync_user_path(io, &mut next)?;

    // 没有别的工具在用 %DEVKIT_HOME% 了，就把这个变量也收回
    if next.owns_devkit_home_var && next.records.is_empty() {
        io.write_env("DEVKIT_HOME", None)?;
        next.owns_devkit_home_var = false;
        removed.push("环境变量 DEVKIT_HOME".to_string());
    }
    save_activation_state(&next)?;

    for entry in &record.path_entries {
        removed.push(format!("PATH {entry}"));
    }
    log::info!(target: "activate", "已取消激活 {tool_id}：{}", removed.join("；"));
    Ok(removed)
}

/// 该工具当前激活的是哪个版本（没激活返回 None）。
pub fn get_activated_version(tool_id: &str) -> Option<String> {
    read_activation_state()
        .records
        .into_iter()
        .find(|record| record.tool_id == tool_id)
        .map(|record| record.version)
}

pub fn get_snapshot(io: &dyn UserEnvIo) -> ActivationSnapshot {
    let state = read_activation_state();
    let user_path = io.read_path().unwrap_or_default();
    ActivationSnapshot {
        records: state.records,
        bin_dir: get_shim_dir().to_string_lossy().to_string(),
        user_path,
        backup_file: state.backup_file,
        managed_path_entries: state.managed_path_entries,
    }
}

/// 只读探测：某个环境变量当前是否指向 devkit 的激活目录（诊断用）。
pub fn describe_env(io: &dyn UserEnvIo, name: &str) -> Option<String> {
    io.read_env(name).ok().flatten()
}

/// entries.env 的类型别名（清单 env 表）。
pub type EnvMap = HashMap<String, String>;

#[cfg(test)]
mod tests {
    use super::*;
    use devkit_types::manifest::ActivateSpec;

    /// 内存版 UserEnvIo（TS 测试里 vi.mock windows 模块的等价物）。
    struct FakeIo {
        env: std::sync::Mutex<HashMap<String, Option<String>>>,
        path: std::sync::Mutex<String>,
    }

    impl FakeIo {
        fn new(path: &str) -> Self {
            FakeIo {
                env: std::sync::Mutex::new(HashMap::new()),
                path: std::sync::Mutex::new(path.to_string()),
            }
        }
    }

    impl UserEnvIo for FakeIo {
        fn read_env(&self, name: &str) -> Result<Option<String>, String> {
            Ok(self.env.lock().unwrap().get(name).cloned().flatten())
        }
        fn write_env(&self, name: &str, value: Option<&str>) -> Result<(), String> {
            self.env
                .lock()
                .unwrap()
                .insert(name.to_string(), value.map(|value| value.to_string()));
            Ok(())
        }
        fn read_path(&self) -> Result<String, String> {
            Ok(self.path.lock().unwrap().clone())
        }
        fn write_path(&self, value: &str) -> Result<(), String> {
            *self.path.lock().unwrap() = value.to_string();
            Ok(())
        }
    }

    /// 环境变量注入不能并发（同进程共享）→ 所有场景串在一个测试里。
    /// 等价于 TS activate/index.test.ts 的用例集合。
    #[test]
    fn activate_lifecycle_scenarios() {
        // 与其它依赖环境变量的测试互斥（见 app_paths::ENV_TEST_LOCK）。
        // 用同步测试 + block_on 包住 async 体：锁 guard 不能跨 await（clippy await_holding_lock），
        // 且 current_thread runtime 内串行执行，环境变量在 await 点之间也不会被并行测试改写。
        let _guard = crate::app_paths::ENV_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(activate_lifecycle_body());
    }

    async fn activate_lifecycle_body() {
        let sandbox =
            std::env::temp_dir().join(format!("devkit-activate-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&sandbox);
        let app_data = sandbox.join("appdata");
        let data_root = sandbox.join("data");
        std::env::set_var("DEVKIT_APP_DATA", &app_data);
        std::env::set_var("DEVKIT_DATA_ROOT", &data_root);

        let io = FakeIo::new(r"C:\Windows;C:\Tools");
        let install = sandbox.join("versions").join("jdk-temurin").join("21");
        std::fs::create_dir_all(&install).unwrap();
        let spec = ActivateSpec {
            path_entries: Some(vec![r"{currentDir}\bin".to_string()]),
            env: Some({
                let mut map = HashMap::new();
                map.insert("JAVA_HOME".to_string(), "{currentDir}".to_string());
                map
            }),
            link_name: None,
        };

        // —— 场景 1：首次激活。PATH 收敛到 %DEVKIT_HOME%，junction 落在 dataRoot\current ——
        let result = activate_version(
            &io,
            &ActivateParams {
                tool_id: "jdk-temurin",
                version: "21.0.12.1",
                install_dir: &install,
                spec: &spec,
                verify_spec: None,
            },
        )
        .await;
        assert!(result.ok, "场景 1 失败：{:?}", result.error);
        let record = result.record.clone().expect("应有激活记录");
        // 数据根注入到沙箱（不在 homedir 下）→ %DEVKIT_HOME% 改写不适用，用绝对路径（行为与 TS 一致）
        assert_eq!(
            record.path_entries,
            vec![format!(
                r"{}\current\jdk-temurin\bin",
                data_root.to_string_lossy()
            )],
        );
        assert_eq!(
            io.read_env("JAVA_HOME").unwrap().as_deref(),
            Some(
                data_root
                    .join("current")
                    .join("jdk-temurin")
                    .to_string_lossy()
                    .as_ref()
            )
        );
        assert_eq!(
            io.read_env("DEVKIT_HOME").unwrap(),
            None,
            "数据根不在 homedir 下，不写 DEVKIT_HOME"
        );
        let expected_first = format!(r"{}\current\jdk-temurin\bin;", data_root.to_string_lossy());
        assert!(
            io.read_path().unwrap().starts_with(&expected_first),
            "PATH 应把 devkit 条目插到最前"
        );
        assert!(
            junction::is_junction(Path::new(&record.link_path)),
            "junction 应存在"
        );
        assert_eq!(
            junction::read_link_target(Path::new(&record.link_path))
                .unwrap()
                .to_lowercase(),
            install.to_string_lossy().to_lowercase()
        );
        // 备份文件已生成且内容为原 PATH
        let backup = read_activation_state().backup_file.clone();
        assert!(backup.is_some(), "首次激活应备份用户 PATH");
        assert_eq!(
            std::fs::read_to_string(backup.unwrap()).unwrap(),
            r"C:\Windows;C:\Tools"
        );

        // —— 场景 2：切版本 = 只改 junction，PATH 不变 ——
        let install2 = sandbox.join("versions").join("jdk-temurin").join("17");
        std::fs::create_dir_all(&install2).unwrap();
        let result2 = activate_version(
            &io,
            &ActivateParams {
                tool_id: "jdk-temurin",
                version: "17.0.9",
                install_dir: &install2,
                spec: &spec,
                verify_spec: None,
            },
        )
        .await;
        assert!(result2.ok, "场景 2 失败：{:?}", result2.error);
        assert!(result2
            .note
            .as_deref()
            .unwrap_or_default()
            .contains("已从 21.0.12.1 切换到 17.0.9"));
        let state2 = read_activation_state();
        assert_eq!(state2.records.len(), 1, "同工具只保留一条记录");
        assert_eq!(
            junction::read_link_target(Path::new(&state2.records[0].link_path)).unwrap(),
            install2.to_string_lossy()
        );
        assert_eq!(
            io.read_path()
                .unwrap()
                .matches("current\\jdk-temurin")
                .count(),
            1,
            "切版本不应重复插 PATH"
        );

        // —— 场景 3：取消激活。PATH/env/junction/记录全部移除，安装目录不动 ——
        let removed = deactivate_tool(&io, "jdk-temurin").unwrap();
        assert!(removed.iter().any(|item| item.starts_with("切换链接")));
        assert!(removed.iter().any(|item| item == "环境变量 JAVA_HOME"));
        assert!(
            !removed.iter().any(|item| item.contains("DEVKIT_HOME")),
            "非 devkit 创建的 DEVKIT_HOME 不动"
        );
        assert!(removed.iter().any(|item| item.starts_with("PATH ")));
        assert_eq!(io.read_path().unwrap(), r"C:\Windows;C:\Tools");
        assert_eq!(io.read_env("JAVA_HOME").unwrap(), None);
        assert_eq!(io.read_env("DEVKIT_HOME").unwrap(), None);
        assert!(!junction::is_junction(Path::new(
            &state2.records[0].link_path
        )));
        assert!(install2.exists(), "取消激活不删安装文件");

        // —— 场景 4：用户自定义 DEVKIT_HOME → 退回绝对路径，不覆盖变量 ——
        io.write_env("DEVKIT_HOME", Some("D:\\my-devkit-home"))
            .unwrap();
        let result4 = activate_version(
            &io,
            &ActivateParams {
                tool_id: "jdk-temurin",
                version: "21.0.12.1",
                install_dir: &install,
                spec: &spec,
                verify_spec: None,
            },
        )
        .await;
        assert!(result4.ok, "场景 4 失败：{:?}", result4.error);
        let record4 = result4.record.clone().expect("应有记录");
        assert_eq!(
            record4.path_entries,
            vec![format!(
                r"{}\current\jdk-temurin\bin",
                data_root.to_string_lossy()
            )],
            "应使用绝对路径（数据根注入沙箱，不在 homedir 下）"
        );
        assert_eq!(
            io.read_env("DEVKIT_HOME").unwrap().as_deref(),
            Some("D:\\my-devkit-home"),
            "不得覆盖用户变量"
        );
        assert!(result4
            .note
            .as_deref()
            .unwrap_or_default()
            .contains(r"DEVKIT_HOME=D:\my-devkit-home"));
        let _ = deactivate_tool(&io, "jdk-temurin").unwrap();
        assert_eq!(io.read_path().unwrap(), r"C:\Windows;C:\Tools");

        // —— 场景 5：版本目录不存在 → 失败且什么都不写 ——
        let bad = activate_version(
            &io,
            &ActivateParams {
                tool_id: "jdk-temurin",
                version: "99",
                install_dir: &sandbox.join("missing"),
                spec: &spec,
                verify_spec: None,
            },
        )
        .await;
        assert!(!bad.ok);
        assert!(bad
            .error
            .as_deref()
            .unwrap_or_default()
            .contains("版本目录不存在"));
        assert!(read_activation_state().records.is_empty());

        // —— 场景 6：激活记录损坏 → 重置为空而不是报错 ——
        std::fs::write(activation_file_path(), "{{{{not json").unwrap();
        assert_eq!(read_activation_state().records.len(), 0);

        // —— 场景 7：拒绝把非链接目录当 junction 替换 ——
        let real_dir = data_root.join("current").join("jdk-temurin");
        let _ = std::fs::remove_dir_all(&real_dir);
        std::fs::create_dir_all(&real_dir).unwrap();
        let err = ensure_junction(&real_dir, &install);
        assert!(err.is_err() && err.unwrap_err().contains("不是一个链接"));

        let _ = std::fs::remove_dir_all(&sandbox);
        std::env::remove_var("DEVKIT_APP_DATA");
        std::env::remove_var("DEVKIT_DATA_ROOT");
    }

    #[test]
    fn devkit_home_var_rewrite_respects_sibling_dirs() {
        let home_text = get_devkit_home().to_string_lossy().to_string();
        assert_eq!(
            to_devkit_home_var(&format!(r"{}\current\go", home_text)),
            r"%DEVKIT_HOME%\current\go"
        );
        // 前缀相似的兄弟目录不能误改
        assert_eq!(
            to_devkit_home_var(&format!(r"{}-other\current\go", home_text)),
            format!(r"{}-other\current\go", home_text)
        );
        // 无关路径原样返回
        assert_eq!(to_devkit_home_var(r"C:\Windows"), r"C:\Windows");
    }
}
