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
  dueAtLocation: number;
  dueNow: number;
  numberOfDays?: number;
  soldOut: boolean;
  parkingTypeId?: number | null;
}
