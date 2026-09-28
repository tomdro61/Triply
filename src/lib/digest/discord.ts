/**
 * Post an embed to a Discord webhook with a BUDGETED retry (plan v2 §3): a
 * global 429 can carry a Retry-After of tens of seconds, and sleeping through
 * it inside a 60-s lambda kills the run with no post, no status, no Sentry.
 */

import type { Embed } from "./render";

export const DISCORD_USERNAME = "Triply Daily";

export type PostResult =
  | { kind: "posted"; status: number; retried: boolean }
  | { kind: "failed"; status: number | null; body: string; retried: boolean };

function retryAfterMs(res: Response, bodyText: string): number | null {
  const h = res.headers.get("retry-after");
  if (h && /^\d+(\.\d+)?$/.test(h)) return Math.ceil(Number(h) * 1000);
  try {
    const j = JSON.parse(bodyText) as { retry_after?: unknown };
    if (typeof j.retry_after === "number") return Math.ceil(j.retry_after * 1000);
  } catch {
    // not JSON
  }
  return null;
}

export async function postToDiscord(
  webhookUrl: string,
  embed: Embed,
  opts: { remainingBudgetMs: number; fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> }
): Promise<PostResult> {
  const f = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const started = Date.now();
  const body = JSON.stringify({ username: DISCORD_USERNAME, embeds: [embed] });

  const attempt = async (): Promise<{ res: Response; text: string } | { error: string }> => {
    try {
      const res = await f(webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(8_000),
      });
      const text = await res.text().catch(() => "");
      return { res, text };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  };

  const first = await attempt();
  if ("error" in first) return { kind: "failed", status: null, body: first.error, retried: false };
  if (first.res.ok || first.res.status === 204) return { kind: "posted", status: first.res.status, retried: false };

  const retryable = first.res.status === 429 || first.res.status >= 500;
  if (!retryable) return { kind: "failed", status: first.res.status, body: first.text.slice(0, 300), retried: false };

  const wait = retryAfterMs(first.res, first.text) ?? 2_000;
  const elapsed = Date.now() - started;
  const budgetLeft = opts.remainingBudgetMs - elapsed - 5_000 - 8_000; // leave the flush + one attempt
  if (wait > budgetLeft) {
    // The wait does not fit: go straight to the loud path rather than be killed mid-sleep.
    return { kind: "failed", status: first.res.status, body: `retry-after ${wait} ms exceeds the remaining budget`, retried: false };
  }
  await sleep(wait);
  const second = await attempt();
  if ("error" in second) return { kind: "failed", status: null, body: second.error, retried: true };
  if (second.res.ok || second.res.status === 204) return { kind: "posted", status: second.res.status, retried: true };
  return { kind: "failed", status: second.res.status, body: second.text.slice(0, 300), retried: true };
}
