"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Search,
  Loader2,
  ChevronLeft,
  ChevronRight,
  Mail,
  AlertTriangle,
  CheckCircle2,
  Inbox,
  RefreshCw,
} from "lucide-react";
import { formatDateTime } from "@/lib/utils";

interface Ticket {
  id: string;
  ticket_number: number;
  name: string;
  email: string;
  subject: string;
  message: string;
  reservation_number: string | null;
  booking_id: string | null;
  booking_match: "matched" | "email_mismatch" | "not_found" | "lookup_failed" | "none";
  priority: "urgent" | "high" | "normal";
  reasons: string[];
  auto_reply_kind: string;
  auto_reply_sent: boolean;
  alerted_at: string | null;
  status: "new" | "open" | "waiting" | "done";
  assigned_to: string | null;
  first_response_at: string | null;
  resolved_at: string | null;
  notes: string;
  /** For the conditional save: PATCH refuses (409) if someone else saved since. */
  updated_at: string;
  created_at: string;
}

type View = "open" | "urgent" | "done" | "all";

const VIEWS: Array<{ key: View; label: string }> = [
  { key: "open", label: "Open" },
  { key: "urgent", label: "Urgent" },
  { key: "done", label: "Done" },
  { key: "all", label: "All" },
];

const PRIORITY_STYLE: Record<Ticket["priority"], string> = {
  urgent: "bg-red-100 text-red-700 border-red-200",
  high: "bg-amber-100 text-amber-800 border-amber-200",
  normal: "bg-gray-100 text-gray-600 border-gray-200",
};

const STATUS_LABEL: Record<Ticket["status"], string> = {
  new: "New",
  open: "Working on it",
  waiting: "Waiting on customer",
  done: "Done",
};

const MATCH_LABEL: Record<Ticket["booking_match"], string> = {
  matched: "Booking matched",
  email_mismatch: "⚠️ Booking under a different email — verify first",
  not_found: "⚠️ Reservation number not found",
  lookup_failed: "⚠️ Lookup failed — check the number by hand",
  none: "No reservation number",
};

const REPLY_LABEL: Record<string, string> = {
  self_cancel: "Sent self-cancel steps",
  already_cancelled: "Told already cancelled",
  cancel_support: "Told we'll cancel it",
  change: "Told we'll send change options",
  at_lot: "Sent lot facts + 'team alerted'",
  booking_details: "Sent booking details",
  payment: "Told payments is on it",
  partner: "Standard acknowledgement",
  generic: "Standard acknowledgement",
};

