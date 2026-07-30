---
name: sketch-flow
description: Force a state-machine sketch before writing async UI handlers in checkout/payment/state-machine code. Must be invoked before adding any new async handler that mutates existing state, especially in src/components/checkout/, src/app/api/checkout/, src/app/api/reservations/, or any file that interacts with Stripe/PaymentIntent state. Replaces "just start coding" with five minutes of state enumeration that prevents race conditions, lost-update bugs, and removed-safety-check regressions.
---

# /sketch-flow — State machine sketch before async UI code

Use BEFORE writing any new async handler in:

- `src/components/checkout/**`
- `src/app/api/checkout/**`, `src/app/api/reservations/**`, `src/app/api/webhooks/**`
- Any file that calls Stripe, ResLab, Park Guard, Resend, or Supabase from a UI handler
- Any file with multiple `useState` hooks where a new async handler will mutate state

The output is a short sketch (markdown, in chat — no need to write to disk) the user reads BEFORE you write code. **If you can't fill in every section, you're not ready to code.**

## Required sections

### 1. State variables involved

List every `useState` / context / external state this handler touches. For each:

- Name
- Type
- Initial value
- Who else writes to it

### 2. Transitions

Enumerate every state change this handler will cause. For each:

- Trigger (user click, async response, etc.)
- New state values
- Side effects (API call, navigation, Sentry capture, etc.)

### 3. Concurrent input cases

For every async boundary in the handler, ask "what if the user does X before this completes?" Enumerate at least:

- User clicks the same button again (rapid double-click)
- User clicks a different button (back, cancel, toggle the opposite)
- User navigates away
- User refreshes the page

For each: what should happen? Are guards needed (in-flight tracking, AbortController, disabled state, sequence ID)?

### 4. Error paths

For every `await`, `fetch`, `try` block:

- What if it rejects?
- What if it returns a non-OK status?
- What user-visible state should result?
- What goes to Sentry, with what context (which `capture*Error` helper, which fields)?

### 5. Safety checks being removed (if any)

If this change removes ANY of: a `disabled={...}` prop, an early `if (!X) return`, a lock boolean, a validation gate, a try/catch wrapping a money path:

- What was the removed check protecting against?
- Is the protected condition still possible after this change?
- If yes, what replaces the check?
- If no, why is it now impossible?

**If you can't justify a removal in this section, don't remove it.** This is the single most common source of regression bugs in this codebase.

### 6. Anti-patterns check

Apply the Triply-specific anti-patterns from CLAUDE.md against this specific change:

- **Silent fallback defaults for booking data** — does this introduce any (`|| "10:00 AM"`, `?? "default"`, optional Zod fields for required user data)?
- **catch / continue with fallback for API responses** — does this introduce `catch { return null }`, `.catch(() => ({}))`, or any swallowed error path on a money/auth call?
- **toISOString / Date math on booking times** — does this touch any booking time / date and apply UTC conversion?
- **Stripe metadata coupling** — does this read or write PI metadata in a way that depends on a fragile convention (empty string sentinels, key presence vs value, etc.)?
- **TIMESTAMPTZ vs TIMESTAMP** — if a DB write/read is involved, did you check the column type matches the value semantics?

### 7. Shared state coupling

If this handler writes to a state variable also written by other handlers (e.g., `submitError` in checkout-form):

- What other handlers write to the same state?
- Could a stale write from this handler clobber a fresh write from another?
- Should this handler use a separate state slot to avoid conflation?

## After the sketch

Show the sketch to the user. Get acknowledgment. Then implement.

If during implementation you discover the sketch was wrong (you missed a state, missed a concurrent case), STOP and update the sketch. Don't paper over it with code.

## Why this exists

This skill was created on 2026-05-09 after a Park Guard checkout re-architecture introduced ~14 bugs in roughly an hour of coding — most of which the same session's reviewers would have flagged in a state-machine review BEFORE coding started. The pattern was: rushed implementation, no enumeration of concurrent inputs, removed an existing safety check (`protectionPlanLocked`) without analyzing what it was protecting against, copied error-handling patterns into a new context where they didn't fit.

The five minutes of sketching this skill demands prevents the hours of bug-fixing those omissions cost.
