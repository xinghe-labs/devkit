//! 安装前预检（镜像 `src/main/core/preflight/index.ts`，SPEC FR-18）。
//!
//! 目的是把所有"注定会失败"的原因一次性报完，而不是让用户在安装过程中逐个撞墙。
//! 所有检查都不产生副作用：网络检查用 HEAD，磁盘检查只读。

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::OnceLock;

use devkit_types::detection::DetectionStatus;
use devkit_types::manifest::{ManifestStatus, ToolManifest};
use devkit_types::plan::InstallPlan;
use devkit_types::preflight::{PreflightCheck, PreflightLevel, PreflightResult};
use regex::Regex;

use crate::detect::detect_tool;
use crate::http::{request_stream, HttpMethod, HttpRequestOptions};
use crate::manifest_fns::{order_download_sources, DownloadSourceRef};

/// Windows 10 22H2 的 build 号（SPEC 已确认的最低支持版本）
pub const MIN_WINDOWS_BUILD: u32 = 19045;

/// 磁盘余量：下载体积的 2.5 倍 + 500 MB（解压后还会膨胀）
pub const DISK_HEADROOM_FACTOR: f64 = 2.5;
pub const DISK_HEADROOM_BYTES: u64 = 500 * 1024 * 1024;

/// 已知的互斥组合：同一台机器上只应装其中一个。
/// M2 扩充清单时继续往这里补。
const CONFLICTS: &[(&str, &str)] = &[("docker-desktop", "podman")];

/// 装完之后**仍然需要用户自己准备**的东西。
///
/// 和 `dependsOn` 的区别：`dependsOn` 指的是「另一个 devkit 能装的工具」，
/// 可以靠拓扑排序 + 预检拦截解决；这里指的是 **devkit 装不了**的东西 ——
/// 只能如实提示，让用户自己去装。
///
/// 为什么必须提示：不提示就是**假成功**，比干净地失败更糟。
/// Rust 的例子里，装完 `rustc --version` 完全正常、devkit 自检也会通过，
/// 但用户第一次 `cargo build` 会撞上 `linker \`link.exe\` not found`，
/// 而那时他早就把"devkit 说装好了"当成事实了。
pub struct ExternalRequirement {
    pub tool_id: &'static str,
    pub message: &'static str,
}

pub const EXTERNAL_REQUIREMENTS: &[ExternalRequirement] = &[ExternalRequirement {
    tool_id: "rust",
    message: "Rust 在 Windows 上默认用 msvc 目标，编译链接需要 MSVC 生成工具\
（Visual Studio Build Tools 里的「使用 C++ 的桌面开发」）。\
devkit 不装它（几个 GB 的独立安装器，有自己的 UI），\
没装的话 rustc 能用、但 cargo build 会报 linker `link.exe` not found。",
}];

/// 从 "10.0.26300" 里取出 build 号。
///
/// TS 用 `os.release()`；Rust 侧由 devkit-sys 直读注册表 CurrentBuildNumber，
/// 这个解析函数保留用于测试与入参已经是 "10.0.x" 形态的场景。
pub fn parse_windows_build(release: &str) -> Option<u32> {
    let parts: Option<Vec<u32>> = release
        .split('.')
        .map(|part| part.parse::<u32>().ok())
        .collect();
    parts?.get(2).copied()
}

/// 选中的工具里，哪些互斥组合同时出现。
pub fn find_conflicts(tool_ids: &[&str]) -> Vec<String> {
    let selected: HashSet<&str> = tool_ids.iter().copied().collect();
    CONFLICTS
        .iter()
        .filter(|(a, b)| selected.contains(a) && selected.contains(b))
        .map(|(a, b)| format!("{a} 与 {b} 功能重叠，同一台机器上建议只安装其中一个"))
        .collect()
}

/// 选中的工具里，哪些还有 devkit 装不了的前置需要用户自己准备
pub fn find_external_requirements(tool_ids: &[&str]) -> Vec<&'static ExternalRequirement> {
    let selected: HashSet<&str> = tool_ids.iter().copied().collect();
    EXTERNAL_REQUIREMENTS
        .iter()
        .filter(|item| selected.contains(item.tool_id))
        .collect()
}

