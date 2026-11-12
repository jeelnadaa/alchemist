# Alchemist — single entry point for building, locally and in CI.
# Run `make help` for every target. CI calls these same targets.

SHELL := bash
.DEFAULT_GOAL := build

APP      := app
TAURI    := $(APP)/src-tauri
NPM      ?= npm
CARGO    ?= cargo
TARGET   ?= $(shell rustc -vV 2>/dev/null | sed -n 's/^host: //p')
VERSION  := $(shell node -p "require('./$(APP)/package.json').version" 2>/dev/null)

define need
	@command -v $(1) >/dev/null 2>&1 || { echo "Missing '$(1)'. $(2)"; exit 1; }
endef

.PHONY: help check-tools deps build run dev test test-unit test-media test-ui test-scripts lint package package-nsis package-portable package-dmg package-appimage package-deb package-rpm version clean distclean budgets site

help: ## List every target
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | sed -E 's/:.*## /\t/' | expand -t 22

check-tools:
	$(call need,node,Install Node.js 20 or newer from https://nodejs.org)
	$(call need,$(NPM),Install npm (comes with Node.js))
	$(call need,$(CARGO),Install Rust from https://rustup.rs)

deps: check-tools ## Install pinned dependencies and the pinned FFmpeg sidecar
	cd $(APP) && $(NPM) ci --no-fund --no-audit
	node scripts/fetch-ffmpeg.mjs $(TARGET)
	cd $(TAURI) && $(CARGO) fetch --locked || $(CARGO) fetch

$(APP)/node_modules: $(APP)/package-lock.json
	$(MAKE) deps

build: $(APP)/node_modules ## Build the app for this computer (debug, fast)
	cd $(APP) && $(NPM) run build
	cd $(TAURI) && $(CARGO) build

run: $(APP)/node_modules ## Build if needed and launch with live reload
	cd $(APP) && npx tauri dev

dev: run ## Same as run

test: test-unit test-ui test-scripts test-media ## All tests: Rust, UI logic, release scripts and real FFmpeg pipelines

test-scripts: ## Release tooling tests (asset naming contract, update manifest)
	node --test scripts/release.test.mjs

test-unit: ## Rust unit tests (limits, maths, arguments, project format…)
	cd $(TAURI) && $(CARGO) test --lib

test-media: ## End-to-end media tests against the real FFmpeg sidecar
	cd $(TAURI) && $(CARGO) test --test media -- --nocapture

test-ui: $(APP)/node_modules ## UI logic tests (timeline, themes/contrast, search, shortcuts)
	cd $(APP) && npx vitest run

lint: $(APP)/node_modules ## Formatting and static checks
	cd $(APP) && npx tsc --noEmit
	cd $(TAURI) && $(CARGO) fmt --check && $(CARGO) clippy --all-targets -- -D warnings

package: $(APP)/node_modules ## All packages for this OS, renamed to the naming contract in release-assets/
	cd $(APP) && npx tauri build --target $(TARGET)
	node scripts/collect-release.mjs $(TARGET)

package-nsis: ## Windows installer only
	cd $(APP) && npx tauri build --target $(TARGET) --bundles nsis
package-portable: ## Portable build (zip / tar.gz) only
	cd $(APP) && npx tauri build --target $(TARGET) --no-bundle
	node scripts/collect-release.mjs $(TARGET)
package-dmg: ## macOS disk image only
	cd $(APP) && npx tauri build --target $(TARGET) --bundles dmg
package-appimage: ## Linux AppImage only
	cd $(APP) && npx tauri build --target $(TARGET) --bundles appimage
package-deb: ## Debian/Ubuntu package only
	cd $(APP) && npx tauri build --target $(TARGET) --bundles deb
package-rpm: ## Fedora/RHEL package only
	cd $(APP) && npx tauri build --target $(TARGET) --bundles rpm

budgets: ## Measure startup, idle and size budgets of the release build
	node scripts/measure-budgets.mjs $(TARGET)

version: ## Print the current version (single source of truth: app/package.json)
	@echo $(VERSION)

site: ## Serve the website locally on :8787
	cd site && python -m http.server 8787

clean: ## Remove build output
	rm -rf $(APP)/dist release-assets
	cd $(TAURI) && $(CARGO) clean

distclean: clean ## Also remove caches, dependencies and the FFmpeg download
	rm -rf $(APP)/node_modules $(TAURI)/binaries $(TAURI)/gen
