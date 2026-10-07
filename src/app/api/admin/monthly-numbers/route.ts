/**
 * GET /api/admin/monthly-numbers
 *
 * Everything on /admin/numbers EXCEPT net take, which the page reads month by
 * month from /api/admin/accounting (the reconciler) so there is one money
 * calculation in the codebase, not two.
 *
 *   - bookings per month + repeat rate, last 6 UTC months (full history read,
 *     because "repeat" needs every earlier booking)
 *   - ResLab channel lots per airport (the warm location list, search's radius)
 *   - origin searches per day, last 14 UTC days (search_events, migration 027)
 *
 * Each section fails on its own: a failure returns that section as null plus
 * a warning, never an empty list that reads like "zero".
 *
 * Rules this route carries (PR #45 review):
 *   - staging shares the production database, so rows with
 *     bookings.livemode = false (Stripe TEST mode, migration 034) are excluded
 *     and counted separately; NULL is a pre-015 row, which is live;
 *   - every database call is bounded — a hung PostgREST call must degrade one
 *     section, not run the function into its timeout;
 *   - this page NEVER triggers a ResLab call: the lot counts come from
 *     getChannelLocationsNoSweep (snapshot / warm list, else null).
 */
import { NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { isAdminEmail, isAtTestLot } from "@/config/admin";
import { productionAirports } from "@/config/airports";
import { captureAPIError } from "@/lib/sentry";
import { resolveEnv } from "@/lib/env";
import { BLOCKED_RESLAB_LOCATION_IDS, getChannelLocationsNoSweep } from "@/lib/reslab/search";
import {
  bookingsByMonth,
  lastNDays,
  lastNMonths,
  type NumbersBookingRow,
} from "@/lib/admin/monthly-numbers";
import { lotsPerAirport } from "@/lib/admin/airport-lots";

// No ResLab sweep can start from here (getChannelLocationsNoSweep), so the
// ceiling only has to cover the bounded database reads below.
export const maxDuration = 30;

const MONTHS_SHOWN = 6;
const DAYS_SHOWN = 14;
const PAGE = 1000;
/** Per database call. The whole route must settle well inside maxDuration. */
const DB_TIMEOUT_MS = 8_000;
const sig = () => AbortSignal.timeout(DB_TIMEOUT_MS);

type CustomerJoin = { email: string | null } | null;
interface BookingRow {
  created_at: string;
  status: string;
  reslab_location_id: number | null;
  livemode: boolean | null;
  customers: CustomerJoin | CustomerJoin[];
}

export async function GET() {
  const authClient = await createClient();
  const {
    data: { user },
  } = await authClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAdminEmail(user.email)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const now = new Date();
  const months = lastNMonths(now, MONTHS_SHOWN);
  const days = lastNDays(now, DAYS_SHOWN);
  const warnings: string[] = [];
  const warn = (what: string, err: unknown) => {
    warnings.push(what);
    const e = err instanceof Error ? err : new Error(String(err));
    captureAPIError(new Error(`Admin monthly numbers: ${what}: ${e.message}`), {
      endpoint: "/api/admin/monthly-numbers",
      method: "GET",
    });
  };

  try {
    const supabase = await createAdminClient();

    const bookingsTask = (async () => {
      // PostgREST caps a select at 1000 rows — page until a short page; `id`
      // breaks created_at ties so pages don't overlap or skip.
      const rows: NumbersBookingRow[] = [];
      let stagingExcluded = 0;
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase
          .from("bookings")
          .select("created_at, status, reslab_location_id, livemode, customers ( email )")
          .order("created_at", { ascending: true })
          .order("id", { ascending: true })
          .range(from, from + PAGE - 1)
          .abortSignal(sig())
          .returns<BookingRow[]>();
        if (error) throw new Error(error.message);
        const page = data ?? [];
        for (const b of page) {
          // Same test-lot rule as the reconciler and /api/admin/stats.
          if (isAtTestLot(b.reslab_location_id)) continue;
          // Staging soaks book real lots into this shared table under Stripe
          // TEST mode. livemode=false is staging; NULL is a pre-015 row (live).
          if (b.livemode === false) {
            stagingExcluded++;
            continue;
          }
          const c = Array.isArray(b.customers) ? (b.customers[0] ?? null) : b.customers;
          rows.push({ created_at: b.created_at, status: b.status, email: c?.email ?? null });
        }
        if (page.length < PAGE) break;
      }
      return { months: bookingsByMonth(rows, months), stagingExcluded };
    })().catch((e: unknown) => {
      warn("bookings fetch failed", e);
      return null;
    });

    const lotsTask = (async () => {
      // Snapshot or warm in-memory list only — NEVER a sweep from an admin
      // page (the 500/day ResLab budget). null = not warm right now.
      const list = await getChannelLocationsNoSweep();
      if (!list) return null;
      return {
        rows: lotsPerAirport(list, productionAirports, BLOCKED_RESLAB_LOCATION_IDS),
        totalLocations: list.length,
      };
    })().catch((e: unknown) => {
      warn("ResLab location list unavailable", e);
      return null;
    });

    const env = resolveEnv();
    const searchesTask = (async () => {
      // One head-only count per day on the created_at index — no rows cross
      // the wire (egress is this project's most expensive recurring incident).
      const counts = await Promise.all(
        days.map(async (day) => {
          const next = new Date(`${day}T00:00:00Z`);
          next.setUTCDate(next.getUTCDate() + 1);
          const { count, error } = await supabase
            .from("search_events")
            .select("id", { count: "exact", head: true })
            .eq("env", env)
            .eq("source", "search")
            .gte("created_at", `${day}T00:00:00Z`)
            .lt("created_at", next.toISOString())
            .abortSignal(sig());
          if (error) throw new Error(error.message);
          return { day, count: count ?? 0 };
        })
      );
      return { env, days: counts };
    })().catch((e: unknown) => {
      warn("search_events count failed", e);
      return null;
    });

    const [bookingsResult, lots, searches] = await Promise.all([bookingsTask, lotsTask, searchesTask]);
    return NextResponse.json({
      months,
      bookings: bookingsResult?.months ?? null,
      stagingExcluded: bookingsResult?.stagingExcluded ?? null,
      lots,
      searches,
      warnings,
    });
  } catch (err) {
    captureAPIError(err instanceof Error ? err : new Error(String(err)), {
      endpoint: "/api/admin/monthly-numbers",
      method: "GET",
    });
    return NextResponse.json({ error: "Monthly numbers failed — see Sentry" }, { status: 500 });
  }
}
