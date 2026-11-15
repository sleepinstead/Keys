//! Byte-for-byte compatible with server/crypto.ts: Argon2id (NFKC password) and AES-256-GCM
//! with the layout version(1) | nonce(12) | tag(16) | ciphertext.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::Engine;
use base64::engine::general_purpose::{STANDARD as B64, URL_SAFE_NO_PAD as B64URL};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use unicode_normalization::UnicodeNormalization;
use zeroize::Zeroizing;

pub const KEY_BYTES: usize = 32;
const NONCE_BYTES: usize = 12;
const TAG_BYTES: usize = 16;
const FORMAT_VERSION: u8 = 1;

/// The vault key (DEK) or a key derived from a password. Wiped from memory when dropped.
pub type Key = Zeroizing<[u8; KEY_BYTES]>;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct KdfParams {
    pub algorithm: String,
    /// Memory cost in KiB.
    pub memory: u32,
    pub passes: u32,
    pub parallelism: u32,
    /// Base64 salt.
    pub salt: String,
}

/// 128 MiB, 3 passes, 4 lanes for passwords; 512 MiB, 6 passes for PIN and pattern vaults.
pub fn new_kdf_params(short_credential: bool) -> KdfParams {
    let (memory, passes) = if short_credential { (524_288, 6) } else { (131_072, 3) };
    KdfParams { algorithm: "argon2id".into(), memory, passes, parallelism: 4, salt: B64.encode(random_bytes::<16>()) }
}

/// KDF settings come from files the user opens, so bound them: a crafted file can't exhaust memory.
pub fn is_valid_kdf(k: &KdfParams) -> bool {
    k.algorithm == "argon2id" && (8192..=524_288).contains(&k.memory) && (1..=10).contains(&k.passes) && (1..=16).contains(&k.parallelism) && (16..=128).contains(&k.salt.len())
}

/// Argon2id → 256-bit key. Slow on purpose: call it from a blocking thread.
pub fn derive_key(password: &str, params: &KdfParams) -> Result<Key, &'static str> {
    if params.algorithm != "argon2id" {
        return Err("Unsupported KDF");
    }
    let salt = B64.decode(&params.salt).map_err(|_| "Invalid salt")?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, Params::new(params.memory, params.passes, params.parallelism, Some(KEY_BYTES)).map_err(|_| "Invalid key settings")?);
    let message = Zeroizing::new(password.nfkc().collect::<String>());
    let mut out = Zeroizing::new([0u8; KEY_BYTES]);
    argon.hash_password_into(message.as_bytes(), &salt, out.as_mut()).map_err(|_| "Key derivation failed")?;
    Ok(out)
}

pub fn encrypt(key: &[u8; KEY_BYTES], plaintext: &[u8], aad: &str) -> Vec<u8> {
    let cipher = Aes256Gcm::new_from_slice(key).expect("32-byte key");
    let nonce = random_bytes::<NONCE_BYTES>();
    let sealed = cipher.encrypt(Nonce::from_slice(&nonce), Payload { msg: plaintext, aad: aad.as_bytes() }).expect("AES-GCM encryption cannot fail for in-memory data");
    // aes-gcm returns ciphertext || tag; the file format stores the tag first.
    let (ct, tag) = sealed.split_at(sealed.len() - TAG_BYTES);
    let mut out = Vec::with_capacity(1 + NONCE_BYTES + sealed.len());
    out.push(FORMAT_VERSION);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(tag);
    out.extend_from_slice(ct);
    out
}

#[derive(Debug)]
pub struct DecryptionError;

pub fn decrypt(key: &[u8; KEY_BYTES], blob: &[u8], aad: &str) -> Result<Zeroizing<Vec<u8>>, DecryptionError> {
    if blob.len() < 1 + NONCE_BYTES + TAG_BYTES || blob[0] != FORMAT_VERSION {
        return Err(DecryptionError);
    }
    let nonce = &blob[1..1 + NONCE_BYTES];
    let tag = &blob[1 + NONCE_BYTES..1 + NONCE_BYTES + TAG_BYTES];
    let ct = &blob[1 + NONCE_BYTES + TAG_BYTES..];
    let mut sealed = Vec::with_capacity(ct.len() + TAG_BYTES);
    sealed.extend_from_slice(ct);
    sealed.extend_from_slice(tag);
    let cipher = Aes256Gcm::new_from_slice(key).expect("32-byte key");
    cipher.decrypt(Nonce::from_slice(nonce), Payload { msg: &sealed, aad: aad.as_bytes() }).map(Zeroizing::new).map_err(|_| DecryptionError)
}

pub fn encrypt_json(key: &[u8; KEY_BYTES], value: &serde_json::Value, aad: &str) -> Vec<u8> {
    let plain = Zeroizing::new(serde_json::to_vec(value).expect("JSON values serialise"));
    encrypt(key, &plain, aad)
}

pub fn decrypt_json(key: &[u8; KEY_BYTES], blob: &[u8], aad: &str) -> Result<serde_json::Value, DecryptionError> {
    let plain = decrypt(key, blob, aad)?;
    serde_json::from_slice(&plain).map_err(|_| DecryptionError)
}

pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut out = [0u8; N];
    rand::rngs::OsRng.fill_bytes(&mut out);
    out
}

pub fn random_key() -> Key {
    Zeroizing::new(random_bytes::<KEY_BYTES>())
}

pub fn random_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// 32 random bytes, base64url (same as the Node server's session tokens).
pub fn random_token() -> String {
    B64URL.encode(random_bytes::<32>())
}

/// Compares two secrets in constant time (hashing first so lengths don't leak).
pub fn safe_equal(a: &str, b: &str) -> bool {
    Sha256::digest(a.as_bytes()).ct_eq(&Sha256::digest(b.as_bytes())).into()
}

pub fn b64_encode(bytes: &[u8]) -> String {
    B64.encode(bytes)
}

pub fn b64_decode(s: &str) -> Option<Vec<u8>> {
    B64.decode(s).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_and_tamper() {
        let key = random_key();
        let blob = encrypt(&key, b"hello", "vaultx:entry:1");
        assert_eq!(&decrypt(&key, &blob, "vaultx:entry:1").unwrap()[..], b"hello");
        assert!(decrypt(&key, &blob, "vaultx:entry:2").is_err(), "AAD binds the row id");
        let mut bad = blob.clone();
        *bad.last_mut().unwrap() ^= 1;
        assert!(decrypt(&key, &bad, "vaultx:entry:1").is_err());
    }
}
