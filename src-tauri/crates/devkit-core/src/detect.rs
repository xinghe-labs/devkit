//! 工具检测（镜像 `src/main/core/detect/index.ts`，语义逐字对齐）。
//!
//! 判定顺序（SPEC FR-1）：1. 版本命令能跑通 → installed / version-mismatch；
//! 2. 文件或注册表有痕迹 → path-missing（已安装但 PATH 未生效）；
//! 3. 都没有 → not-installed。
//! 检测过程本身出错时返回 error，而不是 not-installed ——
//! 不能把"我没查出来"说成"你没装"。

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use devkit_types::detection::{
    DetectCommandSpec, DetectionResult, DetectionStatus, InstalledProgram, RegistryDetectRule,
};
use devkit_types::locale::Locale;
use devkit_types::manifest::ToolManifest;
use devkit_types::version::{extract_version, same_major};
use regex::Regex;

use crate::env_vars::expand_env_vars;
use crate::exec::{run_command, RunOptions};
use crate::manifest_fns::pick_recommended_version;

struct MatchHit {
    evidence: String,
    version: Option<String>,
}

fn build_command_regex(pattern: &str, cmd: &str) -> Result<Regex, String> {
    Regex::new(&format!("(?i){pattern}"))
        .map_err(|error| format!("检测正则非法 \"{pattern}\"（命令 {cmd}）：{error}"))
}

async fn match_command_async(spec: &DetectCommandSpec) -> Result<Option<MatchHit>, String> {
    let args = spec.args.clone().unwrap_or_default();
    let result = run_command(
        &spec.cmd,
        &args,
        &RunOptions {
            cwd: None,
            timeout_ms: Some(8000),
            env: None,
            cancel: None,
        },
    )
    .await;

    if result.spawn_error.is_some() {
        return Ok(None);
    }
    let output = format!("{}\n{}", result.stdout, result.stderr);

    if let Some(pattern) = &spec.expect_regex {
        let regex = build_command_regex(pattern, &spec.cmd)?;
        if !regex.is_match(&output) {
            return Ok(None);
        }
    } else if result.code != Some(0) {
        return Ok(None);
    }

    Ok(Some(MatchHit {
        evidence: format!("command:{}", spec.cmd),
        version: extract_version(Some(&output)),
    }))
}

fn match_file(files: Option<&Vec<String>>) -> Option<MatchHit> {
    for raw in files.map(|items| items.as_slice()).unwrap_or(&[]) {
        let expanded = expand_env_vars(raw);
        // 路径非法（例如含未解析的 %VAR%）时跳过
        if std::path::Path::new(&expanded).exists() {
            return Some(MatchHit {
                evidence: format!("file:{expanded}"),
                version: None,
            });
        }
    }
    None
}

fn match_registry(
    rules: Option<&Vec<RegistryDetectRule>>,
    programs: &[InstalledProgram],
) -> Option<MatchHit> {
    let rules = rules?;
    if rules.is_empty() || programs.is_empty() {
        return None;
    }

    for rule in rules {
        for program in programs {
            if program.hive != rule.hive || program.view != rule.view {
                continue;
            }
            if !program
                .key_path
                .to_lowercase()
                .contains(&rule.path.to_lowercase())
            {
                continue;
            }

            let mut matched = true;
            for (field, pattern) in &rule.match_rules {
                let Some(value) = program.fields.get(field) else {
                    matched = false;
                    break;
                };
                let Ok(expression) = Regex::new(&format!("(?i){pattern}")) else {
                    matched = false;
                    break;
                };
                if !expression.is_match(value) {
                    matched = false;
                    break;
                }
            }
            if !matched {
                continue;
            }

            let version_field = rule
                .version_from
                .clone()
                .unwrap_or_else(|| "DisplayVersion".to_string());
            return Some(MatchHit {
                evidence: format!("registry:{}", program.key_path),
                version: program.fields.get(&version_field).cloned(),
            });
        }
    }
    None
}

