"use client";

/**
 * useParkStayAccess() — should this browser show any Park & Stay entry point?
 * (CX plan v2 §1, "Lock 2"). A DISPLAY decision only: every Park & Stay page
 * and API keeps its own server-side 404 gate (Lock 1). The session signal
 * read here is spoofable on purpose-built clients; it only decides whether
 * to ASK — the server answers.
 *
 * - No Supabase session → "hidden", and ZERO requests to the endpoint (so a
 *   signed-out customer's network log never names it).
 * - A session → one bounded GET, cached in sessionStorage keyed by the user
 *   id, with a TTL: 200 → visible for 10 minutes; 404 → hidden for only 5
 *   (a 404 can also be one failed server-side auth check — review round 1,
 *   item 3 — so it must not hide the feature for the whole tab). An error, a
 *   timeout or an unreadable body is NEVER cached — hidden for this view,
 *   asked again on the next, and logged with console.warn (a plain 404 and
 *   a signed-out visitor are not failures and log nothing).
 * - Every consumer on the page shares ONE open request per user id (CX plan
 *   §12.5, R12-M4): the homepage's hero tab and section ask once.
 * - SIGNED_OUT clears every cached answer. SIGNED_IN or any event carrying a
 *   different user id re-asks for that user. A SIGNED_IN for the SAME user is
 *   ignored: supabase-js re-emits SIGNED_IN on every tab-visibility change
 *   (`_recoverAndRefresh`), and refetching on each would turn tab switches
 *   into requests. The cache is per user id, so a different user never reads
 *   another's answer.
 *
 * Nothing in this file names a hotel or carries Park & Stay copy — it is the
 * piece the shared pages will import (PR B).
 */

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { ParkStayAccess, ParkStayAccessAirport, ParkStayAccessHotel } from "@/lib/hotels/access";

export const PARK_STAY_ACCESS_URL = "/api/park-stay/access";
/** Both the session read and the endpoint call are bounded by this. */
export const PARK_STAY_ACCESS_TIMEOUT_MS = 5_000;
export const PARK_STAY_ACCESS_CACHE_PREFIX = "triply:psa:v2:";
export const PARK_STAY_ACCESS_VISIBLE_TTL_MS = 10 * 60 * 1000;
export const PARK_STAY_ACCESS_HIDDEN_TTL_MS = 5 * 60 * 1000;

export type ParkStayAccessState = { status: "hidden" } | { status: "loading" } | { status: "visible"; data: ParkStayAccess };

const HIDDEN: ParkStayAccessState = { status: "hidden" };

/** The slice of the Supabase auth client this needs (structural, so tests can fake it). */
export interface AccessAuthClient {
  getSession(): Promise<{ data: { session: { user: { id: string } } | null }; error: unknown }>;
  onAuthStateChange(callback: (event: string, session: { user: { id: string } } | null) => void): {
    data: { subscription: { unsubscribe(): void } };
  };
}

export interface AccessStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  readonly length: number;
  key(index: number): string | null;
}

export interface AccessDeps {
  auth: AccessAuthClient;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** Null when sessionStorage is unavailable (private mode, blocked site data). */
  storage: AccessStorage | null;
  timeoutMs?: number;
  /** Epoch ms; injectable for the TTL tests. */
  now?: () => number;
  /**
   * The in-flight requests shared by every consumer on the page (R12-M4).
   * Defaults to one module-wide registry; tests pass their own.
   */
  inflight?: AccessInflight;
}

/**
 * In-flight access requests by user id (CX plan §12.5, R12-M4): the homepage
 * mounts several consumers at once (the hero tab's button and panel, the
 * homepage section), and they must make ONE request and see the same answer.
 * An entry lives only while its request is open; SIGNED_OUT drops them all.
 */
export type AccessInflight = Map<string, Promise<CachedAnswer | null>>;

const SHARED_INFLIGHT: AccessInflight = new Map();

// ───────────────────────── response guard (no zod in the shared bundle) ─────────────────────────

