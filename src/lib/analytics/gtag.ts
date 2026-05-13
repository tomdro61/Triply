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
 */
export function trackNewsletterSignup() {
  if (typeof window !== "undefined" && window.gtag) {
    window.gtag("event", "generate_lead", {
      lead_type: "newsletter",
    });
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
 * Track AI chat first interaction
 */
export function trackChatStart() {
  if (typeof window !== "undefined" && window.gtag) {
    window.gtag("event", "chat_start");
  }
}
