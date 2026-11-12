//! Alchemist app: wires the media core to the window, tray and hotkeys.
//!
//! Lightness rules applied here:
//! - Closing the window destroys the web view (the heavy part). Recording,
//!   jobs and the hotkey keep running in a tiny tray-only process.
//! - Every heavy task runs on a blocking thread or in its own FFmpeg process.

pub mod analysis;
pub mod convert;
pub mod disk;
pub mod export;
pub mod ffmpeg;
pub mod jobs;
pub mod limits;
pub mod paths;
pub mod project;
pub mod quality;
pub mod recorder;
pub mod settings;

use parking_lot::Mutex;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};

pub struct AppState {
    pub data: paths::DataLocation,
    pub queue: Arc<jobs::Queue>,
    pub recorder: Arc<recorder::Recorder>,
    pub settings: Arc<Mutex<settings::Settings>>,
    pub font: PathBuf,
    pub recovered: Mutex<Vec<recorder::Manifest>>,
    /// The last finished recording, picked up by the main window when it opens.
    pub finished: Arc<Mutex<Option<recorder::Manifest>>>,
}

type Res<T> = Result<T, String>;

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Res<T> + Send + 'static) -> Res<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

// ------------------------------------------------------------------ app info

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    version: String,
    os: String,
    portable: bool,
    portable_note: Option<String>,
    data_dir: PathBuf,
    recordings_dir: PathBuf,
    ffmpeg: Option<PathBuf>,
}

#[tauri::command]
fn app_info(app: AppHandle, state: tauri::State<'_, AppState>) -> AppInfo {
    AppInfo {
        version: app.package_info().version.to_string(),
        os: recorder::current_os().into(),
        portable: state.data.portable,
        portable_note: state.data.portable_fallback_reason.clone(),
        data_dir: state.data.root.clone(),
        recordings_dir: state.data.recordings_dir(),
        ffmpeg: ffmpeg::locate().ok(),
    }
}

#[tauri::command]
async fn capabilities() -> Res<ffmpeg::Capabilities> {
    blocking(|| ffmpeg::capabilities().map_err(|e| e.to_string())).await
}

#[tauri::command]
fn check_limits(width: u32, height: u32, fps: f64) -> limits::Clamped {
    limits::clamp_video(limits::VideoSettings { width, height, fps })
}

#[tauri::command]
async fn probe(path: PathBuf) -> Res<ffmpeg::MediaInfo> {
    blocking(move || ffmpeg::probe(&path).map_err(|e| e.to_string())).await
}

// ------------------------------------------------------------------ settings

#[tauri::command]
fn settings_get(state: tauri::State<'_, AppState>) -> settings::Settings {
    state.settings.lock().clone()
}

#[tauri::command]
fn settings_set(state: tauri::State<'_, AppState>, value: settings::Settings) -> Res<()> {
    settings::save(&state.data.settings_file(), &value)?;
    *state.settings.lock() = value;
    Ok(())
}

// ------------------------------------------------------------------ jobs

#[tauri::command]
async fn convert_start(
    state: tauri::State<'_, AppState>,
    req: convert::ConvertRequest,
) -> Res<jobs::Job> {
    let q = state.queue.clone();
    blocking(move || {
        let spec = jobs::spec_for_convert(req).map_err(|e| e.to_string())?;
        Ok(q.add(spec))
    })
    .await
}

/// A 5-second sample of what a conversion will look like, saved to the cache.
#[tauri::command]
async fn convert_preview(
    state: tauri::State<'_, AppState>,
    mut req: convert::ConvertRequest,
) -> Res<jobs::Job> {
    let q = state.queue.clone();
    let cache = state.data.cache_dir();
    blocking(move || {
        let info = ffmpeg::probe(&req.input).map_err(|e| e.to_string())?;
        let len = 5.0_f64.min(info.duration);
        req.start = Some(((info.duration - len) / 2.0).max(0.0));
        req.length = Some(len);
        if let convert::Goal::TargetSize { .. } = req.goal {
            // A short sample needs the same bitrate, not the same file size.
            let plan = convert::plan_target_size(
                &info,
                match req.goal {
                    convert::Goal::TargetSize { target_mb } => target_mb,
                    _ => 25.0,
                },
            );
            let mb =
                (plan.video_kbps + plan.audio_kbps) * len / 8.0 / 1024.0 / convert::SIZE_SAFETY;
            req.goal = convert::Goal::TargetSize {
                target_mb: mb.max(0.05),
            };
        }
        let ext = convert::output_container(&req).ext();
        req.output = Some(cache.join(format!("preview-{}.{ext}", uuid::Uuid::new_v4())));
        let mut spec = jobs::spec_for_convert(req).map_err(|e| e.to_string())?;
        spec.title = format!("Preview: {}", spec.title);
        spec.kind = "preview".into();
        spec.measure_quality = false;
        Ok(q.add(spec))
    })
    .await
}

