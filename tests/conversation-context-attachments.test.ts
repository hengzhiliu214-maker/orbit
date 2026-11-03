import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ConversationContext } from "../src/server/conversation-context.ts";
import { EventBus } from "../src/core/event-bus.ts";
import { SessionStore } from "../src/core/session-store.ts";
import { WorkspaceStore } from "../src/core/workspace-store.ts";
import type { AgentProfile, MessageAttachment } from "../src/shared/types.ts";

/**
 * 回归：ConversationContext.buildRuntimePrompt 曾接收 imagePaths 却没有传给
 * buildAgentContext，导致 <current-attachments> 从未进入生产提示词。
 * 这里直接驱动 buildRuntimePrompt 验证源消息附件进入了运行时提示词。
 */
function makeContext(conversationId = "conv1"): { baseDir: string; ctx: ConversationContext } {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-ctx-attachments-"));
  const workspaceStore = new WorkspaceStore(baseDir);
  const profiles: AgentProfile[] = [{
    id: "dev",
    name: "开发",
    runtime: "claude-code",
    cwd: baseDir,
    systemPrompt: "",
  }];
  const ctx = new ConversationContext({
    workspaceId: "ws1",
    conversationId,
    profiles,
    eventBus: new EventBus(),
    sessionStore: new SessionStore(workspaceStore.sessionsDir("ws1")),
    workspaceStore,
    interactionMode: "direct",
  });
  return { baseDir, ctx };
}

test("ConversationContext passes source attachments into the runtime prompt", () => {
  const { baseDir, ctx } = makeContext();
  try {
    const attachments: MessageAttachment[] = [
      {
        id: "a1", kind: "image", mimeType: "image/png", filename: "shot.png",
        path: "/tmp/shot.png", url: "/api/attachments/ws1/conv1/a1", size: 2048,
        createdAt: new Date().toISOString(),
      },
      {
        id: "a2", kind: "file", mimeType: "application/pdf", filename: "spec.pdf",
        path: "/tmp/spec.pdf", url: "/api/attachments/ws1/conv1/a2", size: 125952,
        createdAt: new Date().toISOString(),
      },
    ];
    const prompt = (ctx as unknown as {
      buildRuntimePrompt: (
        agentId: string,
        prompt: string,
        sourceMessageId?: string,
        sourceAttachments?: MessageAttachment[],
        interactionMode?: "direct",
      ) => string;
    }).buildRuntimePrompt("dev", "do work", undefined, attachments, "direct");

    assert.ok(prompt.includes("<current-attachments>"), "attachments must reach the production prompt");
    assert.ok(prompt.includes("shot.png"));
    assert.ok(prompt.includes("spec.pdf"));
  } finally {
    ctx.dispose();
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});


test("replacement history stays in its conversation and excludes the current message", () => {
  const a = makeContext("conv-a");
  const b = makeContext("conv-b");
  try {
    a.ctx.messages.add({ kind: "user", content: "A-ANCHOR-1948", status: "done" });
    a.ctx.messages.add({ kind: "agent", agentId: "dev", content: "A-ANSWER", status: "done" });
    b.ctx.messages.add({ kind: "user", content: "B-SECRET-8210", status: "done" });
    const attachments: MessageAttachment[] = [{
      id: "current-a", kind: "file", mimeType: "text/plain", filename: "CURRENT-ATTACHMENT.txt",
      path: "/tmp/current-a.txt", url: "/api/attachments/ws1/conv-a/current-a", size: 5,
      createdAt: new Date().toISOString(),
    }];
    const current = a.ctx.messages.add({ kind: "user", content: "CURRENT-TASK-3401", attachments, status: "done" });
    const build = a.ctx as unknown as { buildRuntimePromptContext: (
      agentId: string, prompt: string, sourceMessageId: string, attachments: MessageAttachment[],
      mode: "direct", recovery: boolean,
    ) => { prompt: string; historyIncluded: boolean } };
    const normal = build.buildRuntimePromptContext("dev", current.content, current.id, attachments, "direct", false);
    const recovered = build.buildRuntimePromptContext("dev", current.content, current.id, attachments, "direct", true);
    assert.equal(normal.historyIncluded, false);
    assert.equal(recovered.historyIncluded, true);
    assert.ok(recovered.prompt.includes("A-ANCHOR-1948"));
    assert.ok(recovered.prompt.includes("A-ANSWER"));
    assert.ok(!recovered.prompt.includes("B-SECRET-8210"));
    assert.equal(recovered.prompt.split("CURRENT-TASK-3401").length - 1, 1);
    assert.equal(recovered.prompt.split("<current-attachments>").length - 1, 1);
    assert.equal(recovered.prompt.split("CURRENT-ATTACHMENT.txt").length - 1, 1);
  } finally {
    a.ctx.dispose(); b.ctx.dispose();
    fs.rmSync(a.baseDir, { recursive: true, force: true });
    fs.rmSync(b.baseDir, { recursive: true, force: true });
  }
});
