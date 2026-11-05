import test from "node:test";
import assert from "node:assert/strict";
import { buildConversationSessions, emptySessions } from "../src/core/conversation-sessions.ts";
import { buildConversationGraph } from "../src/core/conversation-graph.ts";
import type { ChatMessage, ConversationSessionSegment } from "../src/shared/types.ts";

const labels = new Map([["b", "乙"], ["a", "甲"], ["supervisor", "监工"]]);
const runtimes = new Map([["a", "codex"]]);
const time = (n: number) => `2026-06-19T09:${String(n).padStart(2, "0")}:00.000Z`;
const user = (id: string): ChatMessage => ({ id, kind: "user", content: "任务", createdAt: time(0) });
function run(id: string, options: Partial<ChatMessage> = {}): ChatMessage {
  return { id, kind: "agent", agentId: "a", content: "回复", createdAt: time(Number(id.replace(/\D/g, "")) || 1), parentMessageId: "u1", runId: `run-${id}`, sessionId: "AAAAAAAA1234", ...options };
}
function sessions(messages: ChatMessage[]) { return buildConversationSessions({ messages, agentLabels: labels, agentRuntimes: runtimes }); }
function segments(messages: ChatMessage[]): ConversationSessionSegment[] {
  return sessions(messages).agents[0].blocks.filter((block): block is ConversationSessionSegment => block.type === "segment");
}

test("单段按不同执行与同一用户根计数", () => {
  const result = sessions([run("r2"), user("u1"), run("r1")]);
  const a = result.agents[0];
  assert.equal(a.segmentCount, 1); assert.equal(a.switchCount, 0); assert.equal(a.distinctSessionCount, 1);
  assert.deepEqual([a.totalRuns, a.totalUserTurns, a.totalMessages, a.totalChars], [2, 1, 2, 4]);
  const block = segments([user("u1"), run("r1"), run("r2")])[0];
  assert.deepEqual([block.runCount, block.userTurns, block.messageCount, block.sessionShortId], [2, 1, 2, "AAAAAAAA"]);
});

test("A→B→A 按段计切换并保留首次观测", () => {
  const messages = [user("u1"), run("r1"), run("r2", { sessionId: "B" }), run("r3")];
  const a = sessions(messages).agents[0];
  assert.deepEqual([a.segmentCount, a.switchCount, a.distinctSessionCount], [3, 2, 2]);
  const blocks = segments(messages);
  assert.equal(blocks[0].firstObservedAt, time(1)); assert.equal(blocks[2].firstObservedAt, blocks[0].firstObservedAt);
});

test("同一 runId 多消息只算一次执行", () => {
  const block = segments([user("u1"), run("r1", { runId: "same" }), run("r2", { runId: "same" })])[0];
  assert.equal(block.runCount, 1); assert.equal(block.messageCount, 2);
});

test("未知区间隔开段但不计入汇总，切换跨越未知区间计算", () => {
  const messages = [user("u1"), run("r1"), run("r2", { sessionId: undefined }), run("r3", { sessionId: "" }), run("r4")];
  const result = sessions(messages); const a = result.agents[0];
  assert.deepEqual([a.unknownIntervalCount, a.unknownMessageCount, a.segmentCount, a.switchCount], [1, 2, 2, 0]);
  assert.equal(result.hasUnknownIntervals, true);
  assert.deepEqual([a.totalMessages, a.totalRuns, a.totalUserTurns, a.totalChars], [2, 2, 2, 4]);
  assert.deepEqual(a.blocks.map((block) => block.type), ["segment", "unknown", "segment"]);
  const b = sessions([...messages.slice(0, -1), run("r4", { sessionId: "B" })]).agents[0];
  assert.equal(b.switchCount, 1);
});

test("分组依标签顺序、未配置员工按首次出现，监工最后", () => {
  const result = sessions([run("r1", { agentId: "supervisor" }), run("r2", { agentId: "z" }), run("r3", { agentId: "a" }), run("r4", { agentId: "b" }), run("r5", { agentId: "y" })]);
  assert.deepEqual(result.agents.map((a) => a.agentId), ["b", "a", "z", "y", "supervisor"]);
  assert.equal(result.agents.at(-1)?.isSupervisor, true); assert.equal(result.agents[1].runtime, "codex");
  assert.equal(result.agents[2].agentLabel, undefined);
});

test("空输入与仅用户消息没有分组", () => {
  for (const messages of [[], [user("u1")]]) assert.deepEqual(sessions(messages), { enabled: true, agents: [], hasUnknownIntervals: false });
  assert.deepEqual(emptySessions(false), { enabled: false, agents: [], hasUnknownIntervals: false });
  assert.equal(emptySessions(true, true).degraded, true);
});

test("轮次沿节点和非节点父链归属用户根，缺失及循环不猜测", () => {
  const messages = [user("u1"), user("u2"), run("r1"), run("r2", { agentId: "b", parentMessageId: "r1" }), run("r3", { sessionId: "B", parentMessageId: "u2" }), run("r4", { agentId: "b", runId: undefined, parentMessageId: "r2" }), run("r5", { agentId: "b", parentMessageId: "missing" }), run("r6", { agentId: "b", parentMessageId: "r7" }), run("r7", { agentId: "b", parentMessageId: "r6" })];
  const result = sessions(messages); const b = result.agents.find((a) => a.agentId === "b")!; const a = result.agents.find((x) => x.agentId === "a")!;
  assert.equal((b.blocks[0] as ConversationSessionSegment).userTurns, 1);
  assert.deepEqual(a.blocks.map((block) => block.type === "segment" && block.userTurns), [1, 1]);
});

test("graph 默认启用且关闭后不影响图及问题台", () => {
  const messages = [user("u1"), run("r1", { runStatus: "failed", content: "甲 运行失败：error" }), run("r2", { discarded: true })];
  const options = { workspaceId: "w", conversationId: "c", messages, agentLabels: labels, agentRuntimes: runtimes };
  const on = buildConversationGraph(options); const off = buildConversationGraph({ ...options, includeSessions: false });
  assert.equal(on.sessions.enabled, true); assert.equal(on.sessions.agents[0].totalMessages, 1);
  assert.deepEqual(off.sessions, emptySessions(false));
  for (const key of ["roots", "nodes", "edges", "problems"] as const) assert.deepEqual(on[key], off[key]);
  assert.equal(on.problems.totalItems, 1); assert.equal(off.problems.totalItems, 1);
});

test("同刻按消息 id 切分，未有 runId 的消息也可归属祖先", () => {
  const result = sessions([user("u1"), run("r2", { createdAt: time(1), sessionId: "B" }), run("r1", { createdAt: time(1), runId: undefined, sessionId: "A" })]);
  const a = result.agents[0];
  assert.deepEqual(a.blocks.map((block) => block.type === "segment" && block.sessionId), ["A", "B"]);
  assert.equal((a.blocks[0] as ConversationSessionSegment).userTurns, 1);
  assert.equal((a.blocks[0] as ConversationSessionSegment).runCount, 0);
});
