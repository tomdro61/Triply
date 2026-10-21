import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Review of PR B, items 1–2: the hero tab has ONE owner of the access
 * answer, resets the Hero to Parking whenever it can't show its panel, later
 * mounts start from the remembered answer, and failures reach Sentry once
 * per page session (never for a 404 or a signed-out visitor).
 */

const captureException = vi.fn();
const scope = { setTag: vi.fn(), setContext: vi.fn(), setLevel: vi.fn() };
vi.mock("@sentry/nextjs", () => ({
  withScope: (cb: (s: typeof scope) => void) => cb(scope),
  captureException: (e: unknown) => captureException(e),
}));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("next/dynamic", () => ({ default: () => () => null }));

import type { ParkStayAccess } from "@/lib/hotels/access";
import { heroTabDecision } from "../slots/hero-tab-slot";
import { SlotBoundary } from "../slots/slot-boundary";
import {
  __resetParkStayReportsForTests,
  nextRemembered,
  pickAccessState,
  reportParkStayFailure,
  startParkStayAccess,
  type AccessAuthClient,
  type ParkStayAccessState,
} from "../use-park-stay-access";

const DATA: ParkStayAccess = { airports: [{ code: "JFK", name: "JFK" }], hotels: [] };
const VISIBLE: ParkStayAccessState = { status: "visible", data: DATA };
const HIDDEN: ParkStayAccessState = { status: "hidden" };
const LOADING: ParkStayAccessState = { status: "loading" };

beforeEach(() => {
  captureException.mockClear();
  scope.setTag.mockClear();
  __resetParkStayReportsForTests();
});

describe("heroTabDecision — panel shows the form, or the Hero resets to Parking", () => {
  const cases: Array<[ParkStayAccessState["status"], boolean, boolean, ReturnType<typeof heroTabDecision>]> = [
    ["visible", false, false, "show"], // the tab, not yet clicked
    ["visible", true, false, "show"], // the tab and its form
    ["hidden", false, false, "hidden"], // every customer
    ["loading", false, false, "hidden"],
    ["hidden", true, false, "reset"], // the answer turned hidden while the tab was open
    ["loading", true, false, "reset"], // a different user is being asked about
    ["visible", true, true, "reset"], // the lazy tab failed (its boundary caught it) while open
    ["visible", false, true, "hidden"], // …or failed before it was opened: gone for this view
  ];
  for (const [access, active, failed, want] of cases) {
    it(`${access}, ${active ? "active" : "inactive"}${failed ? ", failed" : ""} → ${want}`, () => {
      expect(heroTabDecision({ access, active, failed })).toBe(want);
    });
  }
});

