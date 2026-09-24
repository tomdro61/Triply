import { describe, it, expect } from "vitest";
import { FakeSupabase } from "./supabase-fake";

/**
 * Tests for the FAKE, not for any route.
 *
 * Every other suite's guarantees are only as good as this stand-in, and the
 * two ways it can lie are symmetrical: more permissive than PostgREST (the
 * `.or()`-on-UPDATE incident, where 31 green tests hid a mutex that matched
 * zero rows in production) or LESS permissive (modelling `ilike` as equality,
 * which hid an unsubscribe that suppressed strangers' rows — review pass 4,
 * item 1). Both classes get pinned here.
 */

function db() {
  const fake = new FakeSupabase();
  fake.tables.booking_waitlist = [];
  return fake;
}

describe("FakeSupabase — ilike is a LIKE PATTERN, not equality", () => {
  it("treats `_` as a single-character wildcard, exactly as Postgres does", async () => {
    const fake = db().seed("booking_waitlist", [
      { id: "1", email: "first_last@gmail.com" },
      { id: "2", email: "first.last@gmail.com" },
      { id: "3", email: "firstXlast@gmail.com" },
      { id: "4", email: "firstlast@gmail.com" },
    ]);

    const { data } = await fake
      .from("booking_waitlist")
      .select("id")
      .ilike("email", "first_last@gmail.com");

    // Not just row 1 — which is the whole point: a caller that needs one
    // exact address must use `.eq`, and a test against this fake now proves
    // it instead of hiding it.
    expect((data as Array<{ id: string }>).map((r) => r.id)).toEqual(["1", "2", "3"]);
  });

  it("treats `%` as a multi-character wildcard and stays case-insensitive", async () => {
    const fake = db().seed("booking_waitlist", [
      { id: "1", email: "Traveller@Example.com" },
      { id: "2", email: "someone@example.com" },
    ]);

    const wildcard = await fake
      .from("booking_waitlist")
      .select("id")
      .ilike("email", "%@example.com");
    expect((wildcard.data as Array<{ id: string }>)).toHaveLength(2);

    const exact = await fake
      .from("booking_waitlist")
      .select("id")
      .ilike("email", "traveller@example.com");
    expect((exact.data as Array<{ id: string }>).map((r) => r.id)).toEqual(["1"]);
  });

  it("`.eq` is case-SENSITIVE — the reason the DB enforces lowercase emails", async () => {
    const fake = db().seed("booking_waitlist", [
      { id: "1", email: "Traveller@Example.com" },
    ]);

    const { data } = await fake
      .from("booking_waitlist")
      .select("id")
      .eq("email", "traveller@example.com");
    expect(data).toEqual([]);
  });
});

describe("FakeSupabase — count/head and sustained failures", () => {
  it("`{ count: 'exact', head: true }` returns the number of ALL matches and no rows", async () => {
    const fake = db().seed("booking_waitlist", [
      { id: "1", opens_on: "2026-01-01" },
      { id: "2", opens_on: "2026-01-02" },
      { id: "3", opens_on: "2026-02-01" },
    ]);

    const { data, count, error } = await fake
      .from("booking_waitlist")
      .select("id", { count: "exact", head: true })
      .lt("opens_on", "2026-01-15")
      // The count must ignore `.limit()`, like PostgREST's — a backlog check
      // that counted only the page it fetched would under-report exactly when
      // the backlog is worst.
      .limit(1);

    expect(error).toBeNull();
    expect(count).toBe(2);
    expect(data).toBeNull();
  });

  it("failAlways keeps failing until clearFailures, unlike failOnce", async () => {
    const fake = db().seed("booking_waitlist", [{ id: "1", notified_at: null }]);
    fake.failAlways("booking_waitlist", "update", "connection reset", "08006");

    const first = await fake.from("booking_waitlist").update({ notified_at: "x" }).eq("id", "1");
    const second = await fake.from("booking_waitlist").update({ notified_at: "x" }).eq("id", "1");
    expect(first.error).not.toBeNull();
    expect(second.error).not.toBeNull();
    expect(fake.tables.booking_waitlist[0].notified_at).toBeNull();

    fake.clearFailures();
    const third = await fake.from("booking_waitlist").update({ notified_at: "x" }).eq("id", "1");
    expect(third.error).toBeNull();
    expect(fake.tables.booking_waitlist[0].notified_at).toBe("x");
  });
});
