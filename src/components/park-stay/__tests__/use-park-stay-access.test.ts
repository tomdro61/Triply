import { describe, expect, it, vi } from "vitest";

// The hook module imports the browser Supabase client; the controller under
// test never calls it (deps are injected), so a stub is enough.
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));

import {
  PARK_STAY_ACCESS_CACHE_PREFIX,
  PARK_STAY_ACCESS_URL,
  startParkStayAccess,
  type AccessAuthClient,
  type AccessStorage,
  type ParkStayAccessState,
} from "../use-park-stay-access";
import type { ParkStayAccess } from "@/lib/hotels/access";

const ACCESS: ParkStayAccess = {
  airports: [{ code: "JFK", name: "JFK Airport" }],
  hotels: [{ key: "h1", airport: "JFK", reslabLotId: 1, name: "Hotel One", photoUrl: null, shuttle: "Shuttle 24/7" }],
};

type Listener = (event: string, session: { user: { id: string } } | null) => void;

function fakeAuth(initialUser: string | null, opts: { error?: boolean; hang?: boolean } = {}) {
  let listener: Listener | null = null;
  const unsubscribe = vi.fn();
  const auth: AccessAuthClient = {
    getSession: () =>
      opts.hang
        ? new Promise(() => {})
        : Promise.resolve(
            opts.error
              ? { data: { session: null }, error: new Error("auth down") }
              : { data: { session: initialUser ? { user: { id: initialUser } } : null }, error: null }
          ),
    onAuthStateChange: (cb) => {
      listener = cb;
      return { data: { subscription: { unsubscribe } } };
    },
  };
  return {
    auth,
    unsubscribe,
    emit: (event: string, userId: string | null) => listener?.(event, userId ? { user: { id: userId } } : null),
  };
}

function memoryStorage(): AccessStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
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

const ok = () => new Response(JSON.stringify(ACCESS), { status: 200, headers: { "Content-Type": "application/json" } });
const notFound = () => new Response(JSON.stringify({ error: "Not found" }), { status: 404 });

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

function run(auth: AccessAuthClient, fetchImpl: (url: string, init: RequestInit) => Promise<Response>, storage: AccessStorage | null = memoryStorage(), timeoutMs = 50) {
  const states: ParkStayAccessState[] = [];
  const fetchMock = vi.fn(fetchImpl);
  const stop = startParkStayAccess({ auth, fetch: fetchMock, storage, timeoutMs }, (s) => states.push(s));
  return { states, fetchMock, stop, last: () => states[states.length - 1] };
}

