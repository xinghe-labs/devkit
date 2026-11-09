//! 安装参数模板白名单（对应 TS `core/templates/index.ts`）—— 安全关键模块。
//!
//! 清单里的 `install.template` 只能引用这里定义的模板，`install.params` 只能填模板声明过的键，
//! 且值必须匹配模板给出的正则。清单**无权自定义命令行**。
//!
//! 为什么必须这样：清单支持热更新（FR-15），如果清单能自由指定命令与参数，
//! 那么热更新通道就等于任意命令执行通道。参数模板是唯一能触达命令行的入口，
//! 所以它必须写死在代码里、只能被引用、不能被覆盖。
//!
//! 模板分两类：
//!  · extract 类：压缩包直接解压到版本目录，没有命令行
//!  · command 类：跑一个安装器，命令行由这里的 build_command 拼出来（不是清单拼的）

use std::collections::BTreeMap;
use std::sync::LazyLock;

use devkit_types::manifest::{InstallSpec, InstallType};

#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct TemplateError {
    pub message: String,
}

impl TemplateError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct TemplateParamRule {
    /// 值必须匹配此正则
    pub pattern: &'static LazyLock<regex::Regex>,
    pub required: bool,
    pub description: &'static str,
}

#[derive(Debug, Clone)]
pub struct InstallTemplate {
    pub id: &'static str,
    pub install_type: InstallType,
    pub description: &'static str,
    /// (参数名 → 规则)；用 Vec 保持声明顺序，错误信息与 TS 的 Object.keys 顺序一致
    pub params: &'static [(&'static str, TemplateParamRule)],
}

/// 拼命令行时能拿到的上下文；全部由主进程提供，清单无法影响
#[derive(Debug, Clone, Default)]
pub struct CommandContext {
    pub archive_path: String,
    pub install_dir: String,
    /// 安装器日志落盘位置（安装失败时要能翻日志）
    pub log_file: String,
    pub version: String,
    pub tool_id: String,
    /// npm 可执行文件路径（只有 npm 类模板用得上）。
    /// 由 provider 解析：优先 devkit 自己激活/装过的 Node.js，其次 PATH。
    pub npm_cmd: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstallerCommand {
    pub cmd: String,
    pub args: Vec<String>,
    /// 需要管理员权限（安装范围是 machine 时为 true）
    pub requires_admin: bool,
    /// 安装器会把文件放到 install_dir 之外的地方（rustup 这类），自检要按实际位置来
    pub installs_outside_version_dir: bool,
    /// 安装器需要的额外环境变量
    pub env: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExtractPlan {
    Zip {
        strip_components: u32,
    },
    ZipSingleFile {
        file_name: String,
        sub_dir: Option<String>,
        as_name: Option<String>,
    },
    Sfx7z,
}

#[derive(Debug, Clone)]
pub struct ResolvedTemplate {
    pub template: &'static InstallTemplate,
    pub params: BTreeMap<String, String>,
    /// extract 类模板的解析结果
    pub extract: Option<ExtractPlan>,
}

/* ------------------------------------------------------------------ */
/* 参数值正则（与 TS 完全一致）                                          */
/* ------------------------------------------------------------------ */

/// 路径类参数里允许出现的字符（绝对路径 + 盘符 + 反斜杠）
pub static PATH_CHARS: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"^[A-Za-z0-9_\-.:\\/ ]{0,200}$").unwrap());
static FILE_NAME: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._+-]{0,80}$").unwrap());
static SUB_DIR: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"^[A-Za-z0-9._\\-]{1,80}$").unwrap());
static DIR_PROPERTY: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"^[A-Z][A-Za-z0-9_]{0,40}$").unwrap());
/// MSI 属性串：KEY=VALUE(;KEY=VALUE)*，值里不允许出现引号、分号与任何 shell 元字符
static MSI_PROPERTIES: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r#"^[A-Za-z0-9_]{1,40}=[^;"'`|&<>$%^()!]{0,160}(;[A-Za-z0-9_]{1,40}=[^;"'`|&<>$%^()!]{0,160})*$"#)
        .unwrap()
});
/// 追加参数：只允许 -/ 开头的开关与等号取值，禁止 shell 元字符与引号
static EXTRA_ARGS: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r"^-{1,2}[A-Za-z0-9_][A-Za-z0-9_=.,!*-]{0,60}( -{1,2}[A-Za-z0-9_][A-Za-z0-9_=.,!*-]{0,60})*$")
        .unwrap()
});
/// NSIS 的 /D 开关（必须无引号且位于最后）
static NSIS_DIR_SWITCH: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"^/D=$").unwrap());
static STRIP_COMPONENTS: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"^[0-2]$").unwrap());
static BIN_NAME: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$").unwrap());
static FLAG_01: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"^[01]$").unwrap());
static RUSTUP_PROFILE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"^(minimal|default|complete)$").unwrap());
static RUSTUP_HOST: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"^x86_64-pc-windows-(msvc|gnu)$").unwrap());

