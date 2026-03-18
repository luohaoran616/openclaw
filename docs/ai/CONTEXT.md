# CONTEXT

## Project

OpenClaw is a local-first personal AI assistant and gateway with:

- a Node/TypeScript core runtime
- a large plugin/channel surface under `extensions/`
- a web control UI under `ui/`
- source and built runtime outputs under `src/`, `dist/`, and `dist-runtime/`

## Relevant architecture

- `openclaw.mjs`
  - CLI entrypoint
- `package.json`
  - authoritative build and test scripts
- `scripts/tsdown-build.mjs`
  - main runtime build step
- `scripts/runtime-postbuild.mjs`
  - post-build runtime staging
- `scripts/stage-bundled-plugin-runtime.mjs`
  - creates runtime overlays for bundled plugins
- `ui/`
  - control UI sources
- `dist/`
  - built runtime used by the installed source checkout

## Sync strategy context

- `main` is the local stable branch and should track `fork/main`.
- `origin/main` is the official upstream baseline and should stay read-only.
- local work belongs on `feature/*` branches and should be rebased onto `main`.

## Windows-specific notes

- Official source-development docs recommend WSL2 on Windows for the smoothest setup.
- In this local native-Windows checkout, `pnpm build` currently hits shell/path friction in `bash`-driven steps.
- Post-build runtime staging also depends on symlink/junction creation that may fail without the right Windows permissions or Developer Mode setup.
