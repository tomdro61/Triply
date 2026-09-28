/**
 * GET /api/cron/refresh-reslab-locations — the ONLY writer of the shared
 * ResLab location-list snapshot (plan v3 §5). Vercel cron, `0 *\/4 * * *`,
 * Production only.
 *
 * - Auth: `Authorization: Bearer <CRON_SECRET>`, like the other crons.
 * - Calls `sweepChannelLocations()` DIRECTLY: no cache consult (a warm lambda
 *   must never read its own snapshot back and re-write it), no NEXT_PHASE.
 * - Writes only a sweep with zero refused/skipped pages that passed the
 *   plausibility check; `built_at` is the sweep's own start instant.
 * - Skips the sweep entirely (zero ResLab calls) when the current row is
 *   younger than SKIP_IF_YOUNGER_THAN_MS — a manual re-trigger right after a
 *   scheduled run must not double the day's list calls.
 * - A rejected / refused / shrunk / errored run answers NON-2xx so Vercel's
 *   cron alerting sees it, plus one Sentry event: a monitor's failure must
 *   never look like its healthy state.
 * - No retry inside an invocation (40 s + 40 s > maxDuration); the 4-hourly
 *   schedule is the retry.
 */

import { NextRequest, NextResponse } from "next/server";
import { sweepChannelLocations } from "@/lib/reslab/search";
import { readSnapshotMeta, writeSnapshot } from "@/lib/reslab/location-snapshot";
import { captureAPIError } from "@/lib/sentry";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const CTX = { endpoint: "/api/cron/refresh-reslab-locations", method: "GET" as const };
const SKIP_IF_YOUNGER_THAN_MS = 2 * 60 * 60 * 1000;

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const allowShrink = request.nextUrl.searchParams.get("allowShrink") === "1";
  const force = request.nextUrl.searchParams.get("force") === "1";
  const started = Date.now();

  const current = await readSnapshotMeta();
  if (current.kind === "error") {
    // Cannot read the current row ⇒ cannot verify the anti-shrink baseline. A
    // transient Supabase blip must NOT silently switch that guard off and let
    // a shrunken list reach every cold instance for a day. Refuse the run
    // (the 4-hourly schedule retries); an operator can override explicitly.
    captureAPIError(new Error(`snapshot meta read failed: ${current.message}`), { ...CTX, stage: "meta", statusCode: 503 });
    if (!(force && allowShrink)) {
      return NextResponse.json(
        {
          ok: false,
          outcome: "meta_unreadable",
          error: current.message,
          hint: "cannot verify the anti-shrink baseline; pass ?force=1&allowShrink=1 to write anyway",
        },
        { status: 503 }
      );
    }
  }
  const currentCount = current.kind === "row" ? current.locationCount : null;
  if (!force && current.kind === "row" && started - current.builtAtMs < SKIP_IF_YOUNGER_THAN_MS) {
    return NextResponse.json({
      ok: true,
      outcome: "skipped_fresh",
      snapshotAgeMinutes: Math.round((started - current.builtAtMs) / 60_000),
      reslabCalls: 0,
    });
  }

  let sweep;
  try {
    sweep = await sweepChannelLocations(currentCount);
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    captureAPIError(new Error(`ResLab snapshot refresh: sweep threw: ${err.message}`), { ...CTX, stage: "sweep", statusCode: 502 });
    return NextResponse.json({ ok: false, outcome: "sweep_threw", error: err.message }, { status: 502 });
  }

  const failedPages = sweep.refusedPages + sweep.skippedPages;
  const summary = {
    // true only on a ?force=1&allowShrink=1 override: both anti-shrink guards were off.
    baselineUnverified: current.kind === "error",
    // echoed so a deliberately bypassed guard is visible in the run's own JSON
    allowShrink,
    force,
    lastPage: sweep.lastPage,
    paginatorTotal: sweep.paginatorTotal,
    rowsFetched: sweep.rowsFetched,
    unique: sweep.unique.length,
    refusedPages: sweep.refusedPages,
    skippedPages: sweep.skippedPages,
    implausible: sweep.implausible,
    sweepMs: Date.now() - sweep.sweepStartedAt,
  };
  if (failedPages > 0 || sweep.implausible) {
    captureAPIError(
      new Error(
        `ResLab snapshot refresh rejected: ${sweep.refusedPages} refused + ${sweep.skippedPages} skipped of ${sweep.lastPage} pages, ` +
          `assembled ${sweep.unique.length} unique from ${sweep.rowsFetched} rows (paginator total ${sweep.paginatorTotal})`
      ),
      { ...CTX, stage: "sweep", statusCode: 502 }
    );
    return NextResponse.json({ ok: false, outcome: "rejected", ...summary }, { status: 502 });
  }

  const written = await writeSnapshot(
    {
      locations: sweep.unique,
      rowsFetched: sweep.rowsFetched,
      paginatorTotal: sweep.paginatorTotal,
      builtAtMs: sweep.sweepStartedAt,
    },
    { currentLocationCount: currentCount, allowShrink }
  );

  switch (written.kind) {
    case "written":
      return NextResponse.json({ ok: true, outcome: "written", wireBytes: written.wireBytes, ...summary });
    case "noop_newer_exists":
      // Not a failure (another run beat us), but not "written" either.
      return NextResponse.json({ ok: true, outcome: "noop_newer_exists", wireBytes: written.wireBytes, ...summary });
    case "refused":
      captureAPIError(new Error(`ResLab snapshot refresh refused to write: ${written.reason}`), { ...CTX, stage: "write", statusCode: 409 });
      return NextResponse.json({ ok: false, outcome: "refused", reason: written.reason, ...summary }, { status: 409 });
    case "error":
      captureAPIError(new Error(`ResLab snapshot write failed: ${written.message}`), { ...CTX, stage: "write", statusCode: 500 });
      return NextResponse.json({ ok: false, outcome: "write_error", error: written.message, ...summary }, { status: 500 });
  }
}
