import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  assembleHandoffMaterial,
  buildMessagesIndex,
  claimHandoffOperation,
  computeContentKey,
  createCheckpoint,
  deleteCheckpoint,
  detectSecretPattern,
  purgeTrash,
  readConversationSnapshot,
  readManifest,
  sha256Hex,
  stripProblemsText,
  summarizeCheckpoints,
  writeOperation,
  CheckpointError,
  type CheckpointConfig,
} from "../src/core/conversation-checkpoints.ts";
import { buildConversationSessions, emptySessions } from "../src/core/conversation-sessions.ts";
import { emptyProblems } from "../src/core/conversation-problems.ts";
import type { ChatMessage, Conversation, ConversationGraphProblems } from "../src/shared/types.ts";

const CONFIG: CheckpointConfig = { maxPerConversation: 10, maxWorkspaceBytes: 200 * 1024 * 1024, trashRetentionDays: 7 };
const BODY_TOKEN = "正文唯一标记XYZ";
const PROBLEM_TOKEN = "问题台唯一文本ABC";

function message(id: string, minute: number, content = `内容${id}`): ChatMessage {
  return {
    id,
    kind: id.startsWith("u") ? "user" : "agent",
    ...(id.startsWith("u") ? {} : { agentId: "a", runId: `run-${id}`, sessionId: "SESSION-1" }),
    content,
    createdAt: `2026-11-05T10:${String(minute).padStart(2, "0")}:00.000Z`,
  };
}

