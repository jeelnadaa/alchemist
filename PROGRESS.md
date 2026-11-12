# Progress

Status of Alchemist against [PLAN.md](PLAN.md). Updated 2026-11-12.

Legend: ✅ done and tested · 🟡 partly done (see note) · ⬜ not started

## Measured on a real build (Windows 11, x64, release, 2026-11-12)

| Budget | Target | Measured | |
|---|---|---|---|
| App binary | small | 7.2 MB | ✅ |
| Windows installer | small, tracked | 23.4 MB (FFmpeg is ~17 MB of it, compressed) | ✅ tracked by `check-sizes.mjs` |
| Portable zip | – | 33 MB | ✅ |
| Cold start to window | < 1 s | 0.26 s by hand, 0.7 s in `make budgets` (includes polling overhead) | ✅ |
| Idle in tray | < 30 MB | 1.8 MB working set after the window closes (32.7 MB before trimming was added), 0% CPU | ✅ enforced by `make budgets` |
| Recording 1080p | < 100 MB, < 5% CPU | FFmpeg capture process ~150 MB working set (≈83 MB of it is the mapped FFmpeg binary), recorder host ~14 MB; hardware NVENC encoder, 0 dropped frames | 🟡 over budget |
| Editor open | hard cap TBD | Web view ≈ 300–390 MB working set (shared WebView2 pages counted) | 🟡 cap not set yet |

The honest summary: size, start-up and idle are on target and enforced; recording memory is above budget because capture runs through a general FFmpeg build. The fix is a native capture path (see Next).

## Tests

| Suite | Count | What it covers |
|---|---|---|
| Rust unit (`make test-unit`) | 87 | resolution/fps limits (including high refresh rates up to 240 fps), portable mode, FFmpeg probe/progress/error parsing, target-size maths, every convert/enhance/export argument builder, recorder capture arguments for all three OSes, instant replay rolling buffer + custom framerates + keyframe GOP, WAV crash repair, project save/load/migrate/package/relink/history, silence/zoom/caption/waveform helpers, settings |
| Media end-to-end (`make test-media`) | 4 (+1 manual) | generates real clips and runs real FFmpeg: compress to size (lands under limit, VMAF measured), lossless remux, WebM/GIF/MP3, custom size+fps clamping, all enhance filters, silence detection, waveform, thumbnails, quality scoring, all five export presets plus range/custom export with zoom, padding, rounded corners, blur, highlight, text, captions, PiP, speed, freeze, fades, loudness; recording finalize + crash recovery; hardware encoder sanity. Manual (`--ignored`): a real 3 s screen recording with pause/resume and computer sound |
| UI logic (`make test-ui`) | 31 | timeline edits (split, trim, move+snap, ripple, duplicate, freeze, speed, silence removal), zoom maths identical to export, undo history, WCAG AA contrast for all 10 themes × 5 accents, custom theme validation, search ranking and synonyms, shortcut presets have no conflicts, timecodes and parsing at 30/60/120/144/240 fps, number formatting |
| Release scripts (`make test-scripts`) | 2 | asset naming contract, signed update manifest |
| Browser walkthrough | manual | first run, home, Ctrl K search, convert queue + report, editor (split, text, silence removal, undo), export dialog, settings themes + custom theme import, recorder + bar → editor |

Bugs the end-to-end tests caught and fixed: text fades used a 3-argument `min()` FFmpeg rejects; unused audio/video branches broke GIF and audio-only exports; blur radius too big for small regions; `%` in text was treated as a template; rounded corners were drawn on the padding instead of the picture; audio-only exports ended early after a freeze frame.

## Phase 1 — The Core

