//! Instant replay: keep the last N seconds of the screen (and sound) in a
//! small rolling buffer, and save it to the Replays folder on a hotkey.
//!
//! Video: one FFmpeg process writes 2-second Matroska pieces that wrap
//! around (`-f segment -segment_wrap`), so disk use stays fixed. Sound: kept
//! in memory (`recorder::Ring`). Both are stamped with wall-clock time, so a
//! save joins the pieces that cover the last N seconds and cuts the sound to
//! exactly the same stretch.

use crate::ffmpeg;
use crate::recorder::{self, wall_now, AudioTrack, Preset, Ring, Source};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Length of each rolling piece, in seconds.
pub const PIECE: f64 = 2.0;
/// Longest replay we keep (10 minutes).
pub const MAX_SECONDS: u32 = 600;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReplayOptions {
    pub source: Source,
    pub seconds: u32,
    pub mic: bool,
    pub system_audio: bool,
    pub preset: Preset,
    #[serde(default)]
    pub video: Option<crate::limits::VideoSettings>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ReplayStatus {
    pub running: bool,
    pub seconds: u32,
    /// How much is buffered right now (grows to `seconds` after start).
    pub buffered: f64,
    pub notes: Vec<String>,
}

/// A running buffer. Shared (`Arc<Replay>`) so a save can run without
/// blocking status checks; `stop` can be called from anywhere, once or more.
pub struct Replay {
    child: Mutex<Child>,
    stdin: Mutex<Option<ChildStdin>>,
    dir: PathBuf,
    pub opts: ReplayOptions,
    spawned: f64,
    reported: Arc<Mutex<Option<f64>>>,
    tracks: Mutex<Vec<AudioTrack>>,
    rings: Vec<Arc<Mutex<Ring>>>,
    started: Instant,
    notes: Vec<String>,
    stopped: AtomicBool,
    /// One save at a time.
    saving: Mutex<()>,
}

/// Number of pieces kept: enough for `seconds` plus the piece being written.
pub fn pieces_for(seconds: u32) -> u32 {
    (seconds as f64 / PIECE).ceil() as u32 + 3
}

/// FFmpeg arguments for the rolling buffer.
pub fn buffer_args(
    opts: &ReplayOptions,
    caps: &ffmpeg::Capabilities,
    dir: &Path,
    os: &str,
) -> Result<Vec<String>, String> {
    let base_fps = recorder::fps_for(opts.preset);
    let target = opts.video.map(|v| crate::limits::clamp_video(v).value);
    let fps = target.map(|t| t.fps).unwrap_or(base_fps);
    let (mut a, mut vf) = recorder::capture_input(&opts.source, fps, caps, os)?;
    a.insert(0, "-thread_queue_size".into());
    a.insert(1, "512".into());
    if let Some(t) = target {
        vf.push(crate::limits::scale_filter(
            t.width,
            t.height,
            crate::limits::FitMode::Fit,
        ));
    } else {
        vf.push("scale=trunc(iw/2)*2:trunc(ih/2)*2".into());
    }
    a.extend(["-vf".into(), vf.join(",")]);
    let (mut enc, name) = recorder::capture_encoder(caps, opts.preset);
    // A keyframe at every piece boundary so pieces can be joined without re-encoding.
    let gop = ((fps * PIECE).round() as u32).max(1).to_string();
    if let Some(i) = enc.iter().position(|v| v == "-g") {
        enc[i + 1] = gop;
    }
    enc.extend([
        "-force_key_frames".into(),
        format!("expr:gte(t,n_forced*{PIECE})"),
    ]);
    if name.contains("nvenc") {
        enc.extend(["-forced-idr".into(), "1".into()]);
    }
    a.extend(enc);
    let wrap = pieces_for(opts.seconds).to_string();
    a.extend([
        "-f".into(),
        "segment".into(),
        "-segment_time".into(),
        format!("{PIECE}"),
        "-segment_wrap".into(),
        wrap.clone(),
        "-segment_list".into(),
        dir.join("pieces.csv").to_string_lossy().to_string(),
        "-segment_list_type".into(),
        "csv".into(),
        "-segment_list_size".into(),
        wrap,
        "-segment_format".into(),
        "matroska".into(),
        "-reset_timestamps".into(),
        "1".into(),
        dir.join("piece-%03d.mkv").to_string_lossy().to_string(),
    ]);
    Ok(a)
}

/// A finished or in-progress piece: file name and its start/end in stream seconds.
#[derive(Debug, Clone, PartialEq)]
pub struct Piece {
    pub file: String,
    pub start: f64,
    pub end: f64,
}

/// Read FFmpeg's piece list and add the piece being written right now.
pub fn read_pieces(csv: &str, wrap: u32, now_rel: f64) -> Vec<Piece> {
    let mut out: Vec<Piece> = csv
        .lines()
        .filter_map(|l| {
            let mut it = l.trim().rsplitn(3, ',');
            let end = it.next()?.trim().parse().ok()?;
            let start = it.next()?.trim().parse().ok()?;
            let file = it.next()?.trim().trim_matches('"').to_string();
            Some(Piece { file, start, end })
        })
        .collect();
    out.sort_by(|a, b| a.start.total_cmp(&b.start));
    let next_index = out
        .last()
        .and_then(|p| {
            p.file
                .trim_start_matches("piece-")
                .trim_end_matches(".mkv")
                .parse::<u32>()
                .ok()
        })
        .map(|i| (i + 1) % wrap.max(1))
        .unwrap_or(0);
    let start = out.last().map(|p| p.end).unwrap_or(0.0);
    if now_rel > start {
        out.push(Piece {
            file: format!("piece-{next_index:03}.mkv"),
            start,
            end: now_rel,
        });
    }
    out
}

/// Newest pieces first until they add up to `seconds`, returned oldest first.
/// `usable` says whether a piece could be read (the one still being written
/// sometimes can't); unusable pieces are skipped and older ones fill in.
pub fn pick(pieces: &[Piece], seconds: f64, mut usable: impl FnMut(&Piece) -> bool) -> Vec<Piece> {
    let mut out: Vec<Piece> = Vec::new();
    let mut total = 0.0;
    let mut seen = std::collections::HashSet::new();
    for p in pieces.iter().rev() {
        if total >= seconds - 0.05 {
            break;
        }
        // The wrap reuses names: an old entry with a name already taken is gone.
        if !seen.insert(p.file.clone()) || !usable(p) {
            continue;
        }
        total += p.end - p.start;
        out.push(p.clone());
    }
    out.reverse();
    out
}

/// Where replays are saved: the chosen folder, else Videos/Alchemist/Replays.
pub fn replays_dir(custom: Option<&str>, data_root: &Path, portable: bool) -> PathBuf {
    if let Some(c) = custom.filter(|c| !c.trim().is_empty()) {
        return PathBuf::from(c);
    }
    if portable {
        return data_root.join("Replays");
    }
    dirs::video_dir()
        .map(|v| v.join("Alchemist").join("Replays"))
        .unwrap_or_else(|| data_root.join("Replays"))
}

pub fn replay_file_name() -> String {
    chrono::Local::now()
        .format("Replay %Y-%m-%d %H-%M-%S.mp4")
        .to_string()
}

impl Replay {
    pub fn start(opts: ReplayOptions, buffer_dir: PathBuf) -> Result<Replay, String> {
        let mut opts = opts;
        opts.seconds = opts.seconds.clamp(5, MAX_SECONDS);
        let _ = std::fs::remove_dir_all(&buffer_dir);
        std::fs::create_dir_all(&buffer_dir).map_err(|e| e.to_string())?;
        let mut notes = Vec::new();
        // Sound first, so the first seconds have it.
        let keep = opts.seconds as f64 + 2.0 * PIECE + 5.0;
        let mut tracks = Vec::new();
        let mut rings = Vec::new();
        for (on, kind) in [(opts.mic, "mic"), (opts.system_audio, "system")] {
            if !on {
                continue;
            }
            let ring = Arc::new(Mutex::new(Ring::new(keep)));
            match AudioTrack::start_ring(kind, ring.clone()) {
                Ok(t) => {
                    tracks.push(t);
                    rings.push(ring);
                }
                Err(e) => notes.push(e),
            }
        }
        let finish_all = |tracks: Vec<AudioTrack>| {
            for t in tracks {
                t.finish();
            }
        };
        let prepared = (|| -> Result<(Vec<String>, PathBuf), String> {
            let caps = ffmpeg::capture_capabilities().map_err(|e| e.to_string())?;
            let args = buffer_args(&opts, &caps, &buffer_dir, recorder::current_os())?;
            let bin = ffmpeg::locate_capture().map_err(|e| e.to_string())?;
            Ok((args, bin))
        })();
        let (args, bin) = match prepared {
            Ok(v) => v,
            Err(e) => {
                finish_all(tracks);
                return Err(e);
            }
        };
        let spawned = wall_now();
        let mut child = match ffmpeg::command(&bin)
            .args(["-y", "-loglevel", "info"])
            .args(&args)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
        {
            Ok(c) => c,
            Err(e) => {
                finish_all(tracks);
                return Err(e.to_string());
            }
        };
        let stdin = child.stdin.take();
        let reported = Arc::new(Mutex::new(None));
        if let Some(err) = child.stderr.take() {
            let rep = reported.clone();
            std::thread::Builder::new()
                .name("alchemist-replay-log".into())
                .spawn(move || {
                    use std::io::{BufRead, BufReader};
                    for line in BufReader::new(err).split(b'\r').map_while(Result::ok) {
                        let l = String::from_utf8_lossy(&line);
                        for part in l.lines().filter(|p| p.contains("Duration:")) {
                            recorder::watch_start(part, &rep);
                        }
                    }
                })
                .ok();
        }
        let deadline = Instant::now() + Duration::from_millis(2000);
        loop {
            if let Ok(Some(status)) = child.try_wait() {
                finish_all(tracks);
                return Err(format!(
                    "Instant replay couldn't start screen capture (code {}).",
                    status.code().unwrap_or(-1)
                ));
            }
            if reported.lock().is_some() || Instant::now() > deadline {
                break;
            }
            std::thread::sleep(Duration::from_millis(15));
        }
        log::info!("instant replay buffering {} s", opts.seconds);
        Ok(Replay {
            child: Mutex::new(child),
            stdin: Mutex::new(stdin),
            dir: buffer_dir,
            opts,
            spawned,
            reported,
            tracks: Mutex::new(tracks),
            rings,
            started: Instant::now(),
            notes,
            stopped: AtomicBool::new(false),
            saving: Mutex::new(()),
        })
    }

    /// Wall-clock time of the buffer's first frame.
    fn first_frame(&self) -> f64 {
        match *self.reported.lock() {
            Some(t) if (t - self.spawned).abs() < 5.0 => t,
            _ => self.spawned + 0.07,
        }
    }

    pub fn status(&self) -> ReplayStatus {
        let alive = self.is_alive();
        let mut notes = self.notes.clone();
        if !alive && !self.stopped.load(Ordering::Relaxed) {
            notes.push(
                "Screen capture for instant replay stopped unexpectedly. Turn it off and on again."
                    .into(),
            );
        }
        ReplayStatus {
            running: alive,
            seconds: self.opts.seconds,
            buffered: self
                .started
                .elapsed()
                .as_secs_f64()
                .min(self.opts.seconds as f64),
            notes,
        }
    }

    /// The capture process is still running.
    pub fn is_alive(&self) -> bool {
        !self.stopped.load(Ordering::Relaxed) && matches!(self.child.lock().try_wait(), Ok(None))
    }

    /// Save the last `seconds` into `out_dir`. Returns the saved file.
    pub fn save(&self, out_dir: &Path) -> Result<PathBuf, String> {
        if !self.is_alive() {
            return Err("Instant replay isn't running.".into());
        }
        let _one = self.saving.lock();
        let now = wall_now();
        let first = self.first_frame();
        let wrap = pieces_for(self.opts.seconds);
        let csv = std::fs::read_to_string(self.dir.join("pieces.csv")).unwrap_or_default();
        let pieces = read_pieces(&csv, wrap, now - first);
        // Copy first: the buffer keeps rolling while we work.
        let work = self
            .dir
            .with_file_name(format!("replay-save-{}", (now * 1000.0) as u64));
        std::fs::create_dir_all(&work).map_err(|e| e.to_string())?;
        let result = (|| -> Result<PathBuf, String> {
            let chosen = pick(&pieces, self.opts.seconds as f64, |p| {
                let dst = work.join(&p.file);
                std::fs::copy(self.dir.join(&p.file), &dst).is_ok()
                    && ffmpeg::probe(&dst)
                        .map(|i| i.duration > 0.0)
                        .unwrap_or(false)
            });
            if chosen.is_empty() {
                return Err("Instant replay is still starting. Try again in a moment.".into());
            }
            let list: String = chosen
                .iter()
                .map(|p| format!("file '{}'\n", p.file))
                .collect();
            std::fs::write(work.join("list.txt"), list).map_err(|e| e.to_string())?;
            let joined = work.join("joined.mkv");
            ffmpeg::run_capture_stderr(&[
                "-y".into(),
                "-f".into(),
                "concat".into(),
                "-safe".into(),
                "0".into(),
                "-i".into(),
                work.join("list.txt").to_string_lossy().to_string(),
                "-c".into(),
                "copy".into(),
                joined.to_string_lossy().to_string(),
            ])
            .map_err(|e| e.to_string())?;
            let dur = ffmpeg::probe(&joined).map(|i| i.duration).unwrap_or(0.0);
            let v0 = first + chosen[0].start;
            // Sound for exactly the same stretch.
            let mut audio = Vec::new();
            for (i, ring) in self.rings.iter().enumerate() {
                let r = ring.lock();
                if r.rate == 0 {
                    continue;
                }
                let samples = r.extract(v0, v0 + dur);
                let spec = hound::WavSpec {
                    channels: r.channels.max(1),
                    sample_rate: r.rate,
                    bits_per_sample: 16,
                    sample_format: hound::SampleFormat::Int,
                };
                drop(r);
                let path = work.join(format!("sound-{i}.wav"));
                let mut w = hound::WavWriter::create(&path, spec).map_err(|e| e.to_string())?;
                for v in samples {
                    w.write_sample(v).map_err(|e| e.to_string())?;
                }
                w.finalize().map_err(|e| e.to_string())?;
                audio.push(path);
            }
            std::fs::create_dir_all(out_dir).map_err(|e| e.to_string())?;
            let out = unique(out_dir.join(replay_file_name()));
            let mut args: Vec<String> = vec![
                "-y".into(),
                "-i".into(),
                joined.to_string_lossy().to_string(),
            ];
            for a in &audio {
                args.extend(["-i".into(), a.to_string_lossy().to_string()]);
            }
            match audio.len() {
                0 => args.extend(["-map".into(), "0:v".into(), "-c:v".into(), "copy".into()]),
                1 => args.extend([
                    "-map".into(),
                    "0:v".into(),
                    "-map".into(),
                    "1:a".into(),
                    "-c:v".into(),
                    "copy".into(),
                    "-c:a".into(),
                    "aac".into(),
                    "-b:a".into(),
                    "160k".into(),
                ]),
                n => {
                    let ins: String = (1..=n).map(|i| format!("[{i}:a]")).collect();
                    args.extend([
                        "-filter_complex".into(),
                        format!("{ins}amix=inputs={n}:normalize=0:duration=first[a]"),
                        "-map".into(),
                        "0:v".into(),
                        "-map".into(),
                        "[a]".into(),
                        "-c:v".into(),
                        "copy".into(),
                        "-c:a".into(),
                        "aac".into(),
                        "-b:a".into(),
                        "160k".into(),
                    ]);
                }
            }
            args.extend([
                "-movflags".into(),
                "+faststart".into(),
                out.to_string_lossy().to_string(),
            ]);
            ffmpeg::run_capture_stderr(&args).map_err(|e| e.to_string())?;
            Ok(out)
        })();
        let _ = std::fs::remove_dir_all(&work);
        result
    }

    /// Stop capturing and delete the buffer. Safe to call more than once.
    pub fn stop(&self) {
        if self.stopped.swap(true, Ordering::Relaxed) {
            return;
        }
        if let Some(mut i) = self.stdin.lock().take() {
            let _ = i.write_all(b"q");
            let _ = i.flush();
        }
        let deadline = Instant::now() + Duration::from_secs(4);
        let mut child = self.child.lock();
        while matches!(child.try_wait(), Ok(None)) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = child.kill();
        let _ = child.wait();
        drop(child);
        for t in self.tracks.lock().drain(..) {
            t.finish();
        }
        // Wait for a save in progress before removing its source files.
        let _one = self.saving.lock();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

impl Drop for Replay {
    fn drop(&mut self) {
        self.stop();
    }
}

/// `name.mp4`, or `name (2).mp4` if that exists.
fn unique(p: PathBuf) -> PathBuf {
    if !p.exists() {
        return p;
    }
    let stem = p
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let ext = p
        .extension()
        .map(|e| e.to_string_lossy().to_string())
        .unwrap_or_default();
    for i in 2.. {
        let c = p.with_file_name(format!("{stem} ({i}).{ext}"));
        if !c.exists() {
            return c;
        }
    }
    p
}

/// Clamp a requested replay length to what's allowed.
pub fn clamp_seconds(s: u32) -> u32 {
    s.clamp(5, MAX_SECONDS)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn caps() -> ffmpeg::Capabilities {
        let mut c = ffmpeg::Capabilities::default();
        c.encoders.push("libx264".into());
        c
    }

    #[test]
    fn buffer_rolls_two_second_pieces() {
        let o = ReplayOptions {
            source: Source::Screen {
                index: 0,
                x: 0,
                y: 0,
                width: 1920,
                height: 1080,
            },
            seconds: 30,
            mic: false,
            system_audio: false,
            preset: Preset::Tutorial,
            video: None,
        };
        let a = buffer_args(&o, &caps(), Path::new("buf"), "windows")
            .unwrap()
            .join(" ");
        assert!(a.contains("-f segment -segment_time 2 -segment_wrap 18"));
        assert!(a.contains("-g 60"));
        assert!(a.contains("-framerate 30"));
        assert!(a.contains("-reset_timestamps 1"));
        assert!(a.contains("-draw_mouse 1"));
        assert!(a.ends_with("piece-%03d.mkv"));
        assert_eq!(pieces_for(30), 18);
    }

    #[test]
    fn buffer_rolls_with_custom_framerate() {
        let o = ReplayOptions {
            source: Source::Screen {
                index: 0,
                x: 0,
                y: 0,
                width: 1920,
                height: 1080,
            },
            seconds: 60,
            mic: false,
            system_audio: false,
            preset: Preset::High,
            video: Some(crate::limits::VideoSettings {
                width: 2560,
                height: 1440,
                fps: 144.0,
            }),
        };
        let a = buffer_args(&o, &caps(), Path::new("buf"), "windows")
            .unwrap()
            .join(" ");
        assert!(a.contains("-framerate 144"));
        assert!(a.contains("-g 288"));
        assert!(a.contains("scale=2560:1440"));
        assert_eq!(pieces_for(60), 33);
    }

    #[test]
    fn picks_pieces_covering_the_last_seconds() {
        let csv = "piece-003.mkv,6.000000,8.000000\npiece-001.mkv,2.000000,4.000000\npiece-002.mkv,4.000000,6.000000\n";
        let p = read_pieces(csv, 5, 9.2);
        assert_eq!(
            p.last().unwrap(),
            &Piece {
                file: "piece-004.mkv".into(),
                start: 8.0,
                end: 9.2
            }
        );
        let k = pick(&p, 5.0, |_| true);
        assert_eq!(
            k.iter().map(|p| p.file.as_str()).collect::<Vec<_>>(),
            ["piece-002.mkv", "piece-003.mkv", "piece-004.mkv"]
        );
        // The piece being written can't be read: an older one fills in, so
        // the replay is still at least as long as asked.
        let k = pick(&p, 5.0, |p| p.file != "piece-004.mkv");
        assert_eq!(
            k.iter().map(|p| p.file.as_str()).collect::<Vec<_>>(),
            ["piece-001.mkv", "piece-002.mkv", "piece-003.mkv"]
        );
        assert!(pick(&p, 5.0, |_| false).is_empty());
        // Wraps back to 000 after the last index.
        let w = read_pieces("piece-004.mkv,8.0,10.0\n", 5, 10.5);
        assert_eq!(w.last().unwrap().file, "piece-000.mkv");
        assert!(read_pieces("", 5, 0.0).is_empty());
        assert_eq!(read_pieces("", 5, 1.0)[0].file, "piece-000.mkv");
    }

    #[test]
    fn replays_go_to_their_own_folder() {
        let d = replays_dir(None, Path::new("data"), true);
        assert_eq!(d, Path::new("data").join("Replays"));
        assert_eq!(
            replays_dir(Some("X:/clips"), Path::new("data"), false),
            PathBuf::from("X:/clips")
        );
        let n = replay_file_name();
        assert!(n.starts_with("Replay ") && n.ends_with(".mp4"));
        assert_eq!(clamp_seconds(1), 5);
        assert_eq!(clamp_seconds(10_000), 600);
    }
}
