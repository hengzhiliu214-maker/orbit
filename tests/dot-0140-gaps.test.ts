import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { applyEvent, resolveSyncedLastDirectAgentId, upsertMessage } from "../src/ui/App.tsx";
import {
  buildGraphLiveSignature,
  hashAgentLabels,
  messageGraphToken,
} from "../src/ui/graph-live-signature.ts";
import type { AgentState, AppState, ChatMessage } from "../src/shared/types.ts";

/**
 * Dot 0140 补测：WeakMap 身份缓存契约。
 *
 * 背景：liveSignature 逐消息 token 按消息对象身份 WeakMap 缓存；
 * 签名能否感知“已有消息同长度正文替换 / 父关系改变”，取决于更新路径
 * 是否交出新对象。已有 graph-live-signature.test.ts 用新对象断言了
 * “签名变化”，但没有证明生产更新路径真的交出新对象——本文件补的就是
 * 这一环：走真实的 upsertMessage / applyEvent（message.updated）路径，
 * 断言返回的是新对象引用且签名变化；并把“同对象原地改动返回缓存旧
 * token”这一契约行为钉死（调用方不得原地改动后交同一引用，P1 已立禁令）。
 */

const CONV = "conv_dot0140";
const WS = "ws_dot0140";

const labels = new Map([
  ["solution", { label: "Codex", runtime: "codex" }],
]);

function sig(messages: ChatMessage[]): string {
  return buildGraphLiveSignature(messages, CONV, hashAgentLabels(labels));
}

function userMsg(id: string, content: string): ChatMessage {
  return {
    id, kind: "user", content,
    createdAt: "2026-11-06T10:00:00.000Z",
    status: "sent", routeState: "routed",
  };
}

function runMsg(id: string, content: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id, kind: "agent", agentId: "solution", runId: `run_${id}`,
    runStatus: "completed", status: "done", content,
    createdAt: "2026-11-06T10:01:00.000Z",
    completedAt: "2026-11-06T10:02:00.000Z",
    parentMessageId: "msg_000001", routeDepth: 1, routeState: "routed",
    ...extra,
  };
}

function stateWith(messages: ChatMessage[]): AppState {
  return {
    workspace: { id: WS, name: "dot0140", path: "/tmp/dot0140" },
    conversation: { id: CONV, name: "", interactionMode: "direct" },
    agents: [],
    messages,
    messageHistory: { hasOlderMessages: false, olderCursor: null },
    terminal: {},
    runningSummaries: [],
    runtimeAvailability: [],
    pendingPermissions: [],
    pendingElicitations: [],
    agentModelStates: {},
    agentCommands: {},
  };
}

