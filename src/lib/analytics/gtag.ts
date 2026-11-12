/**
 * Google Analytics 4 Helper Functions
 *
 * These functions help track events and manage GA4 consent.
 */

import { captureBookingError } from "@/lib/sentry";
import { buildSearchEventParams, type SearchEventInput } from "@/lib/analytics/search-event";

declare global {
  interface Window {
    gtag: (...args: unknown[]) => void;
    dataLayer: unknown[];
  }
}

/**
 * Revoke analytics consent (user opted out)
 */
export function revokeAnalyticsConsent() {
  if (typeof window !== "undefined" && window.gtag) {
    window.gtag("consent", "update", {
      analytics_storage: "denied",
    });
  }
}

/**
 * Restore analytics consent (user opted back in)
 */
export function grantAnalyticsConsent() {
  if (typeof window !== "undefined" && window.gtag) {
    window.gtag("consent", "update", {
      analytics_storage: "granted",
    });
  }
}

/**
 * Fire-and-forget: a failing analytics call must never break a search, a lot
 * panel or a checkout step. Used by search, select_item, view_item,
 * begin_checkout, add_payment_info and every checkout_* event. (purchase has
 * its own handling: it reports a failure to Sentry.)
 */
function safeEvent(name: string, params: Record<string, unknown>) {
  if (typeof window === "undefined" || !window.gtag) return;
  try {
    window.gtag("event", name, params);
  } catch {
    // Deliberately ignored: analytics only.
  }
}

// ── The booking funnel's standard events ─────────────────────────────────────
// search → select_item → view_item → begin_checkout → add_payment_info → purchase
//
//   search          one per search ATTEMPT, with how it ended and what was
//                   shown (src/lib/analytics/search-event.ts)
//   select_item     a lot was picked from the results. item_list_name:
//                   "search_results" (list card) or "search_map" (map pin or
//                   mobile map card)
//   view_item       a lot's details were shown. item_surface: "search_panel"
//                   (the panel on /search) or "lot_page"
//   begin_checkout  the checkout form was shown with a lot: fires with
//                   checkout_view, under the same conditions, once per page
//                   load (not on a failed, sold-out or lot-less load)
//   add_payment_info  the payment step was reached
//
// What changed on 2026-11-12 (GA4 shows these breaks permanently):
//   - begin_checkout fired at the payment step, beside add_payment_info. For
//     the old series use add_payment_info, which did not change.
//   - view_item fired on the lot page only, with item_id / item_name / price
//     as flat params. It now has an items array (plus currency, item_surface).
//   - select_item fired from the list card only; map picks sent nothing.
//   - search fired on answered searches only; date_error and load_error
//     attempts are new, and sort re-fetches now say so (search_trigger).
//   - checkout_view's `priced` was 0 for every direct lot; it is now 1.
//
// Prices: select_item / view_item carry pricing.minPrice, the lot's pre-tax
// per-day rate without the service fee. begin_checkout carries the stay's
// online total at load (grand total + service fee; no Park Guard, promo or
// at-lot vehicle surcharge, none of which is chosen or charged then).
// add_payment_info and purchase carry the server-verified total.
//
// Event-scoped custom dimensions to register in GA4 for these: item_surface,
// lots_shown, price_band, stay_days, dates_defaulted, search_outcome,
// search_trigger, sort_by (lead_days is shared with checkout_view).

/**
 * A search attempt and what the searcher saw. Builds its own params, so a
 * search event cannot be sent with hand-made ones, and never throws: it is
 * called from inside the search page's fetch, where a throw would replace good
 * results with the error panel.
 */
export function trackSearch(input: SearchEventInput) {
  try {
    safeEvent("search", buildSearchEventParams(input));
  } catch {
    // Analytics only.
  }
}

/** A lot's details were shown, on the search panel or the full lot page. */
export function trackLotView(lot: {
  id: string;
  name: string;
  /** pricing.minPrice: the pre-tax per-day rate, without the service fee. */
  price?: number;
  surface: "search_panel" | "lot_page";
}) {
  safeEvent("view_item", {
    currency: "USD",
    items: [{ item_id: lot.id, item_name: lot.name, price: lot.price }],
    item_surface: lot.surface,
  });
}

/** A lot was picked from the search results. */
export function trackSelectItem(lot: {
  id: string;
  name: string;
  price?: number;
  airport?: string;
  /** Which list it was picked from. */
  list: "search_results" | "search_map";
  /** 0-based place in the results as sorted on screen. */
  position?: number;
}) {
  safeEvent("select_item", {
    item_list_name: lot.list,
    items: [
      {
        item_id: lot.id,
        item_name: lot.name,
        price: lot.price,
        index: lot.position,
      },
    ],
    airport_code: lot.airport,
  });
}

