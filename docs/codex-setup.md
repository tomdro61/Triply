# Codex (OpenAI) review: machine setup

Moved from `CLAUDE.md` on November 11, 2026, unchanged. `/scoped-review` Step 4.5 runs an
adversarial review from OpenAI's Codex (a second model, not primed by Claude's reasoning).
This page is the one-time setup each developer does on each machine.

One-time setup per machine (each dev, in Claude Code):

```
/plugin marketplace add openai/codex-plugin-cc
/plugin install codex@openai-codex
/codex:setup              # offers to npm-install the Codex CLI
! codex login             # sign in with your ChatGPT account
```

- **Windows:** also put `[windows]` / `sandbox = "unelevated"` in
  `~/.codex/config.toml`. Without it Codex can't run any command, reads
  nothing, and returns "No material findings" — an empty review that looks
  clean. Add `model_reasoning_effort = "high"` (top level) for reviews.
- **Model:** reviews use **`gpt-6.1-sol`** at high effort (ChatGPT Plus) —
  `model = "gpt-6.1-sol"` at the top of `~/.codex/config.toml`. Not `gpt-6-astra`:
  it drained the Plus weekly allowance in a day (all models share it). List what your
  account can use with `codex debug models`; confirm with
  `codex exec "Reply OK" < /dev/null` (the header shows `model:`).
- No plugin? `/scoped-review` still runs, and says plainly that Codex was skipped.
- Leave the plugin's **review gate OFF** (it loops and drains usage limits).
- Reviews spend the signed-in ChatGPT account's Codex allowance.
- Codex reads `AGENTS.md` (repo root) for our review guidelines.
- Each review leaves an idle Codex server running that holds its folder open until the Claude
  session ends. Before deleting a temporary worktree a review ran in, stop that one process by
  its PID (never by image name: that kills Claude Code too).
