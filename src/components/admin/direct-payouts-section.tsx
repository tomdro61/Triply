"use client";

import { useEffect, useId, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, Download, Loader2, Mail, RefreshCw } from "lucide-react";
import type { StatementItem, StatementView } from "@/lib/direct/payout-statement";
import type { StatementEmailResult } from "@/lib/direct/payout-email";
import { needsPerson, prepareMarkPaid, previousMonth, type DecisionDraft } from "@/lib/direct/payout-form";

/**
 * "Triply lots" — direct-lot payout statements (Phase 6a, plan §3). Mounted
 * unconditionally on /admin/accounting with its own lot + month picker; it
 * does not use the page's date filter. Everything shown is rebuilt by the
 * server on mark-paid, which refuses if it no longer matches.
 */

type View = StatementView & { lotName: string };
type Lot = { id: string; name: string };

const money = (cents: number | null) =>
  cents === null ? "—" : `${cents < 0 ? "−" : ""}$${(Math.abs(cents) / 100).toFixed(2)}`;

const CLASS_LABEL: Record<StatementItem["class"], string> = { payable: "Pay", zero: "$0", manual: "Needs a decision" };

const emailMessage = (e: StatementEmailResult) =>
  e.outcome === "sent"
    ? `Statement emailed to ${e.to.join(", ")}${e.test ? " (test inbox)" : ""}.`
    : e.outcome === "unknown"
    ? `Statement MAY have been emailed — ${e.reason}.`
    : e.outcome === "busy"
    ? e.reason
    : `Statement not emailed: ${e.reason}.`;

/** "$38.21 paid to X" or, for a month of claw-backs, "$12.00 owed by X to Triply". */
const totalPhrase = (cents: number, lotName: string) =>
  cents < 0 ? `a net balance of ${money(-cents)} owed by ${lotName} to Triply` : `${money(cents)} paid to ${lotName}`;

type Notice = { tone: "ok" | "warn"; text: string };

