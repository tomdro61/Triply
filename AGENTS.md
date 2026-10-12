# Triply — AGENTS.md

Read by OpenAI Codex (local plugin reviews and GitHub PR reviews). The full
team contract is `CLAUDE.md` in this directory; this file is the short version
for reviewers.

Triply (triplypro.com) is an airport-parking marketplace: Next.js 16 App
Router, TypeScript strict, Supabase (Postgres), Stripe, Reservations Lab
("ResLab") booking API, Resend email, Vercel. Real customers pay real money
through this code.

## Review guidelines

Report only issues you can tie to specific lines. Rank Critical / High / Medium.
These are the failure modes this codebase has actually shipped — look for them first:

- **Silent defaults for customer data.** `searchParams.get("x") || "default"`,
  default props like `= "10:00 AM"` on booking/email components. Required booking
  data must be validated at the boundary and rejected when missing.
- **Booking times are literal airport-local strings.** Any `toISOString()`,
  `new Date()` math, `+ "Z"` or timezone conversion applied to them is a bug.
  DB columns for wall-clock times are `TIMESTAMP`, not `TIMESTAMPTZ`.
- **Swallowed errors.** Supabase and Resend calls RESOLVE `{ error }` — they
  don't throw — so an unchecked `{ data }` is a silent failure. No
  `catch { /* continue */ }` on money/auth paths; distinguish 401/403/404/5xx.
- **Failures shown as numbers.** In reports, dashboards and the daily digest a
  failed or partial metric must never display as 0 or as a confident value.
  PostgREST caps responses at 1,000 rows — an un-paged read can look complete.
- **Money order of operations.** Authorize → create the ResLab reservation →
  capture. Never trust a client-sent amount, user id, or plan; fulfilment books
  what the Stripe PaymentIntent was charged.
- **Unbounded third-party calls.** A ResLab/Stripe/DB call on a request path
  needs a timeout; a "fail open" that relies on a catch block does not fail open
  when the function times out first.
- **Shared database.** Staging and production write to the SAME Supabase
  project. Readers of a new row kind must ship before anything writes one.
  Anything added to `bookings` is customer-readable via RLS — private data goes
  in a service-role-only table.
- **AI-written text.** Prompts must not invite the model to state anything the
  supplied data doesn't show (causes, likely sources, invented numbers).
- **Types.** No `any`; no casts through `unknown`; Zod at API boundaries.

Don't flag: style nits, pre-existing issues outside the diff, `Date.now`
purity lint warnings.
