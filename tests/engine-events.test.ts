import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  appendEngineEvent,
  buildCompactionDerivation,
  compactionCaptureEnabled,
  groupMarkerSegments,
  readEngineEvents,
  type EngineEvent,
} from "../src/core/engine-events.ts";
import { buildConversationSessions } from "../src/core/conversation-sessions.ts";
import {
  classifyCodeBuddyAnswerChunk,
  isCodeBuddyCompactionChunk,
} from "../src/core/codebuddy-acp-runtime.ts";
import type { ChatMessage } from "../src/shared/types.ts";

function marker(at: string, extra: Partial<EngineEvent> = {}): EngineEvent {
  return {
    kind: "compaction_marker", runtime: "codebuddy", agentId: "cb",
    runId: "run-1", sessionId: "SESSION-A", observedAt: at, schemaVersion: 1, ...extra,
  };
}

function coverage(at: string): EngineEvent {
  return { kind: "coverage_start", runtime: "codebuddy", observedAt: at, schemaVersion: 1 };
}

test("分类不变：压缩帧仍判 ignore，谓词与分类同口径，畸形 _meta 不误判", () => {
  const compact = { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "摘要" }, _meta: { "codebuddy.ai/isCompactInternal": true } } as never;
  assert.equal(classifyCodeBuddyAnswerChunk(compact), "ignore");
  assert.equal(isCodeBuddyCompactionChunk(compact), true);
  const member = { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x" }, _meta: { "codebuddy.ai/memberEvent": {} } } as never;
  assert.equal(classifyCodeBuddyAnswerChunk(member), "progress");
  assert.equal(isCodeBuddyCompactionChunk(member), false);
  const malformed = { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x" }, _meta: { "codebuddy.ai/isCompactInternal": "yes" } } as never;
  assert.equal(isCodeBuddyCompactionChunk(malformed), false);
  assert.equal(classifyCodeBuddyAnswerChunk(malformed), undefined);
  const noMeta = { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x" } } as never;
  assert.equal(isCodeBuddyCompactionChunk(noMeta), false);
});

test("开关默认关，逐引擎开启", () => {
  const saved = process.env.ORBIT_COMPACTION_CAPTURE;
  try {
    delete process.env.ORBIT_COMPACTION_CAPTURE;
    assert.equal(compactionCaptureEnabled(), false);
    process.env.ORBIT_COMPACTION_CAPTURE = "codex";
    assert.equal(compactionCaptureEnabled(), false);
    process.env.ORBIT_COMPACTION_CAPTURE = "codebuddy";
    assert.equal(compactionCaptureEnabled(), true);
    assert.equal(compactionCaptureEnabled("codex"), false);
  } finally {
    if (saved === undefined) delete process.env.ORBIT_COMPACTION_CAPTURE;
    else process.env.ORBIT_COMPACTION_CAPTURE = saved;
  }
});

test("落盘往返 + 坏行/部分尾行容忍且标降级", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-events-"));
  try {
    assert.equal(readEngineEvents(dir).exists, false);
    appendEngineEvent(dir, coverage("2026-11-05T09:59:00.000Z"));
    appendEngineEvent(dir, marker("2026-11-05T10:02:00.000Z"));
    fs.appendFileSync(path.join(dir, "engine-events.ndjson"), "{坏行\n{\"kind\":\"compaction_marker\",\"runtime\":\"codebuddy\",\"observedAt\":\"2026-11-05T10:0");
    const read = readEngineEvents(dir);
    assert.equal(read.exists, true);
    assert.equal(read.events.length, 2);
    assert.equal(read.badLines, 2);
    assert.equal(read.degraded, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("标记段合并：同回合多 chunk 一段、两段分开的流两段、异 run 分段", () => {
  const segments = groupMarkerSegments([
    marker("2026-11-05T10:02:00.000Z"), marker("2026-11-05T10:02:01.000Z"), marker("2026-11-05T10:02:02.000Z"),
    marker("2026-11-05T10:04:40.000Z"),
    marker("2026-11-05T10:06:00.000Z", { runId: "run-2" }),
    marker("2026-11-05T10:06:01.000Z", { runId: "run-2" }),
  ]);
  assert.equal(segments.length, 3);
  assert.equal(segments[0].chunkCount, 3);
  assert.equal(segments[1].chunkCount, 1);
  assert.equal(segments[2].chunkCount, 2);
});

function sessionsFixture() {
  const msg = (id: string, at: string, sessionId: string, runId: string): ChatMessage => ({
    id, kind: "agent", agentId: "cb", runId, sessionId, content: `消息${id}`, createdAt: at,
  });
  const messages: ChatMessage[] = [
    msg("r1", "2026-11-05T10:00:00.000Z", "SESSION-A", "run-1"),
    msg("r2", "2026-11-05T10:05:00.000Z", "SESSION-A", "run-1"),
    msg("r3", "2026-11-05T10:10:00.000Z", "SESSION-B", "run-2"),
    msg("r4", "2026-11-05T10:20:00.000Z", "SESSION-A", "run-3"),
    msg("r5", "2026-11-05T10:25:00.000Z", "SESSION-A", "run-3"),
  ];
  return buildConversationSessions({
    messages,
    agentLabels: new Map([["cb", "CodeBuddy"]]),
    agentRuntimes: new Map([["cb", "codebuddy"]]),
  }).agents;
}

test("派生：A→B→A 归段按时间窗口唯一命中，窗口外计未归段", () => {
  const agents = sessionsFixture();
  const events: EngineEvent[] = [
    coverage("2026-11-05T09:59:00.000Z"),
    marker("2026-11-05T10:02:00.000Z"), marker("2026-11-05T10:02:01.000Z"),
    marker("2026-11-05T10:22:00.000Z", { runId: "run-3" }),
    marker("2026-11-05T10:12:00.000Z", { runId: "run-2", sessionId: "SESSION-B" }),
    coverage("2026-11-05T11:00:00.000Z"),
  ];
  const { coverage: cov, byAgent } = buildCompactionDerivation({
    read: { exists: true, events, badLines: 0, degraded: false },
    agents,
    now: new Date("2026-11-05T12:00:00.000Z"),
  });
  const view = byAgent.get("cb");
  assert.ok(view);
  assert.equal(view.markerSegmentCount, 3);
  assert.equal(view.unassignedSegmentCount, 1);
  const assigned = view.segments.filter((segment) => segment.assigned);
  assert.deepEqual(assigned.map((segment) => segment.segmentIndex), [1, 3]);
  assert.equal(cov.intervals.length, 2);
  assert.equal(cov.intervals[0].to, "2026-11-05T11:00:00.000Z");
  assert.equal(cov.degraded, false);
  assert.equal(cov.retentionExcluded, false);
});

test("派生：留存窗口外事件被排除并标注；降级透传", () => {
  const agents = sessionsFixture();
  const events: EngineEvent[] = [
    marker("2026-08-01T10:00:00.000Z"),
    marker("2026-11-05T10:02:00.000Z"),
  ];
  const { coverage: cov, byAgent } = buildCompactionDerivation({
    read: { exists: true, events, badLines: 1, degraded: true },
    agents,
    now: new Date("2026-11-05T12:00:00.000Z"),
  });
  assert.equal(cov.retentionExcluded, true);
  assert.equal(cov.retentionDays, 90);
  assert.equal(cov.degraded, true);
  assert.equal(byAgent.get("cb")?.markerSegmentCount, 1);
});

test("派生：无覆盖起点时不虚构覆盖区间，标记仍如实呈现", () => {
  const agents = sessionsFixture();
  const { coverage: cov, byAgent } = buildCompactionDerivation({
    read: { exists: true, events: [marker("2026-11-05T10:02:00.000Z")], badLines: 0, degraded: false },
    agents,
    now: new Date("2026-11-05T12:00:00.000Z"),
  });
  assert.equal(cov.intervals.length, 0);
  assert.equal(byAgent.get("cb")?.markerSegmentCount, 1);
});

// ---- 活体链路（假 CodeBuddy 运行时）：钩子位于回放守卫之后、分类不变 ----

import {
  createCodeBuddyAcpRuntime,
  type CodeBuddyAcpConnector,
} from "../src/core/codebuddy-acp-runtime.ts";

type Notify = Parameters<CodeBuddyAcpConnector>[1];

function compactChunk(text: string) {
  return {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text },
    _meta: { "codebuddy.ai/isCompactInternal": true },
  } as const;
}

function fakeRuntimeConnector(onPrompt: (notify: Notify) => void) {
  const connector: CodeBuddyAcpConnector = (_runOptions, notify) => ({
    pid: 12345,
    async initialize() {
      return { protocolVersion: 1, agentCapabilities: { loadSession: true } };
    },
    async newSession() {
      return { sessionId: "sess-live" };
    },
    async loadSession() {
      return {};
    },
    async resumeSession() {
      return {};
    },
    async prompt() {
      onPrompt(notify);
      return { stopReason: "end_turn" as const };
    },
    async setConfigOption() {
      return { configOptions: [] };
    },
    async cancel() {},
    hasSession() {
      return false;
    },
    close() {},
  });
  return connector;
}

test("活体链路：实时压缩帧触发标记回调且不进答案；回放区间内的压缩帧不触发", async () => {
  const markers: { sessionId: string; messageId?: string }[] = [];
  const connector = fakeRuntimeConnector((notify) => {
    // 回放区间：start → 压缩帧 → end，整段应被回放守卫丢弃，不产生标记。
    notify({ sessionId: "sess-live", update: { sessionUpdate: "session_info_update", _meta: { "codebuddy.ai/historyReplay": "start" } } as never });
    notify({ sessionId: "sess-live", update: compactChunk("回放中的旧摘要") as never });
    notify({ sessionId: "sess-live", update: { sessionUpdate: "session_info_update", _meta: { "codebuddy.ai/historyReplay": "end" } } as never });
    // 实时路径：两帧压缩 chunk + 正常答案。
    notify({ sessionId: "sess-live", update: compactChunk("压缩摘要甲") as never });
    notify({ sessionId: "sess-live", update: compactChunk("压缩摘要乙") as never });
    notify({ sessionId: "sess-live", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "FINAL" } } as never });
  });
  const runtime = createCodeBuddyAcpRuntime(connector);
  const handle = runtime.run({
    agentId: "tester",
    cwd: "/tmp",
    prompt: "hello",
    onCompactionMarker: (info) => { markers.push(info); },
  });
  assert.equal(await handle.result, "FINAL");
  assert.equal(markers.length, 2, "只应记实时路径的两帧，回放帧不重计");
  assert.ok(markers.every((entry) => entry.sessionId === "sess-live"));
});

test("活体链路：标记回调抛错不影响运行结果", async () => {
  const connector = fakeRuntimeConnector((notify) => {
    notify({ sessionId: "sess-live", update: compactChunk("压缩摘要") as never });
    notify({ sessionId: "sess-live", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "OK" } } as never });
  });
  const runtime = createCodeBuddyAcpRuntime(connector);
  const handle = runtime.run({
    agentId: "tester",
    cwd: "/tmp",
    prompt: "hello",
    onCompactionMarker: () => { throw new Error("观测钩子故障"); },
  });
  assert.equal(await handle.result, "OK");
});

test("派生：非试点引擎的标记不并入试点视图", () => {
  const agents = sessionsFixture();
  const events: EngineEvent[] = [
    marker("2026-11-05T10:02:00.000Z", { runtime: "codex" }),
    marker("2026-11-05T10:03:00.000Z"),
  ];
  const { byAgent } = buildCompactionDerivation({
    read: { exists: true, events, badLines: 0, degraded: false },
    agents,
    now: new Date("2026-11-05T12:00:00.000Z"),
  });
  assert.equal(byAgent.get("cb")?.markerSegmentCount, 1);
});
