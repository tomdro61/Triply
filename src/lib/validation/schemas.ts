import { z } from "zod";

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
  fromDate: z.string().min(1),
  toDate: z.string().min(1),
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
});

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
