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
  processTimeline?: ChatMessage["processTimeline"];
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
    processTimeline: input.processTimeline,
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

test("节点类型：根=指令，完成且有产出=结论，进行中=执行", () => {
  const result = graph([
    user("u1", "任务", { routeState: "routed" }),
    run({ id: "a1", parentMessageId: "u1", agentId: "codex", content: "这是最终产出" }),
    run({ id: "b1", parentMessageId: "u1", agentId: "dsh", runStatus: "running", completedAt: undefined, content: "DeepSeek-Harness is working..." }),
    run({ id: "c1", parentMessageId: "u1", agentId: "codebuddy", runStatus: "failed", content: "CodeBuddy 运行失败：boom" }),
  ]);
  const byId = new Map(result.nodes.map((node) => [node.id, node]));
  assert.equal(byId.get("u1")?.nodeType, "instruction");
  assert.equal(byId.get("a1")?.nodeType, "conclusion");
  assert.equal(byId.get("b1")?.nodeType, "execution");
  assert.equal(byId.get("c1")?.nodeType, "execution");
});

test("问题台：失败条目逐字搬运落盘错误文本并可回溯，run 完成后阻碍保留", () => {
  const result = graph([
    user("u1", "任务", { routeState: "routed" }),
    run({ id: "a1", parentMessageId: "u1", agentId: "codex", runStatus: "failed", content: "Codex 运行失败：Session error: -32603 internal error 读取 /tmp/x 失败" }),
    run({ id: "b1", parentMessageId: "u1", agentId: "dsh", content: "后来成功了" }),
  ]);
  const problems = result.problems;
  assert.equal(problems.enabled, true);
  assert.equal(problems.totalItems, 1);
  const item = problems.items[0];
  assert.equal(item.kind, "run-failed");
  assert.equal(item.nodeId, "a1");
  assert.equal(item.messageId, "a1");
  // 前缀剥离后即落盘错误汇总原文，逐字一致
  assert.equal(item.text, "Session error: -32603 internal error 读取 /tmp/x 失败");
  assert.equal(item.errorCode, "-32603");
  assert.equal(item.source, "record");
  const byId = new Map(result.nodes.map((node) => [node.id, node]));
  assert.equal(byId.get("a1")?.obstacleCount, 1);
  assert.equal(byId.get("b1")?.obstacleCount, 0);
});

test("问题台判同：同阶段+同错误码+同触发成簇，不同码分开，短句取消保持独立", () => {
  const fail = (id: string, at: string) =>
    run({
      id,
      parentMessageId: "u1",
      agentId: "codex",
      runStatus: "failed",
      content: "Codex 运行失败：请求失败 -32603 服务内部错误，请稍后重试",
      createdAt: at,
    });
  const result = graph([
    user("u1", "任务", { routeState: "routed" }),
    fail("a1", "2026-06-19T09:02:00.000Z"),
    fail("a2", "2026-06-19T09:05:00.000Z"),
    run({ id: "b1", parentMessageId: "u1", agentId: "dsh", runStatus: "failed", content: "DeepSeek-Harness 运行失败：ENOENT 找不到文件 /data/a.txt", createdAt: "2026-06-19T09:06:00.000Z" }),
    run({ id: "c1", parentMessageId: "u1", agentId: "codebuddy", runStatus: "cancelled", content: "运行已取消。", createdAt: "2026-06-19T09:07:00.000Z" }),
    run({ id: "c2", parentMessageId: "u1", agentId: "codebuddy", runStatus: "cancelled", content: "运行已取消。", createdAt: "2026-06-19T09:08:00.000Z" }),
  ]);
  const problems = result.problems;
  assert.equal(problems.totalItems, 5);
  const multi = problems.clusters.filter((cluster) => cluster.itemIds.length > 1);
  assert.equal(multi.length, 1);
  assert.deepEqual(multi[0].itemIds.length, 2);
  assert.equal(multi[0].errorCode, "-32603");
  // 两个取消条目各自独立成簇（信息不足不判同）
  const cancelClusters = problems.clusters.filter((cluster) => cluster.kind === "run-cancelled");
  assert.equal(cancelClusters.length, 2);
  assert.ok(cancelClusters.every((cluster) => cluster.itemIds.length === 1));
});