/* ------------------------------------------------------------------ */
/* 模板表                                                              */
/* ------------------------------------------------------------------ */

static PARAMS_NONE: &[(&str, TemplateParamRule)] = &[];
static PARAMS_STRIP: &[(&str, TemplateParamRule)] = &[(
    "stripComponents",
    TemplateParamRule {
        pattern: &STRIP_COMPONENTS,
        required: false,
        description: "去掉压缩包顶部的目录层数（0~2）。Node 的 zip 有一层顶层目录，填 1",
    },
)];
static PARAMS_SINGLE_FILE: &[(&str, TemplateParamRule)] = &[
    (
        "fileName",
        TemplateParamRule {
            pattern: &FILE_NAME,
            required: true,
            description: "解压后要保留的文件名，例如 pnpm.exe",
        },
    ),
    (
        "subDir",
        TemplateParamRule {
            pattern: &SUB_DIR,
            required: false,
            description: "放到版本目录下的哪个子目录（如 bin）；不填表示直接放版本目录根",
        },
    ),
    (
        "asName",
        TemplateParamRule {
            pattern: &FILE_NAME,
            required: false,
            description: "落盘时改成的文件名。发行物里的名字常常带平台后缀（如 codex-x86_64-pc-windows-msvc.exe），改名的意义是让用户敲的命令就是 codex 而不是一长串",
        },
    ),
];
static PARAMS_MSI: &[(&str, TemplateParamRule)] = &[
    (
        "dirProperty",
        TemplateParamRule {
            pattern: &DIR_PROPERTY,
            required: false,
            description: "指定安装目录的 MSI 属性名，默认 INSTALLDIR",
        },
    ),
    (
        "properties",
        TemplateParamRule {
            pattern: &MSI_PROPERTIES,
            required: false,
            description: "额外的 MSI 属性，KEY=VALUE 形式，多个用 ; 分隔",
        },
    ),
    (
        "extraArgs",
        TemplateParamRule {
            pattern: &EXTRA_ARGS,
            required: false,
            description: "额外的 msiexec 开关（如 -norestart 之外的定制项）",
        },
    ),
];
static PARAMS_NSIS: &[(&str, TemplateParamRule)] = &[
    (
        "silentArgs",
        TemplateParamRule {
            pattern: &EXTRA_ARGS,
            required: false,
            description: "覆盖默认静默参数；不填则使用 /S",
        },
    ),
    (
        "dirSwitch",
        TemplateParamRule {
            pattern: &NSIS_DIR_SWITCH,
            required: false,
            description: "是否追加 /D=<安装目录>；不填表示用安装器默认目录",
        },
    ),
];
static PARAMS_INNO: &[(&str, TemplateParamRule)] = &[(
    "extraArgs",
    TemplateParamRule {
        pattern: &EXTRA_ARGS,
        required: false,
        description: "额外的 Inno 开关，例如 -MERGETASKS=!runcode",
    },
)];
static PARAMS_PYTHON: &[(&str, TemplateParamRule)] = &[
    (
        "includeLauncher",
        TemplateParamRule {
            pattern: &FLAG_01,
            required: false,
            description: "是否安装 py 启动器（1/0），默认 1",
        },
    ),
    (
        "includePip",
        TemplateParamRule {
            pattern: &FLAG_01,
            required: false,
            description: "是否安装 pip（1/0），默认 1",
        },
    ),
    (
        "extraProperties",
        TemplateParamRule {
            pattern: &MSI_PROPERTIES,
            required: false,
            description: "额外的安装器属性，KEY=VALUE 形式",
        },
    ),
];
static PARAMS_NPM: &[(&str, TemplateParamRule)] = &[
    (
        "binName",
        TemplateParamRule {
            pattern: &BIN_NAME,
            required: true,
            description: "包提供的可执行文件名（不带扩展名），例如 claude",
        },
    ),
    (
        "extraArgs",
        TemplateParamRule {
            pattern: &EXTRA_ARGS,
            required: false,
            description: "额外的 npm 开关",
        },
    ),
];
static PARAMS_RUSTUP: &[(&str, TemplateParamRule)] = &[
    (
        "profile",
        TemplateParamRule {
            pattern: &RUSTUP_PROFILE,
            required: false,
            description: "rustup 安装档位，默认 minimal（只装 rustc/cargo/rust-std）",
        },
    ),
    (
        "defaultHost",
        TemplateParamRule {
            pattern: &RUSTUP_HOST,
            required: false,
            description: "默认工具链 host，默认 x86_64-pc-windows-msvc",
        },
    ),
];

