/**
 * Read the admin dashboard's GET /api/admin/stats response into either the
 * stats object or an error string for the banner — never something in between.
 *
 * WHY: the dashboard used to `await res.json()` on the stats and bookings
 * responses together inside one try. A gateway timeout (504 with an HTML body)
 * made `.json()` throw, the catch only logged, and the cards kept whatever they
 * showed before (or zeros on first load) with no banner — stale or empty
 * figures that looked real. Every non-success path here yields an error that
 * names the HTTP status, so the page can clear the figures and say why.
 */

export type StatsResponseResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Pass the `fetch(...)` promise itself (not an awaited Response) so a network
 * failure — the promise rejecting — is handled here too.
 */
export async function readStatsResponse<T extends object>(
  response: Response | Promise<Response>
): Promise<StatsResponseResult<T>> {
  let res: Response;
  try {
    res = await response;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Stats request failed (no response: ${msg})` };
  }

  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Stats failed to load (HTTP ${res.status}; body unreadable: ${msg})` };
  }

  let parsed: unknown;
  let isJson = true;
  try {
    parsed = JSON.parse(text);
  } catch {
    isJson = false;
  }

  if (!res.ok) {
    const apiError = isJson && isPlainObject(parsed) && typeof parsed.error === "string" ? parsed.error : null;
    return {
      ok: false,
      error: apiError
        ? `${apiError} (HTTP ${res.status})`
        : `Stats failed to load (HTTP ${res.status}${isJson ? "" : ", non-JSON response"})`,
    };
  }

  if (!isJson || !isPlainObject(parsed)) {
    return { ok: false, error: `Stats returned an unreadable response (HTTP ${res.status})` };
  }
  // A 200 that carries an `error` key is not stats.
  if (typeof parsed.error === "string") {
    return { ok: false, error: `${parsed.error} (HTTP ${res.status})` };
  }
  // The route owns the shape; this guards only "is it a JSON object at all".
  const data: T = JSON.parse(text);
  return { ok: true, data };
}
