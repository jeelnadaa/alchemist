//! End-to-end media tests against a real FFmpeg.
//! Generates test clips with FFmpeg's built-in sources, then runs every
//! pipeline the app uses and checks the actual output files.
//!
//! Needs FFmpeg: set ALCHEMIST_FFMPEG, or have the sidecar in
//! src-tauri/binaries/, or ffmpeg on PATH. Skips (passes) if none is found.

use alchemist_lib::convert::{Container, ConvertRequest, EnhanceOptions, Goal, Quality};
use alchemist_lib::ffmpeg;
use alchemist_lib::jobs::{self, Job, Queue, Status};
use alchemist_lib::limits::FitMode;
use alchemist_lib::{analysis, export, project, quality, recorder};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::Duration;

fn setup() -> Option<PathBuf> {
    if std::env::var("ALCHEMIST_FFMPEG").is_err() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries");
        if let Ok(rd) = std::fs::read_dir(&dir) {
            for e in rd.flatten() {
                let n = e.file_name().to_string_lossy().to_string();
                if n.starts_with("ffmpeg-") && !n.ends_with(".txt") {
                    std::env::set_var("ALCHEMIST_FFMPEG", e.path());
                }
            }
        }
    }
    match ffmpeg::locate() {
        Ok(p) => Some(p),
        Err(_) => {
            eprintln!("FFmpeg not found; skipping media tests");
            None
        }
    }
}

/// 6 s 1280x720 30 fps test pattern with a tone that goes silent from 2 s to 4 s.
fn make_clip(dir: &Path, name: &str) -> PathBuf {
    let out = dir.join(name);
    ffmpeg::run_capture_stderr(&[
        "-y".into(),
        "-f".into(),
        "lavfi".into(),
        "-i".into(),
        "testsrc2=size=1280x720:rate=30:duration=6".into(),
        "-f".into(),
        "lavfi".into(),
        "-i".into(),
        "sine=frequency=440:duration=6:sample_rate=48000".into(),
        "-af".into(),
        "volume='if(between(t,2,4),0,1)':eval=frame".into(),
        "-c:v".into(),
        "libx264".into(),
        "-preset".into(),
        "ultrafast".into(),
        "-pix_fmt".into(),
        "yuv420p".into(),
        "-c:a".into(),
        "aac".into(),
        "-shortest".into(),
        out.to_string_lossy().to_string(),
    ])
    .expect("make test clip");
    out
}

fn run_job(spec: jobs::JobSpec) -> Job {
    let (tx, rx) = mpsc::channel::<Job>();
    let tx = parking_lot::Mutex::new(tx);
    let q = Queue::new(Arc::new(move |j: &Job| {
        let _ = tx.lock().send(j.clone());
    }));
    let id = q.add(spec).id;
    loop {
        let j = rx
            .recv_timeout(Duration::from_secs(180))
            .expect("job finished in time");
        if j.id == id && matches!(j.status, Status::Done | Status::Failed | Status::Cancelled) {
            return j;
        }
    }
}

fn req(input: &Path, goal: Goal) -> ConvertRequest {
    ConvertRequest {
        input: input.to_path_buf(),
        output: None,
        goal,
        video: None,
        fit: FitMode::Fit,
        start: None,
        length: None,
        use_hardware: false,
        keep_metadata: true,
    }
}

