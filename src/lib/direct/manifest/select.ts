import { createHash } from "node:crypto";
import { shiftIsoDate } from "@/lib/digest/window";
import { wallDate, type AdminClient } from "./schedule";

/**
 * The bookings a manifest lists (6b plan §3.2, D1, D2).
 *
 * LISTED = confirmed, this Stripe mode, this lot, its booking notice STAMPED
 * (`lot_notified_at` — the manifest is a reminder, never the first word), not
 * mid-cancel (no `cancel_state`, no `cancel_claimed_at`), arriving or departing
 * on the manifest date (literal string compare after `.replace("T", " ")`).
 *
 * GROUPED by the booking's snapshot `direct_booking_terms.lot_recipients`,
 * normalised (trimmed, lower-cased, de-duplicated, sorted): one manifest per
 * set, listing only that set's bookings, so no address learns of a booking from
 * a manifest that its cancel notice would not reach.
 */

const DB_TIMEOUT_MS = 3_000;
const dbSignal = () => AbortSignal.timeout(DB_TIMEOUT_MS);

const BOOKING_COLS =
  "id, stripe_payment_intent_id, reslab_reservation_number, inventory_source, direct_lot_id, livemode, status, cancel_state, cancel_claimed_at, lot_notified_at, location_name, lot_snapshot, check_in, check_out, vehicle_info, vehicle_size_label, vehicle_surcharge_cents, vehicle_surcharge_tax_cents, protection_plan, customer_id";

export interface BookingRow {
  id: string;
  stripe_payment_intent_id: string | null;
  reslab_reservation_number: string;
  inventory_source: string | null;
  direct_lot_id: string | null;
  livemode: boolean | null;
  status: string;
  cancel_state: string | null;
  cancel_claimed_at: string | null;
  lot_notified_at: string | null;
  location_name: string | null;
  lot_snapshot: { name?: unknown } | null;
  check_in: string;
  check_out: string;
  vehicle_info: { make?: string; model?: string; color?: string; licensePlate?: string; state?: string } | null;
  vehicle_size_label: string | null;
  vehicle_surcharge_cents: number | null;
  vehicle_surcharge_tax_cents: number | null;
  protection_plan: string | null;
  customer_id: string | null;
}

export interface ManifestRow {
  bookingId: string;
  piId: string;
  number: string;
  lotName: string;
  /** Literal lot-local "YYYY-MM-DD HH:MM:SS". */
  checkIn: string;
  checkOut: string;
  guestName: string;
  guestPhone: string;
  /** No guest name or phone in the staged payload NOR the customers row — the caller reports the TRP number. */
  guestMissing: boolean;
  vehicle: { make: string; model: string; color: string; licensePlate: string; state: string };
  sizeLabel: string;
  /** Surcharge + its tax, collected at the lot. NULL when the row does not say — never shown as $0. */
  atLotCents: number | null;
  parkGuard: boolean;
}

export interface ManifestGroup {
  /** Normalised snapshot recipient set (pre-routing: staging still hashes the lot's own set). */
  recipients: string[];
  hash: string;
  rows: ManifestRow[];
}

export function normaliseRecipients(list: readonly string[]): string[] {
  return [...new Set(list.map((s) => s.trim().toLowerCase()).filter(Boolean))].sort();
}

/** First 16 hex of sha256 over the normalised set — the run's `recipients_hash`. */
export function recipientsHash(list: readonly string[]): string {
  return createHash("sha256").update(normaliseRecipients(list).join("\n")).digest("hex").slice(0, 16);
}

/** The listing rule, applied to a row read back from the DB. */
export function isListedOn(row: BookingRow, livemode: boolean, lotId: string, date: string): boolean {
  return (
    row.inventory_source === "direct" &&
    String(row.direct_lot_id) === lotId &&
    row.livemode === livemode &&
    row.status === "confirmed" &&
    row.lot_notified_at != null &&
    row.cancel_state == null &&
    row.cancel_claimed_at == null &&
    (wallDate(row.check_in) === date || wallDate(row.check_out) === date)
  );
}

/** PostgREST `.or()` (SELECT only) for "arrives or departs on `date`". */
function onDateOr(date: string): string {
  const next = shiftIsoDate(date, 1);
  return `and(check_in.gte.${date},check_in.lt.${next}),and(check_out.gte.${date},check_out.lt.${next})`;
}

const literal = (ts: string) => String(ts).replace("T", " ").slice(0, 19);

interface Guest {
  name: string;
  phone: string;
}

/**
 * Guest name + phone per booking id: the staged checkout payload
 * (`pending_bookings.customer` — what the booking notice named, as lot-notice
 * does), field by field falling back to the `customers` row the booking links
 * (`bookings.customer_id` → first_name, last_name, phone). A field still empty
 * after both stays "" — the caller shows a placeholder and reports the TRP number.
 */
