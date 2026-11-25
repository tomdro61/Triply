import { z } from "zod";
import { parseMoneyColumn } from "@/lib/utils/money";

/**
 * The booking a support ticket is about, shaped for the ticket panel on
 * /admin/support so the team can answer without opening /admin/bookings.
 * Admin-only (the route checks ADMIN_EMAILS); never sent to a customer.
 */

/**
 * The bookings columns the support panel reads (plus the customer join).
 * NOT the staff cancellation note: it lives in `booking_cancellation_notes`
 * (migration 032), service-role only, because customers can read every column
 * of their own bookings row. The route reads it separately.
 */
export const SUPPORT_BOOKING_COLUMNS =
  "id, reslab_reservation_number, status, inventory_source, location_name, location_address, airport_code, check_in, check_out, subtotal, grand_total, triply_service_fee, due_at_location, discount_amount, promo_code, protection_plan, protection_plan_price, vehicle_info, vehicle_size_label, vehicle_surcharge_cents, vehicle_surcharge_tax_cents, cancellation_reason, cancelled_by, created_at, customers(email, first_name, last_name, phone)";

type Money = string | number | null | undefined;

export interface SupportBookingRow {
  id: string;
  reslab_reservation_number: string;
  status: string | null;
  inventory_source?: string | null;
  location_name: string;
  location_address?: string | null;
  airport_code?: string | null;
  check_in: string;
  check_out: string;
  subtotal?: Money;
  grand_total?: Money;
  triply_service_fee?: Money;
  due_at_location?: Money;
  discount_amount?: Money;
  promo_code?: string | null;
  protection_plan?: string | null;
  protection_plan_price?: Money;
  vehicle_info?: {
    make?: string | null;
    model?: string | null;
    color?: string | null;
    licensePlate?: string | null;
    state?: string | null;
  } | null;
  vehicle_size_label?: string | null;
  vehicle_surcharge_cents?: number | null;
  vehicle_surcharge_tax_cents?: number | null;
  cancellation_reason?: string | null;
  cancelled_by?: string | null;
  /** TIMESTAMPTZ DEFAULT now(), but nullable in migration 001. */
  created_at: string | null;
  customers?:
    | { email: string | null; first_name: string | null; last_name: string | null; phone: string | null }
    | Array<{ email: string | null; first_name: string | null; last_name: string | null; phone: string | null }>
    | null;
}

export interface SupportBookingDetails {
  id: string;
  reservationNumber: string;
  status: string | null;
  inventorySource: "direct" | "reslab";
  locationName: string;
  locationAddress: string | null;
  airportCode: string | null;
  checkIn: string;
  checkOut: string;
  customer: { name: string; email: string | null; phone: string | null };
  /** True when the booking's customer email equals the ticket's (case-insensitive). */
  emailMatchesTicket: boolean;
  vehicle: { description: string | null; plate: string | null; sizeLabel: string | null };
  money: {
    /**
     * What Stripe charged: the same sum the Bookings modal shows as "Paid
     * online". null when grand_total is missing or unreadable, or the sum
     * comes out negative: the panel says "not recorded" instead of a
     * believable $0.00.
     */
    paidOnline: number | null;
    dueAtLocation: number;
    /** Direct lots only: the oversized-vehicle estimate paid AT THE LOT. */
    atLotEstimate: number;
    discount: number;
    promoCode: string | null;
  };
  /** price null = not recorded on the row (the modal's "Price not recorded"). */
  protection: { plan: string; price: number | null } | null;
  /** Set only when the booking is cancelled or refunded (the modal's rule). */
  cancellation: {
    reason: string | null;
    /** null = none, or unavailable (see noteUnavailable). */
    note: string | null;
    /** The notes table couldn't be read: say so rather than imply "no note". */
    noteUnavailable: boolean;
    by: string | null;
  } | null;
  bookedAt: string | null;
}

const clean = (v: string | null | undefined): string | null => {
  const t = (v ?? "").trim();
  return t ? t : null;
};

/** A money column that must be present: a finite number, or null (absent / unreadable). */
function strictMoney(v: Money): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string" || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** "cancelled" and "refunded" are both a cancelled booking (a refunding cancel sets "refunded"). */
export function isCancelledStatus(status: string | null): boolean {
  return status === "cancelled" || status === "refunded";
}

export interface CancellationNote {
  note: string | null;
  unavailable: boolean;
}

