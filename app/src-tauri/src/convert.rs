//! Convert, compress and enhance: turns a request into FFmpeg arguments.
//! Pure functions only, so every decision here is unit-tested.

use crate::ffmpeg::{Capabilities, MediaInfo};
use crate::limits::{self, FitMode, VideoSettings};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const AUDIO_KBPS: f64 = 128.0;
/// Leave headroom so container overhead never pushes a file over the limit.
pub const SIZE_SAFETY: f64 = 0.95;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Container {
    Mp4,
    Webm,
    Mov,
    Mkv,
    Gif,
    Mp3,
    M4a,
    Wav,
}

impl Container {
    pub fn ext(self) -> &'static str {
        match self {
            Container::Mp4 => "mp4",
            Container::Webm => "webm",
            Container::Mov => "mov",
            Container::Mkv => "mkv",
            Container::Gif => "gif",
            Container::Mp3 => "mp3",
            Container::M4a => "m4a",
            Container::Wav => "wav",
        }
    }
    pub fn audio_only(self) -> bool {
        matches!(self, Container::Mp3 | Container::M4a | Container::Wav)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Quality {
    Smaller,
    Same,
    Best,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnhanceOptions {
    pub sharpen: bool,
    pub denoise: bool,
    pub stabilize: bool,
    pub upscale: bool,
    pub deinterlace: bool,
    pub hdr_to_sdr: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "goal", rename_all = "camelCase")]
pub enum Goal {
    /// Make the file fit under a size in megabytes (MiB).
    #[serde(rename_all = "camelCase")]
    TargetSize { target_mb: f64 },
    #[serde(rename_all = "camelCase")]
    Format {
        container: Container,
        quality: Quality,
    },
    #[serde(rename_all = "camelCase")]
    Enhance { options: EnhanceOptions },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertRequest {
    pub input: PathBuf,
    pub output: Option<PathBuf>,
    pub goal: Goal,
    /// Optional resolution/fps override (clamped to the hard limits).
    pub video: Option<VideoSettings>,
    #[serde(default = "default_fit")]
    pub fit: FitMode,
    /// Seconds into the file and length, for previews and range exports.
    pub start: Option<f64>,
    pub length: Option<f64>,
    #[serde(default = "yes")]
    pub use_hardware: bool,
    #[serde(default = "yes")]
    pub keep_metadata: bool,
}

fn default_fit() -> FitMode {
    FitMode::Fit
}
fn yes() -> bool {
    true
}

/// Plan for a target-size encode: the maths, made visible to the user.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SizePlan {
    pub video_kbps: f64,
    pub audio_kbps: f64,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub label: String,
    /// True when even the lowest sensible quality cannot fit (very long videos).
    pub too_small: bool,
}

/// Work out bitrate, resolution and frame rate for a size target.
pub fn plan_target_size(info: &MediaInfo, target_mb: f64) -> SizePlan {
    let duration = info.duration.max(0.1);
    let total_kbps = target_mb * 8.0 * 1024.0 * SIZE_SAFETY / duration;
    let audio_kbps = if !info.has_audio {
        0.0
    } else if total_kbps < 400.0 {
        64.0
    } else {
        AUDIO_KBPS
    };
    let video_kbps = (total_kbps - audio_kbps).max(0.0);
    let (src_w, src_h) = if info.width > 0 {
        (info.width, info.height)
    } else {
        (1920, 1080)
    };
    let src_fps = if info.fps > 0.0 { info.fps } else { 30.0 };

    // Target height by bitrate (H.264-class rules of thumb), never above source.
    let (max_h, max_fps) = if video_kbps >= 4500.0 {
        (1080, 60.0)
    } else if video_kbps >= 2200.0 {
        (1080, 30.0)
    } else if video_kbps >= 900.0 {
        (720, 30.0)
    } else if video_kbps >= 400.0 {
        (480, 30.0)
    } else {
        (360, 24.0)
    };
    let short = src_w.min(src_h);
    let target_short = short.min(max_h);
    let scale = target_short as f64 / short as f64;
    let mut w = ((src_w as f64 * scale) / 2.0).round() as u32 * 2;
    let mut h = ((src_h as f64 * scale) / 2.0).round() as u32 * 2;
    let c = limits::clamp_video(VideoSettings {
        width: w,
        height: h,
        fps: src_fps.min(max_fps),
    });
    w = c.value.width;
    h = c.value.height;
    let fps = c.value.fps;
    SizePlan {
        video_kbps,
        audio_kbps,
        width: w,
        height: h,
        fps,
        label: format!("{}p, {} fps", w.min(h), fps.round()),
        too_small: video_kbps < 80.0,
    }
}

pub fn default_output(input: &Path, ext: &str, suffix: &str) -> PathBuf {
    let stem = input
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "video".into());
    let dir = input.parent().map(Path::to_path_buf).unwrap_or_default();
    let mut candidate = dir.join(format!("{stem}{suffix}.{ext}"));
    let mut n = 2;
    while candidate.exists() {
        candidate = dir.join(format!("{stem}{suffix} ({n}).{ext}"));
        n += 1;
    }
    candidate
}

