# Alchemist: Product & Build Plan

Alchemist is a local-first video studio: **record, edit, convert, enhance and compress** in one polished app. It is meant to replace a screen recorder, a video editor, a converter and a compressor with a single tool that is fast, private and light.

This document describes **what** to build and **why**. The technology choices are yours to make. The only constraint is the one below.

---

## 1. Prime Directive: As Light As Possible

Lightness is the defining quality of Alchemist, and every decision should be weighed against it.

- Low RAM, low CPU, small install size, fast startup, no idle drain.
- Prefer the leanest approach that still delivers a polished result. Pick the technology that serves lightness, not the one that is most convenient.
- Never load what the current task doesn't need. Recording must not pay for the editor, and converting must not pay for the timeline.
- Memory use must stay **flat** regardless of recording length or project size.
- Heavy work must never freeze the interface.

### Budgets (enforced by automated tests that fail the build when exceeded)

| Scenario | Target |
|---|---|
| Idle in tray | under 30 MB RAM |
| Recording 1080p60 | under 100 MB RAM, under 5% CPU on a mid-range machine |
| Editor open, empty project | as small as possible; set a hard cap early and never raise it casually |
| Cold start to usable | under 1 second for recorder, under 2 seconds for editor |
| Installer size | as small as possible; track it every release |

Treat these numbers as starting points. Tighten them as the product matures, and publish the real measured figures on the website. Honest numbers are part of the brand.

---

## 2. Product Principles

1. **One app, not a suite.** The user sees one icon, one installer and one design language.
2. **Isolated internally.** Recording, editing and exporting must not share memory or crash together (see Architecture).
3. **Local-first and private.** No account needed. Files never leave the device unless the user explicitly chooses. Anything cloud-based is opt-in, per feature, and clearly labelled.
4. **Non-destructive.** Original files are never modified. Edits, effects and recording enhancements are applied on top.
5. **Honest numbers.** Show real file sizes, real quality scores, real speeds and real before/after comparisons. No inflated claims.
6. **Polished everywhere.** No half-finished modules. A beginner gets a great result in two clicks, and an expert can reach every setting.
7. **Preview equals export.** What you see is exactly what you get.
8. **Never lose work.** Crash-safe recording, autosave, and recovery on next launch.

---

## 3. Architecture (Conceptual)

One product, several cooperating processes. This is the mechanism that delivers both "one app" and "light recording".

- **Shared core:** one engine for capture, decoding, encoding, effects and export, used by every part of the app so behavior is consistent everywhere.
- **Recorder process:** a tiny, standalone process with a floating toolbar and the capture pipeline. It never loads the timeline, previews or editor UI. It can run while the editor is closed.
- **Editor process:** the full editing interface. It can crash or close without affecting a recording in progress.
- **Worker processes:** conversion, compression, enhancement and export run as background jobs from a queue. They are separate so heavy work cannot bloat or freeze the editor, and they keep working with the editor closed.
- **Hand-off through files and a lightweight message channel:** when a recording ends, it is written into the project and the editor is notified. Nothing large is passed through memory.

### Recorder design rules
- Use the operating system's most efficient native capture path.
- Keep frames off system memory wherever possible and use hardware acceleration for encoding with a software fallback.
- Use small fixed-size buffers so memory never grows during long recordings.
- Write to disk continuously in a crash-safe form so a power cut or crash loses almost nothing.
- Skip live preview while recording, or keep it tiny.
- Record cursor, click, keystroke, scroll and window-focus data as a **separate sidecar**, so effects such as auto-zoom are applied later in the editor and never baked into the capture.
- Record system audio and microphone as **separate tracks**.

---

## 4. Phases

There are exactly three phases. Each phase must end in a shippable, polished state. Do not start the next phase until the current one meets its exit criteria.

---

### Phase 1: The Core (Foundation That Must Be Excellent)

**Goal:** a complete, light, reliable tool that already replaces a screen recorder, a basic editor and a converter/compressor.

