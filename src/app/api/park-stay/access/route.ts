/**
 * GET /api/park-stay/access
 *
 * "Lock 2" of the Park & Stay CX plan (notes/2026-10-20-park-stay-cx-plan.md
 * v2 §1): tells the browser whether to show any Park & Stay entry point, and
 * with what hotels. It is a DISPLAY decision only — every page and API route
 * behind it keeps its own 404 gate (Lock 1), which is the security boundary.
 *
 * Answers exactly like Lock 1: the flag first, then the signed-in admin
 * check, and the same 404 JSON for everyone else (no hint that the feature
 * exists). An admin gets 200 { airports, hotels }.
 *
 * Supplier calls: none, ever — no budget ticket, no LiteAPI, no ResLab. The
 * ResLab account comes from the key fingerprint (a local hash). `no-store` on
 * every answer: the 200 is per-viewer and must never reach a CDN.
 */

import { NextResponse } from "next/server";
import { parkStayFlags } from "@/lib/hotels/flags";
import { parkStayViewerAllowed } from "@/lib/hotels/admin-preview";
import { parkStayAirports } from "@/lib/hotels/park-stay-airports";
import { currentReslabAccount } from "@/lib/hotels/hotel-lot-resolve";
import { buildParkStayAccess, type ParkStayAccess } from "@/lib/hotels/access";

export const dynamic = "force-dynamic";

const CALLER = "/api/park-stay/access";
const NO_STORE = { "Cache-Control": "no-store" } as const;

export type ParkStayAccessResponse = ParkStayAccess;

/** Byte-identical to the other Park & Stay routes' 404 (`_lib/request.ts`). */
function notFound(): NextResponse {
  return NextResponse.json({ error: "Not found" }, { status: 404, headers: NO_STORE });
}

export async function GET() {
  if (!parkStayFlags().enabled) return notFound();
  if (!(await parkStayViewerAllowed(CALLER))) return notFound();
  const airports = parkStayAirports();
  // Allowlisted airports with no enabled hotel: nothing to show, same as off.
  if (airports.length === 0) return notFound();
  const body: ParkStayAccessResponse = buildParkStayAccess(
    airports.map((a) => ({ code: a.code, name: a.name })),
    currentReslabAccount()
  );
  return NextResponse.json(body, { headers: NO_STORE });
}
