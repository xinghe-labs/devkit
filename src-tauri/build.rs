fn main() {
    // 捕获 rustc 版本，供 AppInfo.nodeVersion 如实展示（附录 F.4）
    let rustc = std::process::Command::new("rustc")
        .arg("--version")
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_else(|| "rustc (unknown)".into());
    println!("cargo:rustc-env=DEVKIT_RUSTC_VERSION={rustc}");
    tauri_build::build();
}
