import assert from "node:assert/strict";
import test from "node:test";

import {
  AcpRunnerRegistry,
  defaultAcpRunnerRegistry,
  type AcpRunnerRegistration,
} from "../src/core/acp-runner-registry.ts";

test("default ACP runner registry is the single source for all built-in runtimes", () => {
  assert.deepEqual(
    defaultAcpRunnerRegistry.list().map((registration) => registration.kind),
    ["claude-code", "codex", "codebuddy", "dsh", "workbuddy"],
  );
  assert.equal(defaultAcpRunnerRegistry.runtimeMap().get("codex")?.kind, "codex");
  assert.equal(defaultAcpRunnerRegistry.runtimeMap().get("dsh")?.kind, "dsh");
  assert.equal(defaultAcpRunnerRegistry.get("dsh")?.availabilityKey, "dsh");
  assert.equal(defaultAcpRunnerRegistry.get("dsh")?.resolveProbeCommand(), "dsh");
  // workbuddy 是独立席位：kind 与可用性键独立，探测命令是应用包内的
  // 绝对路径（按名查找会误中 CodeBuddy Code 的同名 CLI）。
  assert.equal(defaultAcpRunnerRegistry.runtimeMap().get("workbuddy")?.kind, "workbuddy");
  assert.equal(defaultAcpRunnerRegistry.get("workbuddy")?.availabilityKey, "workbuddy");
  const probeCommand = defaultAcpRunnerRegistry.get("workbuddy")?.resolveProbeCommand() ?? "";
  assert.ok(probeCommand.endsWith("codebuddy"), `unexpected workbuddy probe command: ${probeCommand}`);
  assert.ok(probeCommand.includes("WorkBuddy"), `workbuddy probe must point inside the app bundle: ${probeCommand}`);
});

test("ACP runner registry rejects mismatched and duplicate registrations", () => {
  const registration = defaultAcpRunnerRegistry.get("codex")!;
  const registry = new AcpRunnerRegistry([registration]);
  assert.throws(() => registry.register(registration), /already registered/);

  const mismatch = {
    ...registration,
    kind: "codebuddy",
  } satisfies AcpRunnerRegistration;
  assert.throws(() => new AcpRunnerRegistry([mismatch]), /kind mismatch/);
});
