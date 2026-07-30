export const meta = {
  name: 'harden-plan',
  description: 'Adversarial multi-agent review of a plan / design / RFC / migration doc to make it bulletproof before any code is written',
  phases: [
    { title: 'Review', detail: 'independent expert reviewers attack the doc from distinct lenses' },
    { title: 'Verify', detail: 'each finding adversarially verified against the real code/doc' },
    { title: 'Synthesize', detail: 'dedupe + check amendments for mutual contradictions + prioritize' },
    { title: 'Gate', detail: 'final residual-risk gate on the amended plan' },
  ],
}

// args: a string (path to the doc) OR { doc, repo, focus, extraLenses }
const A = (typeof args === 'string') ? { doc: args } : (args || {})
const DOC = A.doc
const REPO = A.repo ? `\nRepo root to verify against: ${A.repo}` : ''
const FOCUS = A.focus ? `\n\nEXTRA FOCUS from the operator (weight heavily): ${A.focus}` : ''
if (!DOC) throw new Error('harden-plan: pass the target doc path as args (string) or args.doc')

const commonHead = `You are an adversarial staff-level reviewer. Your ONE job: find every flaw, gap, wrong assumption, and risk in a technical plan so it becomes bulletproof BEFORE any code is written. Being agreeable is failure — find real problems, but only REAL ones specific to THIS plan and THIS codebase.

FIRST read the plan in full: ${DOC}${REPO}
Then VERIFY its claims against the ACTUAL code — do not trust the plan's file:line refs or its stated behavior; open the files and confirm. A plan that misdescribes the code it changes is the most dangerous kind.${FOCUS}`

const findingRules = (tag) => `\n\nFor every issue return a structured finding: a stable id ("${tag}-1", "${tag}-2", …), a title, severity (Critical = would cause data leak / money loss / broken deploy / corrupt data / security hole; High = feature still broken or a real regression; Medium = gap or fragility; Low = polish), the plan section/phase it applies to, the concrete problem, evidence (file:line or precise reasoning you actually checked), and a CONCRETE fix (the exact change to make to the plan, not "consider X"). Quality over quantity — do not pad, but miss nothing that matters. If a section is genuinely sound, don't invent findings.`

// Default lens set — broadly applicable to design docs, migrations, RFCs.
// Each proved to pull its weight on real runs; keep all, add via args.extraLenses.
const DEFAULT_LENSES = [
  { key: 'SEC', name: 'SECURITY & DATA ISOLATION', body: `Attack every authz/authn and data-isolation vector the plan introduces. Can one user's data reach another? Trust boundaries, injection, over-broad access, secrets, RLS/permission bypass, spoofable inputs, side-effecting reads, identity/ownership assumptions (email/id reuse, deletion, change-over-time). Verify any claimed security control actually holds in the code.` },
  { key: 'DATA', name: 'DATA MIGRATION & INTEGRITY', body: `Attack every migration, backfill, dedup, and constraint. Idempotency, re-run safety, ordering hazards across DEPLOYS not just code, FK/cascade behavior, transaction boundaries, partial-failure recovery, adding constraints against dirty/racing data, backups/rollback, and any shared/production database blast radius.` },
  { key: 'CORR', name: 'CORRECTNESS / PLATFORM SEMANTICS', body: `Verify the proposed mechanisms actually work on the real platform. Do the queries/APIs/SDK calls compile and behave as claimed? Null/empty/timezone/case/encoding edge cases, race conditions, framework-specific gotchas (SSR/cookies/caching), library semantics the plan assumes but hasn't verified.` },
  { key: 'REG', name: 'REGRESSION / BLAST RADIUS', body: `What existing, working behavior could this break? Focus hardest on money paths, auth, and anything with a documented bug history. Trace whether each change alters ordering, error handling, or a hot path. Fail-open vs fail-closed. Interactions with known open bugs.` },
  { key: 'COMP', name: 'COMPLETENESS / MISSED SURFACES', body: `Find surfaces, consumers, and flows the plan MISSES. Grep for every caller/consumer of the thing being changed. Missed UI surfaces, admin, background jobs, other entry points. Failure handling on every surface (not just the happy one). Better signals/approaches the plan ignored.` },
  { key: 'OPER', name: 'OPERATIONAL / ROLLOUT / COST', body: `Deploy order, reversibility, feature-flagging, who runs one-time steps and from where, monitoring adequacy and whether the proposed metric is actually implementable/alertable, cost/quota/egress impact, shared-environment timing where schema and code can disagree, and validating success without exposing sensitive data.` },
  { key: 'FIRS', name: 'FIRST-PRINCIPLES ARCHITECTURE CRITIC', body: `Step back from the plan's framing and attack the ARCHITECTURE. Is this the right fix or a patch on a deeper defect? Is there a simpler/more robust design? Does the phasing create a long inconsistent-state window? Name the single biggest risk the plan underestimates and the single thing most likely to be over-engineered. Weigh alternatives honestly.` },
]
const LENSES = [...DEFAULT_LENSES, ...(A.extraLenses || [])]