function isAirport(v: unknown): v is ParkStayAccessAirport {
  return typeof v === "object" && v !== null && "code" in v && typeof v.code === "string" && "name" in v && typeof v.name === "string";
}

function isHotel(v: unknown): v is ParkStayAccessHotel {
  return (
    typeof v === "object" &&
    v !== null &&
    "key" in v &&
    typeof v.key === "string" &&
    "airport" in v &&
    typeof v.airport === "string" &&
    "reslabLotId" in v &&
    (v.reslabLotId === null || (typeof v.reslabLotId === "number" && Number.isInteger(v.reslabLotId))) &&
    "name" in v &&
    typeof v.name === "string" &&
    "photoUrl" in v &&
    (v.photoUrl === null || typeof v.photoUrl === "string") &&
    "shuttle" in v &&
    typeof v.shuttle === "string"
  );
}

export function isParkStayAccess(v: unknown): v is ParkStayAccess {
  return (
    typeof v === "object" &&
    v !== null &&
    "airports" in v &&
    Array.isArray(v.airports) &&
    v.airports.every(isAirport) &&
    "hotels" in v &&
    Array.isArray(v.hotels) &&
    v.hotels.every(isHotel)
  );
}

// ───────────────────────── the cache (every access wrapped: storage can throw) ─────────────────────────

export type CachedAnswer = { visible: false } | { visible: true; data: ParkStayAccess };

/** A stored answer counts only within its TTL (and never from the "future": a clock moved back expires it). */
function readCache(storage: AccessStorage | null, userId: string, now: number): CachedAnswer | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(PARK_STAY_ACCESS_CACHE_PREFIX + userId);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || !("visible" in parsed) || !("at" in parsed) || typeof parsed.at !== "number") return null;
    const age = now - parsed.at;
    if (age < 0) return null;
    if (parsed.visible === false) return age < PARK_STAY_ACCESS_HIDDEN_TTL_MS ? { visible: false } : null;
    if (parsed.visible === true && age < PARK_STAY_ACCESS_VISIBLE_TTL_MS && "data" in parsed && isParkStayAccess(parsed.data)) {
      return { visible: true, data: parsed.data };
    }
    return null;
  } catch {
    return null;
  }
}

function writeCache(storage: AccessStorage | null, userId: string, answer: CachedAnswer, now: number): void {
  if (!storage) return;
  try {
    storage.setItem(PARK_STAY_ACCESS_CACHE_PREFIX + userId, JSON.stringify({ ...answer, at: now }));
  } catch {
    // Quota / blocked storage: the answer simply isn't reused.
  }
}

export function clearParkStayAccessCache(storage: AccessStorage | null): void {
  if (!storage) return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k !== null && k.startsWith(PARK_STAY_ACCESS_CACHE_PREFIX)) keys.push(k);
    }
    for (const k of keys) storage.removeItem(k);
  } catch {
    // Nothing to do: an unreadable cache is also an unusable one.
  }
}

// ───────────────────────── the controller ─────────────────────────

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

function warn(reason: string): void {
  console.warn("[park-stay] access check failed:", reason);
}

