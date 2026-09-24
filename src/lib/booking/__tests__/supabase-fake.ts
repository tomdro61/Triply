/**
 * An in-memory stand-in for the Supabase client, good enough for the booking
 * engine's query surface.
 *
 * It deliberately PARSES the PostgREST filter strings rather than pattern-
 * matching on call order. The mutex's entire correctness lives in one `.or()`
 * expression — `status.eq.pending,and(status.eq.processing,claimed_at.lt.<iso>)`
 * — and a fake that ignored it would only prove that the fake serializes writes,
 * which is worthless. A typo in that string is the failure mode that matters:
 * match nothing and no booking ever completes; match everything and every caller
 * wins the mutex and double-books.
 *
 * Errors can be injected per table+operation so the "a DB fault must never look
 * like a business outcome" invariant is testable.
 */

export type Row = Record<string, unknown>;

interface Filter {
  op: "eq" | "in" | "is" | "lt" | "lte" | "gte" | "ilike" | "or";
  col: string;
  val: unknown;
}

/** Parse one PostgREST `col.op.value` leaf into a predicate. */
function leaf(expr: string): (row: Row) => boolean {
  const first = expr.indexOf(".");
  const second = expr.indexOf(".", first + 1);
  const col = expr.slice(0, first);
  const op = expr.slice(first + 1, second);
  const raw = expr.slice(second + 1);
  return (row) => {
    const actual = row[col];
    switch (op) {
      case "eq":
        return String(actual) === raw;
      case "lt":
        return actual != null && String(actual) < raw;
      case "gte":
        return actual != null && String(actual) >= raw;
      case "is":
        return raw === "null" ? actual == null : String(actual) === raw;
      default:
        throw new Error(`supabase-fake: unsupported or() operator "${op}"`);
    }
  };
}

/**
 * PostgREST's `ilike` takes a LIKE PATTERN, not a literal: `%` matches any
 * run of characters and `_` matches exactly one, both case-insensitively.
 *
 * Modelling it as case-insensitive EQUALITY (what this fake used to do) is
 * the `.or()` incident in reverse — a fake LESS permissive than the database.
 * It let `.ilike("email", "first_last@gmail.com")` look watertight in tests
 * while production also matched `first.last@`, `first-last@` and `firstXlast@`
 * and silently unsubscribed strangers (review pass 4, item 1). Any caller
 * that must match one exact address has to use `.eq`, and this is what makes
 * a test prove it.
 */
