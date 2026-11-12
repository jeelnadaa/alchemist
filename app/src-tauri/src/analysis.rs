//! Analysis helpers: silence detection, auto-zoom from the cursor sidecar,
//! caption files, waveform peaks and thumbnails.

use crate::ffmpeg::{self, FfError};
use crate::project::{Caption, Zoom};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Range {
    pub start: f64,
    pub end: f64,
}

/// Parse `silencedetect` output into ranges at least `min_len` long.
pub fn parse_silences(stderr: &str, min_len: f64) -> Vec<Range> {
    let st = Regex::new(r"silence_start: (-?[\d.]+)").unwrap();
    let en = Regex::new(r"silence_end: ([\d.]+)").unwrap();
    let starts: Vec<f64> = st
        .captures_iter(stderr)
        .filter_map(|c| c[1].parse().ok())
        .collect();
    let ends: Vec<f64> = en
        .captures_iter(stderr)
        .filter_map(|c| c[1].parse().ok())
        .collect();
    starts
        .iter()
        .zip(ends.iter())
        .map(|(&s, &e)| Range {
            start: s.max(0.0),
            end: e,
        })
        .filter(|r| r.end - r.start >= min_len)
        .collect()
}

/// Find pauses in a file's sound. Keeps a short breath at each edge so cuts
/// never feel abrupt.
pub fn detect_silence(path: &Path, threshold_db: f64, min_len: f64) -> Result<Vec<Range>, FfError> {
    let text = ffmpeg::run_capture_stderr(&[
        "-hide_banner".into(),
        "-nostats".into(),
        "-i".into(),
        path.to_string_lossy().to_string(),
        "-vn".into(),
        "-af".into(),
        format!("silencedetect=noise={threshold_db}dB:d={min_len}"),
        "-f".into(),
        "null".into(),
        "-".into(),
    ])?;
    let pad = 0.15;
    Ok(parse_silences(&text, min_len)
        .into_iter()
        .map(|r| Range {
            start: r.start + pad,
            end: (r.end - pad).max(r.start + pad),
        })
        .filter(|r| r.end - r.start > 0.2)
        .collect())
}

#[derive(Debug, Clone, Deserialize)]
pub struct InputEvent {
    pub t: f64,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub x: Option<f64>,
    #[serde(default)]
    pub y: Option<f64>,
}

pub fn read_events(path: &Path) -> Vec<InputEvent> {
    std::fs::read_to_string(path)
        .map(|t| {
            t.lines()
                .filter_map(|l| serde_json::from_str(l).ok())
                .collect()
        })
        .unwrap_or_default()
}

/// Turn clicks into zoom segments. Clicks close together merge into one
/// zoom, so the camera doesn't bounce. `strength` 0..1 sets how close.
/// `origin` and `size` describe the recorded rectangle in screen pixels.
pub fn auto_zoom(
    events: &[InputEvent],
    origin: (f64, f64),
    size: (f64, f64),
    strength: f64,
    hold: f64,
) -> Vec<Zoom> {
    let scale = 1.4 + strength.clamp(0.0, 1.0) * 1.1;
    let mut last_pos = (origin.0 + size.0 / 2.0, origin.1 + size.1 / 2.0);
    let mut clicks: Vec<(f64, f64, f64)> = Vec::new();
    for e in events {
        if let (Some(x), Some(y)) = (e.x, e.y) {
            last_pos = (x, y);
        }
        if e.kind == "click" {
            let fx = ((last_pos.0 - origin.0) / size.0).clamp(0.0, 1.0);
            let fy = ((last_pos.1 - origin.1) / size.1).clamp(0.0, 1.0);
            clicks.push((e.t, fx, fy));
        }
    }
    let mut zooms: Vec<Zoom> = Vec::new();
    for (t, x, y) in clicks {
        let start = (t - 0.6).max(0.0);
        let end = t + hold;
        if let Some(last) = zooms.last_mut() {
            if start <= last.end + 1.0 {
                last.end = end;
                last.x = (last.x + x) / 2.0;
                last.y = (last.y + y) / 2.0;
                continue;
            }
        }
        zooms.push(Zoom {
            start,
            end,
            scale,
            x,
            y,
        });
    }
    zooms
}