### 1.1 Recorder
- ✅ Full screen, chosen monitor, custom area (drag picker window), single window (Windows)
- 🟡 Single window on macOS/Linux: use Area instead (no window capture there yet)
- ✅ Webcam as a separate track, placed as a picture-in-picture overlay in the editor (round in preview; square in export)
- ✅ Computer sound and microphone as separate WAV tracks (computer sound: Windows WASAPI loopback, Linux PulseAudio/PipeWire monitor)
- 🟡 Computer sound on macOS needs ScreenCaptureKit (not done)
- ✅ Global hotkey Ctrl/Cmd+Shift+R, countdown, floating recording bar, tray icon, pause/resume joined into one clip
- ✅ Cursor, click, scroll and (opt-in) keystroke sidecar
- ✅ Presets (tutorial, high, tiny) and custom resolution/fps (up to 240 fps, with 30, 60, 120, 144, 240 fps quick chips and custom inputs) with the shared hard limits
- ✅ Instant replay: rolling buffer (15s to 2 min), hotkey Ctrl/Cmd+Shift+S, dedicated Replays folder, and persistent status chip in title bar and toolbar
- ✅ Crash-safe writing (Matroska clusters every second, WAV headers flushed every second) and automatic recovery on next launch
- ✅ Disk-space warnings, refusal under 500 MB free, auto-stop under 200 MB, dropped-frame count, post-recording report
- ✅ Auto-stop by time or size
- 🟡 Linux recording needs the distro's FFmpeg (the static build has no X11 capture); Wayland portal capture not done

