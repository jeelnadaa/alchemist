//! Export: turns a project into one FFmpeg filter graph.
//!
//! The same project data drives the live preview in the editor, and every
//! effect here mirrors the preview's maths (zoom ramps, fades, positions), so
//! what you see is what you export.

use crate::convert::{self, Quality};
use crate::ffmpeg::Capabilities;
use crate::limits::{self, FitMode};
use crate::project::{Clip, Project, Track};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Preset {
    Share,
    Vertical,
    Small,
    Gif,
    Audio,
    Custom,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRequest {
    pub preset: Preset,
    pub output: PathBuf,
    #[serde(default)]
    pub range: Option<(f64, f64)>,
    #[serde(default)]
    pub width: Option<u32>,
    #[serde(default)]
    pub height: Option<u32>,
    #[serde(default)]
    pub fps: Option<f64>,
    #[serde(default)]
    pub burn_captions: bool,
    #[serde(default)]
    pub sidecar_captions: bool,
    #[serde(default)]
    pub loudness: bool,
    #[serde(default = "yes")]
    pub use_hardware: bool,
    #[serde(default)]
    pub target_mb: Option<f64>,
}

fn yes() -> bool {
    true
}

pub struct ExportPlan {
    pub args: Vec<String>,
    pub duration: f64,
    pub temp_files: Vec<PathBuf>,
}

fn f(v: f64) -> String {
    let s = format!("{v:.3}");
    let s = s.trim_end_matches('0').trim_end_matches('.').to_string();
    if s == "-0" {
        "0".into()
    } else {
        s
    }
}

/// Escape a path for use inside a filter argument (fontfile=…, textfile=…).
pub fn filter_path(p: &Path) -> String {
    let s = p.to_string_lossy().replace('\\', "/");
    s.replace(':', "\\:").replace('\'', "\\'")
}

fn hex_color(c: &str, fallback: &str) -> String {
    let c = c.trim();
    if c.len() == 7 && c.starts_with('#') && c[1..].chars().all(|ch| ch.is_ascii_hexdigit()) {
        format!("0x{}", &c[1..])
    } else {
        fallback.to_string()
    }
}

/// atempo only accepts 0.5–2.0, so chain it for other speeds.
pub fn atempo_chain(speed: f64) -> Vec<String> {
    let mut s = speed.clamp(0.0625, 16.0);
    let mut out = Vec::new();
    while s > 2.0 {
        out.push("atempo=2".to_string());
        s /= 2.0;
    }
    while s < 0.5 {
        out.push("atempo=0.5".to_string());
        s /= 0.5;
    }
    if (s - 1.0).abs() > 1e-6 {
        out.push(format!("atempo={}", f(s)));
    }
    out
}

/// Zoom level over time as an FFmpeg expression of `var` (seconds).
/// Each zoom ramps in and out over `ramp` seconds; mirrors `zoomAt()` in the UI.
pub fn zoom_expr(zooms: &[crate::project::Zoom], ramp: f64, var: &str) -> String {
    if zooms.is_empty() {
        return "1".into();
    }
    let r = ramp.max(0.05);
    let terms: Vec<String> = zooms
        .iter()
        .map(|z| {
            format!(
                "{}*clip(({var}-{})/{},0,1)*clip(({}-{var})/{},0,1)",
                f(z.scale - 1.0),
                f(z.start),
                f(r),
                f(z.end),
                f(r)
            )
        })
        .collect();
    format!("1+{}", terms.join("+"))
}

/// Focus point (fraction) over time; 0.5 when no zoom is active.
pub fn focus_expr(zooms: &[crate::project::Zoom], ramp: f64, axis_x: bool, var: &str) -> String {
    let mut e = "0.5".to_string();
    for z in zooms.iter().rev() {
        let v = if axis_x { z.x } else { z.y };
        e = format!(
            "if(between({var},{},{}),{},{e})",
            f(z.start - ramp),
            f(z.end + ramp),
            f(v.clamp(0.0, 1.0))
        );
    }
    e
}

struct Inputs {
    args: Vec<String>,
    index: HashMap<String, usize>,
}

fn collect_inputs(p: &Project, total: f64) -> Inputs {
    let mut args = Vec::new();
    let mut index = HashMap::new();
    for t in &p.tracks {
        for c in &t.clips {
            let Some(mid) = &c.media_id else { continue };
            if index.contains_key(mid) {
                continue;
            }
            let Some(m) = p.media(mid) else { continue };
            if m.kind == "image" {
                args.extend(["-loop".into(), "1".into(), "-t".into(), f(total.max(0.1))]);
            }
            args.extend(["-i".into(), m.path.to_string_lossy().to_string()]);
            index.insert(mid.clone(), index.len());
        }
    }
    Inputs { args, index }
}

fn video_chain(c: &Clip, input: usize, box_w: u32, box_h: u32, fps: f64) -> String {
    let mut ch = format!("[{input}:v]");
    let mut parts: Vec<String> = Vec::new();
    if c.freeze {
        parts.push(format!("trim=start={}", f(c.in_point)));
        parts.push("setpts=PTS-STARTPTS".into());
        parts.push("trim=end_frame=1".into());
        parts.push("loop=loop=-1:size=1:start=0".into());
        parts.push(format!("fps={}", limits::fps_to_ffmpeg(fps)));
        parts.push(format!("trim=duration={}", f(c.length())));
    } else {
        parts.push(format!("trim=start={}:end={}", f(c.in_point), f(c.out)));
        parts.push("setpts=PTS-STARTPTS".into());
        if c.reverse {
            parts.push("reverse".into());
        }
        if (c.speed - 1.0).abs() > 1e-6 {
            parts.push(format!("setpts=PTS/{}", f(c.speed)));
        }
        parts.push(format!("fps={}", limits::fps_to_ffmpeg(fps)));
    }
    let t = &c.transform;
    if let Some([x, y, w, h]) = t.crop {
        parts.push(format!(
            "crop=iw*{}:ih*{}:iw*{}:ih*{}",
            f(w),
            f(h),
            f(x),
            f(y)
        ));
    }
    match t.rotate.rem_euclid(360) {
        90 => parts.push("transpose=1".into()),
        180 => parts.push("transpose=1,transpose=1".into()),
        270 => parts.push("transpose=2".into()),
        _ => {}
    }
    if t.flip_h {
        parts.push("hflip".into());
    }
    if t.flip_v {
        parts.push("vflip".into());
    }
    let sc = if t.scale > 0.0 { t.scale } else { 1.0 };
    let (bw, bh) = (
        ((box_w as f64 * sc) as u32 / 2 * 2).max(2),
        ((box_h as f64 * sc) as u32 / 2 * 2).max(2),
    );
    parts.push(format!(
        "scale={bw}:{bh}:force_original_aspect_ratio=decrease:flags=lanczos"
    ));
    parts.push("format=yuva420p".into());
    if c.fade_in > 0.0 {
        parts.push(format!("fade=t=in:st=0:d={}:alpha=1", f(c.fade_in)));
    }
    if c.fade_out > 0.0 {
        parts.push(format!(
            "fade=t=out:st={}:d={}:alpha=1",
            f((c.length() - c.fade_out).max(0.0)),
            f(c.fade_out)
        ));
    }
    parts.push(format!("setpts=PTS+{}/TB", f(c.start)));
    ch.push_str(&parts.join(","));
    ch
}

fn text_y(position: &str) -> &'static str {
    match position {
        "top" => "h*0.08",
        "middle" => "(h-text_h)/2",
        _ => "h-text_h-h*0.08",
    }
}

