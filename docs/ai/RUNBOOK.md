# RUNBOOK

## Commands

```sh
git fetch --all --prune
git switch main
git merge --ff-only origin/main
git push fork main
pnpm install
pnpm ui:build
pnpm build
openclaw gateway status --deep
openclaw gateway restart
```

## Troubleshooting

1. If `pnpm build` fails in `scripts/bundle-a2ui.sh`, check whether `bash` can resolve `node` in the current Windows environment.
2. If `runtime-postbuild` fails with `EPERM` on symlinks, prefer WSL2 or a Windows environment with symlink/junction support.
3. If `openclaw gateway restart` times out, immediately follow with `openclaw gateway status --deep`; the gateway may still be healthy.
4. Before syncing upstream, stash or commit local feature work so `main` stays clean.
5. Rebase `feature/*` branches onto `main` after each upstream sync to reduce merge conflicts.
