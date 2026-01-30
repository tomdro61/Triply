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
 * Initialize gtag consent with denied state (before user consent)
 */
export function initializeGtagConsent() {
  if (typeof window !== "undefined") {
    window.dataLayer = window.dataLayer || [];
    window.gtag = function gtag(...args: unknown[]) {
      window.dataLayer.push(args);
    };
    window.gtag("consent", "default", {
      analytics_storage: "denied",
      ad_storage: "denied",
      ad_user_data: "denied",
      ad_personalization: "denied",
      wait_for_update: 500,
    });
  }
}

/**
 * Update gtag consent based on user preferences
 */
export function updateGtagConsent(analytics: boolean, marketing: boolean) {
  if (typeof window !== "undefined" && window.gtag) {
    window.gtag("consent", "update", {
      analytics_storage: analytics ? "granted" : "denied",
      ad_storage: marketing ? "granted" : "denied",
      ad_user_data: marketing ? "granted" : "denied",
      ad_personalization: marketing ? "granted" : "denied",
    });
  }
}

/**
 * Track a search event
 */
export function trackSearch(params: {
  airport: string;
  checkin: string;
  checkout: string;
}) {
  if (typeof window !== "undefined" && window.gtag) {
    window.gtag("event", "search", {
      search_term: params.airport,
      checkin_date: params.checkin,
      checkout_date: params.checkout,
    });
  }
}

/**
 * Track lot view event
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
 * Track purchase event
 */
export function trackPurchase(booking: {
  confirmationNumber: string;
  lotId: string;
  lotName: string;
  grandTotal: number;
}) {
  if (typeof window !== "undefined" && window.gtag) {
    window.gtag("event", "purchase", {
      transaction_id: booking.confirmationNumber,
      value: booking.grandTotal,
      currency: "USD",
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