describe("Dot 0140：WeakMap 身份缓存契约（更新路径必须交新对象）", () => {
  test("upsertMessage 同长度正文替换：返回新对象，签名变化", () => {
    const before = stateWith([
      userMsg("msg_000001", "请处理第一项任务"),
      runMsg("msg_000002", "第一项已完成"),
    ]);
    const replacement = runMsg("msg_000002", "第一项已办妥");
    assert.equal(before.messages[1].content.length, replacement.content.length);
    const after = upsertMessage(before, replacement);
    assert.notEqual(after.messages[1], before.messages[1], "同长度替换必须交出新对象，否则 WeakMap 缓存会返回旧 token");
    assert.notEqual(sig(after.messages), sig(before.messages));
  });

  test("applyEvent message.updated 同长度替换：经事件路径获得新对象并刷新签名", () => {
    const before = stateWith([
      userMsg("msg_000001", "请处理第一项任务"),
      runMsg("msg_000002", "第一项已完成"),
    ]);
    const after = applyEvent(before, {
      type: "message.updated",
      workspaceId: WS,
      conversationId: CONV,
      message: runMsg("msg_000002", "第一项已办妥"),
    });
    assert.notEqual(after.messages[1], before.messages[1], "事件路径必须交出新对象");
    assert.notEqual(sig(after.messages), sig(before.messages));
  });

  test("applyEvent message.updated 父关系改变：新对象且签名变化", () => {
    const before = stateWith([
      userMsg("msg_000001", "请处理第一项任务"),
      runMsg("msg_000002", "第一项已完成"),
    ]);
    const after = applyEvent(before, {
      type: "message.updated",
      workspaceId: WS,
      conversationId: CONV,
      message: runMsg("msg_000002", "第一项已完成", { parentMessageId: "msg_999999" }),
    });
    assert.notEqual(after.messages[1], before.messages[1], "父关系改变必须交出新对象");
    assert.notEqual(sig(after.messages), sig(before.messages));
  });

  test("applyEvent run.activity plan.updated：新对象（流式过程更新同样不原地改动）", () => {
    const before = stateWith([
      userMsg("msg_000001", "请处理第一项任务"),
      runMsg("msg_000002", "执行中", { runStatus: "running" }),
    ]);
    const after = applyEvent(before, {
      type: "run.activity",
      workspaceId: WS,
      conversationId: CONV,
      agentId: "solution",
      runId: "run_msg_000002",
      activity: {
        type: "plan.updated",
        timestamp: "2026-11-06T10:03:00.000Z",
        plan: {
          format: "items",
          entries: [{ content: "第一步", priority: "high", status: "in_progress" }],
        },
      },
    });
    assert.notEqual(after.messages[1], before.messages[1], "流式 plan 更新必须交出新对象");
    assert.notEqual(sig(after.messages), sig(before.messages));
  });

  test("同对象原地改动：缓存返回旧 token（契约行为，调用方不得原地改动）", () => {
    const message = runMsg("msg_000002", "第一项已完成");
    const tokenBefore = messageGraphToken(message);
    // 模拟一次违规的原地改动：同长度正文替换，但仍是同一对象引用。
    message.content = "第一项已办妥";
    assert.equal(
      messageGraphToken(message),
      tokenBefore,
      "同一对象原地改动后缓存命中旧 token——这正是契约要求更新路径交新对象的原因",
    );
    // 同一内容的新对象则重新计 token。
    assert.notEqual(messageGraphToken(runMsg("msg_000002", "第一项已办妥")), tokenBefore);
  });
});

describe("Dot 0140：发送后默认接收人同步（同页内斜杠菜单目标不滞后）", () => {
  const agents: AgentState[] = [
    { id: "solution", label: "Codex", runtime: "codex", status: "idle" },
    { id: "implementation", label: "CodeBuddy", runtime: "codebuddy", status: "idle" },
    { id: "verification", label: "DeepSeek-Harness", runtime: "dsh", status: "idle" },
  ];
  const sync = (
    content: string,
    mode: "direct" | "collaborative" | "supervised" = "direct",
    current: string | undefined = undefined,
    hasAttachments = false,
  ) => resolveSyncedLastDirectAgentId(content, mode, agents, current as never, hasAttachments);

  test("@Codex: 消息在直接对话中同步为 solution", () => {
    assert.equal(sync("@Codex: 处理第一项"), "solution");
    assert.equal(sync("@Codex: 处理第一项", "direct", "implementation"), "solution");
  });

  test("无 @ 的消息沿用既有默认接收人（不改写）", () => {
    assert.equal(sync("随便聊聊", "direct", "solution"), "solution");
    assert.equal(sync("随便聊聊"), undefined);
  });

  test("指派不明 / 多人指派被拦截时不改写", () => {
    assert.equal(sync("@Unknown: 处理第一项"), undefined);
    assert.equal(sync("@Unknown: 处理第一项", "direct", "solution"), "solution");
    assert.equal(sync("@Codex: @CodeBuddy: 一起做"), undefined);
    assert.equal(sync("@Codex: @CodeBuddy: 一起做", "direct", "solution"), "solution");
  });

  test("协作模式下不更新 lastDirectAgentId（服务端只在直接模式更新）", () => {
    assert.equal(sync("@Codex: 处理第一项", "collaborative"), undefined);
    assert.equal(sync("@Codex: 处理第一项", "supervised", "implementation"), "implementation");
  });

  test("空指派无附件不更新；有附件时按指派同步", () => {
    assert.equal(sync("@Codex:"), undefined);
    assert.equal(sync("@Codex:", "direct", undefined, true), "solution");
  });
});
