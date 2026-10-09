/**
 * Oversized-vehicle size codes for direct lots (CMS `Lots.vehicleSurcharges`).
 * Browser-safe: no imports. Keep in step with the CMS validators
 * (triply-cms/src/collections/Lots.ts) and the CHECKs in migration 036.
 */
export const VEHICLE_SIZE_CODE_RE = /^[a-z0-9_]{1,32}$/;
/** "No oversized vehicle" — always offered, never stored as a CMS row. */
export const NO_OVERSIZED_VEHICLE = "none";
export const MAX_VEHICLE_SURCHARGES = 6;
/** Where the customer made the final choice (bookings.vehicle_size_source). */
export const VEHICLE_SIZE_SOURCES = ["modal", "checkout"] as const;
export type VehicleSizeSource = (typeof VEHICLE_SIZE_SOURCES)[number];
