//! 镜像源配置（FR-5，镜像 `src/main/core/config/mirrors.ts`）。
//!
//! 刻意不走 `npm config set` / `pip config set` / `go env -w`：
//! 这些命令要求对应工具**已经装好且在 PATH 上**，而 devkit 的典型场景恰恰是
//! 「什么都还没装」。直接写配置文件 / 环境变量是幂等的，失败可定位。
//!
//! 所有写操作都：先备份（`*.devkit-backup`，只在第一次备份时写）、
//! 只动自己那一块（标记块可幂等替换与移除）、保留文件里其它内容。

use crate::logging;
use devkit_types::settings::{is_valid_mirror_url, MirrorApplyResult, MirrorSetting, MirrorTarget};
use serde::Serialize;
use std::fs;
use std::path::PathBuf;

pub const BEGIN_MARK: &str = "# devkit-begin";
pub const END_MARK: &str = "# devkit-end";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentMirrors {
    pub npm: Option<String>,
    pub pip: Option<String>,
    pub go: Option<String>,
    pub maven: Option<String>,
    pub gradle: Option<String>,
    pub cargo: Option<String>,
    pub conda: Option<String>,
    pub nuget: Option<String>,
    pub docker: Option<String>,
}

fn home_dir() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn app_data() -> PathBuf {
    std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir().join("AppData").join("Roaming"))
}

pub fn npmrc_path() -> PathBuf {
    home_dir().join(".npmrc")
}

pub fn pip_ini_path() -> PathBuf {
    app_data().join("pip").join("pip.ini")
}

pub fn maven_settings_path() -> PathBuf {
    home_dir().join(".m2").join("settings.xml")
}

pub fn gradle_init_path() -> PathBuf {
    home_dir().join(".gradle").join("init.gradle")
}

pub fn cargo_config_path() -> PathBuf {
    home_dir().join(".cargo").join("config.toml")
}

pub fn condarc_path() -> PathBuf {
    home_dir().join(".condarc")
}

pub fn nuget_config_path() -> PathBuf {
    app_data().join("NuGet").join("NuGet.Config")
}

pub fn docker_daemon_path() -> PathBuf {
    home_dir().join(".docker").join("daemon.json")
}

/* ------------------------------------------------------------------ */
/* 通用文本工具（纯函数，单测覆盖）                                      */
/* ------------------------------------------------------------------ */

fn escape_regex(key: &str) -> String {
    regex::escape(key)
}

/// 把 "registry=..." 这一行替换掉；没有就追加。其它行原样保留。
pub fn upsert_ini_value(content: &str, key: &str, value: &str) -> String {
    let pattern =
        regex::Regex::new(&format!(r"(?i)^\s*{}\s*=", escape_regex(key))).expect("ini key regex");
    let mut replaced = false;
    let mut next: Vec<String> = content
        .split('\n')
        .map(|line| line.trim_end_matches('\r').to_string())
        .map(|line| {
            if !replaced && pattern.is_match(&line) {
                replaced = true;
                format!("{key}={value}")
            } else {
                line
            }
        })
        .collect();

    if !replaced {
        while next.last().is_some_and(|line| line.trim().is_empty()) {
            next.pop();
        }
        next.push(format!("{key}={value}"));
        next.push(String::new());
    }

    next.join("\n")
}

/// 在 INI 的某个 section 下写入 key；section 不存在就创建
pub fn upsert_ini_section_value(content: &str, section: &str, key: &str, value: &str) -> String {
    let lines: Vec<String> = content
        .split('\n')
        .map(|line| line.trim_end_matches('\r').to_string())
        .collect();
    let header = format!("[{section}]");
    let header_index = lines
        .iter()
        .position(|line| line.trim().eq_ignore_ascii_case(&header));

    let Some(header_index) = header_index else {
        let mut base: Vec<String> = if content.trim().is_empty() {
            Vec::new()
        } else {
            content
                .trim_end()
                .split('\n')
                .map(|line| line.trim_end_matches('\r').to_string())
                .collect()
        };
        base.push(header);
        base.push(format!("{key} = {value}"));
        base.push(String::new());
        return base.join("\n");
    };

    let mut end = lines.len();
    let section_header = regex::Regex::new(r"^\s*\[").unwrap();
    for (i, line) in lines.iter().enumerate().skip(header_index + 1) {
        if section_header.is_match(line) {
            end = i;
            break;
        }
    }

    let key_pattern =
        regex::Regex::new(&format!(r"(?i)^\s*{}\s*=", escape_regex(key))).expect("ini key regex");
    for i in header_index + 1..end {
        if key_pattern.is_match(&lines[i]) {
            let mut next = lines.clone();
            next[i] = format!("{key} = {value}");
            return next.join("\n");
        }
    }

    let mut next = lines;
    next.insert(header_index + 1, format!("{key} = {value}"));
    next.join("\n")
}

