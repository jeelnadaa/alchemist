//! Project format: portable, versioned JSON that only ever *references*
//! original media. Originals are never modified (PLAN.md principle 4).
//!
//! On disk: `projects/<id>/project.alc`, `history.json` (undo that survives
//! restarts) and `snapshots/` (versioned copies every few minutes).

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const FORMAT_VERSION: u32 = 1;
pub const HISTORY_LIMIT: usize = 200;
pub const SNAPSHOT_EVERY_SECS: u64 = 600;
pub const SNAPSHOTS_KEPT: usize = 20;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSettings {
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    #[serde(default)]
    pub background: String,
    #[serde(default)]
    pub padding: u32,
    #[serde(default)]
    pub radius: u32,
    /// Soft drop shadow under the picture (app-demo look).
    #[serde(default)]
    pub shadow: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Media {
    pub id: String,
    pub path: PathBuf,
    pub kind: String, // video | audio | image
    #[serde(default)]
    pub duration: f64,
    #[serde(default)]
    pub width: u32,
    #[serde(default)]
    pub height: u32,
    #[serde(default)]
    pub has_audio: bool,
    #[serde(default)]
    pub missing: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Transform {
    #[serde(default)]
    pub crop: Option<[f64; 4]>, // x, y, w, h as fractions 0..1
    #[serde(default)]
    pub rotate: i32, // 0, 90, 180, 270
    #[serde(default)]
    pub flip_h: bool,
    #[serde(default)]
    pub flip_v: bool,
    #[serde(default = "one")]
    pub scale: f64,
    #[serde(default)]
    pub x: f64, // offset as fraction of canvas
    #[serde(default)]
    pub y: f64,
}

fn one() -> f64 {
    1.0
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct TextProps {
    pub text: String,
    #[serde(default)]
    pub style: String, // caption | title | label | callout
    #[serde(default = "default_size")]
    pub size: u32,
    #[serde(default)]
    pub position: String, // top | middle | bottom
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub animation: String, // none | fade
}

fn default_size() -> u32 {
    48
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ShapeProps {
    pub shape: String,  // rect | highlight | blur | pixelate | arrow
    pub rect: [f64; 4], // x, y, w, h fractions
    #[serde(default)]
    pub color: String,
}

/// A volume point, `t` seconds from the clip's start on the timeline.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Default)]
pub struct VolumeKey {
    pub t: f64,
    pub v: f64,
}

/// How a clip enters from the clip before it on the same track.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Transition {
    /// "crossfade" (blend into the previous clip) or "dip" (fade through the background).
    pub kind: String,
    pub duration: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Clip {
    pub id: String,
    #[serde(default)]
    pub media_id: Option<String>,
    /// Position on the timeline in seconds.
    pub start: f64,
    /// Source in/out points in seconds (for text/shapes: out - in = length).
    #[serde(rename = "in")]
    pub in_point: f64,
    pub out: f64,
    #[serde(default = "one")]
    pub speed: f64,
    #[serde(default = "one")]
    pub volume: f64,
    #[serde(default)]
    pub fade_in: f64,
    #[serde(default)]
    pub fade_out: f64,
    #[serde(default)]
    pub reverse: bool,
    #[serde(default)]
    pub freeze: bool,
    #[serde(default)]
    pub transform: Transform,
    #[serde(default)]
    pub text: Option<TextProps>,
    #[serde(default)]
    pub shape: Option<ShapeProps>,
    #[serde(default)]
    pub clean_voice: bool,
    #[serde(default)]
    pub volume_keys: Vec<VolumeKey>,
    #[serde(default)]
    pub transition_in: Option<Transition>,
}

impl Default for Clip {
    fn default() -> Self {
        Clip {
            id: String::new(),
            media_id: None,
            start: 0.0,
            in_point: 0.0,
            out: 0.0,
            speed: 1.0,
            volume: 1.0,
            fade_in: 0.0,
            fade_out: 0.0,
            reverse: false,
            freeze: false,
            transform: Transform {
                scale: 1.0,
                ..Default::default()
            },
            text: None,
            shape: None,
            clean_voice: false,
            volume_keys: Vec::new(),
            transition_in: None,
        }
    }
}

impl Clip {
    /// Length on the timeline after speed change.
    pub fn length(&self) -> f64 {
        if self.freeze {
            return (self.out - self.in_point).max(0.0);
        }
        ((self.out - self.in_point) / self.speed.max(0.01)).max(0.0)
    }
    pub fn end(&self) -> f64 {
        self.start + self.length()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub id: String,
    pub kind: String, // video | overlay | text | audio
    pub name: String,
    #[serde(default)]
    pub muted: bool,
    #[serde(default = "one")]
    pub volume: f64,
    pub clips: Vec<Clip>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Zoom {
    pub start: f64,
    pub end: f64,
    pub scale: f64,
    /// Focus point as fractions of the frame.
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Caption {
    pub start: f64,
    pub end: f64,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Marker {
    pub t: f64,
    #[serde(default)]
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub version: u32,
    pub id: String,
    pub name: String,
    pub created: u64,
    pub modified: u64,
    pub settings: ProjectSettings,
    pub media: Vec<Media>,
    pub tracks: Vec<Track>,
    #[serde(default)]
    pub zooms: Vec<Zoom>,
    #[serde(default)]
    pub zoom_smoothness: f64,
    #[serde(default)]
    pub captions: Vec<Caption>,
    #[serde(default)]
    pub markers: Vec<Marker>,
    #[serde(default)]
    pub in_point: Option<f64>,
    #[serde(default)]
    pub out_point: Option<f64>,
    /// Recording sidecar (cursor/click events), relative or absolute.
    #[serde(default)]
    pub events: Option<PathBuf>,
    /// The media the event log belongs to (the screen recording).
    #[serde(default)]
    pub events_media: Option<String>,
    /// Screen rectangle that was recorded: x, y, width, height in screen pixels.
    #[serde(default)]
    pub source_rect: Option<[f64; 4]>,
    /// True when the recording has no cursor in the picture, so Alchemist draws one.
    #[serde(default)]
    pub cursor_hidden: bool,
    #[serde(default)]
    pub cursor: CursorSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct CursorSettings {
    /// Draw Alchemist's smooth cursor (only when the recording has none of its own).
    pub show: bool,
    /// 1.0 = normal size.
    pub size: f64,
    /// 0 = raw movement, 1 = very smooth.
    pub smoothing: f64,
    pub ripple: bool,
    pub highlight: bool,
    pub keys: bool,
    pub color: String,
}

impl Default for CursorSettings {
    fn default() -> Self {
        CursorSettings {
            show: true,
            size: 1.0,
            smoothing: 0.5,
            ripple: true,
            highlight: false,
            keys: true,
            color: "#5b8cff".into(),
        }
    }
}

pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

impl Project {
    pub fn new(name: &str, width: u32, height: u32, fps: f64) -> Self {
        let c =
            crate::limits::clamp_video(crate::limits::VideoSettings { width, height, fps }).value;
        let t = now();
        Project {
            version: FORMAT_VERSION,
            id: uuid::Uuid::new_v4().to_string(),
            name: name.to_string(),
            created: t,
            modified: t,
            settings: ProjectSettings {
                width: c.width,
                height: c.height,
                fps: c.fps,
                background: "#000000".into(),
                padding: 0,
                radius: 0,
                shadow: false,
            },
            media: vec![],
            tracks: vec![
                Track {
                    id: "v1".into(),
                    kind: "video".into(),
                    name: "Video".into(),
                    muted: false,
                    volume: 1.0,
                    clips: vec![],
                },
                Track {
                    id: "t1".into(),
                    kind: "text".into(),
                    name: "Text".into(),
                    muted: false,
                    volume: 1.0,
                    clips: vec![],
                },
                Track {
                    id: "a1".into(),
                    kind: "audio".into(),
                    name: "Voice".into(),
                    muted: false,
                    volume: 1.0,
                    clips: vec![],
                },
            ],
            zooms: vec![],
            zoom_smoothness: 0.5,
            captions: vec![],
            markers: vec![],
            in_point: None,
            out_point: None,
            events: None,
            events_media: None,
            source_rect: None,
            cursor_hidden: false,
            cursor: CursorSettings::default(),
        }
    }

    pub fn duration(&self) -> f64 {
        self.tracks
            .iter()
            .flat_map(|t| t.clips.iter())
            .map(Clip::end)
            .fold(0.0, f64::max)
    }

    pub fn media(&self, id: &str) -> Option<&Media> {
        self.media.iter().find(|m| m.id == id)
    }

    /// Flag media whose files have moved, so the UI can offer to relink them.
    pub fn check_missing(&mut self) -> usize {
        let mut n = 0;
        for m in &mut self.media {
            m.missing = !m.path.exists();
            if m.missing {
                n += 1;
            }
        }
        n
    }
}

/// Upgrade older project files. Unknown future versions are refused politely.
pub fn migrate(mut v: Value) -> Result<Project, String> {
    let ver = v.get("version").and_then(Value::as_u64).unwrap_or(0) as u32;
    if ver > FORMAT_VERSION {
        return Err(
            "This project was made with a newer version of Alchemist. Update Alchemist to open it."
                .into(),
        );
    }
    if ver == 0 {
        // v0 → v1: settings used to be top-level width/height/fps.
        let w = v.get("width").and_then(Value::as_u64).unwrap_or(1920);
        let h = v.get("height").and_then(Value::as_u64).unwrap_or(1080);
        let f = v.get("fps").and_then(Value::as_f64).unwrap_or(30.0);
        if let Some(o) = v.as_object_mut() {
            o.insert("settings".into(), serde_json::json!({ "width": w, "height": h, "fps": f, "background": "#000000", "padding": 0, "radius": 0 }));
            o.insert("version".into(), serde_json::json!(1));
        }
    }
    serde_json::from_value(v).map_err(|e| format!("This project file is damaged ({e})."))
}

pub fn project_dir(root: &Path, id: &str) -> PathBuf {
    root.join(id)
}

fn atomic_write(path: &Path, text: &str) -> std::io::Result<()> {
    if let Some(p) = path.parent() {
        std::fs::create_dir_all(p)?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, text)?;
    std::fs::rename(tmp, path)
}

pub fn save(root: &Path, p: &Project) -> Result<PathBuf, String> {
    let dir = project_dir(root, &p.id);
    let mut p = p.clone();
    p.modified = now();
    let text = serde_json::to_string_pretty(&p).map_err(|e| e.to_string())?;
    let file = dir.join("project.alc");
    atomic_write(&file, &text).map_err(|e| e.to_string())?;
    // Versioned snapshot every SNAPSHOT_EVERY_SECS.
    let snaps = dir.join("snapshots");
    let latest = std::fs::read_dir(&snaps)
        .ok()
        .and_then(|rd| {
            rd.filter_map(Result::ok)
                .filter_map(|e| {
                    e.file_name()
                        .to_string_lossy()
                        .trim_end_matches(".alc")
                        .parse::<u64>()
                        .ok()
                })
                .max()
        })
        .unwrap_or(0);
    if p.modified.saturating_sub(latest) >= SNAPSHOT_EVERY_SECS {
        let _ = atomic_write(&snaps.join(format!("{}.alc", p.modified)), &text);
        prune_snapshots(&snaps);
    }
    Ok(file)
}

fn prune_snapshots(dir: &Path) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<PathBuf> = rd.filter_map(Result::ok).map(|e| e.path()).collect();
    files.sort();
    while files.len() > SNAPSHOTS_KEPT {
        let _ = std::fs::remove_file(files.remove(0));
    }
}

pub fn load(root: &Path, id: &str) -> Result<Project, String> {
    let file = project_dir(root, id).join("project.alc");
    let text = std::fs::read_to_string(&file)
        .map_err(|_| "This project couldn't be found.".to_string())?;
    let v: Value = serde_json::from_str(&text).map_err(|_| {
        "This project file is damaged. Try a snapshot from the project's history.".to_string()
    })?;
    let mut p = migrate(v)?;
    p.check_missing();
    Ok(p)
}

pub fn load_file(path: &Path) -> Result<Project, String> {
    let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    let mut p = migrate(serde_json::from_str(&text).map_err(|e| e.to_string())?)?;
    p.check_missing();
    Ok(p)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub id: String,
    pub name: String,
    pub modified: u64,
    pub duration: f64,
    pub thumb: Option<PathBuf>,
}

pub fn list(root: &Path) -> Vec<Summary> {
    let mut out: Vec<Summary> = std::fs::read_dir(root)
        .map(|rd| {
            rd.filter_map(Result::ok)
                .filter_map(|e| load(root, &e.file_name().to_string_lossy()).ok())
                .map(|p| Summary {
                    duration: p.duration(),
                    thumb: p
                        .media
                        .iter()
                        .find(|m| m.kind == "video")
                        .map(|m| m.path.clone()),
                    id: p.id,
                    name: p.name,
                    modified: p.modified,
                })
                .collect()
        })
        .unwrap_or_default();
    out.sort_by_key(|s| std::cmp::Reverse(s.modified));
    out
}

pub fn delete(root: &Path, id: &str) -> Result<(), String> {
    if id.contains(['/', '\\', '.']) {
        return Err("Invalid project.".into());
    }
    std::fs::remove_dir_all(project_dir(root, id)).map_err(|e| e.to_string())
}

/// Undo history survives restarts: the UI sends the stack, we store it.
pub fn save_history(root: &Path, id: &str, history: &Value) -> Result<(), String> {
    let mut h = history.clone();
    if let Some(arr) = h.get_mut("undo").and_then(Value::as_array_mut) {
        let n = arr.len();
        if n > HISTORY_LIMIT {
            arr.drain(0..n - HISTORY_LIMIT);
        }
    }
    atomic_write(&project_dir(root, id).join("history.json"), &h.to_string())
        .map_err(|e| e.to_string())
}

pub fn load_history(root: &Path, id: &str) -> Value {
    std::fs::read_to_string(project_dir(root, id).join("history.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_else(|| serde_json::json!({ "undo": [], "redo": [] }))
}

/// Copy every media file into `<dest>/media/` and save a project that points
/// at the copies, so the folder can be moved to another computer.
pub fn package(p: &Project, dest: &Path) -> Result<PathBuf, String> {
    let media_dir = dest.join("media");
    std::fs::create_dir_all(&media_dir).map_err(|e| e.to_string())?;
    let mut out = p.clone();
    for m in &mut out.media {
        if !m.path.exists() {
            return Err(format!(
                "\"{}\" is missing. Relink it before packaging.",
                m.path.display()
            ));
        }
        let name = format!(
            "{}-{}",
            &m.id[..m.id.len().min(8)],
            m.path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default()
        );
        let target = media_dir.join(&name);
        std::fs::copy(&m.path, &target).map_err(|e| e.to_string())?;
        m.path = PathBuf::from("media").join(name);
    }
    let file = dest.join(format!("{}.alc", sanitize(&p.name)));
    atomic_write(
        &file,
        &serde_json::to_string_pretty(&out).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    Ok(file)
}

/// Resolve media paths stored relative to a packaged project file.
pub fn resolve_relative(p: &mut Project, base: &Path) {
    for m in &mut p.media {
        if m.path.is_relative() {
            m.path = base.join(&m.path);
        }
    }
}

pub fn relink(p: &mut Project, media_id: &str, new_path: PathBuf) -> Result<(), String> {
    let m = p
        .media
        .iter_mut()
        .find(|m| m.id == media_id)
        .ok_or("Unknown media.")?;
    if !new_path.exists() {
        return Err("That file doesn't exist.".into());
    }
    m.path = new_path;
    m.missing = false;
    Ok(())
}

pub fn sanitize(name: &str) -> String {
    let s: String = name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || " -_".contains(c) {
                c
            } else {
                '-'
            }
        })
        .collect();
    let s = s.trim().to_string();
    if s.is_empty() {
        "project".into()
    } else {
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clip(start: f64, inp: f64, out: f64, speed: f64) -> Clip {
        Clip {
            id: "c".into(),
            media_id: Some("m".into()),
            start,
            in_point: inp,
            out,
            speed,
            volume: 1.0,
            fade_in: 0.0,
            fade_out: 0.0,
            reverse: false,
            freeze: false,
            transform: Transform::default(),
            text: None,
            shape: None,
            clean_voice: false,
            volume_keys: vec![],
            transition_in: None,
        }
    }

    #[test]
    fn new_project_is_clamped_and_has_tracks() {
        let p = Project::new("Demo", 1921, 1080, 500.0);
        assert_eq!(p.settings.width, 1922);
        assert_eq!(p.settings.fps, 240.0);
        assert_eq!(p.tracks.len(), 3);
    }

    #[test]
    fn speed_changes_length() {
        assert_eq!(clip(0.0, 10.0, 20.0, 2.0).length(), 5.0);
        assert_eq!(clip(3.0, 0.0, 10.0, 0.5).end(), 23.0);
    }

    #[test]
    fn save_load_round_trip_and_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let mut p = Project::new("Demo", 1920, 1080, 30.0);
        p.tracks[0].clips.push(clip(0.0, 0.0, 5.0, 1.0));
        save(dir.path(), &p).unwrap();
        let back = load(dir.path(), &p.id).unwrap();
        assert_eq!(back.tracks[0].clips.len(), 1);
        assert!(
            dir.path()
                .join(&p.id)
                .join("snapshots")
                .read_dir()
                .unwrap()
                .count()
                >= 1
        );
        assert_eq!(list(dir.path()).len(), 1);
    }

    #[test]
    fn old_files_migrate_and_new_ones_are_refused() {
        let v0 = serde_json::json!({ "id": "x", "name": "Old", "created": 1, "modified": 1, "width": 1280, "height": 720, "fps": 25.0, "media": [], "tracks": [] });
        let p = migrate(v0).unwrap();
        assert_eq!(p.settings.width, 1280);
        assert_eq!(p.version, 1);
        let future = serde_json::json!({ "version": 99 });
        assert!(migrate(future).unwrap_err().contains("newer version"));
    }

    #[test]
    fn missing_media_is_flagged_and_relinked() {
        let dir = tempfile::tempdir().unwrap();
        let mut p = Project::new("Demo", 1920, 1080, 30.0);
        p.media.push(Media {
            id: "m1".into(),
            path: dir.path().join("gone.mp4"),
            kind: "video".into(),
            duration: 1.0,
            width: 1,
            height: 1,
            has_audio: false,
            missing: false,
        });
        assert_eq!(p.check_missing(), 1);
        let real = dir.path().join("here.mp4");
        std::fs::write(&real, b"x").unwrap();
        relink(&mut p, "m1", real).unwrap();
        assert_eq!(p.check_missing(), 0);
    }

    #[test]
    fn packaging_copies_media_and_never_touches_originals() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("clip.mp4");
        std::fs::write(&src, b"original").unwrap();
        let mut p = Project::new("My Demo", 1920, 1080, 30.0);
        p.media.push(Media {
            id: "abcdef123".into(),
            path: src.clone(),
            kind: "video".into(),
            duration: 1.0,
            width: 1,
            height: 1,
            has_audio: false,
            missing: false,
        });
        let out = dir.path().join("pkg");
        let file = package(&p, &out).unwrap();
        assert_eq!(std::fs::read(&src).unwrap(), b"original");
        let mut q = load_file(&file).unwrap();
        resolve_relative(&mut q, &out);
        assert!(q.media[0].path.exists());
    }

    #[test]
    fn history_is_capped() {
        let dir = tempfile::tempdir().unwrap();
        let undo: Vec<Value> = (0..500).map(|i| serde_json::json!(i)).collect();
        save_history(
            dir.path(),
            "p",
            &serde_json::json!({ "undo": undo, "redo": [] }),
        )
        .unwrap();
        let h = load_history(dir.path(), "p");
        assert_eq!(h["undo"].as_array().unwrap().len(), HISTORY_LIMIT);
        assert_eq!(h["undo"][0], 300);
    }

    #[test]
    fn delete_rejects_paths() {
        assert!(delete(Path::new("."), "../x").is_err());
    }
}
