---
name: end-session
description: End-of-session documentation ritual. Identifies what changed in the session, maps changes against the documentation update table in CLAUDE.md, RECONCILES existing status claims (CLAUDE.md Current Phase, PROGRESS.md, memory) against git/GitHub/the code so stale "open"/"NEXT" lines get fixed, and proposes specific updates to notes/, PROGRESS.md, and the relevant docs/. Run before closing a session that produced commits, schema changes, new skills, or operational procedures.
---

# /end-session — Documentation update ritual

Triply's CLAUDE.md prescribes session notes + a doc-update mapping
table after every working session. The discipline is easy to forget.
This skill walks the session deltas, matches them to the right docs,
and proposes specific updates.

It also **reconciles the docs with reality** (Step 3). Writing down what
this session did is not enough: every session only ADDS text, so status
lines written weeks ago ("PR #44 still open", "NEXT = 4b-1 soak") stay
wrong forever unless something checks them. (Adopted 2026-10-13 from the
shop-pilot `/handoff` skill, after both of those were found stale in
CLAUDE.md on go-live day.)

**When to invoke:**
- Before closing a session that touched code, ops, or schema
- After a customer incident is resolved
- Anytime CLAUDE.md / PROGRESS / docs are out of sync with what just shipped

**Don't invoke for:** sessions that were pure exploration, planning,
or read-only investigation with no code/commit changes.

**Where things live.** This file (in the `triply` repo) is the one copy;
the parent wrapper's `.claude/skills/end-session/SKILL.md` only points
here. The docs it updates (`notes/`, `PROGRESS.md`, `REVIEW-FINDINGS.md`,
`docs/`, the wrapper `CLAUDE.md`) live in the parent wrapper repo
`C:\Projects\Triply_claude\` — from a session rooted in `triply/` that is
`..`. Run `notify-discord.mjs` from this skill's folder. A contributor
without the wrapper repo (Vin) does Steps 1–3 against `triply/CLAUDE.md`
and the PR record, and skips the wrapper docs.

---

## Step 1 — Inventory what changed

Run these to gather the session delta:

```bash
# Commits made this session (look across both submodule + parent)
git -C triply log --oneline --since="<session-start>" 2>/dev/null
git log --oneline --since="<session-start>"

# Working-tree changes (uncommitted)
git -C triply status --short
git status --short

