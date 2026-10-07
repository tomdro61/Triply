/**
 * ResLab lots name their vehicle "extra fields" inconsistently. Most use
 * `car_make` / `license_plate`; some (e.g. Southwestern Airport Parking, BNA,
 * location 471) use `vehicle_make` / `license_plate_number`. Our checkout
 * always collects make / model / color / plate / state once, in the vehicle
 * step, and fulfilment sends them under the common names — so a lot that
 * expects a different name gets an EMPTY field and rejects the reservation
 * with "Validation error" AFTER the card is authorised (2026-09-25, two
 * attempts, $51, customer lost; auth released, never charged).
 *
 * This module maps the vehicle step's values onto whatever names the lot
 * actually declares, so the same answer is never asked twice and never sent
 * blank. Pure and env-free: imported by the checkout form ("use client") and
 * by tests.
 */

import type { VehicleDetails } from "@/types/checkout";

type VehicleSource = keyof VehicleDetails | "makemodel";

/**
 * Every extra-field name we treat as "already answered by the vehicle step",
 * mapped to the value it takes. The first six are the names fulfilment sends
 * unconditionally; the rest are lot-specific spellings seen in ResLab data.
 * Add a spelling here when a lot's `extra_fields` shows a new one — never ask
 * the customer to type their plate a second time under a different label.
 *
 * Checked against the live lot list 2026-09-29 (391 lots). Deliberately NOT
 * here: `stateprovince` (Quality Inn BUF) — it could mean the plate's state or
 * the customer's home state, so the customer answers it.
 */
export const VEHICLE_FIELD_SOURCES: Readonly<Record<string, VehicleSource>> = {
  car_make: "make",
  car_model: "model",
  car_makemodel: "makemodel",
  car_color: "color",
  license_plate: "licensePlate",
  license_plate_state: "state",
  // Lot-specific spellings
  vehicle_make: "make",
  vehicle_model: "model",
  vehicle_makemodel: "makemodel",
  car_make_model: "makemodel",
  makemodel_of_car: "makemodel",
  vehicle_color: "color",
  vehicle_colour: "color",
  car_colour: "color",
  make: "make",
  model: "model",
  color: "color",
  colour: "color",
  license_plate_number: "licensePlate",
  license_plate_no: "licensePlate",
  licence_plate: "licensePlate",
  licence_plate_number: "licensePlate",
  plate: "licensePlate",
  plate_number: "licensePlate",
  license_state: "state",
  licence_plate_state: "state",
  plate_state: "state",
  plate_state_eg_co: "state",
  vehicle_state: "state",
};

/** Is this extra field one the vehicle step already answers? */
export function isVehicleFieldName(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(VEHICLE_FIELD_SOURCES, name.trim().toLowerCase());
}

function valueFor(source: VehicleSource, v: VehicleDetails): string {
  if (source === "makemodel") return `${v.make} ${v.model}`.trim();
  return v[source] ?? "";
}

/**
 * For each extra field the LOT declares whose name we recognise as a vehicle
 * field, the vehicle step's value under the lot's own name. Only names the lot
 * declares are emitted — we never spray every alias at ResLab.
 */
export function vehicleFieldAliasValues(
  lotExtraFields: ReadonlyArray<{ name: string }> | undefined,
  vehicle: VehicleDetails
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of lotExtraFields ?? []) {
    const key = f.name.trim().toLowerCase();
    const source = VEHICLE_FIELD_SOURCES[key];
    if (!source) continue;
    const value = valueFor(source, vehicle);
    if (value.length > 0) out[f.name] = value;
  }
  return out;
}