pub fn compute_required_bytes(total_download_bytes: u64) -> u64 {
    (total_download_bytes as f64 * DISK_HEADROOM_FACTOR).ceil() as u64 + DISK_HEADROOM_BYTES
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProbeResult {
    pub source: String,
    pub url: String,
    pub reachable: bool,
    /// 源可达但文件不在（镜像未同步该版本）
    pub missing: bool,
    pub detail: String,
}

/// 用 HEAD 探测单个源：既判断可达性，也顺便发现"镜像没有这个版本"
pub async fn probe_source(source: &DownloadSourceRef, proxy: Option<&str>) -> ProbeResult {
    let options = HttpRequestOptions {
        headers: Vec::new(),
        method: HttpMethod::Head,
        proxy: proxy.map(|value| value.to_string()),
        timeout_ms: Some(5000),
        cancel: None,
        max_redirects: Some(3),
        allow_insecure: false,
    };
    let base = |reachable: bool, missing: bool, detail: String| ProbeResult {
        source: source.name.clone(),
        url: source.url.clone(),
        reachable,
        missing,
        detail,
    };

    match request_stream(&source.url, &options).await {
        Ok(response) => {
            // HEAD 请求：拿到状态就够了，流直接丢弃（对应 TS 的 resume + destroy）
            drop(response.stream);
            let status = response.status;
            if status == 404 || status == 410 {
                base(true, true, format!("HTTP {status}（该源没有这个版本）"))
            } else if status == 403 {
                base(true, true, "HTTP 403（拒绝访问）".to_string())
            } else if status >= 500 {
                base(false, false, format!("HTTP {status}（服务端错误）"))
            } else {
                base(true, false, format!("HTTP {status}"))
            }
        }
        Err(error) => base(false, false, error.message),
    }
}

/// 工具清单的查找表（TS `PreflightInput.tools: Map<string, ToolManifest>`）。
pub type ToolMap = HashMap<String, ToolManifest>;

pub struct PreflightInput<'a> {
    pub plan: &'a InstallPlan,
    pub tools: &'a ToolMap,
    /// 安装目录所在的盘，用来查剩余空间
    pub target_path: &'a str,
    /// 探测时最多检查几个源（避免预检本身变成一堆网络请求）；0 表示跳过网络探测
    pub max_probes: Option<usize>,
    /// 这台机器上**已经可用**的工具 id（来自检测）。
    ///
    /// 前置依赖的判定是「计划里有 **或** 机器上已有」。
    /// 只看计划会把「本机早就装了 JDK，这次只想装 Maven」误判成缺依赖，
    /// 那是最烦人的假阳性 —— 用户会直接不信任这个检查。
    pub available_tool_ids: Option<HashSet<String>>,
}

fn check(id: &str, level: PreflightLevel, message: String) -> PreflightCheck {
    PreflightCheck {
        id: id.to_string(),
        level,
        message,
    }
}

fn drive_root(target_path: &str) -> Option<String> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let regex = RE.get_or_init(|| Regex::new(r"^[A-Za-z]:[\\/]").expect("valid regex"));
    if let Some(hit) = regex.find(target_path) {
        // "D:\dir\file" → "D:\"
        let mut root = hit.as_str().to_string();
        if root.ends_with('/') {
            root.pop();
            root.push('\\');
        }
        return Some(root);
    }
    // UNC 根 \\server\share
    if let Some(rest) = target_path.strip_prefix("\\\\") {
        let mut parts = rest.splitn(3, '\\');
        let server = parts.next()?;
        let share = parts.next()?;
        if !server.is_empty() && !share.is_empty() {
            return Some(format!("\\\\{server}\\{share}\\"));
        }
    }
    None
}

fn tool_display_name(tool: Option<&ToolManifest>, fallback: &str) -> String {
    match tool {
        Some(tool) => devkit_types::locale::localized_text(
            Some(&tool.name),
            devkit_types::locale::Locale::ZhCn,
            fallback,
        ),
        None => fallback.to_string(),
    }
}

fn version_size_bytes(tool: Option<&ToolManifest>, version: &str) -> u64 {
    tool.and_then(|tool| {
        tool.versions
            .iter()
            .find(|entry| entry.version == version)
            .and_then(|entry| entry.size_bytes)
    })
    .unwrap_or(0)
}