#[tauri::command]
async fn size_plan(path: PathBuf, target_mb: f64) -> Res<convert::SizePlan> {
    blocking(move || {
        let info = ffmpeg::probe(&path).map_err(|e| e.to_string())?;
        Ok(convert::plan_target_size(&info, target_mb))
    })
    .await
}

#[tauri::command]
fn jobs_list(state: tauri::State<'_, AppState>) -> Vec<jobs::Job> {
    state.queue.list()
}

#[tauri::command]
fn job_cancel(state: tauri::State<'_, AppState>, id: String) {
    state.queue.cancel(&id)
}

#[tauri::command]
fn jobs_clear(state: tauri::State<'_, AppState>) {
    state.queue.clear_finished()
}

#[tauri::command]
fn is_busy(state: tauri::State<'_, AppState>) -> bool {
    state.queue.is_busy() || state.recorder.is_recording()
}

// ------------------------------------------------------------------ recorder

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Monitor {
    index: u32,
    name: String,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    scale: f64,
    primary: bool,
}

#[tauri::command]
fn monitors(app: AppHandle) -> Res<Vec<Monitor>> {
    let primary = app.primary_monitor().ok().flatten().map(|m| *m.position());
    let list = app.available_monitors().map_err(|e| e.to_string())?;
    Ok(list
        .iter()
        .enumerate()
        .map(|(i, m)| Monitor {
            index: i as u32,
            name: m
                .name()
                .cloned()
                .unwrap_or_else(|| format!("Screen {}", i + 1)),
            x: m.position().x,
            y: m.position().y,
            width: m.size().width,
            height: m.size().height,
            scale: m.scale_factor(),
            primary: Some(*m.position()) == primary,
        })
        .collect())
}

#[tauri::command]
fn windows_list() -> Vec<String> {
    recorder::list_windows()
}

#[tauri::command]
async fn record_start(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    opts: recorder::RecordOptions,
) -> Res<recorder::Manifest> {
    let r = state.recorder.clone();
    let m = blocking(move || r.start(opts)).await?;
    show_bar(&app);
    let _ = app.emit("recorder", "started");
    Ok(m)
}

#[tauri::command]
async fn record_stop(app: AppHandle, state: tauri::State<'_, AppState>) -> Res<recorder::Manifest> {
    let r = state.recorder.clone();
    let m = blocking(move || r.stop()).await?;
    *state.finished.lock() = Some(m.clone());
    let _ = app.emit("recorder", "stopped");
    Ok(m)
}

/// Close the recording bar and bring back the main window.
#[tauri::command]
fn recording_ui_done(app: AppHandle) {
    if let Some(bar) = app.get_webview_window("bar") {
        let _ = bar.destroy();
    }
    ensure_main(&app);
}

#[tauri::command]
fn take_finished_recording(state: tauri::State<'_, AppState>) -> Option<recorder::Manifest> {
    state.finished.lock().take()
}

#[tauri::command]
fn record_pause(state: tauri::State<'_, AppState>) -> Res<()> {
    state.recorder.pause()
}

#[tauri::command]
async fn record_resume(state: tauri::State<'_, AppState>) -> Res<()> {
    let r = state.recorder.clone();
    blocking(move || r.resume()).await
}

#[tauri::command]
async fn record_cancel(app: AppHandle, state: tauri::State<'_, AppState>) -> Res<()> {
    let r = state.recorder.clone();
    blocking(move || r.cancel()).await?;
    if let Some(bar) = app.get_webview_window("bar") {
        let _ = bar.destroy();
    }
    ensure_main(&app);
    Ok(())
}