/**
 * The checkout form was shown with a lot (fires with checkout_view). `total`
 * is the online total at load (checkoutLoadValue, checkout-funnel.ts); omitted
 * when the load is not priced, never a made-up figure.
 */
export function trackBeginCheckout(booking: {
  lotId: string;
  lotName: string;
  total?: number;
}) {
  safeEvent("begin_checkout", {
    ...(booking.total !== undefined && { value: booking.total, currency: "USD" }),
    items: [
      {
        item_id: booking.lotId,
        item_name: booking.lotName,
        price: booking.total,
      },
    ],
  });
}

/**
 * Track payment step reached in checkout
 */
export function trackAddPaymentInfo(booking: {
  lotId: string;
  lotName: string;
  total: number;
}) {
  // Through safeEvent: this runs inside the PaymentIntent try, where a throw
  // would show "Payment Error" on a payment that was set up fine.
  safeEvent("add_payment_info", {
    value: booking.total,
    currency: "USD",
    items: [
      {
        item_id: booking.lotId,
        item_name: booking.lotName,
        price: booking.total,
      },
    ],
  });
}

/**
 * Track purchase event
 */
export function trackPurchase(booking: {
  confirmationNumber: string;
  lotId: string;
  lotName: string;
  /** The booking's total BEFORE the promo discount (purchasePromo's grossTotal). */
  grandTotal: number;
  serviceFee?: number;
  /** Park Guard pass-through; Triply earns no commission on this. */
  protectionPlanPrice?: number;
  airportCode?: string;
  /** The promo discount (Triply funds it on a ResLab booking); 0 / absent with no code. */
  promoDiscount?: number;
  /** The code's family (promoCouponFamily) — never a per-person WELCOME code. */
  coupon?: string | null;
}) {
  if (typeof window !== "undefined" && window.gtag) {
    // Defensive: any of these arriving as NaN/undefined would emit "NaN"
    // strings into GA4 and silently corrupt revenue analytics.
    const grandTotal = Number.isFinite(booking.grandTotal) ? booking.grandTotal : 0;
    const serviceFee = Number.isFinite(booking.serviceFee) ? (booking.serviceFee || 0) : 0;
    // If the price is supplied but non-finite (NaN, Infinity) we'd silently
    // count $0 commission against a non-zero pass-through — under-report PG
    // revenue across the whole funnel. Alert ops before coercing.
    if (booking.protectionPlanPrice !== undefined && !Number.isFinite(booking.protectionPlanPrice)) {
      captureBookingError(
        new Error(
          `trackPurchase received non-finite protectionPlanPrice (${booking.protectionPlanPrice}) — coercing to 0; GA4 revenue would otherwise be poisoned`
        ),
        { step: "confirmation", confirmationNumber: booking.confirmationNumber }
      );
    }
    const protectionPlanPrice = Number.isFinite(booking.protectionPlanPrice)
      ? (booking.protectionPlanPrice || 0)
      : 0;
    const discount = Number.isFinite(booking.promoDiscount) ? Math.max(0, booking.promoDiscount || 0) : 0;
    // The value is what the booking was worth after the code (promo plan D3).
    const value = +(grandTotal - discount).toFixed(2);
    // Commission base excludes the Park Guard premium (pass-through to a
    // third party) AND the Triply service fee (already broken out below). The
    // promo discount is Triply's cost, so it comes off the commission estimate
    // itself, not off the base it is a percentage of.
    const commissionBase = Math.max(0, grandTotal - serviceFee - protectionPlanPrice);
    window.gtag("event", "purchase", {
      transaction_id: booking.confirmationNumber,
      value,
      currency: "USD",
      ...(booking.coupon && { coupon: booking.coupon }),
      triply_commission: +(commissionBase * 0.15 - discount).toFixed(2),
      triply_service_fee: serviceFee,
      protection_plan_price: protectionPlanPrice,
      airport_code: booking.airportCode,
      items: [
        {
          item_id: booking.lotId,
          item_name: booking.lotName,
          price: value,
          ...(discount > 0 && { discount }),
          ...(booking.coupon && { coupon: booking.coupon }),
        },
      ],
    });
  }
}

/**
 * Track account creation
 */
export function trackSignUp(method: "email" | "google") {
  if (typeof window !== "undefined" && window.gtag) {
    window.gtag("event", "sign_up", { method });
  }
}

/**
 * Track user login
 */
export function trackLogin(method: "email" | "google") {
  if (typeof window !== "undefined" && window.gtag) {
    window.gtag("event", "login", { method });
  }
}

/**
 * Track newsletter signup
 *
 * Optional opts let a caller say WHERE the signup came from (e.g. the
 * end-of-article capture on the blog) and which airport the page was about,
 * so leads can be attributed in GA4. Called with no arguments the event is
 * byte-for-byte what it was before.
 */