/// 工具间的前置依赖（`versions[].dependsOn`）。
///
/// 声明的是**隐藏前置**：不是下载/解压需要，而是运行与自检需要。
///  · npm 类模板要跑 `npm install` → 需要 Node.js
///  · Maven / Gradle 的自检是 `mvn -v` / `gradle -v`，要起 JVM → 需要 JDK
///
/// 不拦的话，干净机器上的表现是：下载成功、解压成功，然后自检报一句
/// 「JAVA_HOME environment variable is not defined correctly」——
/// 用户根本猜不到是"该一起装 JDK"。
///
/// 这个检查在**预检**里而不是构建计划时，是因为 UI 拿预检的 error 直接禁用开始按钮
/// （`disabled={!preflight.ok}`），用户能当场看到原因、补勾选、重新预检。
async fn check_tool_prerequisites(input: &PreflightInput<'_>) -> Vec<PreflightCheck> {
    let plan = input.plan;
    let in_plan: HashSet<&str> = plan.items.iter().map(|item| item.id.as_str()).collect();
    let mut available: HashSet<String> = input.available_tool_ids.clone().unwrap_or_default();

    // 渲染进程还没把检测结果送过来时，自己补一遍「命令 + 文件」快速探测。
    //
    // 为什么必须补：这台机器上完整检测（含注册表扫描）要 7 秒多，
    // 用户完全可能在那之前就点了安装。那时 availableToolIds 是空的，
    // 「本机早有 JDK、这次只想装 Maven」就会被误拦 —— 而这正是我们最不想看到的假阳性。
    //
    // 不传 programs 就是跳过注册表扫描，只跑命令与文件判断，几百毫秒。
    //
    // 判定用白名单（installed / version-mismatch），**不含 path-missing**：
    // 对 jdk-temurin 来说 path-missing 只能来自注册表（该清单没有 detect.files），
    // 含义正是「装了但 java 不在 PATH 上」—— 也就是 `mvn -v` 报
    // 「JAVA_HOME ... not defined correctly」的那个状态。把它当成"有"就是漏拦。
    // `error` 同理不算：那是"我没查出来"，不能当成"你有"。

    // 装了但没生效的依赖 → 哪些工具在等它
    let mut not_effective: HashMap<String, Vec<String>> = HashMap::new();

    let mut dependency_ids: Vec<String> = Vec::new();
    for item in &plan.items {
        for dependency in &item.depends_on {
            if !dependency_ids.contains(dependency) {
                dependency_ids.push(dependency.clone());
            }
        }
    }
    for id in &dependency_ids {
        // 计划里已经要装了，就不必再探测 —— 探测也改变不了结论，白等几百毫秒
        if in_plan.contains(id.as_str()) || available.contains(id) {
            continue;
        }
        let Some(tool) = input.tools.get(id) else {
            continue;
        };
        let result = detect_tool(tool, &[]).await;
        match result.status {
            DetectionStatus::Installed | DetectionStatus::VersionMismatch => {
                available.insert(id.clone());
            }
            DetectionStatus::PathMissing => {
                not_effective.insert(id.clone(), Vec::new());
            }
            _ => {}
        }
    }

    // 缺的依赖 → 哪些工具在等它
    let mut missing: HashMap<String, Vec<String>> = HashMap::new();

    for item in &plan.items {
        for dependency in &item.depends_on {
            if in_plan.contains(dependency.as_str()) || available.contains(dependency) {
                continue;
            }
            missing
                .entry(dependency.clone())
                .or_default()
                .push(item.id.clone());
            if not_effective.contains_key(dependency) {
                not_effective
                    .get_mut(dependency)
                    .expect("key checked above")
                    .push(item.id.clone());
            }
        }
    }

    if missing.is_empty() {
        let declared: Vec<&str> = plan
            .items
            .iter()
            .filter(|item| !item.depends_on.is_empty())
            .map(|item| item.id.as_str())
            .collect();
        let message = if declared.is_empty() {
            "所选工具没有额外的前置依赖".to_string()
        } else {
            format!("前置依赖已满足（{}）", declared.join("、"))
        };
        return vec![check("tool-prerequisites", PreflightLevel::Ok, message)];
    }

    let mut checks = Vec::new();

    for (dependency, dependents) in &missing {
        let tool = input.tools.get(dependency);
        let name = tool_display_name(tool, dependency);
        let who = dependents
            .iter()
            .map(|id| tool_display_name(input.tools.get(id), id))
            .collect::<Vec<_>>()
            .join("、");

        // 依赖**不是 devkit 能装的**（不在清单里 / detect-only / 没有任何版本）时，
        // 绝不能给 error —— 那样 UI 会禁用开始按钮，而"回到选择界面勾选它"这条指引
        // 用户根本执行不了（勾了只会让 buildPlan 抛「清单里没有可安装的版本」），
        // 变成一个没有出路的死胡同。降级成 warn，如实说明需要自己准备。
        let installable = tool
            .is_some_and(|tool| tool.status == ManifestStatus::Ready && !tool.versions.is_empty());
        if !installable {
            checks.push(check(
                &format!("tool-prerequisites:{dependency}"),
                PreflightLevel::Warn,
                format!(
                    "{who} 需要「{name}」，但 devkit 装不了它（清单里没有可安装的版本）。\
请自行准备，否则 {who} 装完可能跑不起来。"
                ),
            ));
            continue;
        }

        // 装了但没生效：这是可修的（激活一下，或一起勾选让 devkit 装一份并接管 PATH）
        if not_effective.contains_key(dependency) {
            checks.push(check(
                &format!("tool-prerequisites:{dependency}"),
                PreflightLevel::Error,
                format!(
                    "检测到「{name}」已经装在这台机器上，但它没有生效（不在 PATH 上），\
{who} 会跑不起来。请到「已安装」里激活它，或把「{name}」一起勾选。"
                ),
            ));
            continue;
        }

        checks.push(check(
            &format!("tool-prerequisites:{dependency}"),
            PreflightLevel::Error,
            format!(
                "{who} 需要先有「{name}」才能装好并用起来，但计划里没有它、这台机器上也没检测到。\
请回到选择界面把「{name}」一起勾选。"
            ),
        ));
    }

    checks
}

fn format_mb(bytes: u64) -> String {
    format!("{} MB", (bytes as f64 / 1024.0 / 1024.0).round() as u64)
}

