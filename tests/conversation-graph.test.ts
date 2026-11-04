import test from "node:test";
import assert from "node:assert/strict";

import { buildConversationGraph } from "../src/core/conversation-graph.ts";
import type { ChatMessage } from "../src/shared/types.ts";

const labels = new Map([
  ["codex", "Codex"],
  ["codebuddy", "CodeBuddy"],
  ["dsh", "DeepSeek-Harness"],
  ["supervisor", "监工"],
]);
const runtimes = new Map([
  ["codex", "codex"],
  ["codebuddy", "codebuddy"],
  ["dsh", "dsh"],
]);

function user(id: string, content: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id, kind: "user", content, createdAt: "2026-06-19T09:00:00.000Z", status: "done", ...extra };
}

function system(id: string, parentMessageId: string): ChatMessage {
  return { id, kind: "system", content: "监工指令", createdAt: "2026-06-19T09:01:00.000Z", parentMessageId };
}

function run(input: {
  id: string;
  parentMessageId?: string;
  agentId: string;
  runStatus?: ChatMessage["runStatus"];
  content?: string;
  routeState?: ChatMessage["routeState"];
  routeDepth?: number;
  discarded?: boolean;
  plan?: ChatMessage["plan"];
  startedAt?: string;
  completedAt?: string;
  createdAt?: string;
}): ChatMessage {
  return {
    id: input.id,
    kind: "agent",
    content: input.content ?? `${input.agentId} 的回复`,
    createdAt: input.createdAt ?? "2026-06-19T09:02:00.000Z",
    parentMessageId: input.parentMessageId,
    agentId: input.agentId,
    runId: `run-${input.id}`,
    runStatus: input.runStatus ?? "completed",
    routeState: input.routeState,
    routeDepth: input.routeDepth,
    discarded: input.discarded,
    plan: input.plan,
    startedAt: input.startedAt ?? "2026-06-19T09:02:00.000Z",
    completedAt: input.completedAt ?? "2026-06-19T09:03:00.000Z",
  };
}

function graph(messages: ChatMessage[]) {
  return buildConversationGraph({
    workspaceId: "ws-1",
    conversationId: "conv-1",
    messages,
    agentLabels: labels,
    agentRuntimes: runtimes,
  });
}

test("多层交接树：父子边、rootId、routeDepth 与子节点计数正确", () => {
  const result = graph([
    user("u1", "@Codex: 设计存储层", { routeState: "routed" }),
    run({ id: "a1", parentMessageId: "u1", agentId: "codex", routeState: "routed", routeDepth: 1 }),
    run({ id: "b1", parentMessageId: "a1", agentId: "codebuddy", routeState: "routed", routeDepth: 2 }),
    run({ id: "c1", parentMessageId: "b1", agentId: "dsh", routeDepth: 3 }),
  ]);

  assert.equal(result.roots.length, 1);
  assert.equal(result.roots[0].id, "u1");
  assert.equal(result.roots[0].nodeCount, 4);
  assert.equal(result.roots[0].status, "completed");

  const byId = new Map(result.nodes.map((node) => [node.id, node]));
  assert.equal(byId.get("a1")?.parentNodeId, "u1");
  assert.equal(byId.get("b1")?.parentNodeId, "a1");
  assert.equal(byId.get("c1")?.parentNodeId, "b1");
  assert.equal(byId.get("c1")?.rootId, "u1");
  assert.equal(byId.get("c1")?.routeDepth, 3);
  assert.equal(byId.get("a1")?.origin, "user");
  assert.equal(byId.get("b1")?.origin, "agent");
  assert.equal(byId.get("u1")?.childCount, 1);
  assert.equal(byId.get("b1")?.childCount, 1);
  assert.equal(byId.get("c1")?.childCount, 0);
  assert.equal(byId.get("a1")?.agentLabel, "Codex");
  assert.equal(byId.get("a1")?.runtime, "codex");

  assert.deepEqual(
    result.edges.map((edge) => edge.id).sort(),
    ["a1->b1", "b1->c1", "u1->a1"],
  );
});

test("监工介入：system 父消息与监工本人派发都记 origin=supervisor", () => {
  const result = graph([
    user("u1", "帮我检查进度", { routeState: "routed" }),
    run({ id: "a1", parentMessageId: "u1", agentId: "codex" }),
    system("s1", "a1"),
    run({ id: "b1", parentMessageId: "s1", agentId: "codebuddy" }),
    run({ id: "sup1", parentMessageId: "u1", agentId: "supervisor" }),
    run({ id: "c1", parentMessageId: "sup1", agentId: "dsh" }),
  ]);
  const byId = new Map(result.nodes.map((node) => [node.id, node]));
  // system 消息不是节点，b1 的父节点跳过它挂到 a1
  assert.equal(byId.has("s1"), false);
  assert.equal(byId.get("b1")?.parentNodeId, "a1");
  assert.equal(byId.get("b1")?.origin, "supervisor");
  // 监工自己的执行派发出的运行记 supervisor
  assert.equal(byId.get("c1")?.parentNodeId, "sup1");
  assert.equal(byId.get("c1")?.origin, "supervisor");
});

