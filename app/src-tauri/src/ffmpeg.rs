//! FFmpeg: finding it, asking it what a file contains, and running it with
//! progress. Every heavy media job runs in a separate FFmpeg process, so a
//! crash or a huge file can never freeze or bloat the app itself.

use once_cell::sync::OnceCell;
use regex::Regex;
use serde::Serialize;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};

#[derive(Debug, thiserror::Error)]
pub enum FfError {
    #[error("FFmpeg was not found. Reinstall Alchemist, or install FFmpeg and make sure it is on your PATH.")]
    NotFound,
    #[error("Could not start FFmpeg: {0}")]
    Spawn(String),
    #[error("{0}")]
    Failed(String),
    #[error("Stopped.")]
    Cancelled,
}

static FFMPEG: OnceCell<Option<PathBuf>> = OnceCell::new();

fn exe_name() -> &'static str {
    if cfg!(windows) {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    }
}

/// Candidate locations, best first: explicit override, bundled sidecar, PATH.
pub fn candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(p) = std::env::var("ALCHEMIST_FFMPEG") {
        out.push(PathBuf::from(p));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            out.push(dir.join(exe_name()));
            out.push(dir.join("binaries").join(exe_name()));
        }
    }
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            out.push(dir.join(exe_name()));
        }
    }
    out
}

pub fn locate() -> Result<PathBuf, FfError> {
    FFMPEG
        .get_or_init(|| candidates().into_iter().find(|p| p.is_file()))
        .clone()
        .ok_or(FfError::NotFound)
}

/// The FFmpeg used for screen capture. On Linux the bundled static build has
/// no X11 capture, so a system FFmpeg (from the distro) is preferred there.
pub fn locate_capture() -> Result<PathBuf, FfError> {
    if cfg!(target_os = "linux") {
        if let Some(path) = std::env::var_os("PATH") {
            for dir in std::env::split_paths(&path) {
                let p = dir.join(exe_name());
                if p.is_file() && list(&p, "-devices").contains("x11grab") {
                    return Ok(p);
                }
            }
        }
    }
    locate()
}

/// Capabilities of the capture FFmpeg (differs from the main one on Linux).
pub fn capture_capabilities() -> Result<Capabilities, FfError> {
    let mut caps = capabilities()?;
    let cap_bin = locate_capture()?;
    if Some(&cap_bin) != locate().ok().as_ref() {
        caps.devices = parse_names(&list(&cap_bin, "-devices"), 1);
        caps.encoders = parse_names(&list(&cap_bin, "-encoders"), 1);
        caps.hw_h264 = ["h264_vaapi", "h264_nvenc", "h264_qsv"]
            .iter()
            .find(|n| caps.encoders.iter().any(|e| e == *n) && encoder_works(&cap_bin, n))
            .map(|s| s.to_string());
    }
    Ok(caps)
}

pub fn command(bin: &Path) -> Command {
    let mut c = Command::new(bin);
    c.arg("-hide_banner");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c
}

// ---------------------------------------------------------------- probing

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct MediaInfo {
    pub duration: f64,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
    pub audio_streams: u32,
    pub subtitle_streams: u32,
    pub bitrate_kbps: Option<u32>,
    pub size_bytes: u64,
    pub container: String,
    pub has_video: bool,
    pub has_audio: bool,
}

