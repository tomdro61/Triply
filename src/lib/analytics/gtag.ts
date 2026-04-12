/**
 * Google Analytics 4 Helper Functions
 *
 * These functions help track events and manage GA4 consent.
 */

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
  airportCode?: string;
}) {
  if (typeof window !== "undefined" && window.gtag) {
    window.gtag("event", "purchase", {
      transaction_id: booking.confirmationNumber,
      value: booking.grandTotal,
      currency: "USD",
      triply_commission: +(booking.grandTotal * 0.15).toFixed(2),
      triply_service_fee: booking.serviceFee || 0,
      airport_code: booking.airportCode,
      items: [
        {
          item_id: booking.lotId,
          item_name: booking.lotName,
          price: booking.grandTotal,
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
