import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const sentry = vi.hoisted(() => ({ captureBookingError: vi.fn() }));
vi.mock("@/lib/sentry", () => sentry);
vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: async () => {
    throw new Error("tests inject the rpc");
  },
}));

import {
  GUEST_LOOKUP_LIMITS,
  GUEST_LOOKUP_RPC_TIMEOUT_MS,
  GUEST_LOOKUP_WINDOW_SECONDS,
  bucketHash,
  guestLookupBuckets,
  ipBucketValue,
  normalizeGuestEmail,
  noteUnknownGuestIp,
  __resetUnknownGuestIpForTests,
  releaseGuestLookup,
  shouldReportRefusal,
  takeGuestLookup,
  type GuestLookupRpc,
} from "../guest-lookup-limit";

beforeEach(() => {
  vi.stubEnv("BOOKING_LINK_SIGNING_SECRET", "test-secret-one");
  sentry.captureBookingError.mockReset();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

type Answer = { data: unknown; error: { message: string; code?: string } | null };
function rpcAnswering(take: Answer | (() => Promise<Answer>), release: Answer = { data: 1, error: null }) {
  const calls = { take: [] as unknown[], release: [] as unknown[] };
  const rpc: GuestLookupRpc = {
    take: (args) => {
      calls.take.push(args);
      return typeof take === "function" ? take() : Promise.resolve(take);
    },
    release: (args) => {
      calls.release.push(args);
      return Promise.resolve(release);
    },
  };
  return { rpc, calls };
}
const allowedRow: Answer = { data: [{ allowed: true, retry_after_seconds: 0, refused: 0, blocked_kinds: [] }], error: null };
const blockedRow = (refused: number, kinds: string[] = ["number"], retry = 3600): Answer => ({
  data: [{ allowed: false, retry_after_seconds: retry, refused, blocked_kinds: kinds }],
  error: null,
});

describe("normalizeGuestEmail", () => {
  it("trims and lowercases; empty, whitespace or over 254 characters → null", () => {
    expect(normalizeGuestEmail("  Dana@Example.COM ")).toBe("dana@example.com");
    expect(normalizeGuestEmail("")).toBeNull();
    expect(normalizeGuestEmail("   ")).toBeNull();
    expect(normalizeGuestEmail(null)).toBeNull();
    expect(normalizeGuestEmail(undefined)).toBeNull();
    expect(normalizeGuestEmail("a".repeat(243) + "@example.co")).toBe("a".repeat(243) + "@example.co"); // 254
    expect(normalizeGuestEmail("a".repeat(244) + "@example.co")).toBeNull(); // 255
  });
});

describe("ipBucketValue", () => {
  it("IPv4 as is; IPv6 by its /64; IPv4-mapped as IPv4; unknown or junk → null", () => {
    expect(ipBucketValue("203.0.113.7")).toBe("203.0.113.7");
    expect(ipBucketValue(" 203.0.113.7 ")).toBe("203.0.113.7");
    expect(ipBucketValue("2001:db8:1:2:3:4:5:6")).toBe("2001:db8:1:2::/64");
    // Every spelling of one /64 is one bucket.
    expect(ipBucketValue("2001:0DB8:0001:0002:ffff::1")).toBe("2001:db8:1:2::/64");
    expect(ipBucketValue("2001:db8:1:2::abcd")).toBe("2001:db8:1:2::/64");
    expect(ipBucketValue("2001:db8::")).toBe("2001:db8:0:0::/64");
    expect(ipBucketValue("::ffff:198.51.100.4")).toBe("198.51.100.4");
    expect(ipBucketValue("unknown")).toBeNull();
    expect(ipBucketValue("")).toBeNull();
    expect(ipBucketValue("999.1.1.1")).toBeNull();
    expect(ipBucketValue("not an ip")).toBeNull();
  });
});

describe("buckets", () => {
  it("a keyed hash per kind: 43 characters, no email or address in it, kind-specific", () => {
    const h = bucketHash("email", "dana@example.com");
    expect(h).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(h).not.toContain("dana");
    expect(bucketHash("number", "x")).not.toBe(bucketHash("email", "x"));
    vi.stubEnv("BOOKING_LINK_SIGNING_SECRET", "another-environment");
    expect(bucketHash("email", "dana@example.com")).not.toBe(h);
  });

  it("keys, kinds and limits stay paired by position; no ip → no address bucket", () => {
    const b = guestLookupBuckets({ ip: "203.0.113.7", email: "dana@example.com", reservationNumber: "RTL900001" });
    expect(b.kinds).toEqual(["number", "email", "ip"]);
    expect(b.limits).toEqual([GUEST_LOOKUP_LIMITS.number, GUEST_LOOKUP_LIMITS.email, GUEST_LOOKUP_LIMITS.ip]);
    expect(b.limits).toEqual([5, 10, 30]);
    expect(b.keys).toEqual([
      bucketHash("number", "RTL900001"),
      bucketHash("email", "dana@example.com"),
      bucketHash("ip", "203.0.113.7"),
    ]);
    const noIp = guestLookupBuckets({ ip: null, email: "dana@example.com", reservationNumber: "RTL900001" });
    expect(noIp.kinds).toEqual(["number", "email"]);
    expect(noIp.keys).toHaveLength(2);
  });

  it("a missing secret throws the config error (the route answers 503)", () => {
    vi.stubEnv("BOOKING_LINK_SIGNING_SECRET", "");
    expect(() => guestLookupBuckets({ ip: null, email: "a@b.co", reservationNumber: "RTL1" })).toThrow(/BOOKING_LINK_SIGNING_SECRET/);
  });
});

describe("takeGuestLookup", () => {
  const buckets = () => guestLookupBuckets({ ip: "203.0.113.7", email: "dana@example.com", reservationNumber: "RTL900001" });

  it("sends the paired arrays and the 24 h window; allowed → the keys to give back later", async () => {
    const { rpc, calls } = rpcAnswering(allowedRow);
    const b = buckets();
    expect(await takeGuestLookup(b, "RTL900001", rpc)).toEqual({ kind: "allowed", keys: b.keys });
    expect(calls.take).toEqual([{ p_keys: b.keys, p_kinds: b.kinds, p_limits: b.limits, p_window_seconds: 86400 }]);
    expect(GUEST_LOOKUP_WINDOW_SECONDS).toBe(86400);
  });

  it("refused → blocked with the wait; a Sentry warning only on the ladder (1, 10, 100, every 1,000)", async () => {
    for (const refused of [1, 2, 9, 10, 11, 100, 999, 1000, 2000, 2001]) {
      sentry.captureBookingError.mockReset();
      const { rpc } = rpcAnswering(blockedRow(refused, ["email", "number"], 1234));
      expect(await takeGuestLookup(buckets(), "RTL900001", rpc)).toEqual({ kind: "blocked", retryAfterSeconds: 1234 });
      expect(sentry.captureBookingError).toHaveBeenCalledTimes(shouldReportRefusal(refused) ? 1 : 0);
    }
    expect([1, 10, 100, 1000, 2000].every(shouldReportRefusal)).toBe(true);
    expect([0, 2, 9, 11, 999, 2001].some(shouldReportRefusal)).toBe(false);
    const { rpc } = rpcAnswering(blockedRow(1, ["email", "number"]));
    sentry.captureBookingError.mockReset();
    await takeGuestLookup(buckets(), "RTL900001", rpc);
    const [err, ctx] = sentry.captureBookingError.mock.calls[0];
    expect(String(err.message)).toContain("email, number");
    expect(String(err.message)).not.toContain("dana");
    expect(ctx).toMatchObject({ step: "confirmation", confirmationNumber: "RTL900001", level: "warning" });
  });

  it("a retry wait below 1 s is sent as 1", async () => {
    const { rpc } = rpcAnswering(blockedRow(2, ["ip"], 0));
    expect(await takeGuestLookup(buckets(), "RTL900001", rpc)).toEqual({ kind: "blocked", retryAfterSeconds: 1 });
  });

  it("fails closed: an rpc error, a malformed answer, a throw or a timeout is `error`, never allowed", async () => {
    const cases: Array<Answer | (() => Promise<Answer>)> = [
      { data: null, error: { message: "boom", code: "XX000" } },
      { data: [], error: null },
      { data: [{ allowed: "yes" }], error: null },
      { data: { allowed: true }, error: null },
      () => Promise.reject(new Error("network")),
    ];
    for (const answer of cases) {
      const { rpc } = rpcAnswering(answer);
      expect((await takeGuestLookup(buckets(), "RTL900001", rpc)).kind).toBe("error");
    }
    vi.useFakeTimers();
    const { rpc } = rpcAnswering(() => new Promise<Answer>(() => {}));
    const pending = takeGuestLookup(buckets(), "RTL900001", rpc);
    await vi.advanceTimersByTimeAsync(GUEST_LOOKUP_RPC_TIMEOUT_MS + 1);
    expect((await pending).kind).toBe("error");
  });
});

describe("noteUnknownGuestIp", () => {
  it("reports once per instance, not per request", () => {
    __resetUnknownGuestIpForTests();
    noteUnknownGuestIp("RTL1");
    noteUnknownGuestIp("RTL2");
    expect(sentry.captureBookingError).toHaveBeenCalledTimes(1);
    expect(sentry.captureBookingError.mock.calls[0][1]).toMatchObject({ fingerprint: ["guest-lookup-unknown-ip"], level: "warning" });
  });
});

describe("releaseGuestLookup", () => {
  it("gives one back per key over the same window; a failure is reported and never thrown", async () => {
    const { rpc, calls } = rpcAnswering(allowedRow);
    await releaseGuestLookup(["k1", "k2"], "RTL900001", rpc);
    expect(calls.release).toEqual([{ p_keys: ["k1", "k2"], p_window_seconds: 86400 }]);
    expect(sentry.captureBookingError).not.toHaveBeenCalled();

    const failing = rpcAnswering(allowedRow, { data: null, error: { message: "down" } });
    await expect(releaseGuestLookup(["k1"], "RTL900001", failing.rpc)).resolves.toBeUndefined();
    expect(sentry.captureBookingError).toHaveBeenCalledTimes(1);
    expect(sentry.captureBookingError.mock.calls[0][1]).toMatchObject({ fingerprint: ["guest-lookup-release-failed"] });
  });
});
