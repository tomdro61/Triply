import { describe, it, expect, beforeEach, vi } from "vitest";

// vi.hoisted so the mock reference is initialized before the (hoisted) vi.mock
// factory runs — the factory accesses reslabMock directly at setup time.
const reslabMock = vi.hoisted(() => ({ getReservation: vi.fn() }));
vi.mock("@/lib/reslab/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/reslab/client")>(
    "@/lib/reslab/client",
  );
  return { ...actual, reslab: reslabMock };
});

import type { ReslabReservation } from "@/lib/reslab/client";
import { ReslabError } from "@/lib/reslab/client";
import { classifyCancelOutcome } from "../reslab-cancel";

const res = (cancelled: unknown) =>
  ({ cancelled }) as unknown as ReslabReservation;

beforeEach(() => reslabMock.getReservation.mockReset());

describe("classifyCancelOutcome — 2xx", () => {
  it("cancelled:true → proceed (refund)", async () => {
    expect(
      await classifyCancelOutcome("RTL1", { ok: true, reservation: res(true) }),
    ).toEqual({ outcome: "proceed" });
    expect(reslabMock.getReservation).not.toHaveBeenCalled();
  });

  it("cancelled:1 (prod returns a number) → proceed (truthy)", async () => {
    expect(
      await classifyCancelOutcome("RTL1", { ok: true, reservation: res(1) }),
    ).toEqual({ outcome: "proceed" });
  });

  it("2xx but cancelled falsy → refuse (cancel did not apply)", async () => {
    const r = await classifyCancelOutcome("RTL1", {
      ok: true,
      reservation: res(false),
    });
    expect(r.outcome).toBe("refuse");
  });
});

describe("classifyCancelOutcome — ambiguous → HOLD (no probe, never refund)", () => {
  it("AbortError → hold", async () => {
    const err = Object.assign(new Error("aborted"), { name: "AbortError" });
    const r = await classifyCancelOutcome("RTL1", { ok: false, error: err });
    expect(r.outcome).toBe("hold");
    expect(reslabMock.getReservation).not.toHaveBeenCalled();
  });

  it("TimeoutError → hold", async () => {
    const err = Object.assign(new Error("timeout"), { name: "TimeoutError" });
    expect((await classifyCancelOutcome("RTL1", { ok: false, error: err })).outcome).toBe("hold");
  });

  it("ReslabError 502 → hold", async () => {
    const r = await classifyCancelOutcome("RTL1", { ok: false, error: new ReslabError(502, "bad gateway") });
    expect(r.outcome).toBe("hold");
    expect(reslabMock.getReservation).not.toHaveBeenCalled();
  });

  it("ReslabError 429 → hold", async () => {
    expect((await classifyCancelOutcome("RTL1", { ok: false, error: new ReslabError(429, "rate limited") })).outcome).toBe("hold");
  });
});

describe("classifyCancelOutcome — definitive 4xx → probe the real state", () => {
  it("4xx + reservation IS cancelled → proceed (already cancelled, idempotent)", async () => {
    reslabMock.getReservation.mockResolvedValue(res(1));
    const r = await classifyCancelOutcome("RTL1", { ok: false, error: new ReslabError(409, "already cancelled") });
    expect(r).toEqual({ outcome: "proceed" });
    expect(reslabMock.getReservation).toHaveBeenCalledWith("RTL1");
  });

  it("4xx + reservation still ACTIVE → refuse (never refund a live spot)", async () => {
    reslabMock.getReservation.mockResolvedValue(res(false));
    const r = await classifyCancelOutcome("RTL1", { ok: false, error: new ReslabError(400, "must not be started or checked in") });
    expect(r.outcome).toBe("refuse");
  });

  it("4xx + probe FAILS → hold (can't confirm, don't refund)", async () => {
    reslabMock.getReservation.mockImplementationOnce(async () => {
      throw new Error("probe down");
    });
    const r = await classifyCancelOutcome("RTL1", { ok: false, error: new ReslabError(404, "not found") });
    expect(r.outcome).toBe("hold");
  });

  it("an unexpected non-ResLab error also probes rather than blindly refunding", async () => {
    reslabMock.getReservation.mockResolvedValue(res(false));
    const r = await classifyCancelOutcome("RTL1", { ok: false, error: new Error("weird") });
    expect(r.outcome).toBe("refuse"); // probe showed still-active
  });
});
