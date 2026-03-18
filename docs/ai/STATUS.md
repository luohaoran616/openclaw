# STATUS

Current goal: Keep the local OpenClaw source checkout aligned with official `openclaw/openclaw` while preserving local UI slash-command work on an isolated feature branch.

## What's done

- Established the fork/upstream remote model:
  - `origin` = `https://github.com/openclaw/openclaw.git`
  - `fork` = `https://github.com/luohaoran616/openclaw.git`
- Preserved local uncommitted work by moving it onto `feature/ui-slash-commands-wip`.
- Confirmed local `main` is now the stable branch tracking `fork/main`.
- Fetched both remotes and compared official upstream with the fork.
- Verified the fork had no unique commits ahead of upstream at sync time.
- Fast-forwarded local `main` to the latest official `origin/main`.
- Pushed the updated `main` back to `fork/main`.
- Verified the synced main commit is `f2655e1e92`.
- Confirmed the local CLI now reports `OpenClaw 2026.3.14 (f2655e1)`.
- Rebased `feature/ui-slash-commands-wip` onto the latest `main`.
- Restored the local slash-command working changes on the rebased feature branch:
  - `ui/src/ui/chat/slash-command-executor.node.test.ts`
  - `ui/src/ui/chat/slash-command-executor.ts`
  - `ui/src/ui/chat/slash-commands.node.test.ts`
  - `ui/src/ui/chat/slash-commands.ts`
- Verified the gateway still responds after restart attempts:
  - `openclaw gateway status --deep` shows `RPC probe: ok`
  - gateway listens on `0.0.0.0:18789`

## Open problems / risks

- Native Windows source builds are still rough in this checkout:
  - `pnpm build` failed in `scripts/bundle-a2ui.sh` because `bash` could not resolve `node`
  - a manual runtime build path then failed in `scripts/runtime-postbuild.mjs` on Windows symlink/junction permissions (`EPERM`)
- `openclaw gateway restart` still often reports a timeout even when the gateway is actually alive afterward.
- The current feature branch changes are intentionally uncommitted and may conflict with future upstream UI work.

## Next actions

1. Keep daily development on `feature/*` branches and keep `main` clean.
2. Before each upstream sync: stash or commit local work, then sync `main` from `origin/main`, then push to `fork/main`.
3. If a full native Windows source build is required, prefer a WSL2-based build path or adjust the build scripts for Windows symlink limitations.
4. When the slash-command work is ready, commit it on `feature/ui-slash-commands-wip`, validate it, then merge it into `main`.
5. If restart reliability matters, investigate why the scheduled-task health check times out despite a healthy RPC probe.

## Key files

- `package.json`
- `scripts/bundle-a2ui.sh`
- `scripts/runtime-postbuild.mjs`
- `scripts/stage-bundled-plugin-runtime.mjs`
- `ui/src/ui/chat/slash-command-executor.ts`
- `ui/src/ui/chat/slash-commands.ts`
- `docs/ai/UPSTREAM.md`
