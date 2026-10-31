# Weekly Maintenance — scheduling

`run-weekly-maintenance.ps1` runs the full closed loop (validate → learn → treat). It's
idempotent and cadence/cooldown-aware, so a weekly trigger just picks up whatever is due.

## What it runs (in order)
1. `perf measure --all` — validate + auto-revert last cycle's Google edits
2. `maintain geo measure` — record AI-citation delta for GEO edits past window
3. `maintain geo capture -n 30` — refresh AI-Overview citation for ranking pages
4. `maintain learn` — aggregate ROI (Google + citation) → rewrite `treatment-policy.json`
5. `maintain run --apply --refresh --limit 15` — treat DUE items (Tier-1 rewrites stay gated)

Output → `reports/maintenance-logs/weekly_<timestamp>.log`.

## Prerequisites (one-time)
- A first live `maintain plan --refresh` on each cluster so snapshots/records exist.
- `.env` present with `SERPAPI_API_KEY`, `ANTHROPIC_API_KEY`, `PAYLOAD_*` — the scheduled task runs headless, so nothing interactive.
- Confirm Anthropic + SerpAPI have credit (a stalled batch wastes the window).

## Register the scheduled task (Windows)

Run this **once** in an elevated PowerShell (adjust `-At`/`-DaysOfWeek` to taste — Monday 03:00 shown):

```powershell
$engine = "C:\Users\vince\Downloads\Triply Master Vin\Triplyvin-main\scripts\blog-engine"
$action  = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$engine\run-weekly-maintenance.ps1`"" `
  -WorkingDirectory $engine
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At 3:00AM
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun `
  -ExecutionTimeLimit (New-TimeSpan -Hours 4)
Register-ScheduledTask -TaskName "TriplyBlogWeeklyMaintenance" `
  -Action $action -Trigger $trigger -Settings $settings -Description "Triply blog maintenance loop"
```

- `-StartWhenAvailable` runs a missed job if the PC was off at 03:00.
- `-ExecutionTimeLimit 4h` is a safety kill (a big cluster + rewrites can be slow).
- Runs as the logged-in user by default (keeps access to `.env` + the local `gsc-token.json`). Add `-User` / `-Password` only if you need it to run when logged out.

## Operate it
- **Run now (test):** `Start-ScheduledTask -TaskName "TriplyBlogWeeklyMaintenance"`
- **Or run the script directly:** `powershell -File run-weekly-maintenance.ps1 -Airport MSP -Limit 10`
- **Check status:** `Get-ScheduledTask -TaskName "TriplyBlogWeeklyMaintenance" | Get-ScheduledTaskInfo`
- **Disable / remove:** `Disable-ScheduledTask …` / `Unregister-ScheduledTask -TaskName "TriplyBlogWeeklyMaintenance"`
- **Read the last log:** newest file in `reports/maintenance-logs/`.

## Tuning
- Scope to one cluster while proving it out: pass `-Airport MSP`.
- `-Limit` caps treatments/week; `-GeoLimit` caps SerpAPI citation captures/week (cost control).
- Tier-1 rewrites are deliberately excluded (no `--rewrites`) — review the "NEEDS APPROVAL" list from a manual `maintain run` and run those by hand.