pub static INSTALL_TEMPLATES: &[InstallTemplate] = &[
    InstallTemplate {
        id: "zip-into-version-dir",
        install_type: InstallType::Zip,
        description: "把压缩包解压到该工具的版本目录 %USERPROFILE%\\.devkit\\versions\\<tool>\\<version>\\（用户级，不需要管理员）",
        params: PARAMS_STRIP,
    },
    InstallTemplate {
        id: "zip-single-file-into-version-dir",
        install_type: InstallType::Zip,
        description: "压缩包里只有一个可执行文件时使用：把它放到版本目录（可选子目录），其余内容丢弃。pnpm / ninja 这类单文件发行版走这个模板",
        params: PARAMS_SINGLE_FILE,
    },
    InstallTemplate {
        id: "exe-7zsfx-extract",
        install_type: InstallType::Exe7Zsfx,
        description: "7-Zip 自解压包（PortableGit 等）：用 -o<目录> -y 静默解压到版本目录，不写注册表、不需要管理员",
        params: PARAMS_NONE,
    },
    InstallTemplate {
        id: "msi-install",
        install_type: InstallType::Msi,
        description: "msiexec /qn 静默安装 MSI。安装目录通过 INSTALLDIR 类属性指定到版本目录；需要管理员权限",
        params: PARAMS_MSI,
    },
    InstallTemplate {
        id: "exe-nsis-silent",
        install_type: InstallType::ExeNsis,
        description: "NSIS 安装器静默安装：/S 加上可选的 /D=<目录>。注意 /D 必须是最后一个参数且不能带引号（NSIS 的硬性规定），因此只在安装路径不含空格时使用",
        params: PARAMS_NSIS,
    },
    InstallTemplate {
        id: "exe-inno-silent",
        install_type: InstallType::ExeInno,
        description: "Inno Setup 安装器静默安装：/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /DIR=\"<目录>\"，用户级安装不需要管理员",
        params: PARAMS_INNO,
    },
    InstallTemplate {
        id: "exe-python-silent",
        install_type: InstallType::ExeCustom,
        description: "python.org 官方安装器静默安装：/quiet InstallAllUsers=0 TargetDir=<目录>。用户级安装，不改 PATH（PATH 由 devkit 的激活机制统一管）",
        params: PARAMS_PYTHON,
    },
    InstallTemplate {
        id: "npm-global-into-version-dir",
        install_type: InstallType::Npm,
        description: "把 npm 包装进版本目录：npm install --global --prefix <版本目录> <已校验的 tgz>。不污染全局 npm（不用 -g 装到 %APPDATA%\\npm），卸载就是删目录。需要机器上有 Node.js（npm 随它一起提供）",
        params: PARAMS_NPM,
    },
    InstallTemplate {
        id: "exe-rustup-init",
        install_type: InstallType::ExeCustom,
        description: "rustup-init.exe 静默安装：通过 CARGO_HOME / RUSTUP_HOME 把整个工具链放进版本目录，--no-modify-path 保证不改 PATH（由 devkit 激活机制接管）",
        params: PARAMS_RUSTUP,
    },
];

