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
  PARK_STAY_ACCESS_CACHE_PREFIX,
  __accessMemoryForTests,
  __dispatchAccessMemoryForTests,
  __resetParkStayAccessMemoryForTests,
  __resetParkStayReportsForTests,
  nextAccessMemory,
  pickAccessState,
  reportParkStayFailure,
  startParkStayAccess,
  watchAuthForAccessMemory,
  type AccessAuthClient,
  type AccessStorage,
  type ParkStayAccessState,
} from "../use-park-stay-access";

type AuthListener = (event: string, session: { user: { id: string } } | null) => void;
function watcherAuth() {
  const listeners: AuthListener[] = [];
  return {
    auth: {
      onAuthStateChange: (cb: AuthListener) => {
        listeners.push(cb);
        return { data: { subscription: { unsubscribe: () => {} } } };
      },
    },
    emit: (event: string, session: { user: { id: string } } | null) => listeners.forEach((l) => l(event, session)),
  };
}

function memoryStore(init: Record<string, string>): AccessStorage & { map: Map<string, string> } {
  const map = new Map(Object.entries(init));
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    get length() {
      return map.size;
    },
    key: (i) => [...map.keys()][i] ?? null,
  };
}

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

describe("the in-memory answer (later mounts start from it, only for the same signed-in user)", () => {
  const set = (userId: string) => nextAccessMemory(null, { type: "answer", userId, state: VISIBLE });

  it("nextAccessMemory: a visible answer is kept per user, unconfirmed until the watcher sees that user", () => {
    const kept = set("u1");
    expect(kept).toEqual({ userId: "u1", state: VISIBLE, confirmed: false });
    const confirmed = nextAccessMemory(kept, { type: "auth", event: "INITIAL_SESSION", userId: "u1" });
    expect(confirmed).toEqual({ userId: "u1", state: VISIBLE, confirmed: true });
    expect(nextAccessMemory(confirmed, { type: "auth", event: "TOKEN_REFRESHED", userId: "u1" })).toBe(confirmed); // unchanged → no re-render
    expect(nextAccessMemory(confirmed, { type: "answer", userId: "u1", state: VISIBLE })).toBe(confirmed);
    expect(nextAccessMemory(confirmed, { type: "user", userId: "u1" })).toBe(confirmed);
  });

  it("nextAccessMemory: sign-out, another user, a hidden answer or a failed check forgets it", () => {
    const m = nextAccessMemory(set("u1"), { type: "auth", event: "SIGNED_IN", userId: "u1" });
    expect(nextAccessMemory(m, { type: "auth", event: "SIGNED_OUT", userId: null })).toBeNull();
    expect(nextAccessMemory(m, { type: "auth", event: "SIGNED_IN", userId: "u2" })).toBeNull();
    expect(nextAccessMemory(m, { type: "auth", event: "INITIAL_SESSION", userId: null })).toBeNull();
    expect(nextAccessMemory(m, { type: "user", userId: "u2" })).toBeNull();
    expect(nextAccessMemory(m, { type: "user", userId: null })).toBeNull();
    expect(nextAccessMemory(m, { type: "answer", userId: "u1", state: HIDDEN })).toBeNull();
    expect(nextAccessMemory(m, { type: "answer", userId: "u1", state: null })).toBeNull();
  });

  it("pickAccessState: memory counts only when it is known to be this session's user", () => {
    const unconfirmed = set("u1");
    const confirmed = nextAccessMemory(unconfirmed, { type: "auth", event: "INITIAL_SESSION", userId: "u1" });
    // Before this mount's session read: only a watcher-confirmed memory.
    expect(pickAccessState(null, confirmed, undefined)).toBe(VISIBLE);
    expect(pickAccessState(null, unconfirmed, undefined)).toEqual(HIDDEN);
    // After it: only the same user's memory.
    expect(pickAccessState(null, unconfirmed, "u1")).toBe(VISIBLE);
    expect(pickAccessState(null, confirmed, "u2")).toEqual(HIDDEN);
    expect(pickAccessState(null, confirmed, null)).toEqual(HIDDEN);
    // "loading" keeps a usable memory; a definitive own answer always wins.
    expect(pickAccessState(LOADING, confirmed, "u1")).toBe(VISIBLE);
    expect(pickAccessState(LOADING, confirmed, "u2")).toBe(LOADING);
    expect(pickAccessState(HIDDEN, confirmed, "u1")).toBe(HIDDEN);
    expect(pickAccessState(VISIBLE, null, "u1")).toBe(VISIBLE);
    expect(pickAccessState(null, null, undefined)).toEqual(HIDDEN);
  });

  it("sign-out with NO hook mounted (admin sign-out, then a client navigation home), then a later mount → hidden", () => {
    __resetParkStayAccessMemoryForTests();
    const { auth, emit } = watcherAuth();
    const storage = memoryStore({ [PARK_STAY_ACCESS_CACHE_PREFIX + "u1"]: "x", keep: "y" });

    // A homepage mount answered visible for u1 and started the watcher (INITIAL_SESSION confirms it).
    __dispatchAccessMemoryForTests({ type: "answer", userId: "u1", state: VISIBLE });
    watchAuthForAccessMemory(auth, storage, new Map());
    emit("INITIAL_SESSION", { user: { id: "u1" } });
    expect(pickAccessState(null, __accessMemoryForTests(), undefined)).toBe(VISIBLE);

    // Every hook unmounts (the visitor goes to /admin); /admin signs out.
    emit("SIGNED_OUT", null);
    expect(__accessMemoryForTests()).toBeNull();
    expect([...storage.map.keys()]).toEqual(["keep"]);
    // The homepage mounts again before its own session read: hidden.
    expect(pickAccessState(null, __accessMemoryForTests(), undefined)).toEqual(HIDDEN);
    __resetParkStayAccessMemoryForTests();
  });

  it("sign-out then sign-in as someone else, with no hook mounted → the next mount is hidden for the new user", () => {
    __resetParkStayAccessMemoryForTests();
    const { auth, emit } = watcherAuth();
    const storage = memoryStore({ [PARK_STAY_ACCESS_CACHE_PREFIX + "u1"]: "x", [PARK_STAY_ACCESS_CACHE_PREFIX + "u2"]: "z" });

    __dispatchAccessMemoryForTests({ type: "answer", userId: "u1", state: VISIBLE });
    watchAuthForAccessMemory(auth, storage, new Map());
    emit("INITIAL_SESSION", { user: { id: "u1" } });
    emit("SIGNED_IN", { user: { id: "u2" } }); // a switch, even without a SIGNED_OUT in between
    expect(__accessMemoryForTests()).toBeNull();
    expect([...storage.map.keys()]).toEqual([PARK_STAY_ACCESS_CACHE_PREFIX + "u2"]); // other users' entries dropped
    expect(pickAccessState(null, __accessMemoryForTests(), undefined)).toEqual(HIDDEN);
    expect(pickAccessState(null, __accessMemoryForTests(), "u2")).toEqual(HIDDEN);

    // Even had the memory survived somehow, a mount whose session is u2 never shows u1's answer.
    const stale = nextAccessMemory(set("u1"), { type: "auth", event: "INITIAL_SESSION", userId: "u1" });
    expect(pickAccessState(null, stale, "u2")).toEqual(HIDDEN);
    __resetParkStayAccessMemoryForTests();
  });

  it("the watcher subscribes once for the life of the page", () => {
    __resetParkStayAccessMemoryForTests();
    const onAuthStateChange = vi.fn(() => ({ data: { subscription: { unsubscribe: () => {} } } }));
    watchAuthForAccessMemory({ onAuthStateChange }, null, new Map());
    watchAuthForAccessMemory({ onAuthStateChange }, null, new Map());
    expect(onAuthStateChange).toHaveBeenCalledTimes(1);
    __resetParkStayAccessMemoryForTests();
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
