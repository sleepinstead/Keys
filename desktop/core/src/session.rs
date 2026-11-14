//! The unlocked vault key, held in memory for one session (server/session.ts), and the
//! in-memory PIN quick unlock (server/pin.ts).

use crate::crypto::{self, KdfParams, Key};

pub struct Session {
    key: Option<Key>,
    token: Option<String>,
    last_activity: i64,
    /// Idle time before auto-lock; kept in step with the vault's settings.
    pub idle_ms: i64,
}

impl Session {
    pub fn new() -> Self {
        Session { key: None, token: None, last_activity: 0, idle_ms: 5 * 60_000 }
    }

    /// Starts a new session, replacing (and invalidating) any existing one.
    pub fn open(&mut self, key: Key, now: i64) -> String {
        self.lock();
        self.key = Some(key);
        let token = crypto::random_token();
        self.token = Some(token.clone());
        self.last_activity = now;
        token
    }

    pub fn unlocked(&self) -> bool {
        self.key.is_some()
    }

    /// The vault key if `token` is the live session. Optionally counts as activity.
    pub fn authorize(&mut self, token: Option<&str>, touch: bool, now: i64) -> Option<Key> {
        self.expire_if_idle(now);
        let (Some(key), Some(live), Some(token)) = (&self.key, &self.token, token) else { return None };
        if !crypto::safe_equal(token, live) {
            return None;
        }
        if touch {
            self.last_activity = now;
        }
        Some(key.clone())
    }

    /// The key while unlocked, for the browser extension (which has no session token of its own).
    pub fn peek(&mut self, touch: bool, now: i64) -> Option<Key> {
        self.expire_if_idle(now);
        let key = self.key.clone()?;
        if touch {
            self.last_activity = now;
        }
        Some(key)
    }

    pub fn expires_at(&self) -> Option<i64> {
        self.key.as_ref().map(|_| self.last_activity + self.idle_ms)
    }

    /// Returns true if it was unlocked. The key is zeroed as it's dropped.
    pub fn lock(&mut self) -> bool {
        let was = self.key.is_some();
        self.key = None;
        self.token = None;
        was
    }

    pub fn expire_if_idle(&mut self, now: i64) -> bool {
        self.key.is_some() && now - self.last_activity >= self.idle_ms && self.lock()
    }
}

impl Default for Session {
    fn default() -> Self {
        Self::new()
    }
}

pub const MAX_PIN_ATTEMPTS: i64 = 5;
const WRAP_AAD: &str = "keys:pin-unlock:v1";

/// PIN quick unlock. A short PIN can't protect data at rest, so it never does: the PIN-wrapped
/// vault key exists only in this process's memory, armed by a master-password unlock and
/// destroyed after MAX_PIN_ATTEMPTS wrong PINs or when the app quits.
#[derive(Default)]
pub struct QuickUnlock {
    wrapped: Option<Vec<u8>>,
    pub kdf: Option<KdfParams>,
    pub length: usize,
    pub attempts_left: i64,
    pub busy: bool,
}

impl QuickUnlock {
    pub fn armed(&self) -> bool {
        self.wrapped.is_some()
    }

    /// `pin_key` is Argon2id(pin) with `kdf`, derived off the request thread.
    pub fn arm(&mut self, dek: &Key, pin_key: &Key, kdf: KdfParams, length: usize) {
        self.disarm();
        self.wrapped = Some(crypto::encrypt(pin_key, dek.as_ref(), WRAP_AAD));
        self.kdf = Some(kdf);
        self.length = length;
        self.attempts_left = MAX_PIN_ATTEMPTS;
    }

    /// A fresh copy of the vault key, or None for a wrong PIN (counting the attempt).
    pub fn try_key(&mut self, pin_key: &Key) -> Option<Key> {
        let wrapped = self.wrapped.as_ref()?;
        match crate::vault::unwrap_dek_with(pin_key, wrapped, WRAP_AAD) {
            Some(dek) => {
                self.attempts_left = MAX_PIN_ATTEMPTS;
                Some(dek)
            }
            None => {
                self.attempts_left -= 1;
                if self.attempts_left <= 0 {
                    self.disarm();
                }
                None
            }
        }
    }

    pub fn disarm(&mut self) {
        self.wrapped = None;
        self.kdf = None;
        self.length = 0;
        self.attempts_left = 0;
    }
}
