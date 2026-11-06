import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { unstable_cache } from "next/cache";
import { z } from "zod";
import { createAdminClient, createClient } from "@/lib/supabase/server";
import { excludeTestBookings, isAdminEmail } from "@/config/admin";
import { captureAPIError } from "@/lib/sentry";
import { calendarDayIn, DIGEST_TZ, shiftIsoDate } from "@/lib/digest/window";
import { gscQuery, GoogleConfigError } from "@/lib/google/client";
import { fetchFromCms } from "@/lib/cms";
import { reconcileRevenue } from "@/lib/accounting/reconcile";
import {
  aggregateBlogBookings,
  blogSlug,
  blogTouchedIds,
  defaultRange,
  LIVE_STATUSES,
  MAX_NET_RANGE_DAYS,
  MAX_RANGE_DAYS,
  netTakeOfDetail,
  rangeBoundsUtc,
  rangeDays,
  type ArticleMeta,
  type BlogBookingRow,
  type BlogBookingsResponse,
  type DateRange,
  type GscPage,
  type NetSummary,
  type Section,
} from "@/lib/admin/blog-bookings";

/**
 * GET /api/admin/blog-bookings?from=YYYY-MM-DD&to=YYYY-MM-DD[&net=1]
 *
 * Which airports and which blog articles produce bookings, from
 * bookings.attribution (first / last touch landing page), Search Console
 * clicks per article and the CMS's airportCode per article. Range = ET days,
 * default the last 90.
 *
 * `net=1` adds net take from the accounting reconciler (reconcileRevenue,
 * ResLab only, no Stripe) for the BLOG-touched bookings only — one ResLab
 * read each, so the page asks for it only on an explicit "Load net take".
 * Ranges past MAX_NET_RANGE_DAYS get a net section error instead. The result
 * is cached 6 h per (range, id set); a result with ResLab fetch errors is not.
 *
 * Search Console and the CMS are independent sections: a failure is
 * { ok: false, error } (and Sentry), never shown as zero clicks.
 */

export const dynamic = "force-dynamic";
// net=1 reads ResLab once per blog booking: ≤ 92 days of blog bookings
// (~400 at today's volume) at concurrency 10 and ~1 s a read is ~40 s.
export const maxDuration = 60;

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && s === d.toISOString().slice(0, 10);
  }, "must be a real calendar date");

const querySchema = z
  .object({ from: isoDate, to: isoDate, net: z.enum(["0", "1"]).optional() })
  .refine((q) => q.from <= q.to, { message: "from must be ≤ to" })
  .refine((q) => rangeDays(q) <= MAX_RANGE_DAYS, { message: `range must be ≤ ${MAX_RANGE_DAYS} days` });

const CACHE_S = 3600;
const NET_CACHE_S = 6 * 3600;
const NET_RESLAB_CONCURRENCY = 10;
const PAGE = 1000; // PostgREST's default max-rows
const MAX_ROWS = 20_000;

async function section<T>(fn: () => Promise<T>): Promise<Section<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (error) {
    if (error instanceof GoogleConfigError) return { ok: false, error: "Google access isn't set up (GOOGLE_ANALYTICS_SA_KEY)" };
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Live, non-test bookings created in the range, paged past PostgREST's row cap. */
async function readBookings(range: DateRange): Promise<BlogBookingRow[]> {
  const supabase = await createAdminClient();
  const { start, end } = rangeBoundsUtc(range);
  const out: BlogBookingRow[] = [];
  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    const { data, error } = await excludeTestBookings(
      supabase
        .from("bookings")
        .select("id, created_at, status, airport_code, attribution")
        .in("status", [...LIVE_STATUSES])
        .gte("created_at", start.toISOString())
        .lt("created_at", end.toISOString())
    )
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1)
      .abortSignal(AbortSignal.timeout(8_000));
    if (error) throw new Error(`bookings read failed: ${error.message}`);
    const rows = (data ?? []) as BlogBookingRow[];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
  throw new Error(`bookings read hit its ${MAX_ROWS}-row cap`);
}

/** The last day Search Console has data for (it lags 2–3 days). */
async function gscLastDay(today: string): Promise<string> {
  const rows = await gscQuery({ startDate: shiftIsoDate(today, -10), endDate: today, dimensions: ["date"] });
  const days = rows.map((r) => r.keys[0]).filter((d): d is string => typeof d === "string").sort();
  const last = days[days.length - 1];
  if (!last) throw new Error("Search Console returned no recent days");
  return last;
}