const FINDINGS_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    lensSummary: { type: 'string' },
    findings: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      properties: {
        id: { type: 'string' }, title: { type: 'string' },
        severity: { type: 'string', enum: ['Critical', 'High', 'Medium', 'Low'] },
        planSection: { type: 'string' }, problem: { type: 'string' },
        evidence: { type: 'string' }, fix: { type: 'string' },
      },
      required: ['id', 'title', 'severity', 'problem', 'fix'],
    } },
  },
  required: ['lensSummary', 'findings'],
}
const VERDICT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['CONFIRMED', 'PLAUSIBLE', 'REFUTED'] },
    reasoning: { type: 'string' }, evidence: { type: 'string' },
    correctedFix: { type: 'string' },
    revisedSeverity: { type: 'string', enum: ['Critical', 'High', 'Medium', 'Low', 'unchanged'] },
  },
  required: ['verdict', 'reasoning'],
}
const SYNTH_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    blockingIssues: { type: 'array', items: { type: 'string' } },
    contradictions: { type: 'array', items: { type: 'string' }, description: 'Pairs of amendments/findings that conflict and how to reconcile' },
    amendments: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      properties: {
        title: { type: 'string' },
        severity: { type: 'string', enum: ['Critical', 'High', 'Medium', 'Low'] },
        appliesTo: { type: 'string' }, change: { type: 'string' },
        rationale: { type: 'string' },
        sourceFindingIds: { type: 'array', items: { type: 'string' } },
      },
      required: ['title', 'severity', 'appliesTo', 'change'],
    } },
  },
  required: ['summary', 'amendments'],
}
const GATE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    isBulletproof: { type: 'boolean' }, verdict: { type: 'string' },
    residualRisks: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      properties: {
        risk: { type: 'string' }, mitigation: { type: 'string' },
        severity: { type: 'string', enum: ['Critical', 'High', 'Medium', 'Low'] },
      },
      required: ['risk', 'mitigation'],
    } },
  },
  required: ['isBulletproof', 'verdict', 'residualRisks'],
}

// Review each lens, then adversarially verify each of its findings as it lands.
const reviewed = await pipeline(
  LENSES,
  (lens) => agent(`${commonHead}\n\nYOUR LENS — ${lens.name}:\n${lens.body}${findingRules(lens.key)}`, {
    schema: FINDINGS_SCHEMA, phase: 'Review', effort: 'high', label: `review:${lens.key}`,
  }),
  (review, lens) => parallel((review?.findings || []).map((f) => () =>
    agent(`Adversarially verify this review finding against the ACTUAL codebase and the plan at ${DOC}. Default to skepticism — many plausible-sounding findings are wrong once you read the code. Read the relevant source before ruling.${REPO}

FINDING (${lens.key}):
${JSON.stringify(f, null, 2)}

CONFIRMED = proven real against code/plan; PLAUSIBLE = likely real but not fully provable statically; REFUTED = the code/plan already handles it or the premise is wrong. If real but the proposed fix is wrong/incomplete, give the corrected fix. Adjust severity if mis-rated.`, {
      schema: VERDICT_SCHEMA, phase: 'Verify', effort: 'high', label: `verify:${lens.key}:${f.id || '?'}`,
    }).then((v) => ({ ...f, lens: lens.key, verdict: v })).catch(() => null)
  )),
)

const all = reviewed.flat().filter(Boolean)
const survivors = all.filter((f) => f.verdict && f.verdict.verdict !== 'REFUTED')
const refuted = all.filter((f) => f.verdict && f.verdict.verdict === 'REFUTED')
log(`Reviewed ${all.length} findings; ${survivors.length} survived, ${refuted.length} refuted.`)

const synthesis = await agent(`You are the lead engineer consolidating an adversarial review of the plan at ${DOC}. Below are the findings that SURVIVED independent verification (REFUTED ones already dropped). Produce a prioritized, de-duplicated set of CONCRETE amendments — each a specific edit (what to change and in which phase), not a vague suggestion. Prefer the verifier's correctedFix/revisedSeverity when present. Call out BLOCKING issues that must be resolved before any code is written.

CRITICAL EXTRA STEP: check your own amendment set for MUTUAL CONTRADICTIONS — amendments whose combined ordering or requirements can't both be satisfied (e.g. "do X before Y" + "Y depends on X"). List each contradiction and how to reconcile it. A self-contradictory amendment set is worse than none.

SURVIVING FINDINGS (JSON):
${JSON.stringify(survivors.map((f) => ({ id: f.id, lens: f.lens, title: f.title, severity: f.severity, planSection: f.planSection, problem: f.problem, fix: f.fix, verdict: f.verdict.verdict, correctedFix: f.verdict.correctedFix, revisedSeverity: f.verdict.revisedSeverity })), null, 2)}`, {
  schema: SYNTH_SCHEMA, phase: 'Synthesize', effort: 'max', label: 'synthesize',
})

const gate = await agent(`Final gate. Read the current plan (${DOC}) and assume ALL amendments below are applied (including the reconciliations for any listed contradictions). Then attack it once more as the harshest possible reviewer: with these applied, is the plan bulletproof? Name every residual risk that would still bite in production, with a concrete mitigation. Explicitly re-check for any contradiction the synthesis missed. Do not rubber-stamp.${REPO}

AMENDMENTS (JSON):
${JSON.stringify(synthesis.amendments, null, 2)}

DECLARED CONTRADICTIONS (JSON):
${JSON.stringify(synthesis.contradictions || [], null, 2)}`, {
  schema: GATE_SCHEMA, phase: 'Gate', effort: 'high', label: 'final-gate',
})

const sev = (f) => (f.verdict.revisedSeverity && f.verdict.revisedSeverity !== 'unchanged') ? f.verdict.revisedSeverity : f.severity
return {
  doc: DOC,
  stats: { total: all.length, survived: survivors.length, refuted: refuted.length },
  bySeverity: survivors.reduce((a, f) => { const s = sev(f); a[s] = (a[s] || 0) + 1; return a }, {}),
  survivors: survivors.map((f) => ({ id: f.id, lens: f.lens, title: f.title, severity: sev(f), verdict: f.verdict.verdict, problem: f.problem, fix: f.verdict.correctedFix || f.fix })),
  refutedTitles: refuted.map((f) => ({ id: f.id, lens: f.lens, title: f.title, why: f.verdict.reasoning })),
  synthesis,
  gate,
}
