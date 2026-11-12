// Decides which tool calls must be approved by a person, whatever permission
// mode the session is in. Pure, so it is unit-tested (guard-lib.test.mjs).
//
// It only ever answers "ask" or nothing. It never allows (that would
// pre-approve everything chained after the command) and never denies.
//
// This is a guardrail against taking a shortcut, not a security boundary: a
// git alias, a cleared environment or an edited hook file gets past it. The
// real gate is on the server (required CI checks and branch protection).

// Tools that change what production serves. The matcher in
// .claude/settings.json must list every name here (a test checks it).
export const VERCEL_DEPLOY_TOOLS = [
  "mcp__vercel__request_promote",
  "mcp__vercel__request_rollback",
  "mcp__vercel__create_deployment",
  "mcp__vercel__assign_alias",
  "mcp__vercel__update_route_versions",
  "mcp__vercel__update_bulk_redirect_version",
  "mcp__vercel__start_rolling_release",
  "mcp__vercel__approve_rolling_release_stage",
  "mcp__vercel__complete_rolling_release",
  "mcp__vercel__pause_project",
  "mcp__vercel__unpause_project",
];

// A heredoc: the marker, the rest of its line (kept), a body that may be
// empty, and the closing word on its own line.
const HEREDOC_RE = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1([^\n]*)\n(?:[\s\S]*?\n)??[ \t]*\2[ \t]*(?=\n|$)/;

// Quoted strings and shell comments, found in ONE left-to-right pass so that
// whichever opens first wins: an apostrophe inside "double quotes" or inside
// a # comment must not pair with a later single quote.
const QUOTED_OR_COMMENT_RE = /'[^']*'|"(?:[^"\\]|\\.)*"|(?<![^\s;&|(])#[^\n]*/g;

/**
 * Drops heredoc bodies and PowerShell here-strings (message text is not a
 * command) and joins continued lines, so one command is one line. Whatever
 * follows the heredoc marker on its own line is still command text
 * (`<<'EOF' && gh pr merge 1`), so it is kept.
 */