async function readError(res: Response): Promise<string> {
  try {
    const body: { error?: unknown } = await res.json();
    return typeof body.error === "string" ? body.error : `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

export function DirectPayoutsSection() {
  const [lots, setLots] = useState<Lot[] | null>(null);
  const [lotsError, setLotsError] = useState<string | null>(null);
  const [lotId, setLotId] = useState("");
  const [month, setMonth] = useState(() => previousMonth(Date.now()));
  const [view, setView] = useState<View | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, DecisionDraft>>({});
  const [statementNote, setStatementNote] = useState("");
  const [busy, setBusy] = useState<"" | "pay" | "resend">("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [lotsDropped, setLotsDropped] = useState(0);
  // A 409 means the server's statement no longer matches this one: paying is off until a reload.
  const [stale, setStale] = useState(false);
  // A response for an older lot/month must never replace the current one.
  const loadSeq = useRef(0);
  const ids = { lot: useId(), month: useId(), note: useId() };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/admin/direct-payouts/lots", { cache: "no-store" });
        if (!res.ok) throw new Error(await readError(res));
        const body: { lots: Lot[]; dropped: number } = await res.json();
        if (cancelled) return;
        setLots(body.lots);
        setLotsDropped(body.dropped);
        if (body.lots.length > 0) setLotId((cur) => cur || body.lots[0].id);
      } catch (e) {
        if (!cancelled) setLotsError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /** Loads one statement; `keepNotice` keeps the outcome of the action that triggered the reload. */
  async function load(forLot: string, forMonth: string, keepNotice = false) {
    if (!forLot) return;
    const seq = ++loadSeq.current;
    setLoading(true);
    setError(null);
    if (!keepNotice) setNotice(null);
    setView(null);
    setDrafts({});
    setStatementNote("");
    setStale(false);
    try {
      const res = await fetch(`/api/admin/direct-payouts?lot=${encodeURIComponent(forLot)}&month=${encodeURIComponent(forMonth)}`, { cache: "no-store" });
      if (!res.ok) throw new Error(await readError(res));
      const body: View = await res.json();
      if (seq !== loadSeq.current) return;
      setView(body);
      // Prefill a known adjustment delta; the admin still has to choose "pay" and say why.
      const pre: Record<string, DecisionDraft> = {};
      for (const i of body.items) {
        if (i.lineKind === "adjustment" && i.suggestedCents !== null) pre[i.piId] = { action: "", amount: (i.suggestedCents / 100).toFixed(2), note: "" };
      }
      setDrafts(pre);
    } catch (e) {
      if (seq === loadSeq.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }

  /** A picker change drops the loaded statement, so nothing on screen belongs to another lot or month. */
  function pick(next: { lot?: string; month?: string }) {
    if (next.lot !== undefined) setLotId(next.lot);
    if (next.month !== undefined) setMonth(next.month);
    loadSeq.current++; // an in-flight load for the old picks is ignored
    setLoading(false);
    setView(null);
    setDrafts({});
    setStatementNote("");
    setNotice(null);
    setError(null);
    setStale(false);
  }

  const setDraft = (pi: string, patch: Partial<DecisionDraft>) =>
    setDrafts((d) => {
      const cur: DecisionDraft = d[pi] ?? { action: "", amount: "", note: "" };
      return { ...d, [pi]: { ...cur, ...patch } };
    });

  const prepared = view && !view.paid ? prepareMarkPaid(view.items, drafts) : null;
  const canPay =
    !!view && !view.paid && !stale && view.blocked.length === 0 && (view.monthClosed || !view.livemode) && !!prepared?.ok && busy === "";

  async function markPaid() {
    if (!view || !prepared?.ok || busy) return;
    const ok = window.confirm(
      `${view.livemode ? "" : "[TEST MODE] "}Record ${totalPhrase(prepared.totalCents, view.lotName)} for check-out month ${view.month} (${prepared.lineCount} line${prepared.lineCount === 1 ? "" : "s"})?\n\nThis cannot be undone — mistakes are corrected with an adjustment on a later statement.`
    );
    if (!ok) return;
    setBusy("pay");
    setNotice(null);
    setError(null);
    try {
      const res = await fetch("/api/admin/direct-payouts/mark-paid", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lot: view.lotId,
          month: view.month,
          viewHash: view.viewHash,
          expectedTotalCents: prepared.totalCents,
          decisions: prepared.decisions,
          note: statementNote.trim() || undefined,
        }),
      });
      if (res.status === 409) {
        setStale(true);
        setError(`${await readError(res)} (Load statement again to continue.)`);
        return;
      }
      if (res.status >= 500 && res.status !== 503) {
        // Includes a function killed mid-request (a non-JSON 504): the write may have happened.
        setStale(true);
        setError(`${await readError(res)} — it may already be marked paid. Load the statement again before retrying.`);
        return;
      }
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      const body: { totalCents: number; email: StatementEmailResult } = await res.json();
      setNotice({
        tone: body.email.outcome === "sent" ? "ok" : "warn",
        text: `${view.lotName}, ${view.month}: recorded ${totalPhrase(body.totalCents, view.lotName)}. ${emailMessage(body.email)}`,
      });
      await load(view.lotId, view.month, true);
    } catch (e) {
      // The request may have reached the server: never assume it did not.
      setError(`No answer from the server (${e instanceof Error ? e.message : String(e)}). Reload before trying again — it may already be marked paid.`);
    } finally {
      setBusy("");
    }
  }

  async function resend() {
    if (!view?.paid || busy) return;
    // An earlier attempt with no recorded email id may still have been delivered (unknown outcome).
    if (view.paid.attempts > 0 && !window.confirm(
      view.paid.emailId
        ? "This statement was already emailed. Send it again?"
        : `An earlier send (${view.paid.attempts} attempt${view.paid.attempts === 1 ? "" : "s"}) failed or its outcome is unknown — it may have reached the lot. Check the inbox first. Send anyway?`
    )) return;
    setBusy("resend");
    setNotice(null);
    setError(null);
    try {
      const res = await fetch("/api/admin/direct-payouts/resend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lot: view.lotId, month: view.month }),
      });
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      const body: { email: StatementEmailResult } = await res.json();
      setNotice({ tone: body.email.outcome === "sent" ? "ok" : "warn", text: `${view.lotName}, ${view.month}: ${emailMessage(body.email)}` });
      await load(view.lotId, view.month, true);
    } catch (e) {
      setError(`No answer from the server (${e instanceof Error ? e.message : String(e)}). Check the inbox before sending again.`);
    } finally {
      setBusy("");
    }
  }

  const pickersLocked = busy !== "" || loading;

  return (
    <section className="mt-10">
      <h2 className="text-sm uppercase font-semibold text-gray-500 tracking-wider mb-3">Triply lots — payouts</h2>
      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <p className="text-xs text-gray-500 mb-4">
          What Triply owes each direct lot for bookings that checked out in a month (lot share of the list-price parking, plus tax the lot
          collects). Pay the lot offline, then mark the month paid here. Independent of the date filter above.
        </p>
        {lotsError && <p className="text-sm text-red-700 mb-3">Lots unavailable: {lotsError}</p>}
        {lotsDropped > 0 && (
          <p className="text-sm text-amber-800 mb-3">
            {lotsDropped} direct lot{lotsDropped === 1 ? "" : "s"} could not be read from the CMS and {lotsDropped === 1 ? "is" : "are"} missing from this list — see Sentry.
          </p>
        )}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-4">
          <div>
            <label htmlFor={ids.lot} className="block text-xs font-medium text-gray-700 mb-1">Lot</label>
            <select
              id={ids.lot}
              value={lotId}
              disabled={busy !== "" || !lots}
              onChange={(e) => pick({ lot: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
            >
              {!lots && <option value="">Loading…</option>}
              {lots?.length === 0 && <option value="">No direct lots</option>}
              {lots?.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor={ids.month} className="block text-xs font-medium text-gray-700 mb-1">Check-out month</label>
            <input
              id={ids.month}
              type="month"
              value={month}
              disabled={busy !== ""}
              onChange={(e) => pick({ month: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
            />
          </div>
          <div className="flex items-end">
            <button
              onClick={() => load(lotId, month)}
              disabled={pickersLocked || !lotId || !/^\d{4}-\d{2}$/.test(month)}
              className="w-full px-4 py-2 bg-coral text-white rounded-lg font-medium hover:bg-coral/90 disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {loading ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
              Load statement
            </button>
          </div>
          {view && (
            <div className="flex items-end">
              <a
                href={`/api/admin/direct-payouts?lot=${encodeURIComponent(view.lotId)}&month=${encodeURIComponent(view.month)}&format=csv`}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg text-sm text-gray-700 hover:bg-gray-50 flex items-center justify-center gap-2"
              >
                <Download size={16} /> Internal CSV
              </a>
            </div>
          )}
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-4 flex items-start gap-2 text-sm text-red-800">
            <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}
        {notice && (
          <div
            className={`rounded-lg p-3 mb-4 flex items-start gap-2 text-sm border ${
              notice.tone === "ok" ? "bg-green-50 border-green-200 text-green-800" : "bg-amber-50 border-amber-200 text-amber-900"
            }`}
          >
            {notice.tone === "ok" ? <CheckCircle2 size={16} className="mt-0.5 flex-shrink-0" /> : <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />}
            <span>{notice.text}</span>
          </div>
        )}

        {view && (
          <>
            <div className="flex flex-wrap gap-2 mb-4 text-xs">
              {!view.livemode && <span className="px-2 py-1 rounded bg-amber-100 text-amber-900 font-semibold">TEST MODE — staging bookings only</span>}
              <span className="px-2 py-1 rounded bg-gray-100 text-gray-700">
                {view.monthClosed ? "Month is over" : "Month not over yet (lot time)"} · {view.timezone}
              </span>
              <span className="px-2 py-1 rounded bg-gray-100 text-gray-700">
                {view.totals.payableCount} pay · {view.totals.zeroCount} $0 · {view.totals.manualCount} need a decision · {view.totals.adjustmentCount} adjustment
                {view.totals.adjustmentCount === 1 ? "" : "s"}
              </span>
            </div>

            {view.paid && (
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 mb-4 text-sm text-blue-900 flex flex-wrap items-center justify-between gap-3">
                <span>
                  Recorded {totalPhrase(view.paid.totalCents, view.lotName)} on {new Date(view.paid.paidAt).toLocaleString()} by {view.paid.paidBy}.{" "}
                  {view.paid.emailId
                    ? "Statement emailed."
                    : view.paid.attempts > 0
                    ? `Statement email not confirmed (${view.paid.attempts} attempt${view.paid.attempts === 1 ? "" : "s"}) — it may have been delivered; check the inbox.`
                    : "Statement not emailed."}
                  {view.items.length > 0 && " Rows below were not on it and go on the next statement."}
                </span>
                <button
                  onClick={resend}
                  disabled={busy !== ""}
                  className="px-3 py-1.5 border border-blue-300 rounded-lg bg-white hover:bg-blue-100 disabled:opacity-50 flex items-center gap-2"
                >
                  {busy === "resend" ? <Loader2 size={14} className="animate-spin" /> : <Mail size={14} />}
                  {view.paid.emailId ? "Re-send statement" : "Send statement"}
                </button>
              </div>
            )}

            {view.blocked.length > 0 && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-4 text-sm text-red-800">
                <p className="font-medium">Cannot be put on a statement — fix these first:</p>
                <ul className="list-disc ml-5 mt-1">
                  {view.blocked.map((b) => (
                    <li key={b.reservationNumber}>
                      {b.reservationNumber}: {b.reason}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-xs text-gray-600 uppercase">
                  <tr>
                    <th className="px-3 py-2 text-left">Booking</th>
                    <th className="px-3 py-2 text-left">Check-out</th>
                    <th className="px-3 py-2 text-left">Row</th>
                    <th className="px-3 py-2 text-right">Parking</th>
                    <th className="px-3 py-2 text-right">Tax</th>
                    <th className="px-3 py-2 text-right">Received / refunded</th>
                    <th className="px-3 py-2 text-right">Rules say</th>
                    <th className="px-3 py-2 text-right" title="Internal: received − refunded − payout − Stripe fee − PG wholesale − tax Triply owes">Margin</th>
                    <th className="px-3 py-2 text-left">Decision</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {view.items.map((i) => {
                    const d = drafts[i.piId];
                    return (
                      <tr key={i.piId} className={needsPerson(i) ? "bg-amber-50/40" : ""}>
                        <td className="px-3 py-2 font-mono text-xs">
                          {i.reservationNumber}
                          <div className="text-gray-500">{i.status}</div>
                        </td>
                        <td className="px-3 py-2 text-gray-600">{i.checkOut.slice(0, 10)}</td>
                        <td className="px-3 py-2">
                          {i.lineKind === "adjustment" ? "Adjustment" : CLASS_LABEL[i.class]}
                          {i.reason && <div className="text-xs text-gray-500">{i.reason}</div>}
                        </td>
                        <td className="px-3 py-2 text-right font-mono">{money(i.basis.subtotalCents)}</td>
                        <td className="px-3 py-2 text-right font-mono">
                          {money(i.basis.taxCents)}
                          <div className="text-xs text-gray-500">{i.basis.taxCollectedBy ?? "?"}</div>
                        </td>
                        <td className="px-3 py-2 text-right font-mono">
                          {money(i.basis.amountReceivedCents)}
                          <div className="text-xs text-gray-500">{money(i.basis.amountRefundedCents)}</div>
                        </td>
                        <td className="px-3 py-2 text-right font-mono">
                          {i.lineKind === "adjustment" && i.priorLinesCents !== null && <div className="text-xs text-gray-500">paid {money(i.priorLinesCents)}</div>}
                          {money(i.suggestedCents)}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-gray-600">{money(i.margin.marginCents)}</td>
                        <td className="px-3 py-2">
                          {needsPerson(i) && !view.paid ? (
                            <div className="flex flex-col gap-1 min-w-[12rem]">
                              <select
                                aria-label={`Decision for ${i.reservationNumber}`}
                                value={d?.action ?? ""}
                                disabled={busy !== ""}
                                onChange={(e) => setDraft(i.piId, { action: e.target.value === "pay" || e.target.value === "defer" ? e.target.value : "" })}
                                className="px-2 py-1 border border-gray-300 rounded text-xs"
                              >
                                <option value="">Decide…</option>
                                <option value="pay">{i.lineKind === "adjustment" ? "Record adjustment (0 = reviewed, no change)" : "Pay amount"}</option>
                                <option value="defer">Defer to next statement</option>
                              </select>
                              {d?.action === "pay" && (
                                <>
                                  <input
                                    aria-label={`Amount in dollars for ${i.reservationNumber}`}
                                    value={d.amount}
                                    disabled={busy !== ""}
                                    onChange={(e) => setDraft(i.piId, { amount: e.target.value })}
                                    placeholder={i.lineKind === "adjustment" ? "-38.21" : "38.21"}
                                    inputMode="decimal"
                                    className="px-2 py-1 border border-gray-300 rounded text-xs font-mono"
                                  />
                                  <input
                                    aria-label={`Note for ${i.reservationNumber}`}
                                    value={d.note}
                                    disabled={busy !== ""}
                                    maxLength={500}
                                    onChange={(e) => setDraft(i.piId, { note: e.target.value })}
                                    placeholder="Why (internal note)"
                                    className="px-2 py-1 border border-gray-300 rounded text-xs"
                                  />
                                </>
                              )}
                            </div>
                          ) : (
                            <span className="text-xs text-gray-500">{needsPerson(i) ? "—" : "Automatic"}</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {view.items.length === 0 && <p className="px-3 py-8 text-center text-gray-500 text-sm">Nothing owed or changed for this month.</p>}
            </div>

            {!view.paid && view.items.length > 0 && (
              <div className="mt-4 flex flex-col md:flex-row md:items-end gap-3 justify-between">
                <div className="flex-1">
                  <label htmlFor={ids.note} className="block text-xs font-medium text-gray-700 mb-1">Statement note (internal, optional)</label>
                  <input
                    id={ids.note}
                    value={statementNote}
                    maxLength={1000}
                    disabled={busy !== ""}
                    onChange={(e) => setStatementNote(e.target.value)}
                    placeholder="e.g. paid by ACH ref 1234"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                  />
                </div>
                <div className="text-right">
                  <p className="text-sm text-gray-700 mb-1">
                    Total to record:{" "}
                    <strong className="font-mono">
                      {prepared?.ok ? (prepared.totalCents < 0 ? `${money(-prepared.totalCents)} owed by the lot` : money(prepared.totalCents)) : "—"}
                    </strong>
                  </p>
                  {prepared && !prepared.ok && <p className="text-xs text-amber-700 mb-1">{prepared.error}</p>}
                  {!view.monthClosed && view.livemode && <p className="text-xs text-amber-700 mb-1">The month is not over yet in the lot&apos;s time.</p>}
                  <button
                    onClick={markPaid}
                    disabled={!canPay}
                    className="px-4 py-2 bg-navy text-white rounded-lg font-medium disabled:opacity-50 flex items-center gap-2 ml-auto"
                  >
                    {busy === "pay" && <Loader2 size={16} className="animate-spin" />}
                    Mark month paid
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
