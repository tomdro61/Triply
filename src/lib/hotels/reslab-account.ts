/**
 * Which ResLab account a deployment talks to (plan v3 §9.3).
 *
 * Preview and staging use the STAGING ResLab account, whose location ids are
 * not production's; local dev uses PRODUCTION ResLab. The id for a hotel lot
 * is chosen BY ACCOUNT — never "try production, then staging".
 *
 * The account is recognised by `keyFingerprint()` (reslab/location-snapshot.ts:
 * the first 16 hex chars of sha256 of RESLAB_API_KEY — the same identity the
 * location snapshot uses). A truncated hash of a high-entropy key, so it is
 * safe in a public repo. The caller (hotel-lot-resolve.ts, the only hotels
 * module allowed to import @/lib/reslab/*) passes the fingerprint in, so this
 * module stays pure.
 *
 * An unknown fingerprint fails CLOSED: no account → the search is unavailable,
 * never guessed.
 *
 * `production` was computed on 19 Oct 2026 from the local `.env.local`
 * RESLAB_API_KEY, which the project docs record as the production key. The
 * staging fingerprint is added with the staging ids at V1.
 */

import type { HotelLotEntry, ReslabAccount } from "./hotel-lots";

export const RESLAB_ACCOUNT_BY_FINGERPRINT: Readonly<Record<string, ReslabAccount>> = {
  f5d7c11622bdb289: "production",
};

export function reslabAccountForFingerprint(fingerprint: string | null): ReslabAccount | null {
  if (!fingerprint) return null;
  return Object.prototype.hasOwnProperty.call(RESLAB_ACCOUNT_BY_FINGERPRINT, fingerprint)
    ? RESLAB_ACCOUNT_BY_FINGERPRINT[fingerprint]
    : null;
}

/** The entry's ResLab location id under `account`, or null (fail closed: that hotel is unavailable). */
export function reslabIdFor(entry: HotelLotEntry, account: ReslabAccount): number | null {
  const id = entry.reslab.ids[account];
  return typeof id === "number" && Number.isInteger(id) && id > 0 ? id : null;
}
