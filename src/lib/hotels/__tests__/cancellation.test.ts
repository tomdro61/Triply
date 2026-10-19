import { describe, it, expect } from "vitest";
import { refundabilityFromPolicies, normaliseRefundableTag } from "../cancellation";
import { roomRefundabilitySummary, roomTermsAcknowledgement, formatLocalDeadline } from "../refundability";

describe("normaliseRefundableTag — total mapping, conservative direction", () => {
  it("accepts the two documented tags", () => {
    expect(normaliseRefundableTag("RFN")).toEqual({ tag: "RFN", anomaly: null });
    expect(normaliseRefundableTag("NRFN")).toEqual({ tag: "NRFN", anomaly: null });
  });
  it("anything else is NON-refundable plus an anomaly (never free cancellation)", () => {
    const r = normaliseRefundableTag("PARTIAL");
    expect(r.tag).toBe("NRFN");
    expect(r.anomaly).toMatch(/unrecognised refundableTag "PARTIAL"/);
    expect(normaliseRefundableTag(undefined).tag).toBe("NRFN");
  });
});

// 2026-10-01 12:00 New York — before every deadline below.
const NOW = new Date("2026-10-01T16:00:00Z");

describe("refundabilityFromPolicies", () => {
  it("NRFN → non-refundable, no anomaly (the sandbox's common case: empty cancelPolicyInfos)", () => {
    const r = refundabilityFromPolicies({ refundableTag: "NRFN", cancelPolicyInfos: [], hotelRemarks: [] }, "America/New_York", NOW);
    expect(r).toEqual({ refundability: { kind: "non_refundable" }, anomaly: null });
  });

  it("RFN → free until the EARLIEST penalised cancelTime, in the policy's timezone", () => {
    const r = refundabilityFromPolicies(
      {
        refundableTag: "RFN",
        cancelPolicyInfos: [
          { cancelTime: "2026-10-14 23:59:00", amount: 232.97, type: "amount", timezone: "America/New_York" },
          { cancelTime: "2026-10-13 18:00:00", amount: 50, type: "amount", timezone: "America/New_York" },
        ],
      },
      "America/New_York",
      NOW
    );
    expect(r.anomaly).toBeNull();
    expect(r.refundability).toEqual({ kind: "free_until", deadlineLocal: "2026-10-13 18:00", timeZone: "America/New_York" });
  });

  it("RFN with no penalised entries is ambiguous → non-refundable + anomaly (we never guess a deadline)", () => {
    const r = refundabilityFromPolicies({ refundableTag: "RFN", cancelPolicyInfos: [] }, "America/New_York", NOW);
    expect(r.refundability).toEqual({ kind: "non_refundable" });
    expect(r.anomaly).toMatch(/deadline unknown/);
  });

  it("an unparseable cancelTime is non-refundable + anomaly", () => {
    const r = refundabilityFromPolicies(
      { refundableTag: "RFN", cancelPolicyInfos: [{ cancelTime: "tomorrow-ish", amount: 10, timezone: "GMT" }] },
      "America/New_York",
      NOW
    );
    expect(r.refundability).toEqual({ kind: "non_refundable" });
    expect(r.anomaly).toMatch(/unparseable cancelTime/);
  });
});