test("问题台：工具失败只有结算计数时标 history-summary，阻断与数据不完整如实标注", () => {
  const result = graph([
    user("u1", "任务", { routeState: "routed" }),
    run({
      id: "a1",
      parentMessageId: "u1",
      agentId: "codex",
      processTimeline: [{ type: "tools", count: 5, failedCount: 2 }],
    }),
    run({ id: "b1", parentMessageId: "u1", agentId: "dsh", routeState: "blocked", content: "被阻断的执行" }),
  ]);
  const problems = result.problems;
  const toolItem = problems.items.find((item) => item.kind === "tool-failed");
  assert.ok(toolItem);
  assert.equal(toolItem.source, "history-summary");
  assert.match(toolItem.text, /失败 2 次/);
  const blockedItem = problems.items.find((item) => item.kind === "route-blocked");
  assert.ok(blockedItem);
  assert.equal(blockedItem.nodeId, "b1");
  assert.equal(problems.dataIncomplete, true);
});

test("重试折叠：失败后同员工重试成链并折叠非末次，完成后的新任务不折叠", () => {
  const result = graph([
    user("u1", "任务", { routeState: "routed" }),
    run({ id: "a1", parentMessageId: "u1", agentId: "dsh", runStatus: "failed", content: "DeepSeek-Harness 运行失败：-32603 会话失效", createdAt: "2026-06-19T09:02:00.000Z" }),
    run({ id: "a2", parentMessageId: "u1", agentId: "dsh", content: "重试成功", createdAt: "2026-06-19T09:04:00.000Z" }),
    run({ id: "b1", parentMessageId: "u1", agentId: "codex", content: "第一个任务", createdAt: "2026-06-19T09:05:00.000Z" }),
    run({ id: "b2", parentMessageId: "u1", agentId: "codex", content: "第二个任务", createdAt: "2026-06-19T09:06:00.000Z" }),
  ]);
  const byId = new Map(result.nodes.map((node) => [node.id, node]));
  assert.equal(byId.get("a1")?.retry?.folded, true);
  assert.equal(byId.get("a1")?.retry?.attempt, 1);
  assert.equal(byId.get("a2")?.retry?.folded, false);
  assert.equal(byId.get("a2")?.retry?.attempt, 2);
  assert.equal(byId.get("a2")?.retry?.totalAttempts, 2);
  assert.equal(byId.get("a1")?.retry?.groupId, byId.get("a2")?.retry?.groupId);
  assert.equal(byId.get("b1")?.retry, undefined);
  assert.equal(byId.get("b2")?.retry, undefined);
});

test("问题台可关闭：includeProblems=false 时原图不变且计数为 0", () => {
  const messages = [
    user("u1", "任务", { routeState: "routed" }),
    run({ id: "a1", parentMessageId: "u1", agentId: "codex", runStatus: "failed", content: "Codex 运行失败：-32603 出错了啊啊啊" }),
  ];
  const off = buildConversationGraph({
    workspaceId: "ws-1",
    conversationId: "conv-1",
    messages,
    agentLabels: labels,
    agentRuntimes: runtimes,
    includeProblems: false,
  });
  assert.equal(off.problems.enabled, false);
  assert.equal(off.problems.items.length, 0);
  assert.equal(off.nodes.length, 2);
  assert.equal(off.nodes.find((node) => node.id === "a1")?.obstacleCount, 0);
  const on = graph(messages);
  assert.equal(on.nodes.length, off.nodes.length);
  assert.equal(on.edges.length, off.edges.length);
});

test("问题台上限：条目超限时截断并如实标注", () => {
  const messages: ChatMessage[] = [user("u1", "任务", { routeState: "routed" })];
  for (let i = 0; i < 210; i++) {
    messages.push(
      run({
        id: `f${i}`,
        parentMessageId: "u1",
        agentId: "codex",
        runStatus: "failed",
        content: `Codex 运行失败：错误 ${i} 发生了奇怪的问题需要处理`,
        createdAt: `2026-06-19T10:${String(i % 60).padStart(2, "0")}:00.000Z`,
      }),
    );
  }
  const result = graph(messages);
  assert.equal(result.problems.totalItems, 210);
  assert.equal(result.problems.items.length, 200);
  assert.equal(result.problems.truncated, true);
});
