//! Junction（目录联接）管理（镜像 `src/main/core/activate/index.ts` 的链接部分）。
//!
//! 安全关键：**只删除确认是 junction 的路径**。如果那个位置是真实目录（用户手工
//! 建过、或上次写坏了），一律拒绝 —— 递归删掉它会把用户的数据一起带走。
//!
//! 文案冻结：拒绝覆盖非链接目录的错误文案是测试锁定的契约（MIGRATION-RUST.md 附录 F），
//! 逐字保留自 `activate/index.ts`。
//!
//! junction crate 封装 FSCTL_SET_REPARSE_POINT，不需要管理员权限（这点与符号链接不同）。

use std::io;
use std::path::Path;

use junction as junction_crate;

/// 创建结果（对齐 TS createJunctionAt 返回值）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JunctionOutcome {
    Created,
    Replaced,
    Unchanged,
}

impl JunctionOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            JunctionOutcome::Created => "created",
            JunctionOutcome::Replaced => "replaced",
            JunctionOutcome::Unchanged => "unchanged",
        }
    }
}

pub fn read_link_target(link: &Path) -> Option<String> {
    junction_crate::get_target(link)
        .ok()
        .map(|target| target.to_string_lossy().into_owned())
}

pub fn is_junction(link: &Path) -> bool {
    junction_crate::exists(link).unwrap_or(false)
}

/// 只删链接本身，绝不动目标目录。
///
/// 踩过的坑：对 junction 直接删会报 "Path is a directory" ——
/// junction 在文件系统层面是个**目录**（带重解析点），只有
/// `RemoveDirectoryW`（`fs::remove_dir`）能把它拿掉。
pub fn unlink_junction(link: &Path) {
    if let Err(error) = std::fs::remove_dir(link) {
        // remove_dir_all 对重解析点不会下钻进目标（std 会先检查 reparse point），
        // 兜底语义与 TS rmSync(recursive) 一致
        log::warn!(target: "activate", "remove_dir 失败，改用 remove_dir_all 兜底：{error}");
        let _ = std::fs::remove_dir_all(link);
    }
}

/// 在指定位置创建 junction；返回 created / replaced / unchanged。
///
/// 链接位置已存在但**不是链接**（真实目录）时直接报错，绝不递归删掉它。
pub fn create_junction_at(link: &Path, target: &Path) -> Result<JunctionOutcome, String> {
    if link.exists() {
        if !is_junction(link) {
            // 文案冻结（activate:apply 的拒覆盖文案，MIGRATION-RUST.md 附录 F）
            return Err(format!(
                "拒绝替换 {}：它不是一个链接（可能是你手工创建的目录）。请先自行处理该目录。",
                link.display()
            ));
        }

        let current = read_link_target(link);
        let same = current
            .as_deref()
            .is_some_and(|current| current.eq_ignore_ascii_case(&target.to_string_lossy()));
        if same {
            return Ok(JunctionOutcome::Unchanged);
        }

        unlink_junction(link);
        make_junction(link, target)?;
        return Ok(JunctionOutcome::Replaced);
    }

    make_junction(link, target)?;
    Ok(JunctionOutcome::Created)
}

fn make_junction(link: &Path, target: &Path) -> Result<(), String> {
    junction_crate::create(target, link)
        .map_err(|error: io::Error| format!("创建链接失败：{}", error))
}

/// 确保 current 根目录存在，然后创建/替换 junction。
pub fn ensure_junction(root: &Path, link: &Path, target: &Path) -> Result<JunctionOutcome, String> {
    std::fs::create_dir_all(root)
        .map_err(|error| format!("创建目录 {} 失败：{}", root.display(), error))?;
    create_junction_at(link, target)
}

/// 删除 junction（只删链接本身）；不是链接或不存在就返回 false，绝不动真实目录。
pub fn remove_junction_at(link: &Path) -> bool {
    if !link.exists() {
        return false;
    }
    if !is_junction(link) {
        return false;
    }
    unlink_junction(link);
    true
}

