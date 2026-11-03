import assert from "node:assert/strict";
import test from "node:test";
import { runAcp, type AcpConnector } from "../src/core/acp-runtime.ts";
import { DSH_ACP, buildDshAcpArgs } from "../src/core/dsh-acp-runtime.ts";
import type { AgentActivityEvent, AgentModelStateSnapshot } from "../src/shared/types.ts";

const model = (currentValue: string) => ({
  id: "model", name: "Model", type: "select" as const, category: "model" as const,
  currentValue, options: [{ value: "a", name: "A" }, { value: "b", name: "B" }],
});
const effort = (currentValue: string) => ({
  id: "reasoning_effort", name: "Reasoning effort", type: "select" as const,
  category: "thought_level", currentValue,
  options: [{ value: "high", name: "High" }, { value: "max", name: "Max" }],
});

async function simulate(updates: any[], configOptions: any[] = []) {
  const activities: AgentActivityEvent[] = [];
  const snapshots: AgentModelStateSnapshot[] = [];
  const connector: AcpConnector = (_options, notify) => ({
    pid: 1,
    async initialize() { return { protocolVersion: 1, agentCapabilities: {} }; },
    async newSession() { return { sessionId: "mock", configOptions }; },
    async loadSession() { return {}; },
    async resumeSession() { return {}; },
    hasSession() { return false; },
    async setConfigOption() { throw new Error("unexpected setConfigOption"); },
    async prompt() {
      for (const update of updates) notify({ sessionId: "mock", update });
      notify({ sessionId: "mock", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } } });
      return { stopReason: "end_turn" };
    },
    async cancel() {}, close() {}, destroy() {},
  });
  const handle = runAcp({
    agentId: "mock-dsh", cwd: "/tmp", prompt: "mock only",
    onActivity: (event) => activities.push(event),
    onSessionConfig: (snapshot) => snapshots.push(snapshot),
  }, DSH_ACP, connector);
  assert.equal(await handle.result, "done");
  return { activities, snapshots };
}

function tool(status: "completed" | "failed", fields: Record<string, unknown>) {
  return { sessionUpdate: "tool_call_update", toolCallId: "tool-1", title: "Read", status, ...fields };
}
const textContent = [{ type: "content", content: { type: "text", text: "visible tool result" } }];

test("dsh command uses its native ACP profile", () => {
  assert.deepEqual(buildDshAcpArgs(), ["--profile", "acp"]);
});

test("rawOutput reaches the completed tool summary", async () => {
  const { activities } = await simulate([tool("completed", { rawOutput: "raw result" })]);
  const completed = activities.find((item) => item.type === "tool.completed");
  assert.equal(completed?.type === "tool.completed" && completed.summary, "raw result");
});

test("content-only completed text reaches the tool summary", async () => {
  const { activities } = await simulate([tool("completed", { content: textContent })]);
  const completed = activities.find((item) => item.type === "tool.completed");
  assert.equal(completed?.type === "tool.completed" && completed.summary, "visible tool result");
});

test("content-only failed text reaches the tool summary", async () => {
  const { activities } = await simulate([tool("failed", { content: textContent })]);
  const failed = activities.find((item) => item.type === "tool.failed");
  assert.equal(failed?.type === "tool.failed" && failed.summary, "visible tool result");
});

test("when both fields exist the current mapping uses rawOutput", async () => {
  const { activities } = await simulate([tool("completed", { rawOutput: "raw result", content: textContent })]);
  const completed = activities.find((item) => item.type === "tool.completed");
  assert.equal(completed?.type === "tool.completed" && completed.summary, "raw result");
});

test("text arriving before a terminal status remains available", async () => {
  const { activities } = await simulate([
    tool("completed", { content: textContent, status: "in_progress" }),
    tool("completed", {}),
  ]);
  const completed = activities.find((item) => item.type === "tool.completed");
  assert.equal(completed?.type === "tool.completed" && completed.summary, "visible tool result");
});

test("rawOutput arriving before a terminal status remains available", async () => {
  const { activities } = await simulate([
    tool("completed", { rawOutput: "early raw result", status: "in_progress" }),
    tool("completed", {}),
  ]);
  const completed = activities.find((item) => item.type === "tool.completed");
  assert.equal(completed?.type === "tool.completed" && completed.summary, "early raw result");
});

test("text blocks are joined and bounded while non-text blocks are ignored", async () => {
  const { activities } = await simulate([tool("completed", { content: [
    { type: "content", content: { type: "text", text: "first" } },
    { type: "terminal", terminalId: "mock-terminal" },
    { type: "content", content: { type: "text", text: "x".repeat(600) } },
  ] })]);
  const completed = activities.find((item) => item.type === "tool.completed");
  const summary = completed?.type === "tool.completed" ? completed.summary : undefined;
  assert.equal(summary?.length, 500);
  assert.ok(summary?.startsWith("first\nx"));
  assert.ok(summary?.endsWith("..."));
});

test("an empty replacement clears previously received content", async () => {
  const { activities } = await simulate([
    tool("completed", { content: textContent, status: "in_progress" }),
    tool("completed", { content: [] }),
  ]);
  const completed = activities.find((item) => item.type === "tool.completed");
  assert.equal(completed?.type === "tool.completed" && completed.summary, undefined);
});

test("config update refreshes both dsh model and reasoning snapshot", async () => {
  const { snapshots } = await simulate([
    { sessionUpdate: "config_option_update", configOptions: [model("b"), effort("max")] },
  ], [model("a"), effort("high")]);
  assert.equal(snapshots.length, 2);
  assert.deepEqual(snapshots.map((s) => s.currentValue), ["a", "b"]);
  assert.deepEqual(snapshots.map((s) => s.runtimeKind), ["dsh", "dsh"]);
  assert.deepEqual(snapshots.map((s) => s.configId), ["model", "model"]);
  assert.deepEqual(snapshots.map((s) => s.reasoning?.configId), ["reasoning_effort", "reasoning_effort"]);
  assert.deepEqual(snapshots.map((s) => s.reasoning?.currentValue), ["high", "max"]);
});