/** "3h 12m", "2d 4h" — how long the customer has waited. */
function age(fromIso: string, toIso?: string | null): string {
  const ms = (toIso ? new Date(toIso).getTime() : Date.now()) - new Date(fromIso).getTime();
  const mins = Math.max(0, Math.floor(ms / 60000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ${mins % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function firstName(email: string): string {
  const local = email.split("@")[0] ?? email;
  return local.charAt(0).toUpperCase() + local.slice(1);
}

export default function AdminSupportPage() {
  const [view, setView] = useState<View>("open");
  // `search` is the box; `query` is what was submitted — only `query` is fetched.
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [assignees, setAssignees] = useState<string[]>([]);
  // Only the latest request may update the list (fast clicks can return out of order).
  const requestId = useRef(0);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  // null until a load succeeds: a failed read shows "—", never 0.
  const [counts, setCounts] = useState<{ open: number; urgent: number } | null>(null);
  const [listFailed, setListFailed] = useState(false);
  const [totalPages, setTotalPages] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Ticket | null>(null);
  const [saving, setSaving] = useState(false);
  const [notesDraft, setNotesDraft] = useState("");

  const load = useCallback(async () => {
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ view, page: String(page) });
      if (query) params.set("search", query);
      const res = await fetch(`/api/admin/support?${params}`);
      const data = await res.json().catch(() => null);
      if (id !== requestId.current) return; // a newer request owns the screen
      if (!res.ok || !data) throw new Error(data?.error || `Failed to load tickets (${res.status})`);
      setTickets(data.tickets);
      setCounts(data.counts);
      setListFailed(false);
      setAssignees(data.assignees);
      setTotalPages(data.pagination.totalPages);
      setSelected((cur) => (cur ? (data.tickets as Ticket[]).find((t) => t.id === cur.id) ?? cur : null));
    } catch (e) {
      if (id === requestId.current) {
        setError(e instanceof Error ? e.message : "Failed to load tickets");
        setCounts(null);
        setListFailed(true);
      }
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [view, page, query]);

  useEffect(() => {
    load();
  }, [load]);

  async function patch(t: Ticket, body: Record<string, unknown>) {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/support/${t.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, expectedUpdatedAt: t.updated_at }),
      });
      const data = await res.json().catch(() => null);
      if (res.status === 409) {
        // Someone else saved first: show theirs (the reload), keep this draft.
        await load();
        throw new Error(data?.error || "Someone else changed this ticket. Reload it and try again.");
      }
      if (!res.ok) throw new Error(data?.error || `Update failed (${res.status})`);
      // Keep the open ticket in view even when it leaves the current list (e.g. closed from "Open").
      const now = new Date().toISOString();
      const local: Partial<Ticket> = {};
      if (typeof body.status === "string") local.status = body.status as Ticket["status"];
      if ("assignedTo" in body) local.assigned_to = (body.assignedTo as string | null) ?? null;
      if (typeof body.notes === "string") local.notes = body.notes;
      if (body.markReplied) {
        local.first_response_at = t.first_response_at ?? now;
        if (t.status === "new" && !local.status) local.status = "waiting";
      }
      if (typeof data?.updatedAt === "string") local.updated_at = data.updatedAt;
      setSelected({ ...t, ...local });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Update failed");
    } finally {
      setSaving(false);
    }
  }

  function open(t: Ticket) {
    setSelected(t);
    setNotesDraft(t.notes);
  }

  const replyHref = (t: Ticket) =>
    `mailto:${encodeURIComponent(t.email)}?subject=${encodeURIComponent(`Re: Triply #${t.ticket_number} - ${t.subject}`)}`;

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Support</h1>
          <p className="text-gray-600">Contact-form requests. Every customer already got an instant reply.</p>
        </div>
        <button
          onClick={() => load()}
          className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
        >
          <RefreshCw className="h-4 w-4" /> Refresh
        </button>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-4 sm:max-w-md">
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <div className="flex items-center gap-2 text-sm text-gray-600">
            <Inbox className="h-4 w-4" /> Open
          </div>
          <div className="mt-1 text-2xl font-bold text-gray-900">{counts?.open ?? "—"}</div>
        </div>
        <div className={`rounded-xl border p-4 ${(counts?.urgent ?? 0) > 0 ? "border-red-200 bg-red-50" : "border-gray-200 bg-white"}`}>
          <div className="flex items-center gap-2 text-sm text-gray-600">
            <AlertTriangle className="h-4 w-4" /> Urgent
          </div>
          <div className={`mt-1 text-2xl font-bold ${(counts?.urgent ?? 0) > 0 ? "text-red-700" : "text-gray-900"}`}>{counts?.urgent ?? "—"}</div>
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex rounded-lg border border-gray-200 bg-white p-1">
          {VIEWS.map((v) => (
            <button
              key={v.key}
              onClick={() => {
                setView(v.key);
                setPage(1);
              }}
              className={`rounded-md px-3 py-1.5 text-sm font-medium ${
                view === v.key ? "bg-brand-orange text-white" : "text-gray-600 hover:bg-gray-100"
              }`}
            >
              {v.label}
            </button>
          ))}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setPage(1);
            setQuery(search.trim());
          }}
          className="flex flex-1 items-center gap-2 sm:max-w-sm"
        >
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Ticket #, email, name, reservation"
              className="w-full rounded-lg border border-gray-200 py-2 pl-9 pr-3 text-sm outline-none focus:ring-2 focus:ring-brand-orange"
            />
          </div>
        </form>
      </div>

      {error && <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      <div className="grid gap-6 lg:grid-cols-5">
        <div className="lg:col-span-2">
          <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
            {loading ? (
              <div className="flex justify-center py-12">
                <Loader2 className="h-6 w-6 animate-spin text-brand-orange" />
              </div>
            ) : listFailed ? (
              <div className="py-12 text-center text-sm text-red-600">Couldn&apos;t load tickets — use Refresh.</div>
            ) : tickets.length === 0 ? (
              <div className="py-12 text-center text-sm text-gray-500">Nothing here. 🎉</div>
            ) : (
              <ul className="divide-y divide-gray-100">
                {tickets.map((t) => (
                  <li key={t.id}>
                    <button
                      onClick={() => open(t)}
                      className={`w-full px-4 py-3 text-left hover:bg-gray-50 ${selected?.id === t.id ? "bg-orange-50" : ""}`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-semibold text-gray-900">
                          #{t.ticket_number} · {t.subject}
                        </span>
                        <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${PRIORITY_STYLE[t.priority]}`}>
                          {t.priority}
                        </span>
                      </div>
                      <div className="mt-1 flex items-center justify-between gap-2 text-xs text-gray-500">
                        <span className="truncate">{t.name} · {t.email}</span>
                        <span className="whitespace-nowrap">
                          {t.status === "done" ? STATUS_LABEL.done : `${STATUS_LABEL[t.status]} · ${age(t.created_at)}`}
                        </span>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {totalPages > 1 && (
            <div className="mt-3 flex items-center justify-between text-sm text-gray-600">
              <button disabled={page <= 1} onClick={() => setPage(page - 1)} className="inline-flex items-center gap-1 disabled:opacity-40">
                <ChevronLeft className="h-4 w-4" /> Prev
              </button>
              <span>
                Page {page} of {totalPages}
              </span>
              <button disabled={page >= totalPages} onClick={() => setPage(page + 1)} className="inline-flex items-center gap-1 disabled:opacity-40">
                Next <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          )}
        </div>

        <div className="lg:col-span-3">
          {!selected ? (
            <div className="rounded-xl border border-dashed border-gray-300 bg-white py-16 text-center text-sm text-gray-500">
              Pick a ticket to work it.
            </div>
          ) : (
            <div className="rounded-xl border border-gray-200 bg-white p-6">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-lg font-bold text-gray-900">
                    #{selected.ticket_number} · {selected.subject}
                  </h2>
                  <p className="text-sm text-gray-600">
                    {selected.name} ·{" "}
                    <a href={`mailto:${selected.email}`} className="text-brand-orange">
                      {selected.email}
                    </a>
                  </p>
                  <p className="mt-1 text-xs text-gray-500">
                    {formatDateTime(selected.created_at)} · waited{" "}
                    {age(selected.created_at, selected.first_response_at)}
                    {selected.first_response_at ? " to first reply" : " so far"}
                  </p>
                </div>
                <span className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${PRIORITY_STYLE[selected.priority]}`}>
                  {selected.priority}
                  {selected.reasons.length > 0 && ` — ${selected.reasons.join(", ")}`}
                </span>
              </div>

              <div className="mt-4 grid gap-2 rounded-lg bg-gray-50 p-4 text-sm text-gray-700 sm:grid-cols-2">
                <div>
                  <span className="text-gray-500">Reservation:</span>{" "}
                  {selected.reservation_number ? (
                    <span className="font-mono font-medium text-gray-900">{selected.reservation_number}</span>
                  ) : (
                    "—"
                  )}
                </div>
                <div>{MATCH_LABEL[selected.booking_match]}</div>
                <div>
                  <span className="text-gray-500">Instant reply:</span> {REPLY_LABEL[selected.auto_reply_kind] ?? selected.auto_reply_kind}
                  {!selected.auto_reply_sent && <span className="text-red-600"> (not delivered)</span>}
                </div>
                {selected.priority === "urgent" && (
                  <div>
                    <span className="text-gray-500">Discord alert:</span> {selected.alerted_at ? "sent" : "not sent"}
                  </div>
                )}
              </div>

              <div className="mt-4 whitespace-pre-wrap rounded-lg border border-gray-200 p-4 text-sm leading-relaxed text-gray-800">
                {selected.message}
              </div>

              <div className="mt-5 flex flex-wrap gap-2">
                <a
                  href={replyHref(selected)}
                  className="inline-flex items-center gap-2 rounded-lg bg-brand-orange px-4 py-2 text-sm font-semibold text-white hover:bg-orange-600"
                >
                  <Mail className="h-4 w-4" /> Reply by email
                </a>
                <button
                  disabled={saving || !!selected.first_response_at}
                  onClick={() => patch(selected, { markReplied: true })}
                  className="inline-flex items-center gap-2 rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                >
                  <CheckCircle2 className="h-4 w-4" />
                  {selected.first_response_at ? "Replied" : "Mark replied"}
                </button>
                {selected.status !== "done" ? (
                  <button
                    disabled={saving}
                    onClick={() => patch(selected, { status: "done" })}
                    className="rounded-lg border border-green-200 bg-green-50 px-4 py-2 text-sm font-medium text-green-700 hover:bg-green-100 disabled:opacity-50"
                  >
                    Close (done)
                  </button>
                ) : (
                  <button
                    disabled={saving}
                    onClick={() => patch(selected, { status: "open" })}
                    className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                  >
                    Reopen
                  </button>
                )}
              </div>

              <div className="mt-5 grid gap-4 sm:grid-cols-2">
                <label className="text-sm">
                  <span className="mb-1 block text-gray-600">Status</span>
                  <select
                    value={selected.status}
                    disabled={saving}
                    onChange={(e) => patch(selected, { status: e.target.value })}
                    className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2"
                  >
                    {(Object.keys(STATUS_LABEL) as Ticket["status"][]).map((s) => (
                      <option key={s} value={s}>
                        {STATUS_LABEL[s]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-sm">
                  <span className="mb-1 block text-gray-600">Owner</span>
                  <select
                    value={selected.assigned_to ?? ""}
                    disabled={saving}
                    onChange={(e) => patch(selected, { assignedTo: e.target.value || null })}
                    className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2"
                  >
                    <option value="">Unassigned</option>
                    {[...assignees, ...(selected.assigned_to && !assignees.includes(selected.assigned_to) ? [selected.assigned_to] : [])].map((e) => (
                      <option key={e} value={e}>
                        {firstName(e)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <label className="mt-4 block text-sm">
                <span className="mb-1 block text-gray-600">Internal notes (customer never sees these)</span>
                <textarea
                  value={notesDraft}
                  onChange={(e) => setNotesDraft(e.target.value)}
                  rows={4}
                  className="w-full resize-y rounded-lg border border-gray-200 px-3 py-2 outline-none focus:ring-2 focus:ring-brand-orange"
                  placeholder="What you did: refunded $X, called the lot, changed dates in ResLab…"
                />
              </label>
              <button
                disabled={saving || notesDraft === selected.notes}
                onClick={() => patch(selected, { notes: notesDraft })}
                className="mt-2 rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                {saving ? "Saving…" : "Save notes"}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
