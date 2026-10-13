/**
 * Test database for the manifest cron: the shared booking-engine fake
 * (supabase-fake.ts) for bookings / pending_bookings / direct_booking_terms /
 * customers / the direct_lots_v2() RPC, plus a strict fake of migration 041's
 * three tables (+ migration 042), which the shared fake does not model:
 *
 *   - PRIMARY KEY / UNIQUE → 23505 on INSERT (the manifest claim and the
 *     follow-up's once-only claim live entirely in them),
 *   - the CHECKs, evaluated on INSERT AND UPDATE against the merged row: 041's
 *     `status NOT IN ('sent','checked') OR sent_at IS NOT NULL OR had_unknown`
 *     (exactly what the cutoff path must satisfy) and 042's `'sent' ⇒ sent_at`,
 *     `'failed' ⇒ NOT had_unknown` and the alerts' resolved_at/resolved_by pair,
 *   - a compound `onConflict` upsert that updates ONLY the columns sent,
 *   - `.or()` refused on UPDATE, as real PostgREST does,
 *   - every UPDATE's filters recorded, so a test can assert each status write
 *     is a compare-and-set on (attempt, status, claimed_at).
 *
 * Tables live in `base.tables`, so assertions read one place.
 */
import { FakeSupabase, type Row } from "@/lib/booking/__tests__/supabase-fake";

export const RUNS = "direct_lot_manifest_runs";
export const ALERTS = "direct_lot_alerts";
export const RESENDS = "direct_lot_resends";

const KEYS: Record<string, string[]> = {
  [RUNS]: ["direct_lot_id", "manifest_date", "livemode", "recipients_hash"],
  [ALERTS]: ["subject", "kind", "livemode"],
  [RESENDS]: ["booking_id", "kind", "source"],
};

const now = () => new Date().toISOString();
let seq = 0;