/// Clips of one track with transitions applied: a crossfade starts the clip
/// earlier (reaching back into its source) with a fade-in over the clip
/// before; a dip fades the previous clip out and this one in. Ends never move.
/// Returns (clip, extra seconds added before its original start).
pub fn with_transitions(track: &Track) -> Vec<(Clip, f64)> {
    let mut out: Vec<(Clip, f64)> = track.clips.iter().map(|c| (c.clone(), 0.0)).collect();
    out.sort_by(|a, b| {
        a.0.start
            .partial_cmp(&b.0.start)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    for i in 1..out.len() {
        let Some(tr) = out[i].0.transition_in.clone() else {
            continue;
        };
        let d = tr.duration.max(0.0);
        if d <= 0.0 {
            continue;
        }
        let prev_end = out[i - 1].0.end();
        if (prev_end - out[i].0.start).abs() > 0.05 {
            continue; // only between touching clips
        }
        match tr.kind.as_str() {
            "dip" => {
                let half = d / 2.0;
                let prev_len = out[i - 1].0.length();
                let len = out[i].0.length();
                out[i - 1].0.fade_out = out[i - 1].0.fade_out.max(half.min(prev_len / 2.0));
                out[i].0.fade_in = out[i].0.fade_in.max(half.min(len / 2.0));
            }
            _ => {
                let c = &out[i].0;
                if c.freeze || c.reverse {
                    continue;
                }
                let available = c.in_point / c.speed.max(0.01);
                let d = d
                    .min(available)
                    .min(out[i - 1].0.length() / 2.0)
                    .min(c.length() / 2.0);
                if d < 0.04 {
                    continue;
                }
                let c = &mut out[i].0;
                c.start -= d;
                c.in_point -= d * c.speed;
                c.fade_in = c.fade_in.max(d);
                out[i].1 = d;
                out[i - 1].0.fade_out = out[i - 1].0.fade_out.max(d);
            }
        }
    }
    out
}

/// Volume over clip-local time as an FFmpeg expression of `t` (seconds since
/// the clip's audio starts). `offset` shifts keys when a transition starts the clip early.
pub fn volume_expr(base: f64, keys: &[crate::project::VolumeKey], offset: f64) -> String {
    if keys.is_empty() {
        return f(base);
    }
    let mut k: Vec<_> = keys.to_vec();
    k.sort_by(|a, b| a.t.partial_cmp(&b.t).unwrap_or(std::cmp::Ordering::Equal));
    let tt = |x: f64| f(x + offset);
    let mut e = f(k.last().unwrap().v.max(0.0));
    for i in (0..k.len()).rev() {
        if i == 0 {
            e = format!("if(lt(t,{}),{},{e})", tt(k[0].t), f(k[0].v.max(0.0)));
        } else {
            let (a, b) = (k[i - 1], k[i]);
            let span = (b.t - a.t).max(1e-3);
            e = format!(
                "if(lt(t,{}),{}+({}-{})*(t-{})/{},{e})",
                tt(b.t),
                f(a.v.max(0.0)),
                f(b.v.max(0.0)),
                f(a.v.max(0.0)),
                tt(a.t),
                f(span)
            );
        }
    }
    format!("{}*({e})", f(base))
}

/// Draw an arrow from (x1,y1) to (x2,y2) into a transparent RGBA canvas and save it as PNG.
pub fn arrow_png(
    path: &Path,
    w: u32,
    h: u32,
    from: (f64, f64),
    to: (f64, f64),
    rgb: (u8, u8, u8),
) -> Result<(), String> {
    let mut buf = vec![0u8; (w * h * 4) as usize];
    let th = (h as f64 * 0.009).max(3.0);
    let (dx, dy) = (to.0 - from.0, to.1 - from.1);
    let len = (dx * dx + dy * dy).sqrt().max(1.0);
    let (ux, uy) = (dx / len, dy / len);
    let head_len = (th * 5.0).min(len * 0.6);
    let head_w = th * 3.2;
    let base = (to.0 - ux * head_len, to.1 - uy * head_len);
    let left = (base.0 - uy * head_w, base.1 + ux * head_w);
    let right = (base.0 + uy * head_w, base.1 - ux * head_w);
    let minx = (from.0.min(to.0).min(left.0).min(right.0) - th * 2.0)
        .floor()
        .max(0.0) as u32;
    let maxx = (from.0.max(to.0).max(left.0).max(right.0) + th * 2.0)
        .ceil()
        .min(w as f64 - 1.0)
        .max(0.0) as u32;
    let miny = (from.1.min(to.1).min(left.1).min(right.1) - th * 2.0)
        .floor()
        .max(0.0) as u32;
    let maxy = (from.1.max(to.1).max(left.1).max(right.1) + th * 2.0)
        .ceil()
        .min(h as f64 - 1.0)
        .max(0.0) as u32;
    let sign = |p: (f64, f64), a: (f64, f64), b: (f64, f64)| {
        (p.0 - b.0) * (a.1 - b.1) - (a.0 - b.0) * (p.1 - b.1)
    };
    for y in miny..=maxy {
        for x in minx..=maxx {
            // 4x supersampling for smooth edges.
            let mut cover = 0.0;
            for sy in 0..2 {
                for sx in 0..2 {
                    let px = x as f64 + 0.25 + sx as f64 * 0.5;
                    let py = y as f64 + 0.25 + sy as f64 * 0.5;
                    // Shaft: distance to segment from..base.
                    let (bx, by) = (base.0 - from.0, base.1 - from.1);
                    let l2 = (bx * bx + by * by).max(1e-9);
                    let tt = (((px - from.0) * bx + (py - from.1) * by) / l2).clamp(0.0, 1.0);
                    let (cx, cy) = (from.0 + bx * tt, from.1 + by * tt);
                    let in_shaft = ((px - cx).powi(2) + (py - cy).powi(2)).sqrt() <= th / 2.0;
                    let p = (px, py);
                    let d1 = sign(p, to, left);
                    let d2 = sign(p, left, right);
                    let d3 = sign(p, right, to);
                    let neg = d1 < 0.0 || d2 < 0.0 || d3 < 0.0;
                    let pos = d1 > 0.0 || d2 > 0.0 || d3 > 0.0;
                    if in_shaft || !(neg && pos) {
                        cover += 0.25;
                    }
                }
            }
            if cover > 0.0 {
                let i = ((y * w + x) * 4) as usize;
                buf[i] = rgb.0;
                buf[i + 1] = rgb.1;
                buf[i + 2] = rgb.2;
                buf[i + 3] = (cover * 255.0) as u8;
            }
        }
    }
    let file = std::fs::File::create(path).map_err(|e| e.to_string())?;
    let mut enc = png::Encoder::new(std::io::BufWriter::new(file), w, h);
    enc.set_color(png::ColorType::Rgba);
    enc.set_depth(png::BitDepth::Eight);
    enc.write_header()
        .and_then(|mut wr| wr.write_image_data(&buf))
        .map_err(|e| e.to_string())
}

fn rgb_of(hex: &str) -> (u8, u8, u8) {
    let c = hex.trim_start_matches('#');
    if c.len() == 6 {
        if let Ok(n) = u32::from_str_radix(c, 16) {
            return ((n >> 16) as u8, (n >> 8) as u8, n as u8);
        }
    }
    (0x5b, 0x8c, 0xff)
}

/// Where the main picture sits inside the padded box (x, y, w, h).
fn content_rect(p: &Project, w: u32, h: u32, box_w: u32, box_h: u32) -> (u32, u32, u32, u32) {
    let main_media = p
        .tracks
        .iter()
        .filter(|t| t.kind == "video")
        .flat_map(|t| t.clips.iter())
        .find_map(|c| {
            c.media_id
                .as_ref()
                .and_then(|id| p.media(id))
                .map(|m| (m, c.transform.rotate.rem_euclid(180) == 90))
        });
    let (cw, ch) = match main_media {
        Some((m, rotated)) if m.width > 0 && m.height > 0 => {
            let (mw, mh) = if rotated {
                (m.height as f64, m.width as f64)
            } else {
                (m.width as f64, m.height as f64)
            };
            let s = (box_w as f64 / mw).min(box_h as f64 / mh);
            (
                ((mw * s).round() as u32).min(box_w),
                ((mh * s).round() as u32).min(box_h),
            )
        }
        _ => (box_w, box_h),
    };
    ((w - cw) / 2, (h - ch) / 2, cw, ch)
}

/// Build the full export. `font` is a TTF bundled with the app; `tmp` is a
/// scratch folder for text files (avoids all drawtext escaping problems).
pub fn build(
    p: &Project,
    req: &ExportRequest,
    caps: &Capabilities,
    font: &Path,
    tmp: &Path,
) -> Result<ExportPlan, String> {
    let total = p.duration();
    if total <= 0.0 {
        return Err("The timeline is empty. Add a video first.".into());
    }
    let (range_start, range_end) = req
        .range
        .unwrap_or((p.in_point.unwrap_or(0.0), p.out_point.unwrap_or(total)));
    let range_end = range_end.min(total);
    if range_end - range_start < 0.05 {
        return Err("The export range is empty.".into());
    }
    let duration = range_end - range_start;

    // Output frame.
    let (mut w, mut h) = (p.settings.width, p.settings.height);
    let mut fps = p.settings.fps;
    let mut fit = FitMode::Fit;
    match req.preset {
        Preset::Vertical => {
            w = 1080;
            h = 1920;
            fit = FitMode::Fill;
        }
        Preset::Gif => {
            let s = 720.0 / w.max(h) as f64;
            if s < 1.0 {
                w = ((w as f64 * s) as u32 / 2 * 2).max(2);
                h = ((h as f64 * s) as u32 / 2 * 2).max(2);
            }
            fps = fps.min(15.0);
        }
        _ => {}
    }
    if let (Some(rw), Some(rh)) = (req.width, req.height) {
        w = rw;
        h = rh;
    }
    if let Some(rf) = req.fps {
        fps = rf;
    }
    let c = limits::clamp_video(limits::VideoSettings {
        width: w,
        height: h,
        fps,
    })
    .value;
    let (w, h, fps) = (c.width, c.height, c.fps);

    let inputs = collect_inputs(p, total);
    let mut g = String::new();
    let mut temp_files = Vec::new();
    let pad = p.settings.padding.min(w.min(h) / 3);
    let (box_w, box_h) = (w - 2 * pad, h - 2 * pad);
    let bg = hex_color(&p.settings.background, "black");

    // 1. Canvas.
    let _ = write!(
        g,
        "color=c={bg}:s={w}x{h}:r={}:d={}[base]",
        limits::fps_to_ffmpeg(fps),
        f(total)
    );
    let mut last = "base".to_string();
    let mut k = 0;
    let (cx, cy, cw, ch) = content_rect(p, w, h, box_w, box_h);

    // 1b. Soft drop shadow under the picture, made once and looped.
    if p.settings.shadow && pad > 0 {
        let off = (h / 90).max(2);
        let blur = ((pad / 2).max(4)).min(((cw.min(ch)) / 4).max(2)).min(40);
        let _ = write!(
            g,
            ";color=c=black:s={w}x{h}:r={}:d=0.1,format=rgba,geq=r=0:g=0:b=0:a='if(between(X\\,{}\\,{})*between(Y\\,{}\\,{})\\,150\\,0)',boxblur=luma_radius={blur}:luma_power=2:alpha_radius={blur}:alpha_power=2,trim=end_frame=1,loop=loop=-1:size=1:start=0,trim=duration={}[shadow];[{last}][shadow]overlay=format=auto[shadowed]",
            limits::fps_to_ffmpeg(fps),
            cx,
            cx + cw,
            cy + off,
            cy + ch + off,
            f(total)
        );
        last = "shadowed".into();
    }

    // 2. Video tracks, bottom to top. Overlay tracks (camera, images) are
    //    added after the zoom so they stay put while the screen zooms.
    let place = |g: &mut String, last: &mut String, k: &mut usize, kinds: &[&str]| {
        let visual: Vec<&Track> = p
            .tracks
            .iter()
            .filter(|t| kinds.contains(&t.kind.as_str()))
            .collect();
        for t in &visual {
            for (c, _) in with_transitions(t) {
                let c = &c;
                let Some(mid) = &c.media_id else { continue };
                let Some(&idx) = inputs.index.get(mid) else {
                    continue;
                };
                let m = p.media(mid).unwrap();
                if m.kind == "audio" {
                    continue;
                }
                let (bw, bh) = if t.kind == "video" && fit == FitMode::Fill {
                    (w, h)
                } else {
                    (box_w, box_h)
                };
                let mut chain = video_chain(c, idx, bw, bh, fps);
                if t.kind == "video" && fit == FitMode::Fill {
                    chain = chain.replace(
                        "force_original_aspect_ratio=decrease",
                        "force_original_aspect_ratio=increase",
                    );
                    chain.push_str(&format!(",crop={w}:{h}"));
                }
                let _ = write!(g, ";{chain}[c{k}]");
                let ox = format!("(W-w)/2+W*{}", f(c.transform.x));
                let oy = format!("(H-h)/2+H*{}", f(c.transform.y));
                let _ = write!(g, ";[{last}][c{k}]overlay=x={ox}:y={oy}:eof_action=pass:enable='between(t,{},{})'[v{k}]", f(c.start), f(c.end()));
                *last = format!("v{k}");
                *k += 1;
            }
        }
    };
    place(&mut g, &mut last, &mut k, &["video"]);

    // 3. Rounded corners: a static mask in the background colour, made once and looped.
    if p.settings.radius > 0 && pad > 0 {
        let (bx, by, box_w, box_h) = (cx, cy, cw, ch);
        let r = p.settings.radius.min(box_w.min(box_h) / 2);
        let a = format!(
            "if(lte(pow(max(max({bx}+{r}-X\\,X-({bx}+{box_w}-{r}))\\,0)\\,2)+pow(max(max({by}+{r}-Y\\,Y-({by}+{box_h}-{r}))\\,0)\\,2)\\,{r}*{r})*between(X\\,{bx}\\,{bx}+{box_w})*between(Y\\,{by}\\,{by}+{box_h})\\,0\\,255)"
        );
        let _ = write!(
            g,
            ";color=c={bg}:s={w}x{h}:r={}:d=0.1,format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='{a}',trim=end_frame=1,loop=loop=-1:size=1:start=0,trim=duration={}[mask];[{last}][mask]overlay=format=auto[rounded]",
            limits::fps_to_ffmpeg(fps),
            f(total)
        );
        last = "rounded".into();
    }

    // 4. Zoom (auto-zoom from clicks, or manual).
    if !p.zooms.is_empty() {
        let ramp = 0.25 + p.zoom_smoothness.clamp(0.0, 1.0) * 0.75;
        let z = zoom_expr(&p.zooms, ramp, "it");
        let fx = focus_expr(&p.zooms, ramp, true, "it");
        let fy = focus_expr(&p.zooms, ramp, false, "it");
        let _ = write!(
            g,
            ";[{last}]zoompan=z='{z}':x='max(0,min(iw-iw/zoom,iw*{fx}-iw/zoom/2))':y='max(0,min(ih-ih/zoom,ih*{fy}-ih/zoom/2))':d=1:s={w}x{h}:fps={}[zoomed]",
            limits::fps_to_ffmpeg(fps)
        );
        last = "zoomed".into();
    }

    // 4b. Overlays (camera bubble, images) on top of the zoomed picture.
    place(&mut g, &mut last, &mut k, &["overlay"]);

    // 5. Shapes: boxes, highlights, blur and pixelate regions, arrows.
    let mut extra_inputs: Vec<String> = Vec::new();
    for t in p
        .tracks
        .iter()
        .filter(|t| t.kind == "text" || t.kind == "overlay")
    {
        for c in &t.clips {
            let Some(sh) = &c.shape else { continue };
            let [x, y, rw, rh] = sh.rect;
            let (px, py) = ((x * w as f64) as i64, (y * h as f64) as i64);
            let (pw, ph) = (
                ((rw * w as f64) as i64).max(4) / 2 * 2,
                ((rh * h as f64) as i64).max(4) / 2 * 2,
            );
            let en = format!("enable='between(t,{},{})'", f(c.start), f(c.end()));
            let color = hex_color(&sh.color, "0x5b8cff");
            if sh.shape == "arrow" {
                std::fs::create_dir_all(tmp).map_err(|e| e.to_string())?;
                let png_path = tmp.join(format!("arrow-{k}.png"));
                let from = (x * w as f64, y * h as f64);
                let to = ((x + rw) * w as f64, (y + rh) * h as f64);
                arrow_png(&png_path, w, h, from, to, rgb_of(&sh.color))?;
                temp_files.push(png_path.clone());
                let idx = inputs.index.len() + extra_inputs.len() / 6;
                extra_inputs.extend([
                    "-loop".into(),
                    "1".into(),
                    "-t".into(),
                    f(total),
                    "-i".into(),
                    png_path.to_string_lossy().to_string(),
                ]);
                let _ = write!(
                    g,
                    ";[{idx}:v]format=rgba[ar{k}];[{last}][ar{k}]overlay=0:0:{en}[sh{k}]"
                );
                last = format!("sh{k}");
                k += 1;
                continue;
            }
            match sh.shape.as_str() {
                "blur" | "pixelate" => {
                    // boxblur's radius must fit in half the (chroma-subsampled) region.
                    let radius = ((pw.min(ph) / 4) - 1).clamp(1, 20);
                    let fx = if sh.shape == "blur" {
                        format!("boxblur={radius}:3")
                    } else {
                        format!(
                            "scale={}:{}:flags=neighbor,scale={pw}:{ph}:flags=neighbor",
                            (pw / 16).max(2),
                            (ph / 16).max(2)
                        )
                    };
                    let _ = write!(g, ";[{last}]split[s{k}a][s{k}b];[s{k}b]crop={pw}:{ph}:{px}:{py},{fx}[s{k}c];[s{k}a][s{k}c]overlay={px}:{py}:{en}[sh{k}]");
                }
                "highlight" => {
                    let _ = write!(g, ";[{last}]drawbox=x={px}:y={py}:w={pw}:h={ph}:color={color}@0.22:t=fill:{en},drawbox=x={px}:y={py}:w={pw}:h={ph}:color={color}:t=4:{en}[sh{k}]");
                }
                _ => {
                    let _ = write!(g, ";[{last}]drawbox=x={px}:y={py}:w={pw}:h={ph}:color={color}:t=6:{en}[sh{k}]");
                }
            }
            last = format!("sh{k}");
            k += 1;
        }
    }

    // 6. Text clips and burned-in captions (drawtext with text files).
    let fontfile = filter_path(font);
    let mut texts: Vec<(f64, f64, String, u32, String, String, String)> = Vec::new();
    for t in p.tracks.iter().filter(|t| t.kind == "text") {
        for c in &t.clips {
            if let Some(tp) = &c.text {
                let size = if tp.size > 0 { tp.size } else { 48 };
                texts.push((
                    c.start,
                    c.end(),
                    tp.text.clone(),
                    size * h / 1080,
                    tp.position.clone(),
                    tp.color.clone(),
                    tp.animation.clone(),
                ));
            }
        }
    }
    if req.burn_captions {
        for cap in &p.captions {
            texts.push((
                cap.start,
                cap.end,
                cap.text.clone(),
                44 * h / 1080,
                "bottom".into(),
                "#ffffff".into(),
                "none".into(),
            ));
        }
    }
    if !texts.is_empty() {
        std::fs::create_dir_all(tmp).map_err(|e| e.to_string())?;
    }
    if !texts.is_empty() && !caps.has_filter("drawtext") {
        // Some FFmpeg builds (e.g. the static Linux one) have no drawtext but do
        // have libass: render the same text as an ASS subtitle layer instead.
        if !caps.has_filter("ass") {
            return Err(
                "This FFmpeg build can't draw text. Remove the text or install a full FFmpeg."
                    .into(),
            );
        }
        let ass = tmp.join("text.ass");
        std::fs::write(&ass, ass_document(&texts, w, h)).map_err(|e| e.to_string())?;
        temp_files.push(ass.clone());
        let fonts_dir = font.parent().map(filter_path).unwrap_or_default();
        let _ = write!(
            g,
            ";[{last}]ass=filename='{}':fontsdir='{fonts_dir}'[txa]",
            filter_path(&ass)
        );
        last = "txa".into();
        texts.clear();
    }
    for (i, (s, e, text, size, pos, color, anim)) in texts.iter().enumerate() {
        let file = tmp.join(format!("text-{i}.txt"));
        std::fs::write(&file, text).map_err(|e| e.to_string())?;
        temp_files.push(file.clone());
        let alpha = if anim == "fade" {
            format!(
                ":alpha='max(0,min(1,min((t-{})/0.3,({}-t)/0.3)))'",
                f(*s),
                f(*e)
            )
        } else {
            String::new()
        };
        let _ = write!(
            g,
            ";[{last}]drawtext=fontfile='{fontfile}':textfile='{}':expansion=none:fontsize={}:fontcolor={}:box=1:boxcolor=0x0a0c10@0.78:boxborderw={}:x=(w-text_w)/2:y={}{alpha}:enable='between(t,{},{})'[tx{i}]",
            filter_path(&file),
            (*size).max(8),
            hex_color(color, "white"),
            (size / 3).max(6),
            text_y(pos),
            f(*s),
            f(*e)
        );
        last = format!("tx{i}");
    }

    // 7. Range trim of the final picture.
    let _ = write!(
        g,
        ";[{last}]trim=start={}:end={},setpts=PTS-STARTPTS,format=yuv420p[vout]",
        f(range_start),
        f(range_end)
    );

    // 8. Audio: every clip that has sound, delayed to its place and mixed.
    let video_end = g.len();
    let mut alabels = Vec::new();
    for t in p.tracks.iter().filter(|_| req.preset != Preset::Gif) {
        if t.muted {
            continue;
        }
        for (c, early) in with_transitions(t) {
            let c = &c;
            let Some(mid) = &c.media_id else { continue };
            let Some(&idx) = inputs.index.get(mid) else {
                continue;
            };
            let m = p.media(mid).unwrap();
            if !(m.kind == "audio" || m.has_audio) || c.freeze {
                continue;
            }
            // A video clip's sound is only used from the video track.
            if m.kind != "audio" && t.kind != "video" {
                continue;
            }
            let mut parts = vec![
                format!("atrim=start={}:end={}", f(c.in_point), f(c.out)),
                "asetpts=PTS-STARTPTS".to_string(),
            ];
            if c.reverse {
                parts.push("areverse".into());
            }
            parts.extend(atempo_chain(c.speed));
            if c.volume_keys.is_empty() {
                parts.push(format!("volume={}", f(c.volume * t.volume)));
            } else {
                parts.push(format!(
                    "volume='{}':eval=frame",
                    volume_expr(c.volume * t.volume, &c.volume_keys, early)
                ));
            }
            if c.clean_voice {
                parts.push("highpass=f=80,afftdn=nr=12:nf=-40".into());
            }
            if c.fade_in > 0.0 {
                parts.push(format!("afade=t=in:st=0:d={}", f(c.fade_in)));
            }
            if c.fade_out > 0.0 {
                parts.push(format!(
                    "afade=t=out:st={}:d={}",
                    f((c.length() - c.fade_out).max(0.0)),
                    f(c.fade_out)
                ));
            }
            let ms = (c.start * 1000.0).round() as i64;
            parts.push(format!("adelay={ms}:all=1"));
            let label = format!("a{}", alabels.len());
            let _ = write!(g, ";[{idx}:a]{}[{label}]", parts.join(","));
            alabels.push(label);
        }
    }
    let has_audio = !alabels.is_empty() && req.preset != Preset::Gif;
    if has_audio {
        let ins: String = alabels.iter().map(|l| format!("[{l}]")).collect();
        let mut tail = format!(
            "amix=inputs={}:normalize=0:dropout_transition=0,aresample=48000",
            alabels.len()
        );
        if req.loudness {
            tail.push_str(",loudnorm=I=-14:TP=-1.5:LRA=11");
        }
        // Pad with silence so sound always covers the whole timeline (freeze frames, gaps at the end).
        let _ = write!(
            g,
            ";{ins}{tail},apad=whole_dur={},atrim=start={}:end={},asetpts=PTS-STARTPTS[aout]",
            f(total),
            f(range_start),
            f(range_end)
        );
    }

    // 9. Encoders.
    let mut args = inputs.args;
    args.extend(extra_inputs);
    let graph_file = tmp.join("graph.txt");
    std::fs::create_dir_all(tmp).map_err(|e| e.to_string())?;

    if req.preset == Preset::Gif {
        let _ = write!(g, ";[vout]fps={},split[ga][gb];[ga]palettegen=stats_mode=diff[gp];[gb][gp]paletteuse=dither=sierra2_4a[gif]", limits::fps_to_ffmpeg(fps));
        std::fs::write(&graph_file, &g).map_err(|e| e.to_string())?;
        args.extend([
            "-filter_complex_script".into(),
            graph_file.to_string_lossy().to_string(),
            "-map".into(),
            "[gif]".into(),
            "-loop".into(),
            "0".into(),
        ]);
    } else if req.preset == Preset::Audio {
        if !has_audio {
            return Err("This project has no sound to export.".into());
        }
        // Audio only: drop the picture graph entirely so no video is processed.
        let audio_graph = g[video_end..].trim_start_matches(';').to_string();
        std::fs::write(&graph_file, &audio_graph).map_err(|e| e.to_string())?;
        args.extend([
            "-filter_complex_script".into(),
            graph_file.to_string_lossy().to_string(),
            "-map".into(),
            "[aout]".into(),
            "-c:a".into(),
            "libmp3lame".into(),
            "-q:a".into(),
            "2".into(),
        ]);
    } else {
        std::fs::write(&graph_file, &g).map_err(|e| e.to_string())?;
        args.extend([
            "-filter_complex_script".into(),
            graph_file.to_string_lossy().to_string(),
            "-map".into(),
            "[vout]".into(),
        ]);
        if has_audio {
            args.extend(["-map".into(), "[aout]".into()]);
        }
        let kbps = if req.preset == Preset::Small {
            let mb = req.target_mb.unwrap_or(25.0);
            Some(
                ((mb * 8.0 * 1024.0 * convert::SIZE_SAFETY / duration)
                    - if has_audio { 128.0 } else { 0.0 })
                .max(80.0),
            )
        } else {
            None
        };
        let quality = if req.preset == Preset::Small {
            Quality::Smaller
        } else {
            Quality::Same
        };
        args.extend(convert::h264_encoder(caps, req.use_hardware, kbps, quality).args);
        args.extend(["-r".into(), limits::fps_to_ffmpeg(fps)]);
        if has_audio {
            args.extend(["-c:a".into(), "aac".into(), "-b:a".into(), "128k".into()]);
        }
        args.extend(["-movflags".into(), "+faststart".into()]);
    }
    temp_files.push(graph_file);
    args.extend(["-t".into(), f(duration)]);
    args.push(req.output.to_string_lossy().to_string());
    Ok(ExportPlan {
        args,
        duration,
        temp_files,
    })
}

fn ass_time(t: f64) -> String {
    let cs = (t.max(0.0) * 100.0).round() as u64;
    format!(
        "{}:{:02}:{:02}.{:02}",
        cs / 360_000,
        cs / 6000 % 60,
        cs / 100 % 60,
        cs % 100
    )
}

/// "#rrggbb" to ASS "&HAABBGGRR".
fn ass_color(hex: &str, alpha: u8) -> String {
    let c = hex.trim_start_matches('#');
    if c.len() == 6 && c.chars().all(|x| x.is_ascii_hexdigit()) {
        format!("&H{alpha:02X}{}{}{}", &c[4..6], &c[2..4], &c[0..2]).to_uppercase()
    } else {
        format!("&H{alpha:02X}FFFFFF")
    }
}

/// The text clips as an ASS subtitle file: same size, place, colour, box and fade as drawtext.
pub fn ass_document(
    texts: &[(f64, f64, String, u32, String, String, String)],
    w: u32,
    h: u32,
) -> String {
    let mut out = format!(
        "[Script Info]\nScriptType: v4.00+\nPlayResX: {w}\nPlayResY: {h}\nWrapStyle: 2\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n"
    );
    for (i, (_, _, _, size, pos, color, _)) in texts.iter().enumerate() {
        let align = match pos.as_str() {
            "top" => 8,
            "middle" => 5,
            _ => 2,
        };
        let margin_v = (h as f64 * 0.08).round() as u32;
        let _ = writeln!(
            out,
            "Style: S{i},Inter,{},{},&H000000FF,&H380A0C10,&H380A0C10,-1,0,0,0,100,100,0,0,3,{},0,{align},20,20,{margin_v},1",
            (*size).max(8),
            ass_color(color, 0),
            (size / 3).max(6)
        );
    }
    out.push_str("\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n");
    for (i, (s, e, text, _, _, _, anim)) in texts.iter().enumerate() {
        let fade = if anim == "fade" {
            "{\\fad(300,300)}"
        } else {
            ""
        };
        let body = text
            .replace('\\', "\\\\")
            .replace('{', "(")
            .replace('}', ")")
            .replace("\r\n", "\\N")
            .replace('\n', "\\N");
        let _ = writeln!(
            out,
            "Dialogue: 0,{},{},S{i},,0,0,0,,{fade}{body}",
            ass_time(*s),
            ass_time(*e)
        );
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::*;

    fn caps() -> Capabilities {
        let mut c = Capabilities::default();
        c.encoders.push("libx264".into());
        c.filters.push("drawtext".into());
        c
    }

    fn demo() -> Project {
        let mut p = Project::new("Demo", 1920, 1080, 30.0);
        p.media.push(Media {
            id: "m1".into(),
            path: "C:/v/screen.mkv".into(),
            kind: "video".into(),
            duration: 60.0,
            width: 1920,
            height: 1080,
            has_audio: true,
            missing: false,
        });
        p.media.push(Media {
            id: "m2".into(),
            path: "C:/v/mic.wav".into(),
            kind: "audio".into(),
            duration: 60.0,
            width: 0,
            height: 0,
            has_audio: true,
            missing: false,
        });
        let mk = |id: &str, mid: &str, start: f64, i: f64, o: f64| Clip {
            id: id.into(),
            media_id: Some(mid.into()),
            start,
            in_point: i,
            out: o,
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
            volume_keys: vec![],
            transition_in: None,
        };
        p.tracks[0].clips.push(mk("c1", "m1", 0.0, 0.0, 20.0));
        p.tracks[0].clips.push(mk("c2", "m1", 20.0, 30.0, 40.0));
        let mut voice = mk("c3", "m2", 0.0, 0.0, 30.0);
        voice.clean_voice = true;
        p.tracks[2].clips.push(voice);
        let mut txt = mk("t1", "", 4.0, 0.0, 3.0);
        txt.media_id = None;
        txt.text = Some(TextProps {
            text: "Click: Publish 'now' 100%".into(),
            style: "callout".into(),
            size: 48,
            position: "bottom".into(),
            color: "#ffffff".into(),
            animation: "fade".into(),
        });
        p.tracks[1].clips.push(txt);
        p
    }

    fn req(preset: Preset) -> ExportRequest {
        ExportRequest {
            preset,
            output: "out.mp4".into(),
            range: None,
            width: None,
            height: None,
            fps: None,
            burn_captions: false,
            sidecar_captions: false,
            loudness: true,
            use_hardware: false,
            target_mb: None,
        }
    }

    fn graph(p: &Project, r: &ExportRequest) -> (String, ExportPlan) {
        let tmp = tempfile::tempdir().unwrap().keep();
        let plan = build(p, r, &caps(), Path::new("C:/fonts/Inter.ttf"), &tmp).unwrap();
        let g = std::fs::read_to_string(tmp.join("graph.txt")).unwrap();
        (g, plan)
    }

    #[test]
    fn media_is_input_once_and_clips_are_placed() {
        let (g, plan) = graph(&demo(), &req(Preset::Share));
        assert_eq!(plan.args.iter().filter(|a| *a == "-i").count(), 2);
        assert!(g.contains("trim=start=30:end=40"));
        assert!(g.contains("setpts=PTS+20/TB"));
        assert!(g.contains("between(t,20,30)"));
        assert!((plan.duration - 30.0).abs() < 1e-9);
    }

    #[test]
    fn audio_is_mixed_cleaned_and_normalised() {
        let (g, _) = graph(&demo(), &req(Preset::Share));
        assert!(g.contains("amix=inputs=3"));
        assert!(g.contains("afftdn"));
        assert!(g.contains("adelay=20000:all=1"));
        assert!(g.contains("loudnorm=I=-14"));
    }

    #[test]
    fn text_uses_a_file_so_quotes_and_colons_are_safe() {
        let (g, plan) = graph(&demo(), &req(Preset::Share));
        assert!(g.contains("textfile="));
        assert!(!g.contains("Publish 'now'"));
        let txt = plan
            .temp_files
            .iter()
            .find(|p| p.to_string_lossy().contains("text-0"))
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(txt).unwrap(),
            "Click: Publish 'now' 100%"
        );
        assert!(g.contains("fontfile='C\\:/fonts/Inter.ttf'"));
        assert!(g.contains("alpha="));
    }

    #[test]
    fn zoom_expression_ramps() {
        let z = vec![Zoom {
            start: 2.0,
            end: 5.0,
            scale: 2.0,
            x: 0.8,
            y: 0.7,
        }];
        let e = zoom_expr(&z, 0.5, "it");
        assert_eq!(e, "1+1*clip((it-2)/0.5,0,1)*clip((5-it)/0.5,0,1)");
        assert!(focus_expr(&z, 0.5, true, "it").contains("0.8"));
        let mut p = demo();
        p.zooms = z;
        let (g, _) = graph(&p, &req(Preset::Share));
        assert!(g.contains("zoompan=z='1+"));
    }

    #[test]
    fn speed_reverse_freeze() {
        assert_eq!(atempo_chain(4.0), vec!["atempo=2", "atempo=2"]);
        assert_eq!(atempo_chain(0.25), vec!["atempo=0.5", "atempo=0.5"]);
        assert_eq!(atempo_chain(1.5), vec!["atempo=1.5"]);
        assert!(atempo_chain(1.0).is_empty());
        let mut p = demo();
        p.tracks[0].clips[0].speed = 2.0;
        p.tracks[0].clips[1].reverse = true;
        let (g, _) = graph(&p, &req(Preset::Share));
        assert!(g.contains("setpts=PTS/2"));
        assert!(g.contains("reverse"));
        let mut p2 = demo();
        p2.tracks[0].clips[0].freeze = true;
        let (g2, _) = graph(&p2, &req(Preset::Share));
        assert!(g2.contains("loop=loop=-1:size=1"));
    }

    #[test]
    fn range_export_and_audio_only() {
        let mut r = req(Preset::Share);
        r.range = Some((5.0, 12.5));
        let (g, plan) = graph(&demo(), &r);
        assert!(g.contains("trim=start=5:end=12.5"));
        assert!((plan.duration - 7.5).abs() < 1e-9);
        let mut a = req(Preset::Audio);
        a.output = "out.mp3".into();
        let (_, plan) = graph(&demo(), &a);
        assert!(plan.args.join(" ").contains("libmp3lame"));
        assert!(plan.args.contains(&"[aout]".to_string()));
    }

    #[test]
    fn vertical_fills_and_gif_has_palette() {
        let (g, _) = graph(&demo(), &req(Preset::Vertical));
        assert!(g.contains("s=1080x1920") && g.contains("crop=1080:1920"));
        let mut gr = req(Preset::Gif);
        gr.output = "o.gif".into();
        let (g, plan) = graph(&demo(), &gr);
        assert!(g.contains("palettegen"));
        assert!(!plan.args.contains(&"[aout]".to_string()));
    }

    #[test]
    fn small_preset_targets_bitrate() {
        let (_, plan) = graph(&demo(), &req(Preset::Small));
        let j = plan.args.join(" ");
        assert!(j.contains("-b:v"), "{j}");
    }

    #[test]
    fn padding_radius_and_shapes() {
        let mut p = demo();
        p.settings.padding = 60;
        p.settings.radius = 24;
        p.settings.background = "#1e2a4a".into();
        p.tracks[1].clips.push(Clip {
            id: "b".into(),
            media_id: None,
            start: 1.0,
            in_point: 0.0,
            out: 2.0,
            speed: 1.0,
            volume: 1.0,
            fade_in: 0.0,
            fade_out: 0.0,
            reverse: false,
            freeze: false,
            transform: Transform::default(),
            text: None,
            shape: Some(ShapeProps {
                shape: "blur".into(),
                rect: [0.1, 0.1, 0.2, 0.1],
                color: String::new(),
            }),
            clean_voice: false,
            volume_keys: vec![],
            transition_in: None,
        });
        let (g, _) = graph(&p, &req(Preset::Share));
        assert!(g.contains("color=c=0x1e2a4a"));
        assert!(g.contains("geq="));
        assert!(g.contains("scale=1800:960"));
        assert!(g.contains("boxblur=20:3"));
    }

    #[test]
    fn custom_resolution_is_clamped() {
        let mut r = req(Preset::Custom);
        r.width = Some(99999);
        r.height = Some(3);
        r.fps = Some(1000.0);
        let (g, plan) = graph(&demo(), &r);
        assert!(g.contains("s=7680x72"));
        assert!(plan.args.join(" ").contains("-r 240"));
    }

    #[test]
    fn empty_timeline_is_a_clear_error() {
        let p = Project::new("x", 1920, 1080, 30.0);
        let tmp = tempfile::tempdir().unwrap();
        let e = build(
            &p,
            &req(Preset::Share),
            &caps(),
            Path::new("f.ttf"),
            tmp.path(),
        )
        .err()
        .unwrap();
        assert!(e.contains("empty"));
    }

    #[test]
    fn ass_fallback_when_drawtext_is_missing() {
        let mut caps = caps();
        caps.filters.retain(|f| f != "drawtext");
        caps.filters.push("ass".into());
        let tmp = tempfile::tempdir().unwrap();
        let plan = build(
            &demo(),
            &req(Preset::Share),
            &caps,
            Path::new("C:/fonts/Inter-Bold.ttf"),
            tmp.path(),
        );
        assert!(plan.is_ok());
        let g = std::fs::read_to_string(tmp.path().join("graph.txt")).unwrap();
        assert!(g.contains("ass=filename=") && !g.contains("drawtext"));
        let doc = std::fs::read_to_string(tmp.path().join("text.ass")).unwrap();
        assert!(doc.contains("PlayResX: 1920"));
        assert!(doc.contains("Dialogue: 0,0:00:04.00,0:00:07.00,S0,,0,0,0,,{\\fad(300,300)}Click: Publish 'now' 100%"));
        assert_eq!(ass_color("#5b8cff", 0), "&H00FF8C5B");
        assert_eq!(ass_time(3661.256), "1:01:01.26");
    }

    #[test]
    fn crossfade_and_dip_transitions() {
        let mut p = demo();
        p.tracks[0].clips[1].transition_in = Some(Transition {
            kind: "crossfade".into(),
            duration: 1.0,
        });
        let v = with_transitions(&p.tracks[0]);
        assert!((v[1].0.start - 19.0).abs() < 1e-9 && (v[1].0.in_point - 29.0).abs() < 1e-9);
        assert_eq!(v[1].0.end(), 30.0);
        assert_eq!(v[1].1, 1.0);
        assert_eq!(v[0].0.fade_out, 1.0);
        let (g, _) = graph(&p, &req(Preset::Share));
        assert!(g.contains("trim=start=29:end=40"));
        assert!(g.contains("between(t,19,30)"));
        p.tracks[0].clips[1].transition_in = Some(Transition {
            kind: "dip".into(),
            duration: 1.0,
        });
        let v = with_transitions(&p.tracks[0]);
        assert_eq!(
            (v[0].0.fade_out, v[1].0.fade_in, v[1].0.start),
            (0.5, 0.5, 20.0)
        );
    }

    #[test]
    fn volume_keys_become_a_curve() {
        let keys = vec![VolumeKey { t: 1.0, v: 1.0 }, VolumeKey { t: 3.0, v: 0.2 }];
        let e = volume_expr(0.5, &keys, 0.0);
        assert_eq!(e, "0.5*(if(lt(t,1),1,if(lt(t,3),1+(0.2-1)*(t-1)/2,0.2)))");
        assert!(volume_expr(1.0, &keys, 2.0).contains("lt(t,3)"));
        assert_eq!(volume_expr(0.8, &[], 0.0), "0.8");
        let mut p = demo();
        p.tracks[2].clips[0].volume_keys = keys;
        let (g, _) = graph(&p, &req(Preset::Share));
        assert!(g.contains(":eval=frame"));
    }

    #[test]
    fn arrows_and_shadow() {
        let mut p = demo();
        p.settings.padding = 60;
        p.settings.shadow = true;
        p.tracks[1].clips.push(Clip {
            id: "ar".into(),
            start: 1.0,
            out: 2.0,
            shape: Some(ShapeProps {
                shape: "arrow".into(),
                rect: [0.2, 0.2, 0.3, 0.2],
                color: "#ff0000".into(),
            }),
            ..Default::default()
        });
        let tmp = tempfile::tempdir().unwrap();
        let plan = build(
            &p,
            &req(Preset::Share),
            &caps(),
            Path::new("f.ttf"),
            tmp.path(),
        )
        .unwrap();
        let g = std::fs::read_to_string(tmp.path().join("graph.txt")).unwrap();
        assert!(g.contains("[shadow]") && g.contains("boxblur=luma_radius"));
        assert!(g.contains("[2:v]format=rgba"), "{g}");
        assert_eq!(plan.args.iter().filter(|a| *a == "-i").count(), 3);
        let arrow = std::fs::read_dir(tmp.path())
            .unwrap()
            .flatten()
            .map(|e| e.path())
            .find(|p| {
                p.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("arrow-")
            })
            .expect("arrow png written");
        let d = png::Decoder::new(std::fs::File::open(arrow).unwrap());
        let mut r = d.read_info().unwrap();
        let mut buf = vec![0; r.output_buffer_size()];
        let info = r.next_frame(&mut buf).unwrap();
        assert_eq!((info.width, info.height), (1920, 1080));
        // Arrow tip area is painted red; a far corner stays transparent.
        let at = |x: u32, y: u32| {
            buf[((y * 1920 + x) * 4) as usize..((y * 1920 + x) * 4 + 4) as usize].to_vec()
        };
        let mid = at(
            ((0.2 + 0.15) * 1920.0) as u32,
            ((0.2 + 0.1) * 1080.0) as u32,
        );
        assert_eq!(&mid[..3], &[255, 0, 0]);
        assert!(mid[3] > 200);
        assert_eq!(at(1900, 1060)[3], 0);
    }
}