describe("the in-memory answer (later mounts start from it)", () => {
  it("pickAccessState: a fresh instance shows the memory; its own definitive answer wins; 'loading' keeps a visible memory", () => {
    expect(pickAccessState(null, VISIBLE)).toBe(VISIBLE);
    expect(pickAccessState(null, HIDDEN)).toBe(HIDDEN);
    expect(pickAccessState(LOADING, VISIBLE)).toBe(VISIBLE);
    expect(pickAccessState(LOADING, HIDDEN)).toBe(LOADING);
    expect(pickAccessState(HIDDEN, VISIBLE)).toBe(HIDDEN);
    expect(pickAccessState(VISIBLE, HIDDEN)).toBe(VISIBLE);
  });

  it("nextRemembered: keeps a visible answer per user; another user, a hidden answer or a failure forgets it", () => {
    const kept = nextRemembered(null, { userId: "u1", state: VISIBLE });
    expect(kept).toEqual({ userId: "u1", state: VISIBLE });
    expect(nextRemembered(kept, { userId: "u1", state: VISIBLE })).toBe(kept); // unchanged → no re-render
    expect(nextRemembered(kept, { user: "u1" })).toBe(kept);
    expect(nextRemembered(kept, { user: "u2" })).toBeNull();
    expect(nextRemembered(kept, { user: null })).toBeNull();
    expect(nextRemembered(kept, { userId: "u1", state: HIDDEN })).toBeNull();
    expect(nextRemembered(kept, { userId: "u1", state: null })).toBeNull();
    expect(nextRemembered(kept, { userId: "u2", state: null })).toBe(kept);
  });

  it("the controller tells the memory who it resolves for, and every definitive answer (or failure)", async () => {
    const events: string[] = [];
    const auth: AccessAuthClient = {
      getSession: async () => ({ data: { session: { user: { id: "u1" } } }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    };
    const run = async (fetchImpl: () => Promise<Response>) => {
      startParkStayAccess(
        {
          auth,
          fetch: fetchImpl,
          storage: null,
          inflight: new Map(),
          report: () => {},
          onUser: (u) => events.push(`user:${u}`),
          onAnswer: (u, s) => events.push(`answer:${u}:${s ? s.status : "forget"}`),
        },
        () => {}
      );
      for (let i = 0; i < 10; i++) await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    };
    await run(async () => new Response(JSON.stringify(DATA), { status: 200 }));
    await run(async () => new Response("x", { status: 503 }));
    expect(events).toEqual(["user:u1", "answer:u1:visible", "user:u1", "answer:u1:forget"]);
  });
});

describe("Sentry reports (once per kind per page session; never a 404 or a signed-out visitor)", () => {
  const auth = (user: string | null): AccessAuthClient => ({
    getSession: async () => ({ data: { session: user ? { user: { id: user } } : null }, error: null }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
  });
  const settle = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 60));
  };
  const quiet = () => vi.spyOn(console, "warn").mockImplementation(() => {});

  it("reports a 5xx, an unreadable body and a timeout to the injected reporter; not a 404, a network error or a signed-out visitor", async () => {
    const warn = quiet();
    try {
      const report = vi.fn();
      const go = (user: string | null, impl: (u: string, init: RequestInit) => Promise<Response>) =>
        startParkStayAccess({ auth: auth(user), fetch: impl, storage: null, inflight: new Map(), timeoutMs: 30, report }, () => {});
      go("u1", async () => new Response("x", { status: 502 }));
      go("u1", async () => new Response("not json", { status: 200 }));
      go("u1", (_u, init) => new Promise<Response>((_r, rej) => init.signal?.addEventListener("abort", () => rej(new Error("aborted")))));
      await settle();
      expect(report.mock.calls.map((c) => c[0])).toEqual(["HTTP 502", "unreadable body", "timeout"]);

      report.mockClear();
      go("u1", async () => new Response("{}", { status: 404 }));
      go("u1", async () => Promise.reject(new TypeError("Failed to fetch")));
      go(null, async () => new Response("x", { status: 500 }));
      await settle();
      expect(report).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("the default reporter sends ONE Sentry event per kind, tagged feature", () => {
    reportParkStayFailure("park_stay_access", new Error("a"));
    reportParkStayFailure("park_stay_access", new Error("b"));
    reportParkStayFailure("park_stay_slot", new Error("c"));
    reportParkStayFailure("park_stay_slot", new Error("d"));
    expect(captureException).toHaveBeenCalledTimes(2);
    expect(scope.setTag.mock.calls).toEqual([
      ["feature", "park_stay_access"],
      ["feature", "park_stay_slot"],
    ]);
  });

  it("SlotBoundary: a caught error renders nothing, is reported (once) and calls onError", () => {
    const warn = quiet();
    try {
      const onError = vi.fn();
      const boundary = new SlotBoundary({ children: "x", onError });
      expect(SlotBoundary.getDerivedStateFromError()).toEqual({ failed: true });
      boundary.componentDidCatch(new Error("chunk failed"), { componentStack: "at Slot" });
      boundary.componentDidCatch(new Error("again"), { componentStack: "at Slot" });
      expect(onError).toHaveBeenCalledTimes(2);
      expect(captureException).toHaveBeenCalledTimes(1);
      boundary.state = { failed: true };
      expect(boundary.render()).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });
});
