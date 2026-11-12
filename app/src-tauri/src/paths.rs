//! Where Alchemist keeps its data, including portable mode (PLAN.md 6.1).
//!
//! Portable mode is switched on by a `portable.txt` marker beside the app.
//! Then settings, presets, logs, crash reports and caches live in a `data/`
//! folder beside the app and nothing is written to the user profile.

use serde::Serialize;
use std::path::{Path, PathBuf};

pub const PORTABLE_MARKER: &str = "portable.txt";
pub const APP_DIR_NAME: &str = "Alchemist";

#[derive(Debug, Clone, Serialize)]
pub struct DataLocation {
    pub root: PathBuf,
    pub portable: bool,
    /// Set when portable mode was requested but the folder is read-only.
    pub portable_fallback_reason: Option<String>,
}

impl DataLocation {
    pub fn settings_file(&self) -> PathBuf {
        self.root.join("settings.json")
    }
    pub fn projects_dir(&self) -> PathBuf {
        self.root.join("projects")
    }
    pub fn recordings_dir(&self) -> PathBuf {
        self.root.join("recordings")
    }
    pub fn logs_dir(&self) -> PathBuf {
        self.root.join("logs")
    }
    pub fn crash_dir(&self) -> PathBuf {
        self.root.join("crash-reports")
    }
    pub fn cache_dir(&self) -> PathBuf {
        self.root.join("cache")
    }
}

/// The folder a portable marker would sit in, for the current executable.
/// macOS: next to the `.app` bundle. Linux AppImage: next to the AppImage file.
pub fn install_dir(exe: &Path) -> PathBuf {
    if let Ok(appimage) = std::env::var("APPIMAGE") {
        if let Some(dir) = Path::new(&appimage).parent() {
            return dir.to_path_buf();
        }
    }
    let dir = exe.parent().map(Path::to_path_buf).unwrap_or_default();
    // …/Alchemist.app/Contents/MacOS/alchemist → folder containing Alchemist.app
    if dir.ends_with("Contents/MacOS") {
        if let Some(bundle_parent) = dir.parent().and_then(Path::parent).and_then(Path::parent) {
            return bundle_parent.to_path_buf();
        }
    }
    dir
}

fn writable(dir: &Path) -> bool {
    if std::fs::create_dir_all(dir).is_err() {
        return false;
    }
    let probe = dir.join(".write-test");
    let ok = std::fs::write(&probe, b"ok").is_ok();
    let _ = std::fs::remove_file(&probe);
    ok
}

/// Decide where data lives. `user_data` is the normal per-user location.
pub fn resolve(install: &Path, user_data: &Path) -> DataLocation {
    if install.join(PORTABLE_MARKER).exists() {
        let root = install.join("data");
        if writable(&root) {
            return DataLocation {
                root,
                portable: true,
                portable_fallback_reason: None,
            };
        }
        return DataLocation {
            root: user_data.to_path_buf(),
            portable: false,
            portable_fallback_reason: Some(format!(
                "The portable folder {} is read-only, so settings are saved in your user profile for this session.",
                install.display()
            )),
        };
    }
    DataLocation {
        root: user_data.to_path_buf(),
        portable: false,
        portable_fallback_reason: None,
    }
}

pub fn default_user_data() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join(APP_DIR_NAME)
}

pub fn detect() -> DataLocation {
    let exe = std::env::current_exe().unwrap_or_default();
    let loc = resolve(&install_dir(&exe), &default_user_data());
    for d in [
        loc.projects_dir(),
        loc.recordings_dir(),
        loc.logs_dir(),
        loc.crash_dir(),
        loc.cache_dir(),
    ] {
        let _ = std::fs::create_dir_all(d);
    }
    loc
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normal_install_uses_user_profile() {
        let install = tempfile::tempdir().unwrap();
        let user = tempfile::tempdir().unwrap();
        let loc = resolve(install.path(), user.path());
        assert!(!loc.portable);
        assert_eq!(loc.root, user.path());
    }

    #[test]
    fn marker_switches_to_portable_data_folder() {
        let install = tempfile::tempdir().unwrap();
        let user = tempfile::tempdir().unwrap();
        std::fs::write(install.path().join(PORTABLE_MARKER), "").unwrap();
        let loc = resolve(install.path(), user.path());
        assert!(loc.portable);
        assert_eq!(loc.root, install.path().join("data"));
        assert!(loc.settings_file().starts_with(install.path()));
    }

    #[test]
    fn macos_bundle_resolves_to_folder_beside_app() {
        let exe = Path::new("/Volumes/USB/Alchemist.app/Contents/MacOS/alchemist");
        if std::env::var("APPIMAGE").is_err() {
            assert_eq!(install_dir(exe), Path::new("/Volumes/USB"));
        }
    }
}
