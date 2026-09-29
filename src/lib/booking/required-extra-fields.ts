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
 * costs the customer a keystroke; failing open costs the sale. ResLab's own
 * spec calls extra_fields "mandatory additional fields… collect values for all
 * of them".
 *
 * A plain text field the customer cannot answer stays satisfiable with "N/A".
 * A FLIGHT field does not: ResLab validates `input_type: "flight_number"` and
 * rejects "N/A" with 422 "Invalid Flight Number" — after the card is
 * authorised (verified on staging 2026-09-29, Park For U LGA). So flight
 * fields are format-checked here, before the charge, and their hint never
 * offers N/A.
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
  // .catch: an input type we cannot read only costs the format check for that
  // field. It must never fail the whole list and skip the lot's gate.
  input_type: z.string().nullish().catch(null),
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

/** ResLab's input type for a field it format-checks as a flight number. */
export const FLIGHT_NUMBER_INPUT_TYPE = "flight_number";

/** The lot page carries `inputType`; ResLab's own object carries `input_type`. */
type WithInputType = { inputType?: string | null; input_type?: string | null };

export function isFlightNumberField(field: WithInputType): boolean {
  const t = field.inputType ?? field.input_type ?? "";
  return t.trim().toLowerCase() === FLIGHT_NUMBER_INPUT_TYPE;
}

/** "dl 460", "DL-460", "DL.460" → "DL460": the compact form ResLab accepts
 *  (DL0460 and AA1093 on confirmed reservations; DL460 verified on staging
 *  2026-09-29, RTL855661). */
export function normalizeFlightNumber(value: string): string {
  return value.replace(/[\s.-]/g, "").toUpperCase();
}

/**
 * An airline designator (two characters, at least one a letter: DL, B6, 9W)
 * followed by 1–4 digits. Checked on the NORMALISED form. This is our gate,
 * not ResLab's published rule (they publish none): it exists to stop the
 * answers we know they refuse ("N/A", "none", free text) before the charge.
 */
const FLIGHT_NUMBER_RE = /^(?:[A-Z][A-Z0-9]|[0-9][A-Z])[0-9]{1,4}$/;

export function isValidFlightNumber(value: string): boolean {
  return FLIGHT_NUMBER_RE.test(normalizeFlightNumber(value));
}

export const FLIGHT_NUMBER_EXAMPLE = "DL 460";

/** The lot will not take a booking without one, so say what the options are. */
export const NO_FLIGHT_NUMBER_ADVICE = "No flight number? Choose another lot or contact us.";

/**
 * The required flight fields whose answer ResLab would refuse: not blank (that
 * is missingRequiredExtraFields' job), and either not a flight number or not
 * in the compact form that is sent. `values` is the map fulfilment sends, so a
 * value still carrying a space is refused here, not by ResLab after the charge.
 */
export function invalidFormatExtraFields<
  F extends { name: string; type?: string | null } & WithInputType,
>(declared: ReadonlyArray<F> | undefined, values: Readonly<Record<string, string>>): F[] {
  return (declared ?? []).filter((f) => {
    if (!isRequiredExtraField(f) || !isFlightNumberField(f)) return false;
    const value = values[f.name];
    if (isBlank(value) || value === undefined) return false;
    return !isValidFlightNumber(value) || value !== normalizeFlightNumber(value);
  });
}

/** What a required field tells the customer under its input. */
export function notApplicableHint(inputType: string): string {
  if (isFlightNumberField({ inputType })) {
    return `Required by this lot. Enter the flight number, for example ${FLIGHT_NUMBER_EXAMPLE}. ${NO_FLIGHT_NUMBER_ADVICE}`;
  }
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
  lotFields: ReadonlyArray<{ name: string } & WithInputType> | undefined,
  vehicle: VehicleDetails,
  typed: Readonly<Record<string, string>>
): Record<string, string> {
  const flightFields = new Set((lotFields ?? []).filter(isFlightNumberField).map((f) => f.name));
  const typedExcludingVehicle = Object.fromEntries(
    Object.entries(typed)
      .filter(([name]) => !isVehicleFieldName(name))
      // A flight number is sent in the compact form ResLab has accepted. Only
      // a value that IS a flight number is rewritten; anything else is left as
      // typed so the gate can refuse it and show the customer what they wrote.
      .map(([name, value]): [string, string] =>
        flightFields.has(name) && isValidFlightNumber(value)
          ? [name, normalizeFlightNumber(value)]
          : [name, value]
      )
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
  F extends { name: string; type?: string | null; label?: string | null } & WithInputType,
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
  for (const f of invalidFormatExtraFields(lotFields, values)) {
    if (isVehicleFieldName(f.name)) continue;
    errors[f.name] = flightNumberFormatMessage(f.label);
  }
  return errors;
}

/** One wording for the form and the server refusal. */
export function flightNumberFormatMessage(label: string | null | undefined): string {
  return `${label?.trim() || "This field"}: enter a flight number, for example ${FLIGHT_NUMBER_EXAMPLE}`;
}

/** Is this a real flight number that is only not in the form that is sent?
 *  Only a page loaded before the deploy produces one. */
export function isUnnormalizedFlightNumber(value: string | undefined): boolean {
  return value !== undefined && isValidFlightNumber(value) && value !== normalizeFlightNumber(value);
}