/// 检测单个工具（对齐 TS `detectTool`）。
pub async fn detect_tool(tool: &ToolManifest, programs: &[InstalledProgram]) -> DetectionResult {
    let started = Instant::now();
    let recommended = pick_recommended_version(tool);
    let recommended_version = recommended.map(|entry| entry.version).unwrap_or_default();
    let recommended_ref = if recommended_version.is_empty() {
        None
    } else {
        Some(recommended_version.as_str())
    };
    let mut errors: Vec<String> = Vec::new();

    let base = |status: DetectionStatus,
                installed_version: Option<String>,
                version_matches: bool,
                evidence: Option<String>,
                error: Option<String>| DetectionResult {
        tool_id: tool.id.clone(),
        status,
        installed_version,
        recommended_version: recommended_ref.map(|value| value.to_string()),
        version_matches,
        evidence,
        error,
        duration_ms: started.elapsed().as_millis() as u64,
    };

    // 1. 命令可用
    for spec in tool.detect.commands.as_deref().unwrap_or(&[]) {
        match match_command_async(spec).await {
            Ok(Some(hit)) => {
                let version_matches = same_major(hit.version.as_deref(), recommended_ref);
                let status = if version_matches {
                    DetectionStatus::Installed
                } else {
                    DetectionStatus::VersionMismatch
                };
                return base(
                    status,
                    hit.version,
                    version_matches,
                    Some(hit.evidence),
                    None,
                );
            }
            Ok(None) => continue,
            Err(message) => errors.push(message),
        }
    }

    // 2. 文件痕迹
    if let Some(file_hit) = match_file(tool.detect.files.as_ref()) {
        return base(
            DetectionStatus::PathMissing,
            None,
            true,
            Some(file_hit.evidence),
            None,
        );
    }

    // 3. 注册表痕迹
    if let Some(registry_hit) = match_registry(tool.detect.registry.as_ref(), programs) {
        return base(
            DetectionStatus::PathMissing,
            registry_hit.version,
            true,
            Some(registry_hit.evidence),
            None,
        );
    }

    let status = if errors.is_empty() {
        DetectionStatus::NotInstalled
    } else {
        DetectionStatus::Error
    };
    base(
        status,
        None,
        true,
        None,
        if errors.is_empty() {
            None
        } else {
            Some(errors.join("; "))
        },
    )
}

/// 并发检测全部工具。注册表只扫一次，所有工具共用（由调用方传入 programs）。
#[derive(Clone, Copy)]
pub struct DetectAllOptions {
    pub concurrency: Option<usize>,
}

pub type DetectCallback = Arc<dyn Fn(&DetectionResult) + Send + Sync>;

pub async fn detect_all(
    tools: &[ToolManifest],
    programs: &[InstalledProgram],
    options: DetectAllOptions,
    on_result: Option<DetectCallback>,
) -> Vec<DetectionResult> {
    let concurrency = options.concurrency.unwrap_or(4).clamp(1, 8);
    let started = Instant::now();

    let queue: Arc<Mutex<VecDeque<ToolManifest>>> =
        Arc::new(Mutex::new(tools.iter().cloned().collect()));
    let results: Arc<Mutex<Vec<DetectionResult>>> = Arc::new(Mutex::new(Vec::new()));
    let programs_ref = Arc::new(programs.to_vec());

    let worker_count = concurrency.min(queue.lock().unwrap().len().max(1));
    let mut handles = Vec::with_capacity(worker_count);
    for _ in 0..worker_count {
        let queue = queue.clone();
        let results = results.clone();
        let programs = programs_ref.clone();
        let on_result = on_result.clone();
        handles.push(tokio::spawn(async move {
            loop {
                let tool = {
                    let mut guard = queue.lock().unwrap();
                    guard.pop_front()
                };
                let Some(tool) = tool else {
                    return;
                };
                let result = detect_tool(&tool, programs.as_slice()).await;
                if let Some(callback) = &on_result {
                    callback(&result);
                }
                results.lock().unwrap().push(result);
            }
        }));
    }
    for handle in handles {
        let _ = handle.await;
    }

    let mut collected = results.lock().unwrap().clone();
    // 按入参顺序稳定排序（对齐 TS 的 order Map 排序）
    let order: HashMap<String, usize> = tools
        .iter()
        .enumerate()
        .map(|(index, tool)| (tool.id.clone(), index))
        .collect();
    collected.sort_by_key(|item| order.get(&item.tool_id).copied().unwrap_or(0));

    let installed = collected
        .iter()
        .filter(|item| item.status == DetectionStatus::Installed)
        .count();
    log::info!(
        target: "detect",
        "检测完成：{} 个工具，耗时 {}ms，已装 {} 个",
        collected.len(),
        started.elapsed().as_millis(),
        installed
    );

    collected
}