fn ts(t: f64, sep: char) -> String {
    let ms = (t.max(0.0) * 1000.0).round() as u64;
    format!(
        "{:02}:{:02}:{:02}{sep}{:03}",
        ms / 3_600_000,
        ms / 60_000 % 60,
        ms / 1000 % 60,
        ms % 1000
    )
}

pub fn to_srt(caps: &[Caption]) -> String {
    caps.iter()
        .enumerate()
        .map(|(i, c)| {
            format!(
                "{}\n{} --> {}\n{}\n\n",
                i + 1,
                ts(c.start, ','),
                ts(c.end, ','),
                c.text.trim()
            )
        })
        .collect()
}

pub fn to_vtt(caps: &[Caption]) -> String {
    let body: String = caps
        .iter()
        .map(|c| {
            format!(
                "{} --> {}\n{}\n\n",
                ts(c.start, '.'),
                ts(c.end, '.'),
                c.text.trim()
            )
        })
        .collect();
    format!("WEBVTT\n\n{body}")
}

/// Parse an SRT or VTT file into captions (import).
pub fn parse_subtitles(text: &str) -> Vec<Caption> {
    let re = Regex::new(r"(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)").unwrap();
    let mut out = Vec::new();
    let mut lines = text.lines().peekable();
    while let Some(l) = lines.next() {
        if let Some(c) = re.captures(l) {
            let n = |i: usize| c[i].parse::<f64>().unwrap_or(0.0);
            let start = n(1) * 3600.0 + n(2) * 60.0 + n(3) + n(4) / 1000.0;
            let end = n(5) * 3600.0 + n(6) * 60.0 + n(7) + n(8) / 1000.0;
            let mut body = Vec::new();
            while let Some(next) = lines.peek() {
                if next.trim().is_empty() {
                    break;
                }
                body.push(lines.next().unwrap().to_string());
            }
            out.push(Caption {
                start,
                end,
                text: body.join("\n"),
            });
        }
    }
    out
}

/// Peak levels (0..1) for drawing a waveform, `buckets` values long.
pub fn waveform(path: &Path, buckets: usize) -> Result<Vec<f32>, FfError> {
    let bin = ffmpeg::locate()?;
    let out = ffmpeg::command(&bin)
        .args(["-loglevel", "error", "-i"])
        .arg(path)
        .args(["-vn", "-ac", "1", "-ar", "2000", "-f", "s16le", "-"])
        .stdin(std::process::Stdio::null())
        .output()
        .map_err(|e| FfError::Spawn(e.to_string()))?;
    Ok(peaks(&out.stdout, buckets))
}

pub fn peaks(pcm: &[u8], buckets: usize) -> Vec<f32> {
    let samples: Vec<i16> = pcm
        .chunks_exact(2)
        .map(|b| i16::from_le_bytes([b[0], b[1]]))
        .collect();
    if samples.is_empty() || buckets == 0 {
        return vec![0.0; buckets];
    }
    let per = (samples.len() as f64 / buckets as f64).max(1.0);
    (0..buckets)
        .map(|i| {
            let a = (i as f64 * per) as usize;
            let b = (((i + 1) as f64 * per) as usize).min(samples.len());
            samples
                .get(a..b.max(a))
                .map(|s| {
                    s.iter()
                        .map(|v| (*v as i32).unsigned_abs())
                        .max()
                        .unwrap_or(0) as f32
                        / 32768.0
                })
                .unwrap_or(0.0)
        })
        .collect()
}

/// One small JPEG frame for thumbnails, cached by path + time.
pub fn thumbnail(path: &Path, at: f64, cache: &Path) -> Result<PathBuf, FfError> {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    path.hash(&mut h);
    ((at * 10.0) as i64).hash(&mut h);
    std::fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .hash(&mut h);
    let out = cache.join(format!("thumb-{:x}.jpg", h.finish()));
    if out.exists() {
        return Ok(out);
    }
    let _ = std::fs::create_dir_all(cache);
    ffmpeg::run_capture_stderr(&[
        "-y".into(),
        "-ss".into(),
        format!("{at:.2}"),
        "-i".into(),
        path.to_string_lossy().to_string(),
        "-frames:v".into(),
        "1".into(),
        "-vf".into(),
        "scale=320:-2".into(),
        "-q:v".into(),
        "5".into(),
        out.to_string_lossy().to_string(),
    ])?;
    Ok(out)
}

