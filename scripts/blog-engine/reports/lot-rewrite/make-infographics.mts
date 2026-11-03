// RETIRED (chart redraw, Nov 2026). This script drew the October 2026 rate charts: lots from hand-made factsheets
// labelled "bookable on Triply" (several we don't sell), at pre-fee rates, with no date. Price charts now come only
// from src/rate-chart.ts, priced from a live triplypro.com search and dated — see reports/chart-redraw/ and
// notes/2026-11-02-chart-redraw-plan.md. publish.mts refuses any PNG this script made. The on-airport rates it held
// moved to ON_AIRPORT_RATES in src/rate-chart.ts.
console.error('make-infographics.mts is retired: draw price charts with reports/chart-redraw/ (src/rate-chart.ts).')
process.exit(1)