#[tauri::command]
fn record_status(state: tauri::State<'_, AppState>) -> Option<recorder::Status> {
    state.recorder.status()
}

#[tauri::command]
fn recovered_recordings(state: tauri::State<'_, AppState>) -> Vec<recorder::Manifest> {
    std::mem::take(&mut *state.recovered.lock())
}

/// Area picker: a transparent full-screen window where the user drags a box.
#[tauri::command]
fn open_area_picker(app: AppHandle, x: i32, y: i32, width: u32, height: u32) -> Res<()> {
    if let Some(w) = app.get_webview_window("picker") {
        let _ = w.destroy();
    }
    let w = WebviewWindowBuilder::new(&app, "picker", WebviewUrl::App("index.html#/picker".into()))
        .title("Choose an area")
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        .build()
        .map_err(|e| e.to_string())?;
    let _ = w.set_position(tauri::PhysicalPosition::new(x, y));
    let _ = w.set_size(tauri::PhysicalSize::new(width, height));
    let _ = w.set_focus();
    Ok(())
}

#[tauri::command]
fn area_picked(app: AppHandle, area: Option<serde_json::Value>) {
    if let Some(w) = app.get_webview_window("picker") {
        let _ = w.destroy();
    }
    let _ = app.emit("area-picked", area);
}

fn show_bar(app: &AppHandle) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.destroy();
    }
    if app.get_webview_window("bar").is_some() {
        return;
    }
    let builder = WebviewWindowBuilder::new(app, "bar", WebviewUrl::App("index.html#/bar".into()))
        .title("Alchemist recording")
        .inner_size(380.0, 64.0)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(false)
        .resizable(false)
        .shadow(false);
    if let Ok(w) = builder.build() {
        if let Ok(Some(m)) = w.current_monitor() {
            let x = m.position().x + m.size().width as i32 - (400.0 * m.scale_factor()) as i32;
            let y = m.position().y + (24.0 * m.scale_factor()) as i32;
            let _ = w.set_position(tauri::PhysicalPosition::new(x, y));
        }
    }
}

// ------------------------------------------------------------------ projects

#[tauri::command]
fn project_new(name: String, width: u32, height: u32, fps: f64) -> project::Project {
    project::Project::new(&name, width, height, fps)
}

#[tauri::command]
fn project_save(state: tauri::State<'_, AppState>, project: project::Project) -> Res<()> {
    project::save(&state.data.projects_dir(), &project).map(|_| ())
}

#[tauri::command]
fn project_load(state: tauri::State<'_, AppState>, id: String) -> Res<project::Project> {
    project::load(&state.data.projects_dir(), &id)
}

#[tauri::command]
fn project_open_file(path: PathBuf) -> Res<project::Project> {
    let mut p = project::load_file(&path)?;
    if let Some(base) = path.parent() {
        project::resolve_relative(&mut p, base);
        p.check_missing();
    }
    Ok(p)
}

#[tauri::command]
fn project_list(state: tauri::State<'_, AppState>) -> Vec<project::Summary> {
    project::list(&state.data.projects_dir())
}

#[tauri::command]
fn project_delete(state: tauri::State<'_, AppState>, id: String) -> Res<()> {
    project::delete(&state.data.projects_dir(), &id)
}

#[tauri::command]
fn history_save(
    state: tauri::State<'_, AppState>,
    id: String,
    history: serde_json::Value,
) -> Res<()> {
    project::save_history(&state.data.projects_dir(), &id, &history)
}

#[tauri::command]
fn history_load(state: tauri::State<'_, AppState>, id: String) -> serde_json::Value {
    project::load_history(&state.data.projects_dir(), &id)
}

#[tauri::command]
async fn project_package(project: project::Project, dest: PathBuf) -> Res<PathBuf> {
    blocking(move || project::package(&project, &dest)).await
}

#[tauri::command]
fn project_relink(
    mut project: project::Project,
    media_id: String,
    path: PathBuf,
) -> Res<project::Project> {
    project::relink(&mut project, &media_id, path)?;
    Ok(project)
}