#### 1.1 Recorder
- Capture: full screen, single window, custom region, chosen monitor.
- Webcam capture as a picture-in-picture bubble or full frame (basic shape, border, mirror).
- System audio plus microphone as separate tracks.
- Controls: global hotkeys, countdown, floating toolbar, tray icon, pause/resume into one seamless clip.
- Cursor, click and keystroke sidecar recorded from day one, even though its effects arrive in Phase 2.
- Quality presets (tutorial, high quality, tiny file).
- **Custom resolution and frame rate** within the limits defined in section 5 (Custom Resolution & Frame Rate Limits).
- Crash-safe recording with automatic recovery.
- Disk-space warnings, dropped-frame detection and an honest post-recording report.
- Auto-stop by time or size.

#### 1.2 Editor (essentials, done really well)
- Multi-track timeline for video, audio and overlays, with snapping.
- Frame-accurate trim, split, ripple delete, move and duplicate.
- Markers and in/out points.
- Project settings with custom resolution and frame rate, changeable later without damaging the edit, within the limits in section 5.
- Speed change, reverse, freeze frame.
- Crop, rotate, flip, scale, position, and aspect-ratio presets (16:9, 9:16, 1:1, 4:5).
- Basic text, shapes, arrows, highlight boxes and blur/pixelate regions for hiding sensitive content.
- Image and logo overlays.
- A small set of high-quality transitions (quality over quantity).
- Per-track volume, fades and basic audio keyframes.
- Smooth scrubbing, including large and high-resolution footage, using lightweight stand-in previews where needed.
- Unlimited undo/redo that survives restarts.
- Fully customizable keyboard shortcuts, plus familiar preset layouts for people switching from other editors.
- Autosave, versioned snapshots and crash recovery.

#### 1.3 Convert & Compress (first-class, usable without opening the editor)
- Drag-and-drop batch queue.
- Common video and audio formats in and out, plus GIF and audio extraction.
- Lossless container change (remux) without re-encoding when possible.
- Hardware-accelerated encoding with a software fallback.
- **Custom output resolution and frame rate** (with aspect-ratio lock, fit/fill/stretch options and preset frame rates such as 23.976, 24, 25, 29.97, 30, 50, 59.94, 60), within the limits in section 5.
- Preserve or edit metadata, subtitles, chapters and multiple audio tracks.
- **Target-size mode** ("make this under 25 MB") that chooses settings automatically.
- Platform presets (messaging apps, email, social, web embedding).
- Quality slider backed by a real quality metric, with the actual number shown.
- Short preview before committing, with estimated size and time.
- Honest result report: size saved, quality score, time taken.

#### 1.4 Export
- Background export queue so the user can keep working.
- Export a selected range or audio only.
- Custom and built-in presets.
- Custom resolution and frame rate on export, within the limits in section 5.
- Burn-in or sidecar captions (the caption engine arrives in Phase 2; the plumbing exists now).

#### 1.5 Foundation work (not optional)
- Memory and performance test harness enforcing the budgets above.
- Design system and **multiple light and dark themes**, as defined in section 7.
- **First-run permission onboarding:** screen-recording, microphone and camera permissions explained in plain words before the OS prompt appears (macOS Screen Recording / TCC, Windows privacy toggles, Linux Wayland portal via PipeWire with an X11 fallback). If a permission is missing, the recorder says exactly which setting to change and offers a button that opens it.
- Clear, human error messages (no cryptic technical output).
- Accessibility basics from day one (full keyboard navigation, visible focus, respects OS reduced-motion and contrast settings). Phase 3 deepens this; it does not start it.
- Packaging for all three operating systems, the build Makefile, the auto-updater and the CI/release pipeline, all as defined in section 6. These are part of Phase 1, not an afterthought, so every phase ships through the real pipeline.
- The website (landing and download pages) as defined in section 8, live before the first public release.
- Project format that is portable, versioned and never touches originals.
- Local-only crash reports: on crash, a minimal report is saved on disk and the user is offered to view or share it. Nothing is sent automatically.

