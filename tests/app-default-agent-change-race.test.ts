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

describe("default agent change tracker: uncertain outcomes (Dot 0094)", () => {
  test("response lost after server commit: uncertain keeps sending blocked until reread resolves", async () => {
    const tracker = createDefaultAgentChangeTracker();
    const request = tracker.beginChange(CONV_A)!;
    // PUT 已发出但响应丢失（服务端可能已提交）：不得按失败解锁回旧值。
    assert.equal(tracker.markUncertain(request), true);
    assert.equal(tracker.isChangePending(CONV_A), true);
    assert.equal(tracker.isChangeConfirming(CONV_A), true);
    assert.equal(tracker.canSend(CONV_A), false, "结果不确定时必须继续阻断发送");
    assert.equal(tracker.beginChange(CONV_A), null, "确认中仍占用序列化槽位");
    // 重读成功（有限重试内）：以重读结果为准解锁。
    assert.equal(tracker.resolveWithReread(request, CONV_A), true);
    assert.equal(tracker.isChangeConfirming(CONV_A), false);
    assert.equal(tracker.canSend(CONV_A), true);
  });

  test("reread resolves whether the stored value matches the target or not", () => {
    // 重读值即权威值：与目标一致说明切换已提交，不一致说明未提交；
    // 两种情况都按重读值解锁，跟踪器不猜测、不按目标值裁决。
    for (const _scenario of ["reread-equals-target", "reread-differs-from-target"]) {
      const tracker = createDefaultAgentChangeTracker();
      const request = tracker.beginChange(CONV_A)!;
      assert.equal(tracker.markUncertain(request), true);
      assert.equal(tracker.resolveWithReread(request, CONV_A), true);
      assert.equal(tracker.canSend(CONV_A), true);
    }
  });

  test("parse failure is uncertain too; failed rereads keep the block until a later refresh resolves", () => {
    const tracker = createDefaultAgentChangeTracker();
    const request = tracker.beginChange(CONV_A)!;
    // 响应解析失败与网络失败同类：转入确认中。
    assert.equal(tracker.markUncertain(request), true);
    // 有限次重读全部失败：不解锁、不回旧值。
    assert.equal(tracker.isChangePending(CONV_A), true);
    assert.equal(tracker.canSend(CONV_A), false, "重读失败必须保持阻断");
    // 后续状态刷新（本身即一次重读）到达后解锁。
    assert.equal(tracker.resolveConfirming(CONV_A), true);
    assert.equal(tracker.canSend(CONV_A), true);
    assert.equal(tracker.resolveConfirming(CONV_A), false, "无确认中变更时刷新不做解锁");
  });

  test("reread resolution is discarded after switching conversations, but still releases the slot", () => {
    const tracker = createDefaultAgentChangeTracker();
    const request = tracker.beginChange(CONV_A)!;
    assert.equal(tracker.markUncertain(request), true);
    assert.equal(tracker.resolveWithReread(request, CONV_B), false, "已切换会话时重读结果不得回写新会话");
    assert.equal(tracker.isChangePending(CONV_A), false, "过期确认仍释放槽位，回原会话不卡死");
  });

  test("uncertain transitions require the live request and the confirming phase", () => {
    const tracker = createDefaultAgentChangeTracker();
    const request = tracker.beginChange(CONV_A)!;
    // 尚未转入确认中时不得用重读解锁（确定结果走 finishChange）。
    assert.equal(tracker.resolveWithReread(request, CONV_A), false);
    assert.equal(tracker.isChangePending(CONV_A), true);
    assert.equal(tracker.markUncertain(request), true);
    // 过期请求的迟到不确定标记不得影响更新的变更。
    const stale = { ...request, sequence: request.sequence + 99 };
    assert.equal(tracker.markUncertain(stale), false);
    assert.equal(tracker.resolveWithReread(stale, CONV_A), false);
    assert.equal(tracker.isChangeConfirming(CONV_A), true);
  });

  test("definite error response unlocks immediately via finishChange (no confirming phase)", () => {
    const tracker = createDefaultAgentChangeTracker();
    const request = tracker.beginChange(CONV_A)!;
    // 明确的错误响应（如 4xx 带 JSON 错误体）是确定失败：立即解锁。
    assert.equal(tracker.finishChange(request, CONV_A), true);
    assert.equal(tracker.isChangeConfirming(CONV_A), false);
    assert.equal(tracker.canSend(CONV_A), true);
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

  test("uncertain outcomes go through the confirming phase and the state reread path (Dot 0094)", () => {
    const updateMatch = appSource.match(/async function updateDefaultDirectAgent\([\s\S]*?\n  \}/);
    assert.ok(updateMatch, "updateDefaultDirectAgent must exist");
    assert.match(updateMatch[0], /tracker\.markUncertain\(request\)/);
    assert.match(updateMatch[0], /tracker\.resolveWithReread\(request, responseContext\(\)\)/);
    assert.match(updateMatch[0], /"\/api\/state"/, "确认必须走既有的状态读取路径重读");
    assert.match(appSource, /确认中…/);
    assert.match(appSource, /接收人结果确认中，完成后可发送/);
    assert.match(appSource, /resolveConfirming\(requestedContext\)/, "状态刷新成功也要能解锁确认中变更");
  });

  test("composer disables the picker and the send button while pending, with a visible status", () => {
    assert.match(appSource, /disabled=\{!hasWorkspace \|\| !hasEnabledAgent \|\| defaultAgentChangePending\}/);
    assert.match(appSource, /\|\| defaultAgentChangePending\}/);
    assert.match(appSource, /defaultReceiverPending/);
    assert.match(appSource, /接收人保存中，完成后可发送/);
  });
});