/// 用标记块替换/插入内容；block 为 None 表示只移除已有块
pub fn upsert_marked_block(content: &str, block: Option<&str>) -> String {
    let lines: Vec<&str> = content.split('\n').collect();
    let begin_index = lines.iter().position(|line| line.trim() == BEGIN_MARK);
    let end_index = lines.iter().position(|line| line.trim() == END_MARK);

    if let (Some(begin_index), Some(end_index)) = (begin_index, end_index) {
        if end_index > begin_index {
            let replacement: Vec<&str> = match block {
                Some(text) => {
                    let mut parts = vec![BEGIN_MARK];
                    parts.extend(text.split('\n'));
                    parts.push(END_MARK);
                    parts
                }
                None => Vec::new(),
            };
            let mut next: Vec<&str> = Vec::with_capacity(lines.len());
            next.extend_from_slice(&lines[..begin_index]);
            next.extend(replacement);
            next.extend_from_slice(&lines[end_index + 1..]);
            return collapse_blank_lines(&next.join("\n"));
        }
    }

    match block {
        None => content.to_string(),
        Some(text) => {
            let mut base: Vec<String> = if content.trim().is_empty() {
                Vec::new()
            } else {
                content
                    .trim_end()
                    .split('\n')
                    .map(|line| line.trim_end_matches('\r').to_string())
                    .collect()
            };
            base.push(String::new());
            base.push(BEGIN_MARK.to_string());
            base.extend(text.split('\n').map(|line| line.to_string()));
            base.push(END_MARK.to_string());
            base.push(String::new());
            base.join("\n")
        }
    }
}

fn collapse_blank_lines(text: &str) -> String {
    regex::Regex::new(r"\n{3,}")
        .unwrap()
        .replace_all(text, "\n\n")
        .to_string()
}

/// 在 XML 里插入/替换 devkit 的 maven mirror 条目
pub fn upsert_maven_mirror(content: &str, url: Option<&str>) -> Result<String, String> {
    let mirror_id = "devkit-central";
    let entry = format!(
        "    <mirror>\n      <id>{mirror_id}</id>\n      <name>devkit mirror</name>\n      <url>{}</url>\n      <mirrorOf>central</mirrorOf>\n    </mirror>",
        url.unwrap_or("")
    );
    let existing = regex::Regex::new(&format!(
        r"(?i)\s*<mirror>\s*<id>{mirror_id}</id>[\s\S]*?</mirror>\s*"
    ))
    .unwrap();

    if url.is_none() {
        // 移除：如果去掉后 <mirrors> 里空了，就一并收掉那个空标签
        return Ok(
            collapse_blank_lines(existing.replace_all(content, "\n").as_ref()).replace(
                &regex::Regex::new(r"(?i)<mirrors>\s*</mirrors>\s*")
                    .unwrap()
                    .to_string(),
                "",
            ),
        );
    }
    let _url = url.unwrap_or_default();

    if existing.is_match(content) {
        return Ok(existing
            .replace(content, format!("\n{entry}\n").as_str())
            .to_string());
    }
    if regex::Regex::new(r"(?i)<mirrors\s*/>")
        .unwrap()
        .is_match(content)
    {
        return Ok(regex::Regex::new(r"(?i)<mirrors\s*/>")
            .unwrap()
            .replace(
                content,
                format!("<mirrors>\n{entry}\n  </mirrors>").as_str(),
            )
            .to_string());
    }
    if regex::Regex::new(r"(?i)<mirrors>")
        .unwrap()
        .is_match(content)
    {
        return Ok(regex::Regex::new(r"(?i)<mirrors>")
            .unwrap()
            .replace(content, format!("<mirrors>\n{entry}").as_str())
            .to_string());
    }
    if regex::Regex::new(r"(?i)</settings>")
        .unwrap()
        .is_match(content)
    {
        return Ok(regex::Regex::new(r"(?i)</settings>")
            .unwrap()
            .replace(
                content,
                format!("  <mirrors>\n{entry}\n  </mirrors>\n</settings>").as_str(),
            )
            .to_string());
    }

    Err(format!(
        "{} 里既没有 <mirrors> 也没有 </settings>，无法安全插入镜像配置。请手工添加或先备份删除该文件。",
        maven_settings_path().display()
    ))
}