/// Can we change container without re-encoding?
pub fn can_remux(info: &MediaInfo, to: Container) -> bool {
    let v = info.video_codec.as_deref().unwrap_or("");
    let a = info.audio_codec.as_deref().unwrap_or("aac");
    match to {
        Container::Mkv => true,
        Container::Mp4 | Container::Mov => {
            matches!(v, "h264" | "hevc" | "av1" | "mpeg4")
                && matches!(a, "aac" | "mp3" | "ac3" | "alac" | "opus")
        }
        Container::Webm => matches!(v, "vp8" | "vp9" | "av1") && matches!(a, "opus" | "vorbis"),
        _ => false,
    }
}

pub struct VideoEncoder {
    pub args: Vec<String>,
    pub name: String,
    pub hardware: bool,
}

fn s(v: &str) -> String {
    v.to_string()
}

/// Pick an H.264 encoder: hardware first (if allowed and it really works), then x264.
pub fn h264_encoder(
    caps: &Capabilities,
    use_hw: bool,
    kbps: Option<f64>,
    quality: Quality,
) -> VideoEncoder {
    if use_hw {
        if let Some(hw) = &caps.hw_h264 {
            let mut args = vec![s("-c:v"), hw.clone()];
            match kbps {
                Some(k) => args.extend([
                    s("-b:v"),
                    format!("{}k", k.round()),
                    s("-maxrate"),
                    format!("{}k", (k * 1.15).round()),
                    s("-bufsize"),
                    format!("{}k", (k * 2.0).round()),
                ]),
                None => {
                    let q = match quality {
                        Quality::Smaller => "30",
                        Quality::Same => "23",
                        Quality::Best => "19",
                    };
                    if hw.contains("nvenc") {
                        args.extend([s("-rc"), s("vbr"), s("-cq"), s(q)]);
                    } else if hw.contains("qsv") {
                        args.extend([s("-global_quality"), s(q)]);
                    } else if hw.contains("videotoolbox") {
                        args.extend([
                            s("-q:v"),
                            s(match quality {
                                Quality::Smaller => "45",
                                Quality::Same => "60",
                                Quality::Best => "75",
                            }),
                        ]);
                    } else {
                        args.extend([
                            s("-b:v"),
                            s(match quality {
                                Quality::Smaller => "2500k",
                                Quality::Same => "6000k",
                                Quality::Best => "12000k",
                            }),
                        ]);
                    }
                }
            }
            args.extend([s("-pix_fmt"), s("yuv420p")]);
            return VideoEncoder {
                args,
                name: hw.clone(),
                hardware: true,
            };
        }
    }
    let enc = if caps.has_encoder("libx264") {
        "libx264"
    } else if caps.has_encoder("libopenh264") {
        "libopenh264"
    } else {
        "mpeg4"
    };
    let mut args = vec![s("-c:v"), s(enc)];
    match kbps {
        Some(k) => args.extend([s("-b:v"), format!("{}k", k.round())]),
        None if enc == "libx264" => {
            let crf = match quality {
                Quality::Smaller => "28",
                Quality::Same => "22",
                Quality::Best => "18",
            };
            args.extend([s("-crf"), s(crf)]);
        }
        None => args.extend([s("-q:v"), s("4")]),
    }
    if enc == "libx264" {
        args.extend([s("-preset"), s("medium")]);
    }
    args.extend([s("-pix_fmt"), s("yuv420p")]);
    VideoEncoder {
        args,
        name: enc.into(),
        hardware: false,
    }
}

