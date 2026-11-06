import test from "node:test";
import assert from "node:assert/strict";

import {
  buildGraphLiveSignature,
  hashAgentLabels,
  messageGraphToken,
} from "../src/ui/graph-live-signature.ts";
import type { ChatMessage } from "../src/shared/types.ts";

const CONV = "conv_p2_sig";

function user(id: string, content: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id, kind: "user", content, createdAt: "2026-11-06T10:00:00.000Z",
    status: "sent", routeState: "routed", ...extra,
  };
}

function run(id: string, content: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id, kind: "agent", agentId: "solution", runId: `run_${id}`,
    runStatus: "completed", status: "done", content,
    createdAt: "2026-11-06T10:01:00.000Z",
    completedAt: "2026-11-06T10:02:00.000Z",
    parentMessageId: "msg_000001", routeDepth: 1, routeState: "routed",
    ...extra,
  };
}

const labels = new Map([
  ["solution", { label: "Codex", runtime: "codex" }],
  ["supervisor", { label: "监工", runtime: "codebuddy" }],
]);

function sig(messages: ChatMessage[], agents = labels): string {
  return buildGraphLiveSignature(messages, CONV, hashAgentLabels(agents));
}

const base = [user("msg_000001", "请处理第一项任务"), run("msg_000002", "第一项已完成")];

test("签名确定：同一输入两次结果相同", () => {
  assert.equal(sig(base), sig(base));
});

test("同长度正文替换：签名变化（Dot 0137 必测）", () => {
  const changed = [user("msg_000001", "请处理第一项任务"), run("msg_000002", "第一项已办妥")];
  assert.equal(base[1].content.length, changed[1].content.length);
  assert.notEqual(sig(base), sig(changed));
});

test("正文追加：签名变化", () => {
  const changed = [base[0], run("msg_000002", "第一项已完成，补充说明")];
  assert.notEqual(sig(base), sig(changed));
});

test("已有消息父子关系变化：parentMessageId 改变即签名变化", () => {
  const changed = [base[0], run("msg_000002", "第一项已完成", { parentMessageId: "msg_999999" })];
  assert.notEqual(sig(base), sig(changed));
});

test("路由状态变化：routeState / routeDepth 改变即签名变化", () => {
  assert.notEqual(sig(base), sig([base[0], run("msg_000002", "第一项已完成", { routeState: "blocked" })]));
  assert.notEqual(sig(base), sig([base[0], run("msg_000002", "第一项已完成", { routeDepth: 2 })]));
});

test("sessionId 变化：签名变化", () => {
  const changed = [base[0], run("msg_000002", "第一项已完成", { sessionId: "sess-new" })];
  assert.notEqual(sig(base), sig(changed));
});

test("discarded 翻转：签名变化", () => {
  const changed = [base[0], run("msg_000002", "第一项已完成", { discarded: true })];
  assert.notEqual(sig(base), sig(changed));
});

test("plan 当前步变化：in_progress 步内容改变即签名变化", () => {
  const planA: ChatMessage["plan"] = {
    format: "items",
    entries: [
      { content: "第一步", priority: "high", status: "completed" },
      { content: "第二步", priority: "medium", status: "in_progress" },
    ],
  };
  const planB: ChatMessage["plan"] = {
    format: "items",
    entries: [
      { content: "第一步", priority: "high", status: "completed" },
      { content: "第二步改写", priority: "medium", status: "in_progress" },
    ],
  };
  const a = [base[0], run("msg_000002", "执行中", { runStatus: "running", plan: planA })];
  const b = [base[0], run("msg_000002", "执行中", { runStatus: "running", plan: planB })];
  assert.notEqual(sig(a), sig(b));
  // 当前步推进（in_progress 易主）也变化
  const planC: ChatMessage["plan"] = {
    format: "items",
    entries: [
      { content: "第一步", priority: "high", status: "completed" },
      { content: "第二步", priority: "medium", status: "completed" },
      { content: "第三步", priority: "medium", status: "in_progress" },
    ],
  };
  const c = [base[0], run("msg_000002", "执行中", { runStatus: "running", plan: planC })];
  assert.notEqual(sig(a), sig(c));
});

test("plan markdown/file 格式内容变化不进签名（DTO 的 planCurrentStep 只取 items 步）", () => {
  const a = [base[0], run("msg_000002", "执行中", {
    runStatus: "running",
    plan: { id: "p1", format: "markdown", content: "# 计划 A" },
  })];
  const b = [base[0], run("msg_000002", "执行中", {
    runStatus: "running",
    plan: { id: "p1", format: "markdown", content: "# 计划 B 完全不同" },
  })];
  assert.equal(sig(a), sig(b));
});

test("activity 单独变化不进签名（导图/问题台都不读 activity）", () => {
  const a = [base[0], run("msg_000002", "执行中", { runStatus: "running" })];
  const b = [base[0], run("msg_000002", "执行中", {
    runStatus: "running",
    activity: [{ type: "tool.failed", name: "bash", summary: "boom", timestamp: "2026-11-06T10:01:30.000Z" }],
  })];
  assert.equal(sig(a), sig(b));
});

test("processTimeline 工具结算计数变化：签名变化（问题台输入）", () => {
  const a = [base[0], run("msg_000002", "第一项已完成", { processTimeline: [{ type: "tools", count: 3, failedCount: 0 }] })];
  const b = [base[0], run("msg_000002", "第一项已完成", { processTimeline: [{ type: "tools", count: 3, failedCount: 1 }] })];
  assert.notEqual(sig(a), sig(b));
});

test("员工改名 / runtime 变化：签名变化（异步晚到的标签同样触发刷新）", () => {
  const renamed = new Map([
    ["solution", { label: "Codex-改名", runtime: "codex" }],
    ["supervisor", { label: "监工", runtime: "codebuddy" }],
  ]);
  assert.notEqual(sig(base), sig(base, renamed));
  const runtimeChanged = new Map([
    ["solution", { label: "Codex", runtime: "dsh" }],
    ["supervisor", { label: "监工", runtime: "codebuddy" }],
  ]);
  assert.notEqual(sig(base), sig(base, runtimeChanged));
});

test("非图输入字段变化不进签名：附件/交互模式/重试 id/审批模式", () => {
  const changed = [base[0], run("msg_000002", "第一项已完成", {
    attachments: [{ kind: "file", mimeType: "text/plain", id: "att_1", filename: "a.txt", path: "/tmp/a.txt", url: "file:///tmp/a.txt", size: 10, createdAt: "2026-11-06T10:00:00.000Z" }],
    interactionMode: "collaborative",
    clientMessageId: "cm-1",
    runIndex: 7,
    approvalMode: "ask",
  })];
  assert.equal(sig(base), sig(changed));
});

test("消息新增 / 状态迁移 / 完成时刻变化：签名变化（旧签名已覆盖的部分不丢）", () => {
  assert.notEqual(sig(base), sig([...base, user("msg_000003", "再来一项")]));
  assert.notEqual(sig(base), sig([base[0], run("msg_000002", "第一项已完成", { runStatus: "failed", status: "error" })]));
  assert.notEqual(sig(base), sig([base[0], run("msg_000002", "第一项已完成", { completedAt: "2026-11-06T10:03:00.000Z" })]));
});

test("逐消息 token 缓存：同一对象两次计值相同", () => {
  const message = run("msg_000002", "第一项已完成");
  assert.equal(messageGraphToken(message), messageGraphToken(message));
});