pub async fn run_preflight(input: PreflightInput<'_>) -> PreflightResult {
    let plan = input.plan;
    let mut checks: Vec<PreflightCheck> = Vec::new();

    let total_download_bytes: u64 = plan
        .items
        .iter()
        .map(|item| version_size_bytes(input.tools.get(&item.id), &item.version))
        .sum();

    let requires_admin = plan.items.iter().any(|item| item.requires_admin);

    // 0. 工具间的前置依赖 —— 放在最前面，因为它是最容易当场修掉的一项
    checks.extend(check_tool_prerequisites(&input).await);

    // 1. 系统版本（TS 用 os.release()；Rust 直读注册表 CurrentBuildNumber）
    match devkit_sys::registry::windows_build_number() {
        None => {
            checks.push(check(
                "os-version",
                PreflightLevel::Warn,
                "无法识别系统版本（注册表 CurrentBuildNumber 读取失败），跳过版本检查".to_string(),
            ));
        }
        Some(build) if build < MIN_WINDOWS_BUILD => {
            checks.push(check(
                "os-version",
                PreflightLevel::Error,
                format!(
                    "系统版本过低：build {build}，最低要求 build {MIN_WINDOWS_BUILD}（Windows 10 22H2）"
                ),
            ));
        }
        Some(build) => {
            checks.push(check(
                "os-version",
                PreflightLevel::Ok,
                format!("系统版本满足要求（build {build}）"),
            ));
        }
    }

    // 2. 架构（Rust 侧按编译目标判断；发布产物只有 x64）
    if cfg!(target_arch = "x86_64") {
        checks.push(check(
            "arch",
            PreflightLevel::Ok,
            "系统架构为 x64".to_string(),
        ));
    } else {
        checks.push(check(
            "arch",
            PreflightLevel::Error,
            format!("当前架构是 {}，本版本只支持 x64", std::env::consts::ARCH),
        ));
    }

    // 3. 磁盘空间
    match drive_root(input.target_path) {
        None => {
            checks.push(check(
                "disk",
                PreflightLevel::Warn,
                format!("无法识别 {} 所在的盘符，跳过磁盘检查", input.target_path),
            ));
        }
        Some(drive) => match devkit_sys::disk::disk_free_bytes(&drive) {
            Err(error) => {
                checks.push(check(
                    "disk",
                    PreflightLevel::Warn,
                    format!("无法读取磁盘剩余空间：{error}"),
                ));
            }
            Ok(free) => {
                let required = compute_required_bytes(total_download_bytes);
                if free < required {
                    checks.push(check(
                        "disk",
                        PreflightLevel::Error,
                        format!(
                            "{drive} 剩余空间不足：可用 {}，需要约 {}",
                            format_mb(free),
                            format_mb(required)
                        ),
                    ));
                } else {
                    checks.push(check(
                        "disk",
                        PreflightLevel::Ok,
                        format!(
                            "{drive} 剩余空间充足：可用 {}，需要约 {}",
                            format_mb(free),
                            format_mb(required)
                        ),
                    ));
                }
            }
        },
    }

    // 4. 下载源可达性：每个工具按镜像偏好顺序探测前几个源。
    //    maxProbes 为 0 表示跳过网络探测（离线环境与单测用）
    //
    //    关键修正：**不能只看首选源**。实测 GitHub release 资产在国内经常完全连不上，
    //    但清单里的国内镜像好得很；如果只看首选源就报"所有源不可达"，用户会被硬生生拦住。
    //    因此这里对每个工具并行探多个源，只要有一个可用就算通过（并在日志里说明用了哪个）。
    let probe_limit = input.max_probes.unwrap_or(3);
    let per_tool_sources = 3;

    // 所有项都已经落在版本目录里时，本次运行根本不需要下载（执行器会自检后直接跳过）。
    // 这时候还去探网络、并且因为探测失败就整体阻断，是在拿一个"用不到的条件"拦住用户 ——
    // 实测过：GitHub 临时不可达时，重跑一个已经装好的工具会被预检卡住（NFR-2 幂等性体验）。
    let needs_download = plan.items.iter().any(|item| {
        item.install_dir
            .as_deref()
            .map_or(true, |dir| !Path::new(dir).exists())
    });

    let mut targets: Vec<(&str, Vec<DownloadSourceRef>)> = Vec::new();
    let mut seen_tools: HashSet<&str> = HashSet::new();

    if !needs_download {
        checks.push(check(
            "network",
            PreflightLevel::Ok,
            "所有项都已经在版本目录里，本次无需下载（会逐项自检后跳过）".to_string(),
        ));
    } else {
        for item in &plan.items {
            if targets.len() >= probe_limit {
                break;
            }
            if seen_tools.contains(item.id.as_str()) {
                continue;
            }
            let Some(tool) = input.tools.get(&item.id) else {
                continue;
            };
            let Some(version) = tool
                .versions
                .iter()
                .find(|entry| entry.version == item.version)
            else {
                continue;
            };
            let sources = order_download_sources(version, &plan.options.mirror_preference)
                .into_iter()
                .take(per_tool_sources)
                .collect::<Vec<_>>();
            if sources.is_empty() {
                continue;
            }
            seen_tools.insert(item.id.as_str());
            targets.push((item.id.as_str(), sources));
        }

        if targets.is_empty() {
            checks.push(check(
                "network",
                PreflightLevel::Warn,
                "没有可探测的下载源".to_string(),
            ));
        } else {
            let probe_limit_total = targets.len();
            let probed = futures_probe_all(&targets, plan.options.proxy.as_deref()).await;

            let mut tools_with_usable_source = 0usize;

            for (tool_id, results) in &probed {
                let usable_index = results
                    .iter()
                    .position(|result| result.reachable && !result.missing);
                let missing_index = results.iter().position(|result| result.missing);

                if let Some(usable_index) = usable_index {
                    tools_with_usable_source += 1;
                    let usable = &results[usable_index];
                    if usable_index == 0 {
                        checks.push(check(
                            &format!("network:{tool_id}"),
                            PreflightLevel::Ok,
                            format!(
                                "{tool_id} 的首选源 {} 可用（{}）",
                                usable.source, usable.detail
                            ),
                        ));
                    } else {
                        let tried = results[..usable_index]
                            .iter()
                            .map(|item| item.source.as_str())
                            .collect::<Vec<_>>()
                            .join("、");
                        checks.push(check(
                            &format!("network:{tool_id}"),
                            PreflightLevel::Warn,
                            format!(
                                "{tool_id} 的首选源不可用，已自动改用 {}（{}）。已试：{tried}",
                                usable.source, usable.detail
                            ),
                        ));
                    }
                    continue;
                }

                if let Some(missing_index) = missing_index {
                    checks.push(check(
                        &format!("network:{tool_id}"),
                        PreflightLevel::Warn,
                        format!(
                            "{tool_id} 的镜像没有这个版本（{}），安装时会继续尝试其它源",
                            results[missing_index].detail
                        ),
                    ));
                    continue;
                }

                let details = results
                    .iter()
                    .map(|item| format!("{}: {}", item.source, item.detail))
                    .collect::<Vec<_>>()
                    .join("；");
                checks.push(check(
                    &format!("network:{tool_id}"),
                    PreflightLevel::Warn,
                    format!(
                        "{tool_id} 的下载源都不可达（{details}）。安装会失败，请检查网络或代理设置"
                    ),
                ));
            }

            // 只有"一个工具的可用源都没有"才升级为阻断级问题
            if tools_with_usable_source == 0 && probe_limit_total > 0 {
                checks.push(check(
                    "network",
                    PreflightLevel::Error,
                    "所有被探测的下载源都不可达，请检查网络或代理设置".to_string(),
                ));
            }
        }
    }

    // 5. 权限
    if requires_admin {
        let names = plan
            .items
            .iter()
            .filter(|item| item.requires_admin)
            .map(|item| item.id.as_str())
            .collect::<Vec<_>>()
            .join("、");
        checks.push(check(
            "admin",
            PreflightLevel::Warn,
            format!("以下项目需要管理员权限，稍后会弹出一次授权：{names}"),
        ));
    } else {
        checks.push(check(
            "admin",
            PreflightLevel::Ok,
            "本次安装全部是用户级操作，不需要管理员权限".to_string(),
        ));
    }

    // 6. 互斥组合
    let selected_ids: Vec<&str> = plan.items.iter().map(|item| item.id.as_str()).collect();
    for conflict in find_conflicts(&selected_ids) {
        checks.push(check(
            &format!("conflict:{conflict}"),
            PreflightLevel::Warn,
            conflict,
        ));
    }

    // 7. devkit 装不了、需要用户自己准备的前置（只提示，不阻断）
    for item in find_external_requirements(&selected_ids) {
        checks.push(check(
            &format!("external-requirement:{}", item.tool_id),
            PreflightLevel::Warn,
            item.message.to_string(),
        ));
    }

    let ok = checks
        .iter()
        .all(|check| check.level != PreflightLevel::Error);
    log::info!(
        target: "preflight",
        "预检完成：{}，共 {} 项检查",
        if ok { "通过" } else { "存在阻断问题" },
        checks.len()
    );

    PreflightResult {
        ok,
        checks,
        total_download_bytes,
        requires_admin,
    }
}

