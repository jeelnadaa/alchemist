//! Custom resolution and frame-rate limits (PLAN.md section 5).
//!
//! This is the single place the hard limits are defined. The recorder, editor
//! project settings, converter and exporter all call [`clamp_video`], so the
//! limits can never drift apart.

use serde::{Deserialize, Serialize};

pub const MIN_WIDTH: u32 = 128;
pub const MIN_HEIGHT: u32 = 72;
pub const MAX_WIDTH: u32 = 7680;
pub const MAX_HEIGHT: u32 = 4320;
pub const MIN_FPS: f64 = 1.0;
pub const MAX_FPS: f64 = 240.0;

/// Frame rates offered as one-click presets everywhere.
pub const PRESET_FPS: [f64; 11] = [
    23.976, 24.0, 25.0, 29.97, 30.0, 50.0, 59.94, 60.0, 120.0, 144.0, 240.0,
];

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct VideoSettings {
    pub width: u32,
    pub height: u32,
    pub fps: f64,
}

/// Result of validating user input: the value that will actually be used and
/// plain-language notes about anything that was changed.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Clamped {
    pub value: VideoSettings,
    pub notes: Vec<String>,
}

fn clamp_dim(v: u32, min: u32, max: u32, name: &str, notes: &mut Vec<String>) -> u32 {
    let mut out = v;
    if out < min {
        notes.push(format!("{name} raised to the minimum of {min} px."));
        out = min;
    } else if out > max {
        notes.push(format!("{name} lowered to the maximum of {max} px."));
        out = max;
    }
    if out % 2 == 1 {
        // Round to the nearest even number, staying inside the limits.
        let even = if out < max { out + 1 } else { out - 1 };
        notes.push(format!(
            "{name} must be an even number, so {out} became {even}."
        ));
        out = even;
    }
    out
}

/// Clamp a requested resolution and frame rate to the hard limits.
/// Never fails: out-of-range input is corrected and explained.
pub fn clamp_video(req: VideoSettings) -> Clamped {
    let mut notes = Vec::new();
    let width = clamp_dim(req.width, MIN_WIDTH, MAX_WIDTH, "Width", &mut notes);
    let height = clamp_dim(req.height, MIN_HEIGHT, MAX_HEIGHT, "Height", &mut notes);

    let mut fps = if req.fps.is_finite() { req.fps } else { 30.0 };
    if fps < MIN_FPS {
        notes.push(format!(
            "Frame rate raised to the minimum of {MIN_FPS} fps."
        ));
        fps = MIN_FPS;
    } else if fps > MAX_FPS {
        notes.push(format!(
            "Frame rate lowered to the maximum of {MAX_FPS} fps."
        ));
        fps = MAX_FPS;
    }
    let rounded = (fps * 100.0).round() / 100.0;
    // 23.976 and 59.94-style rates are kept exactly when they match a preset.
    let preset = PRESET_FPS
        .iter()
        .copied()
        .find(|p| (p - fps).abs() < 0.0005);
    let fps_out = match preset {
        Some(p) => p,
        None => {
            if (rounded - fps).abs() > 1e-9 {
                notes.push(format!(
                    "Frame rate rounded to two decimal places: {rounded} fps."
                ));
            }
            rounded
        }
    };

    Clamped {
        value: VideoSettings {
            width,
            height,
            fps: fps_out,
        },
        notes,
    }
}

/// FFmpeg-friendly frame-rate string: NTSC rates become exact fractions.
pub fn fps_to_ffmpeg(fps: f64) -> String {
    for (approx, frac) in [
        (23.976, "24000/1001"),
        (29.97, "30000/1001"),
        (59.94, "60000/1001"),
        (119.88, "120000/1001"),
    ] {
        if (fps - approx).abs() < 0.001 {
            return frac.to_string();
        }
    }
    if fps.fract() == 0.0 {
        format!("{}", fps as u64)
    } else {
        format!("{fps}")
    }
}

/// Fit/fill/stretch of a source into a target frame, as FFmpeg filters.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FitMode {
    Fit,
    Fill,
    Stretch,
}