/// Probe files and describe them as project media.
#[tauri::command]
async fn media_import(paths: Vec<PathBuf>) -> Res<Vec<project::Media>> {
    blocking(move || {
        let mut out = Vec::new();
        for p in paths {
            let ext = p
                .extension()
                .map(|e| e.to_string_lossy().to_lowercase())
                .unwrap_or_default();
            let image = matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "webp" | "bmp");
            let info = if image {
                ffmpeg::MediaInfo::default()
            } else {
                ffmpeg::probe(&p).map_err(|e| e.to_string())?
            };
            let kind = if image {
                "image"
            } else if info.has_video {
                "video"
            } else {
                "audio"
            };
            out.push(project::Media {
                id: uuid::Uuid::new_v4().to_string(),
                path: p,
                kind: kind.into(),
                duration: if image { 5.0 } else { info.duration },
                width: info.width,
                height: info.height,
                has_audio: info.has_audio,
                missing: false,
            });
        }
        Ok(out)
    })
    .await
}

/// Build an editable project from a finished recording: screen, camera,
/// voice and computer sound on their own tracks, plus auto-zoom from clicks.
#[tauri::command]
async fn project_from_recording(
    state: tauri::State<'_, AppState>,
    id: String,
) -> Res<project::Project> {
    let dir = state.data.recordings_dir().join(&id);
    let root = state.data.projects_dir();
    blocking(move || {
        let m: recorder::Manifest = serde_json::from_str(
            &std::fs::read_to_string(dir.join("recording.json")).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        let video = dir.join(m.video.clone().ok_or("This recording has no video.")?);
        let info = ffmpeg::probe(&video).map_err(|e| e.to_string())?;
        let name = format!("Recording {}", m.started_unix);
        let mut p = project::Project::new(
            &name,
            info.width.max(128),
            info.height.max(72),
            if info.fps > 0.0 { info.fps } else { m.fps },
        );
        let mk_media =
            |path: PathBuf, kind: &str, dur: f64, w: u32, h: u32, audio: bool| project::Media {
                id: uuid::Uuid::new_v4().to_string(),
                path,
                kind: kind.into(),
                duration: dur,
                width: w,
                height: h,
                has_audio: audio,
                missing: false,
            };
        let clip = |mid: &str, dur: f64| project::Clip {
            id: uuid::Uuid::new_v4().to_string(),
            media_id: Some(mid.into()),
            start: 0.0,
            in_point: 0.0,
            out: dur,
            speed: 1.0,
            volume: 1.0,
            fade_in: 0.0,
            fade_out: 0.0,
            reverse: false,
            freeze: false,
            transform: project::Transform {
                scale: 1.0,
                ..Default::default()
            },
            text: None,
            shape: None,
            clean_voice: false,
            volume_keys: vec![],
            transition_in: None,
        };
        let screen = mk_media(
            video,
            "video",
            info.duration,
            info.width,
            info.height,
            info.has_audio,
        );
        p.tracks[0].clips.push(clip(&screen.id, info.duration));
        p.media.push(screen);
        if let Some(cam) = &m.camera {
            let path = dir.join(cam);
            if let Ok(ci) = ffmpeg::probe(&path) {
                let media = mk_media(path, "video", ci.duration, ci.width, ci.height, false);
                let mut c = clip(&media.id, ci.duration.min(info.duration));
                c.transform = project::Transform {
                    scale: 0.24,
                    x: 0.36,
                    y: 0.33,
                    ..Default::default()
                };
                p.tracks.insert(
                    1,
                    project::Track {
                        id: "cam".into(),
                        kind: "overlay".into(),
                        name: "Camera".into(),
                        muted: false,
                        volume: 1.0,
                        clips: vec![c],
                    },
                );
                p.media.push(media);
            }
        }
        let audio_tracks: [(&Option<String>, &str, &str, bool); 2] = [
            (&m.mic, "a1", "Voice", true),
            (&m.system_audio, "a2", "Computer sound", false),
        ];
        for (file, tid, tname, clean) in audio_tracks {
            let Some(file) = file else { continue };
            let path = dir.join(file);
            let Ok(ai) = ffmpeg::probe(&path) else {
                continue;
            };
            let media = mk_media(path, "audio", ai.duration, 0, 0, true);
            let mut c = clip(&media.id, ai.duration.min(info.duration.max(ai.duration)));
            c.clean_voice = clean;
            if let Some(t) = p.tracks.iter_mut().find(|t| t.id == tid) {
                t.clips.push(c);
            } else {
                p.tracks.push(project::Track {
                    id: tid.into(),
                    kind: "audio".into(),
                    name: tname.into(),
                    muted: false,
                    volume: 1.0,
                    clips: vec![c],
                });
            }
            p.media.push(media);
        }
        if let Some(ev) = &m.events {
            let path = dir.join(ev);
            let events = analysis::read_events(&path);
            let (ox, oy, sw, sh) = match &m.source {
                Some(recorder::Source::Screen {
                    x,
                    y,
                    width,
                    height,
                    ..
                })
                | Some(recorder::Source::Area {
                    x,
                    y,
                    width,
                    height,
                    ..
                }) => (*x as f64, *y as f64, *width as f64, *height as f64),
                _ => (0.0, 0.0, info.width as f64, info.height as f64),
            };
            p.zooms = analysis::auto_zoom(&events, (ox, oy), (sw, sh), 0.5, 2.0);
            p.events = Some(path);
        }
        project::save(&root, &p)?;
        Ok(p)
    })
    .await
}

#[tauri::command]
async fn export_start(
    state: tauri::State<'_, AppState>,
    project: project::Project,
    req: export::ExportRequest,
) -> Res<jobs::Job> {
    let q = state.queue.clone();
    let font = state.font.clone();
    let cache = state.data.cache_dir();
    blocking(move || {
        let caps = ffmpeg::capabilities().map_err(|e| e.to_string())?;
        let tmp = cache.join(format!("export-{}", uuid::Uuid::new_v4()));
        let plan = export::build(&project, &req, &caps, &font, &tmp)?;
        if req.sidecar_captions && !project.captions.is_empty() {
            let _ = std::fs::write(
                req.output.with_extension("srt"),
                analysis::to_srt(&project.captions),
            );
        }
        let mut cleanup = plan.temp_files.clone();
        cleanup.push(tmp);
        Ok(q.add(jobs::JobSpec {
            title: format!("Export \"{}\"", project.name),
            kind: "export".into(),
            input: None,
            input_bytes: 0,
            output: req.output.clone(),
            passes: vec![plan.args],
            duration: plan.duration,
            convert: None,
            measure_quality: false,
            cleanup,
        }))
    })
    .await
}

// ------------------------------------------------------------------ analysis

#[tauri::command]
async fn detect_silence(
    path: PathBuf,
    threshold_db: Option<f64>,
    min_len: Option<f64>,
) -> Res<Vec<analysis::Range>> {
    blocking(move || {
        analysis::detect_silence(&path, threshold_db.unwrap_or(-35.0), min_len.unwrap_or(1.0))
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
async fn auto_zoom(
    events: PathBuf,
    origin: (f64, f64),
    size: (f64, f64),
    strength: f64,
) -> Res<Vec<project::Zoom>> {
    blocking(move || {
        Ok(analysis::auto_zoom(
            &analysis::read_events(&events),
            origin,
            size,
            strength,
            2.0,
        ))
    })
    .await
}

#[tauri::command]
async fn waveform(path: PathBuf, buckets: usize) -> Res<Vec<f32>> {
    blocking(move || analysis::waveform(&path, buckets.clamp(16, 4000)).map_err(|e| e.to_string()))
        .await
}

#[tauri::command]
async fn thumbnail(state: tauri::State<'_, AppState>, path: PathBuf, at: f64) -> Res<PathBuf> {
    let cache = state.data.cache_dir();
    blocking(move || analysis::thumbnail(&path, at, &cache).map_err(|e| e.to_string())).await
}

#[tauri::command]
fn make_proxy(state: tauri::State<'_, AppState>, path: PathBuf, duration: f64) -> jobs::Job {
    let out = state
        .data
        .cache_dir()
        .join(format!("proxy-{}.mp4", uuid::Uuid::new_v4()));
    state.queue.add(jobs::JobSpec {
        title: "Preparing smooth preview".into(),
        kind: "proxy".into(),
        input: Some(path.clone()),
        input_bytes: 0,
        output: out.clone(),
        passes: vec![analysis::proxy_args(&path, &out)],
        duration,
        convert: None,
        measure_quality: false,
        cleanup: vec![],
    })
}

#[tauri::command]
fn captions_export(captions: Vec<project::Caption>, path: PathBuf) -> Res<()> {
    let vtt = path
        .extension()
        .map(|e| e.eq_ignore_ascii_case("vtt"))
        .unwrap_or(false);
    std::fs::write(
        &path,
        if vtt {
            analysis::to_vtt(&captions)
        } else {
            analysis::to_srt(&captions)
        },
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn captions_import(path: PathBuf) -> Res<Vec<project::Caption>> {
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let caps = analysis::parse_subtitles(&text);
    if caps.is_empty() {
        return Err("No captions were found in that file.".into());
    }
    Ok(caps)
}

/// Small text files the user picked (theme files). Capped at 1 MB.
#[tauri::command]
fn read_text_file(path: PathBuf) -> Res<String> {
    let len = std::fs::metadata(&path).map_err(|e| e.to_string())?.len();
    if len > 1024 * 1024 {
        return Err("That file is too big to be a theme.".into());
    }
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn file_exists(path: PathBuf) -> bool {
    path.exists()
}

#[tauri::command]
fn file_size(path: PathBuf) -> u64 {
    std::fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

#[tauri::command]
fn quit(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn crash_reports(state: tauri::State<'_, AppState>) -> Vec<PathBuf> {
    std::fs::read_dir(state.data.crash_dir())
        .map(|rd| rd.filter_map(Result::ok).map(|e| e.path()).collect())
        .unwrap_or_default()
}

// ------------------------------------------------------------------ windows

pub fn ensure_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let _ = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("Alchemist")
        .inner_size(1280.0, 820.0)
        .min_inner_size(900.0, 600.0)
        .decorations(true)
        .visible(true)
        .build();
}

/// After the web view is gone, hand unused pages back to the OS so the
/// tray-only process stays inside the idle memory budget.
fn trim_memory_later() {
    std::thread::spawn(|| {
        std::thread::sleep(std::time::Duration::from_secs(3));
        #[cfg(windows)]
        unsafe {
            use windows_sys::Win32::System::ProcessStatus::K32EmptyWorkingSet;
            use windows_sys::Win32::System::Threading::GetCurrentProcess;
            K32EmptyWorkingSet(GetCurrentProcess());
        }
    });
}

fn toggle_recording(app: &AppHandle) {
    let state = app.state::<AppState>();
    if state.recorder.is_recording() {
        let r = state.recorder.clone();
        let app2 = app.clone();
        let finished = state.finished.clone();
        tauri::async_runtime::spawn_blocking(move || {
            if let Ok(m) = r.stop() {
                *finished.lock() = Some(m);
            }
            if let Some(bar) = app2.get_webview_window("bar") {
                let _ = bar.destroy();
            }
            ensure_main(&app2);
            let _ = app2.emit("recording-finished", ());
        });
    } else {
        ensure_main(app);
        let _ = app.emit("hotkey", "record");
    }
}

fn install_crash_hook(dir: PathBuf) {
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let t = project::now();
        let report = format!(
            "Alchemist crash report\nversion: {}\nos: {}\ntime: {t}\n\n{info}\n\nThis file stays on your computer. Share it only if you want to.\n",
            env!("CARGO_PKG_VERSION"),
            recorder::current_os()
        );
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::write(dir.join(format!("crash-{t}.txt")), report);
        prev(info);
    }));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let data = paths::detect();
    install_crash_hook(data.crash_dir());
    let settings = Arc::new(Mutex::new(settings::load(&data.settings_file())));
    let recovered = recorder::recover(&data.recordings_dir());

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            ensure_main(app)
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        toggle_recording(app);
                    }
                })
                .build(),
        )
        .setup(move |app| {
            let handle = app.handle().clone();
            let font = app
                .path()
                .resolve(
                    "resources/Inter-Bold.ttf",
                    tauri::path::BaseDirectory::Resource,
                )
                .unwrap_or_else(|_| PathBuf::from("resources/Inter-Bold.ttf"));
            let emitter = handle.clone();
            let queue = jobs::Queue::new(Arc::new(move |job: &jobs::Job| {
                let _ = emitter.emit("job", job);
            }));
            let recorder = Arc::new(recorder::Recorder::new(data.recordings_dir()));
            let finished: Arc<Mutex<Option<recorder::Manifest>>> = Arc::new(Mutex::new(None));
            app.manage(AppState {
                data: data.clone(),
                queue,
                recorder: recorder.clone(),
                settings: settings.clone(),
                font,
                recovered: Mutex::new(recovered),
                finished: finished.clone(),
            });

            {
                use tauri_plugin_global_shortcut::GlobalShortcutExt;
                if let Err(e) = app.global_shortcut().register("CommandOrControl+Shift+R") {
                    log::warn!("global shortcut unavailable: {e}");
                }
            }

            // Tray: the only thing left running when the window is closed.
            use tauri::menu::{Menu, MenuItem};
            use tauri::tray::TrayIconBuilder;
            let open = MenuItem::with_id(app, "open", "Open Alchemist", true, None::<&str>)?;
            let rec = MenuItem::with_id(
                app,
                "record",
                "Start or stop recording",
                true,
                Some("CommandOrControl+Shift+R"),
            )?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &rec, &quit])?;
            let mut tray = TrayIconBuilder::with_id("main")
                .tooltip("Alchemist")
                .menu(&menu)
                .show_menu_on_left_click(false);
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.on_menu_event(|app, e| match e.id.as_ref() {
                "open" => ensure_main(app),
                "record" => toggle_recording(app),
                "quit" => app.exit(0),
                _ => {}
            })
            .on_tray_icon_event(|tray, e| {
                if let tauri::tray::TrayIconEvent::Click {
                    button: tauri::tray::MouseButton::Left,
                    button_state: tauri::tray::MouseButtonState::Up,
                    ..
                } = e
                {
                    ensure_main(tray.app_handle());
                }
            })
            .build(app)?;

            // Recording watchdog: auto-stop by time, size or low disk.
            let app2 = handle.clone();
            std::thread::Builder::new()
                .name("alchemist-watch".into())
                .spawn(move || loop {
                    std::thread::sleep(std::time::Duration::from_secs(1));
                    if recorder.auto_stop_due() {
                        if let Ok(m) = recorder.stop() {
                            *finished.lock() = Some(m);
                            if let Some(bar) = app2.get_webview_window("bar") {
                                let _ = bar.destroy();
                            }
                            ensure_main(&app2);
                            let _ = app2.emit("recording-finished", ());
                        }
                    }
                    if let Some(st) = recorder.status() {
                        let _ = app2.emit("record-status", st);
                    }
                })?;

            ensure_main(&handle);
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the main window frees the web view; the tray stays.
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let w = window.clone();
                    let _ = w.destroy();
                    trim_memory_later();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            capabilities,
            check_limits,
            probe,
            settings_get,
            settings_set,
            convert_start,
            convert_preview,
            size_plan,
            jobs_list,
            job_cancel,
            jobs_clear,
            is_busy,
            monitors,
            windows_list,
            record_start,
            record_stop,
            recording_ui_done,
            take_finished_recording,
            record_pause,
            record_resume,
            record_cancel,
            record_status,
            recovered_recordings,
            open_area_picker,
            area_picked,
            project_new,
            project_save,
            project_load,
            project_open_file,
            project_list,
            project_delete,
            history_save,
            history_load,
            project_package,
            project_relink,
            media_import,
            project_from_recording,
            export_start,
            detect_silence,
            auto_zoom,
            waveform,
            thumbnail,
            make_proxy,
            captions_export,
            captions_import,
            read_text_file,
            file_exists,
            file_size,
            quit,
            crash_reports
        ])
        .build(tauri::generate_context!())
        .expect("error while building Alchemist")
        .run(|_app, event| {
            if let RunEvent::ExitRequested { api, code, .. } = event {
                // Keep running in the tray when the last window closes.
                if code.is_none() {
                    api.prevent_exit();
                }
            }
        });
}
