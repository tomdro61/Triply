---
name: harden-plan
description: Adversarial multi-agent review of a PLAN / design doc / RFC / migration doc (not a code diff) to make it bulletproof before any code is written. Fans out independent expert reviewers across distinct lenses, adversarially verifies every finding against the real code, then synthesizes concrete amendments and runs a final residual-risk gate. Use when the user wants a plan/design/RFC pressure-tested, or says "harden this plan", "review this design", "is this plan bulletproof". For reviewing an already-written code diff, use /scoped-review or /code-review instead.
---

# /harden-plan — Adversarial multi-agent plan review

Pressure-test a **design artifact** (plan, RFC, migration plan, architecture doc) *before*
any code is written — the cheapest place to catch a bug. This spawns many subagents and is
token-heavy; invoking this skill is the explicit opt-in to run the Workflow.

## When to use
- The user points you at a plan/design/RFC/migration doc and wants it made bulletproof.
- Before committing to a risky implementation (auth, money, schema/migrations, data
  backfills, anything touching a shared/production database).
- NOT for reviewing a finished code diff — that's `/scoped-review` (Triply) or `/code-review`.

## How to run it

1. **Resolve the target doc.** Use the path the user gave in their args. If they didn't name
   one, ask which doc (or offer the most recently edited plan/`notes/*.md`). The target
   should be a real artifact, not a vague "review my project."

2. **Scope the review to the doc.** Skim the doc first. The bundled workflow ships 7 general
   lenses (security, data-migration, correctness, regression, completeness, operational,
   first-principles) that apply to almost any plan — keep them. If the doc has an unusual
   risk surface the defaults under-weight (e.g. concurrency, ML, compliance), pass an
   `extraLenses` array and/or a `focus` string. If the user says "go deep" / "IDC about
   tokens", the defaults already run at high/max effort — no change needed.

3. **Run the bundled workflow.** Call the Workflow tool with the script in this skill's
   directory and pass the doc path (and repo root so reviewers can verify claims against
   real code):

   ```
   Workflow({
     scriptPath: "<this skill dir>/harden-plan.workflow.js",
     args: { doc: "<absolute path to the plan>", repo: "<repo root, usually cwd>", focus: "<optional>" }
   })
   ```
   (On the user's machine this skill lives at `~/.claude/skills/harden-plan/`. `args` also
   accepts a bare string = the doc path.) It runs in the background; you'll be notified on
   completion. Watch live with `/workflows`.

4. **Read the FULL result, not just the notification.** The tool result is often truncated —
   open the output file it names and read `synthesis` (blockingIssues, contradictions,
   amendments), `gate` (isBulletproof, residualRisks), and the Critical/High `survivors`.
   The journal path is given for per-finding detail.

5. **Fold the outcome back into the doc.** Add an authoritative "Review outcome (v2)"
   section: the blocking prerequisites, the corrected plan (with any contradiction the gate
   found reconciled), the amendments by phase, and the residual-risk table. Add a banner at
   the top if the original order/approach turned out unsafe. Then report to the user: lead
   with the Critical/High findings and the gate verdict, and list what must be settled
   before coding.

## What makes it trustworthy
- **Every finding is adversarially verified against the real code** before it counts —
  refuted findings are dropped. Single-pass review's main failure mode is plausible-but-wrong
  findings; the verify pass kills them (~15-20% get refuted on real runs).
- **The synthesizer must check its own amendments for mutual contradictions**, and **the
  final gate re-attacks the amended plan** — on the run this skill was built from, the gate
  caught a Critical contradiction *between two amendments* that everything upstream missed.
- Scale is the point: 5-7 reviewers × per-finding verification × synthesis × gate. Don't
  apologize for the token cost — the user opted in by invoking this.

## Tuning
Edit `harden-plan.workflow.js` in this directory to add/adjust lenses, schemas, or effort.
The lens set is a plain array near the top (`DEFAULT_LENSES`).