### 1.2 Editor
- ✅ Multi-track timeline (video, camera/overlay, text, audio, zoom lane) with snapping to edges, markers and playhead
- ✅ Frame-accurate split, trim, ripple delete, move, duplicate; markers; in/out range
- ✅ Project size/fps changeable later, clamped by the shared limits
- ✅ Speed, reverse (export; preview plays forward), freeze frame
- ✅ Crop (zoom-in crop), rotate, flip, scale, position, aspect presets 16:9, 9:16, 1:1, 4:5
- ✅ Text, boxes, highlights, blur and pixelate regions; image overlays
- ⬜ Arrows (not drawn yet)
- ⬜ Transitions between clips (fades on clips exist; cross-transitions don't)
- ✅ Per-clip volume, fades, voice clean-up, track mute
- ⬜ Audio keyframes
- ✅ Light stand-in previews: files the web view can't play (MKV, AVI, ProRes…) get a 540p proxy automatically
- ✅ Undo/redo that survives restarts (200 steps)
- ✅ Customisable shortcuts with Alchemist, Premiere-, Final Cut- and DaVinci-style presets and conflict detection
- ✅ Autosave, snapshots every 10 minutes (last 20 kept), crash recovery for recordings
- ✅ Missing media detection and relink; package project into a portable folder

### 1.3 Convert & compress
- ✅ Batch queue with progress, ETA, cancel; keeps running with the window closed
- ✅ MP4, WebM, MOV, MKV, GIF, MP3, M4A, WAV; lossless remux when codecs allow
- ✅ Hardware encoding (verified by a real test encode) with software fallback
- ✅ Custom resolution/fps with fit/fill/stretch, proportion lock, presets up to 240 fps (120, 144, 240 fps) and custom framerate input
- ✅ Keeps metadata, chapters, subtitles and all audio tracks where the container allows
- ✅ Target-size mode (two-pass software, or hardware pass + automatic retry if over)
- ✅ Presets by use (chat, email, websites)
- ✅ Measured quality (VMAF, or SSIM if unavailable) with the metric named
- ✅ 5-second preview with before/after split slider and size estimate
- ✅ Honest report: sizes, ratio, quality, time taken; warning when a target can't look good

### 1.4 Export
- ✅ Background queue, keep editing while exporting
- ✅ Range export and audio-only export
- ✅ Presets (sharing, vertical, small file, GIF, audio) and custom size/fps
- ✅ Burned-in or sidecar (.srt) captions; loudness normalisation to −14 LUFS
- ⬜ Saving your own named export presets

### 1.5 Foundation
- 🟡 Budget harness: `make budgets` measures and enforces size, startup and idle memory; recording memory/CPU are measured manually (see table) and not yet enforced
- ✅ Ten themes (5 dark, 5 light incl. high contrast), follow system, accents, text size, reduce motion, custom theme import/export, contrast-tested
- ✅ First-run onboarding with permission explanations and links to the right OS setting
- ✅ Human error messages (FFmpeg errors translated)
- ✅ Keyboard navigation and visible focus; respects reduced motion
- ✅ Packaging: Windows installer (per-user) + portable zip built and verified locally; macOS/Linux packaging defined in CI but not yet run
- ✅ Makefile, BUILDING.md, CI and release pipeline with automatic versioning, draft-then-publish, checksums, signed update manifest, size check, smoke test
- ✅ Auto-update (auto / notify / off, daily with jitter, signature verified, waits for idle, portable → download link, beta channel → link)
- 🟡 Update rollback: the installer is atomic, but keeping the previous version for automatic rollback isn't implemented
- ✅ Versioned project format with migration; originals never touched
- ✅ Local-only crash reports
- ✅ Website (landing + download pages) on Cloudflare Workers static assets (`wrangler.jsonc`, `site/_worker.js` for `/api/latest`), Satoshi self-hosted
- ✅ Production-grade UI redesign: specular rim lighting, glassmorphism, zero-runtime-cost native CSS tooltips, streamlined 72px rail navigation, and Raycast-style search bar

### Phase 1 exit criteria
- ✅ Record, trim, annotate, export and compress entirely inside Alchemist
- 🟡 Every budget met and verified automatically — startup/idle yes; recording memory not yet
- ✅ Forced crash loses about a second (tested with simulated crash: segments + WAV recovered)
- 🟡 Preview equals export — same maths for layout, zoom, text and timing; preview doesn't show reverse playback or exact blur strength
- ⬜ A tagged release producing every package and an older install updating itself — pipeline written, not yet run on GitHub
- ✅ Custom resolution/fps limits enforced in recorder, editor, converter and export

## Phase 2 — Differentiators
- ✅ Auto-zoom from clicks with strength and smoothness; manual zooms
- ⬜ Restylable cursor, click ripples and keystroke overlays (data is recorded; rendering not done)
- ✅ Background, padding, rounded corners for the "app demo" look (shadow not done)
- ⬜ Speed ramping for typing/idle moments
- ✅ Silence detection and one-click removal
- 🟡 Captions: manual, import/export SRT/VTT, burn-in. ⬜ On-device automatic captions, word highlight, translation, edit-by-transcript, filler-word removal
- 🟡 Audio: noise removal (afftdn), loudness normalisation. ⬜ echo removal, studio voice, ducking, voiceover recording, music library
- ⬜ Webcam background blur/removal, auto-framing, auto-reframe
- 🟡 Workflow: relink + package done. ⬜ templates, media library search/tags, copy/paste effects

## Phase 3 — Depth and mastery
- 🟡 Enhance: denoise, sharpen, stabilise, 2× upscale (high-quality scaling, not AI), deinterlace, HDR→SDR, before/after preview. ⬜ AI upscaling, frame interpolation, batch enhance presets
- ⬜ Keyframes, colour tools/LUTs, chroma key, slip/slide/roll, nested sequences, multicam
- ✅ Instant replay (rolling buffer, hotkey `Ctrl Shift S`, Replays folder, high-framerate buffer support up to 240 fps) done; ⬜ watch folders, pipelines, scheduled recording, command-line interface
- ⬜ Opt-in connected features, interchange formats
- 🟡 Polish: first-run guide and empty states done; ⬜ localisation, public benchmark page

## Next, in order
1. **Push to GitHub and run the release pipeline once** (add the `TAURI_SIGNING_PRIVATE_KEY` secret first) to produce macOS and Linux packages and verify an update from 0.1.0 to 0.1.1.
2. **Native capture** (Windows Graphics Capture, ScreenCaptureKit, PipeWire) to bring recording under 100 MB and add macOS computer sound and Wayland.
3. On-device captions (whisper.cpp, model downloaded on first use and unloaded after).
4. Cursor styling and keystroke overlays from the existing sidecar data.
5. Arrows, transitions, audio keyframes, saved export presets.
6. Automatic update rollback; enforce recording budgets in CI.

## Decisions waiting on you
- **Logo**: the app uses the Delta mark; swap `brand/` and run `npx tauri icon` to change it.
- **Licence** for Alchemist itself (FFmpeg is bundled as a separate GPL program).
- **Code-signing certificates** (optional; builds work unsigned with OS warnings).
