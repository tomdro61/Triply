import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { VERCEL_DEPLOY_TOOLS, reasonToAsk, stripHeredocs } from "./guard-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const bash = (command) => reasonToAsk({ tool_name: "Bash", tool_input: { command } });
const asks = (command) => assert.ok(bash(command), `should ask: ${command}`);
const quiet = (command) => assert.equal(bash(command), null, `should stay quiet: ${command}`);

test("skipping the pre-commit gate asks", () => {
  asks("git commit --no-verify -m x");
  asks("cd /c/Projects/Triply_claude/triply && git add a.ts && git commit -q --no-verify -F - <<'EOF'\nfix: x\nEOF");
  asks("git -C triply commit -n -m x");
  asks("git commit -qn -m x");
  asks("git commit -m x -n");
  asks("git commit --no-v -m x");
  asks("git commit --no-ver -m x");
  // -n directly before a separator (PowerShell chains with `;` and no space)
  asks('git commit -m "x" -n; git status');
  asks("(git commit -m x -n)");
  asks("git commit -m x -n&& git push");
  // continued lines are one command
  asks("git commit \\\n  --no-verify \\\n  -m x");
  asks("git commit -m x `\n  --no-verify");
  asks("git commit \\\r\n  --no-verify -m x");
  // an apostrophe in the message must not hide what follows
  asks(`git commit -m "fix: the lot's price" --no-verify && git log --format='%h %s' -1`);
  asks(`git commit -m "fix: user's cart" --no-verify; Write-Host 'done'`);
});

test("the rest of a heredoc's opening line is still a command", () => {
  asks("git commit -F - <<'EOF' && gh pr merge 191 --squash\nfix: x\nEOF");
  asks("git commit -F - <<'EOF' && vercel --prod\nfix: x\nEOF");
  asks("cat <<'EOF' | git commit -n -F -\nfix: x\nEOF");
  asks("git commit -F - <<'EOF' --no-verify\nfix: x\nEOF");
  quiet("git commit -q -F - <<'EOF' && git push\nfix: mention gh pr merge\nEOF");
});

test("a command handed to another shell is checked too", () => {
  asks('bash -c "git commit --no-verify -m x"');
  asks('bash -c "git commit -n -m x"');
  asks('powershell -Command "git commit --no-verify -m x"');
  asks('bash -c "gh pr merge 191 --merge"');
  asks('bash -c "vercel --prod"');
  asks("bash -c 'vercel promote x'");
  asks('bash -c "gh api -X PUT repos/o/r/pulls/1/merge"');
  // an escaped quote inside the string must not cut it short
  asks('bash -c "git commit -m \\"x\\" --no-verify"');
  asks('bash -c "git commit -m \\"x\\" && gh pr merge 1"');
  quiet('git add scripts/setup.sh && git commit -m "chore: setup.sh no longer passes --no-verify"');
  quiet('bash -c "npm test"');
});

test("changing the hooks path or CLAUDECODE asks; reading or naming them does not", () => {
  asks("git -c core.hooksPath=/dev/null commit -m x");
  asks('git -c "core.hooksPath=/dev/null" commit -m x');
  asks("git config core.hooksPath .other");
  asks('git config core.hooksPath "/dev/null"');
  asks("git config core.hookspath /dev/null");
  asks("git config --unset core.hooksPath");
  asks("CLAUDECODE= git commit -m x");
  asks('CLAUDECODE="" git commit -m x');
  asks("$env:CLAUDECODE = ''; git commit -m x");
  asks("env -u CLAUDECODE git commit -m x");
  asks("Remove-Item Env:CLAUDECODE; git commit -m x");
  asks("Clear-Item Env:\\CLAUDECODE; git commit -m x");
  asks("[Environment]::SetEnvironmentVariable('CLAUDECODE', $null); git commit -m x");
  asks("GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null git commit -m x");
  quiet("git config core.hooksPath");
  quiet("git config core.hooksPath 2>/dev/null || echo unset");
  quiet("git config --get core.hooksPath 2>&1");
  quiet("git config core.hooksPath 2>$null");
  quiet('git commit -m "docs: npm install runs git config core.hooksPath .githooks"');
  quiet('git commit -m "docs: the installer sets core.hooksPath=.githooks"');
  quiet('rg -n "git config core.hooksPath x" .');
  quiet("git config --get core.hooksPath");
  quiet("git config core.hooksPath && git status");
  quiet("git grep -n core.hooksPath");
  quiet('git commit -m "chore: npm install sets core.hooksPath"');
  quiet('git commit -m "docs: the gate runs only when CLAUDECODE=1"');
  quiet("git log --grep CLAUDECODE");
  quiet("echo $CLAUDECODE");
});

test("an ordinary commit stays quiet", () => {
  quiet("git commit -m 'fix: x'");
  quiet("git commit -q -F - <<'EOF'\nfix: explain why --no-verify and gh pr merge are prompts\nEOF");
  quiet('git commit -m "docs: never use --no-verify or -n"');
  quiet("git commit --amend --no-edit");
  quiet("git commit -a -m x");
  quiet("git commit -uno -m x");
  quiet("git log -n 5 && git commit -m x");
  quiet("git commit -m x && git log -n 5");
  quiet(`git commit -m "fix: the lot's price" && git log --format='%h %s' -n 3`);
  quiet("git log --oneline .githooks/pre-commit.mjs -n 3");
  quiet("git commit-graph write -n");
  quiet("git commit -m x 2>&1 | tail -n 5");
});