/// 生成 conda 的 .condarc 内容。
///
/// 为什么只写自己那一块并且**发现用户已定义 channels 就拒绝**：
/// YAML 里同名顶层键重复是无效的，硬追加会直接把用户的 .condarc 写坏。
pub fn conda_block(base_url: &str) -> String {
    let trimmed = base_url.trim_end_matches('/');
    format!(
        "# 由 devkit 写入（镜像源配置，FR-5）。删掉 devkit-begin/devkit-end 之间的内容即可还原。\nchannels:\n  - defaults\ndefault_channels:\n  - {trimmed}/pkgs/main\n  - {trimmed}/pkgs/r\n  - {trimmed}/pkgs/msys2\nshow_channel_urls: true"
    )
}

/// 用户已有 .condarc 时，检查里面是否已经定义了我们会写的顶层键
pub fn condarc_has_conflicts(content: &str) -> bool {
    // 先把自己写的那一块摘掉，再看剩下部分有没有同名顶层键 —— 否则第二次应用会被自己拦住
    let begin = content.find(BEGIN_MARK);
    let end = content.find(END_MARK);
    let user_part = match (begin, end) {
        (Some(b), Some(e)) if e > b => {
            format!("{}{}", &content[..b], &content[e + END_MARK.len()..])
        }
        _ => content.to_string(),
    };
    regex::Regex::new(r"(?m)^\s*(channels|default_channels)\s*:")
        .unwrap()
        .is_match(&user_part)
}

/// 在 NuGet.Config 里插入/移除 devkit 的包源
pub fn upsert_nuget_source(content: &str, url: Option<&str>) -> Result<String, String> {
    let key = "devkit";
    let entry = format!(
        r#"    <add key="{key}" value="{}" protocolVersion="3" />"#,
        url.unwrap_or("")
    );
    let existing = regex::Regex::new(&format!(r#"(?i)\s*<add\s+key="{key}"[^>]*/>\s*"#)).unwrap();

    if url.is_none() {
        let removed = existing.replace_all(content, "\n").to_string();
        let cleaned = regex::Regex::new(r"(?i)<packageSources>\s*</packageSources>\s*")
            .unwrap()
            .replace_all(&removed, "");
        return Ok(collapse_blank_lines(&cleaned));
    }
    let _url = url.unwrap_or_default();

    if existing.is_match(content) {
        return Ok(existing
            .replace(content, format!("\n{entry}\n").as_str())
            .to_string());
    }
    if regex::Regex::new(r"(?i)<packageSources\s*/>")
        .unwrap()
        .is_match(content)
    {
        return Ok(regex::Regex::new(r"(?i)<packageSources\s*/>")
            .unwrap()
            .replace(
                content,
                format!("<packageSources>\n{entry}\n  </packageSources>").as_str(),
            )
            .to_string());
    }
    if regex::Regex::new(r"(?i)<packageSources>")
        .unwrap()
        .is_match(content)
    {
        return Ok(regex::Regex::new(r"(?i)<packageSources>")
            .unwrap()
            .replace(content, format!("<packageSources>\n{entry}").as_str())
            .to_string());
    }
    if regex::Regex::new(r"(?i)</configuration>")
        .unwrap()
        .is_match(content)
    {
        return Ok(regex::Regex::new(r"(?i)</configuration>")
            .unwrap()
            .replace(
                content,
                format!("  <packageSources>\n{entry}\n  </packageSources>\n</configuration>")
                    .as_str(),
            )
            .to_string());
    }

    Err(format!(
        "{} 里既没有 <packageSources> 也没有 </configuration>，无法安全插入包源。请手工添加或先备份删除该文件。",
        nuget_config_path().display()
    ))
}

pub fn minimal_nuget_config(url: &str) -> String {
    format!(
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<configuration>\n  <packageSources>\n    <add key=\"devkit\" value=\"{url}\" protocolVersion=\"3\" />\n  </packageSources>\n</configuration>\n"
    )
}

pub fn minimal_maven_settings(url: &str) -> String {
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<settings xmlns=\"http://maven.apache.org/SETTINGS/1.0.0\">\n  <mirrors>\n    <mirror>\n      <id>devkit-central</id>\n      <name>devkit mirror</name>\n      <url>{url}</url>\n      <mirrorOf>central</mirrorOf>\n    </mirror>\n  </mirrors>\n</settings>\n"
    )
}

/// 在 Docker daemon.json 里设置/移除 registry-mirrors，保留其它键
pub fn upsert_docker_registry_mirrors(content: &str, url: Option<&str>) -> Result<String, String> {
    let mut parsed: serde_json::Map<String, serde_json::Value> = if content.trim().is_empty() {
        serde_json::Map::new()
    } else {
        match serde_json::from_str(content) {
            Ok(value) => value,
            Err(error) => {
                return Err(format!(
                    "{} 不是合法 JSON，已拒绝修改：{error}",
                    docker_daemon_path().display()
                ))
            }
        }
    };

    match url {
        None => {
            parsed.remove("registry-mirrors");
        }
        Some(url) => {
            parsed.insert(
                "registry-mirrors".to_string(),
                serde_json::Value::Array(vec![serde_json::Value::String(url.to_string())]),
            );
        }
    }

    let mut out = serde_json::to_string_pretty(&serde_json::Value::Object(parsed))
        .map_err(|error| error.to_string())?;
    out.push('\n');
    Ok(out)
}

/* ------------------------------------------------------------------ */
/* 读写                                                                */
/* ------------------------------------------------------------------ */

fn read_if_exists(file: &PathBuf) -> String {
    fs::read_to_string(file).unwrap_or_default()
}

fn backup_once(file: &PathBuf) -> Option<String> {
    if !file.exists() {
        return None;
    }
    let backup = PathBuf::from(format!("{}.devkit-backup", file.display()));
    if backup.exists() {
        return Some(backup.display().to_string());
    }
    match fs::read_to_string(file).and_then(|content| fs::write(&backup, content)) {
        Ok(()) => Some(backup.display().to_string()),
        Err(_) => None,
    }
}

fn write_file_ensured(file: &PathBuf, content: &str) -> Result<(), String> {
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建目录失败：{error}"))?;
    }
    fs::write(file, content).map_err(|error| format!("写文件失败：{error}"))
}

