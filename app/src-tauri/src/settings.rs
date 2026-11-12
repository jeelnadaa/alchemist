//! User settings. Unknown keys are kept, missing keys get defaults, so old
//! and new versions of the app can share one settings file.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub theme: String,
    pub dark_theme: String,
    pub light_theme: String,
    pub follow_system: bool,
    pub accent: Option<String>,
    pub text_size: String,
    pub reduce_motion: bool,
    pub update_mode: String, // auto | notify | off
    pub beta_channel: bool,
    pub last_update_check: u64,
    pub use_hardware: bool,
    pub record_preset: String,
    pub record_mic: bool,
    pub record_system_audio: bool,
    pub record_camera: bool,
    pub record_keys: bool,
    #[serde(default = "yes")]
    pub record_smooth_cursor: bool,
    pub countdown: u32,
    pub replay_seconds: u32,
    pub replay_hotkey: String,
    pub replays_folder: Option<String>,
    pub default_target_mb: f64,
    pub save_next_to_original: bool,
    pub export_folder: Option<String>,
    pub shortcut_preset: String,
    pub shortcuts: BTreeMap<String, String>,
    pub first_run_done: bool,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            theme: "obsidian".into(),
            dark_theme: "obsidian".into(),
            light_theme: "salt".into(),
            follow_system: false,
            accent: None,
            text_size: "default".into(),
            reduce_motion: false,
            update_mode: "auto".into(),
            beta_channel: false,
            last_update_check: 0,
            use_hardware: true,
            record_preset: "tutorial".into(),
            record_mic: true,
            record_system_audio: true,
            record_camera: false,
            record_keys: false,
            record_smooth_cursor: true,
            countdown: 3,
            replay_seconds: 30,
            replay_hotkey: DEFAULT_REPLAY_HOTKEY.into(),
            replays_folder: None,
            default_target_mb: 25.0,
            save_next_to_original: true,
            export_folder: None,
            shortcut_preset: "alchemist".into(),
            shortcuts: BTreeMap::new(),
            first_run_done: false,
            extra: BTreeMap::new(),
        }
    }
}

/// Saves the last moments of instant replay. Registered only while replay runs.
pub const DEFAULT_REPLAY_HOTKEY: &str = "CommandOrControl+Alt+R";

pub fn load(path: &Path) -> Settings {
    let mut s: Settings = std::fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default();
    migrate(&mut s);
    s
}

/// Fix values written by older versions.
pub fn migrate(s: &mut Settings) {
    // 0.3.0 used Ctrl+Shift+S, which took "Save as" away from every other app.
    if s.replay_hotkey.trim().is_empty() || s.replay_hotkey == "CommandOrControl+Shift+S" {
        s.replay_hotkey = DEFAULT_REPLAY_HOTKEY.into();
    }
    s.replay_seconds = s.replay_seconds.clamp(5, 600);
}

pub fn save(path: &Path, s: &Settings) -> Result<(), String> {
    if let Some(p) = path.parent() {
        std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(
        &tmp,
        serde_json::to_string_pretty(s).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    std::fs::rename(tmp, path).map_err(|e| e.to_string())
}

/// Update checks: at most once a day, with up to an hour of random jitter so
/// every install doesn't ask GitHub at the same minute.
pub fn update_check_due(s: &Settings, now: u64, jitter_secs: u64) -> bool {
    s.update_mode != "off" && now >= s.last_update_check + 86_400 + jitter_secs.min(3600)
}

fn yes() -> bool {
    true
}

#[cfg(test)]
mod tests {
    #[test]
    fn old_replay_hotkey_is_moved_off_save_as() {
        let mut s = Settings {
            replay_hotkey: "CommandOrControl+Shift+S".into(),
            replay_seconds: 0,
            ..Default::default()
        };
        migrate(&mut s);
        assert_eq!(s.replay_hotkey, DEFAULT_REPLAY_HOTKEY);
        assert_eq!(s.replay_seconds, 5);
        let mut custom = Settings {
            replay_hotkey: "Alt+F9".into(),
            ..Default::default()
        };
        migrate(&mut custom);
        assert_eq!(custom.replay_hotkey, "Alt+F9");
    }

    use super::*;

    #[test]
    fn defaults_and_unknown_keys_survive() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("settings.json");
        std::fs::write(&p, r#"{"theme":"salt","futureThing":{"a":1}}"#).unwrap();
        let s = load(&p);
        assert_eq!(s.theme, "salt");
        assert_eq!(s.update_mode, "auto");
        assert!(s.extra.contains_key("futureThing"));
        save(&p, &s).unwrap();
        assert!(std::fs::read_to_string(&p).unwrap().contains("futureThing"));
    }

    #[test]
    fn broken_file_falls_back_to_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("settings.json");
        std::fs::write(&p, "{not json").unwrap();
        assert_eq!(load(&p), Settings::default());
    }

    #[test]
    fn update_throttle() {
        let mut s = Settings::default();
        assert!(update_check_due(&s, 100_000, 0));
        s.last_update_check = 100_000;
        assert!(!update_check_due(&s, 150_000, 0));
        assert!(update_check_due(&s, 190_000, 0));
        assert!(!update_check_due(&s, 186_500, 3000));
        s.update_mode = "off".into();
        assert!(!update_check_due(&s, 999_999, 0));
    }
}
