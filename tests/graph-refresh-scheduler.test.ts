import test from "node:test";
import assert from "node:assert/strict";

import {
  GraphFetchGeneration,
  GraphRefreshScheduler,
  type GraphRefreshReason,
  type GraphRefreshSchedulerTimers,
} from "../src/ui/graph-refresh-scheduler.ts";

/** 可控假时钟：now + setTimeout/clearTimeout，advance 按时间顺序触发。 */
class FakeClock {
  nowMs = 1_000_000;
  private timers = new Map<number, { at: number; fn: () => void }>();
  private nextId = 1;

  timersApi(): GraphRefreshSchedulerTimers {
    return {
      now: () => this.nowMs,
      setTimeout: (fn, ms) => {
        const id = this.nextId++;
        this.timers.set(id, { at: this.nowMs + ms, fn });
        return id;
      },
      clearTimeout: (id) => { this.timers.delete(id as number); },
    };
  }

  advance(ms: number): void {
    const end = this.nowMs + ms;
    for (;;) {
      let next: { id: number; at: number; fn: () => void } | null = null;
      for (const [id, timer] of this.timers) {
        if (timer.at <= end && (!next || timer.at < next.at)) next = { id, ...timer };
      }
      if (!next) break;
      this.timers.delete(next.id);
      this.nowMs = next.at;
      next.fn();
    }
    this.nowMs = end;
  }
}

/**
 * 面板侧取回桩：记录每次发起的时刻与原因；inFlight 为真时不自动结算，
 * 由测试手动 settle（模拟单次在途请求）。
 */
function makePanel(clock: FakeClock, autoSettle: boolean) {
  const calls: { at: number; reason: GraphRefreshReason }[] = [];
  let scheduler!: GraphRefreshScheduler;
  const pendingTokens: number[] = [];
  const requestFetch = (reason: GraphRefreshReason) => {
    calls.push({ at: clock.nowMs, reason });
    const token = scheduler.onFetchStarted();
    if (autoSettle) scheduler.onFetchSettled(token);
    else pendingTokens.push(token);
  };
  scheduler = new GraphRefreshScheduler(requestFetch, clock.timersApi(), 1000, 450, 1000);
  return {
    scheduler,
    calls,
    settleOldest() {
      const token = pendingTokens.shift();
      if (token !== undefined) scheduler.onFetchSettled(token);
    },
    settleAll() {
      while (pendingTokens.length > 0) {
        const token = pendingTokens.shift();
        if (token !== undefined) scheduler.onFetchSettled(token);
      }
    },
  };
}

test("孤立变化：最后一次变化后 450ms 取一次（尾沿合并）", () => {
  const clock = new FakeClock();
  const panel = makePanel(clock, true);
  panel.scheduler.onInputChanged();
  clock.advance(449);
  assert.equal(panel.calls.length, 0);
  clock.advance(1);
  assert.equal(panel.calls.length, 1);
  assert.equal(panel.calls[0].reason, "live");
  assert.equal(panel.calls[0].at, 1_000_450);
});

test("同批多变只取一次：取回时刻按最后一次变化算", () => {
  const clock = new FakeClock();
  const panel = makePanel(clock, true);
  panel.scheduler.onInputChanged();
  clock.advance(100);
  panel.scheduler.onInputChanged();
  clock.advance(100);
  panel.scheduler.onInputChanged();
  clock.advance(449);
  assert.equal(panel.calls.length, 0);
  clock.advance(1);
  assert.equal(panel.calls.length, 1);
  assert.equal(panel.calls[0].at, 1_000_650);
});

test("连续变化期间节流：约每 1 秒取一次，不每令牌刷图；最大等待 1 秒", () => {
  const clock = new FakeClock();
  const startMs = clock.nowMs;
  const panel = makePanel(clock, true);
  for (let i = 0; i < 50; i++) {
    panel.scheduler.onInputChanged();
    clock.advance(100);
  }
  // 5 秒、每 100ms 一变：首次取回恰在最大等待 1000ms 处，之后每 1000ms 一次
  assert.equal(panel.calls.length, 5, `calls=${JSON.stringify(panel.calls)}`);
  assert.equal(panel.calls[0].at - startMs, 1000);
  for (let i = 1; i < panel.calls.length; i++) {
    assert.equal(panel.calls[i].at - panel.calls[i - 1].at, 1000);
  }
  // 变化停止后无待取变化，不再补发
  clock.advance(450);
  assert.equal(panel.calls.length, 5);
  // 停止后再变：最终补刷在节流下限内（距上次发起 1000ms）
  clock.advance(100);
  panel.scheduler.onInputChanged(); // 最后一次变化在 1_005_550
  clock.advance(449);
  assert.equal(panel.calls.length, 5);
  clock.advance(1);
  assert.equal(panel.calls.length, 6);
  assert.equal(panel.calls[5].at - panel.calls[4].at, 1000);
  assert.ok(panel.calls[5].at - 1_005_550 <= 1000, "最终补刷距最后一次变化 ≤1000ms");
});