pub fn find_template(id: &str) -> Option<&'static InstallTemplate> {
    INSTALL_TEMPLATES.iter().find(|template| template.id == id)
}

pub fn list_template_ids() -> Vec<&'static str> {
    INSTALL_TEMPLATES
        .iter()
        .map(|template| template.id)
        .collect()
}

/// 校验一份参数对象是否符合模板声明；返回清洗后的参数
fn validate_params(
    template: &InstallTemplate,
    params: &BTreeMap<String, String>,
) -> Result<BTreeMap<String, String>, TemplateError> {
    let mut result = BTreeMap::new();

    for (key, value) in params {
        let rule = template
            .params
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, rule)| rule);
        let Some(rule) = rule else {
            let allowed = template
                .params
                .iter()
                .map(|(name, _)| *name)
                .collect::<Vec<_>>()
                .join(", ");
            let allowed = if allowed.is_empty() {
                "（无）"
            } else {
                &allowed
            };
            return Err(TemplateError::new(format!(
                "安装模板 \"{}\" 不接受参数 \"{}\"。允许的参数：{}",
                template.id, key, allowed
            )));
        };
        if !rule.pattern.is_match(value) {
            return Err(TemplateError::new(format!(
                "安装模板 \"{}\" 的参数 \"{}\" 值不合法：{:?}（要求：{}）",
                template.id, key, value, rule.description
            )));
        }
        result.insert(key.clone(), value.clone());
    }

    for (key, rule) in template.params {
        if rule.required && !result.contains_key(*key) {
            return Err(TemplateError::new(format!(
                "安装模板 \"{}\" 缺少必填参数 \"{}\"（{}）",
                template.id, key, rule.description
            )));
        }
    }

    Ok(result)
}

fn build_extract_plan(
    template_id: &str,
    params: &BTreeMap<String, String>,
) -> Result<ExtractPlan, TemplateError> {
    match template_id {
        "zip-into-version-dir" => {
            let strip = params
                .get("stripComponents")
                .and_then(|value| value.parse::<u32>().ok())
                .unwrap_or(0);
            Ok(ExtractPlan::Zip {
                strip_components: strip,
            })
        }
        "zip-single-file-into-version-dir" => Ok(ExtractPlan::ZipSingleFile {
            file_name: params.get("fileName").cloned().unwrap_or_default(),
            sub_dir: params.get("subDir").cloned(),
            as_name: params.get("asName").cloned(),
        }),
        "exe-7zsfx-extract" => Ok(ExtractPlan::Sfx7z),
        _ => Err(TemplateError::new(format!(
            "模板 {template_id} 不是解压类模板"
        ))),
    }
}

/// 把 "a b c" 形式的追加参数切成数组；正则已保证不含引号与元字符
fn split_args(input: Option<&str>) -> Vec<String> {
    match input {
        Some(value) => value
            .split(' ')
            .filter(|part| !part.is_empty())
            .map(|part| part.to_string())
            .collect(),
        None => Vec::new(),
    }
}

fn param<'a>(params: &'a BTreeMap<String, String>, key: &str) -> Option<&'a str> {
    params.get(key).map(|value| value.as_str())
}

