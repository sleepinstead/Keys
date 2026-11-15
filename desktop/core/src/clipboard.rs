//! Clears the system clipboard, but only if it still holds a given secret (by SHA-256).

use sha2::{Digest, Sha256};

/// macOS for now (pbpaste/pbcopy); other systems fall back to the page's own clearing.
pub const SUPPORTED: bool = cfg!(target_os = "macos");

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Whether `text` matches the lowercase hex SHA-256 `hash` (as the page computes it over UTF-8).
pub fn matches(text: &[u8], hash: &str) -> bool {
    hex(&Sha256::digest(text)) == hash
}

#[cfg(target_os = "macos")]
pub fn clear_if(hash: &str) {
    use std::io::Write;
    use std::process::{Command, Stdio};
    let Ok(out) = Command::new("/usr/bin/pbpaste").env("LANG", "en_US.UTF-8").output() else { return };
    let current = zeroize::Zeroizing::new(out.stdout);
    if !matches(&current, hash) {
        return;
    }
    if let Ok(mut child) = Command::new("/usr/bin/pbcopy").env("LANG", "en_US.UTF-8").stdin(Stdio::piped()).spawn() {
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(b"");
        }
        let _ = child.wait();
    }
}

#[cfg(not(target_os = "macos"))]
pub fn clear_if(_hash: &str) {}

#[cfg(test)]
mod tests {
    #[test]
    fn hash_matches_sha256_hex() {
        assert!(super::matches(b"abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"));
        assert!(!super::matches(b"abd", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"));
    }
}