test("尾沿补刷：节流已满时，最后一次变化后 450ms 取到", () => {
  const clock = new FakeClock();
  const panel = makePanel(clock, true);
  panel.scheduler.onInputChanged();
  clock.advance(2000); // 首次取回在 450ms 处
  assert.equal(panel.calls.length, 1);
  panel.scheduler.onInputChanged();
  clock.advance(449);
  assert.equal(panel.calls.length, 1);
  clock.advance(1);
  assert.equal(panel.calls.length, 2);
  assert.equal(panel.calls[1].at, 1_002_450);
});

test("在途请求未结算时不并发；结算后按节流补约", () => {
  const clock = new FakeClock();
  const panel = makePanel(clock, false);
  panel.scheduler.onInputChanged();
  clock.advance(450);
  assert.equal(panel.calls.length, 1);
  clock.advance(50);
  panel.scheduler.onInputChanged();
  clock.advance(2000);
  assert.equal(panel.calls.length, 1, "在途时只记 pending，不发新请求");
  panel.settleOldest();
  clock.advance(0); // 冲掉 delay 0 的补约定时器
  assert.equal(panel.calls.length, 2, "结算后立即补约（已满 1 秒）");
  assert.equal(panel.calls[1].at, 1_002_500);
});

test("结算时节流未满：等到满 1 秒再补约", () => {
  const clock = new FakeClock();
  const panel = makePanel(clock, false);
  panel.scheduler.onInputChanged();
  clock.advance(450);
  assert.equal(panel.calls.length, 1);
  clock.advance(300);
  panel.scheduler.onInputChanged();
  panel.settleOldest();
  assert.equal(panel.calls.length, 1);
  clock.advance(699);
  assert.equal(panel.calls.length, 1);
  clock.advance(1);
  assert.equal(panel.calls.length, 2);
  assert.equal(panel.calls[1].at - panel.calls[0].at, 1000);
});

test("手动刷新打断节流等待并立即取；旧 pending 不再补发", () => {
  const clock = new FakeClock();
  const panel = makePanel(clock, false);
  panel.scheduler.onInputChanged();
  clock.advance(450);
  clock.advance(300);
  panel.scheduler.onInputChanged();
  panel.scheduler.requestImmediate("manual");
  assert.equal(panel.calls.length, 2);
  assert.equal(panel.calls[1].reason, "manual");
  panel.settleOldest();
  panel.settleOldest();
  clock.advance(5000);
  assert.equal(panel.calls.length, 2, "手动取已覆盖 pending，不再补发");
});

test("打开原因如实传递", () => {
  const clock = new FakeClock();
  const panel = makePanel(clock, true);
  panel.scheduler.requestImmediate("open");
  assert.deepEqual(panel.calls, [{ at: clock.nowMs, reason: "open" }]);
});

test("过期令牌的 settled 被忽略，不误清新取回的 fetching 态", () => {
  const clock = new FakeClock();
  const panel = makePanel(clock, false);
  panel.scheduler.onInputChanged();
  clock.advance(450);
  assert.equal(panel.calls.length, 1);
  panel.scheduler.requestImmediate("manual"); // 发起新取回（令牌 2）
  assert.equal(panel.calls.length, 2);
  panel.scheduler.onFetchSettled(1); // 旧取回晚到结算：应被忽略
  panel.scheduler.onInputChanged(); // 变化到达：新取回在途，不应并发
  clock.advance(5000);
  assert.equal(panel.calls.length, 2, "旧 settled 不得误清 fetching，也不得漏发");
  panel.settleAll();
  clock.advance(0);
  assert.equal(panel.calls.length, 3, "新取回结算后 pending 补约");
});

test("代次保护：只有最新代次算当前", () => {
  const gen = new GraphFetchGeneration();
  const first = gen.next();
  const second = gen.next();
  assert.equal(gen.isCurrent(first), false);
  assert.equal(gen.isCurrent(second), true);
  assert.equal(gen.isCurrent(second + 1), false);
});

test("dispose 后计时器不再触发", () => {
  const clock = new FakeClock();
  const panel = makePanel(clock, true);
  panel.scheduler.onInputChanged();
  clock.advance(100);
  panel.scheduler.dispose();
  clock.advance(5000);
  assert.equal(panel.calls.length, 0);
});
