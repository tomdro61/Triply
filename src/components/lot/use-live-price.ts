"use client";

import { useEffect, useState } from "react";
import { z } from "zod";
import { priceViewFromQuote, type PriceView } from "@/lib/pricing/price-view";
import { convertTo24Hour } from "@/lib/utils/time";

/**
 * What a price box (lot page booking box, search slider) should show for the
 * dates and times on screen.
 *
 * The lot's own pricing was priced once, when the page loaded (the search's or
 * the link's dates, at the page's pricing times). Once the customer has picked
 * both times, this asks GET /api/lots/quote for the stay on screen — totals
 * equal to what checkout charges for that stay, before optional Park Guard
 * protection and any promo. Until both times are
 * picked: the loaded price while the dates are unchanged and no time is
 * picked, otherwise no figure at all ("needs_times") — never a default-time
 * guess or the old stay's total.
 */
export type LivePrice =
  | { kind: "as_loaded" }
  | { kind: "needs_times" }
  /** A direct lot not open for online booking: there is no quote to ask for. */
  | { kind: "closed" }
  | { kind: "loading" }
  | { kind: "ready"; view: PriceView }
  | { kind: "sold_out" }
  /** Checkout would refuse this stay (e.g. inside the lot's notice period, below its minimum stay). */
  | { kind: "not_bookable" }
  /** The quote could not be had (outage, network, a malformed answer). */
  | { kind: "error" };

export type Settled = Extract<LivePrice, { kind: "ready" | "sold_out" | "not_bookable" | "error" }>;

export interface LivePriceInput {
  lotId: string;
  checkIn: string;
  checkOut: string;
  /** "" until the customer picks one. */
  checkInTime: string;
  checkOutTime: string;
  /** The dates the lot's own pricing was priced for. */
  pricedCheckIn: string;
  pricedCheckOut: string;
  /** False for a direct lot not open for online booking (checkout refuses it). */
  enabled: boolean;
}

export type LivePricePlan =
  | { kind: "as_loaded" | "needs_times" | "closed" | "not_bookable" }
  /** `key` is the quote's query string — it identifies the stay, so an answer
   *  for an older stay is never shown for a newer one. */
  | { kind: "fetch"; key: string };

/**
 * Pure: what to show without a network call, or which quote to fetch.
 * The page's own pricing times are never treated as the customer's: the server
 * may have priced a different time than the link carried (a time that can no
 * longer be booked, the lot's own timezone), so any picked times are quoted.
 */
export function planLivePrice(i: LivePriceInput): LivePricePlan {
  const datesChanged = i.checkIn !== i.pricedCheckIn || i.checkOut !== i.pricedCheckOut;
  if (!i.enabled) return datesChanged ? { kind: "closed" } : { kind: "as_loaded" };
  const picked = (i.checkInTime !== "" ? 1 : 0) + (i.checkOutTime !== "" ? 1 : 0);
  if (picked === 0) return datesChanged ? { kind: "needs_times" } : { kind: "as_loaded" };
  // One time picked can already change the billed days — no figure until both are.
  if (picked === 1 || i.checkIn === "" || i.checkOut === "") return { kind: "needs_times" };
  // Pick-up must be after drop-off (the date picker allows the same day) —
  // checkout refuses it, so don't ask.
  if (`${i.checkOut} ${convertTo24Hour(i.checkOutTime)}` <= `${i.checkIn} ${convertTo24Hour(i.checkInTime)}`) {
    return { kind: "not_bookable" };
  }
  const key = new URLSearchParams({
    lotId: i.lotId,
    checkin: i.checkIn,
    checkout: i.checkOut,
    checkinTime: i.checkInTime,
    checkoutTime: i.checkOutTime,
  }).toString();
  return { kind: "fetch", key };
}

// The answer is checked, not trusted (CLAUDE.md: Zod at boundaries).
const quoteBodySchema = z.object({
  quote: z.object({
    grandTotal: z.number().finite(),
    subtotal: z.number().finite(),
    feesTotal: z.number().finite(),
    taxTotal: z.number().finite(),
    serviceFee: z.number().finite(),
    dueAtLocation: z.number().finite(),
    numberOfDays: z.number().finite().optional(),
    soldOut: z.boolean(),
  }),
});

/**
 * Pure: a GET /api/lots/quote answer → what to show. Never the old stay's total.
 * - 404/422: checkout would refuse this stay → not_bookable (Reserve off).
 * - 400 is a request our own route rejected (page and server disagree) — our
 *   bug, not the customer's answer: error, Reserve stays on.
 * - Anything else that isn't a valid quote: error ("total shown at checkout").
 */
export function settleQuote(status: number, body: unknown): Settled {
  if (status === 404 || status === 422) return { kind: "not_bookable" };
  if (status < 200 || status >= 300) return { kind: "error" };
  const parsed = quoteBodySchema.safeParse(body);
  if (!parsed.success) return { kind: "error" };
  if (parsed.data.quote.soldOut) return { kind: "sold_out" };
  const view = priceViewFromQuote(parsed.data.quote);
  return view ? { kind: "ready", view } : { kind: "error" };
}

/** Fetches one quote. Null when aborted (a newer stay replaced it). */
export async function fetchQuote(
  key: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch
): Promise<Settled | null> {
  try {
    const res = await fetchImpl(`/api/lots/quote?${key}`, { signal, cache: "no-store" });
    const body: unknown = await res.json().catch(() => null);
    return signal.aborted ? null : settleQuote(res.status, body);
  } catch {
    // Network failure or abort. Not reported: the route reports ResLab
    // outages (throttled); here a failure only means "no figure".
    return signal.aborted ? null : { kind: "error" };
  }
}

/** Pure: the plan plus the last settled answer → what to show. */
export function pickLive(plan: LivePricePlan, settled: { key: string; price: Settled } | null): LivePrice {
  if (plan.kind !== "fetch") return { kind: plan.kind };
  return settled && settled.key === plan.key ? settled.price : { kind: "loading" };
}

const QUOTE_DEBOUNCE_MS = 400;

export function useLivePrice(input: LivePriceInput): LivePrice {
  const plan = planLivePrice(input);
  const key = plan.kind === "fetch" ? plan.key : null;
  const [settled, setSettled] = useState<{ key: string; price: Settled } | null>(null);

  useEffect(() => {
    if (!key) return;
    const controller = new AbortController();
    // Wait out a burst of changes (date picker, two time selects) so one stay
    // costs one quote; a newer stay cancels both the wait and the request.
    const timer = setTimeout(() => {
      fetchQuote(key, controller.signal).then((price) => {
        if (price) setSettled({ key, price });
      });
    }, QUOTE_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [key]);

  return pickLive(plan, settled);
}