export function toSupportBookingDetails(
  row: SupportBookingRow,
  ticketEmail: string,
  cancellationNote: CancellationNote = { note: null, unavailable: false }
): SupportBookingDetails {
  const c = Array.isArray(row.customers) ? row.customers[0] ?? null : row.customers ?? null;
  const ownerEmail = clean(c?.email);
  const name = [clean(c?.first_name), clean(c?.last_name)].filter(Boolean).join(" ");

  // "Paid online", exactly as the /admin/bookings modal computes it:
  // grand_total (ResLab parking total, pre-discount) + Triply service fee +
  // protection premium − due at location − promo discount. The optional
  // parts count as 0 when absent (as in the modal); grand_total must be there.
  const serviceFee = parseMoneyColumn(row.triply_service_fee);
  const premium = parseMoneyColumn(row.protection_plan_price);
  const dueAtLocation = parseMoneyColumn(row.due_at_location);
  const discount = parseMoneyColumn(row.discount_amount);
  const grandTotal = strictMoney(row.grand_total);
  const sum = grandTotal === null ? null : grandTotal + serviceFee + premium - dueAtLocation - discount;
  // Round to cents BEFORE the sign check: a true $0.00 booking (100% promo, or
  // all due at the lot) can come out as -4e-16 in floating point.
  const cents = sum === null ? null : Math.round(sum * 100) / 100;
  const paidOnline = cents === null || cents < 0 ? null : cents === 0 ? 0 : cents;
  const direct = row.inventory_source === "direct";
  const atLotEstimate = direct
    ? ((row.vehicle_surcharge_cents ?? 0) + (row.vehicle_surcharge_tax_cents ?? 0)) / 100
    : 0;

  const v = row.vehicle_info ?? null;
  const description = [clean(v?.color), clean(v?.make), clean(v?.model)].filter(Boolean).join(" ") || null;
  const plate = clean(v?.licensePlate) ? [clean(v?.licensePlate), clean(v?.state)].filter(Boolean).join(" · ") : null;

  const plan = clean(row.protection_plan);
  const cancelled = isCancelledStatus(row.status);

  return {
    id: row.id,
    reservationNumber: row.reslab_reservation_number,
    status: row.status,
    inventorySource: direct ? "direct" : "reslab",
    locationName: row.location_name,
    locationAddress: clean(row.location_address),
    airportCode: clean(row.airport_code),
    checkIn: row.check_in,
    checkOut: row.check_out,
    customer: { name: name || "—", email: ownerEmail, phone: clean(c?.phone) },
    emailMatchesTicket: !!ownerEmail && ownerEmail.toLowerCase() === ticketEmail.trim().toLowerCase(),
    vehicle: { description, plate, sizeLabel: clean(row.vehicle_size_label) },
    money: { paidOnline, dueAtLocation, atLotEstimate, discount, promoCode: clean(row.promo_code) },
    protection: plan && plan !== "none" ? { plan, price: strictMoney(row.protection_plan_price) } : null,
    // A reason can be on a booking whose cancel didn't go through (it is
    // written first, cleared best-effort): only a cancelled status counts.
    cancellation: cancelled
      ? {
          reason: clean(row.cancellation_reason),
          note: clean(cancellationNote.note),
          noteUnavailable: cancellationNote.unavailable,
          by: clean(row.cancelled_by),
        }
      : null,
    bookedAt: row.created_at,
  };
}

/**
 * The route's answer, checked on the client: anything that isn't exactly
 * { booking: SupportBookingDetails | null } is a failure, never "no booking",
 * and never a half-object that crashes the panel while rendering.
 */
const detailsSchema = z.object({
  id: z.string(),
  reservationNumber: z.string(),
  status: z.string().nullable(),
  inventorySource: z.enum(["direct", "reslab"]),
  locationName: z.string(),
  locationAddress: z.string().nullable(),
  airportCode: z.string().nullable(),
  checkIn: z.string(),
  checkOut: z.string(),
  customer: z.object({ name: z.string(), email: z.string().nullable(), phone: z.string().nullable() }),
  emailMatchesTicket: z.boolean(),
  vehicle: z.object({ description: z.string().nullable(), plate: z.string().nullable(), sizeLabel: z.string().nullable() }),
  money: z.object({
    paidOnline: z.number().nullable(),
    dueAtLocation: z.number(),
    atLotEstimate: z.number(),
    discount: z.number(),
    promoCode: z.string().nullable(),
  }),
  protection: z.object({ plan: z.string(), price: z.number().nullable() }).nullable(),
  cancellation: z
    .object({ reason: z.string().nullable(), note: z.string().nullable(), noteUnavailable: z.boolean(), by: z.string().nullable() })
    .nullable(),
  bookedAt: z.string().nullable(),
}) satisfies z.ZodType<SupportBookingDetails>;

// `satisfies` only catches a schema LOOSER than the interface; this also fails
// the build when it is STRICTER (e.g. z.string() for a field that can be null,
// which would reject a real booking at runtime).
type SchemaMatchesInterface = [z.infer<typeof detailsSchema>] extends [SupportBookingDetails]
  ? [SupportBookingDetails] extends [z.infer<typeof detailsSchema>]
    ? true
    : false
  : false;
const schemaMatchesInterface: SchemaMatchesInterface = true;
void schemaMatchesInterface;

const answerSchema = z.object({ booking: detailsSchema.nullable() });

export function parseBookingAnswer(data: unknown): { ok: true; booking: SupportBookingDetails | null } | { ok: false } {
  const parsed = answerSchema.safeParse(data);
  return parsed.success ? { ok: true, booking: parsed.data.booking } : { ok: false };
}

/** What the person at the desk should do, by HTTP status (never the server's bare word). */
export function bookingFailureMessage(status: number): string {
  if (status === 401) return "Your session expired. Sign in again, then reopen the ticket.";
  if (status === 403) return "Only team admins can see bookings here.";
  if (status === 404) return "This ticket no longer exists. Refresh the list.";
  return `Couldn't load the booking (error ${status}). Refresh to try again, or look it up in Bookings.`;
}
