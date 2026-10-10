/**
 * Google Analytics 4 Helper Functions
 *
 * These functions help track events and manage GA4 consent.
 */

import { captureBookingError } from "@/lib/sentry";

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
 * Track a search event
 */
export function trackSearch(params: {
  airportCode: string;
  checkin: string;
  checkout: string;
}) {
  if (typeof window !== "undefined" && window.gtag) {
    window.gtag("event", "search", {
      search_term: params.airportCode,
      airport_code: params.airportCode,
      checkin_date: params.checkin,
      checkout_date: params.checkout,
    });
  }
}

/**
 * Track lot view event (lot detail page)
 */
export function trackLotView(lot: {
  id: string;
  name: string;
  price?: number;
}) {
  if (typeof window !== "undefined" && window.gtag) {
    window.gtag("event", "view_item", {
      item_id: lot.id,
      item_name: lot.name,
      price: lot.price,
    });
  }
}

/**
 * Track lot selection from search results
 */
export function trackSelectItem(lot: {
  id: string;
  name: string;
  price?: number;
  airport?: string;
  position?: number;
}) {
  if (typeof window !== "undefined" && window.gtag) {
    window.gtag("event", "select_item", {
      item_list_name: "search_results",
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
}

/**
 * Track begin checkout event
 */
export function trackBeginCheckout(booking: {
  lotId: string;
  lotName: string;
  total: number;
}) {
  if (typeof window !== "undefined" && window.gtag) {
    window.gtag("event", "begin_checkout", {
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
}

/**
 * Track payment step reached in checkout
 */
export function trackAddPaymentInfo(booking: {
  lotId: string;
  lotName: string;
  total: number;
}) {
  if (typeof window !== "undefined" && window.gtag) {
    window.gtag("event", "add_payment_info", {
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
}

/**
 * Track purchase event
 */
export function trackPurchase(booking: {
  confirmationNumber: string;
  lotId: string;
  lotName: string;
  grandTotal: number;
  serviceFee?: number;
  /** Park Guard pass-through; Triply earns no commission on this. */
  protectionPlanPrice?: number;
  airportCode?: string;
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
    // Commission base excludes the Park Guard premium (pass-through to a
    // third party) AND the Triply service fee (already broken out below).
    const commissionBase = Math.max(0, grandTotal - serviceFee - protectionPlanPrice);
    window.gtag("event", "purchase", {
      transaction_id: booking.confirmationNumber,
      value: grandTotal,
      currency: "USD",
      triply_commission: +(commissionBase * 0.15).toFixed(2),
      triply_service_fee: serviceFee,
      protection_plan_price: protectionPlanPrice,
      airport_code: booking.airportCode,
      items: [
        {
          item_id: booking.lotId,
          item_name: booking.lotName,
          price: grandTotal,
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
 * until GA is actually loaded (i.e. until the cookie banner has been
 * accepted).
 *
 * Trade-off, accepted: a resubmit of the same email from a DIFFERENT browser
 * or device still double-counts — this is a marketing metric (generate_lead
 * volume), not a security or billing control, so an occasional inflated
 * count is fine. Wrapped in try/catch because localStorage can throw
 * (private browsing, storage disabled, quota) — on failure this fires the
 * event rather than risk silently dropping a real lead.
 */
export function markAndShouldTrackNewsletterSignup(email: string): boolean {
  // No gtag means no consent yet (the GA script only loads once the cookie
  // banner is accepted), or analytics is disabled entirely. Nothing will be
  // sent, so nothing should be written down either — and returning true keeps
  // a later, consented submit of the same address able to fire exactly once.
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

/** Fire-and-forget: analytics must never be able to break a checkout step. */
function sendCheckoutEvent(name: string, params: Record<string, string | number | undefined>) {
  if (typeof window === "undefined" || !window.gtag) return;
  try {
    window.gtag("event", name, params);
  } catch {
    // Deliberately ignored: a failing analytics call is not a checkout error.
  }
}

/** /checkout mounted — before its data loads (the load waits on ResLab). */
export function trackCheckoutOpen() {
  sendCheckoutEvent("checkout_open", {});
}

/** The checkout form rendered with a loaded lot. */
export function trackCheckoutView(params: {
  lotId: string;
  leadDays: number | null;
  loadMs: number;
  /** 0 when the load fell back to estimated pricing (ResLab cost call failed)
   *  — those visitors then fail at "Continue to Payment"; keep them separable. */
  priced: 0 | 1;
}) {
  sendCheckoutEvent("checkout_view", {
    lot_id: params.lotId,
    lead_days: params.leadDays ?? undefined,
    load_ms: params.loadMs,
    priced: params.priced,
  });
}

/** /checkout couldn't show the form (error, sold out, no lot, missing times). */
export function trackCheckoutLoadFailed(params: { reason: string; status?: number; loadMs: number }) {
  sendCheckoutEvent("checkout_load_failed", {
    checkout_reason: params.reason,
    http_status: params.status,
    load_ms: params.loadMs,
  });
}

export function trackCheckoutStepView(step: string) {
  sendCheckoutEvent("checkout_step_view", { checkout_step: step });
}

/** `source`: "browser" = native required/type checks; "form" = our validators. */
export function trackCheckoutValidationError(params: {
  step: string;
  fields: string;
  source: "browser" | "form";
}) {
  if (!params.fields) return;
  sendCheckoutEvent("checkout_validation_error", {
    checkout_step: params.step,
    checkout_fields: params.fields,
    validation_source: params.source,
  });
}

/** "Continue to Payment" failed to create the PaymentIntent. */
export function trackCheckoutPaymentInitFailed(params: { reason: string; status?: number }) {
  sendCheckoutEvent("checkout_payment_init_failed", {
    checkout_reason: params.reason,
    http_status: params.status,
  });
}

export function trackCheckoutBack(fromStep: string) {
  sendCheckoutEvent("checkout_back", { checkout_step: fromStep });
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
