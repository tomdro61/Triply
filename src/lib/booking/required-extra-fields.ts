/**
 * Which of a lot's ResLab "extra fields" the customer MUST fill before paying.
 *
 * ResLab sends no required flag. Its extra-field object (client.ts
 * ReslabExtraField, from the v1.10 OpenAPI spec) is
 *   { id, name, label, type: "parking" | "room" | "both",
 *     input_type: "text" | "license_plate" | "number", per_car }
 * — `type` is the PRODUCT the field belongs to, not a required marker. The
 * checkout used to test `field.type === "required"`, which can never be true,
 * so every lot-specific field (e.g. a return flight number) rendered as
 * optional. A blank declared field is what ResLab rejects with "Validation
 * error" AFTER the card is authorised (2026-09-25, BNA lot 471: auth released,
 * sale lost) — so a lot declaring a field is the only signal we get that it
 * wants it.
 *
 * Rule: a declared field is required unless it is scoped to rooms only (we
 * only book parking). Unknown `type` values count as required — failing safe
 * costs the customer a keystroke; failing open costs the sale. A field the
 * customer cannot know (a return flight when driving) stays satisfiable: the
 * UI tells them to enter "N/A" (or 0 for a number field) instead of leaving it
 * blank.
 *
 * Pure and env-free: imported by the checkout form ("use client"), the pending
 * route (the server-side gate, before the charge) and by tests.
 */

import { z } from "zod";
import type { VehicleDetails } from "@/types/checkout";
import { isVehicleFieldName, vehicleFieldAliasValues } from "@/lib/booking/vehicle-field-aliases";

/**
 * How long the pending route's pre-charge field lookup may take, ResLab login
 * included. That route's maxDuration is 15 s and every ResLab call has its own
 * 10 s timeout (login + lookup on a cold instance = 20 s), so without this a
 * hanging ResLab gets the function KILLED: no skip, no Sentry event, a
 * non-JSON 504, and a check that was meant to be advisory blocks every
 * checkout.
 */
export const REQUIRED_FIELD_LOOKUP_TIMEOUT_MS = 4_000;

/** The minimum of a ResLab extra field this rule reads. Validated at the
 *  ResLab boundary (the pending route) — extra keys pass through. */
export const declaredExtraFieldSchema = z.object({
  name: z.string().min(1),
  label: z.string().nullish(),
  // A field with no scope is still a field the lot declared: it counts as
  // required (isRequiredExtraField) instead of failing the whole array and
  // skipping the gate for the lot.
  type: z.string().nullish(),
});
export const declaredExtraFieldsSchema = z.array(declaredExtraFieldSchema);

export type DeclaredExtraField = z.infer<typeof declaredExtraFieldSchema>;

/** Is the customer required to answer this lot-declared field? */
export function isRequiredExtraField(field: { type?: string | null }): boolean {
  return (field.type ?? "").trim().toLowerCase() !== "room";
}

/** Blank means empty after trimming — a space is not an answer to ResLab. */
function isBlank(value: string | undefined): boolean {
  return value === undefined || value.trim().length === 0;
}

/**
 * EXACTLY the extra-field map fulfilment sends to ResLab: the vehicle step's
 * answers under the common names, overlaid by whatever the payload carries
 * (typed answers + the lot's own vehicle spellings). fulfill.ts builds the
 * reservation from this, and the pending route validates against it, so the
 * gate can never check a different map from the one ResLab receives.
 */
export function reslabExtraFieldValues(
  vehicle: VehicleDetails,
  extraFields: Readonly<Record<string, string>> | undefined
): Record<string, string> {
  return {
    car_make: vehicle.make,
    car_model: vehicle.model,
    car_makemodel: `${vehicle.make} ${vehicle.model}`, // Combined field required by ResLab
    car_color: vehicle.color,
    license_plate: vehicle.licensePlate,
    license_plate_state: vehicle.state,
    ...extraFields,
  };
}

/**
 * The required declared fields that have no answer in `values`, in the lot's
 * order. Empty array = safe to charge.
 */
export function missingRequiredExtraFields<F extends { name: string; type?: string | null }>(
  declared: ReadonlyArray<F> | undefined,
  values: Readonly<Record<string, string>>
): F[] {
  return (declared ?? []).filter(
    (f) => isRequiredExtraField(f) && isBlank(values[f.name])
  );
}

/** What a required field should tell a customer it does not apply to. */
export function notApplicableHint(inputType: string): string {
  return inputType === "number"
    ? "Required by this lot. If it doesn't apply to you, enter 0."
    : "Required by this lot. If it doesn't apply to you, enter N/A.";
}

/**
 * The extra fields the checkout sends for this lot: typed answers (never for a
 * vehicle-named field — the vehicle step is authoritative for those), overlaid
 * by the vehicle step's answers under the lot's own vehicle spellings.
 *
 * The checkout form builds its request body THROUGH this function, so the step
 * gate (extraFieldStepErrors) checks the map that is actually sent, not a copy
 * of it.
 */
export function checkoutExtraFields(
  lotFields: ReadonlyArray<{ name: string }> | undefined,
  vehicle: VehicleDetails,
  typed: Readonly<Record<string, string>>
): Record<string, string> {
  const typedExcludingVehicle = Object.fromEntries(
    Object.entries(typed).filter(([name]) => !isVehicleFieldName(name))
  );
  return { ...typedExcludingVehicle, ...vehicleFieldAliasValues(lotFields, vehicle) };
}

/**
 * The vehicle step's gate for lot fields: an error per required field the
 * customer still has to answer, keyed by field name. Vehicle-named fields are
 * answered by the vehicle inputs (which have their own errors), so they never
 * appear here. Empty object = the step may advance.
 */
export function extraFieldStepErrors<
  F extends { name: string; type?: string | null; label?: string | null },
>(
  lotFields: ReadonlyArray<F> | undefined,
  vehicle: VehicleDetails,
  typed: Readonly<Record<string, string>>
): Record<string, string> {
  const values = reslabExtraFieldValues(vehicle, checkoutExtraFields(lotFields, vehicle, typed));
  const errors: Record<string, string> = {};
  for (const f of missingRequiredExtraFields(lotFields, values)) {
    if (isVehicleFieldName(f.name)) continue;
    errors[f.name] = `${f.label?.trim() || "This field"} is required`;
  }
  return errors;
}
