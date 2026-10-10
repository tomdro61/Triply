/**
 * A direct-lot bookings row + v2 lot snapshot, shared by the reservation-view
 * unit tests and the GET /api/reservations/[id] route tests.
 */
export const directSnapshot = {
  v: 2,
  directLotId: "1",
  name: "The Parking Point JFK",
  slug: "the-parking-point-jfk",
  airportCode: "JFK",
  timezone: "America/New_York",
  address: { street: "150-10 Rockaway Blvd", city: "Jamaica", state: "NY", zip: "11434" },
  coordinates: { lat: 40.6681, lng: -73.7914 },
  shuttleDetails: "Free shuttle every 10 minutes",
  shuttlePhone: "(718) 555-0100",
  bookingInstructions: {
    beforeArrival: null,
    whenYouArrive: "Pull up to the booth and show your QR code.",
    importantNotes: "Keys stay with the attendant.",
    whenYouReturn: null,
    gettingToAirport: null,
  },
  visibility: "staging_only",
  rateCents: 995,
  taxRatePercent: 16,
  taxCollectedBy: "triply",
  minStayDays: 1,
  minLeadHours: 2,
};

export function directRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    inventory_source: "direct",
    status: "confirmed",
    direct_lot_id: "1",
    lot_snapshot: directSnapshot,
    subtotal: "29.85",
    tax_total: "4.78",
    fees_total: "0",
    grand_total: "34.63",
    discount_amount: null,
    due_at_location: "0",
    triply_service_fee: "5.95",
    protection_plan: null,
    protection_plan_price: null,
    vehicle_size: "suv",
    vehicle_size_label: "SUV / Van",
    vehicle_surcharge_cents: 3000,
    vehicle_surcharge_tax_cents: 480,
    vehicle_info: { make: "Honda", model: "Pilot", color: "Black", licensePlate: "ABC1234", state: "NY" },
    customers: { first_name: "Dana", last_name: "Rivera", email: "dana@example.com", phone: "5551234567" },
    ...overrides,
  };
}