/** One bounded GET. Only a 200 with a readable body or a 404 is definitive; every other outcome is logged. */
async function ask(deps: AccessDeps, timeoutMs: number): Promise<CachedAnswer | null> {
  const controller = new AbortController();
  let timedOut = false;
  const t = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const res = await deps.fetch(PARK_STAY_ACCESS_URL, { cache: "no-store", credentials: "same-origin", signal: controller.signal });
    if (res.status === 404) return { visible: false };
    if (res.status !== 200) {
      warn(`HTTP ${res.status}`);
      return null;
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      warn(timedOut ? "timeout" : "unreadable body");
      return null;
    }
    if (isParkStayAccess(body)) return { visible: true, data: body };
    warn("unreadable body");
    return null;
  } catch (err) {
    warn(timedOut ? "timeout" : `network error: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Joins the open request for this user, or starts one (R12-M4). `ask` never rejects. */
function askShared(deps: AccessDeps, inflight: AccessInflight, userId: string, timeoutMs: number): Promise<CachedAnswer | null> {
  const open = inflight.get(userId);
  if (open) return open;
  const p = ask(deps, timeoutMs).finally(() => {
    if (inflight.get(userId) === p) inflight.delete(userId);
  });
  inflight.set(userId, p);
  return p;
}

/**
 * Starts the access check and follows auth changes. `onState` gets every
 * state change; the returned function stops it (unsubscribes, and late
 * answers are dropped).
 */
export function startParkStayAccess(deps: AccessDeps, onState: (s: ParkStayAccessState) => void): () => void {
  const timeoutMs = deps.timeoutMs ?? PARK_STAY_ACCESS_TIMEOUT_MS;
  const now = deps.now ?? (() => Date.now());
  const inflight = deps.inflight ?? SHARED_INFLIGHT;
  let stopped = false;
  // Each resolve gets a generation; only the latest may publish.
  let generation = 0;
  // undefined = not known yet; null = signed out.
  let currentUserId: string | null | undefined;

  const publish = (gen: number, s: ParkStayAccessState) => {
    if (!stopped && gen === generation) onState(s);
  };

  async function resolveFor(userId: string | null): Promise<void> {
    const gen = ++generation;
    currentUserId = userId;
    if (!userId) {
      publish(gen, HIDDEN);
      return;
    }
    const cached = readCache(deps.storage, userId, now());
    if (cached) {
      publish(gen, cached.visible ? { status: "visible", data: cached.data } : HIDDEN);
      return;
    }
    publish(gen, { status: "loading" });
    const answer = await askShared(deps, inflight, userId, timeoutMs);
    if (stopped || gen !== generation) return;
    if (answer === null) {
      publish(gen, HIDDEN); // not cached: asked again on the next page view
      return;
    }
    writeCache(deps.storage, userId, answer, now());
    publish(gen, answer.visible ? { status: "visible", data: answer.data } : HIDDEN);
  }

  const { data } = deps.auth.onAuthStateChange((event, session) => {
    if (stopped) return;
    const id = session?.user.id ?? null;
    if (event === "SIGNED_OUT") {
      clearParkStayAccessCache(deps.storage);
      // A request still open for the old session must not be joined later.
      inflight.clear();
      void resolveFor(null);
      return;
    }
    // INITIAL_SESSION is handled by the getSession() read below.
    if (event === "INITIAL_SESSION" && currentUserId === undefined) return;
    if (id !== currentUserId) {
      if (event === "SIGNED_IN") clearParkStayAccessCache(deps.storage);
      void resolveFor(id);
    }
  });

  void (async () => {
    const gen = generation;
    let userId: string | null = null;
    try {
      const { data: s, error } = await withTimeout(deps.auth.getSession(), timeoutMs);
      // Supabase resolves { error } rather than throwing: an error is "no session".
      if (error) warn(`session read: ${error instanceof Error ? error.message : String(error)}`);
      userId = error ? null : (s.session?.user.id ?? null);
    } catch (err) {
      // A hung or failed session read hides, uncached.
      warn(`session read: ${err instanceof Error ? err.message : String(err)}`);
      userId = null;
    }
    // An auth event may already have resolved a newer state; don't overwrite it.
    if (stopped || gen !== generation) return;
    await resolveFor(userId);
  })();

  return () => {
    stopped = true;
    data.subscription.unsubscribe();
  };
}

function browserStorage(): AccessStorage | null {
  try {
    return typeof window !== "undefined" ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

/** Starts "hidden" (also on the server), so customers never see a placeholder flash. */
export function useParkStayAccess(): ParkStayAccessState {
  const [state, setState] = useState<ParkStayAccessState>(HIDDEN);
  useEffect(() => {
    const supabase = createClient();
    return startParkStayAccess(
      { auth: supabase.auth, fetch: (url, init) => fetch(url, init), storage: browserStorage() },
      setState
    );
  }, []);
  return state;
}