async function guestsFor(supabase: AdminClient, bookings: readonly BookingRow[]): Promise<Map<string, Guest>> {
  const out = new Map<string, Guest>();
  if (bookings.length === 0) return out;
  const piIds = bookings.map((b) => b.stripe_payment_intent_id).filter((p): p is string => !!p);
  const staged = new Map<string, Guest>();
  if (piIds.length > 0) {
    const { data, error } = await supabase
      .from("pending_bookings")
      .select("stripe_payment_intent_id, customer")
      .in("stripe_payment_intent_id", piIds)
      .abortSignal(dbSignal());
    if (error) throw new Error(`manifest: guest read failed: ${error.code ?? "?"} ${error.message}`);
    for (const r of (data ?? []) as Array<{ stripe_payment_intent_id: string; customer: { firstName?: string; lastName?: string; phone?: string } | null }>) {
      const c = r.customer;
      staged.set(r.stripe_payment_intent_id, {
        name: `${c?.firstName ?? ""} ${c?.lastName ?? ""}`.trim(),
        phone: (c?.phone ?? "").trim(),
      });
    }
  }

  const incomplete = bookings.filter((b) => {
    const g = staged.get(b.stripe_payment_intent_id ?? "");
    return (!g?.name || !g.phone) && !!b.customer_id;
  });
  const customers = new Map<string, Guest>();
  if (incomplete.length > 0) {
    const { data, error } = await supabase
      .from("customers")
      .select("id, first_name, last_name, phone")
      .in("id", [...new Set(incomplete.map((b) => b.customer_id).filter((id): id is string => !!id))])
      .abortSignal(dbSignal());
    if (error) throw new Error(`manifest: customer read failed: ${error.code ?? "?"} ${error.message}`);
    for (const c of (data ?? []) as Array<{ id: string; first_name: string | null; last_name: string | null; phone: string | null }>) {
      customers.set(c.id, { name: `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim(), phone: (c.phone ?? "").trim() });
    }
  }

  for (const b of bookings) {
    const s = staged.get(b.stripe_payment_intent_id ?? "");
    const c = b.customer_id ? customers.get(b.customer_id) : undefined;
    out.set(b.id, { name: s?.name || c?.name || "", phone: s?.phone || c?.phone || "" });
  }
  return out;
}

function toManifestRow(b: BookingRow, guest: Guest | undefined): ManifestRow {
  const v = b.vehicle_info ?? {};
  const snapshotName = b.lot_snapshot && typeof b.lot_snapshot.name === "string" ? b.lot_snapshot.name : null;
  const surcharge = b.vehicle_surcharge_cents;
  const tax = b.vehicle_surcharge_tax_cents;
  return {
    bookingId: b.id,
    piId: b.stripe_payment_intent_id ?? "",
    number: b.reslab_reservation_number,
    lotName: b.location_name || snapshotName || "",
    checkIn: literal(b.check_in),
    checkOut: literal(b.check_out),
    guestName: guest?.name || "(see admin)",
    guestPhone: guest?.phone || "—",
    guestMissing: !guest?.name || !guest.phone,
    vehicle: { make: v.make ?? "", model: v.model ?? "", color: v.color ?? "", licensePlate: v.licensePlate ?? "", state: v.state ?? "" },
    sizeLabel: b.vehicle_size_label ?? "—",
    atLotCents: surcharge != null && tax != null ? Number(surcharge) + Number(tax) : null,
    parkGuard: b.protection_plan != null && b.protection_plan !== "",
  };
}

/**
 * Listed rows for (lot, date), grouped by recipient set. A listed booking with
 * no terms row cannot be routed: it is left out and returned as `unroutable`
 * (TRP numbers) for the caller to report.
 */
export async function selectManifestGroups(
  supabase: AdminClient,
  livemode: boolean,
  lotId: string,
  date: string
): Promise<{ groups: ManifestGroup[]; unroutable: string[] }> {
  const { data, error } = await supabase
    .from("bookings")
    .select(BOOKING_COLS)
    .eq("inventory_source", "direct")
    .eq("direct_lot_id", lotId)
    .eq("livemode", livemode)
    .eq("status", "confirmed")
    .not("lot_notified_at", "is", null)
    .is("cancel_state", null)
    .is("cancel_claimed_at", null)
    .or(onDateOr(date))
    .abortSignal(dbSignal());
  if (error) throw new Error(`manifest: bookings read failed: ${error.code ?? "?"} ${error.message}`);
  const listed = ((data ?? []) as BookingRow[]).filter((b) => isListedOn(b, livemode, lotId, date) && !!b.stripe_payment_intent_id);
  if (listed.length === 0) return { groups: [], unroutable: [] };

  const piIds = listed.map((b) => b.stripe_payment_intent_id as string);
  const { data: terms, error: termsError } = await supabase
    .from("direct_booking_terms")
    .select("stripe_payment_intent_id, lot_recipients")
    .in("stripe_payment_intent_id", piIds)
    .abortSignal(dbSignal());
  if (termsError) throw new Error(`manifest: terms read failed: ${termsError.code ?? "?"} ${termsError.message}`);
  const recipientsByPi = new Map<string, string[]>();
  for (const t of (terms ?? []) as Array<{ stripe_payment_intent_id: string; lot_recipients: string[] | null }>) {
    const set = normaliseRecipients(t.lot_recipients ?? []);
    if (set.length > 0) recipientsByPi.set(t.stripe_payment_intent_id, set);
  }
  const guests = await guestsFor(supabase, listed);

  const groups = new Map<string, ManifestGroup>();
  const unroutable: string[] = [];
  for (const b of listed) {
    const pi = b.stripe_payment_intent_id as string;
    const set = recipientsByPi.get(pi);
    if (!set) {
      unroutable.push(b.reslab_reservation_number);
      continue;
    }
    const hash = recipientsHash(set);
    const group = groups.get(hash) ?? { recipients: set, hash, rows: [] };
    group.rows.push(toManifestRow(b, guests.get(b.id)));
    groups.set(hash, group);
  }
  return { groups: [...groups.values()].sort((a, b) => a.hash.localeCompare(b.hash)), unroutable };
}

/**
 * The re-check before every send (§3.4 step 2): re-read exactly these ids and
 * keep the ones that are STILL listed. Never adds a booking the list did not have.
 */
export async function recheckManifestRows(
  supabase: AdminClient,
  livemode: boolean,
  lotId: string,
  date: string,
  ids: string[]
): Promise<ManifestRow[]> {
  if (ids.length === 0) return [];
  const { data, error } = await supabase.from("bookings").select(BOOKING_COLS).in("id", ids).abortSignal(dbSignal());
  if (error) throw new Error(`manifest: re-check read failed: ${error.code ?? "?"} ${error.message}`);
  const still = ((data ?? []) as BookingRow[]).filter((b) => isListedOn(b, livemode, lotId, date) && !!b.stripe_payment_intent_id);
  const guests = await guestsFor(supabase, still);
  return still.map((b) => toManifestRow(b, guests.get(b.id)));
}

/** Any confirmed booking (listed or not) arriving or departing at the lot on `date`. */
export async function lotHasConfirmedBookingOn(supabase: AdminClient, livemode: boolean, lotId: string, date: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("bookings")
    .select("id, check_in, check_out")
    .eq("inventory_source", "direct")
    .eq("direct_lot_id", lotId)
    .eq("livemode", livemode)
    .eq("status", "confirmed")
    .or(onDateOr(date))
    .limit(50)
    .abortSignal(dbSignal());
  if (error) throw new Error(`manifest: booking check failed: ${error.code ?? "?"} ${error.message}`);
  return ((data ?? []) as Array<{ check_in: string; check_out: string }>).some(
    (r) => wallDate(r.check_in) === date || wallDate(r.check_out) === date
  );
}

export interface FollowUpRow {
  bookingId: string;
  piId: string;
  number: string;
  status: string;
  lotName: string;
  customerName: string;
  fromDate: string;
  toDate: string;
  vehicleLine: string;
}

/**
 * The bookings a run listed (ids_ever), with what the follow-up cancel email
 * shows — the same fields and fallbacks as the 4b-2 cancel notice.
 */
export async function readFollowUpRows(supabase: AdminClient, ids: string[]): Promise<FollowUpRow[]> {
  if (ids.length === 0) return [];
  const { data, error } = await supabase.from("bookings").select(BOOKING_COLS).in("id", ids).abortSignal(dbSignal());
  if (error) throw new Error(`manifest follow-up: bookings read failed: ${error.code ?? "?"} ${error.message}`);
  const rows = (data ?? []) as BookingRow[];
  const guests = await guestsFor(supabase, rows.filter((b) => b.status === "cancelled" || b.status === "refunded"));
  return rows.map((b) => {
    const v = b.vehicle_info ?? {};
    const name = guests.get(b.id)?.name || "(see admin)";
    const snapshotName = b.lot_snapshot && typeof b.lot_snapshot.name === "string" ? b.lot_snapshot.name : "";
    return {
      bookingId: b.id,
      piId: b.stripe_payment_intent_id ?? "",
      number: b.reslab_reservation_number,
      status: b.status,
      lotName: b.location_name || snapshotName,
      customerName: name,
      fromDate: literal(b.check_in),
      toDate: literal(b.check_out),
      vehicleLine: [v.color, v.make, v.model].filter(Boolean).join(" ") + (v.licensePlate ? ` — plate ${v.licensePlate}` : ""),
    };
  });
}