export function trackNewsletterSignup(opts?: {
  source?: string;
  airportCode?: string | null;
}) {
  if (typeof window !== "undefined" && window.gtag) {
    const params: Record<string, string> = {
      lead_type: "newsletter",
    };
    if (opts?.source) params.lead_source = opts.source;
    if (opts?.airportCode) params.airport_code = opts.airportCode;

    window.gtag("event", "generate_lead", params);
  }
}

// v2: the key used to embed the raw lowercased email. It is now a digest —
// see markAndShouldTrackNewsletterSignup. The version bump means a browser
// carrying a v1 key simply fires once more, rather than reading a key format
// that no longer exists.
const NEWSLETTER_SIGNUP_TRACKED_KEY_PREFIX = "triply_newsletter_signup_tracked_v2:";

// Re-fire after this long. A dedup key with no expiry is a permanent record
// of "someone signed up from this browser", which is more than a marketing
// counter needs; six months is well past the point where a repeat signup is
// worth counting again.
const NEWSLETTER_SIGNUP_TRACKED_TTL_MS = 180 * 24 * 60 * 60 * 1000;

/**
 * FNV-1a, twice with different seeds, concatenated — 64 bits of non-reversible
 * digest for a dedup key.
 *
 * Deliberately NOT crypto.subtle: that is async and this runs inline in a
 * submit handler. This is not a security control (an attacker with the
 * browser's localStorage could brute-force a known address either way); it
 * exists so the key is not a plaintext email address sitting in storage for a
 * marketing counter's benefit.
 */
