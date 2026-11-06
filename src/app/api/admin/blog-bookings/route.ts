import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { unstable_cache } from "next/cache";
import { z } from "zod";
import { createAdminClient, createClient } from "@/lib/supabase/server";
import { excludeTestBookings, isAdminEmail } from "@/config/admin";
import blogRedirectMap from "@/config/blog-redirects.json";
import { captureAPIError } from "@/lib/sentry";
import { calendarDayIn, DIGEST_TZ, shiftIsoDate } from "@/lib/digest/window";
import { gscQuery, GoogleConfigError } from "@/lib/google/client";
import { fetchFromCms } from "@/lib/cms";
import { reconcileRevenue, RESLAB_SKIPPED_TIME_BUDGET } from "@/lib/accounting/reconcile";
import {
  aggregateBlogBookings,
  blogSlug,
  blogTouchedIds,
  defaultRange,
  LIVE_STATUSES,
  MAX_NET_RANGE_DAYS,
  MAX_RANGE_DAYS,
  mergeRedirectedSlugs,
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
import { netShortfallText } from "@/lib/admin/blog-bookings-format";

/**
 * GET /api/admin/blog-bookings?from=YYYY-MM-DD&to=YYYY-MM-DD[&net=1|fresh]
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
 * is cached 6 h per (range, blog booking ids and their statuses), so a
 * booking that turns disputed recomputes; a result with ResLab fetch errors
 * is not cached. The net section carries `computedAt`, so a cached figure
 * shows its age.
 * `net=fresh` is the page's "Reload net take": the same section, computed
 * now without reading or writing the cache.
 *
 * Search Console and the CMS are independent sections, each with its own
 * time budget: a failure or a late answer is { ok: false, error } (and
 * Sentry), never shown as zero clicks. A range Search Console has no data for
 * yet is { ok: false, note: true } — expected, so not reported.
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
  .object({ from: isoDate, to: isoDate, net: z.enum(["0", "1", "fresh"]).optional() })
  .refine((q) => q.from <= q.to, { message: "from must be ≤ to" })
  .refine((q) => rangeDays(q) <= MAX_RANGE_DAYS, { message: `range must be ≤ ${MAX_RANGE_DAYS} days` });

const ENDPOINT = "/api/admin/blog-bookings";
const CACHE_S = 3600;
const NET_CACHE_S = 6 * 3600;
const NET_RESLAB_CONCURRENCY = 10;
// Every ResLab request and by-id bookings page in net take is aborted after
// this long, so one hung read can't hold the function to maxDuration.
const NET_FETCH_TIMEOUT_MS = 8_000;
// No ResLab read starts later than this after the request began. One already
// in flight is bounded by NET_FETCH_TIMEOUT_MS, so net take is done by ~48 s
// and the response leaves inside maxDuration (60 s) — including when the
// bookings read was slow, since the clock starts with the request.
const NET_DEADLINE_MS = 40_000;
/** Failed ResLab reads sent to Sentry with the event (the count is always sent). */
const NET_ERROR_SAMPLE = 20;
// Search Console and the CMS run beside net take once the bookings are read;
// each is cut off at its budget, so a slow source fails its own section
// instead of the whole page (a CMS page is up to 2 × 8 s with its retry).
const GSC_BUDGET_MS = 20_000;
const CMS_BUDGET_MS = 25_000;
const PAGE = 1000; // PostgREST's default max-rows
const MAX_ROWS = 20_000;

/** Merged posts' old slugs → the survivor ({} until a merge ships). */
const BLOG_REDIRECTS: Readonly<Record<string, string>> = blogRedirectMap;

/**
 * A section as the route holds it: the page's Section plus, on failure, the
 * original error for Sentry and whether to report it at all (an expected
 * state is not). Narrowed to a Section before it is sent.
 */
type Attempt<T> = { ok: true; data: T } | { ok: false; error: string; note?: true; cause: unknown; report: boolean };

/** Search Console lags 2–3 days, so a range of only the last day or two has
 *  no data yet: an expected state, shown as a note and never reported. */
class GscNoDataYet extends Error {}

/** A section that didn't answer inside its budget. One message per section,
 *  so Sentry groups them. */
class SectionTimeout extends Error {
  constructor(label: string, budgetMs: number) {
    super(`${label} took longer than ${budgetMs / 1000} s`);
  }
}

/** `fn`, rejected with SectionTimeout if it hasn't settled within `ms`. The
 *  late work isn't cancelled; its eventual result is ignored. */
function withBudget<T>(label: string, ms: number, fn: () => Promise<T>): () => Promise<T> {
  return () =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new SectionTimeout(label, ms)), ms);
      fn().then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        }
      );
    });
}