/** Search Console clicks + impressions per blog article over the range (clipped to its last day). */
async function readGsc(range: DateRange, today: string): Promise<{ window: DateRange; pages: Array<[string, GscPage]> }> {
  const last = await gscLastDay(today);
  const window: DateRange = { from: range.from, to: range.to < last ? range.to : last };
  if (window.from > window.to) throw new Error("Search Console has no data for this range yet");
  return unstable_cache(
    async () => {
      const rows = await gscQuery({
        startDate: window.from,
        endDate: window.to,
        dimensions: ["page"],
        dimensionFilterGroups: [{ filters: [{ dimension: "page", operator: "contains", expression: "/blog/" }] }],
      });
      const pages = new Map<string, GscPage>();
      for (const r of rows) {
        const slug = blogSlug(r.keys[0]);
        if (!slug) continue;
        const p = pages.get(slug) ?? { clicks: 0, impressions: 0 };
        p.clicks += r.clicks;
        p.impressions += r.impressions;
        pages.set(slug, p);
      }
      return { window, pages: [...pages.entries()] };
    },
    ["admin-blog-bookings", "gsc", window.from, window.to],
    { revalidate: CACHE_S }
  )();
}

const cmsPageSchema = z.object({
  docs: z.array(
    z.object({
      slug: z.string().nullish(),
      title: z.string().nullish(),
      airportCode: z.string().nullish(),
    })
  ),
  totalPages: z.number().optional(),
});

const CMS_PAGE = 500;
const CMS_MAX_PAGES = 40;

/** slug → title + airportCode for every published post (select keeps it to three fields). */
async function readArticleMeta(): Promise<Array<[string, ArticleMeta]>> {
  const out = new Map<string, ArticleMeta>();
  for (let page = 1; page <= CMS_MAX_PAGES; page++) {
    const raw: unknown = await fetchFromCms(
      "/posts",
      {
        "where[status][equals]": "published",
        "select[slug]": "true",
        "select[title]": "true",
        "select[airportCode]": "true",
        depth: "0",
        sort: "slug",
        limit: String(CMS_PAGE),
        page: String(page),
      },
      CACHE_S
    );
    const parsed = cmsPageSchema.safeParse(raw);
    if (!parsed.success) throw new Error("CMS posts response has an unexpected shape");
    for (const d of parsed.data.docs) {
      if (!d.slug) continue;
      const code = d.airportCode?.trim().toUpperCase();
      out.set(d.slug.toLowerCase(), { title: d.title ?? null, airport: code && /^[A-Z]{3}$/.test(code) ? code : null });
    }
    const totalPages = parsed.data.totalPages ?? 1;
    if (page >= totalPages || parsed.data.docs.length === 0) return [...out.entries()];
  }
  throw new Error(`CMS has more than ${CMS_PAGE * CMS_MAX_PAGES} posts`);
}

interface NetData {
  /** Booking id → net take (plain entries: unstable_cache JSON-serialises). */
  entries: Array<[string, number | null]>;
  fetchErrors: number;
}

/** Thrown out of the cached function so a partial result is never cached. */
class UncachedNet extends Error {
  constructor(readonly data: NetData) {
    super("net take had ResLab fetch errors");
  }
}

/**
 * Net take per blog booking id from the reconciler. Its range is UTC days and
 * ours is ET days, so ask for one extra day each side; the id list does the
 * real narrowing.
 */
async function computeNet(range: DateRange, ids: string[]): Promise<NetData> {
  const result = await reconcileRevenue({
    from: shiftIsoDate(range.from, -1),
    to: shiftIsoDate(range.to, 1),
    by: "created",
    invoiceAmount: 0,
    includeReslab: true,
    includeStripe: false,
    bookingIds: ids,
    reslabConcurrency: NET_RESLAB_CONCURRENCY,
  });
  return {
    entries: result.bookings.map((b) => [b.id, netTakeOfDetail(b)]),
    fetchErrors: result.reslab.fetchErrors.length,
  };
}

async function readNet(range: DateRange, ids: string[]): Promise<NetData> {
  if (ids.length === 0) return { entries: [], fetchErrors: 0 };
  const idsHash = createHash("sha256").update([...ids].sort().join(",")).digest("hex").slice(0, 32);
  try {
    return await unstable_cache(
      async () => {
        const data = await computeNet(range, ids);
        if (data.fetchErrors > 0) throw new UncachedNet(data);
        return data;
      },
      ["admin-blog-bookings", "net", range.from, range.to, idsHash],
      { revalidate: NET_CACHE_S }
    )();
  } catch (err) {
    if (err instanceof UncachedNet) return err.data;
    throw err;
  }
}