/// command 类模板的命令行构造（对齐 TS 的 buildCommandFactory）
pub fn build_command(
    template_id: &str,
    params: &BTreeMap<String, String>,
    context: &CommandContext,
) -> Result<InstallerCommand, TemplateError> {
    match template_id {
        "msi-install" => {
            let dir_property = param(params, "dirProperty")
                .unwrap_or("INSTALLDIR")
                .to_string();
            let properties: Vec<String> = params
                .get("properties")
                .map(|value| {
                    value
                        .split(';')
                        .filter(|part| !part.is_empty())
                        .map(|part| part.to_string())
                        .collect()
                })
                .unwrap_or_default();
            let mut args = vec![
                "/i".to_string(),
                context.archive_path.clone(),
                "/qn".to_string(),
                "/norestart".to_string(),
                "/l*v".to_string(),
                context.log_file.clone(),
                format!("{dir_property}={}", context.install_dir),
            ];
            args.extend(properties);
            args.extend(split_args(param(params, "extraArgs")));
            Ok(InstallerCommand {
                cmd: "msiexec.exe".to_string(),
                args,
                requires_admin: true,
                installs_outside_version_dir: false,
                env: BTreeMap::new(),
            })
        }

        "exe-nsis-silent" => {
            let silent = split_args(param(params, "silentArgs"));
            let mut args = if silent.is_empty() {
                vec!["/S".to_string()]
            } else {
                silent
            };
            // /D 必须是最后一个参数，且不能加引号。路径含空格时命令行会自动加引号并破坏 NSIS 解析，
            // 所以这里显式拒绝 —— 宁可报错也不要装到错误的位置。
            if let Some(dir_switch) = param(params, "dirSwitch") {
                if context.install_dir.chars().any(|c| c.is_whitespace()) {
                    return Err(TemplateError::new(format!(
                        "NSIS 的 /D 开关不接受含空格的路径，当前安装目录是 {}。请把用户目录改到不含空格的路径，或改用该软件的 ZIP / MSI 发行版。",
                        context.install_dir
                    )));
                }
                args.push(format!("{dir_switch}{}", context.install_dir));
            }
            Ok(InstallerCommand {
                cmd: context.archive_path.clone(),
                args,
                requires_admin: true,
                installs_outside_version_dir: false,
                env: BTreeMap::new(),
            })
        }

        "exe-inno-silent" => {
            let mut args = vec![
                "/VERYSILENT".to_string(),
                "/SUPPRESSMSGBOXES".to_string(),
                "/NORESTART".to_string(),
                "/SP-".to_string(),
                format!("/LOG={}", context.log_file),
                format!("/DIR={}", context.install_dir),
            ];
            args.extend(split_args(param(params, "extraArgs")));
            Ok(InstallerCommand {
                cmd: context.archive_path.clone(),
                args,
                requires_admin: false,
                installs_outside_version_dir: false,
                env: BTreeMap::new(),
            })
        }

        "exe-python-silent" => {
            let include_launcher = param(params, "includeLauncher").unwrap_or("1").to_string();
            let include_pip = param(params, "includePip").unwrap_or("1").to_string();
            let extra: Vec<String> = params
                .get("extraProperties")
                .map(|value| {
                    value
                        .split(';')
                        .filter(|part| !part.is_empty())
                        .map(|part| part.to_string())
                        .collect()
                })
                .unwrap_or_default();
            let mut args = vec![
                "/quiet".to_string(),
                "InstallAllUsers=0".to_string(),
                "PrependPath=0".to_string(),
                "AssociateFiles=0".to_string(),
                "Shortcuts=0".to_string(),
                "Include_test=0".to_string(),
                format!("Include_launcher={include_launcher}"),
                format!("Include_pip={include_pip}"),
                format!("TargetDir={}", context.install_dir),
            ];
            args.extend(extra);
            Ok(InstallerCommand {
                cmd: context.archive_path.clone(),
                args,
                requires_admin: false,
                installs_outside_version_dir: false,
                env: BTreeMap::new(),
            })
        }

        "npm-global-into-version-dir" => {
            let mut args = vec![
                "install".to_string(),
                "--global".to_string(),
                "--prefix".to_string(),
                context.install_dir.clone(),
                "--no-fund".to_string(),
                "--no-audit".to_string(),
                "--loglevel=error".to_string(),
                // 装的是已经校验过 SHA-256 的本地 tgz；但注意 npm 仍会去 registry
                // 解析这个包的依赖与平台二进制（见清单 notes 里的说明）
                context.archive_path.clone(),
            ];
            args.extend(split_args(param(params, "extraArgs")));
            Ok(InstallerCommand {
                // 用 provider 解析出来的 npm：优先 devkit 自己的 Node.js，其次 PATH
                cmd: context.npm_cmd.clone(),
                args,
                requires_admin: false,
                installs_outside_version_dir: false,
                env: BTreeMap::new(),
            })
        }

        "exe-rustup-init" => {
            let mut env = BTreeMap::new();
            // rustup 只认 CARGO_HOME / RUSTUP_HOME，把这两个指到版本目录即可
            env.insert(
                "CARGO_HOME".to_string(),
                format!("{}\\cargo", context.install_dir),
            );
            env.insert(
                "RUSTUP_HOME".to_string(),
                format!("{}\\rustup", context.install_dir),
            );
            Ok(InstallerCommand {
                cmd: context.archive_path.clone(),
                args: vec![
                    "-y".to_string(),
                    "--no-modify-path".to_string(),
                    "--profile".to_string(),
                    param(params, "profile").unwrap_or("minimal").to_string(),
                    "--default-host".to_string(),
                    param(params, "defaultHost")
                        .unwrap_or("x86_64-pc-windows-msvc")
                        .to_string(),
                    "--default-toolchain".to_string(),
                    "stable".to_string(),
                ],
                requires_admin: false,
                installs_outside_version_dir: true,
                env,
            })
        }

        _ => Err(TemplateError::new(format!(
            "模板 {template_id} 不是安装器类模板"
        ))),
    }
}

