import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { STALE_NOTICE_CLAIM_MS } from "../lot-notice";

/**
 * The lot hears of a cancellation LAST (4b plan §10 F-2) only because a booking
 * notice's send can never still be in flight when its claim goes stale: the
 * cancel claim's second gate passes a STALE booking claim. That holds while
 * every route able to send a booking notice is killed (maxDuration) well
 * before STALE_NOTICE_CLAIM_MS. A route added without a maxDuration, or one
 * raised toward the claim window, breaks the ordering — so it fails here.
 */
const APP = join(__dirname, "..", "..", "..", "app");

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === "__tests__" ? [] : routeFiles(p);
    return name === "route.ts" ? [p] : [];
  });
}

describe("lot-notice claim window vs route lifetimes", () => {
  const senders = routeFiles(APP).filter((f) => /createBooking|sendLotBookingNotice/.test(readFileSync(f, "utf8")));

  it("finds the routes that can send a booking notice", () => {
    expect(senders.length).toBeGreaterThanOrEqual(4);
  });

  it.each(senders.map((f) => [f.slice(APP.length + 1)] as const))("%s ends well before a notice claim goes stale", (rel) => {
    const src = readFileSync(join(APP, rel), "utf8");
    const m = src.match(/export const maxDuration = (\d+);/);
    expect(m, `${rel} must export a maxDuration`).not.toBeNull();
    const seconds = Number(m![1]);
    // At most half the claim window: headroom for the stale check's own clock.
    expect(seconds * 1000).toBeLessThanOrEqual(STALE_NOTICE_CLAIM_MS / 2);
  });
});