/// 删除 junction；删不掉且位置还在时给一条告警（对齐 TS removeJunction）。
pub fn remove_junction(link: &Path) -> bool {
    let removed = remove_junction_at(link);
    if !removed && link.exists() {
        log::warn!(target: "activate", "跳过删除 {}：它不是链接", link.display());
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_root(name: &str) -> std::path::PathBuf {
        let root =
            std::env::temp_dir().join(format!("devkit-junction-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }

    /// junction 创建不需要管理员权限，这些用例在 Windows 开发机上真跑（对应 junction.test.ts）。
    #[test]
    fn create_then_read_through_link() {
        let root = temp_root("create");
        let link = root.join("link");
        let target = root.join("target");
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("marker.txt"), "target-data").unwrap();

        assert_eq!(
            create_junction_at(&link, &target).unwrap(),
            JunctionOutcome::Created
        );
        assert_eq!(
            fs::read_to_string(link.join("marker.txt")).unwrap(),
            "target-data"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn recreate_same_target_is_unchanged() {
        let root = temp_root("idem");
        let link = root.join("link");
        let target = root.join("target");
        fs::create_dir_all(&target).unwrap();

        create_junction_at(&link, &target).unwrap();
        assert_eq!(
            create_junction_at(&link, &target).unwrap(),
            JunctionOutcome::Unchanged
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn switch_target_replaces_link_and_keeps_old_target() {
        // 「切换目标时替换链接」——这就是"切版本"
        let root = temp_root("switch");
        let link = root.join("link");
        let target = root.join("target");
        let other = root.join("target2");
        fs::create_dir_all(&target).unwrap();
        fs::create_dir_all(&other).unwrap();
        fs::write(target.join("marker.txt"), "target-data").unwrap();
        fs::write(other.join("marker.txt"), "v2").unwrap();

        create_junction_at(&link, &target).unwrap();
        assert_eq!(
            create_junction_at(&link, &other).unwrap(),
            JunctionOutcome::Replaced
        );
        assert_eq!(fs::read_to_string(link.join("marker.txt")).unwrap(), "v2");
        // 原目标必须完好
        assert_eq!(
            fs::read_to_string(target.join("marker.txt")).unwrap(),
            "target-data"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn removing_junction_never_touches_target() {
        // 回归：对 junction 用错删除方式会报 "Path is a directory"
        let root = temp_root("remove");
        let link = root.join("link");
        let target = root.join("target");
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("marker.txt"), "target-data").unwrap();

        create_junction_at(&link, &target).unwrap();
        assert!(remove_junction_at(&link));
        assert!(!link.exists());
        assert_eq!(
            fs::read_to_string(target.join("marker.txt")).unwrap(),
            "target-data"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn refuse_to_touch_real_directory() {
        // 误把真实目录当链接删/换 = 把用户数据带走，所以两层都要拒绝
        let root = temp_root("real");
        let real = root.join("real");
        let target = root.join("target");
        fs::create_dir_all(&real).unwrap();
        fs::create_dir_all(&target).unwrap();
        fs::write(real.join("important.txt"), "do-not-delete").unwrap();

        assert!(!remove_junction_at(&real));
        assert!(real.join("important.txt").exists());

        let error = create_junction_at(&real, &target).unwrap_err();
        assert!(error.contains("不是一个链接"), "{error}");
        // 文案冻结：逐字对照 TS
        assert_eq!(
            error,
            format!(
                "拒绝替换 {}：它不是一个链接（可能是你手工创建的目录）。请先自行处理该目录。",
                real.display()
            )
        );
        assert_eq!(
            fs::read_to_string(real.join("important.txt")).unwrap(),
            "do-not-delete"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn missing_path_is_safe_noop() {
        let root = temp_root("noop");
        assert!(!remove_junction_at(&root.join("nope")));
        unlink_junction(&root.join("nope")); // 不抛错
        let _ = fs::remove_dir_all(&root);
    }
}