test("a PowerShell here-string message is not a command", () => {
  quiet("git commit -m @'\nfix: mention gh pr merge and --no-verify\n'@");
  assert.ok(
    reasonToAsk({ tool_name: "PowerShell", tool_input: { command: "git commit --no-verify -m @'\nx\n'@" } }),
  );
});

test("merging and production deploys ask", () => {
  asks("gh pr merge 191 --merge");
  asks("cd triply && gh pr merge 191 --squash --delete-branch");
  asks(`gh pr comment 191 --body "Tom's go given" && gh pr merge 191 --squash && echo 'merged'`);
  asks("gh api -X PUT repos/tomdro61/Triply/pulls/191/merge");
  asks('gh api -X PUT "repos/tomdro61/Triply/pulls/191/merge"');
  asks("gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: \"x\"}) { clientMutationId } }'");
  asks("gh api graphql -f query='mutation { enablePullRequestAutoMerge(input: {pullRequestId: \"x\"}) { clientMutationId } }'");
  asks("vercel --prod");
  asks("npx vercel@latest --prod");
  asks("npx vercel promote https://x.vercel.app");
  asks("vercel rollback");
  asks("vercel deploy --target production");
  asks("vercel --target=production");
  asks("vercel deploy \\\n  --prod");
  asks("vercel alias set x.vercel.app www.triplypro.com");
  asks("vercel redeploy x.vercel.app");
  asks(`git commit -m "fix: the lot's price" && vercel --prod && echo 'deployed'`);
});

test("reading PRs and deployments stays quiet", () => {
  quiet("gh pr view 191 --json mergeable,mergeStateStatus");
  quiet("gh pr create --base main --title 'x' --body 'do not gh pr merge yet'");
  quiet("gh pr checks 191");
  quiet("gh pr list --state merged");
  quiet("gh api repos/tomdro61/Triply/pulls/191");
  quiet("git merge origin/main");
  quiet("vercel ls");
  quiet("vercel build --prod");
  quiet("vercel alias ls");
  quiet("vercel rollback status");
  quiet("vercel promote status");
  quiet("cat notes/vercel-rollback-plan.md");
  quiet("git add vercel.json src/components/promo/promote-banner.tsx");
  quiet("npm test");
});

test("the Vercel deploy tools ask; other tools do not", () => {
  for (const tool_name of VERCEL_DEPLOY_TOOLS) assert.ok(reasonToAsk({ tool_name, tool_input: {} }), tool_name);
  assert.equal(reasonToAsk({ tool_name: "mcp__vercel__get_deployment", tool_input: {} }), null);
});

test("malformed input stays quiet", () => {
  assert.equal(reasonToAsk(undefined), null);
  assert.equal(reasonToAsk({}), null);
  assert.equal(reasonToAsk({ tool_name: "Bash", tool_input: {} }), null);
  assert.equal(reasonToAsk({ tool_name: "Bash", tool_input: { command: 42 } }), null);
});

test("stripHeredocs removes each kind of body and keeps what follows", () => {
  const forms = [
    "git commit -F - <<'EOF'\nBODY\nEOF\ngit push",
    'git commit -F - <<"EOF"\nBODY\nEOF\ngit push',
    "git commit -F - <<EOF\nBODY\nEOF\ngit push",
    "git commit -F - <<-EOF\n\tBODY\n\tEOF\ngit push",
    "git commit -F - <<'EOF'\r\nBODY\r\nEOF\r\ngit push",
    "git commit -m @'\nBODY\n'@\ngit push",
    'git commit -m @"\nBODY\n"@\ngit push',
  ];
  for (const form of forms) {
    const out = stripHeredocs(form);
    assert.doesNotMatch(out, /BODY/, form);
    assert.match(out, /git push/, form);
  }
});

// A typo in the matcher or the output shape would switch the whole guard off
// without a sound, so the wiring is tested too.
test("settings.json registers the guard for every tool it knows", () => {
  const settings = JSON.parse(readFileSync(join(here, "..", "settings.json"), "utf8"));
  const entry = settings.hooks.PreToolUse.find((e) => e.hooks.some((h) => h.args?.some((a) => a.endsWith("guard.mjs"))));
  assert.ok(entry, "no PreToolUse entry runs guard.mjs");
  const matcher = new RegExp(`^(?:${entry.matcher})$`);
  for (const tool of ["Bash", "PowerShell", ...VERCEL_DEPLOY_TOOLS]) assert.match(tool, matcher);
  const script = entry.hooks[0].args.at(-1).replace("${CLAUDE_PROJECT_DIR}", join(here, "..", ".."));
  assert.ok(existsSync(script), script);
});

test("guard.mjs prints an ask decision, and nothing on bad input", () => {
  const guard = (stdin) => spawnSync(process.execPath, [join(here, "guard.mjs")], { input: stdin, encoding: "utf8" });
  const hit = guard(JSON.stringify({ tool_name: "Bash", tool_input: { command: "gh pr merge 1" } }));
  assert.equal(hit.status, 0);
  assert.equal(JSON.parse(hit.stdout).hookSpecificOutput.permissionDecision, "ask");
  assert.equal(JSON.parse(hit.stdout).hookSpecificOutput.hookEventName, "PreToolUse");
  const miss = guard(JSON.stringify({ tool_name: "Bash", tool_input: { command: "git status" } }));
  assert.deepEqual([miss.status, miss.stdout], [0, ""]);
  const bad = guard("not json");
  assert.deepEqual([bad.status, bad.stdout], [0, ""]);
});
