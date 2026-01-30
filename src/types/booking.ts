export interface Vehicle {
  id?: string;
  vehicleType: string;
  make?: string;
  model?: string;
  licensePlate: string;
  color?: string;
}

export interface Customer {
  email: string;
  firstName: string;
  lastName: string;
  phone?: string;
}

export interface BookingPricing {
  subtotal: number;
  taxes: number;
  serviceFee: number;
  discount: number;
  promoCode?: string;
  grandTotal: number;
  currency: string;
}

export interface BookingDraft {
  lotId: string;
  lotName: string;
  lotAddress: string;
  airportCode: string;
  parkingTypeId: number;
  parkingTypeName: string;

  checkinDate: string;
  checkoutDate: string;

  customer: Customer;
  vehicles: Vehicle[];

  pricing: BookingPricing;

  createAccount?: boolean;
  password?: string;
}

export interface Booking {
  id: string;
  confirmationNumber: string;

  inventorySource: "reslab" | "direct";
  reslabReservationNumber?: string;

  lotId: string;
  lotName: string;
  lotAddress: string;
  airportCode: string;

  customer: Customer;
  vehicles: Vehicle[];

  checkinDate: string;
  checkoutDate: string;
  parkingType?: string;

  pricing: BookingPricing;

  stripePaymentIntentId?: string;
  paymentStatus: "pending" | "succeeded" | "failed" | "refunded";

  status: "confirmed" | "cancelled" | "completed";
  cancelledAt?: string;
  refundAmount?: number;

  createdAt: string;
  updatedAt: string;
}

export interface BookingConfirmation {
  confirmationNumber: string;
  lotName: string;
  lotAddress: string;
  lotPhone?: string;
  checkinDate: string;
  checkoutDate: string;
  parkingType: string;
  grandTotal: number;
  customerName: string;
  customerEmail: string;
  vehicles: Vehicle[];
  shuttleInfo?: string;
  directions?: string;
  qrCodeUrl?: string;
}
