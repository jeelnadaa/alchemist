# Building Alchemist

One command builds the app on any OS: `make`. CI runs the same targets, so local and CI builds never differ. `make help` lists everything.

## Prerequisites

| | Windows 10/11 | macOS 12+ | Linux (Debian/Ubuntu) |
|---|---|---|---|
| Node.js 20+ | nodejs.org | `brew install node` | nodejs.org or your package manager |
| Rust (stable) | rustup.rs | rustup.rs | rustup.rs |
| C toolchain | Visual Studio Build Tools with "Desktop development with C++" | `xcode-select --install` | `build-essential` |
| WebView | WebView2 (preinstalled on Windows 11) | built in | `libwebkit2gtk-4.1-dev` |
| make | `choco install make` or `scoop install make` | built in | built in |
| Other | – | – | `libayatana-appindicator3-dev librsvg2-dev patchelf libasound2-dev libxtst-dev libxi-dev libx11-dev libxdo-dev rpm`; for screen recording also `ffmpeg` |

If a tool is missing, `make` says which one and where to get it.

## Everyday commands

```bash
make deps          # pinned npm packages + the pinned FFmpeg sidecar (the only step that downloads)
make run           # start the app with live reload
make test          # every test: Rust units, UI logic, release scripts, real FFmpeg pipelines
make lint          # TypeScript, rustfmt and clippy
make package       # installer + portable package for this OS in release-assets/
make budgets       # measure size, startup and idle memory against scripts/budgets.json
make version       # print the version (app/package.json is the single source of truth)
make clean         # remove build output; distclean also removes dependencies
```

Single package types: `make package-nsis`, `package-portable`, `package-dmg`, `package-appimage`, `package-deb`, `package-rpm`.

Run only the screen-recording test (needs a desktop session):

```bash
cd app/src-tauri && cargo test --test media -- --ignored
```

## UI without the desktop shell

`cd app && npm run dev` serves the UI at http://localhost:1420. Outside the desktop app a built-in mock backend (`app/src/mock.ts`) stands in for the Rust core, so every screen can be clicked through in a normal browser.

## FFmpeg

`scripts/fetch-ffmpeg.mjs` downloads a pinned FFmpeg 6.1.1 build for the target into `app/src-tauri/binaries/`. To build offline, point it at a local binary: `ALCHEMIST_FFMPEG_LOCAL=/path/to/ffmpeg node scripts/fetch-ffmpeg.mjs`. At runtime `ALCHEMIST_FFMPEG` overrides which FFmpeg is used.

## Signing

- **Update signing (required for auto-update).** Generate once with `cd app && npx tauri signer generate -w ../.keys/alchemist-updater.key`. Put the public key in `app/src-tauri/tauri.conf.json` (`plugins.updater.pubkey`) and the private key in the GitHub secret `TAURI_SIGNING_PRIVATE_KEY`. Keep an offline backup: without it, installed apps can't verify future updates.
- **Code signing (optional).** Builds work unsigned. Add `WINDOWS_CERTIFICATE`/`WINDOWS_CERTIFICATE_PASSWORD` or the `APPLE_*` secrets and the release pipeline signs (and notarises on macOS) automatically, with no code changes.

## Releases

Commit with conventional messages (`fix:`, `feat:`, `feat!:`). Pushing to `main` keeps a release pull request up to date; merging it builds every platform, and only if all of them pass publishes the GitHub Release with checksums and the signed update manifest. See `.github/workflows/release.yml`.

## Website

`site/` is the website (landing and download pages). It deploys to Cloudflare Workers with static assets:

- Connected repository (Workers & Pages → your Worker → Settings → Build): root directory `/`, build command empty, deploy command `npx wrangler deploy`. `wrangler.jsonc` at the root points at `site/`. (If the root directory is `site`, `site/wrangler.jsonc` is used instead.)
- From your machine: `npx wrangler login`, then `npx wrangler deploy`.
- Preview locally: `npx wrangler dev`, then open http://localhost:8787.

`site/_worker.js` serves `/api/latest` (the latest GitHub release, cached at the edge) and hands everything else to the static files. `GITHUB_REPO` is set in `wrangler.jsonc`; add a `GITHUB_TOKEN` secret (`npx wrangler secret put GITHUB_TOKEN`) only if you hit GitHub's rate limit. The same `_worker.js` also works on Cloudflare Pages.