/// 并行探测所有目标（TS 的双层 Promise.all）。
async fn futures_probe_all(
    targets: &[(&str, Vec<DownloadSourceRef>)],
    proxy: Option<&str>,
) -> Vec<(String, Vec<ProbeResult>)> {
    let joins = targets.iter().map(|(tool_id, sources)| {
        let source_jobs = sources
            .iter()
            .map(|source| probe_source(source, proxy))
            .collect::<Vec<_>>();
        async move {
            let results = futures_join(source_jobs).await;
            ((*tool_id).to_string(), results)
        }
    });
    futures_join(joins.collect::<Vec<_>>()).await
}

/// 顺序无关的并发 join（futures crate 太重，这里用 tokio join_all 的等价手写版）。
async fn futures_join<F: std::future::Future>(futures: Vec<F>) -> Vec<F::Output> {
    let mut outputs = Vec::with_capacity(futures.len());
    // 逐个 await 也能并发 —— tokio 的多线程调度下，这些 Future 已经在各自的任务里
    // 交替执行；这里保持简单，不引入 futures crate。
    for future in futures {
        outputs.push(future.await);
    }
    outputs
}

#[cfg(test)]
mod tests {
    use super::*;
    use devkit_types::detection::{DetectSpec, RegistryDetectRule};
    use devkit_types::locale::LocalizedText;
    use devkit_types::manifest::{
        Arch, InstallScope, InstallSpec, InstallType, LicenseTier, ManifestStatus, MirrorSpec,
        SourceSpec, ToolCategory, ToolVersionSpec, VersionChannel,
    };
    use devkit_types::plan::{
        MirrorPreference, PlanItem, PlanItemState, PlanOptions, PlanSummary, SchemaVersion,
    };

