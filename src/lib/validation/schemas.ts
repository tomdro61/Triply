import { z } from "zod";
import { PROTECTION_PLAN_CODES } from "@/lib/parkguard/plans";

/**
 * Park Guard tier on the wire: "A" | "B" | "C", or an explicit null when the
 * customer declined. Used by the checkout PI create/update routes and the
 * reservation + pending-booking payloads. Built from the same tuple that
 * defines `ProtectionPlanCode` (plans.ts is env-free), so the schema and the
 * type cannot drift in either direction.
 */
export const protectionPlanCodeSchema = z.enum(PROTECTION_PLAN_CODES).nullable();

export const contactFormSchema = z.object({
  name: z.string().min(1, "Name is required").max(200),
  email: z.string().email("Invalid email address").max(254),
  subject: z.string().min(1, "Subject is required").max(500),
  message: z.string().min(1, "Message is required").max(5000),
});

export const paymentIntentSchema = z.object({
  amount: z.number().positive("Amount must be positive").max(100000),
  lotName: z.string().min(1).max(500),
  lotId: z.string().min(1).max(100),
  checkIn: z.string().min(1),
  checkOut: z.string().min(1),
  customerEmail: z.string().email(),
});

export const reservationSchema = z.object({
  locationId: z.number().int().positive(),
  costsToken: z.string().min(1),
  fromDate: z.string().regex(
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
    "fromDate must be in 'YYYY-MM-DD HH:mm:ss' format with a time selected"
  ),
  toDate: z.string().regex(
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
    "toDate must be in 'YYYY-MM-DD HH:mm:ss' format with a time selected"
  ),
  parkingTypeId: z.number().int().positive(),
  customer: z.object({
    firstName: z.string().min(1).max(100),
    lastName: z.string().min(1).max(100),
    email: z.string().email().max(254),
    phone: z.string().min(1).max(30),
  }),
  vehicle: z.object({
    make: z.string().min(1).max(100),
    model: z.string().min(1).max(100),
    color: z.string().min(1).max(50),
    licensePlate: z.string().min(1).max(20),
    state: z.string().min(1).max(5),
  }),
  extraFields: z.record(z.string(), z.string()).optional(),
  locationName: z.string().max(500).optional(),
  locationAddress: z.string().max(500).optional(),
  airportCode: z.string().max(10).optional(),
  subtotal: z.number().optional(),
  taxTotal: z.number().optional(),
  feesTotal: z.number().optional(),
  grandTotal: z.number().optional(),
  triplyServiceFee: z.number().optional(),
  userId: z.string().nullable().optional(),
  stripePaymentIntentId: z.string().optional(),
  // Required KEY, nullable VALUE: "A" | "B" | "C" is the Park Guard tier the
  // customer picked, null means they explicitly declined. Deliberately not
  // `.optional()` — an omitted key must fail validation, otherwise a client
  // that's been opted in could slip past the PaymentIntent-metadata cross-check
  // without paying. The pending route re-derives the tier from PI metadata and
  // rejects a mismatch; it never trusts this value for money.
  protectionPlanCode: protectionPlanCodeSchema,
});

/**
 * Payload staged to `pending_bookings` immediately BEFORE the customer confirms
 * payment, so the booking can be completed server-side even if the browser never
 * comes back (a 3-D Secure redirect, a BNPL redirect, a crash, a closed tab).
 *
 * Identical to reservationSchema except `stripePaymentIntentId` is REQUIRED —
 * the PaymentIntent id is the row's primary key and the mutex every fulfilment
 * path claims. A pending row without one is unreachable and therefore useless.
 */
export const pendingBookingSchema = reservationSchema.extend({
  stripePaymentIntentId: z.string().min(1, "stripePaymentIntentId is required"),
  /** Query params needed to rebuild the customer's /confirmation URL on the
   *  redirect-return path, where the original client state is long gone. */
  confirmationParams: z.record(z.string(), z.string()).optional(),
});

export type ReservationInput = z.infer<typeof reservationSchema>;
export type PendingBookingInput = z.infer<typeof pendingBookingSchema>;

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
