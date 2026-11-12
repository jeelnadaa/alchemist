//! Screen recorder.
//!
//! Design (PLAN.md section 3):
//! - Video is captured and encoded by a separate FFmpeg process using the
//!   platform's capture path, hardware encoder first. It never touches the
//!   editor, so recording stays light.
//! - Microphone and computer sound are written as separate WAV tracks.
//! - Cursor, clicks, scrolls and (optionally) keys are written to a sidecar
//!   file, so effects like auto-zoom are applied later and never baked in.
//! - Everything is written continuously: Matroska clusters every second and
//!   WAV headers updated every second, so a crash loses about a second.
//! - Pause starts a new segment; stop joins segments without re-encoding.

use crate::convert::null_sink;
use crate::ffmpeg::{self, Capabilities, FfError};
use crate::limits::{self, VideoSettings};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Source {
    /// A whole monitor; x/y/width/height are its desktop rectangle in physical pixels.
    #[serde(rename_all = "camelCase")]
    Screen {
        index: u32,
        x: i32,
        y: i32,
        width: u32,
        height: u32,
    },
    /// A window by title (Windows); elsewhere the UI sends its rectangle as an Area.
    #[serde(rename_all = "camelCase")]
    Window { title: String },
    #[serde(rename_all = "camelCase")]
    Area {
        x: i32,
        y: i32,
        width: u32,
        height: u32,
        screen_index: u32,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Preset {
    Tutorial,
    High,
    Tiny,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordOptions {
    pub source: Source,
    pub mic: bool,
    pub system_audio: bool,
    pub camera: bool,
    pub preset: Preset,
    /// Optional custom output size/fps; clamped to the hard limits.
    pub video: Option<VideoSettings>,
    pub record_keys: bool,
    pub auto_stop_seconds: Option<u64>,
    pub auto_stop_mb: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub id: String,
    pub started_unix: u64,
    pub state: String,
    pub source: Option<Source>,
    pub fps: f64,
    pub segments: Vec<String>,
    pub video: Option<String>,
    pub mic: Option<String>,
    pub system_audio: Option<String>,
    pub camera: Option<String>,
    pub events: Option<String>,
    pub duration: f64,
    pub dropped_frames: u64,
    pub bytes: u64,
    pub encoder: String,
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub recording: bool,
    pub paused: bool,
    pub seconds: f64,
    pub bytes: u64,
    pub dropped_frames: u64,
    pub free_bytes: Option<u64>,
    pub warning: Option<String>,
    pub mic_level: f32,
}

pub fn fps_for(preset: Preset) -> f64 {
    match preset {
        Preset::Tutorial => 30.0,
        Preset::High => 60.0,
        Preset::Tiny => 24.0,
    }
}

fn s(v: &str) -> String {
    v.to_string()
}

/// Encoder settings for live capture: hardware first, light software fallback.
pub fn capture_encoder(caps: &Capabilities, preset: Preset) -> (Vec<String>, String) {
    let gop = "120";
    if let Some(hw) = &caps.hw_h264 {
        let rate = match preset {
            Preset::Tiny => "2500k",
            Preset::Tutorial => "8000k",
            Preset::High => "16000k",
        };
        let mut a = vec![s("-c:v"), hw.clone(), s("-b:v"), s(rate), s("-g"), s(gop)];
        if hw.contains("nvenc") {
            a.extend([s("-preset"), s("p1"), s("-tune"), s("ll")]);
        }
        if hw.contains("qsv") {
            a.extend([s("-preset"), s("veryfast")]);
        }
        if hw.contains("amf") {
            a.extend([s("-quality"), s("speed")]);
        }
        a.extend([s("-pix_fmt"), s("yuv420p")]);
        return (a, hw.clone());
    }
    let crf = match preset {
        Preset::Tiny => "32",
        Preset::Tutorial => "24",
        Preset::High => "20",
    };
    let enc = if caps.has_encoder("libx264") {
        "libx264"
    } else {
        "mpeg4"
    };
    let mut a = vec![s("-c:v"), s(enc)];
    if enc == "libx264" {
        a.extend([
            s("-preset"),
            s("ultrafast"),
            s("-tune"),
            s("zerolatency"),
            s("-crf"),
            s(crf),
        ]);
    } else {
        a.extend([s("-q:v"), s("5")]);
    }
    a.extend([s("-g"), s(gop), s("-pix_fmt"), s("yuv420p")]);
    (a, enc.into())
}

/// Platform capture input arguments.
pub fn capture_input(
    src: &Source,
    fps: f64,
    caps: &Capabilities,
    os: &str,
) -> Result<(Vec<String>, Vec<String>), String> {
    let r = limits::fps_to_ffmpeg(fps);
    let mut filters = Vec::new();
    let input = match os {
        "windows" => {
            let mut a = vec![
                s("-f"),
                s("gdigrab"),
                s("-framerate"),
                r.clone(),
                s("-draw_mouse"),
                s("1"),
            ];
            match src {
                Source::Screen {
                    x,
                    y,
                    width,
                    height,
                    ..
                }
                | Source::Area {
                    x,
                    y,
                    width,
                    height,
                    ..
                } => {
                    a.extend([
                        s("-offset_x"),
                        x.to_string(),
                        s("-offset_y"),
                        y.to_string(),
                        s("-video_size"),
                        format!("{}x{}", even(*width), even(*height)),
                        s("-i"),
                        s("desktop"),
                    ]);
                }
                Source::Window { title } => a.extend([s("-i"), format!("title={title}")]),
            }
            a
        }
        "macos" => {
            let idx = match src {
                Source::Screen { index, .. } => *index,
                Source::Area { screen_index, .. } => *screen_index,
                Source::Window { .. } => return Err("Recording a single window isn't available on macOS yet. Choose Area and drag around the window.".into()),
            };
            if let Source::Area {
                x,
                y,
                width,
                height,
                ..
            } = src
            {
                filters.push(format!(
                    "crop={}:{}:{}:{}",
                    even(*width),
                    even(*height),
                    x.max(&0),
                    y.max(&0)
                ));
            }
            vec![
                s("-f"),
                s("avfoundation"),
                s("-capture_cursor"),
                s("1"),
                s("-framerate"),
                r.clone(),
                s("-pixel_format"),
                s("uyvy422"),
                s("-i"),
                format!("Capture screen {idx}:none"),
            ]
        }
        _ => {
            if !caps.has_device("x11grab") {
                return Err("Screen recording on Linux needs an FFmpeg with X11 capture. Install your distribution's ffmpeg package and restart Alchemist.".into());
            }
            let display = std::env::var("DISPLAY").unwrap_or_else(|_| ":0".into());
            match src {
                Source::Screen {
                    x,
                    y,
                    width,
                    height,
                    ..
                }
                | Source::Area {
                    x,
                    y,
                    width,
                    height,
                    ..
                } => vec![
                    s("-f"),
                    s("x11grab"),
                    s("-framerate"),
                    r.clone(),
                    s("-draw_mouse"),
                    s("1"),
                    s("-video_size"),
                    format!("{}x{}", even(*width), even(*height)),
                    s("-i"),
                    format!("{display}+{x},{y}"),
                ],
                Source::Window { .. } => return Err(
                    "Recording a single window isn't available on Linux yet. Choose Area instead."
                        .into(),
                ),
            }
        }
    };
    Ok((input, filters))
}

fn even(v: u32) -> u32 {
    (v / 2 * 2).max(2)
}

pub fn current_os() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

/// Full FFmpeg arguments for one video segment.
pub fn segment_args(
    opts: &RecordOptions,
    caps: &Capabilities,
    out: &Path,
    os: &str,
) -> Result<(Vec<String>, String), String> {
    let base_fps = fps_for(opts.preset);
    let target = opts.video.map(|v| limits::clamp_video(v).value);
    let fps = target.map(|t| t.fps).unwrap_or(base_fps);
    let (mut a, mut vf) = capture_input(&opts.source, fps, caps, os)?;
    a.insert(0, s("-thread_queue_size"));
    a.insert(1, s("512"));
    if let Some(t) = target {
        vf.push(limits::scale_filter(
            t.width,
            t.height,
            limits::FitMode::Fit,
        ));
    } else {
        vf.push(s("scale=trunc(iw/2)*2:trunc(ih/2)*2"));
    }
    a.extend([s("-vf"), vf.join(",")]);
    let (enc, name) = capture_encoder(caps, opts.preset);
    a.extend(enc);
    // Matroska with frequent clusters: a crash loses about a second.
    a.extend([
        s("-f"),
        s("matroska"),
        s("-cluster_time_limit"),
        s("1000"),
        s("-flush_packets"),
        s("1"),
    ]);
    a.push(out.to_string_lossy().to_string());
    Ok((a, name))
}

// ---------------------------------------------------------------- audio tracks

struct AudioTrack {
    stop: Arc<AtomicBool>,
    paused: Arc<AtomicBool>,
    level: Arc<AtomicU64>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl AudioTrack {
    /// Start capturing `device_kind` ("mic" or "system") into a WAV file.
    fn start(kind: &'static str, path: PathBuf) -> Result<AudioTrack, String> {
        let stop = Arc::new(AtomicBool::new(false));
        let paused = Arc::new(AtomicBool::new(false));
        let level = Arc::new(AtomicU64::new(0));
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), String>>();
        let (st, pa, lv) = (stop.clone(), paused.clone(), level.clone());
        let thread = std::thread::Builder::new()
            .name(format!("alchemist-audio-{kind}"))
            .spawn(move || {
                // cpal streams are not Send on every platform, so they live on this thread.
                let host = cpal::default_host();
                let device = if kind == "mic" {
                    host.default_input_device()
                } else if cfg!(windows) {
                    // WASAPI loopback: an input stream on the output device.
                    host.default_output_device()
                } else {
                    host.input_devices().ok().and_then(|mut it| {
                        it.find(|d| {
                            d.name()
                                .map(|n| n.to_lowercase().contains("monitor"))
                                .unwrap_or(false)
                        })
                    })
                };
                let Some(device) = device else {
                    let _ = ready_tx.send(Err(if kind == "mic" {
                        "No microphone was found.".into()
                    } else {
                        "Recording computer sound isn't available on this system.".into()
                    }));
                    return;
                };
                let config = if kind == "mic" || !cfg!(windows) {
                    device.default_input_config()
                } else {
                    device.default_output_config()
                };
                let config = match config {
                    Ok(c) => c,
                    Err(e) => {
                        let _ = ready_tx.send(Err(format!(
                            "Couldn't open the {}: {e}",
                            if kind == "mic" {
                                "microphone"
                            } else {
                                "computer sound"
                            }
                        )));
                        return;
                    }
                };
                let spec = hound::WavSpec {
                    channels: config.channels(),
                    sample_rate: config.sample_rate().0,
                    bits_per_sample: 16,
                    sample_format: hound::SampleFormat::Int,
                };
                let writer = match hound::WavWriter::create(&path, spec) {
                    Ok(w) => Arc::new(Mutex::new(Some(w))),
                    Err(e) => {
                        let _ = ready_tx.send(Err(e.to_string()));
                        return;
                    }
                };
                let w2 = writer.clone();
                let (pa2, lv2) = (pa.clone(), lv.clone());
                let write = move |samples: &mut dyn Iterator<Item = i16>| {
                    if pa2.load(Ordering::Relaxed) {
                        return;
                    }
                    let mut peak: i32 = 0;
                    if let Some(w) = w2.lock().as_mut() {
                        for v in samples {
                            peak = peak.max((v as i32).abs());
                            let _ = w.write_sample(v);
                        }
                    }
                    lv2.store(peak as u64, Ordering::Relaxed);
                };
                let err_fn = |e| log::warn!("audio stream error: {e}");
                let sc: cpal::StreamConfig = config.clone().into();
                let stream = match config.sample_format() {
                    cpal::SampleFormat::F32 => {
                        let wr = write;
                        device.build_input_stream(
                            &sc,
                            move |d: &[f32], _: &_| {
                                wr(&mut d
                                    .iter()
                                    .map(|v| (v.clamp(-1.0, 1.0) * i16::MAX as f32) as i16))
                            },
                            err_fn,
                            None,
                        )
                    }
                    cpal::SampleFormat::I16 => {
                        let wr = write;
                        device.build_input_stream(
                            &sc,
                            move |d: &[i16], _: &_| wr(&mut d.iter().copied()),
                            err_fn,
                            None,
                        )
                    }
                    cpal::SampleFormat::U16 => {
                        let wr = write;
                        device.build_input_stream(
                            &sc,
                            move |d: &[u16], _: &_| {
                                wr(&mut d.iter().map(|v| (*v as i32 - 32768) as i16))
                            },
                            err_fn,
                            None,
                        )
                    }
                    other => {
                        let _ = ready_tx.send(Err(format!("Unsupported audio format {other:?}")));
                        return;
                    }
                };
                let stream = match stream.and_then(|s| {
                    s.play()
                        .map(|_| s)
                        .map_err(|e| cpal::BuildStreamError::BackendSpecific {
                            err: cpal::BackendSpecificError {
                                description: e.to_string(),
                            },
                        })
                }) {
                    Ok(s) => s,
                    Err(e) => {
                        let _ = ready_tx.send(Err(format!("Couldn't start audio: {e}")));
                        return;
                    }
                };
                let _ = ready_tx.send(Ok(()));
                // Flush every second: the WAV header stays valid if we crash.
                while !st.load(Ordering::Relaxed) {
                    std::thread::sleep(Duration::from_millis(1000));
                    if let Some(w) = writer.lock().as_mut() {
                        let _ = w.flush();
                    }
                }
                drop(stream);
                let finished = writer.lock().take();
                if let Some(w) = finished {
                    let _ = w.finalize();
                }
            })
            .map_err(|e| e.to_string())?;
        match ready_rx.recv_timeout(Duration::from_secs(5)) {
            Ok(Ok(())) => Ok(AudioTrack {
                stop,
                paused,
                level,
                thread: Some(thread),
            }),
            Ok(Err(e)) => Err(e),
            Err(_) => Err("The audio device didn't respond.".into()),
        }
    }

    fn finish(mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

// ---------------------------------------------------------------- input sidecar

/// Records cursor, clicks, scrolls and optionally keys with timestamps.
/// rdev's listener can't be stopped, so it runs once for the app lifetime
/// and writes only while a recording is active.
struct EventSink {
    file: Option<std::fs::File>,
    start: Instant,
    keys: bool,
    last_move: Instant,
    paused: bool,
    offset: f64,
}

static EVENTS: once_cell::sync::Lazy<Mutex<Option<EventSink>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(None));
static LISTENER: std::sync::Once = std::sync::Once::new();

fn ensure_listener() {
    LISTENER.call_once(|| {
        std::thread::Builder::new()
            .name("alchemist-input".into())
            .spawn(|| {
                let _ = rdev::listen(|ev| {
                    let mut g = EVENTS.lock();
                    let Some(sink) = g.as_mut() else { return };
                    if sink.paused {
                        return;
                    }
                    let t = sink.offset + sink.start.elapsed().as_secs_f64();
                    let line = match ev.event_type {
                        rdev::EventType::MouseMove { x, y } => {
                            if sink.last_move.elapsed() < Duration::from_millis(33) {
                                return;
                            }
                            sink.last_move = Instant::now();
                            format!(r#"{{"t":{t:.3},"type":"move","x":{x:.0},"y":{y:.0}}}"#)
                        }
                        rdev::EventType::ButtonPress(b) => {
                            format!(r#"{{"t":{t:.3},"type":"click","button":"{b:?}"}}"#)
                        }
                        rdev::EventType::Wheel { delta_x, delta_y } => format!(
                            r#"{{"t":{t:.3},"type":"scroll","dx":{delta_x},"dy":{delta_y}}}"#
                        ),
                        rdev::EventType::KeyPress(k) if sink.keys => {
                            format!(r#"{{"t":{t:.3},"type":"key","key":"{k:?}"}}"#)
                        }
                        _ => return,
                    };
                    if let Some(f) = sink.file.as_mut() {
                        let _ = writeln!(f, "{line}");
                    }
                });
            })
            .ok();
    });
}

// ---------------------------------------------------------------- session

struct Segment {
    child: Child,
    stdin: Option<ChildStdin>,
    path: PathBuf,
}

pub struct Session {
    dir: PathBuf,
    opts: RecordOptions,
    manifest: Manifest,
    segment: Option<Segment>,
    mic: Option<AudioTrack>,
    system: Option<AudioTrack>,
    camera: Option<Segment>,
    started: Instant,
    paused_total: f64,
    paused_at: Option<Instant>,
    dropped: Arc<AtomicU64>,
}

pub struct Recorder {
    session: Mutex<Option<Session>>,
    root: PathBuf,
}

impl Recorder {
    pub fn new(root: PathBuf) -> Self {
        Recorder {
            session: Mutex::new(None),
            root,
        }
    }

    pub fn is_recording(&self) -> bool {
        self.session.lock().is_some()
    }

    fn spawn_segment(
        &self,
        opts: &RecordOptions,
        path: &Path,
        dropped: Arc<AtomicU64>,
    ) -> Result<(Segment, String), FfError> {
        let caps = ffmpeg::capture_capabilities()?;
        let (args, enc) = segment_args(opts, &caps, path, current_os()).map_err(FfError::Failed)?;
        let bin = ffmpeg::locate_capture()?;
        let mut cmd = ffmpeg::command(&bin);
        cmd.args(["-y", "-loglevel", "info"])
            .args(&args)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        let mut child = cmd.spawn().map_err(|e| FfError::Spawn(e.to_string()))?;
        let stdin = child.stdin.take();
        if let Some(err) = child.stderr.take() {
            std::thread::spawn(move || {
                let re = regex::Regex::new(r"drop=\s*(\d+)").unwrap();
                let mut tail = String::new();
                for line in BufReader::new(err).split(b'\r').map_while(Result::ok) {
                    let l = String::from_utf8_lossy(&line);
                    if let Some(c) = re.captures(&l) {
                        dropped.store(c[1].parse().unwrap_or(0), Ordering::Relaxed);
                    }
                    tail.push_str(&l);
                    if tail.len() > 8000 {
                        tail.drain(..4000);
                    }
                }
                log::info!("capture ended: {}", tail.lines().last().unwrap_or(""));
            });
        }
        // Fail fast if FFmpeg can't open the capture device.
        std::thread::sleep(Duration::from_millis(600));
        if let Ok(Some(status)) = child.try_wait() {
            return Err(FfError::Failed(format!(
                "Screen capture couldn't start (code {}). Check that Alchemist is allowed to record the screen.",
                status.code().unwrap_or(-1)
            )));
        }
        Ok((
            Segment {
                child,
                stdin,
                path: path.to_path_buf(),
            },
            enc,
        ))
    }

    fn spawn_camera(&self, path: &Path) -> Option<Segment> {
        let caps = ffmpeg::capture_capabilities().ok()?;
        let bin = ffmpeg::locate_capture().ok()?;
        let input: Vec<String> = match current_os() {
            "windows" => {
                let name = list_cameras_windows(&bin).into_iter().next()?;
                vec![s("-f"), s("dshow"), s("-i"), format!("video={name}")]
            }
            "macos" => vec![
                s("-f"),
                s("avfoundation"),
                s("-framerate"),
                s("30"),
                s("-i"),
                s("0:none"),
            ],
            _ => vec![s("-f"), s("v4l2"), s("-i"), s("/dev/video0")],
        };
        let (enc, _) = capture_encoder(&caps, Preset::Tutorial);
        let mut cmd = ffmpeg::command(&bin);
        cmd.args(["-y", "-loglevel", "error"])
            .args(&input)
            .args(["-vf", "scale=-2:720"])
            .args(&enc)
            .args(["-f", "matroska", "-cluster_time_limit", "1000"])
            .arg(path);
        let mut child = cmd
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .ok()?;
        let stdin = child.stdin.take();
        Some(Segment {
            child,
            stdin,
            path: path.to_path_buf(),
        })
    }

    pub fn start(&self, opts: RecordOptions) -> Result<Manifest, String> {
        let mut g = self.session.lock();
        if g.is_some() {
            return Err("Already recording.".into());
        }
        if let Some(free) = crate::disk::free_bytes(&self.root) {
            if free < 500 * 1024 * 1024 {
                return Err(
                    "Less than 500 MB of disk space is free. Free some space before recording."
                        .into(),
                );
            }
        }
        let started_unix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let id = format!("recording-{started_unix}");
        let dir = self.root.join(&id);
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let mut manifest = Manifest {
            id,
            started_unix,
            state: "recording".into(),
            source: Some(opts.source.clone()),
            fps: fps_for(opts.preset),
            ..Default::default()
        };
        if let Some(v) = opts.video {
            manifest.fps = limits::clamp_video(v).value.fps;
        }

        let dropped = Arc::new(AtomicU64::new(0));
        let seg_path = dir.join("screen-001.mkv");
        let (segment, enc) = self
            .spawn_segment(&opts, &seg_path, dropped.clone())
            .map_err(|e| e.to_string())?;
        manifest.encoder = enc;
        manifest.segments.push("screen-001.mkv".into());

        let mic = if opts.mic {
            match AudioTrack::start("mic", dir.join("mic.wav")) {
                Ok(t) => {
                    manifest.mic = Some("mic.wav".into());
                    Some(t)
                }
                Err(e) => {
                    manifest.notes.push(e);
                    None
                }
            }
        } else {
            None
        };
        let system = if opts.system_audio {
            match AudioTrack::start("system", dir.join("system.wav")) {
                Ok(t) => {
                    manifest.system_audio = Some("system.wav".into());
                    Some(t)
                }
                Err(e) => {
                    manifest.notes.push(e);
                    None
                }
            }
        } else {
            None
        };
        let camera = if opts.camera {
            let c = self.spawn_camera(&dir.join("camera.mkv"));
            if c.is_some() {
                manifest.camera = Some("camera.mkv".into());
            } else {
                manifest
                    .notes
                    .push("No camera was found, so the recording has no camera bubble.".into());
            }
            c
        } else {
            None
        };

        ensure_listener();
        if let Ok(f) = std::fs::File::create(dir.join("events.jsonl")) {
            manifest.events = Some("events.jsonl".into());
            *EVENTS.lock() = Some(EventSink {
                file: Some(f),
                start: Instant::now(),
                keys: opts.record_keys,
                last_move: Instant::now(),
                paused: false,
                offset: 0.0,
            });
        }

        write_manifest(&dir, &manifest);
        let session = Session {
            dir,
            opts,
            manifest: manifest.clone(),
            segment: Some(segment),
            mic,
            system,
            camera,
            started: Instant::now(),
            paused_total: 0.0,
            paused_at: None,
            dropped,
        };
        *g = Some(session);
        Ok(manifest)
    }

    pub fn pause(&self) -> Result<(), String> {
        let mut g = self.session.lock();
        let s = g.as_mut().ok_or("Not recording.")?;
        if s.paused_at.is_some() {
            return Ok(());
        }
        if let Some(seg) = s.segment.take() {
            stop_segment(seg);
        }
        for t in [&s.mic, &s.system].into_iter().flatten() {
            t.paused.store(true, Ordering::Relaxed);
        }
        if let Some(e) = EVENTS.lock().as_mut() {
            e.paused = true;
        }
        s.paused_at = Some(Instant::now());
        Ok(())
    }

    pub fn resume(&self) -> Result<(), String> {
        let mut g = self.session.lock();
        let s = g.as_mut().ok_or("Not recording.")?;
        let Some(at) = s.paused_at.take() else {
            return Ok(());
        };
        s.paused_total += at.elapsed().as_secs_f64();
        let name = format!("screen-{:03}.mkv", s.manifest.segments.len() + 1);
        let (seg, _) = self
            .spawn_segment(&s.opts, &s.dir.join(&name), s.dropped.clone())
            .map_err(|e| e.to_string())?;
        s.segment = Some(seg);
        s.manifest.segments.push(name);
        for t in [&s.mic, &s.system].into_iter().flatten() {
            t.paused.store(false, Ordering::Relaxed);
        }
        if let Some(e) = EVENTS.lock().as_mut() {
            e.paused = false;
        }
        write_manifest(&s.dir, &s.manifest);
        Ok(())
    }

    pub fn status(&self) -> Option<Status> {
        let g = self.session.lock();
        let s = g.as_ref()?;
        let paused_now = s
            .paused_at
            .map(|a| a.elapsed().as_secs_f64())
            .unwrap_or(0.0);
        let seconds = s.started.elapsed().as_secs_f64() - s.paused_total - paused_now;
        let bytes: u64 = std::fs::read_dir(&s.dir)
            .map(|rd| {
                rd.filter_map(Result::ok)
                    .filter_map(|e| e.metadata().ok())
                    .map(|m| m.len())
                    .sum()
            })
            .unwrap_or(0);
        let free = crate::disk::free_bytes(&s.dir);
        let mut warning = None;
        if let Some(f) = free {
            if f < 1024 * 1024 * 1024 {
                warning = Some(format!("Only {} MB of disk space left.", f / 1024 / 1024));
            }
        }
        let dropped = s.dropped.load(Ordering::Relaxed);
        if dropped > 30 && warning.is_none() {
            warning = Some(format!(
                "{dropped} frames dropped. Try the Tutorial preset or close heavy apps."
            ));
        }
        let level = s
            .mic
            .as_ref()
            .map(|m| m.level.load(Ordering::Relaxed) as f32 / i16::MAX as f32)
            .unwrap_or(0.0);
        Some(Status {
            recording: true,
            paused: s.paused_at.is_some(),
            seconds,
            bytes,
            dropped_frames: dropped,
            free_bytes: free,
            warning,
            mic_level: level,
        })
    }

    /// Should auto-stop fire? Checked by the app's timer.
    pub fn auto_stop_due(&self) -> bool {
        let st = match self.status() {
            Some(s) => s,
            None => return false,
        };
        let g = self.session.lock();
        let Some(s) = g.as_ref() else { return false };
        let by_time = s
            .opts
            .auto_stop_seconds
            .map(|t| st.seconds >= t as f64)
            .unwrap_or(false);
        let by_size = s
            .opts
            .auto_stop_mb
            .map(|mb| st.bytes >= mb * 1024 * 1024)
            .unwrap_or(false);
        let disk = st
            .free_bytes
            .map(|f| f < 200 * 1024 * 1024)
            .unwrap_or(false);
        by_time || by_size || disk
    }

    pub fn cancel(&self) -> Result<(), String> {
        let dir = self.stop_inner()?.0;
        let _ = std::fs::remove_dir_all(dir);
        Ok(())
    }

    fn stop_inner(&self) -> Result<(PathBuf, Manifest, f64), String> {
        let mut s = self.session.lock().take().ok_or("Not recording.")?;
        let paused_now = s
            .paused_at
            .map(|a| a.elapsed().as_secs_f64())
            .unwrap_or(0.0);
        let seconds = s.started.elapsed().as_secs_f64() - s.paused_total - paused_now;
        if let Some(seg) = s.segment.take() {
            stop_segment(seg);
        }
        if let Some(c) = s.camera.take() {
            stop_segment(c);
        }
        if let Some(m) = s.mic.take() {
            m.finish();
        }
        if let Some(m) = s.system.take() {
            m.finish();
        }
        *EVENTS.lock() = None;
        Ok((s.dir, s.manifest, seconds))
    }

    /// Stop, join segments without re-encoding and write the final manifest.
    pub fn stop(&self) -> Result<Manifest, String> {
        let dropped_ref = self
            .session
            .lock()
            .as_ref()
            .map(|s| s.dropped.load(Ordering::Relaxed))
            .unwrap_or(0);
        let (dir, mut m, seconds) = self.stop_inner()?;
        finalize(&dir, &mut m).map_err(|e| e.to_string())?;
        m.duration = seconds.max(m.duration);
        m.dropped_frames = dropped_ref;
        write_manifest(&dir, &m);
        Ok(m)
    }
}

fn stop_segment(mut seg: Segment) {
    // 'q' lets FFmpeg finish the file cleanly; kill if it doesn't within 5 s.
    if let Some(mut i) = seg.stdin.take() {
        let _ = i.write_all(b"q");
        let _ = i.flush();
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match seg.child.try_wait() {
            Ok(Some(_)) => break,
            _ if Instant::now() > deadline => {
                let _ = seg.child.kill();
                let _ = seg.child.wait();
                break;
            }
            _ => std::thread::sleep(Duration::from_millis(50)),
        }
    }
    log::info!("segment closed: {}", seg.path.display());
}

pub fn write_manifest(dir: &Path, m: &Manifest) {
    if let Ok(t) = serde_json::to_string_pretty(m) {
        let tmp = dir.join("recording.json.tmp");
        if std::fs::write(&tmp, t).is_ok() {
            let _ = std::fs::rename(&tmp, dir.join("recording.json"));
        }
    }
}

/// Join segments (stream copy) into `screen.mkv` and record final sizes.
pub fn finalize(dir: &Path, m: &mut Manifest) -> Result<(), FfError> {
    let existing: Vec<String> = m
        .segments
        .iter()
        .filter(|s| {
            dir.join(s)
                .metadata()
                .map(|md| md.len() > 0)
                .unwrap_or(false)
        })
        .cloned()
        .collect();
    if existing.is_empty() {
        return Err(FfError::Failed("Nothing was recorded.".into()));
    }
    let video = if existing.len() == 1 {
        existing[0].clone()
    } else {
        let list = dir.join("segments.txt");
        let body: String = existing
            .iter()
            .map(|s| format!("file '{}'\n", s.replace('\'', "'\\''")))
            .collect();
        std::fs::write(&list, body).map_err(|e| FfError::Failed(e.to_string()))?;
        let out = "screen.mkv".to_string();
        ffmpeg::run_capture_stderr(&[
            "-y".into(),
            "-f".into(),
            "concat".into(),
            "-safe".into(),
            "0".into(),
            "-i".into(),
            list.to_string_lossy().to_string(),
            "-c".into(),
            "copy".into(),
            dir.join(&out).to_string_lossy().to_string(),
        ])?;
        for s in &existing {
            let _ = std::fs::remove_file(dir.join(s));
        }
        let _ = std::fs::remove_file(list);
        out
    };
    // Matroska is crash-safe while recording; MP4 plays everywhere (including
    // the editor preview). Re-wrapping is a copy, not a re-encode.
    let video = remux_to_mp4(dir, &video).unwrap_or(video);
    if let Some(cam) = m.camera.clone() {
        if dir.join(&cam).exists() {
            m.camera = Some(remux_to_mp4(dir, &cam).unwrap_or(cam));
        }
    }
    let info = ffmpeg::probe(&dir.join(&video)).unwrap_or_default();
    m.duration = info.duration;
    m.video = Some(video);
    m.state = "done".into();
    m.bytes = std::fs::read_dir(dir)
        .map(|rd| {
            rd.filter_map(Result::ok)
                .filter_map(|e| e.metadata().ok())
                .map(|m| m.len())
                .sum()
        })
        .unwrap_or(0);
    let _ = null_sink();
    Ok(())
}

fn remux_to_mp4(dir: &Path, name: &str) -> Option<String> {
    let out = Path::new(name)
        .with_extension("mp4")
        .to_string_lossy()
        .to_string();
    ffmpeg::run_capture_stderr(&[
        "-y".into(),
        "-i".into(),
        dir.join(name).to_string_lossy().to_string(),
        "-c".into(),
        "copy".into(),
        "-movflags".into(),
        "+faststart".into(),
        dir.join(&out).to_string_lossy().to_string(),
    ])
    .ok()?;
    if dir
        .join(&out)
        .metadata()
        .map(|m| m.len() > 0)
        .unwrap_or(false)
    {
        let _ = std::fs::remove_file(dir.join(name));
        Some(out)
    } else {
        None
    }
}

/// Fix the RIFF/data sizes of a WAV whose writer was killed mid-recording.
pub fn repair_wav(path: &Path) -> std::io::Result<bool> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)?;
    let len = f.metadata()?.len();
    if len < 44 {
        return Ok(false);
    }
    let mut header = [0u8; 44];
    f.read_exact(&mut header)?;
    if &header[0..4] != b"RIFF" || &header[36..40] != b"data" {
        return Ok(false);
    }
    let riff = (len - 8) as u32;
    let data = (len - 44) as u32;
    let current = u32::from_le_bytes([header[40], header[41], header[42], header[43]]);
    if current == data {
        return Ok(false);
    }
    f.seek(SeekFrom::Start(4))?;
    f.write_all(&riff.to_le_bytes())?;
    f.seek(SeekFrom::Start(40))?;
    f.write_all(&data.to_le_bytes())?;
    Ok(true)
}

/// On launch: find recordings interrupted by a crash or power cut and make them usable.
pub fn recover(root: &Path) -> Vec<Manifest> {
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(root) else {
        return out;
    };
    for e in rd.filter_map(Result::ok) {
        let dir = e.path();
        let Ok(text) = std::fs::read_to_string(dir.join("recording.json")) else {
            continue;
        };
        let Ok(mut m) = serde_json::from_str::<Manifest>(&text) else {
            continue;
        };
        if m.state != "recording" {
            continue;
        }
        for w in [&m.mic, &m.system_audio].into_iter().flatten() {
            let _ = repair_wav(&dir.join(w));
        }
        if finalize(&dir, &mut m).is_ok() {
            m.state = "recovered".into();
            m.notes.push("Recovered after Alchemist closed unexpectedly. The last second or so may be missing.".into());
            write_manifest(&dir, &m);
            out.push(m);
        }
    }
    out
}

#[cfg(windows)]
fn list_cameras_windows(bin: &Path) -> Vec<String> {
    let out = ffmpeg::command(bin)
        .args(["-list_devices", "true", "-f", "dshow", "-i", "dummy"])
        .output();
    let text = out
        .map(|o| String::from_utf8_lossy(&o.stderr).to_string())
        .unwrap_or_default();
    parse_dshow_video(&text)
}
#[cfg(not(windows))]
fn list_cameras_windows(_bin: &Path) -> Vec<String> {
    Vec::new()
}

pub fn parse_dshow_video(text: &str) -> Vec<String> {
    let re = regex::Regex::new(r#""([^"]+)" \(video\)"#).unwrap();
    re.captures_iter(text).map(|c| c[1].to_string()).collect()
}

/// Top-level window titles that can be recorded on Windows.
#[cfg(windows)]
pub fn list_windows() -> Vec<String> {
    use windows_sys::Win32::Foundation::{BOOL, HWND, LPARAM};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowTextLengthW, GetWindowTextW, IsWindowVisible,
    };
    unsafe extern "system" fn cb(hwnd: HWND, lp: LPARAM) -> BOOL {
        let out = &mut *(lp as *mut Vec<String>);
        if IsWindowVisible(hwnd) == 0 {
            return 1;
        }
        let len = GetWindowTextLengthW(hwnd);
        if len <= 0 {
            return 1;
        }
        let mut buf = vec![0u16; len as usize + 1];
        let n = GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
        let title = String::from_utf16_lossy(&buf[..n as usize]);
        if !title.trim().is_empty() && title != "Program Manager" && !out.contains(&title) {
            out.push(title);
        }
        1
    }
    let mut v: Vec<String> = Vec::new();
    unsafe {
        EnumWindows(Some(cb), &mut v as *mut _ as LPARAM);
    }
    v
}
#[cfg(not(windows))]
pub fn list_windows() -> Vec<String> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn caps(hw: Option<&str>) -> Capabilities {
        let mut c = Capabilities::default();
        c.encoders.push("libx264".into());
        c.devices.push("x11grab".into());
        c.hw_h264 = hw.map(String::from);
        c
    }
    fn opts(src: Source) -> RecordOptions {
        RecordOptions {
            source: src,
            mic: true,
            system_audio: true,
            camera: false,
            preset: Preset::Tutorial,
            video: None,
            record_keys: false,
            auto_stop_seconds: None,
            auto_stop_mb: None,
        }
    }

    #[test]
    fn windows_area_uses_gdigrab_offsets() {
        let o = opts(Source::Area {
            x: 100,
            y: 50,
            width: 801,
            height: 601,
            screen_index: 0,
        });
        let (a, enc) = segment_args(&o, &caps(None), Path::new("s.mkv"), "windows").unwrap();
        let j = a.join(" ");
        assert!(
            j.contains("-f gdigrab")
                && j.contains("-offset_x 100")
                && j.contains("-video_size 800x600")
        );
        assert!(j.contains("-f matroska") && j.contains("-cluster_time_limit 1000"));
        assert_eq!(enc, "libx264");
        assert!(j.contains("ultrafast"));
    }

    #[test]
    fn hardware_encoder_is_used_for_capture_when_present() {
        let o = opts(Source::Screen {
            index: 0,
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
        });
        let (a, enc) =
            segment_args(&o, &caps(Some("h264_nvenc")), Path::new("s.mkv"), "windows").unwrap();
        assert_eq!(enc, "h264_nvenc");
        assert!(a.join(" ").contains("-preset p1"));
    }

    #[test]
    fn window_capture_by_title() {
        let o = opts(Source::Window {
            title: "Browser".into(),
        });
        let (a, _) = segment_args(&o, &caps(None), Path::new("s.mkv"), "windows").unwrap();
        assert!(a.contains(&"title=Browser".to_string()));
        assert!(segment_args(&o, &caps(None), Path::new("s.mkv"), "macos").is_err());
    }

    #[test]
    fn macos_and_linux_inputs() {
        let o = opts(Source::Area {
            x: 10,
            y: 20,
            width: 640,
            height: 480,
            screen_index: 1,
        });
        let m = segment_args(&o, &caps(None), Path::new("s.mkv"), "macos")
            .unwrap()
            .0
            .join(" ");
        assert!(m.contains("Capture screen 1:none") && m.contains("crop=640:480:10:20"));
        let l = segment_args(&o, &caps(None), Path::new("s.mkv"), "linux")
            .unwrap()
            .0
            .join(" ");
        assert!(l.contains("x11grab") && l.contains("+10,20"));
        let mut no_x11 = caps(None);
        no_x11.devices.clear();
        assert!(segment_args(&o, &no_x11, Path::new("s.mkv"), "linux").is_err());
    }

    #[test]
    fn custom_recording_settings_are_clamped() {
        let mut o = opts(Source::Screen {
            index: 0,
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
        });
        o.video = Some(VideoSettings {
            width: 99999,
            height: 10,
            fps: 999.0,
        });
        let j = segment_args(&o, &caps(None), Path::new("s.mkv"), "windows")
            .unwrap()
            .0
            .join(" ");
        assert!(j.contains("-framerate 240") && j.contains("scale=7680:72"));
    }

    #[test]
    fn dshow_camera_list() {
        let t = r#"[dshow @ 0] "Integrated Camera" (video)
[dshow @ 0]   Alternative name "@device_pnp_x"
[dshow @ 0] "Microphone (Realtek)" (audio)"#;
        assert_eq!(parse_dshow_video(t), vec!["Integrated Camera"]);
    }

    #[test]
    fn wav_repair_fixes_sizes() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.wav");
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: 8000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut w = hound::WavWriter::create(&p, spec).unwrap();
        for i in 0..800 {
            w.write_sample((i % 100) as i16).unwrap();
        }
        w.flush().unwrap();
        std::mem::forget(w); // simulate a crash: no finalize
                             // Append raw samples the header doesn't know about.
        let mut f = std::fs::OpenOptions::new().append(true).open(&p).unwrap();
        f.write_all(&[0u8; 400]).unwrap();
        drop(f);
        assert!(repair_wav(&p).unwrap());
        let r = hound::WavReader::open(&p).unwrap();
        assert_eq!(r.len(), 1000);
    }

    #[test]
    fn manifest_round_trip_and_recovery_skips_finished() {
        let dir = tempfile::tempdir().unwrap();
        let rec = dir.path().join("recording-1");
        std::fs::create_dir_all(&rec).unwrap();
        let m = Manifest {
            id: "recording-1".into(),
            state: "done".into(),
            ..Default::default()
        };
        write_manifest(&rec, &m);
        assert!(recover(dir.path()).is_empty());
    }
}
