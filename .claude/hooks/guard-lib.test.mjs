import assert from "node:assert/strict";
import { test } from "node:test";
import { reasonToAsk, stripHeredocs } from "./guard-lib.mjs";

const bash = (command) => reasonToAsk({ tool_name: "Bash", tool_input: { command } });
const asks = (command) => assert.ok(bash(command), `should ask: ${command}`);
const quiet = (command) => assert.equal(bash(command), null, `should stay quiet: ${command}`);

test("skipping the pre-commit gate asks", () => {
  asks("git commit --no-verify -m x");
  asks("cd /c/Projects/Triply_claude/triply && git add a.ts && git commit -q --no-verify -F - <<'EOF'\nfix: x\nEOF");
  asks("git -C triply commit -n -m x");
  asks("git commit -qn -m x");
  asks("git -c core.hooksPath=/dev/null commit -m x");
  asks("git config core.hooksPath .other");
  asks("git config --unset core.hooksPath");
  asks("CLAUDECODE= git commit -m x");
  asks("$env:CLAUDECODE = ''; git commit -m x");
  asks("env -u CLAUDECODE git commit -m x");
});

test("an ordinary commit stays quiet", () => {
  quiet("git commit -m 'fix: x'");
  quiet("git commit -q -F - <<'EOF'\nfix: explain why --no-verify and gh pr merge are prompts\nEOF");
  quiet('git commit -m "docs: never use --no-verify or -n"');
  quiet("git commit --amend --no-edit");
  quiet("git commit -a -m x");
  quiet("git log -n 5 && git commit -m x");
  quiet("git commit -m x && git log -n 5");
  quiet("git commit-graph write -n");
  quiet("echo $CLAUDECODE");
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
  asks("gh api -X PUT repos/tomdro61/Triply/pulls/191/merge");
  asks('gh api -X PUT "repos/tomdro61/Triply/pulls/191/merge"');
  asks("gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: \"x\"}) { clientMutationId } }'");
  asks("vercel --prod");
  asks("npx vercel promote https://x.vercel.app");
  asks("vercel rollback");
});

test("reading PRs and deployments stays quiet", () => {
  quiet("gh pr view 191 --json mergeable,mergeStateStatus");
  quiet("gh pr create --base main --title 'x' --body 'do not gh pr merge yet'");
  quiet("gh pr checks 191");
  quiet("gh api repos/tomdro61/Triply/pulls/191");
  quiet("git merge origin/main");
  quiet("vercel ls");
  quiet("npm test");
});

test("the Vercel deploy tools ask; other tools do not", () => {
  assert.ok(reasonToAsk({ tool_name: "mcp__vercel__request_promote", tool_input: {} }));
  assert.ok(reasonToAsk({ tool_name: "mcp__vercel__request_rollback", tool_input: {} }));
  assert.ok(reasonToAsk({ tool_name: "mcp__vercel__create_deployment", tool_input: {} }));
  assert.equal(reasonToAsk({ tool_name: "mcp__vercel__get_deployment", tool_input: {} }), null);
});

test("malformed input stays quiet", () => {
  assert.equal(reasonToAsk(undefined), null);
  assert.equal(reasonToAsk({}), null);
  assert.equal(reasonToAsk({ tool_name: "Bash", tool_input: {} }), null);
  assert.equal(reasonToAsk({ tool_name: "Bash", tool_input: { command: 42 } }), null);
});

test("stripHeredocs removes the body and keeps what follows", () => {
  const out = stripHeredocs("git commit -F - <<'EOF'\nbody --no-verify\nEOF\ngit push");
  assert.doesNotMatch(out, /no-verify/);
  assert.match(out, /git push/);
});
