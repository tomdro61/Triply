import { createSign } from "node:crypto";
import { z } from "zod";

/**
 * Read-only Google Analytics 4 + Search Console client for the admin
 * Analytics page. Signs a service-account JWT with node:crypto (no SDK
 * dependency) and exchanges it for an access token.
 *
 * Key: GOOGLE_ANALYTICS_SA_KEY = the service account's JSON key, base64-
 * encoded (Vercel Production only; never in the repo). The account is an
 * Analytics Viewer on the GA4 property and a restricted user on the Search
 * Console domain property, so it can read and never change anything.
 * Missing or malformed key → GoogleConfigError, which callers show as
 * "unavailable", never as zero.
 */

export const GA4_PROPERTY = "523836069";
export const GSC_SITE = "sc-domain:triplypro.com";
const SCOPES = [
  "https://www.googleapis.com/auth/analytics.readonly",
  "https://www.googleapis.com/auth/webmasters.readonly",
].join(" ");
const TIMEOUT_MS = 8_000;

export class GoogleConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleConfigError";
  }
}

const keySchema = z.object({ client_email: z.string().min(1), private_key: z.string().min(1) });

function readKey(): z.infer<typeof keySchema> {
  const raw = process.env.GOOGLE_ANALYTICS_SA_KEY;
  if (!raw) throw new GoogleConfigError("GOOGLE_ANALYTICS_SA_KEY is not set");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
  } catch {
    throw new GoogleConfigError("GOOGLE_ANALYTICS_SA_KEY is not base64-encoded JSON");
  }
  const key = keySchema.safeParse(parsed);
  if (!key.success) throw new GoogleConfigError("GOOGLE_ANALYTICS_SA_KEY lacks client_email / private_key");
  return key.data;
}

let cachedToken: { token: string; expMs: number } | null = null;

async function accessToken(): Promise<string> {
  if (cachedToken && cachedToken.expMs > Date.now() + 60_000) return cachedToken.token;
  const key = readKey();
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({
    iss: key.client_email,
    scope: SCOPES,
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  })}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(key.private_key, "base64url");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${signature}`,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: "no-store",
  });
  const body: unknown = await res.json().catch(() => null);
  const parsed = z.object({ access_token: z.string(), expires_in: z.number() }).safeParse(body);
  if (!res.ok || !parsed.success) throw new Error(`Google token exchange failed (HTTP ${res.status})`);
  cachedToken = { token: parsed.data.access_token, expMs: Date.now() + parsed.data.expires_in * 1000 };
  return cachedToken.token;
}

async function post(url: string, payload: object): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${await accessToken()}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: "no-store",
  });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = z.object({ error: z.object({ message: z.string() }) }).safeParse(body);
    throw new Error(`Google API HTTP ${res.status}: ${msg.success ? msg.data.error.message : "no message"}`);
  }
  return body;
}

const ga4ResponseSchema = z.object({
  dimensionHeaders: z.array(z.object({ name: z.string() })).optional(),
  metricHeaders: z.array(z.object({ name: z.string() })).optional(),
  rows: z
    .array(
      z.object({
        dimensionValues: z.array(z.object({ value: z.string() })),
        metricValues: z.array(z.object({ value: z.string() })),
      })
    )
    .optional(),
  rowCount: z.number().optional(),
  metadata: z.object({ dataLossFromOtherRow: z.boolean().optional() }).optional(),
});

export type Ga4Row = { dims: Record<string, string>; metrics: Record<string, number> };

const GA4_PAGE = 10_000;
const MAX_PAGES = 10;

/**
 * GA4 Data API runReport → flat rows, ALL of them: pages with `offset` until
 * `rowCount` rows are in. Throws (never returns a silently partial report)
 * when the row count can't be reached or GA4 folded rows into "(other)".
 */
export async function ga4Report(report: object): Promise<Ga4Row[]> {
  const out: Ga4Row[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = ga4ResponseSchema.parse(
      await post(`https://analyticsdata.googleapis.com/v1beta/properties/${GA4_PROPERTY}:runReport`, {
        ...report,
        limit: GA4_PAGE,
        offset: page * GA4_PAGE,
      })
    );
    if (body.metadata?.dataLossFromOtherRow) {
      throw new Error("GA4 folded rows into \"(other)\" — the report would be incomplete");
    }
    const dimNames = (body.dimensionHeaders ?? []).map((h) => h.name);
    const metricNames = (body.metricHeaders ?? []).map((h) => h.name);
    const rows = body.rows ?? [];
    for (const r of rows) {
      out.push({
        dims: Object.fromEntries(dimNames.map((n, i) => [n, r.dimensionValues[i]?.value ?? ""])),
        metrics: Object.fromEntries(metricNames.map((n, i) => [n, Number(r.metricValues[i]?.value ?? 0)])),
      });
    }
    if (body.rowCount === undefined) {
      // No count: a short page is the last one; a full page means more may follow.
      if (rows.length < GA4_PAGE) return out;
      continue;
    }
    if (out.length >= body.rowCount || rows.length === 0) {
      if (out.length < body.rowCount) throw new Error(`GA4 returned ${out.length} of ${body.rowCount} rows`);
      return out;
    }
  }
  throw new Error(`GA4 report has more than ${MAX_PAGES * GA4_PAGE} rows`);
}

const gscResponseSchema = z.object({
  rows: z
    .array(
      z.object({
        // Absent on a totals query (no dimensions).
        keys: z.array(z.string()).default([]),
        clicks: z.number(),
        impressions: z.number(),
      })
    )
    .optional(),
});

export type GscRow = { keys: string[]; clicks: number; impressions: number };

const GSC_PAGE = 25_000;

/** Search Console searchAnalytics.query, all pages (`startRow`) — a full page means more follow. */
export async function gscQuery(query: object): Promise<GscRow[]> {
  const out: GscRow[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = gscResponseSchema.parse(
      await post(
        `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(GSC_SITE)}/searchAnalytics/query`,
        { ...query, rowLimit: GSC_PAGE, startRow: page * GSC_PAGE }
      )
    );
    const rows = body.rows ?? [];
    out.push(...rows);
    if (rows.length < GSC_PAGE) return out;
  }
  throw new Error(`Search Console query has more than ${MAX_PAGES * GSC_PAGE} rows`);
}