test("discarded 消息整体过滤，子运行上溯跳过它", () => {
  const result = graph([
    user("u1", "任务", { routeState: "routed" }),
    run({ id: "a1", parentMessageId: "u1", agentId: "codex", discarded: true }),
    run({ id: "b1", parentMessageId: "a1", agentId: "codebuddy" }),
    user("u2", "被丢弃的用户消息", { discarded: true }),
  ]);
  assert.deepEqual(result.nodes.map((node) => node.id).sort(), ["b1", "u1"]);
  const byId = new Map(result.nodes.map((node) => [node.id, node]));
  // a1 被过滤后 b1 的父链断裂，成为独立森林根（不伪造挂载）
  assert.equal(byId.get("b1")?.parentNodeId, undefined);
  assert.equal(byId.get("b1")?.rootId, "b1");
  assert.equal(result.roots.length, 2);
});

test("ignored 根与 blocked 节点带 dimmed 标记，正常叶子运行不淡化", () => {
  const result = graph([
    user("u1", "没派给任何人的话", { routeState: "ignored" }),
    user("u2", "正式任务", { routeState: "routed" }),
    run({ id: "a1", parentMessageId: "u2", agentId: "codex", routeState: "ignored" }),
    run({ id: "b1", parentMessageId: "u2", agentId: "codebuddy", routeState: "blocked" }),
  ]);
  const byId = new Map(result.nodes.map((node) => [node.id, node]));
  assert.equal(byId.get("u1")?.dimmed, true);
  assert.equal(byId.get("u1")?.routeState, "ignored");
  assert.equal(byId.get("b1")?.dimmed, true);
  // 叶子运行的 routeState=ignored 是「未再交接」的正常收尾，不淡化
  assert.equal(byId.get("a1")?.dimmed, false);
  const blockedEdge = result.edges.find((edge) => edge.target === "b1");
  assert.equal(blockedEdge?.dimmed, true);
  assert.equal(blockedEdge?.routeState, "routed");
});

test("多根森林：roots 分页数据各自独立计数与状态", () => {
  const result = graph([
    user("u1", "第一个任务", { routeState: "routed" }),
    run({ id: "a1", parentMessageId: "u1", agentId: "codex", runStatus: "failed" }),
    user("u2", "第二个任务", { routeState: "routed", createdAt: "2026-06-19T10:00:00.000Z" }),
    run({ id: "b1", parentMessageId: "u2", agentId: "dsh", runStatus: "running", completedAt: undefined }),
    user("u3", "只是打个招呼", { routeState: "ignored", createdAt: "2026-06-19T11:00:00.000Z" }),
  ]);
  assert.equal(result.roots.length, 3);
  const rootsById = new Map(result.roots.map((root) => [root.id, root]));
  assert.equal(rootsById.get("u1")?.status, "failed");
  assert.equal(rootsById.get("u1")?.nodeCount, 2);
  assert.equal(rootsById.get("u2")?.status, "running");
  assert.equal(rootsById.get("u3")?.status, "idle");
  assert.equal(rootsById.get("u3")?.nodeCount, 1);
  const byId = new Map(result.nodes.map((node) => [node.id, node]));
  assert.equal(byId.get("a1")?.rootId, "u1");
  assert.equal(byId.get("b1")?.rootId, "u2");
});

test("执行中节点带 plan 当前步，排队/取消等状态原样映射", () => {
  const result = graph([
    user("u1", "长任务", { routeState: "routed" }),
    run({
      id: "a1",
      parentMessageId: "u1",
      agentId: "codex",
      runStatus: "running",
      completedAt: undefined,
      content: "Codex is working...",
      plan: {
        format: "items",
        entries: [
          { content: "读代码", priority: "high", status: "completed" },
          { content: "写补丁", priority: "high", status: "in_progress" },
          { content: "跑测试", priority: "medium", status: "pending" },
        ],
      },
    }),
    run({ id: "b1", parentMessageId: "u1", agentId: "codebuddy", runStatus: "queued", completedAt: undefined }),
    run({ id: "c1", parentMessageId: "u1", agentId: "dsh", runStatus: "cancelled" }),
  ]);
  const byId = new Map(result.nodes.map((node) => [node.id, node]));
  assert.equal(byId.get("a1")?.status, "running");
  assert.equal(byId.get("a1")?.planCurrentStep, "写补丁");
  // 占位内容不作标题，回退为员工显示名
  assert.equal(byId.get("a1")?.title, "Codex");
  assert.equal(byId.get("b1")?.status, "queued");
  assert.equal(byId.get("b1")?.planCurrentStep, undefined);
  assert.equal(byId.get("c1")?.status, "cancelled");
});
