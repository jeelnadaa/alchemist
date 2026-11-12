# Third-party notices

Alchemist includes or uses the following software and fonts. Thank you to their authors.

## FFmpeg
Alchemist ships an unmodified FFmpeg 6.1.1 build (from the `ffmpeg-static` project, release `b6.1.1`) as a **separate program** that it runs for capture, conversion and export. This build is licensed under the **GNU GPL v3** because it includes GPL components such as x264. Source code: https://ffmpeg.org/download.html and https://github.com/eugeneware/ffmpeg-static. The exact licence text of the bundled build is written to `FFMPEG_LICENSE.txt` next to the binary when it is downloaded.

## Tauri
MIT or Apache-2.0. https://tauri.app

## Rust crates
Including serde, regex, parking_lot, uuid, dirs, cpal, hound, rdev, semver, once_cell, thiserror, windows-sys and libc. Each is MIT and/or Apache-2.0 licensed; see `cargo about`/crates.io for the full list.

## Fonts
- **Satoshi** by Indian Type Foundry, distributed by Fontshare under the ITF Free Font License (free for personal and commercial use, including embedding in apps and websites). https://www.fontshare.com/fonts/satoshi
- **Inter** by Rasmus Andersson, SIL Open Font License 1.1. Used for text burned into exported videos. https://rsms.me/inter
- **JetBrains Mono** by JetBrains, SIL Open Font License 1.1. https://www.jetbrains.com/lp/mono

## Website libraries
- GSAP and ScrollTrigger (GreenSock standard "no charge" license) and Lenis (MIT), vendored in `site/assets/vendor`.
