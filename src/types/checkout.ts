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

export interface CheckoutData {
  customer: CustomerDetails;
  vehicle: VehicleDetails;
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
  total: number;
}
