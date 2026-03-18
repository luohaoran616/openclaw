# UPSTREAM

## Source

- Project: `openclaw/openclaw`
- URL: `https://github.com/openclaw/openclaw.git`
- Local work style: upstream-compatible fork maintenance

## Merge strategy

- Method: fast-forward or rebase from official `origin/main`
- Frequency: on demand before resuming feature work
- Conflict preference: preserve upstream structure first, then re-apply local feature changes on isolated branches

## Branch model

- `origin/main` = official upstream baseline
- `fork/main` = personal stable branch
- `feature/*` = isolated local work branches

## Tracking setup

- Local `main` tracks `fork/main`
- Upstream `origin/main` is fetch-only reference for sync
- Local feature branches rebase onto `main`

## Boundaries

### We modify

- local feature work under `ui/` and other isolated areas as needed
- fork-specific experiments on `feature/*`
- repo-local workflow docs under `docs/ai/`

### We try not to modify

- broad upstream architecture without a clear local need
- unrelated channel/plugin subsystems while doing focused UI work

## Sync checklist

1. `git fetch --all --prune`
2. `git switch main`
3. ensure local work is committed or stashed
4. `git merge --ff-only origin/main`
5. `git push fork main`
6. `git switch feature/<name>`
7. `git rebase main`
