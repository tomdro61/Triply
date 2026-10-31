# Daily test + live dashboard — watch the improvement engine

Two tools to *see* the improvement engine working, faster than the weekly cycle:

- **`npm run dashboard`** — a local, read-only view of everything the engine has done.
- **`run-daily-test.ps1`** — a safe daily run that refreshes the data (applies nothing).

## The dashboard

```
npm run dashboard        # → http://localhost:4319   (Ctrl+C to stop)
```

Reads the engine's own files (`reports/articles/*.json`, `treatment-roi.json`,
`maintenance-plan.json`, newest `clarity-report-*.json`) — no database, no build step,
no dependencies. Auto-refreshes every 60s. Shows:

- **KPIs** — articles tracked, avg Google position, total impressions, changes applied vs
  measured vs auto-reverted, how many are due now, AI-Overview citation rate.
- **Position buckets & tiers** — where articles sit (top-3 / page-1 / striking-distance) and
  their maintenance tier (fills in once `maintain plan` runs).
- **Treatment verdicts & ROI** — which fix types actually help (win-rate), once verdicts land.
- **GEO** — AI-Overview citation gained/lost/held.
- **Clarity** — the top user-friction pages (dead/rage clicks) from the latest report.
- **Article table** — sortable; each row has a position-trend sparkline that grows a point
  every time the daily test runs.

Change the port with `DASHBOARD_PORT=4320 npm run dashboard`.

## The daily safe test

```
powershell -File run-daily-test.ps1 -Airport SAN          # one small cluster
powershell -File run-daily-test.ps1 -Airport SAN -WithGeo # also refresh AI-citation (SerpAPI cost)
```

It **applies nothing**. It runs `perf measure --all` → `maintain plan --refresh` (fresh GSC
snapshots + tiers) → `maintain run` **dry-run** (previews what it *would* fix) → `maintain learn`.
Output → `reports/maintenance-logs/daily_<timestamp>.log`. Each run appends a fresh snapshot to
every article record, so the dashboard's positions/trends move day to day.

### Why not just run the real weekly loop daily?
Whether an edit *helped* needs ~28 days of Search Console data, and after an edit an article is
frozen in a 28-day cooldown — so a daily *apply* run would mostly find "nothing due." The daily
test therefore watches the **machinery + daily-moving positions**, not final verdicts. The real
edits stay on the weekly `run-weekly-maintenance.ps1`.

## Register the daily task (Windows, run once in an elevated PowerShell)

```powershell
$engine = "C:\Users\vince\Downloads\Triply Master Vin\Triplyvin-main\scripts\blog-engine"
$action  = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$engine\run-daily-test.ps1`" -Airport SAN" `
  -WorkingDirectory $engine
$trigger = New-ScheduledTaskTrigger -Daily -At 6:00AM
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Hours 1)
Register-ScheduledTask -TaskName "TriplyBlogDailyTest" `
  -Action $action -Trigger $trigger -Settings $settings `
  -Description "Triply blog improvement engine — daily safe test (no edits)"
```

- **Run now (test):** `Start-ScheduledTask -TaskName "TriplyBlogDailyTest"`
- **Check status:** `Get-ScheduledTask -TaskName "TriplyBlogDailyTest" | Get-ScheduledTaskInfo`
- **Remove:** `Unregister-ScheduledTask -TaskName "TriplyBlogDailyTest"`

## Prerequisites
- `.env` present; `gsc-token.json` present (run `npm run gsc:auth` once if not). Both already exist here.
- The dashboard needs no keys — it only reads local files.