/// 用工具清单里的 zh-CN 名称（预检消息用；找不到则回退 id）。
pub fn tool_display_name(tool: Option<&ToolManifest>, fallback: &str) -> String {
    match tool {
        Some(tool) => {
            devkit_types::locale::localized_text(Some(&tool.name), Locale::ZhCn, fallback)
        }
        None => fallback.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use devkit_types::detection::{DetectSpec, RegistryHive, RegistryView};
    use devkit_types::manifest::{LicenseTier, ManifestStatus, ToolCategory};
    use std::collections::HashSet;

    fn program(
        hive: RegistryHive,
        view: RegistryView,
        key_path: &str,
        fields: &[(&str, &str)],
    ) -> InstalledProgram {
        InstalledProgram {
            hive,
            view,
            key_path: key_path.to_string(),
            fields: fields
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
        }
    }

    fn rule(
        hive: RegistryHive,
        view: RegistryView,
        path: &str,
        pattern: &str,
    ) -> RegistryDetectRule {
        RegistryDetectRule {
            hive,
            view,
            path: path.to_string(),
            match_rules: [("DisplayName".to_string(), pattern.to_string())]
                .into_iter()
                .collect(),
            version_from: None,
        }
    }

    fn tool_with_registry(rules: Vec<RegistryDetectRule>) -> ToolManifest {
        ToolManifest {
            id: "jdk-temurin".to_string(),
            category: ToolCategory::Runtime,
            tier: LicenseTier::L1,
            status: ManifestStatus::Ready,
            provider: None,
            name: [("zh-CN".to_string(), "Eclipse Temurin JDK".to_string())]
                .into_iter()
                .collect(),
            description: Default::default(),
            homepage: None,
            license: None,
            detect: DetectSpec {
                commands: None,
                files: None,
                registry: Some(rules),
            },
            versions: Vec::new(),
            notes: None,
        }
    }

    #[test]
    fn registry_match_returns_version_field() {
        // 「版本字段提取」用例（决策 D6 保留）
        let programs =
            vec![program(
            RegistryHive::Hklm,
            RegistryView::View64,
            "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{GUID}",
            &[
                ("DisplayName", "Eclipse Temurin JDK with Hotspot 21.0.5 (x64)"),
                ("DisplayVersion", "21.0.5"),
            ],
        )];
        let hit = match_registry(
            Some(&vec![rule(
                RegistryHive::Hklm,
                RegistryView::View64,
                "\\Uninstall",
                "Temurin JDK",
            )]),
            &programs,
        )
        .expect("应命中");
        assert_eq!(hit.version.as_deref(), Some("21.0.5"));
        assert!(hit.evidence.starts_with("registry:HKEY_LOCAL_MACHINE\\"));
    }

    #[test]
    fn registry_match_respects_hive_and_view() {
        // 「WOW6432Node 差异」用例（决策 D6 保留）：hive/view 不符不命中
        let programs = vec![program(
            RegistryHive::Hklm,
            RegistryView::View32,
            "HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\x",
            &[("DisplayName", "Node.js")],
        )];
        let rules = vec![rule(
            RegistryHive::Hklm,
            RegistryView::View64,
            "\\Uninstall",
            "Node",
        )];
        assert!(match_registry(Some(&rules), &programs).is_none());
        let rules32 = vec![rule(
            RegistryHive::Hklm,
            RegistryView::View32,
            "\\Uninstall",
            "Node",
        )];
        assert!(match_registry(Some(&rules32), &programs).is_some());
    }

    #[test]
    fn registry_match_requires_all_fields() {
        let programs = vec![program(
            RegistryHive::Hklm,
            RegistryView::View64,
            "HKEY_LOCAL_MACHINE\\SOFTWARE\\Uninstall\\x",
            &[("DisplayName", "Node.js")],
        )];
        let mut rule = rule(
            RegistryHive::Hklm,
            RegistryView::View64,
            "\\Uninstall",
            "Node",
        );
        rule.match_rules
            .insert("Publisher".to_string(), "Node\\.js Foundation".to_string());
        // Publisher 缺失 → 不命中
        assert!(match_registry(Some(&vec![rule]), &programs).is_none());
    }

    #[test]
    fn registry_match_version_from_override() {
        let programs = vec![program(
            RegistryHive::Hklm,
            RegistryView::View64,
            "HKEY_LOCAL_MACHINE\\SOFTWARE\\Uninstall\\x",
            &[("DisplayName", "Node.js"), ("Version", "9.9.9")],
        )];
        let mut rule = rule(
            RegistryHive::Hklm,
            RegistryView::View64,
            "\\Uninstall",
            "Node",
        );
        rule.version_from = Some("Version".to_string());
        let hit = match_registry(Some(&vec![rule]), &programs).expect("应命中");
        assert_eq!(hit.version.as_deref(), Some("9.9.9"));
    }

    #[test]
    fn file_match_expands_env_vars() {
        // %WINDIR% 必然存在
        let hit = match_file(Some(&vec!["%WINDIR%\\System32\\cmd.exe".to_string()]));
        assert!(hit.is_some(), "应命中 %WINDIR%\\System32\\cmd.exe");
        assert!(hit.unwrap().evidence.starts_with("file:"));
        assert!(match_file(Some(&vec!["%DEFINITELY_NOT_SET%\\x.exe".to_string()])).is_none());
    }

    #[test]
    fn invalid_regex_reports_chinese_error() {
        let error = build_command_regex("([", "node").unwrap_err();
        assert!(error.contains("检测正则非法"));
        assert!(error.contains("node"));
    }

    #[test]
    fn file_beats_not_installed_and_registry_falls_back() {
        // 无命令、无文件时靠注册表 → path-missing（已装但 PATH 未生效）
        let programs = vec![program(
            RegistryHive::Hklm,
            RegistryView::View64,
            "HKEY_LOCAL_MACHINE\\SOFTWARE\\Uninstall\\x",
            &[("DisplayName", "Node.js"), ("DisplayVersion", "22.12.0")],
        )];
        let tool = tool_with_registry(vec![rule(
            RegistryHive::Hklm,
            RegistryView::View64,
            "\\Uninstall",
            "Node",
        )]);
        let result = futures_lite_block(detect_tool(&tool, &programs));
        assert_eq!(result.status, DetectionStatus::PathMissing);
        assert_eq!(result.installed_version.as_deref(), Some("22.12.0"));
    }

    /// 最小 block_on：检测测试里跑 async 不需要整套 runtime 依赖。
    fn futures_lite_block<F: std::future::Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(future)
    }

    #[test]
    fn detect_all_keeps_input_order() {
        let tools = vec![tool_with_registry(Vec::new()), {
            let mut tool = tool_with_registry(Vec::new());
            tool.id = "other".to_string();
            tool
        }];
        let results = futures_lite_block(detect_all(
            &tools,
            &[],
            DetectAllOptions {
                concurrency: Some(4),
            },
            None,
        ));
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].tool_id, "jdk-temurin");
        assert_eq!(results[1].tool_id, "other");
        assert!(results
            .iter()
            .all(|item| item.status == DetectionStatus::NotInstalled));
    }

    #[test]
    fn detect_all_calls_back_per_result() {
        let seen: Arc<Mutex<HashSet<String>>> = Arc::new(Mutex::new(HashSet::new()));
        let captured = seen.clone();
        let tools = vec![tool_with_registry(Vec::new())];
        let callback: DetectCallback = Arc::new(move |result: &DetectionResult| {
            captured.lock().unwrap().insert(result.tool_id.clone());
        });
        futures_lite_block(detect_all(
            &tools,
            &[],
            DetectAllOptions { concurrency: None },
            Some(callback),
        ));
        assert!(seen.lock().unwrap().contains("jdk-temurin"));
    }
}
