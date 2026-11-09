//! ZIP 解压（对应 TS `core/installer/zip.ts`）。
//!
//! 安全关键：ZIP 是攻击面。恶意压缩包可以用 `../` 或绝对路径把文件写到目标目录之外
//! （zip slip）。这里不依赖任何库的默认行为，自己算并校验最终路径 —— 见 resolve_entry_path。
//! 符号链接条目也一律拒绝：Windows 上解出符号链接没有正当用途，只会带来意外。

use std::path::{Component, Path, PathBuf};

use tokio_util::sync::CancellationToken;

#[derive(Debug, thiserror::Error)]
pub enum ZipExtractError {
    /// zip slip / 符号链接 / 找不到目标文件 —— 一律按"恶意或坏包"处理
    #[error("{0}")]
    Slip(String),
    #[error("解压已取消")]
    Cancelled,
    #[error("解压失败：{0}")]
    Io(#[from] std::io::Error),
    #[error("解压失败：{0}")]
    Zip(#[from] zip::result::ZipError),
}

pub struct ExtractOptions {
    pub zip_file: PathBuf,
    pub dest_dir: PathBuf,
    /// 去掉压缩包顶部的目录层数（Node 的 zip 有一层 node-v24.21.0-win-x64/）
    pub strip_components: usize,
    pub on_progress: Option<Box<dyn Fn(u64, u64) + Send + Sync>>,
    pub cancel: Option<CancellationToken>,
}

impl ExtractOptions {
    pub fn new(zip_file: impl Into<PathBuf>, dest_dir: impl Into<PathBuf>) -> Self {
        Self {
            zip_file: zip_file.into(),
            dest_dir: dest_dir.into(),
            strip_components: 0,
            on_progress: None,
            cancel: None,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ExtractResult {
    pub files: u64,
    pub bytes: u64,
}

/// 计算某个压缩包条目应该落到哪个绝对路径。
/// 返回 None 表示该条目应被跳过（是目录项，或被 strip_components 削没了）。
///
/// 校验规则（任一不满足即返回 Slip 错误）：
///  1. 不允许出现 `..` 段
///  2. 不允许绝对路径（`/x`、`\x`）或盘符（`C:`）
///  3. 拼出的最终路径必须仍在 dest_dir 之内
pub fn resolve_entry_path(
    dest_dir: &Path,
    entry_name: &str,
    strip_components: usize,
) -> Result<Option<PathBuf>, ZipExtractError> {
    if entry_name.contains('\0') {
        return Err(ZipExtractError::Slip(format!(
            "条目名包含空字节：{entry_name:?}"
        )));
    }

    let normalized = entry_name.replace('\\', "/");
    if normalized.starts_with('/') {
        return Err(ZipExtractError::Slip(format!(
            "条目使用了绝对路径：{entry_name}"
        )));
    }

    let parts: Vec<&str> = normalized
        .split('/')
        .filter(|part| !part.is_empty() && *part != ".")
        .collect();

    if parts.contains(&"..") {
        return Err(ZipExtractError::Slip(format!(
            "条目试图跳出目标目录（含 ..）：{entry_name}"
        )));
    }
    if let Some(first) = parts.first() {
        let bytes = first.as_bytes();
        if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
            return Err(ZipExtractError::Slip(format!("条目包含盘符：{entry_name}")));
        }
    }
    // NTFS 备用数据流：`a.exe:hidden` 会写到目标目录内的一个数据流上。
    // 虽然逃不出目标目录，但它在磁盘上"看不见"，没有任何正当用途，一律拒绝（安全审查 L1）。
    if normalized.contains(':') {
        return Err(ZipExtractError::Slip(format!(
            "条目名包含冒号（可能是 NTFS 数据流）：{entry_name}"
        )));
    }

    let stripped: Vec<&str> = parts.iter().skip(strip_components).copied().collect();
    if stripped.is_empty() {
        return Ok(None);
    }

    let mut resolved = dest_dir.to_path_buf();
    for part in &stripped {
        resolved.push(part);
    }

    // 最终防线：拼出来的路径必须仍在目标目录之内（Component 级别校验，
    // 不依赖字符串前缀 —— Windows 的 `C:\a` 与 `C:\ab` 前缀问题就在这里）
    let inside = resolved.strip_prefix(dest_dir).map_err(|_| {
        ZipExtractError::Slip(format!(
            "条目落点超出目标目录：{entry_name} → {}",
            resolved.display()
        ))
    })?;
    if inside.as_os_str().is_empty()
        || !inside
            .components()
            .all(|c| matches!(c, Component::Normal(_)))
    {
        return Err(ZipExtractError::Slip(format!(
            "条目落点超出目标目录：{entry_name} → {}",
            resolved.display()
        )));
    }

    Ok(Some(resolved))
}

/// 判断是否为符号链接条目（unix mode 位于 externalFileAttributes 高 16 位）
pub fn is_symlink_entry(external_file_attributes: u32) -> bool {
    let mode = (external_file_attributes >> 16) & 0o170000;
    mode == 0o120000
}

pub async fn extract_zip(options: ExtractOptions) -> Result<ExtractResult, ZipExtractError> {
    tokio::task::spawn_blocking(move || extract_zip_sync(options))
        .await
        .map_err(|error| ZipExtractError::Slip(format!("解压任务失败：{error}")))?
}

fn extract_zip_sync(options: ExtractOptions) -> Result<ExtractResult, ZipExtractError> {
    let file = std::fs::File::open(&options.zip_file)?;
    let mut archive = zip::ZipArchive::new(file)?;
    let mut result = ExtractResult::default();

    for index in 0..archive.len() {
        if let Some(cancel) = &options.cancel {
            if cancel.is_cancelled() {
                return Err(ZipExtractError::Cancelled);
            }
        }

        let mut entry = archive.by_index(index)?;
        let name = entry.name().to_string();

        // zip crate 的 unix_mode() = externalFileAttributes 高 16 位，与 TS 的判定等价
        let unix_mode = entry.unix_mode().unwrap_or(0);
        if is_symlink_entry(unix_mode << 16) {
            return Err(ZipExtractError::Slip(format!(
                "压缩包内含符号链接条目，已拒绝解压：{name}"
            )));
        }

        let target = resolve_entry_path(&options.dest_dir, &name, options.strip_components)?;
        let Some(target) = target else { continue };

        if entry.is_dir() {
            std::fs::create_dir_all(&target)?;
            continue;
        }

        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut out = std::fs::File::create(&target)?;
        let copied = std::io::copy(&mut entry, &mut out)?;
        result.files += 1;
        result.bytes += copied;
        if let Some(on_progress) = &options.on_progress {
            on_progress(result.files, entry.size());
        }
    }

    Ok(result)
}

pub struct ExtractSingleFileOptions {
    pub zip_file: PathBuf,
    pub dest_dir: PathBuf,
    /// 要从压缩包里取出的文件名（按 basename 匹配，取层级最浅的那个）
    pub file_name: String,
    /// 放到 dest_dir 下的哪个子目录；None 表示直接放 dest_dir 根
    pub sub_dir: Option<String>,
    /// 落盘时改成的文件名；不填则沿用压缩包里的名字
    pub as_name: Option<String>,
    pub cancel: Option<CancellationToken>,
}

/// 从压缩包里只取一个文件放到版本目录（pnpm / ninja 这类单文件发行版）。
///
/// 做法：先整体解到 dest_dir 下的临时暂存目录（仍然走同一套 zip-slip 校验），
/// 找到目标文件后复制到最终位置，再删掉暂存目录 —— 这样不会把压缩包里的
/// 其它杂物（license、文档、多余二进制）留在版本目录里。
pub async fn extract_zip_single_file(
    options: ExtractSingleFileOptions,
) -> Result<(PathBuf, u64), ZipExtractError> {
    let staging = options.dest_dir.join(".devkit-staging");
    let _ = tokio::fs::remove_dir_all(&staging).await;

    let outcome = extract_single_file_inner(&options, &staging).await;
    let _ = tokio::fs::remove_dir_all(&staging).await;
    outcome
}

async fn extract_single_file_inner(
    options: &ExtractSingleFileOptions,
    staging: &Path,
) -> Result<(PathBuf, u64), ZipExtractError> {
    let extract = extract_zip(ExtractOptions {
        zip_file: options.zip_file.clone(),
        dest_dir: staging.to_path_buf(),
        strip_components: 0,
        on_progress: None,
        cancel: options.cancel.clone(),
    })
    .await?;
    let _ = extract;

    let target_name = options.file_name.to_lowercase();
    let mut matches: Vec<PathBuf> = Vec::new();
    collect_matches(staging, &target_name, &mut matches).await?;

    if matches.is_empty() {
        return Err(ZipExtractError::Slip(format!(
            "压缩包里找不到 {}",
            options.file_name
        )));
    }

    // 取层级最浅的那个，避免拿到嵌套的同名文件
    matches.sort_by_key(|path| path.components().count());
    let source = matches[0].clone();

    let final_dir = match &options.sub_dir {
        Some(sub_dir) => options.dest_dir.join(sub_dir),
        None => options.dest_dir.clone(),
    };
    tokio::fs::create_dir_all(&final_dir).await?;
    let final_name = options
        .as_name
        .clone()
        .unwrap_or_else(|| options.file_name.clone());
    let final_path = final_dir.join(final_name);
    tokio::fs::copy(&source, &final_path).await?;

    let bytes = tokio::fs::metadata(&final_path).await?.len();
    Ok((final_path, bytes))
}

async fn collect_matches(
    current: &Path,
    target_lower: &str,
    matches: &mut Vec<PathBuf>,
) -> Result<(), ZipExtractError> {
    let mut entries = tokio::fs::read_dir(current).await?;
    while let Some(entry) = entries.next_entry().await? {
        let path = entry.path();
        let file_type = entry.file_type().await?;
        if file_type.is_dir() {
            Box::pin(collect_matches(&path, target_lower, matches)).await?;
        } else if entry.file_name().to_string_lossy().to_lowercase() == target_lower {
            matches.push(path);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn dest() -> PathBuf {
        PathBuf::from(r"C:\u\.devkit\versions\node\24.1.0")
    }

    #[test]
    fn resolves_normal_entry() {
        let resolved = resolve_entry_path(&dest(), "node-v24.1.0-win-x64/node.exe", 1)
            .unwrap()
            .unwrap();
        assert_eq!(resolved, dest().join("node.exe"));
    }

    #[test]
    fn rejects_parent_traversal() {
        let error = resolve_entry_path(&dest(), "../evil.exe", 0).unwrap_err();
        assert!(matches!(error, ZipExtractError::Slip(_)));
        // 中间段带 .. 也不行
        assert!(resolve_entry_path(&dest(), "a/../../evil.exe", 0).is_err());
    }

    #[test]
    fn rejects_absolute_and_drive_paths() {
        assert!(resolve_entry_path(&dest(), "/etc/passwd", 0).is_err());
        assert!(resolve_entry_path(&dest(), r"\windows\system32\x.dll", 0).is_err());
        assert!(resolve_entry_path(&dest(), "C:/windows/x.dll", 0).is_err());
        assert!(resolve_entry_path(&dest(), "c:x.dll", 0).is_err());
    }

    #[test]
    fn rejects_ntfs_stream_and_nul() {
        assert!(resolve_entry_path(&dest(), "a.exe:hidden", 0).is_err());
        assert!(resolve_entry_path(&dest(), "a\0b", 0).is_err());
    }

    #[test]
    fn strips_components_and_skips_empty() {
        assert_eq!(
            resolve_entry_path(&dest(), "top/", 1).unwrap(),
            None,
            "顶层目录被削掉后应跳过"
        );
        assert_eq!(
            resolve_entry_path(&dest(), "./x", 0).unwrap(),
            Some(dest().join("x"))
        );
    }

    #[test]
    fn symlink_detection() {
        // 0o120777 << 16
        assert!(is_symlink_entry(0o120777u32 << 16));
        // 0o100644 << 16（普通文件）
        assert!(!is_symlink_entry(0o100644u32 << 16));
        // 0 = 没有 unix 属性（Windows 打的包）
        assert!(!is_symlink_entry(0));
    }

    fn write_zip(path: &Path, entries: &[(&str, &[u8])]) {
        let file = std::fs::File::create(path).unwrap();
        let mut writer = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        for (name, body) in entries {
            writer.start_file(*name, options).unwrap();
            writer.write_all(body).unwrap();
        }
        writer.finish().unwrap();
    }

    #[tokio::test]
    async fn extracts_files_with_strip() {
        let dir = std::env::temp_dir().join(format!("devkit-zip-{}", std::process::id()));
        let _ = tokio::fs::remove_dir_all(&dir).await;
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let zip_path = dir.join("pkg.zip");
        write_zip(
            &zip_path,
            &[("pkg/bin/node.exe", b"binary"), ("pkg/README.txt", b"docs")],
        );

        let dest = dir.join("out");
        let result = extract_zip(ExtractOptions {
            strip_components: 1,
            ..ExtractOptions::new(&zip_path, &dest)
        })
        .await
        .unwrap();
        assert_eq!(result.files, 2);
        assert_eq!(
            tokio::fs::read(dest.join("bin/node.exe")).await.unwrap(),
            b"binary"
        );
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    #[tokio::test]
    async fn single_file_picks_shallowest_match() {
        let dir = std::env::temp_dir().join(format!("devkit-zip-single-{}", std::process::id()));
        let _ = tokio::fs::remove_dir_all(&dir).await;
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let zip_path = dir.join("pnpm.zip");
        write_zip(
            &zip_path,
            &[
                ("pnpm.exe", b"top-level"),
                ("nested/deep/pnpm.exe", b"nested"),
                ("license.txt", b"text"),
            ],
        );

        let dest = dir.join("out");
        tokio::fs::create_dir_all(&dest).await.unwrap();
        let (file, bytes) = extract_zip_single_file(ExtractSingleFileOptions {
            zip_file: zip_path.clone(),
            dest_dir: dest.clone(),
            file_name: "pnpm.exe".to_string(),
            sub_dir: Some("bin".to_string()),
            as_name: None,
            cancel: None,
        })
        .await
        .unwrap();
        assert_eq!(file, dest.join("bin").join("pnpm.exe"));
        assert_eq!(bytes, "top-level".len() as u64);
        assert_eq!(tokio::fs::read(&file).await.unwrap(), b"top-level");
        assert!(!dest.join("license.txt").exists(), "临时暂存目录应被清理");
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }
}