**Phase 1 exit criteria**
- A person can record, trim, annotate, export and compress a video entirely inside Alchemist with no external tools.
- Every memory and startup budget is met and verified by automated tests.
- A forced crash during recording loses no more than a couple of seconds of footage.
- Preview and export match visually and audibly.
- A tagged release produces every package listed in section 6 automatically, and an installed older version updates itself to it successfully.
- Custom resolution and frame rate work in the recorder, editor, converter and export, and the limits in section 5 are enforced everywhere.

---

### Phase 2: The Differentiators (What Makes It Special)

**Goal:** the features that make Alchemist feel like a premium product and a real alternative to dedicated demo and tutorial tools.

#### 2.1 Screen-demo polish (driven by the Phase 1 sidecar data)
- **Auto-zoom** that follows the cursor and clicks, with adjustable strength and smoothness.
- Smooth, restylable, resizable cursor with click ripples and highlights.
- Keystroke overlays and spotlight/dim effects.
- Background, padding, rounded corners and shadow styling for a clean "app demo" look.
- Speed ramping to skip typing, loading and idle moments.
- Silence and dead-air detection with one-click removal.

#### 2.2 Captions and text-based editing (on-device)
- Automatic captions with word-level timing, running locally.
- Caption styling presets, including word-by-word highlight, plus translation.
- Caption export in standard subtitle formats.
- **Edit by transcript:** delete words in the text and the video cuts follow.
- Filler-word and long-pause removal.

#### 2.3 Audio quality
- Noise removal, echo and reverb reduction, and a one-slider "studio voice".
- Loudness normalization to common targets, with the measured value displayed honestly.
- Auto-ducking (music dips under speech).
- Voiceover recording straight onto the timeline.
- Built-in royalty-free music and sound effects, or a clean library import experience.

#### 2.4 Webcam and framing
- Background blur and removal without a green screen, running locally.
- Auto-framing and lighting correction.
- Auto-reframe for vertical output, tracking the speaker or cursor.
- Shape, border and layout templates (picture-in-picture, split screen).

#### 2.5 Workflow
- Project templates (tutorial, product demo, short-form vertical video).
- Media library with search, tags and duplicate detection.
- Relink missing media and package a project into a portable folder.
- Copy and paste effect stacks between clips.

**Phase 2 exit criteria**
- A raw screen recording becomes a polished, captioned, zoom-animated demo in a few minutes with minimal manual work.
- All AI-style features run on-device by default, are clearly labelled, and respect the lightness budgets (heavy models load only when used and unload afterwards).
- Recorder memory and startup budgets are unchanged from Phase 1.

---

### Phase 3: Depth and Mastery (Power, Automation, Ecosystem)

**Goal:** advanced quality, deep control and automation, so professionals and power users can stay in Alchemist.

#### 3.1 Enhance (quality improvement)
- AI upscaling to higher resolutions.
- Denoise and deblock, including restoration of old or heavily compressed footage.
- Sharpening and detail recovery.
- Frame-rate conversion and smooth slow motion through interpolation.
- Stabilization.
- HDR to SDR tone mapping so phone footage never looks washed out.
- De-interlacing.
- A **before/after split-view slider** on every enhancement, with batch enhancement through the worker queue.

#### 3.2 Advanced editing and color
- Full keyframing for every property.
- Exposure, contrast, white balance, curves, LUT support, and a one-click auto-fix.
- Chroma key, vignette and other effects, all non-destructive.
- Slip, slide and roll edits, nested sequences and adjustment layers.
- Advanced animated text and motion presets.
- Multi-camera and multi-monitor recording workflows.

#### 3.3 Automation
- Watch folders for automatic conversion and compression.
- Batch processing and reusable pipelines (for example "record, caption, compress, export").
- Instant-replay recording (rolling buffer saved on a hotkey) and scheduled recording.
- Command-line access to conversion and compression for scripting.

