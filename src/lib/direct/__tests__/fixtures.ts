/**
 * A `public.direct_lots()` row (migration 035) for The Parking Point JFK,
 * shared by the adapter / search-merge / getLotById tests. store.test.ts keeps
 * its own copy on purpose: that file pins the row's keys against
 * DIRECT_LOT_ROW_KEYS, and a shared fixture would let both drift together.
 */
export function directLotRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    name: "The Parking Point JFK",
    slug: "the-parking-point-jfk",
    airport_code: "JFK",
    reslab_location_id: null,
    description_short: "Fenced 24-hour lot",
    content: null,
    seo_meta_title: null,
    seo_meta_description: null,
    featured_image_url: "/api/media/file/shuttles.webp",
    featured_image_alt: "Shuttles",
    gallery_urls: ["/api/media/file/lot.webp", "/api/media/file/shuttles.webp", null],
    distance_to_terminal_minutes: 10,
    shuttle_details: "Every 15–20 min, 24/7",
    shuttle_phone: "+1 (347) 960-7065",
    address_street: "150-57 183rd St",
    address_city: "Springfield Gardens",
    address_state: "NY",
    address_zip: "11413",
    lat: 40.6568,
    lng: -73.7644,
    booking_instructions: {
      beforeArrival: null,
      whenYouArrive: "Show your confirmation at the booth",
      importantNotes: "No oversized vehicles",
      whenYouReturn: null,
      gettingToAirport: "Shuttle runs 24/7",
    },
    faqs: [],
    amenities: [{ id: 1, name: "Shuttle", icon: "bus" }],
    is_active: true,
    visibility: "staging_only",
    min_stay_days: 1,
    min_lead_hours: 2,
    base_daily_rate: 9.95,
    tax_rate_percent: 10.375,
    tax_collected_by: "lot",
    partner_share_percent: 80,
    notification_emails: ["tom@triplypro.com"],
    status: "published",
    published_at: null,
    updated_at: "2026-10-05T20:00:00.000Z",
    ...overrides,
  };
}