#[test]
fn full_media_pipeline() {
    if setup().is_none() {
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    let clip = make_clip(dir, "clip.mp4");

    // Probe.
    let info = ffmpeg::probe(&clip).unwrap();
    assert!(
        (info.duration - 6.0).abs() < 0.2,
        "duration {}",
        info.duration
    );
    assert_eq!((info.width, info.height), (1280, 720));
    assert!(info.has_audio && info.has_video);
    let caps = ffmpeg::capabilities().unwrap();
    assert!(caps.has_encoder("libx264"));

    // Target size: must land under the limit, with a measured quality score.
    let j =
        run_job(jobs::spec_for_convert(req(&clip, Goal::TargetSize { target_mb: 0.5 })).unwrap());
    assert_eq!(j.status, Status::Done, "{:?}", j.error);
    let r = j.report.unwrap();
    assert!(
        r.output_bytes > 0 && r.output_bytes <= 512 * 1024,
        "size {}",
        r.output_bytes
    );
    let q = r.quality.expect("quality measured");
    assert!(q.metric == "VMAF" || q.metric == "SSIM");
    assert!(q.value > 0.0);
    assert!(!j.output.to_string_lossy().contains("pass"));

    // Lossless remux mp4 -> mkv.
    let j = run_job(
        jobs::spec_for_convert(req(
            &clip,
            Goal::Format {
                container: Container::Mkv,
                quality: Quality::Same,
            },
        ))
        .unwrap(),
    );
    assert_eq!(j.status, Status::Done, "{:?}", j.error);
    assert!((ffmpeg::probe(&j.output).unwrap().duration - 6.0).abs() < 0.2);

    // WebM, GIF, MP3.
    for c in [Container::Webm, Container::Gif, Container::Mp3] {
        let j = run_job(
            jobs::spec_for_convert(req(
                &clip,
                Goal::Format {
                    container: c,
                    quality: Quality::Smaller,
                },
            ))
            .unwrap(),
        );
        assert_eq!(j.status, Status::Done, "{c:?}: {:?}", j.error);
        let out = ffmpeg::probe(&j.output).unwrap();
        match c {
            Container::Mp3 => assert!(out.has_audio && !out.has_video),
            Container::Gif => assert!(out.has_video && out.width <= 720),
            _ => assert!(out.has_video && out.has_audio),
        }
    }

    // Custom size + fps, clamped and applied.
    let mut r2 = req(
        &clip,
        Goal::Format {
            container: Container::Mp4,
            quality: Quality::Smaller,
        },
    );
    r2.video = Some(alchemist_lib::limits::VideoSettings {
        width: 641,
        height: 360,
        fps: 24.0,
    });
    r2.output = Some(dir.join("custom.mp4"));
    let j = run_job(jobs::spec_for_convert(r2).unwrap());
    assert_eq!(j.status, Status::Done, "{:?}", j.error);
    let o = ffmpeg::probe(&j.output).unwrap();
    assert_eq!((o.width, o.height), (642, 360));
    assert!((o.fps - 24.0).abs() < 0.1, "fps {}", o.fps);

    // Enhance (all filters) on a 2-second preview range.
    let mut r3 = req(
        &clip,
        Goal::Enhance {
            options: EnhanceOptions {
                sharpen: true,
                denoise: true,
                stabilize: true,
                upscale: true,
                deinterlace: true,
                hdr_to_sdr: false,
            },
        },
    );
    r3.start = Some(1.0);
    r3.length = Some(2.0);
    r3.output = Some(dir.join("enhanced.mp4"));
    let j = run_job(jobs::spec_for_convert(r3).unwrap());
    assert_eq!(j.status, Status::Done, "{:?}", j.error);
    let o = ffmpeg::probe(&j.output).unwrap();
    assert_eq!((o.width, o.height), (2560, 1440));
    assert!((o.duration - 2.0).abs() < 0.3);

    // Silence detection finds the gap at 2–4 s.
    let s = analysis::detect_silence(&clip, -35.0, 1.0).unwrap();
    assert_eq!(s.len(), 1, "{s:?}");
    assert!(
        s[0].start > 1.9 && s[0].start < 2.4 && s[0].end > 3.6 && s[0].end < 4.1,
        "{s:?}"
    );

    // Waveform and thumbnail.
    let w = analysis::waveform(&clip, 60).unwrap();
    assert_eq!(w.len(), 60);
    assert!(w[5] > 0.1 && w[30] < 0.02, "{:?}", &w[..]);
    let thumb = analysis::thumbnail(&clip, 1.0, &dir.join("cache")).unwrap();
    assert!(thumb.exists());

    // Quality of a file against itself is (near) perfect.
    let self_q = quality::measure(&caps, &clip, &clip, 6.0, 640, 360).unwrap();
    assert!(self_q.verdict.contains("identical"), "{self_q:?}");
}

#[test]
fn project_export_renders_everything() {
    if setup().is_none() {
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    let clip = make_clip(dir, "clip.mp4");
    let caps = ffmpeg::capabilities().unwrap();
    let used = [
        "drawtext", "zoompan", "geq", "boxblur", "drawbox", "afftdn", "loudnorm", "apad", "amix", "adelay", "atempo",
        "palettegen", "paletteuse", "fade", "afade", "overlay", "trim", "atrim", "loop", "highpass", "scale", "crop",
        "color", "hflip", "split", "aresample", "fps", "format", "setpts", "asetpts", "volume",
    ];
    let missing: Vec<&str> = used.iter().copied().filter(|f| !caps.has_filter(f)).collect();
    eprintln!("FFmpeg: {}\nfilters missing from this build: {missing:?}", caps.version);
    let font = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("Inter-Bold.ttf");

    let mut p = project::Project::new("Export test", 1280, 720, 30.0);
    p.settings.padding = 40;
    p.settings.radius = 24;
    p.settings.background = "#1e2a4a".into();
    let m = project::Media {
        id: "m".into(),
        path: clip.clone(),
        kind: "video".into(),
        duration: 6.0,
        width: 1280,
        height: 720,
        has_audio: true,
        missing: false,
    };
    p.media.push(m);
    let mk = |id: &str, start: f64, i: f64, o: f64| project::Clip {
        id: id.into(),
        media_id: Some("m".into()),
        start,
        in_point: i,
        out: o,
        speed: 1.0,
        volume: 1.0,
        fade_in: 0.3,
        fade_out: 0.3,
        reverse: false,
        freeze: false,
        transform: project::Transform {
            scale: 1.0,
            ..Default::default()
        },
        text: None,
        shape: None,
        clean_voice: true,
    };
    p.tracks[0].clips.push(mk("a", 0.0, 0.0, 2.0));
    let mut fast = mk("b", 2.0, 2.0, 6.0);
    fast.speed = 2.0;
    p.tracks[0].clips.push(fast);
    let mut freeze = mk("c", 4.0, 1.0, 2.0);
    freeze.freeze = true;
    p.tracks[0].clips.push(freeze);
    let mut overlay = mk("pip", 0.5, 0.0, 3.0);
    overlay.transform = project::Transform {
        scale: 0.25,
        x: 0.35,
        y: 0.3,
        flip_h: true,
        ..Default::default()
    };
    p.tracks.insert(
        1,
        project::Track {
            id: "ov".into(),
            kind: "overlay".into(),
            name: "Camera".into(),
            muted: false,
            volume: 1.0,
            clips: vec![overlay],
        },
    );
    let mut text = mk("t", 1.0, 0.0, 2.0);
    text.media_id = None;
    text.text = Some(project::TextProps {
        text: "Click: 'Publish' 100%".into(),
        style: "callout".into(),
        size: 48,
        position: "bottom".into(),
        color: "#ffffff".into(),
        animation: "fade".into(),
    });
    let mut blur = mk("s", 0.0, 0.0, 5.0);
    blur.media_id = None;
    blur.shape = Some(project::ShapeProps {
        shape: "blur".into(),
        rect: [0.1, 0.1, 0.2, 0.2],
        color: String::new(),
    });
    let mut hl = mk("h", 0.0, 0.0, 5.0);
    hl.media_id = None;
    hl.shape = Some(project::ShapeProps {
        shape: "highlight".into(),
        rect: [0.6, 0.6, 0.2, 0.1],
        color: "#5b8cff".into(),
    });
    let text_track = p.tracks.iter_mut().find(|t| t.kind == "text").unwrap();
    text_track.clips.extend([text, blur, hl]);
    p.zooms.push(project::Zoom {
        start: 0.5,
        end: 2.5,
        scale: 2.0,
        x: 0.7,
        y: 0.6,
    });
    p.captions.push(project::Caption {
        start: 0.2,
        end: 1.5,
        text: "A caption".into(),
    });

    let total = p.duration();
    assert!((total - 5.0).abs() < 1e-6, "total {total}");

    for (preset, ext) in [
        (export::Preset::Share, "mp4"),
        (export::Preset::Vertical, "mp4"),
        (export::Preset::Small, "mp4"),
        (export::Preset::Gif, "gif"),
        (export::Preset::Audio, "mp3"),
    ] {
        let out = dir.join(format!("export-{preset:?}.{ext}"));
        let req = export::ExportRequest {
            preset,
            output: out.clone(),
            range: None,
            width: None,
            height: None,
            fps: None,
            burn_captions: true,
            sidecar_captions: true,
            loudness: true,
            use_hardware: false,
            target_mb: Some(1.0),
        };
        let plan =
            export::build(&p, &req, &caps, &font, &dir.join(format!("tmp-{preset:?}"))).unwrap();
        if let Ok(d) = std::env::var("ALCHEMIST_DUMP") {
            let _ = std::fs::create_dir_all(&d);
            let _ = std::fs::copy(
                dir.join(format!("tmp-{preset:?}")).join("graph.txt"),
                Path::new(&d).join(format!("{preset:?}.graph.txt")),
            );
            let _ = std::fs::write(
                Path::new(&d).join(format!("{preset:?}.args.txt")),
                plan.args.join(
                    "
",
                ),
            );
            let _ = std::fs::copy(&clip, Path::new(&d).join("clip.mp4"));
        }
        let job = run_job(jobs::JobSpec {
            title: "export".into(),
            kind: "export".into(),
            input: None,
            input_bytes: 0,
            output: out.clone(),
            passes: vec![plan.args],
            duration: plan.duration,
            convert: None,
            measure_quality: false,
            cleanup: vec![],
        });
        assert_eq!(job.status, Status::Done, "{preset:?}: {:?}", job.error);
        let o = ffmpeg::probe(&out).unwrap();
        if let Ok(d) = std::env::var("ALCHEMIST_DUMP") {
            let _ = std::fs::copy(&out, Path::new(&d).join(out.file_name().unwrap()));
        }
        assert!(
            (o.duration - total).abs() < 0.35,
            "{preset:?} duration {}",
            o.duration
        );
        match preset {
            export::Preset::Share => {
                assert_eq!((o.width, o.height), (1280, 720));
                assert!(o.has_audio);
            }
            export::Preset::Vertical => assert_eq!((o.width, o.height), (1080, 1920)),
            export::Preset::Small => {
                assert!(std::fs::metadata(&out).unwrap().len() <= 1024 * 1024 + 64 * 1024)
            }
            export::Preset::Audio => assert!(!o.has_video && o.has_audio),
            _ => {}
        }
    }

    // Range export.
    let out = dir.join("range.mp4");
    let req = export::ExportRequest {
        preset: export::Preset::Custom,
        output: out.clone(),
        range: Some((1.0, 3.0)),
        width: Some(640),
        height: Some(360),
        fps: Some(25.0),
        burn_captions: false,
        sidecar_captions: false,
        loudness: false,
        use_hardware: false,
        target_mb: None,
    };
    let plan = export::build(&p, &req, &caps, &font, &dir.join("tmp-range")).unwrap();
    if let Ok(d) = std::env::var("ALCHEMIST_DUMP") {
        let _ = std::fs::copy(
            dir.join("tmp-range").join("graph.txt"),
            Path::new(&d).join("range.graph.txt"),
        );
        let _ = std::fs::write(
            Path::new(&d).join("range.args.txt"),
            plan.args.join(
                "
",
            ),
        );
    }
    let job = run_job(jobs::JobSpec {
        title: "range".into(),
        kind: "export".into(),
        input: None,
        input_bytes: 0,
        output: out.clone(),
        passes: vec![plan.args],
        duration: plan.duration,
        convert: None,
        measure_quality: false,
        cleanup: vec![],
    });
    assert_eq!(job.status, Status::Done, "{:?}", job.error);
    let o = ffmpeg::probe(&out).unwrap();
    assert!(
        (o.duration - 2.0).abs() < 0.3,
        "range duration {}",
        o.duration
    );
    assert_eq!((o.width, o.height), (640, 360));
}

#[test]
fn recording_finalize_joins_segments_and_recovers_crashes() {
    if setup().is_none() {
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let rec = root.join("recording-1");
    std::fs::create_dir_all(&rec).unwrap();
    // Two "paused" segments in Matroska, like the recorder writes.
    for (i, d) in [(1, 2), (2, 3)] {
        ffmpeg::run_capture_stderr(&[
            "-y".into(),
            "-f".into(),
            "lavfi".into(),
            "-i".into(),
            format!("testsrc2=size=640x360:rate=30:duration={d}"),
            "-c:v".into(),
            "libx264".into(),
            "-preset".into(),
            "ultrafast".into(),
            "-pix_fmt".into(),
            "yuv420p".into(),
            "-f".into(),
            "matroska".into(),
            rec.join(format!("screen-00{i}.mkv"))
                .to_string_lossy()
                .to_string(),
        ])
        .unwrap();
    }
    // A WAV left behind by a crash (header never finalised).
    let wav = rec.join("mic.wav");
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: 8000,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut w = hound::WavWriter::create(&wav, spec).unwrap();
    for i in 0..8000 {
        w.write_sample(((i % 50) * 100) as i16).unwrap();
    }
    w.flush().unwrap();
    std::mem::forget(w);
    let m = recorder::Manifest {
        id: "recording-1".into(),
        state: "recording".into(),
        segments: vec!["screen-001.mkv".into(), "screen-002.mkv".into()],
        mic: Some("mic.wav".into()),
        fps: 30.0,
        ..Default::default()
    };
    recorder::write_manifest(&rec, &m);

    let recovered = recorder::recover(root);
    assert_eq!(recovered.len(), 1);
    let r = &recovered[0];
    assert_eq!(r.state, "recovered");
    assert_eq!(r.video.as_deref(), Some("screen.mp4"));
    assert!(
        (r.duration - 5.0).abs() < 0.3,
        "joined duration {}",
        r.duration
    );
    assert!(hound::WavReader::open(&wav).is_ok());
    assert!(!rec.join("screen-001.mkv").exists());
}

#[test]
fn hardware_encoders_are_only_reported_if_they_work() {
    if setup().is_none() {
        return;
    }
    let caps = ffmpeg::capabilities().unwrap();
    if let Some(hw) = &caps.hw_h264 {
        let tmp = tempfile::tempdir().unwrap();
        let out = tmp.path().join("hw.mp4");
        ffmpeg::run_capture_stderr(&[
            "-y".into(),
            "-f".into(),
            "lavfi".into(),
            "-i".into(),
            "testsrc2=size=640x360:rate=30:duration=1".into(),
            "-c:v".into(),
            hw.clone(),
            "-pix_fmt".into(),
            "yuv420p".into(),
            out.to_string_lossy().to_string(),
        ])
        .unwrap();
        assert!(out.exists());
    }
}

/// Records the real screen for 3 seconds with computer sound, then stops.
/// Needs a desktop session; run with `cargo test --test media -- --ignored`.
#[test]
#[ignore]
fn real_screen_recording() {
    if setup().is_none() {
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let r = recorder::Recorder::new(tmp.path().to_path_buf());
    let opts = recorder::RecordOptions {
        source: recorder::Source::Area {
            x: 0,
            y: 0,
            width: 800,
            height: 600,
            screen_index: 0,
        },
        mic: false,
        system_audio: true,
        camera: false,
        preset: recorder::Preset::Tutorial,
        video: None,
        record_keys: false,
        auto_stop_seconds: None,
        auto_stop_mb: None,
    };
    let started = r.start(opts).expect("recording starts");
    std::thread::sleep(Duration::from_millis(1500));
    r.pause().unwrap();
    std::thread::sleep(Duration::from_millis(500));
    r.resume().unwrap();
    std::thread::sleep(Duration::from_millis(1500));
    let st = r.status().unwrap();
    assert!(
        st.seconds > 2.5 && st.seconds < 4.0,
        "status seconds {}",
        st.seconds
    );
    let m = r.stop().expect("recording stops");
    eprintln!("manifest: {m:?}");
    assert_eq!(m.state, "done");
    let dir = tmp.path().join(&started.id);
    let video = dir.join(m.video.as_ref().unwrap());
    assert!(video.extension().unwrap() == "mp4");
    let info = ffmpeg::probe(&video).unwrap();
    assert_eq!((info.width, info.height), (800, 600));
    assert!(
        info.duration > 2.0 && info.duration < 4.5,
        "video duration {}",
        info.duration
    );
    assert!(dir.join("events.jsonl").exists());
    if let Some(sys) = &m.system_audio {
        assert!(hound::WavReader::open(dir.join(sys)).is_ok());
    }
}