function newsletterSignupDigest(value: string): string {
  const round = (seed: number, input: string): string => {
    let h = seed;
    for (let i = 0; i < input.length; i++) {
      h ^= input.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
  };
  return round(0x811c9dc5, value) + round(0x9e3779b9, `${value}|triply`);
}

/**
 * Per-browser dedup guard for the newsletter's generate_lead event.
 *
 * PR #23 pass 4: /api/newsletter's response no longer distinguishes a new
 * subscriber from an already-subscribed one — that distinction was an
 * enumeration oracle to an unauthenticated caller (Sentry review, pass 3/4).
 * The client can no longer read `alreadySubscribed` off the response to
 * decide whether to fire trackNewsletterSignup, so this substitutes a
 * localStorage guard keyed on a DIGEST of the lowercased email: fires once
 * per email per browser, per TTL.
 *
 * Pass-5 review: the key used to be the raw email, written on every submit
 * regardless of consent — a plaintext address parked in storage forever for
 * the sake of a counter. It is now hashed, expires, and is not written at all
 * until GA is actually loaded.
 *
 * Trade-off, accepted: a resubmit of the same email from a DIFFERENT browser
 * or device still double-counts — this is a marketing metric (generate_lead
 * volume), not a security or billing control, so an occasional inflated
 * count is fine. Wrapped in try/catch because localStorage can throw
 * (private browsing, storage disabled, quota) — on failure this fires the
 * event rather than risk silently dropping a real lead.
 */
export function markAndShouldTrackNewsletterSignup(email: string): boolean {
  // No gtag means GA is not configured, not loaded yet, or blocked. Nothing
  // will be sent, so nothing should be written down either — and returning
  // true keeps a later submit of the same address able to fire exactly once.
  if (typeof window === "undefined" || !window.gtag) return true;

  const key = `${NEWSLETTER_SIGNUP_TRACKED_KEY_PREFIX}${newsletterSignupDigest(
    email.trim().toLowerCase()
  )}`;
  try {
    const seenAt = Number(window.localStorage.getItem(key));
    if (seenAt && Date.now() - seenAt < NEWSLETTER_SIGNUP_TRACKED_TTL_MS) return false;
    window.localStorage.setItem(key, String(Date.now()));
    return true;
  } catch {
    return true;
  }
}

/**
 * Track contact form submission
 */
export function trackContactFormSubmit() {
  if (typeof window !== "undefined" && window.gtag) {
    window.gtag("event", "generate_lead", {
      lead_type: "contact_form",
    });
  }
}

/**
 * Track a lot-operator inquiry sent from /partners. Same `generate_lead`
 * event as the contact form, with its own lead_type so supply leads can be
 * counted apart from customer messages.
 */
export function trackPartnerInquirySubmit(airportCode: string) {
  if (typeof window !== "undefined" && window.gtag) {
    window.gtag("event", "generate_lead", {
      lead_type: "partner_inquiry",
      airport_code: airportCode,
    });
  }
}

/**
 * Track a click on a blog article's booking CTA, or a search submitted from
 * the booking widget at the top of an article — the two ways a blog reader
 * can head toward checkout.
 */
export function trackBlogCtaClick(params: {
  /** Empty string when the article/reader hasn't picked an airport we sell. */
  airportCode: string;
  placement: "top-widget" | "mid-article" | "end-of-article" | "end-of-article-inline";
}) {
  if (typeof window !== "undefined" && window.gtag) {
    window.gtag("event", "blog_cta_click", {
      airport_code: params.airportCode || undefined,
      placement: params.placement,
    });
  }
}

/**
 * Track AI chat first interaction
 */
export function trackChatStart() {
  if (typeof window !== "undefined" && window.gtag) {
    window.gtag("event", "chat_start");
  }
}

// ── Checkout funnel (2026-10-06) ────────────────────────────────────────────
// Where the people who open /checkout drop out before the payment step. Keys
// and reason buckets only — see src/lib/analytics/checkout-funnel.ts. Report
// with a GA4 funnel exploration on checkout_open → checkout_view →
// checkout_step_view(details → vehicle → payment); repeat step views from Back
// don't distort it because funnels count users. Breakdowns need the event-
// scoped custom dimensions checkout_step, checkout_fields, checkout_reason,
// lead_days registered in GA4.

/** /checkout mounted — before its data loads (the load waits on ResLab). */
export function trackCheckoutOpen() {
  safeEvent("checkout_open", {});
}

/** The checkout form rendered with a loaded lot. */
export function trackCheckoutView(params: {
  lotId: string;
  leadDays: number | null;
  loadMs: number;
  /** 0 when the load fell back to estimated pricing (ResLab cost call failed)
   *  — those visitors then fail at "Continue to Payment"; keep them separable.
   *  isPricedLoad (checkout-funnel.ts): a direct lot is priced by its own
   *  terms and reports 1 (it reported 0 before 2026-11-12). */
  priced: 0 | 1;
}) {
  safeEvent("checkout_view", {
    lot_id: params.lotId,
    lead_days: params.leadDays ?? undefined,
    load_ms: params.loadMs,
    priced: params.priced,
  });
}

/** /checkout couldn't show the form (error, sold out, no lot, missing times). */
export function trackCheckoutLoadFailed(params: { reason: string; status?: number; loadMs: number }) {
  safeEvent("checkout_load_failed", {
    checkout_reason: params.reason,
    http_status: params.status,
    load_ms: params.loadMs,
  });
}

export function trackCheckoutStepView(step: string) {
  safeEvent("checkout_step_view", { checkout_step: step });
}

/** `source`: "browser" = native required/type checks; "form" = our validators. */
export function trackCheckoutValidationError(params: {
  step: string;
  fields: string;
  source: "browser" | "form";
}) {
  if (!params.fields) return;
  safeEvent("checkout_validation_error", {
    checkout_step: params.step,
    checkout_fields: params.fields,
    validation_source: params.source,
  });
}

/** "Continue to Payment" failed to create the PaymentIntent. */
export function trackCheckoutPaymentInitFailed(params: { reason: string; status?: number }) {
  safeEvent("checkout_payment_init_failed", {
    checkout_reason: params.reason,
    http_status: params.status,
  });
}

export function trackCheckoutBack(fromStep: string) {
  safeEvent("checkout_back", { checkout_step: fromStep });
}

/**
 * The first form field a checkout visitor types into or picks (autofill
 * counts), once per checkout load (2026-11-02; focus would also count the
 * browser's own jump to an empty required field). Splits the details-step
 * drop (the biggest leak: −41%) into
 * people who never touched the form — browsing, price-checking — and people
 * who started typing and quit. Field KEY only, never what was typed.
 */
export function trackCheckoutFirstField(params: { step: string; field: string }) {
  safeEvent("checkout_first_field", {
    checkout_step: params.step,
    checkout_fields: params.field,
  });
}

/**
 * A drop-off or pick-up time picked on a lot page or the search slider
 * (2026-11-02). Shows how often visitors move off the default times before
 * booking, and to what — times are a "clock time" choice (e.g. "6:30 AM"),
 * never personal data.
 */
export function trackBookingTimeChange(params: {
  surface: "lot_page" | "search_slider";
  which: "checkin" | "checkout";
  time: string;
}) {
  safeEvent("booking_time_change", {
    time_surface: params.surface,
    time_which: params.which,
    time_value: params.time,
  });
}

/**
 * Track a post-trip review submitted from /review/[token] (the optional form,
 * not the bare star tap). rating 1–5; airport_code only when it is an airport
 * we sell.
 */
export function trackReviewSubmitted(params: { rating: number; airportCode: string | null }) {
  if (typeof window !== "undefined" && window.gtag) {
    window.gtag("event", "review_submitted", {
      rating: params.rating,
      airport_code: params.airportCode || undefined,
    });
  }
}
