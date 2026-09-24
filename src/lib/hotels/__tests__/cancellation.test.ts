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

describe("refundabilityFromPolicies", () => {
  it("NRFN → non-refundable, no anomaly (the sandbox's common case: empty cancelPolicyInfos)", () => {
    const r = refundabilityFromPolicies({ refundableTag: "NRFN", cancelPolicyInfos: [], hotelRemarks: [] }, "America/New_York");
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
      "UTC"
    );
    expect(r.anomaly).toBeNull();
    expect(r.refundability).toEqual({ kind: "free_until", deadlineLocal: "2026-10-13 18:00", timeZone: "America/New_York" });
  });

  it("RFN with no penalised entries is ambiguous → non-refundable + anomaly (we never guess a deadline)", () => {
    const r = refundabilityFromPolicies({ refundableTag: "RFN", cancelPolicyInfos: [] }, "America/New_York");
    expect(r.refundability).toEqual({ kind: "non_refundable" });
    expect(r.anomaly).toMatch(/deadline unknown/);
  });

  it("an unparseable cancelTime is non-refundable + anomaly", () => {
    const r = refundabilityFromPolicies(
      { refundableTag: "RFN", cancelPolicyInfos: [{ cancelTime: "tomorrow-ish", amount: 10 }] },
      "America/New_York"
    );
    expect(r.refundability).toEqual({ kind: "non_refundable" });
    expect(r.anomaly).toMatch(/unparseable cancelTime/);
  });
});

describe("refundability copy — one source for every surface", () => {
  it("formats the deadline without any Date parsing", () => {
    expect(formatLocalDeadline("2026-10-13 18:00")).toBe("Oct 13, 2026 at 6:00 PM");
    expect(formatLocalDeadline("2026-10-13 00:05")).toBe("Oct 13, 2026 at 12:05 AM");
  });
  it("summary and terms copy are CONDITIONAL on refundability", () => {
    const free = { kind: "free_until" as const, deadlineLocal: "2026-10-13 18:00", timeZone: "America/New_York" };
    expect(roomRefundabilitySummary(free)).toBe("Free cancellation until Oct 13, 2026 at 6:00 PM");
    expect(roomRefundabilitySummary({ kind: "non_refundable" })).toBe("Non-refundable room");
    expect(roomTermsAcknowledgement({ kind: "non_refundable" })).toMatch(/non-refundable/);
    expect(roomTermsAcknowledgement(free)).toMatch(/free to cancel until Oct 13/);
  });
});
