import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { createDefaultAgentChangeTracker } from "../src/ui/default-agent-change-state.ts";

/**
 * Dot 0092 定向复核第 1 项：默认接收人变更竞态。
 *
 * 切换默认接收人的 PUT 未确认期间仍可发送，消息会按旧接收人路由；
 * 切换会话后旧响应到达还会覆盖当前会话的界面状态。无 React 渲染
 * 环境下：跟踪器状态机做行为单测（含真实异步延迟时序），App 组件
 * 以源码结构断言关键接线点。
 */

const appSource = fs.readFileSync(
  path.resolve(import.meta.dirname, "../src/ui/App.tsx"),
  "utf-8",
);

const CONV_A = { workspaceId: "ws-1", conversationId: "conv-a" };
const CONV_B = { workspaceId: "ws-1", conversationId: "conv-b" };

describe("default agent change tracker", () => {
  test("change in flight blocks sending for that conversation only", () => {
    const tracker = createDefaultAgentChangeTracker();
    assert.equal(tracker.canSend(CONV_A), true, "idle conversation must allow sending");

    const request = tracker.beginChange(CONV_A);
    assert.ok(request, "first change must be accepted");
    assert.equal(tracker.isChangePending(CONV_A), true);
    assert.equal(tracker.canSend(CONV_A), false, "sending must be blocked while the change is unconfirmed");
    assert.equal(tracker.canSend(CONV_B), true, "another conversation is not blocked by conv-a's change");
  });

  test("delayed response applies when the user is still on the same conversation", async () => {
    const tracker = createDefaultAgentChangeTracker();
    const request = tracker.beginChange(CONV_A)!;
    assert.equal(tracker.canSend(CONV_A), false);

    // 模拟慢响应：响应在 30ms 后才到达，期间发送一直被拦截。
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(tracker.canSend(CONV_A), false, "still blocked while the response is in flight");

    assert.equal(tracker.finishChange(request, CONV_A), true, "fresh response for the current conversation must apply");
    assert.equal(tracker.isChangePending(CONV_A), false);
    assert.equal(tracker.canSend(CONV_A), true, "sending is allowed again after confirmation");
  });

  test("serialization: a second change for the same conversation is rejected while one is in flight", () => {
    const tracker = createDefaultAgentChangeTracker();
    const first = tracker.beginChange(CONV_A);
    assert.ok(first);
    assert.equal(tracker.beginChange(CONV_A), null, "overlapping change for the same conversation must be rejected");
    assert.ok(tracker.beginChange(CONV_B), "a different conversation may change in parallel");

    assert.equal(tracker.finishChange(first, CONV_A), true);
    assert.ok(tracker.beginChange(CONV_A), "after confirmation the conversation accepts a new change");
  });

  test("response arriving after switching conversations is discarded", async () => {
    const tracker = createDefaultAgentChangeTracker();
    const request = tracker.beginChange(CONV_A)!;

    await new Promise((resolve) => setTimeout(resolve, 10));
    // 用户已切到 conv-b：conv-a 的响应不得回写 conv-b 的界面状态。
    assert.equal(tracker.finishChange(request, CONV_B), false, "stale response must not apply to another conversation");
    assert.equal(tracker.isChangePending(CONV_A), false, "the completed change still releases its slot");
    assert.equal(tracker.canSend(CONV_A), true, "returning to conv-a is not stuck in the pending state");
  });

  test("out-of-order stale response does not clear a newer pending change", () => {
    const tracker = createDefaultAgentChangeTracker();
    const first = tracker.beginChange(CONV_A)!;
    assert.equal(tracker.finishChange(first, CONV_A), true);

    const second = tracker.beginChange(CONV_A)!;
    assert.ok(second.sequence > first.sequence, "sequences must be monotonic");
    // 第一份响应的迟到副本此时到达：不得清掉第二份在途变更。
    assert.equal(tracker.finishChange(first, CONV_A), false, "stale duplicate must be discarded");
    assert.equal(tracker.isChangePending(CONV_A), true, "the newer change is still in flight");
    assert.equal(tracker.canSend(CONV_A), false);

    assert.equal(tracker.finishChange(second, CONV_A), true);
    assert.equal(tracker.canSend(CONV_A), true);
  });

  test("failure completion releases the slot and reports applicability the same way", () => {
    const tracker = createDefaultAgentChangeTracker();
    const request = tracker.beginChange(CONV_A)!;
    // 失败路径与成功路径共用 finishChange 做结束与过期判定。
    assert.equal(tracker.finishChange(request, CONV_B), false, "a failure surfacing on another conversation must be discarded");
    assert.equal(tracker.isChangePending(CONV_A), false, "failure still releases the pending slot");
  });
});

describe("App wiring for default agent change races", () => {
  test("updateDefaultDirectAgent is bound to the tracker lifecycle", () => {
    const updateMatch = appSource.match(/async function updateDefaultDirectAgent\([\s\S]*?\n  \}/);
    assert.ok(updateMatch, "updateDefaultDirectAgent must exist");
    assert.match(updateMatch[0], /tracker\.beginChange\(/);
    assert.match(updateMatch[0], /tracker\.finishChange\(request, responseContext\(\)\)/);
  });

  test("sendMessage authoritatively blocks while a change is unconfirmed", () => {
    const sendMatch = appSource.match(/async function sendMessage\([\s\S]*?\n  \}/);
    assert.ok(sendMatch, "sendMessage must exist");
    assert.match(sendMatch[0], /defaultAgentChangeTrackerRef\.current\.canSend\(/);
  });

  test("composer disables the picker and the send button while pending, with a visible status", () => {
    assert.match(appSource, /disabled=\{!hasWorkspace \|\| !hasEnabledAgent \|\| defaultAgentChangePending\}/);
    assert.match(appSource, /\|\| defaultAgentChangePending\}/);
    assert.match(appSource, /defaultReceiverPending/);
    assert.match(appSource, /接收人保存中，完成后可发送/);
  });
});
