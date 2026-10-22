"use client";

import { useEffect, useState } from "react";
import type { CheckoutCostData } from "@/types/checkout";
import { priceViewFromCost, type PriceView } from "@/lib/pricing/price-view";

/**
 * What a price box (lot page booking box, search slider) should show for the
 * dates and times on screen.
 *
 * The lot's own pricing was priced once, for the window the page was loaded
 * with. Once the customer has picked both times — and the stay differs from
 * that window — this asks GET /api/checkout/lot for the stay on screen: the
 * same endpoint the checkout page prices from, so the box and checkout agree.
 * Dates changed but times not picked yet → no figure at all ("needs_times"),
 * rather than a default-time guess or the old window's total.
 */
export type LivePrice =
  | { kind: "as_loaded" }
  | { kind: "needs_times" }
  | { kind: "loading" }
  | { kind: "ready"; view: PriceView }
  | { kind: "sold_out" }
  | { kind: "error" };

type Settled = Extract<LivePrice, { kind: "ready" | "sold_out" | "error" }>;

export interface StayOnScreen {
  checkIn: string;
  checkOut: string;
  /** "" until the customer picks one. */
  checkInTime: string;
  checkOutTime: string;
}

export interface LivePriceInput extends StayOnScreen {
  lotId: string;
  /** The stay the lot's own pricing was priced for; a "" time = the page's default times. */
  priced: StayOnScreen;
  /** False where checkout would refuse anyway (a direct lot not open for booking). */
  enabled: boolean;
}

export type LivePricePlan =
  | { kind: "as_loaded" }
  | { kind: "needs_times" }
  /** `key` identifies the stay, so an answer for an older stay is never shown. */
  | { kind: "fetch"; key: string; query: string };

/** Pure: what to show without a network call, or which quote to fetch. */
export function planLivePrice(i: LivePriceInput): LivePricePlan {
  const timesChosen = i.checkInTime !== "" && i.checkOutTime !== "";
  const datesChanged = i.checkIn !== i.priced.checkIn || i.checkOut !== i.priced.checkOut;
  if (!timesChosen || !i.enabled || i.checkIn === "" || i.checkOut === "") {
    return datesChanged ? { kind: "needs_times" } : { kind: "as_loaded" };
  }
  const sameAsLoaded =
    !datesChanged && i.checkInTime === i.priced.checkInTime && i.checkOutTime === i.priced.checkOutTime;
  if (sameAsLoaded) return { kind: "as_loaded" };
  const query = new URLSearchParams({
    lotId: i.lotId,
    checkin: i.checkIn,
    checkout: i.checkOut,
    checkinTime: i.checkInTime,
    checkoutTime: i.checkOutTime,
  }).toString();
  return { kind: "fetch", key: query, query };
}

/** Pure: a GET /api/checkout/lot answer → what to show. Never the old window's total. */
export function settleQuote(ok: boolean, body: { costData?: CheckoutCostData | null } | null): Settled {
  if (!ok || !body?.costData) return { kind: "error" };
  if (body.costData.soldOut) return { kind: "sold_out" };
  const view = priceViewFromCost(body.costData);
  return view ? { kind: "ready", view } : { kind: "error" };
}

export function useLivePrice(input: LivePriceInput): LivePrice {
  const plan = planLivePrice(input);
  const key = plan.kind === "fetch" ? plan.key : null;
  const [settled, setSettled] = useState<{ key: string; price: Settled } | null>(null);

  useEffect(() => {
    if (!key) return;
    const controller = new AbortController();
    // The route captures its own failures (ResLab errors, 5xx) in Sentry; here
    // a failure only means "no figure".
    fetch(`/api/checkout/lot?${key}`, { signal: controller.signal, cache: "no-store" })
      .then(async (res) => settleQuote(res.ok, await res.json().catch(() => null)))
      .catch((): Settled => ({ kind: "error" }))
      .then((price) => {
        // A superseded request is aborted; its late answer must never land.
        if (!controller.signal.aborted) setSettled({ key, price });
      });
    return () => controller.abort();
  }, [key]);

  if (plan.kind !== "fetch") return plan;
  return settled && settled.key === plan.key ? settled.price : { kind: "loading" };
}