async function section<T>(fn: () => Promise<T>): Promise<Attempt<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (error) {
    if (error instanceof GscNoDataYet) return { ok: false, error: error.message, note: true, cause: error, report: false };
    if (error instanceof GoogleConfigError) {
      return { ok: false, error: "Google access isn't set up (GOOGLE_ANALYTICS_SA_KEY)", cause: error, report: true };
    }
    return { ok: false, error: error instanceof Error ? error.message : String(error), cause: error, report: true };
  }
}

function toSection<T, U>(a: Attempt<T>, data: (d: T) => U): Section<U> {
  if (a.ok) return { ok: true, data: data(a.data) };
  return { ok: false, error: a.error, ...(a.note ? { note: true as const } : {}) };
}

/** Sentry for a failed section: the original error when there is one, else a
 *  fixed message per stage, so events group. */
function reportSection(stage: string, a: Attempt<unknown>): void {
  if (a.ok || !a.report) return;
  captureAPIError(a.cause instanceof Error ? a.cause : new Error(`admin blog-bookings: ${stage} unavailable`), {
    endpoint: ENDPOINT,
    method: "GET",
    stage,
    extra: { error: a.error },
  });
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
  if (window.from > window.to) {
    throw new GscNoDataYet(`Search Console has no data for this range yet (its latest day is ${last})`);
  }
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
  /** Of fetchErrors, reads skipped because the deadline passed. */
  skipped: number;
  /** Up to NET_ERROR_SAMPLE failed reads, for Sentry. */
  errorSample: Array<{ reservation: string; error: string }>;
  /** When the reconciler finished (ISO). */
  computedAt: string;
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
 * real narrowing. Bounded: every request times out and no read starts after
 * `deadline` (a skipped read is a fetch error, so the result isn't cached).
 */
async function computeNet(range: DateRange, ids: string[], deadline: number): Promise<NetData> {
  const result = await reconcileRevenue({
    from: shiftIsoDate(range.from, -1),
    to: shiftIsoDate(range.to, 1),
    by: "created",
    invoiceAmount: 0,
    includeReslab: true,
    includeStripe: false,
    bookingIds: ids,
    reslabConcurrency: NET_RESLAB_CONCURRENCY,
    fetchTimeoutMs: NET_FETCH_TIMEOUT_MS,
    deadline,
  });
  const errors = result.reslab.fetchErrors;
  return {
    entries: result.bookings.map((b) => [b.id, netTakeOfDetail(b)]),
    fetchErrors: errors.length,
    skipped: errors.filter((e) => e.err === RESLAB_SKIPPED_TIME_BUDGET).length,
    errorSample: errors.slice(0, NET_ERROR_SAMPLE).map((e) => ({ reservation: e.resNum, error: e.err })),
    computedAt: new Date().toISOString(),
  };
}

/**
 * Cache key part for net take: the blog booking ids AND their statuses, so a
 * booking that turns disputed (which has no net figure) recomputes instead of
 * keeping its cached confirmed figure for up to NET_CACHE_S.
 */
function netFingerprint(ids: readonly string[], rows: readonly BlogBookingRow[]): string {
  const status = new Map(rows.map((r) => [r.id, r.status]));
  const parts = ids.map((id) => `${id}:${status.get(id) ?? ""}`).sort();
  return createHash("sha256").update(parts.join(",")).digest("hex").slice(0, 32);
}

async function readNet(
  range: DateRange,
  ids: string[],
  fingerprint: string,
  deadline: number,
  fresh: boolean
): Promise<NetData> {
  if (ids.length === 0) {
    return { entries: [], fetchErrors: 0, skipped: 0, errorSample: [], computedAt: new Date().toISOString() };
  }
  if (fresh) return computeNet(range, ids, deadline);
  try {
    return await unstable_cache(
      async () => {
        const data = await computeNet(range, ids, deadline);
        if (data.fetchErrors > 0) throw new UncachedNet(data);
        return data;
      },
      ["admin-blog-bookings", "net", range.from, range.to, fingerprint],
      { revalidate: NET_CACHE_S }
    )();
  } catch (err) {
    if (err instanceof UncachedNet) return err.data;
    throw err;
  }
}

/**
 * The net section as the page sees it, reported to Sentry here. Errors (not
 * partial figures) when the range is too wide or when most blog bookings came
 * back without a figure.
 */
async function netSection(
  range: DateRange,
  rows: readonly BlogBookingRow[],
  deadline: number,
  fresh: boolean
): Promise<{ section: Section<NetSummary>; netById?: Map<string, number | null> }> {
  const days = rangeDays(range);
  if (days > MAX_NET_RANGE_DAYS) {
    return { section: { ok: false, error: `net take covers at most ${MAX_NET_RANGE_DAYS} days — this range is ${days}` } };
  }
  const ids = blogTouchedIds(rows, range);
  const s = await section(() => readNet(range, ids, netFingerprint(ids, rows), deadline, fresh));
  if (!s.ok) {
    reportSection("net", s);
    return { section: { ok: false, error: s.error } };
  }
  const netById = new Map(s.data.entries);
  const known = ids.filter((id) => {
    const v = netById.get(id);
    return v !== undefined && v !== null;
  }).length;
  const summary: NetSummary = {
    bookings: ids.length,
    known,
    fetchErrors: s.data.fetchErrors,
    skipped: s.data.skipped,
    computedAt: s.data.computedAt,
  };
  const counts = { bookings: summary.bookings, known, fetchErrors: summary.fetchErrors, skipped: summary.skipped };
  if (s.data.fetchErrors > 0) {
    captureAPIError(new Error("admin blog-bookings: net take had ResLab fetch errors"), {
      endpoint: ENDPOINT,
      method: "GET",
      stage: "net",
      extra: { ...counts, sample: s.data.errorSample },
    });
  }
  if (ids.length > 0 && known * 2 < ids.length) {
    captureAPIError(new Error("admin blog-bookings: net take has a figure for under half the blog bookings"), {
      endpoint: ENDPOINT,
      method: "GET",
      stage: "net",
      extra: counts,
    });
    return { section: { ok: false, error: netShortfallText(summary) } };
  }
  return { section: { ok: true, data: summary }, netById };
}

export async function GET(request: NextRequest) {
  const startedAt = Date.now();
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
  const wantNet = parsed.data.net === "1" || parsed.data.net === "fresh";

  let rows: BlogBookingRow[];
  try {
    rows = await readBookings(range);
  } catch (err) {
    captureAPIError(err instanceof Error ? err : new Error(String(err)), {
      endpoint: ENDPOINT,
      method: "GET",
      stage: "bookings",
    });
    return NextResponse.json({ error: "Bookings query failed — see Sentry for details" }, { status: 500 });
  }

  const [gsc, cms, netResult] = await Promise.all([
    section(withBudget("Search Console", GSC_BUDGET_MS, () => readGsc(range, today))),
    section(withBudget("CMS", CMS_BUDGET_MS, readArticleMeta)),
    wantNet
      ? netSection(range, rows, startedAt + NET_DEADLINE_MS, parsed.data.net === "fresh")
      : Promise.resolve(null),
  ]);
  reportSection("gsc", gsc);
  reportSection("cms", cms);

  const report = aggregateBlogBookings({
    rows,
    range,
    gscBySlug: gsc.ok ? mergeRedirectedSlugs(gsc.data.pages, BLOG_REDIRECTS) : undefined,
    gscWindow: gsc.ok ? gsc.data.window : undefined,
    articleMeta: cms.ok ? new Map(cms.data) : undefined,
    netById: netResult?.netById,
  });

  const body: BlogBookingsResponse = {
    report,
    gsc: toSection(gsc, (d) => ({ window: d.window })),
    cms: toSection(cms, (d) => ({ articles: d.length })),
    ...(netResult ? { net: netResult.section } : {}),
  };
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}