/// 解析并校验清单给出的安装模板引用。
/// 任何不认识的模板名、类型不匹配、未声明的参数键、不合规的参数值，一律抛错 ——
/// 宁可安装失败，也不执行一条来路不明的命令。
pub fn resolve_install_template(
    spec: Option<&InstallSpec>,
) -> Result<Option<ResolvedTemplate>, TemplateError> {
    let Some(spec) = spec else { return Ok(None) };

    let template = find_template(&spec.template).ok_or_else(|| {
        TemplateError::new(format!(
            "未知的安装模板 \"{}\"。可用模板：{}",
            spec.template,
            list_template_ids().join(", ")
        ))
    })?;

    if template.install_type != spec.install_type {
        return Err(TemplateError::new(format!(
            "安装模板 \"{}\" 的类型是 {:?}，但清单声明的是 {:?}",
            template.id, template.install_type, spec.install_type
        )));
    }

    let params: BTreeMap<String, String> = spec
        .params
        .clone()
        .unwrap_or_default()
        .into_iter()
        .collect();
    let params = validate_params(template, &params)?;

    if matches!(
        template.install_type,
        InstallType::Zip | InstallType::Exe7Zsfx
    ) {
        let extract = build_extract_plan(template.id, &params)?;
        return Ok(Some(ResolvedTemplate {
            template,
            params,
            extract: Some(extract),
        }));
    }

    Ok(Some(ResolvedTemplate {
        template,
        params,
        extract: None,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn spec(template: &str, install_type: InstallType, params: &[(&str, &str)]) -> InstallSpec {
        InstallSpec {
            install_type,
            template: template.to_string(),
            params: Some(
                params
                    .iter()
                    .map(|(key, value)| (key.to_string(), value.to_string()))
                    .collect(),
            ),
        }
    }

    fn params_map(entries: &[(&str, &str)]) -> BTreeMap<String, String> {
        entries
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect()
    }

    #[test]
    fn resolves_valid_reference() {
        let resolved = resolve_install_template(Some(&spec(
            "zip-into-version-dir",
            InstallType::Zip,
            &[("stripComponents", "1")],
        )))
        .unwrap()
        .unwrap();
        assert_eq!(resolved.template.id, "zip-into-version-dir");
        assert_eq!(
            resolved.params.get("stripComponents").map(String::as_str),
            Some("1")
        );
        assert_eq!(
            resolved.extract,
            Some(ExtractPlan::Zip {
                strip_components: 1
            })
        );
    }

    #[test]
    fn none_when_no_spec() {
        assert!(resolve_install_template(None).unwrap().is_none());
    }

    #[test]
    fn rejects_unknown_template() {
        let error =
            resolve_install_template(Some(&spec("run-whatever-i-want", InstallType::Zip, &[])))
                .unwrap_err();
        assert!(error.message.contains("未知的安装模板"));
        assert!(error.message.contains("zip-into-version-dir"));
    }

    #[test]
    fn rejects_type_mismatch() {
        let error =
            resolve_install_template(Some(&spec("zip-into-version-dir", InstallType::Msi, &[])))
                .unwrap_err();
        assert!(error.message.contains("类型"), "{}", error.message);
    }

    #[test]
    fn rejects_undeclared_param_key() {
        let error = resolve_install_template(Some(&spec(
            "zip-into-version-dir",
            InstallType::Zip,
            &[("evilCommand", "calc.exe")],
        )))
        .unwrap_err();
        assert!(
            error.message.contains("不接受参数 \"evilCommand\""),
            "{}",
            error.message
        );
    }

    #[test]
    fn rejects_bad_param_values() {
        for bad in ["3", "-1", "1; rm -rf /", "", "1 && calc"] {
            let error = resolve_install_template(Some(&spec(
                "zip-into-version-dir",
                InstallType::Zip,
                &[("stripComponents", bad)],
            )))
            .unwrap_err();
            assert!(
                error.message.contains("值不合法"),
                "参数值 {bad:?}: {}",
                error.message
            );
        }
    }

    #[test]
    fn allows_omitting_optional_params() {
        let resolved =
            resolve_install_template(Some(&spec("zip-into-version-dir", InstallType::Zip, &[])))
                .unwrap()
                .unwrap();
        assert!(resolved.params.is_empty());
        assert_eq!(
            resolved.extract,
            Some(ExtractPlan::Zip {
                strip_components: 0
            })
        );
    }

    #[test]
    fn template_table_is_well_formed() {
        for template in INSTALL_TEMPLATES {
            assert!(!template.id.is_empty());
            assert!(!template.description.is_empty());
        }
    }

    #[test]
    fn missing_required_param_rejected() {
        let error = resolve_install_template(Some(&spec(
            "zip-single-file-into-version-dir",
            InstallType::Zip,
            &[],
        )))
        .unwrap_err();
        assert!(
            error.message.contains("缺少必填参数 \"fileName\""),
            "{}",
            error.message
        );
    }

    fn context() -> CommandContext {
        CommandContext {
            archive_path: r"C:\dl\python-3.12.exe".to_string(),
            install_dir: r"C:\u\.devkit\versions\python\3.12.0".to_string(),
            log_file: r"C:\u\.devkit\logs\install.log".to_string(),
            version: "3.12.0".to_string(),
            tool_id: "python".to_string(),
            npm_cmd: r"C:\u\.devkit\current\node\npm.cmd".to_string(),
        }
    }

    #[test]
    fn builds_msi_command() {
        let command = build_command(
            "msi-install",
            &params_map(&[("properties", "LAUNCHAPP=1")]),
            &context(),
        )
        .unwrap();
        assert_eq!(command.cmd, "msiexec.exe");
        assert!(command.requires_admin);
        assert_eq!(command.args[0], "/i");
        assert!(command
            .args
            .contains(&"INSTALLDIR=C:\\u\\.devkit\\versions\\python\\3.12.0".to_string()));
        assert!(command.args.contains(&"LAUNCHAPP=1".to_string()));
    }

    #[test]
    fn builds_inno_command() {
        let command = build_command("exe-inno-silent", &params_map(&[]), &context()).unwrap();
        assert!(!command.requires_admin);
        assert!(command.args.contains(&"/VERYSILENT".to_string()));
        assert!(command
            .args
            .contains(&format!("/DIR={}", context().install_dir)));
    }

    #[test]
    fn nsis_rejects_path_with_spaces() {
        let mut ctx = context();
        ctx.install_dir = r"C:\Users\John Doe\.devkit\versions\app\1.0".to_string();
        let error = build_command(
            "exe-nsis-silent",
            &params_map(&[("dirSwitch", "/D=")]),
            &ctx,
        )
        .unwrap_err();
        assert!(
            error.message.contains("不接受含空格的路径"),
            "{}",
            error.message
        );
    }

    #[test]
    fn builds_rustup_command_with_env() {
        let command = build_command("exe-rustup-init", &params_map(&[]), &context()).unwrap();
        assert!(!command.requires_admin);
        assert!(command.installs_outside_version_dir);
        assert_eq!(
            command.env.get("CARGO_HOME").map(String::as_str),
            Some(r"C:\u\.devkit\versions\python\3.12.0\cargo")
        );
        assert!(command.args.contains(&"--no-modify-path".to_string()));
    }

    #[test]
    fn builds_npm_command() {
        let command = build_command(
            "npm-global-into-version-dir",
            &params_map(&[("binName", "claude")]),
            &context(),
        )
        .unwrap();
        assert_eq!(command.cmd, context().npm_cmd);
        assert!(command.args.contains(&"--global".to_string()));
        assert!(command.args.contains(&context().archive_path.clone()));
    }
}
