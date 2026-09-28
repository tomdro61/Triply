/**
 * The model-written read (plan v2 §2): 3–5 sentences from Haiku on the
 * AGGREGATES ONLY, then a post-hoc number check. A number the model emits that
 * is not in its input withholds the read with a visible line — a missing read
 * must never be indistinguishable from a timeout.
 */

import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import type { DigestData } from "./types";

/** The digest's own pin — never the customer-chat AI_MODEL, which is tuned separately. */
export const DIGEST_MODEL = "claude-haiku-4-5";
export const READ_TIMEOUT_MS = 6_000;

export type ReadResult =
  | { kind: "ok"; text: string }
  | { kind: "withheld"; reason: string }
  | { kind: "unavailable"; reason: string };

/**
 * The allow-listed model input: aggregates only. No lost-sales rows, no free
 * text from any table, no ids. Built by explicit field selection so a new
 * row-level field added to DigestData cannot leak by default.
 */
export function modelInput(d: DigestData): Record<string, unknown> {
  const b = d.bookings.ok ? d.bookings.data : null;
  const w = d.whereFrom.ok ? d.whereFrom.data : null;
  const f = d.funnel.ok ? d.funnel.data : null;
  const l = d.lostSales.ok ? d.lostSales.data : null;
  const e = d.engagement.ok ? d.engagement.data : null;
  return {
    date: d.dateEt,
    bookings: b && {
      count: b.count.value,
      avg7: b.count.avg7,
      avg28: b.count.avg28,
      gmv: b.gmv,
      chargedOnline: b.chargedOnline,
      avgOrder: b.avgOrder,
      feeIncome: b.feeIncome,
      pgAttachRate: b.pgAttachRate,
      promoBookings: b.promoBookings,
      repeatByEmail: b.repeatByEmail,
      leadTime: b.leadTime,
      cancelledOrFailed: b.cancelledOrFailed,
    },
    whereFrom: w && {
      byChannel: w.byChannel,
      topAirports: w.topAirports,
      landing: w.landing,
      aiReferrals: w.aiReferrals,
      topBlogPosts: w.topBlogPosts.map((p) => ({ path: p.path, bookings: p.bookings })),
    },
    funnel: f && {
      originSearches: f.originSearches.value,
      originAvg7: f.originSearches.avg7,
      distinctAirports: f.distinctAirports,
      topAirports: f.topAirports,
      datesDefaultedShare: f.datesDefaultedShare,
      soldOutShare: f.soldOutShare,
      degradedCount: f.degradedCount,
    },
    lostSalesByStatus: l ? l.byStatus : null,
    engagement: e && {
      newsletter: e.newsletterBySource,
      waitlist: e.waitlistByAirport,
      chatSessions: e.chatSessions,
    },
  };
}

const SYSTEM = `You write a 3–5 sentence morning read of yesterday's numbers for a small airport-parking marketplace (Triply). Rules:
- Use ONLY numbers present in the JSON you are given. Never compute or invent a number, a percentage, or a total.
- Compare yesterday to avg7/avg28 only where those are present (null means "no baseline yet" — say so, do not guess).
- No causal claims ("because", "due to", "driven by"); say what changed, and name one thing worth a look.
- "originSearches" are CDN misses, not customer searches — never call them customers or visits.
- No advice on pricing, legal, or marketing spend. No greetings. Plain sentences, no bullets, no headers.`;

// ── number validation ──────────────────────────────────────────────

// A number token INCLUDING any letter/percent suffix glued to it ("10k", "9am",
// "3x", "$1.2k", "4.7%"). The suffix is captured so a magnitude or unit the
// aggregates never carry is rejected rather than skipped — there is no word
// boundary between a digit and a letter, so a plain \b-bounded pattern would
// simply not see "10k" and let it through.
const CANDIDATE = /\$\s?\d[\d,]*(?:\.\d+)?[a-z%]*|\b\d[\d,]*(?:\.\d+)?[a-z%]*/gi;
const SUFFIX = /[a-z%]+$/i;
// Suffixes that do not change the number's meaning: percent, ordinals, "7d".
const HARMLESS_SUFFIX = /^(%|st|nd|rd|th|d)$/i;

function normalise(tok: string): string {
  let t = tok.replace(/[$,%\s]/g, "").replace(SUFFIX, "");
  if (/^\d+\.0+$/.test(t)) t = t.replace(/\.0+$/, "");
  return t;
}

/** Every rendered form of every number in the input, plus window labels and the date's numerals. */
export function allowedTokens(input: Record<string, unknown>, dateEt: string): Set<string> {
  const out = new Set<string>(["7", "28"]);
  const [y, m, d] = dateEt.split("-");
  out.add(y);
  out.add(String(Number(d)));
  out.add(d); // the model may echo the date verbatim, zero-padded
  out.add(String(Number(m)));
  out.add(m);
  const walk = (v: unknown): void => {
    if (typeof v === "number" && Number.isFinite(v)) {
      out.add(normalise(String(v)));
      out.add(normalise(v.toFixed(2)));
      out.add(normalise(v.toFixed(1)));
      out.add(normalise(String(Math.round(v))));
      if (v >= 0 && v <= 1) {
        // a share (0 and 1 included — "0%" / "100%"): the model may write it as a percentage
        out.add(normalise(String(Math.round(v * 100))));
        out.add(normalise((v * 100).toFixed(1)));
      }
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(input);
  return out;
}

/** Returns the first offending token, or null when every number is accounted for. */
export function firstUnexplainedNumber(text: string, allowed: Set<string>): string | null {
  for (const m of text.matchAll(CANDIDATE)) {
    const raw = m[0];
    const suffix = raw.replace(/[$\s]/g, "").match(SUFFIX)?.[0] ?? "";
    // "10k", "9am", "3x", "$1.2k": a unit or magnitude the aggregates never use.
    if (suffix && !HARMLESS_SUFFIX.test(suffix)) return raw.trim();
    if (!allowed.has(normalise(raw))) return raw.trim();
  }
  return null;
}

export async function writeModelRead(data: DigestData): Promise<ReadResult> {
  const input = modelInput(data);
  let text: string;
  try {
    const r = await generateText({
      model: anthropic(DIGEST_MODEL),
      system: SYSTEM,
      prompt: JSON.stringify(input),
      maxOutputTokens: 300,
      abortSignal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
    text = r.text.trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { kind: "unavailable", reason: /abort|timeout/i.test(msg) ? "timeout" : msg.slice(0, 80) };
  }
  if (text.length === 0) return { kind: "unavailable", reason: "empty" };
  const bad = firstUnexplainedNumber(text, allowedTokens(input, data.dateEt));
  if (bad !== null) return { kind: "withheld", reason: `failed number check (${bad})` };
  return { kind: "ok", text: text.slice(0, 900) };
}
