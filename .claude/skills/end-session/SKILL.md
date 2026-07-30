---
name: end-session
description: End-of-session documentation ritual. Identifies what changed in the session, maps changes against the documentation update table in CLAUDE.md, and proposes specific updates to notes/, PROGRESS.md, and the relevant docs/. Run before closing a session that produced commits, schema changes, new skills, or operational procedures. Replaces the discipline of remembering to update docs every time.
---

# /end-session — Documentation update ritual

Triply's CLAUDE.md prescribes session notes + a doc-update mapping
table after every working session. The discipline is easy to forget.
This skill walks the session deltas, matches them to the right docs,
and proposes specific updates.

**When to invoke:**
- Before closing a session that touched code, ops, or schema
- After a customer incident is resolved
- Anytime CLAUDE.md / PROGRESS / docs are out of sync with what just shipped

**Don't invoke for:** sessions that were pure exploration, planning,
or read-only investigation with no code/commit changes.

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

If `<session-start>` is unknown, ask the user how far back to look,
or default to the last commit on `main` plus any newer commits on
`staging`.

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

Always include:
- A new entry or update to `notes/YYYY-MM-DD.md` (current date in
  America/New_York or wherever the user is — ask if unclear). Format
  matches `notes/2026-02-10-session6.md`: header + Tasks Completed +
  Key Decisions + Issues Encountered + Commits Made + Next Steps.
- A line in `PROGRESS.md` if the change is user-visible or alters
  project state.

---

## Step 3 — Propose updates per doc

For each doc identified in Step 2, propose:
- Where to insert (which section, before/after which heading)
- Exact text to add or modify
- A 1-line trailer entry like `*Updated <date> — <brief reason>*`

Show the user the proposed updates as a batch — don't write yet.
Ask for approval.

---

## Step 4 — Apply approved updates

Use Edit (preferred — preserves formatting) or Write (only for new
files like `notes/YYYY-MM-DD.md`). For each file:
- Read it first if you haven't
- Make the precise edit
- Don't reformat unrelated content

For commit hygiene: don't auto-commit doc updates. The user should
review the diff and commit themselves so the message reflects their
intent.

---

## Step 5 — Final summary

Tell the user:
- Which docs got updated (file + brief description)
- Which doc-update categories from the matrix were skipped because
  no changes triggered them
- A one-line "next session pickup" note, e.g., "Resume at: see notes/2026-05-05.md
  Next Steps section"

If any pending follow-ups were noted (e.g., "merge bf53458 to main"),
list them so they don't fall through the cracks.

---

## Step 6 — Publish the summary to the Triply Discord

After the docs are updated, publish a short digest + next priorities to Discord.

1. **Draft** a condensed summary — what shipped / what was decided / any
   customer impact — plus the top 3–5 next priorities. Tighter and plainer
   than the notes file; team-readable, no `file:line` noise.
2. **Write** it to a temp payload JSON in the scratchpad:
   `{ "date": "YYYY-MM-DD", "summary": "…markdown…", "priorities": ["…", "…"] }`
3. **Preview** first: `node .claude/skills/end-session/notify-discord.mjs <payload.json> --dry-run`
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

---

## Example dispatch decision

**Session content:**
- Fixed customer bug; 4 commits to triply main; migration 007 applied
- Built 3 new skills, 1 hook, REVIEW-FINDINGS.md
- Resolved the customer's case (EXAMPLE12345)

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
