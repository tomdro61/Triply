import { describe, it, expect, beforeEach, vi } from "vitest";
import { FakeSupabase } from "@/lib/booking/__tests__/supabase-fake";

const db = new FakeSupabase();
vi.mock("@/lib/supabase/server", () => ({ createAdminClient: async () => db }));

import {
  claimForCancel,
  releaseClaim,
  CANCEL_STALE_CLAIM_MS,
  CancelClaimError,
} from "../claim";

const NOW = 1_800_000_000_000;
const iso = (ms: number) => new Date(ms).toISOString();

function seedBooking(over: Record<string, unknown> = {}) {
  db.tables.bookings = [
    {
      id: "b1",
      reslab_reservation_number: "RTL1",
      status: "confirmed",
      cancel_claimed_at: null,
      cancel_state: null,
      ...over,
    },
  ];
}

beforeEach(() => {
  db.tables.bookings = [];
  db.log = [];
});

describe("claimForCancel", () => {
  it("claims a fresh confirmed booking and returns ownedAt", async () => {
    seedBooking();
    const r = await claimForCancel("RTL1", NOW);
    expect(r).toEqual({ claimed: true, ownedAt: iso(NOW) });
    expect(db.tables.bookings[0].cancel_claimed_at).toBe(iso(NOW));
    expect(db.tables.bookings[0].cancel_state).toBe("claimed");
  });

  it("a second claim on an already-claimed (fresh) booking → in_progress", async () => {
    seedBooking({ cancel_claimed_at: iso(NOW - 1000), cancel_state: "claimed" });
    expect(await claimForCancel("RTL1", NOW)).toEqual({
      claimed: false,
      reason: "in_progress",
    });
  });

  it("a terminal booking → already_terminal (idempotent, not an error)", async () => {
    for (const status of ["cancelled", "refunded"]) {
      seedBooking({ status, cancel_state: "refund_issued", cancel_claimed_at: iso(NOW - 5000) });
      expect(await claimForCancel("RTL1", NOW)).toEqual({
        claimed: false,
        reason: "already_terminal",
      });
    }
  });

  it("re-steals a STALE abandoned claim (owner died) and re-drives", async () => {
    seedBooking({
      cancel_claimed_at: iso(NOW - CANCEL_STALE_CLAIM_MS - 1000),
      cancel_state: "claimed",
    });
    const r = await claimForCancel("RTL1", NOW);
    expect(r).toEqual({ claimed: true, ownedAt: iso(NOW) });
    expect(db.tables.bookings[0].cancel_claimed_at).toBe(iso(NOW)); // re-claimed to now
  });

  it("does NOT steal a stale deliberate HOLD (that's the cron's to finish)", async () => {
    seedBooking({
      cancel_claimed_at: iso(NOW - CANCEL_STALE_CLAIM_MS - 1000),
      cancel_state: "held_reslab_ambiguous",
    });
    expect(await claimForCancel("RTL1", NOW)).toEqual({
      claimed: false,
      reason: "in_progress",
    });
    // untouched
    expect(db.tables.bookings[0].cancel_state).toBe("held_reslab_ambiguous");
  });

  it("does NOT steal a claim that is stale by time but not yet past the window", async () => {
    seedBooking({
      cancel_claimed_at: iso(NOW - CANCEL_STALE_CLAIM_MS + 1000), // 1s short of stale
      cancel_state: "claimed",
    });
    expect(await claimForCancel("RTL1", NOW)).toEqual({
      claimed: false,
      reason: "in_progress",
    });
  });

  it("two concurrent claimers: exactly ONE wins", async () => {
    seedBooking();
    const [a, b] = await Promise.all([
      claimForCancel("RTL1", NOW),
      claimForCancel("RTL1", NOW),
    ]);
    expect([a, b].filter((x) => x.claimed).length).toBe(1);
    expect([a, b].filter((x) => !x.claimed && x.reason === "in_progress").length).toBe(1);
  });

  it("throws CancelClaimError on a DB fault (caller does no side effects)", async () => {
    seedBooking();
    db.failOnce("bookings", "update", "connection reset");
    await expect(claimForCancel("RTL1", NOW)).rejects.toBeInstanceOf(CancelClaimError);
  });
});

describe("releaseClaim (pinned to ownedAt)", () => {
  it("releases OUR claim", async () => {
    seedBooking({ cancel_claimed_at: iso(NOW), cancel_state: "claimed" });
    await releaseClaim("RTL1", iso(NOW));
    expect(db.tables.bookings[0].cancel_claimed_at).toBeNull();
    expect(db.tables.bookings[0].cancel_state).toBeNull();
  });

  it("is a NO-OP when a new owner holds the claim (stale-stolen — FIRS-3)", async () => {
    // A slow request A (ownedAt = NOW) resumes on an abort path, but its claim
    // was already stale-stolen by B (cancel_claimed_at = NOW+100s). A's pinned
    // release must NOT wipe B's claim.
    seedBooking({ cancel_claimed_at: iso(NOW + 100_000), cancel_state: "claimed" });
    await releaseClaim("RTL1", iso(NOW));
    expect(db.tables.bookings[0].cancel_claimed_at).toBe(iso(NOW + 100_000)); // untouched
    expect(db.tables.bookings[0].cancel_state).toBe("claimed");
  });

  it("throws CancelClaimError on a DB fault", async () => {
    seedBooking({ cancel_claimed_at: iso(NOW), cancel_state: "claimed" });
    db.failOnce("bookings", "update", "conn reset");
    await expect(releaseClaim("RTL1", iso(NOW))).rejects.toBeInstanceOf(CancelClaimError);
  });
});