function likeRegex(pattern: string): RegExp {
  let out = "";
  for (const ch of pattern) {
    if (ch === "%") out += "[\\s\\S]*";
    else if (ch === "_") out += "[\\s\\S]";
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`, "i");
}

/** Split on commas that are NOT inside parentheses. */
function splitTop(expr: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) {
      out.push(expr.slice(start, i));
      start = i + 1;
    }
  }
  out.push(expr.slice(start));
  return out.filter(Boolean);
}

function parseOr(expr: string): (row: Row) => boolean {
  const terms = splitTop(expr).map((term) => {
    if (term.startsWith("and(") && term.endsWith(")")) {
      const inner = splitTop(term.slice(4, -1)).map(leaf);
      return (row: Row) => inner.every((f) => f(row));
    }
    return leaf(term);
  });
  return (row) => terms.some((f) => f(row));
}

export class FakeSupabase {
  tables: Record<string, Row[]> = {
    pending_bookings: [],
    bookings: [],
    cart_claims: [],
    customers: [],
  };

  /** `${table}:${op}` -> injected error. Consumed on first use. */
  private injected = new Map<string, { message: string; code: string }>();

  /** `${table}:${op}` -> injected error that is NEVER consumed. A one-shot
   *  failure can only prove a single request's behaviour; a SUSTAINED fault
   *  (a column missing all deploy long, an UPDATE failing for half an hour)
   *  is what turns a "harmless, it just retries next time" write into a loop,
   *  and needs a fault that keeps failing. */
  private persistent = new Map<string, { message: string; code: string }>();

  /** Payload-conditional injected errors, consumed on first MATCH. Lets a test
   *  fail a SPECIFIC write among several same-`table:op` writes (e.g. the terminal
   *  status write vs the earlier claim UPDATE — both `bookings:update`) by
   *  matching on the update payload. */
  private conditional: Array<{
    table: string;
    op: string;
    predicate: (payload: Row | null) => boolean;
    message: string;
    code: string;
  }> = [];

  /** Every query executed, for assertions like "createReservation was skipped". */
  log: Array<{ table: string; op: string }> = [];

  seed(table: string, rows: Row[]) {
    this.tables[table] = rows.map((r) => ({ ...r }));
    return this;
  }

  /** Make the next `op` on `table` fail, once. `code` lets a test exercise
   *  error-class-dependent branches (e.g. a Postgres 23514 CHECK violation as a
   *  PERMANENT booking-insert failure vs a transient connection reset). */
  failOnce(
    table: string,
    op: "select" | "insert" | "update" | "delete",
    message: string,
    code = "XXFAKE"
  ) {
    this.injected.set(`${table}:${op}`, { message, code });
    return this;
  }

  /** Make EVERY `op` on `table` fail until `clearFailures()`. `failOnce` only
   *  ever exercises the optimistic path — a retry, or a second write on the
   *  same row, silently succeeds under it. A SUSTAINED fault (write
   *  unavailability, a rotated key) is the case where a retry and its own
   *  bookkeeping write both fail, and it needs its own injector to be
   *  testable at all. */
  failAlways(
    table: string,
    op: "select" | "insert" | "update" | "delete",
    message: string,
    code = "XXFAKE"
  ) {
    this.persistent.set(`${table}:${op}`, { message, code });
    return this;
  }

  /** Drops every injected failure (one-shot, conditional and persistent).
   *  Call between tests — a `failAlways` left set would leak into the next. */
  clearFailures() {
    this.injected.clear();
    this.persistent.clear();
    this.conditional = [];
    return this;
  }

  clearFailAlways(table: string, op: "select" | "insert" | "update" | "delete") {
    this.persistent.delete(`${table}:${op}`);
    return this;
  }

  /** Fail the first `op` on `table` whose payload matches `predicate`, once.
   *  Use to target one write among several same-table:op writes. */
  failWhen(
    table: string,
    op: "select" | "insert" | "update" | "delete",
    predicate: (payload: Row | null) => boolean,
    message: string,
    code = "XXFAKE"
  ) {
    this.conditional.push({ table, op, predicate, message, code });
    return this;
  }

  from(table: string) {
    return new FakeQuery(this, table);
  }

  _takeConditional(
    table: string,
    op: string,
    payload: Row | null
  ): { message: string; code: string } | null {
    const idx = this.conditional.findIndex(
      (c) => c.table === table && c.op === op && c.predicate(payload)
    );
    if (idx >= 0) {
      const [c] = this.conditional.splice(idx, 1);
      return { message: c.message, code: c.code };
    }
    return null;
  }

  _take(table: string, op: string): { message: string; code: string } | null {
    const key = `${table}:${op}`;
    const err = this.injected.get(key);
    if (err) {
      this.injected.delete(key);
      return err;
    }
    return this.persistent.get(key) ?? null;
  }
}

class FakeQuery implements PromiseLike<{ data: unknown; error: unknown; count?: number }> {
  private filters: Filter[] = [];
  private op: "select" | "insert" | "update" | "delete" = "select";
  private payload: Row | null = null;
  private selectStr = "";
  /** `.select()` called AFTER insert/update/delete — PostgREST only returns
   *  the affected rows when it is. */
  private selectOnMutation = false;
  private singleRow = false;
  private requireOne = false;
  private orOnMutation = false;
  private limitN: number | null = null;
  private countMode = false;
  private headOnly = false;
  private orderCol: string | null = null;
  private orderAsc = true;

  constructor(private db: FakeSupabase, private table: string) {}

  select(str = "", opts?: { count?: "exact" | "planned" | "estimated"; head?: boolean }) {
    if (this.op === "select") {
      this.selectStr = str;
      // `{ count: "exact", head: true }` is how a caller asks "how many rows
      // match?" without transferring them. Modelled for real (count computed
      // BEFORE any limit, no rows in `data`) so a route that reads `count`
      // can't pass a test purely because the fake handed back `data` anyway.
      if (opts?.count) this.countMode = true;
      if (opts?.head) this.headOnly = true;
    } else {
      this.selectOnMutation = true;
    }
    return this;
  }
  insert(payload: Row) {
    this.op = "insert";
    this.payload = payload;
    return this;
  }
  update(payload: Row) {
    this.op = "update";
    this.payload = payload;
    return this;
  }
  delete() {
    this.op = "delete";
    return this;
  }
  eq(col: string, val: unknown) {
    this.filters.push({ op: "eq", col, val });
    return this;
  }
  in(col: string, val: unknown[]) {
    this.filters.push({ op: "in", col, val });
    return this;
  }
  is(col: string, val: unknown) {
    this.filters.push({ op: "is", col, val });
    return this;
  }
  lt(col: string, val: unknown) {
    this.filters.push({ op: "lt", col, val });
    return this;
  }
  lte(col: string, val: unknown) {
    this.filters.push({ op: "lte", col, val });
    return this;
  }
  gte(col: string, val: unknown) {
    this.filters.push({ op: "gte", col, val });
    return this;
  }
  ilike(col: string, val: unknown) {
    this.filters.push({ op: "ilike", col, val });
    return this;
  }
  or(expr: string) {
    // Mirror a real-PostgREST constraint the hard way, on purpose: `.or()` works
    // on a SELECT but FAILS on an UPDATE/DELETE with "column ... does not exist".
    // An earlier fake silently accepted `.or()` on updates, so 31 tests passed
    // while the production mutex matched zero rows and every booking stalled on
    // staging. The fake must never be more permissive than the database again.
    this.orOnMutation = this.op !== "select";
    this.filters.push({ op: "or", col: "", val: expr });
    return this;
  }
  // A no-op fake here let `.order("opens_on")`'s selection guarantee (oldest
  // overdue rows attempted first, so the backlog can't starve the same rows
  // run after run) go completely untested — the fake always returned
  // insertion order regardless of what was asked for, which would pass a
  // test that got the intended row purely by luck of seed order.
  order(col: string, opts?: { ascending?: boolean }) {
    this.orderCol = col;
    this.orderAsc = opts?.ascending ?? true;
    return this;
  }
  limit(n: number) {
    this.limitN = n;
    return this;
  }
  maybeSingle() {
    this.singleRow = true;
    return this;
  }
  /** Unlike maybeSingle, `.single()` returns a PGRST116 ERROR when no row
   *  matches. Callers in this codebase rely on that distinction — several
   *  destructure only `{ data }` and treat PGRST116 as a plain "not found". */
  single() {
    this.singleRow = true;
    this.requireOne = true;
    return this;
  }

  private embeddedCustomer(row: Row): Row {
    if (!this.selectStr.includes("customers!inner")) return row;
    const cust = this.db.tables.customers.find((c) => c.id === row.customer_id);
    return { ...row, customers: cust ? { email: cust.email } : null };
  }

  private matches(row: Row): boolean {
    const withEmbed = this.embeddedCustomer(row);
    return this.filters.every((f) => {
      if (f.op === "or") return parseOr(String(f.val))(withEmbed);

      // Embedded column reference, e.g. "customers.email".
      let actual: unknown;
      if (f.col.includes(".")) {
        const [rel, col] = f.col.split(".");
        actual = (withEmbed[rel] as Row | null)?.[col];
        // An !inner join drops rows with no match.
        if (withEmbed[rel] == null) return false;
      } else {
        actual = withEmbed[f.col];
      }

      switch (f.op) {
        case "eq":
          return String(actual) === String(f.val);
        case "in":
          return (f.val as unknown[]).map(String).includes(String(actual));
        case "is":
          return f.val === null ? actual == null : actual === f.val;
        case "lt":
          return actual != null && String(actual) < String(f.val);
        case "lte":
          return actual != null && String(actual) <= String(f.val);
        case "gte":
          return actual != null && String(actual) >= String(f.val);
        case "ilike":
          // A real LIKE pattern match — see likeRegex. Never equality.
          return actual != null && likeRegex(String(f.val)).test(String(actual));
        default:
          return true;
      }
    });
  }

  then<R1 = { data: unknown; error: unknown; count?: number }, R2 = never>(
    onfulfilled?:
      | ((value: { data: unknown; error: unknown; count?: number }) => R1 | PromiseLike<R1>)
      | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null
  ): PromiseLike<R1 | R2> {
    return Promise.resolve(this.run()).then(onfulfilled, onrejected);
  }

  private run(): { data: unknown; error: unknown; count?: number } {
    this.db.log.push({ table: this.table, op: this.op });

    // Real PostgREST rejects `.or()` on a mutating request. Reproduce it so a
    // regression to `.update(...).or(...)` fails a test instead of silently
    // matching nothing in production.
    if (this.orOnMutation) {
      return {
        data: null,
        error: {
          message: `column ${this.table}.status does not exist`,
          code: "42703",
        },
      };
    }

    const conditional = this.db._takeConditional(
      this.table,
      this.op,
      this.payload
    );
    if (conditional) {
      return { data: null, error: conditional };
    }

    const injected = this.db._take(this.table, this.op);
    if (injected) {
      return { data: null, error: injected };
    }

    const rows = (this.db.tables[this.table] ??= []);

    if (this.op === "insert") {
      const row = { ...this.payload } as Row;
      // Emulate the UNIQUE constraints the engine relies on.
      const dupe =
        (this.table === "pending_bookings" &&
          rows.some(
            (r) =>
              r.stripe_payment_intent_id === row.stripe_payment_intent_id
          )) ||
        (this.table === "cart_claims" &&
          rows.some(
            (r) => r.cart_key === row.cart_key && r.released_at == null
          )) ||
        (this.table === "bookings" &&
          row.stripe_payment_intent_id != null &&
          rows.some(
            (r) =>
              r.stripe_payment_intent_id === row.stripe_payment_intent_id
          ));
      if (dupe) {
        return {
          data: null,
          error: { message: "duplicate key value", code: "23505" },
        };
      }
      if (!row.id) row.id = `row_${rows.length + 1}`;
      if (!row.created_at) row.created_at = new Date().toISOString();
      row.updated_at = new Date().toISOString();
      rows.push(row);
      if (!this.selectOnMutation) return { data: null, error: null };
      return { data: this.singleRow ? row : [row], error: null };
    }

    const hit = rows.filter((r) => this.matches(r));

    if (this.op === "update") {
      for (const r of hit) {
        Object.assign(r, this.payload);
        r.updated_at = new Date().toISOString();
      }
      if (!this.selectOnMutation) return { data: null, error: null };
      const out = hit.map((r) => ({ ...r }));
      return { data: this.singleRow ? out[0] ?? null : out, error: null };
    }

    if (this.op === "delete") {
      const out = hit.map((r) => ({ ...r }));
      this.db.tables[this.table] = rows.filter((r) => !this.matches(r));
      // Without `.select()` PostgREST returns NO rows from a DELETE, so a
      // caller that skips it cannot tell a 0-row delete from a successful
      // one. Reproduce that: a fake that always handed back the deleted rows
      // would bless exactly the bug the orphan-cleanup `.select("id")` in
      // /api/newsletter exists to catch.
      if (!this.selectOnMutation) return { data: null, error: null };
      return { data: this.singleRow ? out[0] ?? null : out, error: null };
    }

    const ordered = this.orderCol
      ? [...hit].sort((a, b) => {
          const col = this.orderCol as string;
          const av = a[col];
          const bv = b[col];
          if (av == null && bv == null) return 0;
          // Postgres: ASC => NULLS LAST, DESC => NULLS FIRST. Never the
          // reverse — a fake that orders nulls first would bless a row
          // PostgREST puts last.
          if (av == null) return this.orderAsc ? 1 : -1;
          if (bv == null) return this.orderAsc ? -1 : 1;
          if (av < bv) return this.orderAsc ? -1 : 1;
          if (av > bv) return this.orderAsc ? 1 : -1;
          return 0;
        })
      : hit;
    // The count is over EVERY match, before `.limit()` — that is what
    // PostgREST returns, and a backlog check that counted only the limited
    // page would under-report exactly when the backlog is worst.
    if (this.countMode || this.headOnly) {
      return {
        data: this.headOnly ? null : hit.map((r) => this.embeddedCustomer({ ...r })),
        count: hit.length,
        error: null,
      };
    }
    const limited = this.limitN == null ? ordered : ordered.slice(0, this.limitN);
    const out = limited.map((r) => this.embeddedCustomer({ ...r }));
    // Real PostgREST returns a PGRST116 error for .single() on EITHER zero OR
    // multiple matches — the multiple case matters because customers.email is
    // not UNIQUE in prod, so a duplicate-email lookup errors rather than
    // silently returning the first row.
    if (this.requireOne && out.length !== 1) {
      return {
        data: null,
        error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" },
      };
    }
    return { data: this.singleRow ? out[0] ?? null : out, error: null };
  }
}
