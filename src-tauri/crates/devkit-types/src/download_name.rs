//! 下载产物缓存文件名（镜像 `src/shared/download-name.ts` —— 全项目唯一实现）。
//!
//! ## 为什么单独抽出来
//!
//! 这份知识曾经有两份实现，而且不一致：
//!
//! - `executor` 会补 `.exe`：VS Code 的下载地址以 `/stable` 结尾，取出来没有扩展名，
//!   而 Windows 主要按扩展名决定怎么执行
//! - `offline` 的 `archiveFileName()` **不补**
//!
//! 后果是确定的：离线包里那个文件叫 `vscode-1.141.0-stable`，
//! 而执行器去下载缓存里找 `vscode-1.141.0-stable.exe` —— **离线安装 VS Code 必然失败**。
//!
//! 所以两边都必须调这里，单测直接覆盖 VS Code 那个 URL 形态。

/// 取 URL 路径部分的最后一段（等价 `node:path.basename(new URL(url).pathname)`）。
pub fn url_basename(url: &str) -> Result<String, String> {
    // 手写 URL 路径解析：协议后先剥掉 host[:port]，再取 pathname 末段。
    // TS 侧用 new URL(url).pathname（不含 host），这里对齐同一语义。
    let after_scheme = match (url.find("://"), url.find(':')) {
        (Some(idx), _) => &url[idx + 3..],
        // TS 的 URL 构造器要求协议；没有协议按非法 URL 处理
        _ => return Err(format!("下载地址不是合法的 URL，无法推导缓存文件名：{url}")),
    };

    // host 段：第一个 '/' 之前（authority 终点）；没有 '/' 则 pathname 为空
    let path_start = after_scheme.find('/').unwrap_or(after_scheme.len());
    let pathname = &after_scheme[path_start..];

    let path_end = pathname.find(['?', '#']).unwrap_or(pathname.len());
    let path = &pathname[..path_end];

    let segments: Vec<&str> = path
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect();
    match segments.last() {
        Some(last) => Ok((*last).to_string()),
        None => Ok(String::new()),
    }
}

#[derive(Debug, Clone, Default)]
pub struct DownloadNameInput<'a> {
    pub tool_id: &'a str,
    pub version: &'a str,
    pub url: &'a str,
    /// 安装模板的 `type`（如 `zip` / `exe-inno` / `msi`）。
    ///
    /// zip 类不补扩展名：解压靠内容识别，不靠后缀。
    /// 其余（安装器类）在 URL 末段没有扩展名时补 `.exe`。
    pub install_type: Option<&'a str>,
}

/// 下载缓存的文件名：`<toolId>-<version>-<url 末段>[.exe]`。
///
/// 离线包**制作**与离线包**导入后的执行**都必须走这个函数，
/// 否则打包时写的名字和执行时找的名字就会不一致。
pub fn download_file_name(input: &DownloadNameInput<'_>) -> Result<String, String> {
    let base = url_basename(input.url)?;
    if base.is_empty() {
        return Err(format!("下载地址里取不到文件名：{}", input.url));
    }

    // 已经带扩展名（node-v24.21.0-win-x64.zip）就不动；
    // 没有扩展名且不是 zip 类（VS Code 的 /stable）才补 .exe
    let has_extension = base.contains('.');
    let name = if has_extension || input.install_type == Some("zip") {
        base
    } else {
        format!("{base}.exe")
    };

    Ok(format!("{}-{}-{}", input.tool_id, input.version, name))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_basename_takes_last_segment() {
        assert_eq!(
            url_basename("https://nodejs.org/dist/v24.21.0/node-v24.21.0-win-x64.zip").unwrap(),
            "node-v24.21.0-win-x64.zip"
        );
        assert_eq!(
            url_basename("https://example.com/a/b/file.exe?query=1#frag").unwrap(),
            "file.exe"
        );
        assert_eq!(url_basename("https://example.com/").unwrap(), "");
        assert!(url_basename("not a url").is_err());
    }

    #[test]
    fn download_name_matches_ts_semantics() {
        // zip 类不补扩展名
        let zip = DownloadNameInput {
            tool_id: "nodejs",
            version: "24.21.0",
            url: "https://nodejs.org/dist/v24.21.0/node-v24.21.0-win-x64.zip",
            install_type: Some("zip"),
        };
        assert_eq!(
            download_file_name(&zip).unwrap(),
            "nodejs-24.21.0-node-v24.21.0-win-x64.zip"
        );

        // VS Code 的 /stable 形态：没有扩展名 → 补 .exe
        let vscode = DownloadNameInput {
            tool_id: "vscode",
            version: "1.141.0",
            url: "https://update.code.visualstudio.com/1.141.0/win32-x64/stable",
            install_type: Some("exe-inno"),
        };
        assert_eq!(
            download_file_name(&vscode).unwrap(),
            "vscode-1.141.0-stable.exe"
        );
    }
}
