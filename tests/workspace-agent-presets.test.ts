import assert from "node:assert/strict";
import test from "node:test";

import { initialAgentConfigsForWorkspacePreset, preferredRuntimeFromAvailability } from "../src/core/workspace-agent-presets.ts";
import { PRESET_IDS } from "../src/core/workspace-presets.ts";
import type { RuntimeAvailability } from "../src/shared/types.ts";

function runtime(runtime: string, available: boolean): RuntimeAvailability {
  return {
    runtime,
    available,
    path: available ? `${runtime}-path` : null,
    checkedAt: new Date(0).toISOString(),
  };
}

test("software-development preset pre-provisions the full team enabled", () => {
  const configs = initialAgentConfigsForWorkspacePreset(PRESET_IDS.softwareDevelopment);
  assert.ok(configs, "software-development preset should pre-provision agents");
  const enabledIds = configs.filter((config) => config.enabled).map((config) => config.id).sort();

  assert.deepEqual(enabledIds, ["implementation", "solution", "verification"]);
});

test("software-development preset keeps each member's template runtime", () => {
  const configs = initialAgentConfigsForWorkspacePreset(PRESET_IDS.softwareDevelopment);
  assert.ok(configs);
  const byId = new Map(configs.map((config) => [config.id, config]));

  assert.equal(byId.get("solution")?.runtime, "codex");
  assert.equal(byId.get("implementation")?.runtime, "codebuddy");
  assert.equal(byId.get("verification")?.runtime, "dsh");
});

test("software-development preset uses the single locally available runtime for all members", () => {
  const configs = initialAgentConfigsForWorkspacePreset(PRESET_IDS.softwareDevelopment, [
    runtime("claude-agent-acp", false),
    runtime("codex-acp", true),
    runtime("codebuddy", false),
    runtime("dsh", false),
  ]);
  assert.ok(configs);
  const byId = new Map(configs.map((config) => [config.id, config]));

  assert.equal(byId.get("solution")?.runtime, "codex");
  assert.equal(byId.get("implementation")?.runtime, "codex");
  assert.equal(byId.get("verification")?.runtime, "codex");
});

test("software-development preset keeps available template runtimes and falls back for unavailable ones", () => {
  const configs = initialAgentConfigsForWorkspacePreset(PRESET_IDS.softwareDevelopment, [
    runtime("claude-agent-acp", true),
    runtime("codex-acp", true),
    runtime("codebuddy", true),
  ]);
  assert.ok(configs);
  const byId = new Map(configs.map((config) => [config.id, config]));

  // solution/implementation keep their template runtimes; verification's dsh is
  // not in the availability list, so it falls back to the distributed pool.
  assert.equal(byId.get("solution")?.runtime, "codex");
  assert.equal(byId.get("implementation")?.runtime, "codebuddy");
  assert.equal(byId.get("verification")?.runtime, "codebuddy");
});

test("software-development preset falls back through a subset of available runtimes", () => {
  const configs = initialAgentConfigsForWorkspacePreset(PRESET_IDS.softwareDevelopment, [
    runtime("claude-agent-acp", true),
    runtime("codex-acp", true),
    runtime("codebuddy", false),
  ]);
  assert.ok(configs);
  const byId = new Map(configs.map((config) => [config.id, config]));

  assert.equal(byId.get("solution")?.runtime, "codex");
  assert.equal(byId.get("implementation")?.runtime, "codex");
  assert.equal(byId.get("verification")?.runtime, "claude-code");
});

test("software-development preset falls back to claude-code when no runtime is available", () => {
  const configs = initialAgentConfigsForWorkspacePreset(PRESET_IDS.softwareDevelopment, [
    runtime("claude-agent-acp", false),
    runtime("codex-acp", false),
    runtime("codebuddy", false),
    runtime("dsh", false),
  ]);
  assert.ok(configs);
  const byId = new Map(configs.map((config) => [config.id, config]));

  assert.equal(byId.get("solution")?.runtime, "claude-code");
  assert.equal(byId.get("implementation")?.runtime, "claude-code");
  assert.equal(byId.get("verification")?.runtime, "claude-code");
});

test("software-development preset is born aligned under full availability", () => {
  const configs = initialAgentConfigsForWorkspacePreset(PRESET_IDS.softwareDevelopment, [
    runtime("claude-agent-acp", true),
    runtime("codex-acp", true),
    runtime("codebuddy", true),
    runtime("dsh", true),
    runtime("workbuddy", true),
  ]);
  assert.ok(configs);
  assert.equal(configs.length, 3);
  const byId = new Map(configs.map((config) => [config.id, config]));

  const codex = byId.get("solution");
  assert.equal(codex?.name, "Codex");
  assert.equal(codex?.runtime, "codex");
  assert.ok(!codex?.systemPrompt.includes("除非明确分配"));

  const codebuddy = byId.get("implementation");
  assert.equal(codebuddy?.name, "CodeBuddy");
  assert.equal(codebuddy?.runtime, "codebuddy");

  const dsh = byId.get("verification");
  assert.equal(dsh?.name, "DeepSeek-Harness");
  assert.equal(dsh?.runtime, "dsh");
  assert.equal(dsh?.description, undefined);
  assert.equal(dsh?.systemPrompt, "身份与人设以你自身的系统配置为准，此处不另行设定；按本轮协作规则处理任务并回复。");
  assert.deepEqual(dsh?.model, { preferredModelId: "[\"workbuddy-cn\",\"deepseek-v4.1-flash\"]", runtimeKind: "dsh" });

  assert.ok(configs.every((config) => config.enabled));
  assert.ok(configs.every((config) => config.runtime !== "claude-code" && config.runtime !== "workbuddy"));
});

test("empty preset pre-provisions no agents", () => {
  const configs = initialAgentConfigsForWorkspacePreset(PRESET_IDS.empty);

  assert.equal(configs, null);
});

test("unknown preset id pre-provisions no agents", () => {
  const configs = initialAgentConfigsForWorkspacePreset("no-such-team");

  assert.equal(configs, null);
});

test("preferred runtime uses claude-code before codex when both are available", () => {
  assert.equal(preferredRuntimeFromAvailability([
    runtime("claude-agent-acp", true),
    runtime("codex-acp", true),
    runtime("codebuddy", true),
  ]), "claude-code");
});

test("preferred runtime falls back to claude-code when no runtime is available", () => {
  assert.equal(preferredRuntimeFromAvailability([
    runtime("codex-acp", false),
    runtime("claude-agent-acp", false),
    runtime("codebuddy", false),
  ]), "claude-code");
});
