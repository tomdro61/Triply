# Chart redraw — blog rate charts from a live search, dated

The October 2026 blog charts called lots Triply does not sell "bookable on Triply", at old prices, with no date.
These scripts redraw them from one live triplypro.com search per airport, print "Prices as of <date>" on every
chart, and swap them into live posts. Plan: `notes/2026-11-02-chart-redraw-plan.md` (wrapper repo).

Run from `scripts/blog-engine/`. Everything under `out/` is local and gitignored (searches, charts, backups, logs).

## The monthly refresh

| Step | Command | Writes |
|---|---|---|
| 1. Prices | `npx tsx reports/chart-redraw/prices.mts` | `data/chart-prices.json` (tracked — commit it; the engine uses it for new posts) |
| 2. Inventory | run `inventory.sql` read-only against the CMS database → `out/inventory-raw.json` | nothing |
| 3. Sort | `npx tsx reports/chart-redraw/classify.mts` | `out/inventory.json` |
| 4. Draw + decide | `npx tsx reports/chart-redraw/render.mts` | `out/charts/`, `out/plan.json` |
| 5. Review page | `npx tsx reports/chart-redraw/contact-sheet.mts` → publish `out/contact/` | nothing in the CMS |
| 6. Swap | `npx tsx reports/chart-redraw/publish.mts <AIRPORTS…>` (dry run) → `--apply` after Tom's OK | live posts |

- **Step 1** searches each airport once, 7 × 24 h on a holiday-free Thursday 8+ days out. A search that is degraded,
  stale, partial, from another airport or for other dates gives that airport no chart this run. `--from-saved`
  rebuilds the file from the saved searches and keeps their date. Canadian airports are held (`CURRENCY_HOLD` in
  `prices.mts`): checkout charges ResLab's CAD total as USD — lift it once that is settled.
- **Step 2** needs read access to the CMS database (the REST API can't search inside post content). It returns ids
  and the posts' plain text, ~30 MB, once.
- **Step 4** swaps only like-for-like standard charts (the October `<code>-parking-rates-*` images and earlier
  `<code>-rate-chart-*` ones). Engine one-off images, other topics, single-lot posts, neighbour-airport posts and
  Canadian airports are held. The post text is checked only to rank posts for the prose pass (every post in scope
  quotes lot prices somewhere).
- **Step 6** uploads one image per airport and kind (`out/uploaded-<asOf>.json`), backs every post up to
  `out/backups/<asOf>/`, writes only the chart nodes with a conditional PATCH, re-reads and checks each post, and
  stops on any failed check. `--verify <log>` re-reads; `--rollback <log> --apply` restores posts nobody edited
  since. Corrections never move `contentUpdatedAt`.

Old media are kept 30 days after a swap (a rollback points back at them).
