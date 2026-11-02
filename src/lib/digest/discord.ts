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

export interface PostOptions {
  remainingBudgetMs: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** The webhook's display name for this post. Default: DISCORD_USERNAME. */
  username?: string;
  /**
   * Plain message text sent beside the embed. A mention only pings from here —
   * one inside an embed never does (the direct-lot alerts put "@here" here).
   */
  content?: string;
  /**
   * Which mentions in `content` may ping, e.g. { parse: ["everyone"] } for
   * "@here". Whenever `content` is sent this is too — default { parse: [] },
   * nothing pings — so a caller can never ping by accident.
   */
  allowedMentions?: { parse: Array<"everyone" | "users" | "roles"> };
  /** Per-attempt timeout. Default 8 s; the booking alert uses less because a booking waits on it. */
  timeoutMs?: number;
  /**
   * Count the post as delivered only when Discord says it SAVED the message:
   * sent with `?wait=true`, success = 200 with a message `id`. Without it a 204
   * is success, and Discord's docs say an unsaved message can still return no
   * error — fine for the digest, not for an alert whose fallback is email.
   */
  requireMessageId?: boolean;
}

/** Exactly a Discord webhook URL (optionally with a query, e.g. thread_id). */
export function isDiscordWebhookUrl(url: string): boolean {
  return /^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\d+\/[A-Za-z0-9_-]+(?:\?[^#\s]*)?$/.test(url);
}

function withWait(webhookUrl: string): string {
  const url = new URL(webhookUrl);
  url.searchParams.set("wait", "true");
  return url.toString();
}

function savedMessage(res: Response, text: string): boolean {
  if (res.status !== 200) return false;
  try {
    return typeof (JSON.parse(text) as { id?: unknown }).id === "string";
  } catch {
    return false;
  }
}

export async function postToDiscord(webhookUrl: string, embed: Embed, opts: PostOptions): Promise<PostResult> {
  const f = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const started = Date.now();
  // Optional keys are added only when given, so a caller passing none (the daily
  // digest) sends exactly the body it always did. Pinned by discord.test.ts.
  // Any `content` goes out with allowed_mentions (default: none may ping).
  const mentions = opts.allowedMentions ?? (opts.content !== undefined ? { parse: [] } : undefined);
  const body = JSON.stringify({
    username: opts.username ?? DISCORD_USERNAME,
    ...(opts.content !== undefined ? { content: opts.content } : {}),
    ...(mentions !== undefined ? { allowed_mentions: { parse: [...mentions.parse] } } : {}),
    embeds: [embed],
  });

  let target = webhookUrl;
  if (opts.requireMessageId) {
    try {
      target = withWait(webhookUrl);
    } catch {
      // Never echo the URL: it is a secret (Node's fetch puts it in its parse error).
      return { kind: "failed", status: null, body: "webhook URL is not a valid URL", retried: false };
    }
  }
  const delivered = (res: Response, text: string) =>
    opts.requireMessageId ? savedMessage(res, text) : res.ok || res.status === 204;

  const attempt = async (): Promise<{ res: Response; text: string } | { error: string }> => {
    try {
      const res = await f(target, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 8_000),
      });
      const text = await res.text().catch(() => "");
      return { res, text };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  };

  const first = await attempt();
  if ("error" in first) return { kind: "failed", status: null, body: first.error, retried: false };
  if (delivered(first.res, first.text)) return { kind: "posted", status: first.res.status, retried: false };
  // Not the reply itself: with wait=true it echoes the message, customer text included.
  if (first.res.ok) return { kind: "failed", status: first.res.status, body: `no saved message in the reply (${first.text.length} bytes)`, retried: false };

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
  if (delivered(second.res, second.text)) return { kind: "posted", status: second.res.status, retried: true };
  if (second.res.ok) return { kind: "failed", status: second.res.status, body: `no saved message in the reply (${second.text.length} bytes)`, retried: true };
  return { kind: "failed", status: second.res.status, body: second.text.slice(0, 300), retried: true };
}