#### 3.4 Optional connected features (always opt-in, always clearly labelled)
- Bring-your-own-provider features such as auto chapters, summaries and translation.
- Sharing to the user's own storage, such as a personal server or cloud drive. No required accounts and no required hosting.
- Import and export of common interchange formats from other editors.

#### 3.5 Final polish
- Interactive first-run tutorial and helpful empty states.
- Accessibility pass (keyboard navigation, screen reader support where possible, contrast).
- Localization, with strong coverage of widely used languages including Indian languages.
- Public benchmark page showing real measured memory, speed and quality results.

**Phase 3 exit criteria**
- Enhancement and conversion results are measurably good, and the comparisons shown are honest.
- Power users can fully automate repetitive work without opening the editor.
- Lightness budgets still hold. Any new feature that breaks a budget must be fixed or made opt-in and lazy-loaded.

---

## 5. Custom Resolution & Frame Rate Limits

Users can set any resolution and frame rate they want, but only inside safe, sensible limits. The limits exist to protect the lightness budgets, prevent crashes and stop settings that cannot produce a good result.

### Hard limits (cannot be exceeded under any circumstance)

| Setting | Minimum | Maximum |
|---|---|---|
| Resolution (width x height) | 128 x 72 | 7680 x 4320 (8K) |
| Frame rate | 1 fps | 240 fps |
| Decimal frame rates | allowed (for example 23.976, 29.97, 59.94) | up to two decimal places |

- Width and height must be even numbers (the app rounds to the nearest valid value and tells the user).
- Any input outside the hard limits is clamped with a clear message stating the limit, never silently changed and never an error dump.
- The same hard limits apply in the recorder, editor project settings, converter and exporter, defined in one place so they can never drift apart.

### Recommended (soft) limits, derived from the user's own machine
- At startup and when hardware changes, the app measures what the machine can realistically do (capture, encode and decode capability).
- If the user picks a value above what their machine can handle well, the app shows a clear warning with the likely consequence (dropped frames, slow export, high memory) and a suggested safer value. The user may still proceed up to the hard limit.
- **Recording is stricter than exporting:** a custom recording setting must never push the recorder past its memory and CPU budget. If it would, the app warns before recording starts and offers the nearest setting that fits.
- Show a live estimate for the chosen settings: expected file size per minute, rough CPU/GPU load and whether hardware encoding is available.

### Behavior rules
- Capturing at a custom resolution and frame rate never changes the original source; scaling and frame-rate conversion happen at capture or export time, never destructively.
- Raising frame rate above the source (for example 30 to 60) is only done through proper frame interpolation (Phase 3) or frame duplication, and the app says which one is used.
- Raising resolution above the source is labelled as upscaling, and is honest about the result (Phase 3 enhancement offers real upscaling).
- Aspect-ratio lock is on by default, with presets (16:9, 9:16, 1:1, 4:5, 21:9) plus fully custom values.
- Users can save custom combinations as named presets.
- Automated tests cover the minimum, the maximum, out-of-range values, odd numbers and decimal frame rates, and confirm that the recorder stays within its memory budget at the highest allowed recording setting the machine supports.

---

## 6. Packaging, Build, Auto-Update & Release Pipeline

### 6.1 What users download (per release)

Everything is self-contained: users install nothing else first.

Every OS gets **both an installer and a portable build**.

| OS | Installer | Portable |
|---|---|---|
| **Windows** (10 and 11, x64; arm64 if practical) | Setup `.exe`, **per-user by default** (no admin prompt, so silent self-updates work); an all-users option may exist | **Portable `.zip`**: unzip and run, no installation, no registry dependence |
| **macOS** (12 or later) | `.dmg` for **Apple silicon (arm64)** and `.dmg` for **Intel (x64)**. A universal image may be added, but the two separate ones must exist so downloads stay small | **Portable `.zip`** containing the `.app`, per architecture |
| **Linux** (x64 and arm64) | Native `.deb` (Debian/Ubuntu) and `.rpm` (Fedora/RHEL) packages | **AppImage** and **`.tar.gz`** |

