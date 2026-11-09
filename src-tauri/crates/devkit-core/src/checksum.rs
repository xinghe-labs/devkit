//! SHA-256 流式校验（对应 TS `core/downloader/checksum.ts`）。
//!
//! 不把整个文件读进内存：安装包可能上百 MB。

use std::io::Read;
use std::path::Path;

use sha2::{Digest, Sha256};

/// 流式计算文件的 SHA-256（小写十六进制）。
pub fn sha256_file(path: &Path) -> std::io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = vec![0u8; 256 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
    }
    Ok(hex::encode(hash.finalize()))
}

/// 便于日志里比对：只显示前 12 位。
pub fn short_hash(hash: Option<&str>) -> String {
    match hash {
        Some(value) if value.len() >= 12 => format!("{}…", &value[..12]),
        Some(value) => value.to_string(),
        None => "—".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_matches_known_vector() {
        // echo -n devkit | sha256sum
        const EXPECTED: &str = "e92c90628a9bf3484bf499ad448c7df5cebdd833cbcf827be48f9d6cc8800b61";
        let dir = std::env::temp_dir().join(format!("devkit-sha-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("建临时目录");
        let file = dir.join("payload.bin");
        std::fs::write(&file, b"devkit").expect("写文件");
        assert_eq!(sha256_file(&file).expect("算哈希"), EXPECTED);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn short_hash_truncates() {
        assert_eq!(short_hash(Some("0123456789abcdef")), "0123456789ab…");
        assert_eq!(short_hash(None), "—");
    }
}
