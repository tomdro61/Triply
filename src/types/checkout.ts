export interface CustomerDetails {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
}

export interface VehicleDetails {
  make: string;
  model: string;
  color: string;
  licensePlate: string;
  state: string;
}

export interface ExtraFieldValue {
  fieldId: number;
  fieldName: string;
  value: string;
}

export interface CheckoutData {
  customer: CustomerDetails;
  vehicle: VehicleDetails;
  extraFields?: ExtraFieldValue[];
  promoCode?: string;
  acceptedTerms: boolean;
}

export type CheckoutStep = "details" | "vehicle" | "payment";

export interface PriceBreakdown {
  dailyRate: number;
  days: number;
  subtotal: number;
  discount: number;
  taxes: number;
  fees: number;
  serviceFee: number;
  /** Park Guard parking protection premium when opted in, 0 otherwise. */
  protectionPlan: number;
  total: number;
  dueNow: number;
  dueAtLocation: number;
}

export interface CheckoutCostData {
  costsToken: string | null;
  grandTotal: number;
  subtotal: number;
  taxTotal: number;
  feesTotal: number;
  serviceFee: number;
  dueAtLocation: number;
  dueNow: number;
  numberOfDays?: number;
  soldOut: boolean;
  parkingTypeId?: number | null;
  /** DIRECT lots only: the terms this checkout was priced with (quoteDirectCheckout). */
  direct?: DirectCheckoutTerms;
}

export interface DirectCheckoutTerms {
  /** Billed days (directDays) — the parking AND any vehicle surcharge are billed on these. */
  days: number;
  taxRatePercent: number;
  /** Oversized-vehicle surcharges, PAID AT THE LOT — never part of any online amount above. */
  vehicleSurcharges: { code: string; label: string; dailyRateCents: number }[];
}