**Portable mode rules**
- A portable build is detected by a marker file next to the executable (for example `portable.txt`).
- In portable mode, all settings, caches, presets, logs and crash reports live in a `data/` folder next to the app. Nothing is written to the user profile, the registry or system folders, so the whole folder can live on a USB stick.
- If the portable folder is read-only, the app says so once and falls back to the normal user profile location for that session.

**Exact asset naming** (the website and the auto-updater both match on this pattern, so it is a contract and must be tested in CI):

```
alchemist-<version>-<os>-<arch>[-<kind>].<ext>
  os    = windows | macos | linux
  arch  = x64 | arm64 | universal
  kind  = setup | portable        (omitted when the extension already says it)

alchemist-1.4.2-windows-x64-setup.exe
alchemist-1.4.2-windows-x64-portable.zip
alchemist-1.4.2-macos-arm64.dmg
alchemist-1.4.2-macos-x64.dmg
alchemist-1.4.2-macos-arm64-portable.zip
alchemist-1.4.2-linux-x64.AppImage
alchemist-1.4.2-linux-x64.tar.gz
alchemist-1.4.2-linux-x64.deb
alchemist-1.4.2-linux-x64.rpm
SHA256SUMS.txt
latest.json        (update manifest, see 6.4)
latest.json.sig    (signature of the manifest)
```

- Every release publishes `SHA256SUMS.txt` covering all assets.
- Installers must be small. Track installer size per release and treat a sudden jump as a bug.
- Installers and the app itself must be code-signed and notarized where the platform expects it (Windows signing, macOS signing and notarization). If signing certificates are not yet available, the pipeline must still work with clearly documented unsigned builds, and signing must be switchable on through pipeline secrets without changing any code.
- The website download page should detect the user's OS and architecture and offer the right file first.

### 6.2 Build system (the Makefile)

A single `Makefile` at the repository root is the one entry point for building the app, locally and in CI. A developer on any OS should be able to clone the repo, run one command and get a working build. The pipeline must call the same targets so local and CI builds never differ.

Required targets (names can be refined, behavior must be kept):
- `make` / `make build`: build the app for the current OS and architecture.
- `make run`: build if needed and launch.
- `make test`: run all automated tests, including the memory, startup and resolution/frame-rate limit tests from earlier sections.
- `make lint`: run formatting and static checks.
- `make package`: produce all packages valid for the current OS (installer and portable zip on Windows, disk image on macOS, AppImage, tar.gz and native packages on Linux).
- `make package-<format>`: build one specific package type.
- `make version`: print the current version (from the single source of truth, see 6.3).
- `make clean` and `make distclean`: remove build output, and additionally caches and downloaded dependencies.
- `make deps`: fetch and prepare dependencies in a reproducible way (pinned versions only).
- `make help`: list every target with a one-line description.

Rules:
- Builds are **reproducible**: all dependencies pinned, no surprise network fetches at build time beyond `make deps`.
- Builds are **incremental**: only what changed is rebuilt, locally and in CI.
- Clear errors: a missing tool produces a plain message saying what to install, not a wall of output.
- Release builds are optimized and stripped for minimum size, and keep debug symbols as separate files for crash analysis.
- A short `BUILDING.md` explains prerequisites and usage for each OS.

### 6.3 Versioning (automatic increment)

- Versioning follows semantic versioning (MAJOR.MINOR.PATCH).
- There is **one single source of truth** for the version. The app, installers, update manifest and release notes all read from it.
- The version is **incremented automatically by the pipeline**, no one edits it by hand. It is derived from commit messages using a simple convention:
  - a fix produces a patch bump,
  - a new feature produces a minor bump,
  - a breaking change produces a major bump,
  - documentation, comment, CI-only and chore changes produce **no bump and no release**.