/// Parse the text FFmpeg prints for `ffmpeg -i <file>`.
pub fn parse_probe(text: &str) -> MediaInfo {
    static DUR: once_cell::sync::Lazy<Regex> = once_cell::sync::Lazy::new(|| {
        Regex::new(
            r"Duration: (\d+):(\d+):(\d+(?:\.\d+)?)(?:, start: [-\d.]+)?, bitrate: (\d+|N/A)",
        )
        .unwrap()
    });
    static VID: once_cell::sync::Lazy<Regex> = once_cell::sync::Lazy::new(|| {
        Regex::new(
            r"Stream #\d+:\d+(?:\[\w+\])?(?:\(\w+\))?: Video: (\w+)[^\n]*?, (\d{2,5})x(\d{2,5})",
        )
        .unwrap()
    });
    static FPS: once_cell::sync::Lazy<Regex> =
        once_cell::sync::Lazy::new(|| Regex::new(r"Video:[^\n]*?, ([\d.]+) (?:fps|tbr)").unwrap());
    static AUD: once_cell::sync::Lazy<Regex> = once_cell::sync::Lazy::new(|| {
        Regex::new(r"Stream #\d+:\d+(?:\[\w+\])?(?:\(\w+\))?: Audio: (\w+)").unwrap()
    });
    static SUB: once_cell::sync::Lazy<Regex> = once_cell::sync::Lazy::new(|| {
        Regex::new(r"Stream #\d+:\d+(?:\[\w+\])?(?:\(\w+\))?: Subtitle:").unwrap()
    });
    static INPUT: once_cell::sync::Lazy<Regex> =
        once_cell::sync::Lazy::new(|| Regex::new(r"Input #0, ([\w,]+), from").unwrap());

    let mut info = MediaInfo::default();
    if let Some(c) = DUR.captures(text) {
        let h: f64 = c[1].parse().unwrap_or(0.0);
        let m: f64 = c[2].parse().unwrap_or(0.0);
        let s: f64 = c[3].parse().unwrap_or(0.0);
        info.duration = h * 3600.0 + m * 60.0 + s;
        info.bitrate_kbps = c[4].parse().ok();
    }
    if let Some(c) = VID.captures(text) {
        info.has_video = true;
        info.video_codec = Some(c[1].to_string());
        info.width = c[2].parse().unwrap_or(0);
        info.height = c[3].parse().unwrap_or(0);
    }
    if let Some(c) = FPS.captures(text) {
        info.fps = c[1].parse().unwrap_or(0.0);
    }
    let audio: Vec<_> = AUD.captures_iter(text).collect();
    info.audio_streams = audio.len() as u32;
    if let Some(c) = audio.first() {
        info.has_audio = true;
        info.audio_codec = Some(c[1].to_string());
    }
    info.subtitle_streams = SUB.find_iter(text).count() as u32;
    if let Some(c) = INPUT.captures(text) {
        info.container = c[1].split(',').next().unwrap_or("").to_string();
    }
    info
}

pub fn probe(path: &Path) -> Result<MediaInfo, FfError> {
    let bin = locate()?;
    let out = command(&bin)
        .arg("-i")
        .arg(path)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| FfError::Spawn(e.to_string()))?;
    let text = String::from_utf8_lossy(&out.stderr);
    if text.contains("No such file or directory") || text.contains("Invalid data found") {
        return Err(FfError::Failed(format!(
            "\"{}\" isn't a video or audio file Alchemist can read.",
            path.file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default()
        )));
    }
    let mut info = parse_probe(&text);
    info.size_bytes = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    Ok(info)
}

// ---------------------------------------------------------------- capabilities

#[derive(Debug, Clone, Default, Serialize)]
pub struct Capabilities {
    pub version: String,
    pub encoders: Vec<String>,
    pub hw_h264: Option<String>,
    pub hw_hevc: Option<String>,
    pub devices: Vec<String>,
    pub filters: Vec<String>,
}

static CAPS: OnceCell<Capabilities> = OnceCell::new();

fn list(bin: &Path, flag: &str) -> String {
    command(bin)
        .arg(flag)
        .stdin(Stdio::null())
        .output()
        .map(|o| {
            format!(
                "{}{}",
                String::from_utf8_lossy(&o.stdout),
                String::from_utf8_lossy(&o.stderr)
            )
        })
        .unwrap_or_default()
}

pub fn parse_names(text: &str, col: usize) -> Vec<String> {
    // Lines look like " V....D libx264   H.264 / ..." or " D  dshow  DirectShow"
    text.lines()
        .filter_map(|l| {
            let parts: Vec<&str> = l.split_whitespace().collect();
            if parts.len() > col && !l.contains("=") && !l.starts_with("--") {
                Some(parts[col].to_string())
            } else {
                None
            }
        })
        .collect()
}