/**
 * The net section as the page sees it. Errors (not partial figures) when the
 * range is too wide or when most blog bookings came back without a figure.
 */
async function netSection(
  range: DateRange,
  ids: string[]
): Promise<{ section: Section<NetSummary>; netById?: Map<string, number | null>; report: boolean }> {
  const days = rangeDays(range);
  if (days > MAX_NET_RANGE_DAYS) {
    return {
      section: { ok: false, error: `net take covers at most ${MAX_NET_RANGE_DAYS} days — this range is ${days}` },
      report: false,
    };
  }
  const s = await section(() => readNet(range, ids));
  if (!s.ok) return { section: s, report: true };
  const netById = new Map(s.data.entries);
  const known = ids.filter((id) => {
    const v = netById.get(id);
    return v !== undefined && v !== null;
  }).length;
  const summary: NetSummary = { bookings: ids.length, known, fetchErrors: s.data.fetchErrors };
  if (s.data.fetchErrors > 0) {
    captureAPIError(new Error(`admin blog-bookings: ${s.data.fetchErrors} ResLab fetch error(s) in net take`), {
      endpoint: "/api/admin/blog-bookings",
      method: "GET",
      stage: "net",
    });
  }
  if (ids.length > 0 && known * 2 < ids.length) {
    return {
      section: {
        ok: false,
        error: `ResLab returned a figure for only ${known} of ${ids.length} blog bookings (${s.data.fetchErrors} fetch error(s))`,
      },
      report: true,
    };
  }
  return { section: { ok: true, data: summary }, netById, report: false };
}

export async function GET(request: NextRequest) {
  const authClient = await createClient();
  const {
    data: { user },
  } = await authClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAdminEmail(user.email)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const today = calendarDayIn(DIGEST_TZ, new Date());
  const params = request.nextUrl.searchParams;
  const fallback = defaultRange(today);
  // from/to are optional as a PAIR (no params = the default 90 days); one
  // without the other is rejected rather than silently filled in.
  if (params.has("from") !== params.has("to")) {
    return NextResponse.json({ error: "pass both from and to, or neither" }, { status: 400 });
  }
  const parsed = querySchema.safeParse({
    from: params.get("from") ?? fallback.from,
    to: params.get("to") ?? fallback.to,
    net: params.get("net") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues.map((i) => `${i.path.join(".") || "query"}: ${i.message}`).join("; ") },
      { status: 400 }
    );
  }
  const range: DateRange = { from: parsed.data.from, to: parsed.data.to };
  const wantNet = parsed.data.net === "1";

  let rows: BlogBookingRow[];
  try {
    rows = await readBookings(range);
  } catch (err) {
    captureAPIError(err instanceof Error ? err : new Error(String(err)), {
      endpoint: "/api/admin/blog-bookings",
      method: "GET",
      stage: "bookings",
    });
    return NextResponse.json({ error: "Bookings query failed — see Sentry for details" }, { status: 500 });
  }

  const [gsc, cms, netResult] = await Promise.all([
    section(() => readGsc(range, today)),
    section(readArticleMeta),
    wantNet ? netSection(range, blogTouchedIds(rows, range)) : Promise.resolve(null),
  ]);
  const net = netResult?.section ?? null;

  for (const [name, s, report] of [
    ["gsc", gsc, true],
    ["cms", cms, true],
    ["net", net, netResult?.report ?? false],
  ] as const) {
    if (s && !s.ok && report) {
      captureAPIError(new Error(`admin blog-bookings: ${name} unavailable: ${s.error}`), {
        endpoint: "/api/admin/blog-bookings",
        method: "GET",
        stage: name,
      });
    }
  }

  const report = aggregateBlogBookings({
    rows,
    range,
    gscBySlug: gsc.ok ? new Map(gsc.data.pages) : undefined,
    gscWindow: gsc.ok ? gsc.data.window : undefined,
    articleMeta: cms.ok ? new Map(cms.data) : undefined,
    netById: netResult?.netById,
  });

  const body: BlogBookingsResponse = {
    report,
    gsc: gsc.ok ? { ok: true, data: { window: gsc.data.window } } : gsc,
    cms: cms.ok ? { ok: true, data: { articles: cms.data.length } } : cms,
    ...(net ? { net } : {}),
  };
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}