- The pipeline creates the Git tag and a GitHub Release, and generates release notes (changelog) grouped by type from the commit messages.
- Pre-release tags (for example beta) are supported and are marked as pre-releases so the auto-updater can treat them separately.
- Automated commits made by the pipeline must never trigger the pipeline again (no infinite loops).
- The version number is applied at the **final packaging step**, so that changing the version never invalidates the compile cache. The app reads its version at runtime from a small resource/metadata file written at packaging time, not from a compiled-in constant.

**Release cadence (avoid update fatigue).** Releasing on every single merge would push an update to users several times a day. Instead, use a **release pull request**: the pipeline keeps one open PR that accumulates the changelog and the computed next version as fixes and features land on main. Merging that PR is what tags and publishes the release. Versioning stays fully automatic; a maintainer only decides *when* to ship. Urgent fixes ship by merging the release PR immediately.

### 6.4 Auto-update (inside the app)

The app updates itself using **GitHub Releases** as the source.

**Checking**
- Checks the repository's latest release on startup (throttled to at most once per day, with random jitter so all users don't hit GitHub at the same minute) and when the user clicks "Check for updates".
- **Stable channel:** downloads the signed manifest from `https://github.com/<owner>/<repo>/releases/latest/download/latest.json`. This is a plain file download, not a GitHub API call, so it is **not subject to the 60-requests-per-hour API limit** and never needs a token.
- **Beta channel (opt-in):** uses the GitHub Releases API list endpoint (pre-releases are excluded from "latest"), with `ETag` conditional requests so repeat checks cost nothing against the rate limit.
- `latest.json` contains: version, release date, minimum supported version for in-place update, notes URL, and per-asset entries (OS, arch, kind, URL, size, SHA-256).
- Ignores drafts and pre-releases unless the user opted into the beta channel. Fails silently and quietly (retry later) when offline.
- The check is done by a tiny short-lived background process and never stays resident, to respect the lightness budget.

**Downloading and applying**
- Picks the correct asset for the current OS, architecture and install type (installer, portable, AppImage, native package).
- Downloads in the background with resume support and a visible, honest progress indicator.
- **Verifies integrity and authenticity before applying**: checksum plus a signature check against a public key embedded in the app. An update that fails verification is discarded and never applied.
  - The update-signing key (a small Ed25519 key) is **separate from OS code-signing certificates**, lives only in release-pipeline secrets, and has an offline backup.
  - The app embeds the current public key **and** a next/rotation key, so the signing key can be rotated without stranding old installs.
- Applies the update automatically on the next restart, or immediately when the user clicks "Restart and update".
- **Never interrupts important work.** No update is applied during a recording, an active export or a running conversion job. It waits until idle.
- Keeps the previous version so a failed update **rolls back automatically**, and the user is never left with a broken app.
- Prevents downgrades, unless the user explicitly chooses an older version.

**Install-type behavior**
- Windows installer and portable zip: update in place (portable updates the portable folder, not the system). Because the default install is per-user, no admin prompt interrupts the update.
- macOS: replace the app bundle safely. Note that an unsigned or quarantined app launched from a translocated (randomized read-only) path cannot update itself; in that case the app asks the user to move it to Applications first. The portable `.zip` updates by replacing the `.app` next to it.
- Linux AppImage: update the AppImage file in place. Native packages (Debian/Fedora style) show a notification pointing to the package or the new download, since the system package manager owns those files.
- If an in-place update is not possible for any reason (permissions, read-only location), the app shows a clear message and a download link instead of failing.

**User control and privacy**
- Settings offer three modes: automatic, notify only, and off.
- Shows the changelog for the new version before or after updating.
- The updater contacts GitHub only, sends no telemetry and no identifying data.
- Later optimization (not Phase 1): delta/binary-diff updates so a small fix doesn't re-download the whole app.