describe("refundabilityFromPolicies — the deadline's own timezone and the clock (review H3, H4)", () => {
  const NY = "America/New_York";
  const rfn = (infos: { cancelTime: string; timezone?: string }[]) => ({
    refundableTag: "RFN",
    cancelPolicyInfos: infos.map((i) => ({ amount: 100, type: "amount", ...i })),
  });

  it("an 18:00 GMT deadline is 2:00 PM at a New York hotel in October (EDT)", () => {
    const r = refundabilityFromPolicies(rfn([{ cancelTime: "2026-10-14 18:00:00", timezone: "GMT" }]), NY, NOW);
    expect(r).toEqual({ refundability: { kind: "free_until", deadlineLocal: "2026-10-14 14:00", timeZone: NY }, anomaly: null });
    expect(roomRefundabilitySummary(r.refundability)).toBe("Room: free cancellation until Oct 14, 2026 at 2:00 PM (hotel time)");
  });

  it("…and 1:00 PM in November (EST)", () => {
    const r = refundabilityFromPolicies(rfn([{ cancelTime: "2026-11-10 18:00:00", timezone: "GMT" }]), NY, NOW);
    expect(r.refundability).toEqual({ kind: "free_until", deadlineLocal: "2026-11-10 13:00", timeZone: NY });
  });

  it("the earliest deadline is chosen by INSTANT, not by comparing wall-clock strings across zones", () => {
    // 20:00 GMT = 16:00 EDT, earlier than 17:00 EDT although "20:00" > "17:00" as text.
    const r = refundabilityFromPolicies(
      rfn([
        { cancelTime: "2026-10-14 17:00:00", timezone: NY },
        { cancelTime: "2026-10-14 20:00:00", timezone: "GMT" },
      ]),
      NY,
      NOW
    );
    expect(r.refundability).toEqual({ kind: "free_until", deadlineLocal: "2026-10-14 16:00", timeZone: NY });
  });

  it("a missing or unrecognised timezone is non-refundable + anomaly", () => {
    expect(refundabilityFromPolicies(rfn([{ cancelTime: "2026-10-14 18:00:00" }]), NY, NOW)).toMatchObject({
      refundability: { kind: "non_refundable" },
      anomaly: expect.stringMatching(/timezone/),
    });
    expect(refundabilityFromPolicies(rfn([{ cancelTime: "2026-10-14 18:00:00", timezone: "Mars/Olympus" }]), NY, NOW).refundability).toEqual({ kind: "non_refundable" });
  });

  it("a deadline at or before now is non-refundable + anomaly — never free cancellation", () => {
    const at = new Date("2026-10-14T18:00:00Z");
    expect(refundabilityFromPolicies(rfn([{ cancelTime: "2026-10-14 18:00:00", timezone: "GMT" }]), NY, at)).toMatchObject({
      refundability: { kind: "non_refundable" },
      anomaly: expect.stringMatching(/passed/),
    });
    const justBefore = new Date("2026-10-14T17:59:00Z");
    expect(refundabilityFromPolicies(rfn([{ cancelTime: "2026-10-14 18:00:00", timezone: "GMT" }]), NY, justBefore).refundability.kind).toBe("free_until");
  });
});


describe("review pass 2 — an unreadable penalty can never extend free cancellation (M4)", () => {
  it("a positive penalty with no cancelTime makes the rate non-refundable, even next to a readable later deadline", () => {
    const r = refundabilityFromPolicies(
      {
        refundableTag: "RFN",
        cancelPolicyInfos: [
          { amount: 100, cancelTime: null, timezone: "GMT" },
          { amount: 200, cancelTime: "2026-10-14 18:00:00", timezone: "GMT" },
        ],
      },
      "America/New_York",
      NOW
    );
    expect(r).toMatchObject({ refundability: { kind: "non_refundable" }, anomaly: expect.stringMatching(/without a cancelTime/) });
  });

  it("an entry with an unreadable amount is non-refundable + anomaly; a zero-amount entry is ignored", () => {
    const base = { cancelTime: "2026-10-14 18:00:00", timezone: "GMT" };
    expect(refundabilityFromPolicies({ refundableTag: "RFN", cancelPolicyInfos: [{ ...base, amount: null }, { ...base, amount: 50 }] }, "America/New_York", NOW).refundability).toEqual({ kind: "non_refundable" });
    expect(refundabilityFromPolicies({ refundableTag: "RFN", cancelPolicyInfos: [{ amount: 0, cancelTime: null }, { ...base, amount: 50 }] }, "America/New_York", NOW).refundability.kind).toBe("free_until");
  });
});

describe("refundability copy — one source for every surface", () => {
  it("formats the deadline without any Date parsing", () => {
    expect(formatLocalDeadline("2026-10-13 18:00")).toBe("Oct 13, 2026 at 6:00 PM");
    expect(formatLocalDeadline("2026-10-13 00:05")).toBe("Oct 13, 2026 at 12:05 AM");
  });
  it("summary and terms copy are CONDITIONAL on refundability", () => {
    const free = { kind: "free_until" as const, deadlineLocal: "2026-10-13 18:00", timeZone: "America/New_York" };
    expect(roomRefundabilitySummary(free)).toBe("Room: free cancellation until Oct 13, 2026 at 6:00 PM (hotel time)");
    expect(roomRefundabilitySummary({ kind: "non_refundable" })).toBe("Non-refundable room");
    expect(roomTermsAcknowledgement({ kind: "non_refundable" })).toMatch(/non-refundable/);
    expect(roomTermsAcknowledgement(free)).toMatch(/free to cancel until Oct 13/);
  });
});
