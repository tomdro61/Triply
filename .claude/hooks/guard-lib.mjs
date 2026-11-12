// Decides which tool calls must be approved by a person, whatever permission
// mode the session is in. Pure, so it is unit-tested (guard-lib.test.mjs).
//
// It only ever answers "ask" or nothing. It never allows (that would
// pre-approve everything chained after the command) and never denies.

const VERCEL_DEPLOY_TOOLS = new Set([
  "mcp__vercel__request_promote",
  "mcp__vercel__request_rollback",
  "mcp__vercel__create_deployment",
]);

/** Drops heredoc bodies and PowerShell here-strings: message text is not a command. */
export function stripHeredocs(command) {
  return command
    .replace(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[^\n]*\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g, " ")
    .replace(/@'[\s\S]*?\n'@/g, " ")
    .replace(/@"[\s\S]*?\n"@/g, " ");
}

/** Also drops quoted strings, for rules where a quoted mention is only prose. */
export function stripQuoted(command) {
  return stripHeredocs(command)
    .replace(/'[^']*'/g, " ")
    .replace(/"(?:[^"\\]|\\.)*"/g, " ");
}

// One command of a chain: stop at ; & | and newlines.
const SEG = "[^;&|\\n]*";

/**
 * @param {{tool_name?: string, tool_input?: {command?: string}}} input the hook's stdin
 * @returns {string | null} why a person must approve, or null to stay out of the way
 */
export function reasonToAsk(input) {
  const tool = input?.tool_name ?? "";
  if (VERCEL_DEPLOY_TOOLS.has(tool)) {
    return "This changes what production serves (Vercel promote, rollback or deploy). Tom approves these.";
  }
  const command = input?.tool_input?.command;
  if (typeof command !== "string" || !command) return null;

  const noHeredocs = stripHeredocs(command);
  const bare = stripQuoted(command);

  // Skipping or disabling the pre-commit gate.
  if (new RegExp(`\\bgit\\b${SEG}\\bcommit\\b(?!-)${SEG}(--no-verify\\b|\\s-[a-zA-Z]*n[a-zA-Z]*(\\s|$))`).test(bare)) {
    return "`git commit --no-verify` skips the pre-commit gate (typecheck and tests). Approve only if the failure is not caused by this commit.";
  }
  if (/core\.hooksPath/i.test(noHeredocs)) {
    return "This changes or overrides core.hooksPath, which is what installs the pre-commit gate.";
  }
  if (/\bgit\b/.test(bare) && /\bCLAUDECODE\b/.test(noHeredocs)) {
    return "This touches CLAUDECODE alongside a git command; the pre-commit gate only runs when CLAUDECODE=1.";
  }

  // Merging to main, or changing what production serves.
  if (/\bgh\s+pr\s+merge\b/.test(bare)) {
    return "Merging a PR deploys to production. Merge only on Tom's explicit go.";
  }
  if (/\bgh\s+api\b/.test(bare) && /(\/merge\b|mergePullRequest)/.test(noHeredocs)) {
    return "This merges a PR through the GitHub API. Merge only on Tom's explicit go.";
  }
  if (new RegExp(`\\bvercel\\b${SEG}(--prod\\b|\\bpromote\\b|\\brollback\\b)`).test(bare)) {
    return "This changes what production serves (Vercel deploy, promote or rollback). Tom approves these.";
  }
  return null;
}