### 6.5 CI/CD pipeline (GitHub)

The pipeline runs on GitHub, builds and tests the app on every OS, and publishes releases to GitHub Releases. It is designed so it never rebuilds more than it needs to.

**Triggers and what each one does**
- **Pull request:** build and test only. No release, no version bump, no publishing.
- **Merge to the main branch:** build and test every platform, and update the release PR (next version + changelog, see 6.3).
- **Merge of the release PR:** tag, build, package everything, and publish a GitHub Release.
- **Documentation-only, comment-only or CI-config-only changes:** **skip the app builds entirely** and produce no release. A change to a Markdown file or a document must cost almost nothing.
- **Website-only changes (`site/`):** deploy the website only (section 8); never build the app. App-only changes never redeploy the website.
- **Manual trigger:** allows a maintainer to run a release or a dry run on demand.

**Smart, per-OS builds**
- Platform jobs run in parallel for Windows, macOS (Intel and Apple silicon) and Linux (x64 and arm64).
- Changes limited to one platform's code (for example only Windows-specific files) only rebuild and retest **that** platform in pull requests. Changes to shared code rebuild all platforms.
- Obsolete runs are cancelled automatically when a newer commit arrives on the same branch.

**Caching (so work is never repeated)**
- Cache dependencies, toolchains and **incremental build output** per OS and architecture.
- Cache keys are based on the content that really affects the result (dependency lock information and relevant source), so an unrelated change does not throw the cache away.
- Release builds restore the previous cache and recompile only what changed.
- Cache usage and build time are reported in every run, and a sudden loss of cache effectiveness is treated as a pipeline bug.

**Release safety**
- The release is created as a **draft** and published only when **all** platform builds and tests succeed. A failure on one OS never produces a half-complete release.
- Every release includes all packages from section 6.1, the SHA-256 checksums, the signed update manifest and the generated release notes.
- Tests in the pipeline include the memory, startup and installer-size budget checks, and a build that exceeds a budget fails.
- Secrets (signing keys, tokens) are used only in release runs, never exposed to pull requests from forks.
- A successful run on a clean machine installs the produced package, launches it and runs a basic smoke test before the release is published.

---

## 7. Themes & Design System

Alchemist ships with **multiple light and dark themes**, not just one of each. Theming must cost nothing at runtime: a theme is a small set of design tokens, switching is instant, and no theme loads extra assets.

### Built-in themes (initial set)

| Dark | Character | Light | Character |
|---|---|---|---|
| **Obsidian** (default dark) | neutral near-black, royal blue accent | **Parchment** (default light) | warm paper, ink text, amber accent |
| **Mercury** | cool graphite, silver-blue accent | **Salt** | clean neutral white, blue accent |
| **Cinnabar** | deep red-brown, vermilion accent | **Quartz** | soft rose-grey, violet accent |
| **Verdigris** | dark teal, copper-green accent | **Gold Leaf** | cream, rich gold accent |
| **High Contrast Dark** | accessibility | **High Contrast Light** | accessibility |

### Rules
- **Token based:** every color, radius, shadow and motion duration in the UI comes from named tokens (surface, surface-raised, text, text-muted, accent, accent-text, border, focus, success, warning, danger, timeline track colors, waveform, selection). No hard-coded colors anywhere in the UI.
- **Follow system:** default is "System", which picks the user's chosen dark theme or chosen light theme based on the OS setting and switches live when the OS changes.
- **Accent override:** any theme can take a custom accent color; the app automatically derives hover, pressed and on-accent text colors and keeps them readable.
- **Contrast enforced:** every theme is checked in automated tests for WCAG AA contrast on text and essential UI; a theme that fails does not ship.
- **Semantic colors stay meaningful:** recording red, warning amber and success green stay recognizable in every theme.
- **Custom themes:** users can import/export a theme as a small JSON file. Invalid or unreadable themes fall back safely with a clear message.
- **Consistent everywhere:** the recorder toolbar, editor, converter, dialogs, tray menu and installer screens (where the platform allows) all use the active theme.
- **Motion respects the user:** animations are short and purposeful, and the app honours the OS "reduce motion" setting.