function makeFixture(messages: ChatMessage[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-ckpt-"));
  const workspaceRoot = path.join(root, "conversations", "WsTest");
  const convDir = path.join(workspaceRoot, "conv_test");
  const messagesDir = path.join(convDir, "messages");
  fs.mkdirSync(messagesDir, { recursive: true });
  const shardBody = messages.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  fs.writeFileSync(path.join(messagesDir, "2026-11-05.ndjson"), shardBody);
  fs.writeFileSync(path.join(messagesDir, "manifest.json"), JSON.stringify({
    version: 1,
    nextId: messages.length + 1,
    shards: [{ name: "2026-11-05.ndjson", firstCreatedAt: messages[0]?.createdAt ?? "", lastCreatedAt: messages.at(-1)?.createdAt ?? "", count: messages.length, bytes: Buffer.byteLength(shardBody) }],
  }));
  const conversation = {
    id: "conv_test", workspaceId: "WsTest", name: "测试会话",
    createdAt: "2026-11-05T09:00:00.000Z", lastOpenedAt: "2026-11-05T10:00:00.000Z", interactionMode: "direct",
  } as Conversation;
  return { root, workspaceRoot, convDir, messagesDir, conversation };
}

function createArgs(fixture: ReturnType<typeof makeFixture>, overrides: Partial<Parameters<typeof createCheckpoint>[0]> = {}) {
  const snapshot = readConversationSnapshot(fixture.convDir);
  return {
    conversationDir: fixture.convDir,
    workspaceConversationsRoot: fixture.workspaceRoot,
    snapshot,
    sessions: buildConversationSessions({ messages: snapshot.messages, agentLabels: new Map([["a", "甲"]]) }),
    problems: stripProblemsText(emptyProblems(true)),
    conversation: fixture.conversation,
    config: CONFIG,
    ...overrides,
  };
}

test("快照读取与索引：只记结构不含正文", () => {
  const fixture = makeFixture([message("u1", 0, `${BODY_TOKEN} 请处理`), message("r1", 1)]);
  try {
    const snapshot = readConversationSnapshot(fixture.convDir);
    assert.equal(snapshot.messages.length, 2);
    assert.equal(snapshot.shards.length, 1);
    const index = buildMessagesIndex(snapshot.messages);
    assert.equal(index.entries[0].charCount, snapshot.messages[0].content.length);
    assert.equal(index.entries[0].contentSha256, sha256Hex(snapshot.messages[0].content));
    assert.ok(!JSON.stringify(index).includes(BODY_TOKEN));
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("快照在读取期间变化时明确失败，不产出混合包", () => {
  const fixture = makeFixture([message("u1", 0)]);
  try {
    assert.throws(
      () => readConversationSnapshot(fixture.convDir, {
        afterFirstPass: () => {
          fs.appendFileSync(path.join(fixture.messagesDir, "2026-11-05.ndjson"), JSON.stringify(message("r9", 9)) + "\n");
        },
      }),
      (error: unknown) => error instanceof CheckpointError && error.code === "snapshot-changed",
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("分片损坏时拒绝生成", () => {
  const fixture = makeFixture([message("u1", 0)]);
  try {
    fs.appendFileSync(path.join(fixture.messagesDir, "2026-11-05.ndjson"), "{不是JSON\n");
    assert.throws(
      () => readConversationSnapshot(fixture.convDir),
      (error: unknown) => error instanceof CheckpointError && error.code === "snapshot-corrupt",
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("生成检查点：四件事实层 + manifest 对账，包内无正文与问题台原文", () => {
  const fixture = makeFixture([message("u1", 0, `${BODY_TOKEN} 请处理`), message("r1", 1)]);
  try {
    const problems: ConversationGraphProblems = {
      ...emptyProblems(true),
      totalItems: 1,
      items: [{
        id: "n1#problem-0", nodeId: "n1", messageId: "r1", kind: "run-failed", stage: "run",
        text: PROBLEM_TOKEN, source: "record", createdAt: "2026-11-05T10:01:00.000Z",
      }],
    };
    const args = createArgs(fixture);
    args.problems = stripProblemsText(problems);
    const result = createCheckpoint(args);
    assert.equal(result.created, true);
    const manifest = readManifest(result.dir);
    assert.ok(manifest);
    assert.equal(manifest.sourceWindow.messageCount, 2);
    assert.equal(manifest.summaryLayer, null);
    for (const [name, hash] of Object.entries(manifest.files)) {
      assert.equal(sha256Hex(fs.readFileSync(path.join(result.dir, name), "utf8")), hash, `文件 ${name} 的 sha256 应与 manifest 一致`);
    }
    const wholePackage = ["manifest.json", "messages-index.json", "sessions.json", "problems.json", "conversation.json"]
      .map((name) => fs.readFileSync(path.join(result.dir, name), "utf8")).join("\n");
    assert.ok(!wholePackage.includes(BODY_TOKEN), "包内不得出现消息正文");
    assert.ok(!wholePackage.includes(PROBLEM_TOKEN), "包内不得出现问题台逐字文本");
    assert.ok(wholePackage.includes(sha256Hex(PROBLEM_TOKEN)), "问题台只留文本 sha256");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("同状态重复生成返回已有包，不产新目录（不同时间点）", () => {
  const fixture = makeFixture([message("u1", 0), message("r1", 1)]);
  try {
    const first = createCheckpoint(createArgs(fixture, { now: new Date("2026-11-05T11:00:00.000Z") }));
    const second = createCheckpoint(createArgs(fixture, { now: new Date("2026-11-05T12:30:00.000Z") }));
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.checkpointId, first.checkpointId);
    const summary = summarizeCheckpoints({ conversationDir: fixture.convDir, workspaceConversationsRoot: fixture.workspaceRoot, writeEnabled: true, config: CONFIG });
    assert.equal(summary.count, 1);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("容量到限拒绝新增，不静默删旧包；命中已有内容键时仍可复用", () => {
  const fixture = makeFixture([message("u1", 0)]);
  try {
    const config = { ...CONFIG, maxPerConversation: 1 };
    const first = createCheckpoint(createArgs(fixture, { config }));
    assert.equal(first.created, true);
    const again = createCheckpoint(createArgs(fixture, { config }));
    assert.equal(again.created, false);
    fs.appendFileSync(path.join(fixture.messagesDir, "2026-11-05.ndjson"), JSON.stringify(message("r2", 2)) + "\n");
    assert.throws(
      () => createCheckpoint(createArgs(fixture, { config })),
      (error: unknown) => error instanceof CheckpointError && error.code === "cap-count",
    );
    const summary = summarizeCheckpoints({ conversationDir: fixture.convDir, workspaceConversationsRoot: fixture.workspaceRoot, writeEnabled: true, config });
    assert.equal(summary.count, 1, "到限拒绝后旧包仍在");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("工作区字节上限到限拒绝", () => {
  const fixture = makeFixture([message("u1", 0)]);
  try {
    const config = { ...CONFIG, maxWorkspaceBytes: 10 };
    assert.throws(
      () => createCheckpoint(createArgs(fixture, { config })),
      (error: unknown) => error instanceof CheckpointError && error.code === "cap-bytes",
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("删除移入 .trash，列表标源已删除，超保留期清除", () => {
  const fixture = makeFixture([message("u1", 0)]);
  try {
    const created = createCheckpoint(createArgs(fixture));
    deleteCheckpoint(fixture.convDir, created.checkpointId, new Date("2026-11-05T12:00:00.000Z"));
    const summary = summarizeCheckpoints({ conversationDir: fixture.convDir, workspaceConversationsRoot: fixture.workspaceRoot, writeEnabled: true, config: CONFIG });
    assert.equal(summary.count, 0);
    assert.equal(summary.items.length, 1);
    assert.equal(summary.items[0].status, "deleted");
    const removed = purgeTrash(fixture.convDir, 7, new Date("2026-12-01T00:00:00.000Z"));
    assert.equal(removed, 1);
    const after = summarizeCheckpoints({ conversationDir: fixture.convDir, workspaceConversationsRoot: fixture.workspaceRoot, writeEnabled: true, config: CONFIG });
    assert.equal(after.items.length, 0);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("坏包只标自身 degraded，不拖垮列表", () => {
  const fixture = makeFixture([message("u1", 0)]);
  try {
    const created = createCheckpoint(createArgs(fixture));
    const badDir = path.join(fixture.convDir, "archives", "ckpt-20260101000000-99");
    fs.mkdirSync(badDir, { recursive: true });
    fs.writeFileSync(path.join(badDir, "manifest.json"), "{损坏");
    const summary = summarizeCheckpoints({ conversationDir: fixture.convDir, workspaceConversationsRoot: fixture.workspaceRoot, writeEnabled: true, config: CONFIG });
    assert.equal(summary.count, 2);
    assert.equal(summary.items.find((item) => item.checkpointId === created.checkpointId)?.degraded, undefined);
    assert.equal(summary.items.find((item) => item.checkpointId === "ckpt-20260101000000-99")?.degraded, true);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("交接操作认领：进行中恢复同一操作，失败后新建并带回可复用会话", () => {
  const fixture = makeFixture([message("u1", 0)]);
  try {
    const created = createCheckpoint(createArgs(fixture));
    const first = claimHandoffOperation(created.dir, created.checkpointId);
    const second = claimHandoffOperation(created.dir, created.checkpointId);
    assert.equal(first.resumed, false);
    assert.equal(second.resumed, true);
    assert.equal(second.operation.operationId, first.operation.operationId);
    writeOperation(created.dir, { ...first.operation, state: "failed", newConversationId: "conv_deadbeef" });
    const third = claimHandoffOperation(created.dir, created.checkpointId);
    assert.equal(third.resumed, false);
    assert.notEqual(third.operation.operationId, first.operation.operationId);
    assert.equal(third.reusableConversationId, "conv_deadbeef");
    writeOperation(created.dir, { ...third.operation, state: "done", newConversationId: "conv_deadbeef" });
    const fourth = claimHandoffOperation(created.dir, created.checkpointId);
    assert.equal(fourth.resumed, true);
    assert.equal(fourth.operation.state, "done");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("交接材料：确定性、上限与省略标注，单条超限整条省略不裁剪", () => {
  const base = {
    checkpointId: "ckpt-20261105120000-1",
    checkpointCreatedAt: "2026-11-05T12:00:00.000Z",
    contentKey: "abcdef0123456789",
    sourceConversationId: "conv_test",
    messageCount: 3,
    segmentCount: 1,
    switchCount: 0,
    problemItems: [{ id: "p1", kind: "run-failed", text: "失败原因原文", createdAt: "2026-11-05T10:01:00.000Z" }],
    recentMessages: [message("u1", 0, "短消息"), message("r1", 1, "x".repeat(500))],
    maxExcerptChars: 200,
  };
  const first = assembleHandoffMaterial(base);
  const second = assembleHandoffMaterial(base);
  assert.equal(first.excerptHash, second.excerptHash, "同一输入必得同一 hash");
  assert.ok(first.excerptChars <= 200);
  assert.ok(first.fullText.includes("失败原因原文"));
  assert.ok(first.fullText.includes("授权不继承"));
  assert.ok(first.omitted.some((line) => line.includes("r1")), "超限消息应整条省略并标注");
  assert.ok(!first.fullText.includes("x".repeat(200)), "不得静默裁剪长消息冒充完整");
});

test("内容键稳定：与生成时间无关，随源内容变化而变", () => {
  const base = {
    shards: [{ name: "a.ndjson", sha256: "aa" }],
    selectionScope: "index-only-v1",
    derivationVersion: "ckpt-derive-v1",
    schemaVersion: 1,
    payloadSha256: { "messages-index.json": "bb" },
  };
  assert.equal(computeContentKey(base), computeContentKey({ ...base }));
  assert.notEqual(computeContentKey(base), computeContentKey({ ...base, shards: [{ name: "a.ndjson", sha256: "cc" }] }));
});

test("凭据形态自检：命中即报，未命中通过", () => {
  assert.equal(detectSecretPattern("普通文本，没有任何敏感形态。"), null);
  assert.equal(detectSecretPattern("token: sk-abcdefghijklmnopqrstuvwxyz0123456789"), "api-token");
  assert.equal(detectSecretPattern("-----BEGIN RSA PRIVATE KEY-----"), "private-key");
  assert.equal(detectSecretPattern("配置标记 小代码酱 出现"), "private-config-marker");
});

test("空会话也可生成检查点（零消息）", () => {
  const fixture = makeFixture([]);
  try {
    const result = createCheckpoint(createArgs(fixture, {
      sessions: emptySessions(true),
    }));
    assert.equal(result.created, true);
    const manifest = readManifest(result.dir);
    assert.equal(manifest?.sourceWindow.messageCount, 0);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