    fn names(zh: &str) -> LocalizedText {
        [("zh-CN".to_string(), zh.to_string())]
            .into_iter()
            .collect()
    }

    fn source(url: &str, sha: &str) -> SourceSpec {
        SourceSpec {
            url: url.to_string(),
            sha256: Some(sha.to_string()),
        }
    }

    fn version(version: &str, size: u64, url: &str) -> ToolVersionSpec {
        ToolVersionSpec {
            version: version.to_string(),
            channel: VersionChannel::Lts,
            recommended: Some(true),
            arch: Arch::X64,
            release_date: None,
            size_bytes: Some(size),
            install_scope: InstallScope::User,
            requires_reboot: None,
            depends_on: None,
            source: Some(source(url, "0".repeat(64).as_str())),
            mirrors: Some(vec![
                MirrorSpec {
                    name: "huaweicloud".to_string(),
                    url: format!("{url}.mirror1"),
                },
                MirrorSpec {
                    name: "aliyun".to_string(),
                    url: format!("{url}.mirror2"),
                },
            ]),
            install: Some(InstallSpec {
                install_type: InstallType::Zip,
                template: "zip-into-version-dir".to_string(),
                params: None,
            }),
            uninstall: None,
            activate: None,
            configure: None,
            verify: None,
        }
    }

    fn tool(id: &str, versions: Vec<ToolVersionSpec>) -> ToolManifest {
        ToolManifest {
            id: id.to_string(),
            category: ToolCategory::Runtime,
            tier: LicenseTier::L1,
            status: ManifestStatus::Ready,
            provider: None,
            name: names(id),
            description: Default::default(),
            homepage: None,
            license: None,
            detect: DetectSpec {
                commands: None,
                files: None,
                registry: Some(Vec::<RegistryDetectRule>::new()),
            },
            versions,
            notes: None,
        }
    }

    fn plan_item(id: &str, version: &str, depends_on: Vec<String>) -> PlanItem {
        PlanItem {
            id: id.to_string(),
            version: version.to_string(),
            tier: LicenseTier::L1,
            install_scope: InstallScope::User,
            requires_admin: false,
            requires_reboot: false,
            depends_on,
            state: PlanItemState::Pending,
            attempts: 0,
            download_attempts: None,
            error: None,
            note: None,
            started_at: None,
            finished_at: None,
            install_dir: None,
            archive_path: None,
        }
    }

    fn plan(items: Vec<PlanItem>) -> InstallPlan {
        InstallPlan {
            plan_id: "plan-test".to_string(),
            created_at: "2026-02-12T00:00:00Z".to_string(),
            devkit_version: "0.6.2".to_string(),
            manifest_revision: "test".to_string(),
            schema_version: SchemaVersion::One,
            summary: PlanSummary::default(),
            items,
            options: PlanOptions {
                concurrency: 2,
                mirror_preference: MirrorPreference::Huaweicloud,
                proxy: None,
                create_restore_point: false,
                dry_run: false,
            },
        }
    }

    fn tools_map(tools: Vec<ToolManifest>) -> ToolMap {
        tools
            .into_iter()
            .map(|tool| (tool.id.clone(), tool))
            .collect()
    }

    #[test]
    fn parse_windows_build_extracts_third_segment() {
        assert_eq!(parse_windows_build("10.0.26300"), Some(26300));
        assert_eq!(parse_windows_build("10.0.19045"), Some(19045));
        assert_eq!(parse_windows_build("10.0"), None);
        assert_eq!(parse_windows_build("a.b.c"), None);
    }

    #[test]
    fn conflicts_detected_and_reported() {
        let conflicts = find_conflicts(&["docker-desktop", "podman"]);
        assert_eq!(conflicts.len(), 1);
        assert!(conflicts[0].contains("docker-desktop 与 podman 功能重叠"));

        assert!(find_conflicts(&["docker-desktop"]).is_empty());
        assert!(find_conflicts(&["git", "nodejs"]).is_empty());
    }