/// A hardware encoder only counts if a tiny real encode succeeds:
/// listed encoders often exist without a matching GPU or driver.
fn encoder_works(bin: &Path, enc: &str) -> bool {
    command(bin)
        .args([
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=black:s=256x144:d=0.2",
            "-frames:v",
            "3",
            "-c:v",
            enc,
            "-f",
            "null",
            "-",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

pub fn capabilities() -> Result<Capabilities, FfError> {
    if let Some(c) = CAPS.get() {
        return Ok(c.clone());
    }
    let bin = locate()?;
    let version = list(&bin, "-version")
        .lines()
        .next()
        .unwrap_or("")
        .to_string();
    let encoders = parse_names(&list(&bin, "-encoders"), 1);
    let devices = parse_names(&list(&bin, "-devices"), 1);
    let filters = parse_names(&list(&bin, "-filters"), 1);
    let pick = |names: &[&str]| -> Option<String> {
        names
            .iter()
            .filter(|n| encoders.iter().any(|e| e == *n))
            .find(|n| encoder_works(&bin, n))
            .map(|s| s.to_string())
    };
    let hw_h264 = pick(&[
        "h264_videotoolbox",
        "h264_nvenc",
        "h264_qsv",
        "h264_amf",
        "h264_vaapi",
        "h264_mf",
    ]);
    let hw_hevc = pick(&["hevc_videotoolbox", "hevc_nvenc", "hevc_qsv", "hevc_amf"]);
    let caps = Capabilities {
        version,
        encoders,
        hw_h264,
        hw_hevc,
        devices,
        filters,
    };
    let _ = CAPS.set(caps.clone());
    Ok(caps)
}

impl Capabilities {
    pub fn has_encoder(&self, n: &str) -> bool {
        self.encoders.iter().any(|e| e == n)
    }
    pub fn has_filter(&self, n: &str) -> bool {
        self.filters.iter().any(|e| e == n)
    }
    pub fn has_device(&self, n: &str) -> bool {
        self.devices.iter().any(|e| e == n)
    }
}

// ---------------------------------------------------------------- running

/// Parse `-progress pipe:1` key=value output into seconds processed.
pub fn parse_progress_line(line: &str) -> Option<f64> {
    let (k, v) = line.split_once('=')?;
    match k.trim() {
        "out_time_us" | "out_time_ms" => v.trim().parse::<f64>().ok().map(|us| us / 1_000_000.0),
        "out_time" => {
            let mut parts = v.trim().split(':');
            let h: f64 = parts.next()?.parse().ok()?;
            let m: f64 = parts.next()?.parse().ok()?;
            let s: f64 = parts.next()?.parse().ok()?;
            Some(h * 3600.0 + m * 60.0 + s)
        }
        _ => None,
    }
}

/// Turn FFmpeg's last error lines into something a person can act on.
pub fn humanize_error(stderr: &str) -> String {
    let last = stderr
        .lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("")
        .trim();
    let s = stderr.to_lowercase();
    if s.contains("no space left") {
        "The disk is full. Free some space or choose another folder, then try again.".into()
    } else if s.contains("permission denied") {
        "Alchemist isn't allowed to write there. Choose another folder.".into()
    } else if s.contains("invalid data found") {
        "This file looks damaged or isn't a video Alchemist can read.".into()
    } else if s.contains("unknown encoder") || s.contains("encoder not found") {
        "This format needs an encoder that isn't available on this computer. Try MP4 or WebM."
            .into()
    } else if s.contains("could not find codec parameters") {
        "Alchemist couldn't understand the file's video track.".into()
    } else if last.is_empty() {
        "Something went wrong while processing the video.".into()
    } else {
        format!("Something went wrong while processing the video. Details: {last}")
    }
}

pub struct Running {
    pub child: Child,
}

/// Spawn FFmpeg with progress on stdout. `on_progress` gets seconds done.
/// Returns the stderr tail on failure, already made human.
pub fn run_with_progress(
    args: &[String],
    mut on_progress: impl FnMut(f64),
    register: impl FnOnce(u32),
    cancelled: impl Fn() -> bool,
) -> Result<(), FfError> {
    let bin = locate()?;
    let mut cmd = command(&bin);
    cmd.args([
        "-y",
        "-nostats",
        "-progress",
        "pipe:1",
        "-loglevel",
        "error",
    ])
    .args(args)
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| FfError::Spawn(e.to_string()))?;
    register(child.id());
    let stderr = child.stderr.take();
    let err_thread = std::thread::spawn(move || {
        let mut buf = String::new();
        if let Some(e) = stderr {
            for line in BufReader::new(e).lines().map_while(Result::ok) {
                buf.push_str(&line);
                buf.push('\n');
                if buf.len() > 16_000 {
                    buf.drain(..8_000);
                }
            }
        }
        buf
    });
    if let Some(out) = child.stdout.take() {
        for line in BufReader::new(out).lines().map_while(Result::ok) {
            if let Some(t) = parse_progress_line(&line) {
                on_progress(t);
            }
        }
    }
    let status = child.wait().map_err(|e| FfError::Spawn(e.to_string()))?;
    let err = err_thread.join().unwrap_or_default();
    if cancelled() {
        return Err(FfError::Cancelled);
    }
    if status.success() {
        Ok(())
    } else {
        Err(FfError::Failed(humanize_error(&err)))
    }
}

pub fn kill_pid(pid: u32) {
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .status();
    }
    #[cfg(not(windows))]
    {
        let _ = Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .status();
    }
}

/// Run FFmpeg to completion and return stderr (used for analysis filters).
pub fn run_capture_stderr(args: &[String]) -> Result<String, FfError> {
    let bin = locate()?;
    let out = command(&bin)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| FfError::Spawn(e.to_string()))?;
    let text = String::from_utf8_lossy(&out.stderr).to_string();
    if out.status.success() {
        Ok(text)
    } else {
        Err(FfError::Failed(humanize_error(&text)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'team-standup.mov':
  Metadata:
    major_brand     : qt
  Duration: 00:03:00.04, start: 0.000000, bitrate: 55123 kb/s
  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(tv, bt709, progressive), 1920x1080 [SAR 1:1 DAR 16:9], 54980 kb/s, 59.94 fps, 59.94 tbr, 60k tbn (default)
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp, 128 kb/s (default)
  Stream #0:2[0x3](eng): Audio: aac (LC), 48000 Hz, mono, fltp, 64 kb/s
  Stream #0:3[0x4](eng): Subtitle: mov_text (tx3g / 0x67337874), 0 kb/s
At least one output file must be specified"#;

    #[test]
    fn probe_parses_everything() {
        let i = parse_probe(SAMPLE);
        assert!((i.duration - 180.04).abs() < 1e-6);
        assert_eq!((i.width, i.height), (1920, 1080));
        assert_eq!(i.fps, 59.94);
        assert_eq!(i.video_codec.as_deref(), Some("h264"));
        assert_eq!(i.audio_codec.as_deref(), Some("aac"));
        assert_eq!(i.audio_streams, 2);
        assert_eq!(i.subtitle_streams, 1);
        assert_eq!(i.bitrate_kbps, Some(55123));
        assert_eq!(i.container, "mov");
        assert!(i.has_video && i.has_audio);
    }

    #[test]
    fn probe_audio_only_and_simple_stream_labels() {
        let t = "Input #0, wav, from 'a.wav':\n  Duration: 00:00:10.50, bitrate: 1411 kb/s\n  Stream #0:0: Audio: pcm_s16le ([1][0][0][0] / 0x0001), 44100 Hz, 2 channels, s16, 1411 kb/s\n";
        let i = parse_probe(t);
        assert!(!i.has_video);
        assert!(i.has_audio);
        assert_eq!(i.duration, 10.5);
        assert_eq!(i.container, "wav");
    }

    #[test]
    fn progress_lines() {
        assert_eq!(parse_progress_line("out_time_us=2500000"), Some(2.5));
        assert_eq!(parse_progress_line("out_time=00:01:02.500000"), Some(62.5));
        assert_eq!(parse_progress_line("frame=12"), None);
        assert_eq!(parse_progress_line("garbage"), None);
    }

    #[test]
    fn errors_are_human() {
        assert!(humanize_error("x\nNo space left on device").contains("disk is full"));
        assert!(humanize_error("Unknown encoder 'libfoo'").contains("encoder"));
        assert!(humanize_error("").contains("Something went wrong"));
    }

    #[test]
    fn name_lists() {
        let t = " V....D libx264              libx264 H.264\n A....D aac                  AAC\n ------\n";
        assert_eq!(parse_names(t, 1), vec!["libx264", "aac"]);
    }
}