pub fn scale_filter(w: u32, h: u32, mode: FitMode) -> String {
    match mode {
        FitMode::Fit => format!(
            "scale={w}:{h}:force_original_aspect_ratio=decrease:flags=lanczos,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1"
        ),
        FitMode::Fill => format!(
            "scale={w}:{h}:force_original_aspect_ratio=increase:flags=lanczos,crop={w}:{h},setsar=1"
        ),
        FitMode::Stretch => format!("scale={w}:{h}:flags=lanczos,setsar=1"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(w: u32, h: u32, fps: f64) -> VideoSettings {
        VideoSettings {
            width: w,
            height: h,
            fps,
        }
    }

    #[test]
    fn in_range_values_pass_untouched() {
        let c = clamp_video(v(1920, 1080, 60.0));
        assert_eq!(c.value, v(1920, 1080, 60.0));
        assert!(c.notes.is_empty());
    }

    #[test]
    fn minimum_and_maximum_are_enforced() {
        let lo = clamp_video(v(10, 10, 0.1));
        assert_eq!(lo.value, v(MIN_WIDTH, MIN_HEIGHT, MIN_FPS));
        assert_eq!(lo.notes.len(), 3);
        let hi = clamp_video(v(99_999, 99_999, 1000.0));
        assert_eq!(hi.value, v(MAX_WIDTH, MAX_HEIGHT, MAX_FPS));
    }

    #[test]
    fn exact_limits_are_allowed() {
        let c = clamp_video(v(MAX_WIDTH, MAX_HEIGHT, MAX_FPS));
        assert!(c.notes.is_empty());
        let c = clamp_video(v(MIN_WIDTH, MIN_HEIGHT, MIN_FPS));
        assert!(c.notes.is_empty());
    }

    #[test]
    fn odd_numbers_become_even() {
        let c = clamp_video(v(1281, 721, 30.0));
        assert_eq!(c.value.width, 1282);
        assert_eq!(c.value.height, 722);
        assert_eq!(c.notes.len(), 2);
    }

    #[test]
    fn odd_at_the_maximum_rounds_down() {
        // 7679 is below the max but odd; rounding up would exceed nothing, so it goes up.
        assert_eq!(clamp_video(v(7679, 1080, 30.0)).value.width, 7680);
        // An odd minimum rounds up.
        assert_eq!(clamp_video(v(129, 73, 30.0)).value, v(130, 74, 30.0));
    }

    #[test]
    fn high_framerate_presets_and_custom() {
        assert_eq!(clamp_video(v(1920, 1080, 120.0)).value.fps, 120.0);
        assert_eq!(clamp_video(v(1920, 1080, 144.0)).value.fps, 144.0);
        assert_eq!(clamp_video(v(1920, 1080, 240.0)).value.fps, 240.0);
        // Custom gaming framerate like 165Hz
        let c165 = clamp_video(v(2560, 1440, 165.0));
        assert_eq!(c165.value.fps, 165.0);
        assert_eq!(fps_to_ffmpeg(165.0), "165");
        assert_eq!(fps_to_ffmpeg(144.0), "144");
        assert_eq!(fps_to_ffmpeg(240.0), "240");
    }

    #[test]
    fn decimal_frame_rates() {
        assert_eq!(clamp_video(v(1920, 1080, 23.976)).value.fps, 23.976);
        assert_eq!(clamp_video(v(1920, 1080, 29.97)).value.fps, 29.97);
        let c = clamp_video(v(1920, 1080, 47.123));
        assert_eq!(c.value.fps, 47.12);
        assert_eq!(c.notes.len(), 1);
        assert_eq!(clamp_video(v(1920, 1080, f64::NAN)).value.fps, 30.0);
    }

    #[test]
    fn ffmpeg_rates_are_exact_fractions() {
        assert_eq!(fps_to_ffmpeg(29.97), "30000/1001");
        assert_eq!(fps_to_ffmpeg(23.976), "24000/1001");
        assert_eq!(fps_to_ffmpeg(60.0), "60");
        assert_eq!(fps_to_ffmpeg(12.5), "12.5");
    }

    #[test]
    fn scale_filters() {
        assert!(scale_filter(1280, 720, FitMode::Fit).contains("pad=1280:720"));
        assert!(scale_filter(1080, 1920, FitMode::Fill).contains("crop=1080:1920"));
        assert_eq!(
            scale_filter(640, 360, FitMode::Stretch),
            "scale=640:360:flags=lanczos,setsar=1"
        );
    }
}