function defaults(table: string): Row {
  const t = now();
  if (table === RUNS) {
    return { attempt: 1, had_unknown: false, claimed_at: t, attempt_claimed_at: t, first_sent_at: null, sent_at: null, email_id: null, last_error: null, created_at: t, updated_at: t };
  }
  if (table === ALERTS) return { first_seen_at: t, last_seen_at: t, alerted_at: null, detail: {}, resolved_at: null, resolved_by: null, created_at: t, updated_at: t };
  seq++;
  return { id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`, attempts: 0, outcome: "sending", recipients: null, email_id: null, last_error: null, created_at: t, updated_at: t };
}

function violated(table: string, r: Row): string | null {
  if (table === RUNS) {
    if (!["sending", "sent", "checked", "failed"].includes(String(r.status))) return "direct_lot_manifest_runs_status_check";
    if ((r.status === "sent" || r.status === "checked") && r.sent_at == null && r.had_unknown !== true) return "direct_lot_manifest_runs_check";
    // 042
    if (r.status === "sent" && r.sent_at == null) return "direct_lot_manifest_runs_sent_has_time";
    if (r.status === "failed" && r.had_unknown !== false) return "direct_lot_manifest_runs_failed_not_unknown";
    if (!/^[0-9]+$/.test(String(r.direct_lot_id))) return "direct_lot_manifest_runs_direct_lot_id_check";
    if (!/^[0-9a-f]{16}$/.test(String(r.recipients_hash))) return "direct_lot_manifest_runs_recipients_hash_check";
    if (!(Number(r.attempt) >= 1)) return "direct_lot_manifest_runs_attempt_check";
    if (!Array.isArray(r.recipients) || r.recipients.length < 1) return "direct_lot_manifest_runs_recipients_check";
    if (!Array.isArray(r.booking_ids) || !Array.isArray(r.ids_ever)) return "direct_lot_manifest_runs_not_null";
    if (typeof r.livemode !== "boolean" || typeof r.test !== "boolean" || r.manifest_date == null) return "direct_lot_manifest_runs_not_null";
  }
  if (table === ALERTS) {
    if (!["lot_notice", "cancel_notice", "manifest", "lot_config", "followup"].includes(String(r.kind))) return "direct_lot_alerts_kind_check";
    if (!String(r.subject ?? "").trim()) return "direct_lot_alerts_subject_check";
    if (r.detail == null || typeof r.detail !== "object" || Array.isArray(r.detail)) return "direct_lot_alerts_detail_check";
    // 042: resolved_at and resolved_by together, and a non-blank resolver.
    if ((r.resolved_at == null) !== (r.resolved_by == null)) return "direct_lot_alerts_resolved_check";
    if (r.resolved_by != null && !String(r.resolved_by).trim()) return "direct_lot_alerts_resolved_check";
  }
  if (table === RESENDS) {
    if (!["lot_cancel_reminder", "customer_confirmation", "manifest_followup_cancel"].includes(String(r.kind))) return "direct_lot_resends_kind_check";
    if (!["sending", "sent", "failed", "unknown"].includes(String(r.outcome))) return "direct_lot_resends_outcome_check";
    if (!(Number(r.attempts) >= 0)) return "direct_lot_resends_attempts_check";
    if (!String(r.source ?? "").trim() || !String(r.sent_by ?? "").trim()) return "direct_lot_resends_source_check";
    if (r.booking_id == null || r.stripe_payment_intent_id == null || typeof r.livemode !== "boolean") return "direct_lot_resends_not_null";
  }
  return null;
}

type Filter = { op: "eq" | "in" | "gte" | "lt" | "is"; col: string; val: unknown };
type Result = { data: unknown; error: { message: string; code: string } | null };

export class ManifestDb {
  readonly base = new FakeSupabase();
  /** Every UPDATE on the 041 tables: table, payload, filter columns. */
  readonly updates: Array<{ table: string; payload: Row; filters: string[] }> = [];
  /** Runs just before a mutation is applied — a test's "concurrent writer". */
  beforeMutation: ((table: string, op: "insert" | "update", payload: Row) => void) | null = null;
  private failures: Array<{ table: string; op: string; code: string }> = [];

  get tables() {
    return this.base.tables;
  }
  rows(table: string): Row[] {
    return (this.base.tables[table] ??= []);
  }
  failNext(table: string, op: "select" | "insert" | "update", code = "XXFAKE") {
    this.failures.push({ table, op, code });
  }
  takeFailure(table: string, op: string) {
    const i = this.failures.findIndex((f) => f.table === table && f.op === op);
    return i >= 0 ? this.failures.splice(i, 1)[0] : null;
  }
  reset() {
    this.base.tables = { pending_bookings: [], bookings: [], cart_claims: [], customers: [], direct_booking_terms: [], [RUNS]: [], [ALERTS]: [], [RESENDS]: [] };
    this.base.clearFailures();
    this.base.rpcHandlers = {};
    this.updates.length = 0;
    this.failures = [];
    this.beforeMutation = null;
  }
  /** The object `createAdminClient()` resolves to in these tests. */
  readonly client = {
    from: (table: string) => (KEYS[table] ? new OwnQuery(this, table) : this.base.from(table)),
    rpc: (fn: string, args: Record<string, unknown> = {}) => this.base.rpc(fn, args),
  };
}

class OwnQuery implements PromiseLike<Result> {
  private op: "select" | "insert" | "update" = "select";
  private payload: Row = {};
  private filters: Filter[] = [];
  private single = false;
  private returning = false;
  private upsertOn: string[] | null = null;
  private orOnUpdate = false;
  private orders: string[] = [];
  private limitN: number | null = null;

  constructor(private db: ManifestDb, private table: string) {}

  select() {
    if (this.op !== "select") this.returning = true;
    return this;
  }
  insert(payload: Row) {
    this.op = "insert";
    this.payload = payload;
    return this;
  }
  upsert(payload: Row, opts?: { onConflict?: string }) {
    this.op = "insert";
    this.payload = payload;
    this.upsertOn = (opts?.onConflict ?? KEYS[this.table].join(",")).split(",").map((s) => s.trim());
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
  gte(col: string, val: unknown) {
    this.filters.push({ op: "gte", col, val });
    return this;
  }
  lt(col: string, val: unknown) {
    this.filters.push({ op: "lt", col, val });
    return this;
  }
  is(col: string, val: unknown) {
    this.filters.push({ op: "is", col, val });
    return this;
  }
  or() {
    if (this.op === "update") this.orOnUpdate = true;
    return this;
  }
  order(col: string) {
    this.orders.push(col);
    return this;
  }
  limit(n: number) {
    this.limitN = n;
    return this;
  }
  abortSignal() {
    return this;
  }
  maybeSingle() {
    this.single = true;
    return this;
  }

  then<R1 = Result, R2 = never>(
    onfulfilled?: ((value: Result) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null
  ): PromiseLike<R1 | R2> {
    return Promise.resolve(this.run()).then(onfulfilled, onrejected);
  }

  private matches(r: Row): boolean {
    return this.filters.every((f) => {
      const v = r[f.col];
      switch (f.op) {
        case "eq":
          return String(v) === String(f.val);
        case "in":
          return (f.val as unknown[]).map(String).includes(String(v));
        case "gte":
          return v != null && String(v) >= String(f.val);
        case "lt":
          return v != null && String(v) < String(f.val);
        case "is":
          return f.val === null ? v == null : v === f.val;
      }
    });
  }

  private out(rows: Row[]): Result {
    const copies = rows.map((r) => ({ ...r }));
    return { data: this.single ? copies[0] ?? null : copies, error: null };
  }

  private run(): Result {
    // The "concurrent writer" acts first, so it can also arm a failure for THIS statement.
    if (this.op !== "select") this.db.beforeMutation?.(this.table, this.op, this.payload);
    const failure = this.db.takeFailure(this.table, this.op);
    if (failure) return { data: null, error: { message: `injected ${this.op} failure`, code: failure.code } };
    if (this.orOnUpdate) return { data: null, error: { message: `column ${this.table}.status does not exist`, code: "42703" } };
    const rows = this.db.rows(this.table);

    if (this.op === "insert") {
      const keyCols = this.upsertOn ?? KEYS[this.table];
      const existing = rows.find((r) => keyCols.every((c) => String(r[c]) === String(this.payload[c])));
      if (existing && this.upsertOn) {
        const merged = { ...existing, ...this.payload, updated_at: now() };
        const bad = violated(this.table, merged);
        if (bad) return { data: null, error: { message: `violates check constraint "${bad}"`, code: "23514" } };
        Object.assign(existing, merged);
        return this.returning ? this.out([existing]) : { data: null, error: null };
      }
      const row = { ...defaults(this.table), ...this.payload };
      const bad = violated(this.table, row);
      if (bad) return { data: null, error: { message: `violates check constraint "${bad}"`, code: "23514" } };
      if (existing || rows.some((r) => KEYS[this.table].every((c) => String(r[c]) === String(row[c])))) {
        return { data: null, error: { message: `duplicate key value violates unique constraint "${this.table}_pkey"`, code: "23505" } };
      }
      rows.push(row);
      return this.returning ? this.out([row]) : { data: null, error: null };
    }

    if (this.op === "update") {
      this.db.updates.push({ table: this.table, payload: { ...this.payload }, filters: this.filters.map((f) => `${f.col}.${f.op}`) });
      const hit = rows.filter((r) => this.matches(r));
      const merged = hit.map((r) => ({ ...r, ...this.payload, updated_at: now() }));
      for (const m of merged) {
        const bad = violated(this.table, m);
        if (bad) return { data: null, error: { message: `violates check constraint "${bad}"`, code: "23514" } };
      }
      hit.forEach((r, i) => Object.assign(r, merged[i]));
      return this.returning ? this.out(hit) : { data: null, error: null };
    }

    let hit = rows.filter((r) => this.matches(r));
    for (const col of [...this.orders].reverse()) hit = [...hit].sort((a, b) => String(a[col]).localeCompare(String(b[col])));
    if (this.limitN != null) hit = hit.slice(0, this.limitN);
    return this.out(hit);
  }
}
