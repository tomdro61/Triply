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
  op: "eq" | "in" | "is" | "lt" | "gte" | "ilike" | "or";
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

  /** `${table}:${op}` -> error message. Consumed on first use. */
  private injected = new Map<string, string>();

  /** Every query executed, for assertions like "createReservation was skipped". */
  log: Array<{ table: string; op: string }> = [];

  seed(table: string, rows: Row[]) {
    this.tables[table] = rows.map((r) => ({ ...r }));
    return this;
  }

  /** Make the next `op` on `table` fail, once. */
  failOnce(table: string, op: "select" | "insert" | "update", message: string) {
    this.injected.set(`${table}:${op}`, message);
    return this;
  }

  from(table: string) {
    return new FakeQuery(this, table);
  }

  _take(table: string, op: string): string | null {
    const key = `${table}:${op}`;
    const msg = this.injected.get(key);
    if (msg) {
      this.injected.delete(key);
      return msg;
    }
    return null;
  }
}

class FakeQuery implements PromiseLike<{ data: unknown; error: unknown }> {
  private filters: Filter[] = [];
  private op: "select" | "insert" | "update" = "select";
  private payload: Row | null = null;
  private selectStr = "";
  private singleRow = false;
  private requireOne = false;
  private limitN: number | null = null;

  constructor(private db: FakeSupabase, private table: string) {}

  select(str = "") {
    if (this.op === "select") this.selectStr = str;
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
  gte(col: string, val: unknown) {
    this.filters.push({ op: "gte", col, val });
    return this;
  }
  ilike(col: string, val: unknown) {
    this.filters.push({ op: "ilike", col, val });
    return this;
  }
  or(expr: string) {
    this.filters.push({ op: "or", col: "", val: expr });
    return this;
  }
  order() {
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
        case "gte":
          return actual != null && String(actual) >= String(f.val);
        case "ilike":
          return (
            actual != null &&
            String(actual).toLowerCase() === String(f.val).toLowerCase()
          );
        default:
          return true;
      }
    });
  }

  then<R1 = { data: unknown; error: unknown }, R2 = never>(
    onfulfilled?:
      | ((value: { data: unknown; error: unknown }) => R1 | PromiseLike<R1>)
      | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null
  ): PromiseLike<R1 | R2> {
    return Promise.resolve(this.run()).then(onfulfilled, onrejected);
  }

  private run(): { data: unknown; error: unknown } {
    this.db.log.push({ table: this.table, op: this.op });

    const injected = this.db._take(this.table, this.op);
    if (injected) {
      return { data: null, error: { message: injected, code: "XXFAKE" } };
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
      return { data: this.singleRow ? row : [row], error: null };
    }

    const hit = rows.filter((r) => this.matches(r));

    if (this.op === "update") {
      for (const r of hit) {
        Object.assign(r, this.payload);
        r.updated_at = new Date().toISOString();
      }
      const out = hit.map((r) => ({ ...r }));
      return { data: this.singleRow ? out[0] ?? null : out, error: null };
    }

    const limited = this.limitN == null ? hit : hit.slice(0, this.limitN);
    const out = limited.map((r) => this.embeddedCustomer({ ...r }));
    if (this.requireOne && out.length === 0) {
      // What real PostgREST returns for .single() with no match.
      return {
        data: null,
        error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" },
      };
    }
    return { data: this.singleRow ? out[0] ?? null : out, error: null };
  }
}