export function stripHeredocs(command) {
  let text = command.replace(/\r\n/g, "\n");
  // One heredoc at a time, until none is left: the kept tail of an opening
  // line can open a second heredoc (`<<'A' && cat <<'B'`).
  for (let before; before !== text; ) {
    before = text;
    text = text.replace(HEREDOC_RE, (_all, _quote, _word, rest) => ` ${rest}`);
  }
  return text
    .replace(/@'[\s\S]*?\n'@/g, " ")
    .replace(/@"[\s\S]*?\n"@/g, " ")
    .replace(/[\\`]\n/g, " "); // bash `\` and PowerShell backtick continuations
}

/** Also drops quoted strings and comments, for rules where a quoted mention is only prose. */
export function stripQuoted(command) {
  return stripHeredocs(command).replace(QUOTED_OR_COMMENT_RE, " ");
}

// One command of a chain: stop at ; & | and newlines.
const SEG = "[^;&|\\n]*";

// `git … commit … --no-verify` (or any prefix git accepts: --no-v, --no-ver)
// or a short-option cluster containing n (-n, -qn). `commit` must be its own
// word (not a path, not commit-graph); the cluster stops at an option that
// takes a value (-m, -F, -C, -c, -u, -S, -t), so `-uno` is not `-n`.
const SKIP_GATE_RE = new RegExp(
  `\\bgit\\b${SEG}(?<=\\s)commit(?=\\s|$)${SEG}(--no-v[a-z-]*|\\s-(?:(?![mFCcuSt])[a-zA-Z])*n[a-zA-Z]*(?=[\\s;&|)]|$))`,
);

// A string handed to another shell is still a command: its quoted argument
// is checked with every rule. Group 1 is a "double-quoted" argument (escapes
// allowed, as in stripQuoted), group 2 a 'single-quoted' one.
const SHELL_STRING_RE =
  /\b(?:bash|sh|zsh|pwsh|powershell|cmd|eval|Invoke-Expression|iex)\b[^;&|\n'"]*?(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/gi;

// `vercel` as a command word (not vercel.json, not notes/vercel-x.md). A
// local `vercel build` and the read-only subcommands stay quiet.
const VERCEL_PROD_RE = new RegExp(
  `(?:^|[\\s;&|(])vercel(?:@[\\w.-]+)?(?=\\s|$)(?!\\s+build\\b)${SEG}` +
    `(--prod\\b|--target[= ]+production\\b|\\bpromote\\b(?!\\s+status)|\\brollback\\b(?!\\s+status)` +
    `|\\balias(?:es)?\\b(?!\\s+(?:ls|list)\\b)|\\bredeploy\\b)`,
);

const SKIP_GATE =
  "`git commit --no-verify` skips the pre-commit gate (typecheck and tests). Approve only if the failure is not caused by this commit.";
const PRODUCTION = "This changes what production serves (Vercel deploy, promote, rollback, alias or pause). Tom approves these.";

/**
 * @param {{tool_name?: string, tool_input?: {command?: string}}} input the hook's stdin
 * @returns {string | null} why a person must approve, or null to stay out of the way
 */
export function reasonToAsk(input, depth = 0) {
  if (VERCEL_DEPLOY_TOOLS.includes(input?.tool_name ?? "")) return PRODUCTION;

  const command = input?.tool_input?.command;
  if (typeof command !== "string" || !command) return null;

  const noHeredocs = stripHeredocs(command);
  const bare = stripQuoted(command);

  // Skipping or disabling the pre-commit gate.
  if (SKIP_GATE_RE.test(bare)) return SKIP_GATE;

  if (depth < 2) {
    for (const m of noHeredocs.matchAll(SHELL_STRING_RE)) {
      const text = m[1] !== undefined ? m[1].replace(/\\(["\\$`])/g, "$1") : m[2];
      const inner = reasonToAsk({ tool_name: "Bash", tool_input: { command: text } }, depth + 1);
      if (inner) return inner;
    }
  }

  // Writes to core.hooksPath only: reading it, grepping for it or naming it
  // in a message stays quiet. `words` keeps one placeholder per quoted string,
  // so a quoted VALUE still reads as a write and quoted prose disappears.
  // (A quoted key, `git config 'core.hooksPath' x`, is unquoted first.)
  const words = noHeredocs
    .replace(/(['"])(core\.hooksPath)\1/gi, "$2")
    .replace(QUOTED_OR_COMMENT_RE, (m) => (m[0] === "#" ? " " : " QUOTED "))
    .replace(/\d*>>?(?:&\d+|\s*[^\s;&|]+)/g, " "); // redirects (2>/dev/null, 2>&1) are not a value
  if (
    /-c\s+["']?core\.hooksPath\s*=/i.test(noHeredocs) ||
    (/GIT_CONFIG_(?:KEY_\d+|PARAMETERS)/.test(bare) && /core\.hooksPath/i.test(noHeredocs)) ||
    /\bconfig\b[^;&|\n]*\bcore\.hooksPath\b(?![ \t]*(?:$|[;&|\n)]))/i.test(words) ||
    /\bconfig\b[^;&|\n]*(?:--unset(?:-all)?|\bunset)\b[^;&|\n]*\bcore\.hooksPath\b/i.test(words)
  ) {
    return "This changes or overrides core.hooksPath, which is what installs the pre-commit gate.";
  }
  // Setting or clearing CLAUDECODE next to a git command (not mentioning it).
  // (A quoted `"env:CLAUDECODE"` path is unquoted first.)
  const envWords = noHeredocs.replace(/(['"])(env:\\?CLAUDECODE)\1/gi, "$2").replace(QUOTED_OR_COMMENT_RE, " ");
  if (
    /\bgit\b/.test(bare) &&
    (/\bCLAUDECODE[ \t]*=|\benv\b[^;&|\n]*-u[ \t]*CLAUDECODE\b|\bunset\b[^;&|\n]*\bCLAUDECODE\b|\b(?:Remove-Item|Clear-Item|Set-Item|New-Item|del|ri|rm|ni)\b[^;&|\n]*env:\\?CLAUDECODE/i.test(
      envWords,
    ) ||
      (/SetEnvironmentVariable\s*\(/i.test(bare) && /SetEnvironmentVariable\([^)]*CLAUDECODE/i.test(noHeredocs)))
  ) {
    return "This sets or clears CLAUDECODE alongside a git command; the pre-commit gate only runs when CLAUDECODE=1.";
  }

  // Merging to main, or changing what production serves.
  if (/\bgh\s+pr\s+merge\b/.test(bare)) {
    return "Merging a PR deploys to production. Merge only on Tom's explicit go.";
  }
  if (/\bgh\s+api\b/.test(bare) && /(\/merge\b|mergePullRequest|enablePullRequestAutoMerge)/.test(noHeredocs)) {
    return "This merges a PR through the GitHub API. Merge only on Tom's explicit go.";
  }
  if (VERCEL_PROD_RE.test(bare)) return PRODUCTION;
  return null;
}
