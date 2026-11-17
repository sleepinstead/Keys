//! The few things that differ between macOS and Windows: home folder, file permissions, how a
//! file is recognised after a sync app replaces it, and child processes without a console window.

use std::fs::Metadata;
use std::path::{Path, PathBuf};

/// The user's home folder (HOME on macOS, USERPROFILE on Windows).
pub fn home() -> PathBuf {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(var).or_else(|| std::env::var_os("HOME")).map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/"))
}

/// Owner-only access. On Windows the per-user folders Keys uses are already private (their ACLs),
/// and a database elsewhere is the user's choice of location; contents are encrypted either way.
pub fn make_private(path: &Path, dir: bool) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(if dir { 0o700 } else { 0o600 }))
    }
    #[cfg(not(unix))]
    {
        let _ = (path, dir);
        Ok(())
    }
}

/// What identifies a file on disk: (file id, volume, size, modified time in ns). A sync app that
/// replaces the file changes the id (Unix inode; Windows creation time) or the modified time.
pub fn identity(m: &Metadata) -> (u64, u64, u64, i128) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        (m.ino(), m.dev(), m.size(), m.mtime() as i128 * 1_000_000_000 + m.mtime_nsec() as i128)
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // FILETIME ticks are 100 ns.
        (m.creation_time(), 0, m.file_size(), m.last_write_time() as i128 * 100)
    }
}

/// A command that doesn't flash a console window on Windows.
pub fn command(program: impl AsRef<std::ffi::OsStr>) -> std::process::Command {
    #[allow(unused_mut)]
    let mut cmd = std::process::Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}