/// Arguments for a light stand-in copy used for smooth scrubbing of big files.
pub fn proxy_args(input: &Path, output: &Path) -> Vec<String> {
    vec![
        "-i".into(),
        input.to_string_lossy().to_string(),
        "-vf".into(),
        "scale=-2:'min(540,ih)'".into(),
        "-c:v".into(),
        "libx264".into(),
        "-preset".into(),
        "veryfast".into(),
        "-crf".into(),
        "28".into(),
        "-g".into(),
        "15".into(),
        "-c:a".into(),
        "aac".into(),
        "-b:a".into(),
        "96k".into(),
        "-movflags".into(),
        "+faststart".into(),
        output.to_string_lossy().to_string(),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn silences_are_parsed_and_short_ones_ignored() {
        let t = "[silencedetect @ 0] silence_start: 3.5\n[silencedetect @ 0] silence_end: 6.0 | silence_duration: 2.5\n[silencedetect @ 0] silence_start: 10\n[silencedetect @ 0] silence_end: 10.3 | silence_duration: 0.3\n";
        let r = parse_silences(t, 1.0);
        assert_eq!(
            r,
            vec![Range {
                start: 3.5,
                end: 6.0
            }]
        );
    }

    #[test]
    fn clicks_become_merged_zooms() {
        let ev = vec![
            InputEvent {
                t: 1.0,
                kind: "move".into(),
                x: Some(1600.0),
                y: Some(900.0),
            },
            InputEvent {
                t: 2.0,
                kind: "click".into(),
                x: None,
                y: None,
            },
            InputEvent {
                t: 3.0,
                kind: "click".into(),
                x: None,
                y: None,
            },
            InputEvent {
                t: 20.0,
                kind: "move".into(),
                x: Some(100.0),
                y: Some(100.0),
            },
            InputEvent {
                t: 20.5,
                kind: "click".into(),
                x: None,
                y: None,
            },
        ];
        let z = auto_zoom(&ev, (0.0, 0.0), (1920.0, 1080.0), 0.5, 2.0);
        assert_eq!(z.len(), 2);
        assert!((z[0].start - 1.4).abs() < 1e-9 && (z[0].end - 5.0).abs() < 1e-9);
        assert!((z[0].x - 1600.0 / 1920.0).abs() < 1e-9);
        assert!(z[1].x < 0.1);
        assert!(z[0].scale > 1.5);
    }

    #[test]
    fn captions_round_trip() {
        let caps = vec![
            Caption {
                start: 1.5,
                end: 3.25,
                text: "Hello".into(),
            },
            Caption {
                start: 3661.0,
                end: 3662.0,
                text: "Two\nlines".into(),
            },
        ];
        let srt = to_srt(&caps);
        assert!(srt.contains("00:00:01,500 --> 00:00:03,250"));
        assert!(srt.contains("01:01:01,000"));
        assert_eq!(parse_subtitles(&srt), caps);
        let vtt = to_vtt(&caps);
        assert!(vtt.starts_with("WEBVTT") && vtt.contains("00:00:01.500"));
        assert_eq!(parse_subtitles(&vtt), caps);
    }

    #[test]
    fn waveform_peaks() {
        let mut pcm = Vec::new();
        for i in 0..1000i16 {
            let v: i16 = if i < 500 { 0 } else { 16384 };
            pcm.extend_from_slice(&v.to_le_bytes());
        }
        let p = peaks(&pcm, 4);
        assert_eq!(p.len(), 4);
        assert_eq!(p[0], 0.0);
        assert!((p[3] - 0.5).abs() < 0.01);
        assert_eq!(peaks(&[], 3), vec![0.0; 3]);
    }
}