# DB migrations added this session
ls triply/supabase/migrations/ -t | head -3
```

`<session-start>` = the last `triply` commit SHA named in the newest
`notes/YYYY-MM-DD*.md` (its Commits section, or the `triply → <sha>`
pointer in the wrapper's last `docs:` commit) — diff from there:
`git -C triply log --oneline <sha>..origin/main`. Don't go by the notes
file's DATE: a session that continues over several days keeps adding to
one day's note ("Continues the Oct 12 session…"), so "the newest note
before today" lands on the wrong file or on itself. Only ask the user if
no SHA can be found. Also run
`gh pr list --state open` in `triply/` — an open PR is either this
session's unfinished work or a stale claim to check in Step 3.

Capture:
- New / modified files in `triply/src/`
- New migrations
- New skills in `.claude/skills/`
- New hooks in `.claude/hooks/`
- Modified configs (`.claude/settings.json`)
- Customer impact (any incidents resolved, any URLs/IDs to flag)

If the inventory is empty, tell the user there's nothing to document
and stop.

---

## Step 2 — Map changes to docs

Use the table from CLAUDE.md as the routing matrix. For each change
type triggered, propose specific updates to the listed file(s):

| Change type | Update these |
|---|---|
| Phase / task completion | `PROGRESS.md` |
| Architecture changes | `docs/triply_architecture_overview.md`, `docs/ARCHITECTURE.md` |
| New features / implementation details | `docs/triply_solution_design.md` |
| Build plan changes | `docs/triply_mvp_plan.md` |
| API integration changes | `docs/triply_reslab_integration.md`, `docs/API_REFERENCE.md` |
| API route or endpoint changes | `docs/API_REFERENCE.md` |
| Service / infrastructure changes | `docs/SYSTEM_MAP.md`, `docs/ARCHITECTURE.md` |
| Operational procedures | `docs/OPERATIONS_RUNBOOK.md` |
| Data source / content changes | `docs/DATA_SOURCES.md` |
| Pre-launch task completion | `docs/LAUNCH_CHECKLIST.md` |
| Quick reference changes | `CLAUDE.md` |
| New skill / hook / settings | `CLAUDE.md` (the workflow section), and the skill's own SKILL.md |
| Customer incident | `REVIEW-FINDINGS.md` (incident entry), `notes/YYYY-MM-DD.md` (full session detail) |
| Schema migration | `docs/triply_solution_design.md` (Database Schema section), `notes/YYYY-MM-DD.md` |
| A review (`/scoped-review`, Codex) found Critical/High, or a bug review missed reached a customer | `REVIEW-FINDINGS.md` (one entry per PR: findings, severity, fixed/open, lessons) |
| Something surprising the next session would get wrong (a user decision, a gotcha) | memory — **proposed** in Step 4, the user picks |

Always include:
- A new entry or update to `notes/YYYY-MM-DD.md` (current date in
  America/New_York or wherever the user is — ask if unclear). Format
  matches `notes/2026-02-10-session6.md`: header + Tasks Completed +
  Key Decisions + Issues Encountered + Commits Made + Next Steps.
- A line in `PROGRESS.md` if the change is user-visible or alters
  project state.

---

## Step 3 — Reconcile existing status claims with reality

This is the step that catches drift. Read the status claims the next
session will trust, and verify each one that touches an area this
session worked in (or that looks old):

- `CLAUDE.md` → "Current Phase" checklist (`[ ]` / `[~]` / `[x]` lines, every "NEXT =")
- the top of `PROGRESS.md`
- `MEMORY.md` index lines + the memory files for this session's projects —
  the live store is `C:\Users\tomjd\.claude\projects\C--Projects-Triply-claude\memory\`
  (the `C--Users-tomjd-OneDrive-Desktop-Triply-claude` folder is an empty
  leftover from an old checkout path; auditing it audits nothing)
- the previous session's notes → "Next Steps"

| Claim | Verify with |
|---|---|
| "PR #N open / merged" | `gh pr view N --json state,mergedAt` |
| "X LIVE / shipped" | the merge commit is on `origin/main` (`git branch -r --contains <sha>`), the code exists (`grep`) |
| "migration NNN applied" | the file exists AND Supabase `list_migrations` / a column query shows it |
| "flag / env X on in Production" | the code reads it; Vercel env list shows the target (never print values) |
| "NEXT = …" / "pending: …" | is it done? (git log, gh, the code) — or superseded by a later decision in notes/memory |

**Rule: a checkbox is not evidence.** It was right when written. If you
can't find evidence, say "unverified" — don't guess either way. A
conversation is not a shipped commit.

Classify each: ✅ correct · ⚠️ says open, but done (propose closing, with
the evidence) · ⚠️ says done, but the code disagrees (raise as a question) ·
❌ genuinely still open (leave). Only propose edits for the ⚠️ rows.

**A superseded "NEXT =" or "pending:" is DELETED, not kept.** Don't prefix
it with "Was:" or tuck it under "Earlier:" — the history is in notes/ and
git. Replace the line with the current state and the one real next step.
A long status bullet that has grown "Was: … Earlier: … NEXT = …" layers
is the failure this step exists to stop; rewrite it to its current shape.

---

## Step 4 — Propose updates per doc

For each doc identified in Step 2, propose:
- Where to insert (which section, before/after which heading)
- Exact text to add or modify
- A 1-line trailer entry like `*Updated <date> — <brief reason>*`

Show the user the proposed updates as a batch — don't write yet. Order:

1. `notes/YYYY-MM-DD.md` + `PROGRESS.md` entries
2. other docs from the Step 2 table
3. **Stale claims found in Step 3**, each with its evidence
4. **Memory candidates** — listed, not written; the user picks
5. **Rows of the Step 2 table skipped, each with a reason** ("no migration,
   so no schema doc") — an audit that only lists what it changed can't be
   told apart from one that forgot to look

Ask for approval.

---

## Step 5 — Apply approved updates

Use Edit (preferred — preserves formatting) or Write (only for new
files like `notes/YYYY-MM-DD.md`). For each file:
- Read it first if you haven't
- Make the precise edit
- Don't reformat unrelated content

Commit only when the user says so, and keep doc commits separate
from code commits (parent repo: `docs: <date> — …`, stage only the doc
files + the `triply` pointer — never the unrelated `triply-cms/` noise).

---

## Step 6 — Final summary

Tell the user:
- Which docs got updated (file + brief description)
- Which doc-update categories from the matrix were skipped, and why
- Which stale claims were corrected (and any left as "unverified")
- A one-line "next session pickup" note, e.g., "Resume at: see notes/2026-05-05.md
  Next Steps section"

**Restate every pending follow-up** (apply a migration, a click-through,
an open review item, a day-1 check) — even ones said earlier in the
session. The final message is the one the next session reads.

---

## Step 7 — Publish the summary to the Triply Discord

After the docs are updated, publish a short digest + next priorities to Discord.

1. **Draft** a condensed summary — what shipped / what was decided / any
   customer impact — plus the top 3–5 next priorities. Tighter and plainer
   than the notes file; team-readable, no `file:line` noise.
2. **Write** it to a temp payload JSON in the scratchpad:
   `{ "date": "YYYY-MM-DD", "summary": "…markdown…", "priorities": ["…", "…"] }`
3. **Preview** first: `node triply/.claude/skills/end-session/notify-discord.mjs <payload.json> --dry-run` (from the wrapper; from `triply/` drop the `triply/` prefix)
   — show the user the rendered embed and get a quick OK. It's a team channel,
   but preview-before-publish is the rule for anything sent to an external service.
4. **Post** on OK: same command without `--dry-run`; confirm the ✅.
5. If `DISCORD_SESSION_WEBHOOK_URL` isn't set in `triply/.env.local`, skip this
   step and tell the user Discord publishing isn't configured yet (create a
   channel webhook → paste the URL into `triply/.env.local`).

Keep it concise — a summary paragraph + a bulleted next-priorities list. This is
a team-facing digest, not the full notes.

---

## Don't

- Don't auto-write to docs without first showing the proposed diff.
  Docs are higher-stakes than code — they shape future decisions.
- Don't include trivial changes in session notes ("typo fix in
  README"). Session notes should record decisions, not every keystroke.
- Don't skip the customer-impact section if there was one. Future
  sessions reading the notes need to know what was resolved.
- Don't forget the trailer date stamp on each modified doc — it's
  the cheapest way to spot stale documentation.
- Don't trust a checkbox or a "NEXT =" line — verify it (Step 3).
- Don't skip Step 3 because the session's own notes are done — without
  it this skill is just a session log.

---

## Example dispatch decision

**Session content:**
- Fixed customer bug; 4 commits to triply main; migration 007 applied
- Built 3 new skills, 1 hook, REVIEW-FINDINGS.md
- Resolved Jill's case (FVSPF765362)

**Categories triggered:**
- `Schema migration` → triply_solution_design.md (Database Schema), notes/, PROGRESS.md
- `API endpoint changes` → API_REFERENCE.md (the endpoint that changed)
- `API integration changes` → triply_reslab_integration.md (ResLab quirk)
- `New skill / hook` → CLAUDE.md (workflow section), each SKILL.md self-documents
- `Operational procedures` → OPERATIONS_RUNBOOK.md (new sections for the skills + customer-recovery playbook)
- `Customer incident` → REVIEW-FINDINGS.md, notes/

**Files updated:** 7 (notes/2026-05-04.md, notes/2026-05-05.md,
PROGRESS.md, OPERATIONS_RUNBOOK.md, API_REFERENCE.md,
triply_reslab_integration.md, triply_solution_design.md).

**Skipped (no trigger):** ARCHITECTURE.md, SYSTEM_MAP.md,
DATA_SOURCES.md, LAUNCH_CHECKLIST.md, mvp_plan.md.