---

## 8. Website (Landing & Download Pages)

The website lives in `site/` in the same repository and is hosted on **Cloudflare Pages**.

### Pages
- **Landing page (`/`):** what Alchemist is, the five jobs (record, edit, convert, compress, enhance), lightness budgets, themes showcase, privacy, auto-update, and a primary download button that already matches the visitor's OS.
- **Download page (`/download/`):** detects OS and CPU architecture, offers the right installer first, plus the portable build, and lists every asset from the latest GitHub Release with size and SHA-256, verification commands per OS, release notes, system requirements and a link to older releases.

### Rules
- **Production grade:** fast (target Lighthouse 95+ on every category), accessible, responsive down to small phones, works with JavaScript disabled (falls back to a link to GitHub Releases), and honours `prefers-reduced-motion`.
- **Typography:** Satoshi for all body and UI text; a display serif for headlines; a monospace for numbers, file names and checksums.
- **Motion:** fluid, purposeful motion (WebGL hero, scroll-driven reveals, smooth page transitions), but it must never block content or hurt performance: animations pause off-screen and when the tab is hidden.
- **Live release data:** the download page reads the latest release through a small Cloudflare Pages Function (`/api/latest`) that calls GitHub server-side, caches the result at the edge for a few minutes, and normalizes it (version, date, notes, assets with OS/arch/kind/size/SHA-256). If the function is unavailable, the page falls back to the GitHub API directly, then to a plain link to the Releases page. The function never needs a token for public repos but can use one from a Pages secret to raise rate limits.
- **Honest numbers:** performance figures on the site are labelled as budgets until real measured numbers are published from CI; once they exist, the site shows the measured values per release.
- **Deploy:** a website-only change deploys the site (preview deployment for pull requests, production on main) and never triggers app builds.
- **Security headers:** strict Content-Security-Policy, HSTS, no third-party trackers, no cookies.

---

## 9. Licensing & Legal (decide early)

- Choose the app's own license before the first public release.
- Codec and library licensing affects distribution: for example, building the media engine on FFmpeg in LGPL configuration vs GPL configuration changes what the app may be licensed as, and patent-encumbered encoders (H.264, HEVC) should prefer the operating system's hardware encoders where possible. Document the decision and include all third-party notices in the app's About screen and in every package.
- Fonts and icons used in the app and the website must have licenses that allow redistribution/embedding.

---

## 10. Cross-Cutting Requirements (Apply to Every Phase)

- **Lazy everything:** modules, models and effects load only when used and release memory when done.
- **No regressions on lightness:** every release reports memory, startup time and installer size compared with the previous release.
- **Privacy by default:** no telemetry without explicit consent, no required sign-in, and offline operation for all core features.
- **Determinism:** same project plus same settings gives the same output.
- **Resilience:** odd formats, variable frame rate footage, missing media and low disk space are handled gracefully with clear messages.
- **Consistency:** one design language, one set of shortcuts and one terminology across recorder, editor and converter.

---

## 11. Non-Goals

- Not a cloud service and not a social or hosting platform.
- Not a collection of loosely related tools. Everything shares the same core and design.
- No feature ships if it makes the recorder heavy.
- No hundreds of low-quality effects or transitions. A small, excellent set is better.

---

## 12. Definition of Done for the Whole Product

Alchemist is done when a new user can install it quickly (or just unzip it), record their screen with almost no resource impact, turn the recording into a polished video, and export a small, high-quality file, all within one fast, private and beautifully consistent app in the theme they like, and every claim on the website is backed by a number they can verify. It must install or run portably on Windows, macOS and Linux, keep itself up to date safely from GitHub Releases, and ship every new version automatically through a pipeline that never wastes a rebuild.
