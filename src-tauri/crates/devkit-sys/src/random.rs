//! 密码学安全随机数（提权作业 id 与 nonce 用）。
//!
//! 用 BCryptGenRandom（Windows CNG），不引入额外 crate。

use windows::Win32::Security::Cryptography::{BCryptGenRandom, BCRYPT_USE_SYSTEM_PREFERRED_RNG};

/// 生成 `len` 字节的 CSPRNG 随机数。失败才返回 Err（系统级 RNG 不可用是极罕见
/// 但必须如实上报的故障）。
pub fn random_bytes(len: usize) -> Result<Vec<u8>, String> {
    let mut buffer = vec![0u8; len];
    // SAFETY：buffer 有效且长度匹配；系统首选 RNG 无需算法句柄
    let status =
        unsafe { BCryptGenRandom(None, buffer.as_mut_slice(), BCRYPT_USE_SYSTEM_PREFERRED_RNG) };
    status
        .ok()
        .map_err(|error| format!("BCryptGenRandom 失败：{error}"))?;
    Ok(buffer)
}

/// 随机 hex 字符串（nonce 用）
pub fn random_hex(bytes: usize) -> Result<String, String> {
    Ok(random_bytes(bytes)?
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn random_hex_is_random_and_sized() {
        let a = random_hex(32).expect("系统 RNG 应可用");
        let b = random_hex(32).expect("系统 RNG 应可用");
        assert_eq!(a.len(), 64);
        assert_ne!(a, b, "两次 32 字节随机输出不应相同");
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    }
}
