//! Copies secrets to the system clipboard and clears them later, but only if the clipboard still
//! holds that secret (by SHA-256), so whatever the user copied since is kept. On Windows, copied
//! secrets are kept out of clipboard history (Win+V) and cloud clipboard sync.

use sha2::{Digest, Sha256};

pub const SUPPORTED: bool = cfg!(any(target_os = "macos", windows));

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Lowercase hex SHA-256, as the page computes it over UTF-8.
pub fn hash(text: &[u8]) -> String {
    hex(&Sha256::digest(text))
}

pub fn matches(text: &[u8], hash_hex: &str) -> bool {
    hash(text) == hash_hex
}

/// Puts a secret on the clipboard. False if the system clipboard couldn't be used.
#[cfg(any(target_os = "macos", windows))]
pub fn copy(text: &str) -> bool {
    let Ok(mut cb) = arboard::Clipboard::new() else { return false };
    #[cfg(windows)]
    {
        use arboard::SetExtWindows;
        cb.set().exclude_from_history().exclude_from_cloud().exclude_from_monitoring().text(text).is_ok()
    }
    #[cfg(not(windows))]
    {
        cb.set_text(text).is_ok()
    }
}

#[cfg(any(target_os = "macos", windows))]
pub fn clear_if(hash_hex: &str) {
    let Ok(mut cb) = arboard::Clipboard::new() else { return };
    let Ok(current) = cb.get_text() else { return };
    let current = zeroize::Zeroizing::new(current);
    if matches(current.as_bytes(), hash_hex) {
        let _ = cb.clear();
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
pub fn copy(_text: &str) -> bool {
    false
}

#[cfg(not(any(target_os = "macos", windows)))]
pub fn clear_if(_hash: &str) {}

#[cfg(test)]
mod tests {
    #[test]
    fn hash_matches_sha256_hex() {
        assert!(super::matches(b"abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"));
        assert!(!super::matches(b"abd", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"));
    }
}
