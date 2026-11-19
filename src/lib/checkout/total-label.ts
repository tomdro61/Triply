import { currencySign } from "@/lib/fx/usd-label";

/** The part of a direct lot's vehicle estimate these helpers read. */
interface AtLotEstimate {
  atLotCents: number;
}

/**
 * The label on the order summary's total row. An oversized vehicle on a
 * direct lot pays twice (card now, the rest at the lot), so the card charge
 * is never called "Total" there: it reads as the whole trip.
 */
export function totalRowLabel(vehicleEstimate: AtLotEstimate | null, usdLabel: boolean): string {
  if (vehicleEstimate && vehicleEstimate.atLotCents > 0) return "Charged today";
  return usdLabel ? "Total (USD)" : "Total";
}

export interface TripStripPrice {
  totalLabel: string;
  /** null while the page has no server price: the client fallback guesses the tax (8%), so it is never shown here. */
  total: number | null;
  /** The money that changes hands at the lot, in the summary's words, or null when it is all paid online. */
  atLotNote: string | null;
  sign: ReturnType<typeof currencySign>;
}

/**
 * What the details step's trip strip shows: the same total, label and split
 * the order summary shows, from the same price breakdown, so the two never
 * disagree. The strip may be the only price a phone shopper sees before
 * typing, so a second payment at the lot is never left out.
 */
export function tripStripPrice(input: {
  /** The page loaded a server price (checkout-form's costData). */
  priced: boolean;
  priceBreakdown: { total: number; dueNow: number; dueAtLocation: number };
  vehicleEstimate: AtLotEstimate | null;
  usdLabel: boolean;
}): TripStripPrice {
  const { priced, priceBreakdown: p, vehicleEstimate, usdLabel } = input;
  const sign = currencySign(usdLabel);
  const totalLabel = totalRowLabel(vehicleEstimate, usdLabel);
  if (!priced) return { totalLabel, total: null, atLotNote: null, sign };
  let atLotNote: string | null = null;
  if (vehicleEstimate && vehicleEstimate.atLotCents > 0) {
    atLotNote = `+ ${sign}${(vehicleEstimate.atLotCents / 100).toFixed(2)} due at the lot (est.)`;
  } else if (p.dueAtLocation > 0) {
    atLotNote = `${sign}${p.dueNow.toFixed(2)} due now, ${sign}${p.dueAtLocation.toFixed(2)} at the lot`;
  }
  return { totalLabel, total: p.total, atLotNote, sign };
}
