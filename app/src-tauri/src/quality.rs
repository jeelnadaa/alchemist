//! Honest quality numbers: compares the result with the original using a real
//! metric. VMAF when this FFmpeg has it, otherwise SSIM. The metric name is
//! always shown next to the number.

use crate::ffmpeg::{self, Capabilities, FfError};
use regex::Regex;
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QualityScore {
    /// "VMAF" (0–100) or "SSIM" (0–1).
    pub metric: String,
    pub value: f64,
    /// Plain words: "Looks identical", "Very close", "Noticeably softer"…
    pub verdict: String,
}

pub fn verdict(metric: &str, v: f64) -> String {
    let score = if metric == "VMAF" {
        v
    } else {
        ((v - 0.85) / 0.15 * 100.0).clamp(0.0, 100.0)
    };
    match score {
        s if s >= 93.0 => "Looks identical to the original".into(),
        s if s >= 85.0 => "Very close to the original".into(),
        s if s >= 70.0 => "Slightly softer than the original".into(),
        _ => "Noticeably softer than the original".into(),
    }
}

pub fn parse_ssim(stderr: &str) -> Option<f64> {
    let re = Regex::new(r"SSIM [^\n]*All:([\d.]+)").ok()?;
    re.captures_iter(stderr)
        .last()
        .and_then(|c| c[1].parse().ok())
}

pub fn parse_vmaf(stderr: &str) -> Option<f64> {
    let re = Regex::new(r"VMAF score[:=]\s*([\d.]+)").ok()?;
    re.captures_iter(stderr)
        .last()
        .and_then(|c| c[1].parse().ok())
}

/// Build the comparison: a 10-second window from the middle keeps it quick.
pub fn compare_args(
    original: &Path,
    result: &Path,
    duration: f64,
    use_vmaf: bool,
    w: u32,
    h: u32,
) -> Vec<String> {
    let window = 10.0_f64.min(duration.max(0.5));
    let start = ((duration - window) / 2.0).max(0.0);
    let metric = if use_vmaf { "libvmaf" } else { "ssim" };
    vec![
        "-ss".into(), format!("{start:.3}"), "-t".into(), format!("{window:.3}"), "-i".into(), result.to_string_lossy().to_string(),
        "-ss".into(), format!("{start:.3}"), "-t".into(), format!("{window:.3}"), "-i".into(), original.to_string_lossy().to_string(),
        "-lavfi".into(),
        format!("[0:v]scale={w}:{h}:flags=bicubic,setpts=PTS-STARTPTS[d];[1:v]scale={w}:{h}:flags=bicubic,setpts=PTS-STARTPTS[r];[d][r]{metric}"),
        "-f".into(), "null".into(), "-".into(),
    ]
}

pub fn measure(
    caps: &Capabilities,
    original: &Path,
    result: &Path,
    duration: f64,
    w: u32,
    h: u32,
) -> Result<QualityScore, FfError> {
    if w == 0 || h == 0 {
        return Err(FfError::Failed("No video to compare.".into()));
    }
    let use_vmaf = caps.has_filter("libvmaf");
    let text =
        ffmpeg::run_capture_stderr(&compare_args(original, result, duration, use_vmaf, w, h))?;
    let (metric, value) = if use_vmaf {
        ("VMAF", parse_vmaf(&text))
    } else {
        ("SSIM", parse_ssim(&text))
    };
    let value =
        value.ok_or_else(|| FfError::Failed("Couldn't measure quality for this file.".into()))?;
    Ok(QualityScore {
        metric: metric.into(),
        value,
        verdict: verdict(metric, value),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ssim_summary() {
        let t =
            "[Parsed_ssim_4 @ 0x1] SSIM Y:0.991 (20.4) U:0.99 (20) V:0.99 (20) All:0.987654 (19.1)";
        assert_eq!(parse_ssim(t), Some(0.987654));
    }

    #[test]
    fn parses_vmaf() {
        assert_eq!(
            parse_vmaf("[libvmaf @ 0x1] VMAF score: 94.312"),
            Some(94.312)
        );
    }

    #[test]
    fn verdicts_are_plain() {
        assert!(verdict("VMAF", 96.0).contains("identical"));
        assert!(verdict("SSIM", 0.99).contains("identical"));
        assert!(verdict("SSIM", 0.80).contains("Noticeably"));
    }

    #[test]
    fn compare_uses_middle_window() {
        let a = compare_args(
            Path::new("o.mp4"),
            Path::new("r.mp4"),
            100.0,
            false,
            1280,
            720,
        )
        .join(" ");
        assert!(a.contains("-ss 45.000 -t 10.000"));
        assert!(a.contains("ssim"));
    }
}