/// 写用户环境变量（GOPROXY 这类）；value 为 None 表示删除。
/// 直接走 devkit-sys 的注册表读写（与 activate 同一套），不用 setx（1024 字符截断）。
fn write_user_env_var(name: &str, value: Option<&str>) -> Result<(), String> {
    devkit_sys::user_env::write_user_env(name, value)
}

/// 读用户级 GOPROXY（没有则返回 None）
fn read_go_proxy() -> Option<String> {
    devkit_sys::user_env::read_user_env("GOPROXY")
        .ok()
        .flatten()
}

pub fn read_current_mirrors() -> CurrentMirrors {
    let npm_content = read_if_exists(&npmrc_path());
    let npm = regex::Regex::new(r"(?im)^\s*registry\s*=\s*(.+)$")
        .unwrap()
        .captures(&npm_content)
        .map(|caps| caps[1].trim().to_string());

    let pip_content = read_if_exists(&pip_ini_path());
    let pip = regex::Regex::new(r"(?im)^\s*index-url\s*=\s*(.+)$")
        .unwrap()
        .captures(&pip_content)
        .map(|caps| caps[1].trim().to_string());

    let maven_content = read_if_exists(&maven_settings_path());
    let maven = regex::Regex::new(r"(?i)<id>devkit-central</id>[\s\S]*?<url>(.*?)</url>")
        .unwrap()
        .captures(&maven_content)
        .map(|caps| caps[1].trim().to_string());

    let gradle_content = read_if_exists(&gradle_init_path());
    let gradle = regex::Regex::new(
        r#"(?i)devkit-begin[\s\S]*?url\s*[=:]?\s*['"]?([^'"
]+)['"]?[\s\S]*?devkit-end"#,
    )
    .unwrap()
    .captures(&gradle_content)
    .map(|caps| caps[1].trim().to_string());

    let cargo_content = read_if_exists(&cargo_config_path());
    let cargo = regex::Regex::new(
        r##"(?i)devkit-begin[\s\S]*?registry\s*=\s*"([^"]+)"[\s\S]*?devkit-end"##,
    )
    .unwrap()
    .captures(&cargo_content)
    .map(|caps| caps[1].trim().to_string());

    let conda_content = read_if_exists(&condarc_path());
    let conda = regex::Regex::new(
        r"(?i)devkit-begin[\s\S]*?default_channels:\s*\r?\n\s*-\s*(.+?)/pkgs/main[\s\S]*?devkit-end",
    )
    .unwrap()
    .captures(&conda_content)
    .map(|caps| caps[1].trim().to_string());

    let nuget_content = read_if_exists(&nuget_config_path());
    let nuget = regex::Regex::new(r#"(?i)<add\s+key="devkit"\s+value="([^"]+)""#)
        .unwrap()
        .captures(&nuget_content)
        .map(|caps| caps[1].trim().to_string());

    let docker_content = read_if_exists(&docker_daemon_path());
    let docker = if docker_content.trim().is_empty() {
        None
    } else {
        serde_json::from_str::<serde_json::Value>(&docker_content)
            .ok()
            .and_then(|parsed| {
                parsed
                    .get("registry-mirrors")
                    .and_then(|value| value.as_array())
                    .and_then(|array| array.first())
                    .and_then(|first| first.as_str())
                    .map(|value| value.to_string())
            })
    };

    CurrentMirrors {
        npm,
        pip,
        go: read_go_proxy(),
        maven,
        gradle,
        cargo,
        conda,
        nuget,
        docker,
    }
}