fn enhance_filters(
    o: &EnhanceOptions,
    info: &MediaInfo,
    caps: Option<&Capabilities>,
) -> Vec<String> {
    let mut f = Vec::new();
    if o.deinterlace {
        f.push(s("bwdif=mode=send_frame:deint=interlaced"));
    }
    if o.hdr_to_sdr {
        // zscale/tonemap need libzimg; fall back to a simple, honest curve otherwise.
        if caps.map(|c| c.has_filter("zscale")).unwrap_or(false) {
            f.push(s("zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p"));
        } else {
            f.push(s("colorspace=all=bt709:iall=bt2020:fast=1"));
        }
    }
    if o.stabilize {
        f.push(s("deshake=rx=32:ry=32"));
    }
    if o.denoise {
        f.push(s("hqdn3d=3:2:4:3"));
    }
    if o.upscale {
        let (w, h) = (info.width.max(2), info.height.max(2));
        let c = limits::clamp_video(VideoSettings {
            width: w * 2,
            height: h * 2,
            fps: 30.0,
        })
        .value;
        f.push(format!("scale={}:{}:flags=lanczos", c.width, c.height));
    }
    if o.sharpen {
        f.push(s("unsharp=5:5:0.8:3:3:0.4"));
    }
    f
}

/// Full argument list for one conversion pass. `pass` is Some((n, logfile))
/// for two-pass x264 target-size encodes.
pub fn build_args(
    req: &ConvertRequest,
    info: &MediaInfo,
    caps: &Capabilities,
    output: &Path,
    pass: Option<(u8, &Path)>,
) -> Vec<String> {
    let mut a: Vec<String> = Vec::new();
    if let Some(st) = req.start {
        a.extend([s("-ss"), format!("{st:.3}")]);
    }
    a.push(s("-i"));
    a.push(req.input.to_string_lossy().to_string());
    if let Some(len) = req.length {
        a.extend([s("-t"), format!("{len:.3}")]);
    }

    let mut vf: Vec<String> = Vec::new();
    let mut fps_override: Option<f64> = None;
    if let Some(v) = req.video {
        let c = limits::clamp_video(v).value;
        vf.push(limits::scale_filter(c.width, c.height, req.fit));
        fps_override = Some(c.fps);
    }

    match &req.goal {
        Goal::TargetSize { target_mb } => {
            let plan = plan_target_size(info, *target_mb);
            if req.video.is_none() && (plan.width != info.width || plan.height != info.height) {
                vf.push(format!(
                    "scale={}:{}:flags=lanczos",
                    plan.width, plan.height
                ));
            }
            if req.video.is_none() && info.fps > plan.fps + 0.5 {
                fps_override = Some(plan.fps);
            }
            let two_pass = pass.is_some();
            let mut enc = h264_encoder(
                caps,
                req.use_hardware && !two_pass,
                Some(plan.video_kbps),
                Quality::Same,
            );
            a.extend([s("-map"), s("0:v:0")]);
            if !vf.is_empty() {
                a.extend([s("-vf"), vf.join(",")]);
            }
            if let Some(f) = fps_override {
                a.extend([s("-r"), limits::fps_to_ffmpeg(f)]);
            }
            if let Some((n, log)) = pass {
                enc.args.extend([
                    s("-pass"),
                    n.to_string(),
                    s("-passlogfile"),
                    log.to_string_lossy().to_string(),
                ]);
            }
            a.extend(enc.args);
            if pass.map(|p| p.0) == Some(1) {
                a.extend([s("-an"), s("-f"), s("mp4"), null_sink()]);
                return a;
            }
            if info.has_audio {
                a.extend([
                    s("-map"),
                    s("0:a:0"),
                    s("-c:a"),
                    s("aac"),
                    s("-b:a"),
                    format!("{}k", plan.audio_kbps.round()),
                ]);
            }
            a.extend([s("-movflags"), s("+faststart")]);
        }
        Goal::Format { container, quality } => {
            let c = *container;
            if c == Container::Gif {
                let fps = fps_override.unwrap_or(15.0).min(30.0);
                let scale = if req.video.is_some() {
                    vf.join(",")
                } else {
                    s("scale='min(720,iw)':-2:flags=lanczos")
                };
                a.extend([
                    s("-filter_complex"),
                    format!("[0:v]fps={},{scale},split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a", limits::fps_to_ffmpeg(fps)),
                    s("-loop"), s("0"),
                ]);
            } else if c.audio_only() {
                a.extend([s("-vn"), s("-map"), s("0:a:0")]);
                match c {
                    Container::Mp3 => a.extend([
                        s("-c:a"),
                        s("libmp3lame"),
                        s("-q:a"),
                        s(match quality {
                            Quality::Smaller => "5",
                            Quality::Same => "2",
                            Quality::Best => "0",
                        }),
                    ]),
                    Container::M4a => a.extend([
                        s("-c:a"),
                        s("aac"),
                        s("-b:a"),
                        s(match quality {
                            Quality::Smaller => "96k",
                            Quality::Same => "192k",
                            Quality::Best => "256k",
                        }),
                    ]),
                    _ => a.extend([s("-c:a"), s("pcm_s16le")]),
                }
            } else if vf.is_empty()
                && fps_override.is_none()
                && *quality == Quality::Same
                && can_remux(info, c)
            {
                // Lossless container change: seconds instead of minutes, zero quality loss.
                a.extend([s("-map"), s("0"), s("-c"), s("copy")]);
                if c == Container::Mp4 || c == Container::Mov {
                    a.extend([s("-c:s"), s("mov_text")]);
                }
            } else {
                a.extend([s("-map"), s("0:v:0"), s("-map"), s("0:a?")]);
                if !vf.is_empty() {
                    a.extend([s("-vf"), vf.join(",")]);
                }
                if let Some(f) = fps_override {
                    a.extend([s("-r"), limits::fps_to_ffmpeg(f)]);
                }
                if c == Container::Webm {
                    let crf = match quality {
                        Quality::Smaller => "38",
                        Quality::Same => "32",
                        Quality::Best => "26",
                    };
                    if caps.has_encoder("libvpx-vp9") {
                        a.extend([
                            s("-c:v"),
                            s("libvpx-vp9"),
                            s("-crf"),
                            s(crf),
                            s("-b:v"),
                            s("0"),
                            s("-row-mt"),
                            s("1"),
                            s("-deadline"),
                            s("good"),
                            s("-cpu-used"),
                            s("4"),
                        ]);
                    } else {
                        a.extend([
                            s("-c:v"),
                            s("libvpx"),
                            s("-crf"),
                            s("10"),
                            s("-b:v"),
                            s("4M"),
                        ]);
                    }
                    a.extend([s("-c:a"), s("libopus"), s("-b:a"), s("128k")]);
                } else {
                    a.extend(h264_encoder(caps, req.use_hardware, None, *quality).args);
                    a.extend([s("-c:a"), s("aac"), s("-b:a"), s("160k")]);
                    if c == Container::Mkv {
                        a.extend([s("-map"), s("0:s?"), s("-c:s"), s("copy")]);
                    } else {
                        a.extend([s("-map"), s("0:s?"), s("-c:s"), s("mov_text")]);
                    }
                    if c == Container::Mp4 || c == Container::Mov {
                        a.extend([s("-movflags"), s("+faststart")]);
                    }
                }
            }
        }
        Goal::Enhance { options } => {
            vf.extend(enhance_filters(options, info, Some(caps)));
            a.extend([s("-map"), s("0:v:0"), s("-map"), s("0:a?")]);
            if !vf.is_empty() {
                a.extend([s("-vf"), vf.join(",")]);
            }
            if let Some(f) = fps_override {
                a.extend([s("-r"), limits::fps_to_ffmpeg(f)]);
            }
            a.extend(h264_encoder(caps, req.use_hardware, None, Quality::Best).args);
            a.extend([s("-c:a"), s("copy"), s("-movflags"), s("+faststart")]);
        }
    }
    if req.keep_metadata {
        a.extend([s("-map_metadata"), s("0"), s("-map_chapters"), s("0")]);
    }
    a.push(output.to_string_lossy().to_string());
    a
}

