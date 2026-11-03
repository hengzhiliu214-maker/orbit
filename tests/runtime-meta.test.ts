import assert from "node:assert/strict";
import test from "node:test";

import { AGENT_RUNTIME_PRIORITY, runtimeKindToCliKey } from "../src/core/runtime-meta.ts";

test("runtime priority defaults to codex and ranks claude-code last", () => {
  // This order drives every implicit runtime pick: supervisor seeding in the
  // UI (preferredSupervisionRuntime), the preset fallback pool, and the
  // settings page first-available runtime. Codex must stay first so the
  // supervisor defaults to Codex; claude-code stays selectable, ranked last.
  assert.deepEqual(AGENT_RUNTIME_PRIORITY, ["codex", "codebuddy", "dsh", "workbuddy", "claude-code"]);
  assert.equal(AGENT_RUNTIME_PRIORITY[0], "codex");
  assert.equal(AGENT_RUNTIME_PRIORITY[AGENT_RUNTIME_PRIORITY.length - 1], "claude-code");
});

test("supervisor pick over full availability resolves to codex", () => {
  // Mirrors preferredSupervisionRuntime in src/ui/App.tsx: the first priority
  // entry whose CLI key is available. Under full availability (claude-code is
  // always available through its built-in adapter) the pick must be codex,
  // never claude-code.
  const availableCliKeys = new Set(AGENT_RUNTIME_PRIORITY.map((runtime) => runtimeKindToCliKey(runtime)));
  const pick = AGENT_RUNTIME_PRIORITY.find((runtime) => availableCliKeys.has(runtimeKindToCliKey(runtime)));
  assert.equal(pick, "codex");
});