fn gradle_block(url: &str) -> String {
    format!(
        "// 由 devkit 写入（镜像源配置，FR-5）。删掉 devkit-begin/devkit-end 之间的内容即可还原。\nallprojects {{\n  buildscript {{\n    repositories {{\n      maven {{\n        url '{url}'\n      }}\n    }}\n  }}\n  repositories {{\n    maven {{\n      url '{url}'\n    }}\n  }}\n}}"
    )
}

fn cargo_block(url: &str) -> String {
    format!(
        "# 由 devkit 写入（镜像源配置，FR-5）。删掉 devkit-begin/devkit-end 之间的内容即可还原。\n[source.crates-io]\nreplace-with = 'devkit-mirror'\n\n[source.devkit-mirror]\nregistry = \"{url}\""
    )
}

fn find_setting(
    settings: &[MirrorSetting],
    target: MirrorTarget,
) -> Result<Option<&MirrorSetting>, String> {
    let found = settings.iter().find(|item| item.target == target);
    // 只在真的要写入时校验；enabled=false 是"移除"，不需要合法地址
    if let Some(setting) = found {
        if setting.enabled && !setting.url.is_empty() && !is_valid_mirror_url(&setting.url) {
            return Err(format!(
                "镜像地址不合法：{:.80}。只允许 https 与 URL 安全字符集",
                setting.url
            ));
        }
    }
    Ok(found)
}

