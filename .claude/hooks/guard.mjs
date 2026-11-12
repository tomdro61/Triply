// Claude Code PreToolUse hook (registered in .claude/settings.json).
// Turns a few commands into a prompt for a person: see guard-lib.mjs.
// Any error here exits 0, so a broken hook never blocks work.

import { readFileSync } from "node:fs";
import { reasonToAsk } from "./guard-lib.mjs";

try {
  const reason = reasonToAsk(JSON.parse(readFileSync(0, "utf8")));
  if (reason) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "ask",
          permissionDecisionReason: `[triply guard] ${reason}`,
        },
      }),
    );
  }
} catch {
  // Unreadable input: stay out of the way.
}