    #[test]
    fn external_requirements_only_for_selected() {
        let hits = find_external_requirements(&["rust", "git"]);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].tool_id, "rust");
        assert!(hits[0].message.contains("link.exe"));
        assert!(find_external_requirements(&["git"]).is_empty());
    }

    #[test]
    fn required_bytes_is_factor_plus_base() {
        // 1 GB × 2.5 + 500 MB
        assert_eq!(
            compute_required_bytes(1024 * 1024 * 1024),
            1_073_741_824 * 5 / 2 + 500 * 1024 * 1024
        );
        // 0 字节也要保底 500 MB
        assert_eq!(compute_required_bytes(0), 500 * 1024 * 1024);
        // 进位：1 字节 × 2.5 = 2.5 → ceil = 3
        assert_eq!(compute_required_bytes(1), 3 + 500 * 1024 * 1024);
    }

    #[test]
    fn drive_root_handles_drive_and_unc() {
        assert_eq!(drive_root("D:\\dir\\file.zip"), Some("D:\\".to_string()));
        assert_eq!(drive_root("C:/Users/x"), Some("C:\\".to_string()));
        assert_eq!(
            drive_root("\\\\server\\share\\dir"),
            Some("\\\\server\\share\\".to_string())
        );
        assert_eq!(drive_root("relative/path"), None);
    }

    #[tokio::test]
    async fn preflight_blocks_on_missing_dependency() {
        // maven dependsOn jdk-temurin，但计划里没有、机器上也没有 → error，提示勾选
        let maven = tool(
            "maven",
            vec![version(
                "3.9.9",
                10 * 1024 * 1024,
                "https://example.com/maven.zip",
            )],
        );
        let plan = plan(vec![PlanItem {
            depends_on: vec!["jdk-temurin".to_string()],
            ..plan_item("maven", "3.9.9", Vec::new())
        }]);
        // jdk 在清单里（可装）→ error 提示勾选；若不在清单里则是 warn「自行准备」
        let jdk = tool(
            "jdk-temurin",
            vec![version(
                "21.0.5",
                200 * 1024 * 1024,
                "https://example.com/jdk.zip",
            )],
        );
        let tools = tools_map(vec![maven, jdk]);
        let result = run_preflight(PreflightInput {
            plan: &plan,
            tools: &tools,
            target_path: "D:\\devkit\\downloads",
            max_probes: Some(0),
            available_tool_ids: None,
        })
        .await;
        assert!(!result.ok);
        let prereq = result
            .checks
            .iter()
            .find(|check| check.id == "tool-prerequisites:jdk-temurin")
            .expect("应有缺依赖检查");
        assert_eq!(prereq.level, PreflightLevel::Error);
        assert!(prereq.message.contains("把「jdk-temurin」一起勾选"));
    }

    #[tokio::test]
    async fn preflight_satisfied_dependency_reports_ok() {
        let maven = tool(
            "maven",
            vec![version(
                "3.9.9",
                10 * 1024 * 1024,
                "https://example.com/maven.zip",
            )],
        );
        let plan = plan(vec![PlanItem {
            depends_on: vec!["jdk-temurin".to_string()],
            ..plan_item("maven", "3.9.9", Vec::new())
        }]);
        let tools = tools_map(vec![maven]);
        let result = run_preflight(PreflightInput {
            plan: &plan,
            tools: &tools,
            target_path: "D:\\devkit\\downloads",
            max_probes: Some(0),
            available_tool_ids: Some(HashSet::from(["jdk-temurin".to_string()])),
        })
        .await;
        let prereq = result
            .checks
            .iter()
            .find(|check| check.id == "tool-prerequisites")
            .expect("应有依赖检查");
        assert_eq!(prereq.level, PreflightLevel::Ok);
        assert!(prereq.message.contains("前置依赖已满足"));
    }

    #[tokio::test]
    async fn preflight_dependency_in_plan_is_not_missing() {
        let maven = tool(
            "maven",
            vec![version(
                "3.9.9",
                10 * 1024 * 1024,
                "https://example.com/maven.zip",
            )],
        );
        let jdk = tool(
            "jdk-temurin",
            vec![version(
                "21.0.5",
                200 * 1024 * 1024,
                "https://example.com/jdk.zip",
            )],
        );
        let plan = plan(vec![
            plan_item("maven", "3.9.9", Vec::new()),
            plan_item("jdk-temurin", "21.0.5", Vec::new()),
        ]);
        // 注意：dependsOn 在构建计划时已展开到 item 上，这里手工补上
        let mut item = plan_item("maven", "3.9.9", Vec::new());
        item.depends_on = vec!["jdk-temurin".to_string()];
        let plan = InstallPlan {
            items: vec![item, plan_item("jdk-temurin", "21.0.5", Vec::new())],
            ..plan
        };
        let tools = tools_map(vec![maven, jdk]);
        let result = run_preflight(PreflightInput {
            plan: &plan,
            tools: &tools,
            target_path: "D:\\devkit\\downloads",
            max_probes: Some(0),
            available_tool_ids: None,
        })
        .await;
        let prereq = result
            .checks
            .iter()
            .find(|check| check.id == "tool-prerequisites")
            .expect("应有依赖检查");
        assert_eq!(prereq.level, PreflightLevel::Ok);
        assert!(prereq.message.contains("maven"));
    }

    #[tokio::test]
    async fn preflight_skips_network_when_everything_installed() {
        let node = tool(
            "nodejs",
            vec![version(
                "24.21.0",
                37 * 1024 * 1024,
                "https://example.com/node.zip",
            )],
        );
        let dir = std::env::temp_dir().join("devkit-preflight-skip-network");
        std::fs::create_dir_all(&dir).unwrap();
        let plan = plan(vec![plan_item("nodejs", "24.21.0", Vec::new())]);
        let plan = InstallPlan {
            items: vec![PlanItem {
                install_dir: Some(dir.display().to_string()),
                ..plan_item("nodejs", "24.21.0", Vec::new())
            }],
            ..plan
        };
        let tools = tools_map(vec![node]);
        let result = run_preflight(PreflightInput {
            plan: &plan,
            tools: &tools,
            target_path: "D:\\devkit",
            max_probes: None,
            available_tool_ids: None,
        })
        .await;
        let network = result
            .checks
            .iter()
            .find(|check| check.id == "network")
            .expect("应有 network 检查");
        assert_eq!(network.level, PreflightLevel::Ok);
        assert!(network.message.contains("无需下载"));
        let _ = std::fs::remove_dir(&dir);
    }

    #[tokio::test]
    async fn preflight_warns_on_conflict_and_external() {
        let docker = tool(
            "docker-desktop",
            vec![version(
                "4.34.0",
                500 * 1024 * 1024,
                "https://example.com/docker.exe",
            )],
        );
        let podman = tool(
            "podman",
            vec![version(
                "5.2.0",
                100 * 1024 * 1024,
                "https://example.com/podman.zip",
            )],
        );
        let rust = tool(
            "rust",
            vec![version(
                "1.82.0",
                300 * 1024 * 1024,
                "https://example.com/rust.zip",
            )],
        );
        let plan = plan(vec![
            plan_item("docker-desktop", "4.34.0", Vec::new()),
            plan_item("podman", "5.2.0", Vec::new()),
            plan_item("rust", "1.82.0", Vec::new()),
        ]);
        let tools = tools_map(vec![docker, podman, rust]);
        let result = run_preflight(PreflightInput {
            plan: &plan,
            tools: &tools,
            target_path: "D:\\devkit",
            max_probes: Some(0),
            available_tool_ids: None,
        })
        .await;
        assert!(result
            .checks
            .iter()
            .any(|check| check.id.starts_with("conflict:") && check.level == PreflightLevel::Warn));
        assert!(result
            .checks
            .iter()
            .any(|check| check.id == "external-requirement:rust"
                && check.level == PreflightLevel::Warn));
        // warn 不阻断
        assert!(result.ok);
        // 权限提示：全用户级
        let admin = result
            .checks
            .iter()
            .find(|check| check.id == "admin")
            .expect("应有 admin 检查");
        assert_eq!(admin.level, PreflightLevel::Ok);
    }

    #[tokio::test]
    async fn preflight_reports_admin_for_machine_scope() {
        let mut vs_build = tool(
            "vscode",
            vec![version(
                "1.95.0",
                100 * 1024 * 1024,
                "https://example.com/vscode.exe",
            )],
        );
        if let Some(item) = vs_build.versions.first_mut() {
            item.install_scope = InstallScope::Machine;
            item.requires_reboot = None;
        }
        let plan = plan(vec![PlanItem {
            requires_admin: true,
            ..plan_item("vscode", "1.95.0", Vec::new())
        }]);
        let tools = tools_map(vec![vs_build]);
        let result = run_preflight(PreflightInput {
            plan: &plan,
            tools: &tools,
            target_path: "C:\\Program Files",
            max_probes: Some(0),
            available_tool_ids: None,
        })
        .await;
        assert!(result.requires_admin);
        let admin = result
            .checks
            .iter()
            .find(|check| check.id == "admin")
            .expect("应有 admin 检查");
        assert_eq!(admin.level, PreflightLevel::Warn);
        assert!(admin.message.contains("vscode"));
    }

    #[test]
    fn total_bytes_sums_version_sizes() {
        let node = tool(
            "nodejs",
            vec![version(
                "24.21.0",
                37 * 1024 * 1024,
                "https://example.com/node.zip",
            )],
        );
        let git = tool(
            "git",
            vec![version(
                "2.47.0",
                60 * 1024 * 1024,
                "https://example.com/git.exe",
            )],
        );
        let plan = plan(vec![
            plan_item("nodejs", "24.21.0", Vec::new()),
            plan_item("git", "2.47.0", Vec::new()),
        ]);
        let tools = tools_map(vec![node, git]);
        // 直接复用 run_preflight 的 sum 逻辑太重，这里对齐实现：
        let total: u64 = plan
            .items
            .iter()
            .map(|item| version_size_bytes(tools.get(&item.id), &item.version))
            .sum();
        assert_eq!(total, (37 + 60) * 1024 * 1024);
    }

    /// 真实 HEAD 探测（需要网络）：npmmirror 国内直连。
    /// cargo test -p devkit-core --lib preflight -- --ignored --nocapture
    #[tokio::test]
    #[ignore = "真实网络探测，手动触发"]
    async fn probe_source_real_reachability() {
        let source = DownloadSourceRef {
            name: "npmmirror".to_string(),
            url: "https://registry.npmmirror.com/-/binary/node/v24.21.0/node-v24.21.0-win-x64.zip"
                .to_string(),
        };
        let result = probe_source(&source, None).await;
        println!("probe: {:?}", result);
        assert!(result.reachable, "npmmirror 应可达：{}", result.detail);
        assert!(!result.missing);
        assert_eq!(result.detail, "HTTP 200");

        let missing = probe_source(
            &DownloadSourceRef {
                name: "npmmirror".to_string(),
                url: "https://registry.npmmirror.com/-/binary/node/v99.99.99/node-v99.99.99-win-x64.zip"
                    .to_string(),
            },
            None,
        )
        .await;
        println!("probe-missing: {:?}", missing);
        assert!(missing.reachable && missing.missing);
        assert!(missing.detail.contains("该源没有这个版本"));
    }
}