/// 应用镜像设置。enabled=false 的目标会被移除对应配置（回到官方源）。
/// 只改自己写进去的那一块，绝不整文件覆盖。
pub fn apply_mirrors(settings: &[MirrorSetting]) -> MirrorApplyResult {
    let mut changed: Vec<String> = Vec::new();
    let mut backup_files: Vec<String> = Vec::new();

    let outcome = (|| -> Result<(), String> {
        // npm
        if let Some(npm) = find_setting(settings, MirrorTarget::Npm)? {
            let file = npmrc_path();
            if let Some(backup) = backup_once(&file) {
                backup_files.push(backup);
            }
            let content = read_if_exists(&file);
            if npm.enabled && !npm.url.is_empty() {
                write_file_ensured(&file, &upsert_ini_value(&content, "registry", &npm.url))?;
                changed.push(format!("npm registry → {}", npm.url));
            } else if regex::Regex::new(r"(?im)^\s*registry\s*=")
                .unwrap()
                .is_match(&content)
            {
                let cleaned = regex::Regex::new(r"(?im)^\s*registry\s*=.*\r?\n?")
                    .unwrap()
                    .replace_all(&content, "")
                    .to_string();
                write_file_ensured(&file, &cleaned)?;
                changed.push("npm registry → 官方源（已移除自定义 registry）".to_string());
            }
        }

        // pip
        if let Some(pip) = find_setting(settings, MirrorTarget::Pip)? {
            let file = pip_ini_path();
            if let Some(backup) = backup_once(&file) {
                backup_files.push(backup);
            }
            let content = read_if_exists(&file);
            if pip.enabled && !pip.url.is_empty() {
                write_file_ensured(
                    &file,
                    &upsert_ini_section_value(&content, "global", "index-url", &pip.url),
                )?;
                changed.push(format!("pip index-url → {}", pip.url));
            } else if regex::Regex::new(r"(?im)^\s*index-url\s*=")
                .unwrap()
                .is_match(&content)
            {
                let cleaned = regex::Regex::new(r"(?im)^\s*index-url\s*=.*\r?\n?")
                    .unwrap()
                    .replace_all(&content, "")
                    .to_string();
                write_file_ensured(&file, &cleaned)?;
                changed.push("pip index-url → 官方源（已移除自定义 index-url）".to_string());
            }
        }

        // go
        if let Some(go) = find_setting(settings, MirrorTarget::Go)? {
            if go.enabled && !go.url.is_empty() {
                write_user_env_var("GOPROXY", Some(&go.url))?;
                changed.push(format!("GOPROXY → {}", go.url));
            } else {
                write_user_env_var("GOPROXY", None)?;
                changed.push("GOPROXY → 已移除（使用官方默认）".to_string());
            }
        }

        // maven
        if let Some(maven) = find_setting(settings, MirrorTarget::Maven)? {
            let file = maven_settings_path();
            if let Some(backup) = backup_once(&file) {
                backup_files.push(backup);
            }
            let content = read_if_exists(&file);
            if maven.enabled && !maven.url.is_empty() {
                let next = if content.trim().is_empty() {
                    minimal_maven_settings(&maven.url)
                } else {
                    upsert_maven_mirror(&content, Some(&maven.url))?
                };
                write_file_ensured(&file, &next)?;
                changed.push(format!("Maven mirror → {}", maven.url));
            } else if !content.is_empty() {
                write_file_ensured(&file, &upsert_maven_mirror(&content, None)?)?;
                changed.push("Maven mirror → 官方源（已移除 devkit 的 mirror 条目）".to_string());
            }
        }

        // gradle
        if let Some(gradle) = find_setting(settings, MirrorTarget::Gradle)? {
            let file = gradle_init_path();
            if let Some(backup) = backup_once(&file) {
                backup_files.push(backup);
            }
            let content = read_if_exists(&file);
            let block = if gradle.enabled && !gradle.url.is_empty() {
                Some(gradle_block(&gradle.url))
            } else {
                None
            };
            let next = upsert_marked_block(&content, block.as_deref());
            if next.trim() != content.trim() {
                write_file_ensured(&file, &next)?;
                changed.push(if block.is_some() {
                    format!("Gradle init.gradle → {}", gradle.url)
                } else {
                    "Gradle init.gradle → 已移除 devkit 的镜像块".to_string()
                });
            }
        }

        // cargo
        if let Some(cargo) = find_setting(settings, MirrorTarget::Cargo)? {
            let file = cargo_config_path();
            if let Some(backup) = backup_once(&file) {
                backup_files.push(backup);
            }
            let content = read_if_exists(&file);
            let block = if cargo.enabled && !cargo.url.is_empty() {
                Some(cargo_block(&cargo.url))
            } else {
                None
            };
            let next = upsert_marked_block(&content, block.as_deref());
            if next.trim() != content.trim() {
                write_file_ensured(&file, &next)?;
                changed.push(if block.is_some() {
                    format!("cargo config.toml → {}", cargo.url)
                } else {
                    "cargo config.toml → 已移除 devkit 的镜像块".to_string()
                });
            }
        }

        // conda
        if let Some(conda) = find_setting(settings, MirrorTarget::Conda)? {
            let file = condarc_path();
            if let Some(backup) = backup_once(&file) {
                backup_files.push(backup);
            }
            let content = read_if_exists(&file);
            if conda.enabled && !conda.url.is_empty() {
                if !content.trim().is_empty() && condarc_has_conflicts(&content) {
                    return Err(format!(
                        "{} 里已经定义了 channels / default_channels。YAML 不允许同名顶层键重复，\
                         为避免写坏你的配置，devkit 没有自动修改。请手工把镜像地址合并进去，\
                         或先备份删除该文件后重试。",
                        file.display()
                    ));
                }
                write_file_ensured(
                    &file,
                    &upsert_marked_block(&content, Some(&conda_block(&conda.url))),
                )?;
                changed.push(format!("conda .condarc → {}", conda.url));
            } else if !content.trim().is_empty() {
                write_file_ensured(&file, &upsert_marked_block(&content, None))?;
                changed.push("conda .condarc → 已移除 devkit 的镜像块".to_string());
            }
        }

        // nuget
        if let Some(nuget) = find_setting(settings, MirrorTarget::Nuget)? {
            let file = nuget_config_path();
            if let Some(backup) = backup_once(&file) {
                backup_files.push(backup);
            }
            let content = read_if_exists(&file);
            if nuget.enabled && !nuget.url.is_empty() {
                let next = if content.trim().is_empty() {
                    minimal_nuget_config(&nuget.url)
                } else {
                    upsert_nuget_source(&content, Some(&nuget.url))?
                };
                write_file_ensured(&file, &next)?;
                changed.push(format!("NuGet 包源 → {}", nuget.url));
            } else if !content.trim().is_empty() {
                write_file_ensured(&file, &upsert_nuget_source(&content, None)?)?;
                changed.push("NuGet 包源 → 已移除 devkit 的源".to_string());
            }
        }

        // docker
        if let Some(docker) = find_setting(settings, MirrorTarget::Docker)? {
            let file = docker_daemon_path();
            if let Some(backup) = backup_once(&file) {
                backup_files.push(backup);
            }
            let content = read_if_exists(&file);
            if docker.enabled && !docker.url.is_empty() {
                write_file_ensured(
                    &file,
                    &upsert_docker_registry_mirrors(&content, Some(&docker.url))?,
                )?;
                changed.push(format!(
                    "Docker registry-mirrors → {}（需要重启 Docker Desktop）",
                    docker.url
                ));
            } else if !content.trim().is_empty() {
                write_file_ensured(&file, &upsert_docker_registry_mirrors(&content, None)?)?;
                changed.push("Docker registry-mirrors → 已移除".to_string());
            }
        }

        Ok(())
    })();

    match outcome {
        Ok(()) => {
            logging::global().info(
                "mirrors",
                &format!(
                    "镜像配置已应用：{}",
                    if changed.is_empty() {
                        "无变化".to_string()
                    } else {
                        changed.join("；")
                    }
                ),
            );
            MirrorApplyResult {
                ok: true,
                changed,
                backup_files,
                error: None,
            }
        }
        Err(error) => {
            logging::global().error("mirrors", &format!("应用镜像配置失败：{error}"));
            MirrorApplyResult {
                ok: false,
                changed,
                backup_files,
                error: Some(error),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upsert_ini_value_replaces_and_appends() {
        // 替换已有行，其它行保留
        assert_eq!(
            upsert_ini_value("a=1\nregistry=https://old\nb=2", "registry", "https://new"),
            "a=1\nregistry=https://new\nb=2"
        );
        // 大小写不敏感
        assert_eq!(
            upsert_ini_value("REGISTRY=https://old", "registry", "https://new"),
            "registry=https://new"
        );
        // 没有就追加（去掉尾部空行后追加）
        assert_eq!(
            upsert_ini_value("a=1\n\n", "registry", "https://new"),
            "a=1\nregistry=https://new\n"
        );
    }

    #[test]
    fn upsert_ini_section_creates_and_updates() {
        // 文件为空 → 创建 section
        assert_eq!(
            upsert_ini_section_value("", "global", "index-url", "https://pypi/mirror"),
            "[global]\nindex-url = https://pypi/mirror\n"
        );
        // 已有 section → 插入到 section 头后
        let existing = "[install]\nfoo=bar\n\n[global]\nother=1\n";
        let next = upsert_ini_section_value(existing, "global", "index-url", "https://u");
        assert!(next.contains("[global]\nindex-url = https://u\nother=1"));
        // 已有 key → 原位替换
        let existing = "[global]\nindex-url = https://old\nother=1\n";
        assert_eq!(
            upsert_ini_section_value(existing, "global", "index-url", "https://new"),
            "[global]\nindex-url = https://new\nother=1\n"
        );
    }

    #[test]
    fn marked_block_upsert_and_remove() {
        let block = "line1\nline2";
        // 空文件 → 追加块
        let with_block = upsert_marked_block("", Some(block));
        assert!(with_block.contains("# devkit-begin\nline1\nline2\n# devkit-end"));

        // 已有块 → 原位替换（不留旧内容）
        let replaced = upsert_marked_block(&with_block, Some("line3"));
        assert!(replaced.contains("line3"));
        assert!(!replaced.contains("line1"));

        // 移除块
        let removed = upsert_marked_block(&with_block, None);
        assert!(!removed.contains("devkit-begin"));
        assert!(!removed.contains("line1"));

        // 移除不存在的块 = 原文不动
        assert_eq!(upsert_marked_block("keep me", None), "keep me");
    }

    #[test]
    fn maven_mirror_insert_replace_remove() {
        // 空标签自闭合 → 展开插入
        let self_closing = "<settings>\n  <mirrors/>\n</settings>";
        let inserted = upsert_maven_mirror(self_closing, Some("https://maven/u")).unwrap();
        assert!(inserted.contains("<id>devkit-central</id>"));
        assert!(inserted.contains("<mirrorOf>central</mirrorOf>"));

        // 已有条目 → 原位替换
        let replaced = upsert_maven_mirror(&inserted, Some("https://maven/v2")).unwrap();
        assert!(replaced.contains("https://maven/v2"));
        assert!(!replaced.contains("https://maven/u"));

        // 没有 mirrors 也没有 </settings> → 报错
        assert!(upsert_maven_mirror("random content", Some("https://u")).is_err());

        // 移除：条目没了；mirrors 空了标签也收掉
        let removed = upsert_maven_mirror(&inserted, None).unwrap();
        assert!(!removed.contains("devkit-central"));
    }

    #[test]
    fn conda_conflict_detection_ignores_own_block() {
        let block = conda_block("https://mirrors.tuna");
        assert!(block.contains("/pkgs/main"));
        assert!(block.contains("/pkgs/msys2"));

        // 自己写的块不算冲突
        let own = upsert_marked_block("", Some(&block));
        assert!(!condarc_has_conflicts(&own));

        // 用户已有 channels → 冲突
        assert!(condarc_has_conflicts("channels:\n  - conda-forge\n"));
        // 有自己的块 + 用户另有 channels → 冲突
        let mixed = format!("{own}\nchannels:\n  - x\n");
        assert!(condarc_has_conflicts(&mixed));
    }

    #[test]
    fn nuget_source_and_docker_json() {
        let empty_config = minimal_nuget_config("https://nuget/u");
        assert!(empty_config.contains(r#"<add key="devkit" value="https://nuget/u""#));

        // 已有 configuration 标签 → 插入 packageSources
        let existing = "<?xml?>\n<configuration>\n</configuration>";
        let inserted = upsert_nuget_source(existing, Some("https://nuget/u")).unwrap();
        assert!(inserted.contains("packageSources"));

        let replaced = upsert_nuget_source(&inserted, Some("https://nuget/v2")).unwrap();
        assert!(replaced.contains("https://nuget/v2"));

        // docker：保留其它键
        let docker =
            upsert_docker_registry_mirrors(r#"{"debug": true}"#, Some("https://docker/u")).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&docker).unwrap();
        assert_eq!(parsed["debug"], true);
        assert_eq!(parsed["registry-mirrors"][0], "https://docker/u");
        // 移除
        let removed = upsert_docker_registry_mirrors(&docker, None).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&removed).unwrap();
        assert!(parsed.get("registry-mirrors").is_none());
        // 非法 JSON 拒绝
        assert!(upsert_docker_registry_mirrors("{ not json", Some("https://u")).is_err());
    }

    #[test]
    fn find_setting_validates_url_only_when_enabled() {
        let bad = MirrorSetting {
            target: MirrorTarget::Npm,
            enabled: true,
            url: "javascript:alert(1)".to_string(),
        };
        assert!(find_setting(std::slice::from_ref(&bad), MirrorTarget::Npm).is_err());

        // enabled=false（移除）不校验
        let removing = MirrorSetting {
            enabled: false,
            ..bad
        };
        assert!(find_setting(&[removing], MirrorTarget::Npm).is_ok());
    }

    #[test]
    fn apply_mirrors_rejects_unsafe_url_without_touching_files() {
        let settings = vec![MirrorSetting {
            target: MirrorTarget::Npm,
            enabled: true,
            url: "http://not-https.example".to_string(),
        }];
        let result = apply_mirrors(&settings);
        assert!(!result.ok);
        assert!(result
            .error
            .as_deref()
            .unwrap_or_default()
            .contains("不合法"));
    }
}