pub fn null_sink() -> String {
    if cfg!(windows) {
        s("NUL")
    } else {
        s("/dev/null")
    }
}

pub fn output_container(req: &ConvertRequest) -> Container {
    match &req.goal {
        Goal::TargetSize { .. } | Goal::Enhance { .. } => Container::Mp4,
        Goal::Format { container, .. } => *container,
    }
}

pub fn output_suffix(req: &ConvertRequest) -> String {
    match &req.goal {
        Goal::TargetSize { target_mb } => format!(" ({} MB)", target_mb.round()),
        Goal::Format { .. } => String::new(),
        Goal::Enhance { .. } => " (enhanced)".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info() -> MediaInfo {
        MediaInfo {
            duration: 180.0,
            width: 1920,
            height: 1080,
            fps: 59.94,
            video_codec: Some("h264".into()),
            audio_codec: Some("aac".into()),
            has_video: true,
            has_audio: true,
            audio_streams: 1,
            ..Default::default()
        }
    }
    fn caps(x264: bool, hw: Option<&str>) -> Capabilities {
        let mut c = Capabilities::default();
        if x264 {
            c.encoders.push("libx264".into());
        }
        c.encoders.push("libvpx-vp9".into());
        c.hw_h264 = hw.map(String::from);
        c
    }
    fn req(goal: Goal) -> ConvertRequest {
        ConvertRequest {
            input: "in.mov".into(),
            output: None,
            goal,
            video: None,
            fit: FitMode::Fit,
            start: None,
            length: None,
            use_hardware: true,
            keep_metadata: true,
        }
    }

    #[test]
    fn target_size_maths_is_under_the_limit() {
        let p = plan_target_size(&info(), 25.0);
        let total = (p.video_kbps + p.audio_kbps) * 180.0 / 8.0 / 1024.0;
        assert!(total <= 25.0, "planned {total} MB");
        assert!(total >= 25.0 * 0.9);
        assert_eq!((p.width, p.height), (1280, 720));
        assert_eq!(p.fps, 30.0);
        assert!(!p.too_small);
    }

    #[test]
    fn target_size_keeps_resolution_when_budget_allows() {
        let p = plan_target_size(&info(), 400.0);
        assert_eq!((p.width, p.height), (1920, 1080));
        assert!((p.fps - 59.94).abs() < 0.01);
    }

    #[test]
    fn target_size_vertical_video_scales_the_short_side() {
        let mut i = info();
        i.width = 1080;
        i.height = 1920;
        let p = plan_target_size(&i, 25.0);
        assert_eq!((p.width, p.height), (720, 1280));
    }

    #[test]
    fn hopeless_targets_are_flagged() {
        let mut i = info();
        i.duration = 7200.0;
        assert!(plan_target_size(&i, 5.0).too_small);
    }

    #[test]
    fn remux_rules() {
        assert!(can_remux(&info(), Container::Mp4));
        assert!(can_remux(&info(), Container::Mkv));
        assert!(!can_remux(&info(), Container::Webm));
    }

    #[test]
    fn mov_to_mp4_same_quality_is_lossless_copy() {
        let a = build_args(
            &req(Goal::Format {
                container: Container::Mp4,
                quality: Quality::Same,
            }),
            &info(),
            &caps(true, None),
            Path::new("out.mp4"),
            None,
        );
        let j = a.join(" ");
        assert!(j.contains("-c copy"), "{j}");
        assert!(!j.contains("libx264"));
    }

    #[test]
    fn webm_uses_vp9_and_opus() {
        let j = build_args(
            &req(Goal::Format {
                container: Container::Webm,
                quality: Quality::Same,
            }),
            &info(),
            &caps(true, None),
            Path::new("o.webm"),
            None,
        )
        .join(" ");
        assert!(j.contains("libvpx-vp9") && j.contains("libopus"));
    }

    #[test]
    fn gif_uses_palette() {
        let j = build_args(
            &req(Goal::Format {
                container: Container::Gif,
                quality: Quality::Same,
            }),
            &info(),
            &caps(true, None),
            Path::new("o.gif"),
            None,
        )
        .join(" ");
        assert!(j.contains("palettegen") && j.contains("paletteuse"));
    }

    #[test]
    fn mp3_extracts_audio() {
        let j = build_args(
            &req(Goal::Format {
                container: Container::Mp3,
                quality: Quality::Same,
            }),
            &info(),
            &caps(true, None),
            Path::new("o.mp3"),
            None,
        )
        .join(" ");
        assert!(j.contains("-vn") && j.contains("libmp3lame"));
    }

    #[test]
    fn hardware_is_preferred_and_software_is_fallback() {
        let r = req(Goal::Format {
            container: Container::Mp4,
            quality: Quality::Smaller,
        });
        let hw = build_args(
            &r,
            &info(),
            &caps(true, Some("h264_nvenc")),
            Path::new("o.mp4"),
            None,
        )
        .join(" ");
        assert!(hw.contains("h264_nvenc"));
        let mut r2 = r.clone();
        r2.use_hardware = false;
        let sw = build_args(
            &r2,
            &info(),
            &caps(true, Some("h264_nvenc")),
            Path::new("o.mp4"),
            None,
        )
        .join(" ");
        assert!(sw.contains("libx264") && sw.contains("-crf 28"));
    }

    #[test]
    fn two_pass_first_pass_writes_nothing() {
        let r = req(Goal::TargetSize { target_mb: 25.0 });
        let log = Path::new("pass");
        let p1 = build_args(
            &r,
            &info(),
            &caps(true, Some("h264_nvenc")),
            Path::new("o.mp4"),
            Some((1, log)),
        )
        .join(" ");
        assert!(p1.contains("-pass 1") && p1.contains("-an") && p1.contains("libx264"));
        assert!(p1.ends_with(&null_sink()));
        let p2 = build_args(
            &r,
            &info(),
            &caps(true, None),
            Path::new("o.mp4"),
            Some((2, log)),
        )
        .join(" ");
        assert!(p2.contains("-pass 2") && p2.contains("-c:a aac") && p2.contains("scale=1280:720"));
    }

    #[test]
    fn custom_resolution_is_clamped_everywhere() {
        let mut r = req(Goal::Format {
            container: Container::Mp4,
            quality: Quality::Same,
        });
        r.video = Some(VideoSettings {
            width: 99999,
            height: 721,
            fps: 500.0,
        });
        let j = build_args(&r, &info(), &caps(true, None), Path::new("o.mp4"), None).join(" ");
        assert!(j.contains("scale=7680:722"), "{j}");
        assert!(j.contains("-r 240"));
    }

    #[test]
    fn enhance_filters_in_order() {
        let o = EnhanceOptions {
            sharpen: true,
            denoise: true,
            stabilize: true,
            upscale: true,
            deinterlace: false,
            hdr_to_sdr: false,
        };
        let j = build_args(
            &req(Goal::Enhance { options: o }),
            &info(),
            &caps(true, None),
            Path::new("o.mp4"),
            None,
        )
        .join(" ");
        let d = j.find("deshake").unwrap();
        let n = j.find("hqdn3d").unwrap();
        let u = j.find("scale=3840:2160").unwrap();
        let sh = j.find("unsharp").unwrap();
        assert!(d < n && n < u && u < sh);
    }

    #[test]
    fn preview_range_is_applied() {
        let mut r = req(Goal::Format {
            container: Container::Mp4,
            quality: Quality::Smaller,
        });
        r.start = Some(10.0);
        r.length = Some(5.0);
        let a = build_args(&r, &info(), &caps(true, None), Path::new("o.mp4"), None);
        assert_eq!(&a[0..2], &["-ss".to_string(), "10.000".to_string()]);
        assert!(a.join(" ").contains("-t 5.000"));
    }

    #[test]
    fn output_names_never_overwrite() {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("clip.mov");
        let first = default_output(&input, "mp4", "");
        assert_eq!(first.file_name().unwrap(), "clip.mp4");
        std::fs::write(&first, b"x").unwrap();
        assert_eq!(
            default_output(&input, "mp4", "").file_name().unwrap(),
            "clip (2).mp4"
        );
    }
}
