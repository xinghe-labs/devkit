//! 磁盘信息（对应 TS `preflight` 里的 `statfs` 用法）。

use windows::core::PCWSTR;
use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;

/// 目标盘剩余空间（字节）。
///
/// 对应 TS `statfs(root)` 的 `bavail * bsize` —— 「非特权用户可用」的余量，
/// 不是整个盘的剩余（`GetDiskFreeSpaceExW` 的 lpFreeToCaller 参数）。
/// root 形如 `D:\`，UNC 根 `\\server\share\` 也可以。
pub fn disk_free_bytes(root: &str) -> Result<u64, String> {
    let wide: Vec<u16> = root.encode_utf16().chain(std::iter::once(0)).collect();
    let mut free_to_caller = 0u64;
    let mut total = 0u64;
    let mut free_total = 0u64;
    let result = unsafe {
        GetDiskFreeSpaceExW(
            PCWSTR(wide.as_ptr()),
            Some(&mut free_to_caller),
            Some(&mut total),
            Some(&mut free_total),
        )
    };
    result.map_err(|error| format!("GetDiskFreeSpaceExW({root}) 失败：{error}"))?;
    Ok(free_to_caller)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 真机直读：系统盘 C:\ 必然存在。
    #[test]
    fn system_drive_reports_free_space() {
        let free = disk_free_bytes("C:\\").expect("C:\\ 不该读失败");
        assert!(free > 0, "C:\\ 剩余空间不该是 0");
    }

    #[test]
    fn invalid_drive_reports_error() {
        let error = disk_free_bytes("Q:\\").unwrap_err();
        assert!(error.contains("GetDiskFreeSpaceExW"), "{error}");
    }
}
