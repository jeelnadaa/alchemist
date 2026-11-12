# Alchemist launch film — plan

**What it is:** a free desktop video studio (Windows, macOS, Linux) that records, edits, converts and shrinks video, all on your own computer.
**For:** people who make screen recordings, tutorials and clips and are tired of juggling four apps and an upload site.
**What sets it apart:** one light app instead of four tools. 23 MB installer, first window in under a second, nothing leaves the computer.
**Most impressive claim:** "Shrink any video to the exact size you need," plus the 23 MB / under-a-second numbers (measured, PROGRESS.md).
**Visual hook:** the site's own headline, *Every video tool. One light app.*, set huge in Satoshi Black, with *light* in Instrument Serif italic royal blue. The two lines snap in on the downbeats.
**Real UI to show:** Record screen → click Record (smooth cursor, click ripple) → editor with silence banner and auto-zoom → Convert to a target size.
**Tone:** `default`, leaning polished. Confident, clean, a little playful. Soft dips through the background, nothing muddy.
**Share caption:** see share-copy.txt.

## Identity (from site/assets/css)

- Background #0b0c0f, surfaces #0f1115 / #14161b, text #eceef2, muted #9aa1ad, accent royal blue #5b8cff (buttons #3d6be6), recording red #f05252.
- Type: Satoshi (body and display, 400–900), Instrument Serif italic for the one accent word, JetBrains Mono for small labels and timecodes.
- Logo: the delta mark (site/assets/img/logo.svg).

## Sound

- 120 BPM, so one beat = 0.5 s. Every cut and type hit lands on the grid, counted from frame 0.
- Key of D minor. Soft sub pulse and a warm pad, a muted pluck motif, light hats from the Reveal on. Cut accents are filtered "whoosh" swells and soft ticks tuned to D, sitting under the music.
- Narration: edge-tts en-US-AndrewNeural, the same voice as the portfolio's earlier launch film. Ducked music (−8 dB) under the voice.
- Subtitles: Satoshi 700, words light up as they're spoken (word timings from the TTS), accent words in royal blue.

## Storyboard (1920×1080, 30 fps; final lengths snap to beats after the narration is measured)

| # | Time | Scene | On screen | Narration |
|---|---|---|---|---|
| 1 | 0.0–3.0 | Hook | Black. "Every video tool." slams in word by word on beats 1–3, "One *light* app." on beat 4. A thin blue line draws under *light*. | "Every video tool. One light app." |
| 2 | 3.0–7.5 | Record | The real Record screen glides up in a floating window. A smooth cursor glides to **Record** and clicks (blue ripple). The recording bar appears and its timer counts up. | "Record your screen, with a cursor that glides." |
| 3 | 7.5–12.0 | Edit | The real editor. The silence banner ("Found 3 silent pauses") is clicked away, the preview auto-zooms into a click, and a caption appears. | "Cut silences, zoom in, add captions." |
| 4 | 12.0–16.5 | Shrink | The real Convert screen, target **25 MB**. A big counter drops 1.24 GB → 24.8 MB, with "50× smaller" in mono. | "Shrink any video to the exact size you need." |
| 5 | 16.5–~23 | Punchline | Three facts tick in on beats (23 MB installer · opens in under a second · stays on your computer), then the logo and **Alchemist**, "Free for Windows, macOS & Linux". | "Twenty-three megabytes. Opens in under a second. Alchemist. Free, for every desktop." |

All UI is the real app (browser build with its demo data: "team-standup" projects, a sample recording). No real user data appears.

## Build

1. Capture the real app (Vite dev server, mock backend) with Playwright at 1920×1080: Record, Record with the recording bar, Editor, Convert.
2. One HTML composition (`work/composition/index.html`) with the site's fonts and tokens. `render(t)` draws every frame as a pure function of time, and the UI captures are animated in it.
3. Voice: edge-tts per line, with word boundaries for subtitles. Music and effects: synthesized in Python on the 120 BPM grid, then mixed with the voice in FFmpeg.
4. Stills from every scene and mid-transition → fix → render frames with Playwright → encode with FFmpeg (H.264, yuv420p, AAC).
5. Poster `brag.jpg` = a settled frame from the punchline, baked in as frame 0.
