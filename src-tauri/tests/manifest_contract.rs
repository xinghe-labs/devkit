//! 契约测试（MIGRATION-RUST.md §8）：Rust serde 侧吃下真实清单。
//!
//! 这是比 fixture 更硬的验收：随包发布的 25 份清单是 TS/Ajv 校验过的既有事实，
//! 如果 Rust 校验器拒绝其中任何一份，就说明 serde 镜像或手写约束与 Ajv 有偏差。
//!
//! fixture（`fixtures/*.json`）覆盖"TS 接受 / Rust 拒绝必须一致"的边界样本，
//! TS 侧由 vitest 读同一批文件（`src/main/core/manifest/contract.test.ts`）。

use devkit_manifest::{load_manifests, validate_manifest_files, ManifestFileInput};
use devkit_types::plan::InstallPlan;

const REPO_ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/..");

/// 随包清单根目录：`resources/manifest/`
fn builtin_manifest_dir() -> std::path::PathBuf {
    std::path::PathBuf::from(REPO_ROOT).join("resources/manifest")
}

#[test]
fn all_builtin_manifests_pass_rust_validator() {
    let dir = builtin_manifest_dir();
    assert!(
        dir.join("tools").exists(),
        "找不到随包清单目录：{}",
        dir.display()
    );

    let result = load_manifests(&dir, None, true);
    assert!(
        result.errors.is_empty(),
        "随包清单必须全部通过 Rust 校验，实际错误：{:?}",
        result.errors
    );
    assert!(
        result.tools.len() >= 25,
        "随包清单应有 25 份，实际加载 {} 份",
        result.tools.len()
    );
    assert_eq!(result.source, devkit_types::ManifestSource::Builtin);
}

#[test]
fn schema_file_still_shipped_alongside_manifests() {
    // Rust 校验器不读 schema（serde 承担结构校验），
    // 但 schema 与清单一起随包发布（TS 侧热更新要用同一套校验器）
    assert!(builtin_manifest_dir()
        .join("schema/tool.schema.json")
        .exists());
}

#[test]
fn fixtures_rejected_by_rust() {
    // 边界样本：TS/Ajv 拒绝的清单，Rust 也必须拒绝
    let fixtures_dir =
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/contract/fixtures");
    let mut checked = 0;

    for entry in std::fs::read_dir(&fixtures_dir).expect("fixtures 目录必须存在") {
        let entry = entry.expect("read_dir entry");
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.ends_with(".json") {
            continue;
        }
        // 约定：文件名以 accept- 开头的样本必须通过，reject- 开头的必须被拒绝
        let content = std::fs::read_to_string(entry.path()).expect("read fixture");
        let data: serde_json::Value =
            serde_json::from_str(&content).expect("fixture 必须是合法 JSON");

        let result = validate_manifest_files(&[ManifestFileInput {
            file: name.clone(),
            data,
        }]);
        if name.starts_with("accept-") {
            assert!(
                result.errors.is_empty() && result.tools.len() == 1,
                "fixture {name} 应被 Rust 接受，实际：{:?}",
                result.errors
            );
        } else if name.starts_with("reject-") {
            assert!(
                !result.errors.is_empty(),
                "fixture {name} 应被 Rust 拒绝（与 Ajv 一致）"
            );
        }
        checked += 1;
    }

    assert!(checked >= 8, "契约 fixture 应至少 8 份，实际 {checked} 份");
}

/* ------------------------------------------------------------------ */
/* pending.json 双向写兼容（§8）：TS 写的 Rust 能读，Rust 写的 TS 能读    */
/* ------------------------------------------------------------------ */

/// 递归删除 null 键：Rust 回写时 `Option::None` 不落盘，
/// 对齐附录 B 的约定「TS null 归一化为缺失后比对」。
fn strip_nulls(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Object(map) => {
            map.retain(|_, v| !v.is_null());
            for (_, v) in map.iter_mut() {
                strip_nulls(v);
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                strip_nulls(item);
            }
        }
        _ => {}
    }
}

#[test]
fn pending_plan_ts_written_rust_reads_and_roundtrips() {
    let fixture = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/contract/fixtures/pending-plan.json");
    let original: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&fixture).expect("读 pending fixture"))
            .expect("fixture 必须是合法 JSON");

    // 1. TS 写出的 pending.json 必须能被 Rust 读入
    let plan: InstallPlan = serde_json::from_value(original.clone())
        .expect("TS 写出的 pending.json 必须被 Rust serde 读入");
    assert_eq!(plan.plan_id, "plan-8f3c1d2e");
    assert_eq!(plan.items.len(), 2);

    // 2. Rust 回写后与原始 JSON 语义一致（null 归一化为缺失后逐字段比对）
    let rewritten = serde_json::to_value(&plan).expect("回写");
    let mut expected = original.clone();
    strip_nulls(&mut expected);
    assert_eq!(rewritten, expected, "Rust 回写必须与 TS 形态一致");

    // 3. 回写结果落盘，供 TS 侧 vitest 读入（双向兼容的第二半边）
    let generated = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/contract/fixtures/generated-pending-plan.json");
    std::fs::write(
        &generated,
        serde_json::to_string_pretty(&rewritten).expect("序列化") + "\n",
    )
    .expect("写 generated fixture");
}
