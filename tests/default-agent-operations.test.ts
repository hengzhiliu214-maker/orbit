import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { DefaultAgentOperationRegistry } from "../src/server/default-agent-operations.ts";

/**
 * Dot 0096 终结屏障：默认接收人变更的操作登记。
 *
 * 客户端在 PUT 结果不确定时凭 operationId 查操作状态裁决终结：
 * pending 不是终结（提交前的读取只能看到 pending，绝不能据此解锁），
 * committed / failed 才是终结；同一会话的变更必须串行执行不交错。
 */

const KEY = "ws-1\nconv-a";

describe("default agent operation registry", () => {
  test("operation lifecycle: pending is not terminal, commit and fail are", async () => {
    const registry = new DefaultAgentOperationRegistry();
    await registry.runExclusive(KEY, async () => {
      registry.begin(KEY, "op-1", "agent-a");
      // 提交前读取：只能看到 pending——这正是「GET 在 PUT 提交前返回
      // 旧值不得据此解锁」的服务端对应物：未终结就是未终结。
      assert.equal(registry.get(KEY, "op-1")?.status, "pending");
      assert.equal(registry.get(KEY, "op-1")?.agentId, "agent-a");
      const committed = registry.commit(KEY, "op-1", "agent-a");
      assert.equal(committed?.status, "committed");
    });
    assert.equal(registry.get(KEY, "op-1")?.status, "committed");

    await registry.runExclusive(KEY, async () => {
      registry.begin(KEY, "op-2", "agent-b");
      const failed = registry.fail(KEY, "op-2", "Failed to persist the default direct agent.");
      assert.equal(failed?.status, "failed");
      assert.equal(failed?.message, "Failed to persist the default direct agent.");
    });
    assert.equal(registry.get(KEY, "op-2")?.status, "failed");
    // 已终结的操作记录仍可查询（迟到的确认查询要能得到终局答案）。
    assert.equal(registry.get(KEY, "op-1")?.status, "committed");
  });

  test("unknown operations are absent, and finishing one is a no-op", () => {
    const registry = new DefaultAgentOperationRegistry();
    assert.equal(registry.get(KEY, "op-missing"), undefined);
    assert.equal(registry.commit(KEY, "op-missing", "agent-a"), undefined);
    assert.equal(registry.fail(KEY, "op-missing", "boom"), undefined);
    // begin 幂等：重复登记不重置已终结状态。
    registry.begin(KEY, "op-1", "agent-a");
    registry.commit(KEY, "op-1", "agent-a");
    assert.equal(registry.begin(KEY, "op-1", "agent-b").status, "committed");
  });

  test("same-conversation operations run serially and never interleave", async () => {
    const registry = new DefaultAgentOperationRegistry();
    const order: string[] = [];
    const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const first = registry.runExclusive(KEY, async () => {
      registry.begin(KEY, "op-1", "agent-a");
      order.push("first:start");
      await delay(30);
      // 第一个操作提交前，第二个操作不得开始（pending 期间的读取
      // 也只能看到 op-1 的 pending，不能看到任何后续变更的结果）。
      assert.equal(registry.get(KEY, "op-2"), undefined);
      registry.commit(KEY, "op-1", "agent-a");
      order.push("first:end");
      return "first-result";
    });
    const second = registry.runExclusive(KEY, async () => {
      order.push("second:start");
      registry.begin(KEY, "op-2", null);
      registry.commit(KEY, "op-2", null);
      order.push("second:end");
      return "second-result";
    });
    assert.equal(await first, "first-result");
    assert.equal(await second, "second-result");
    assert.deepEqual(order, ["first:start", "first:end", "second:start", "second:end"]);
    assert.equal(registry.get(KEY, "op-2")?.agentId, null, "清除默认（null）同样是可提交的终结值");
  });

  test("a failing task does not poison the queue, and other conversations are independent", async () => {
    const registry = new DefaultAgentOperationRegistry();
    await assert.rejects(
      registry.runExclusive(KEY, async () => {
        throw new Error("handler blew up");
      }),
      /handler blew up/,
    );
    const value = await registry.runExclusive(KEY, async () => "recovered");
    assert.equal(value, "recovered");
    const other = await registry.runExclusive("ws-1\nconv-b", async () => "other-conversation");
    assert.equal(other, "other-conversation");
  });

  test("only the most recent operations are retained per conversation", () => {
    const registry = new DefaultAgentOperationRegistry();
    for (let i = 1; i <= 10; i += 1) {
      registry.begin(KEY, `op-${i}`, "agent-a");
      registry.commit(KEY, `op-${i}`, "agent-a");
    }
    assert.equal(registry.get(KEY, "op-1"), undefined, "最旧的操作记录被淘汰");
    assert.equal(registry.get(KEY, "op-10")?.status, "committed", "最新操作仍可查到终结状态");
  });
});