describe("useParkStayAccess controller (CX plan v2 §1)", () => {
  it("no session → hidden with ZERO requests to the endpoint", async () => {
    const a = fakeAuth(null);
    const r = run(a.auth, async () => ok());
    await settle();
    expect(r.fetchMock).not.toHaveBeenCalled();
    expect(r.last()).toEqual({ status: "hidden" });
  });

  it("a session read that errors or hangs → hidden, no request", async () => {
    for (const opts of [{ error: true }, { hang: true }]) {
      const a = fakeAuth("u1", opts);
      const r = run(a.auth, async () => ok());
      await new Promise((res) => setTimeout(res, 80));
      expect(r.fetchMock).not.toHaveBeenCalled();
      expect(r.last()).toEqual({ status: "hidden" });
    }
  });

  it("session → loading, then visible; one fetch, no-store, cached per user", async () => {
    const storage = memoryStorage();
    const a = fakeAuth("u1");
    const r = run(a.auth, async () => ok(), storage);
    await settle();
    expect(r.states.map((s) => s.status)).toEqual(["loading", "visible"]);
    expect(r.last()).toEqual({ status: "visible", data: ACCESS });
    expect(r.fetchMock).toHaveBeenCalledTimes(1);
    expect(r.fetchMock.mock.calls[0][0]).toBe(PARK_STAY_ACCESS_URL);
    expect(r.fetchMock.mock.calls[0][1]).toMatchObject({ cache: "no-store" });
    expect(storage.map.has(PARK_STAY_ACCESS_CACHE_PREFIX + "u1")).toBe(true);

    // A second page view in the same tab: answered from the cache, no request.
    const r2 = run(fakeAuth("u1").auth, async () => ok(), storage);
    await settle();
    expect(r2.fetchMock).not.toHaveBeenCalled();
    expect(r2.last()).toEqual({ status: "visible", data: ACCESS });
  });

  it("a 404 (not an admin) is a definitive hidden and is cached", async () => {
    const storage = memoryStorage();
    const r = run(fakeAuth("u1").auth, async () => notFound(), storage);
    await settle();
    expect(r.last()).toEqual({ status: "hidden" });
    const r2 = run(fakeAuth("u1").auth, async () => ok(), storage);
    await settle();
    expect(r2.fetchMock).not.toHaveBeenCalled();
    expect(r2.last()).toEqual({ status: "hidden" });
  });

  it("errors, timeouts and unreadable bodies are NEVER cached", async () => {
    const failures: Array<(url: string, init: RequestInit) => Promise<Response>> = [
      async () => new Response("oops", { status: 503 }),
      async () => {
        throw new TypeError("network");
      },
      async () => new Response(JSON.stringify({ airports: "nope" }), { status: 200 }),
      (_url, init) =>
        new Promise<Response>((_res, rej) => {
          init.signal?.addEventListener("abort", () => rej(new Error("aborted")));
        }),
    ];
    for (const f of failures) {
      const storage = memoryStorage();
      const r = run(fakeAuth("u1").auth, f, storage, 30);
      await new Promise((res) => setTimeout(res, 60));
      expect(r.last()).toEqual({ status: "hidden" });
      expect(storage.map.size).toBe(0);
      // The next page view asks again.
      const r2 = run(fakeAuth("u1").auth, async () => ok(), storage);
      await settle();
      expect(r2.fetchMock).toHaveBeenCalledTimes(1);
      expect(r2.last()).toEqual({ status: "visible", data: ACCESS });
    }
  });

  it("a cache entry for another user is never used; a user-id change re-asks", async () => {
    const storage = memoryStorage();
    storage.setItem(PARK_STAY_ACCESS_CACHE_PREFIX + "admin", JSON.stringify({ visible: true, data: ACCESS }));
    const a = fakeAuth("customer");
    const r = run(a.auth, async () => notFound(), storage);
    await settle();
    expect(r.fetchMock).toHaveBeenCalledTimes(1);
    expect(r.last()).toEqual({ status: "hidden" });

    r.fetchMock.mockImplementation(async () => ok());
    a.emit("TOKEN_REFRESHED", "someone-else");
    await settle();
    expect(r.fetchMock).toHaveBeenCalledTimes(2);
    expect(r.last()).toEqual({ status: "visible", data: ACCESS });
  });

  it("SIGNED_OUT clears every cached answer and hides; SIGNED_IN as another user clears and re-asks", async () => {
    const storage = memoryStorage();
    storage.setItem("unrelated", "keep");
    const a = fakeAuth("u1");
    const r = run(a.auth, async () => ok(), storage);
    await settle();
    expect(r.last()?.status).toBe("visible");

    a.emit("SIGNED_OUT", null);
    await settle();
    expect(r.last()).toEqual({ status: "hidden" });
    expect([...storage.map.keys()]).toEqual(["unrelated"]);

    r.fetchMock.mockImplementation(async () => notFound());
    a.emit("SIGNED_IN", "u2");
    await settle();
    expect(r.fetchMock).toHaveBeenCalledTimes(2);
    expect(r.last()).toEqual({ status: "hidden" });
  });

  it("SIGNED_IN for the SAME user (supabase-js re-emits it on tab focus) does not refetch", async () => {
    const a = fakeAuth("u1");
    const r = run(a.auth, async () => ok());
    await settle();
    a.emit("SIGNED_IN", "u1");
    a.emit("INITIAL_SESSION", "u1");
    await settle();
    expect(r.fetchMock).toHaveBeenCalledTimes(1);
    expect(r.last()?.status).toBe("visible");
  });

  it("blocked sessionStorage (throws) still works, just uncached", async () => {
    const throwing: AccessStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
      get length(): number {
        throw new Error("blocked");
      },
      key: () => {
        throw new Error("blocked");
      },
    };
    const a = fakeAuth("u1");
    const r = run(a.auth, async () => ok(), throwing);
    await settle();
    expect(r.last()).toEqual({ status: "visible", data: ACCESS });
    a.emit("SIGNED_OUT", null);
    await settle();
    expect(r.last()).toEqual({ status: "hidden" });
  });

  it("stop() unsubscribes and drops a late answer", async () => {
    let release: (r: Response) => void = () => {};
    const a = fakeAuth("u1");
    const r = run(a.auth, () => new Promise<Response>((res) => (release = res)));
    await settle();
    expect(r.last()).toEqual({ status: "loading" });
    r.stop();
    release(ok());
    await settle();
    expect(a.unsubscribe).toHaveBeenCalledTimes(1);
    expect(r.last()).toEqual({ status: "loading" });
  });
});
