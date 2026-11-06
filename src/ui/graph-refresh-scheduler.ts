/**
 * 指令链刷新调度器（P2b，Dot 0137 反例 b + gobot 0138 双向有界）。
 *
 * 旧机制是纯尾沿 450ms 防抖：流式消息约每 100ms 改一次签名时，
 * 防抖计时器不断被重置，可能直到长响应结束才触发——图长期停在旧快照。
 * 反过来签名每令牌抖动也不能持续刷图抢主线程。
 *
 * 本调度器双向有界（默认值写死在构造参数里，调用方可覆盖）：
 * - 尾沿合并：孤立变化在最后一次变化后 450ms 取一次（同批变化只取一次）。
 * - 最大等待：从第一次未取变化起最晚 maxWaitMs（默认 1000ms）即取到，
 *   不会等到流结束。
 * - 节流：连续变化期间两次取回发起至少间隔 minIntervalMs（默认 1000ms）。
 * - 单次在途：取回进行中不发新请求；变化先记 pending，取回完成后再按
 *   上式补约，不丢变化也不并发。
 * - 代次保护另见 GraphFetchGeneration：旧响应晚到不得覆盖新状态。
 *
 * 下次取回时刻 = max(min(最后变化+450ms, 首次未取变化+1000ms),
 *                     上次发起+1000ms)，单个可注入时钟的定时器驱动。
 * 计时器可注入（测试用假时钟）；默认用全局 setTimeout / Date.now。
 */

export type GraphRefreshReason = "open" | "live" | "manual";

export type GraphRefreshSchedulerTimers = {
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (id: unknown) => void;
};

const defaultTimers: GraphRefreshSchedulerTimers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

/** 请求代次：每次发起取回 +1；响应只当其代次仍是最新时才可落盘。 */
export class GraphFetchGeneration {
  private current = 0;
  next(): number {
    this.current += 1;
    return this.current;
  }
  isCurrent(generation: number): boolean {
    return generation === this.current;
  }
}

export class GraphRefreshScheduler {
  private pending = false;
  private pendingReason: GraphRefreshReason = "live";
  private fetching = false;
  private fetchToken = 0;
  private lastFetchStartedAt = 0;
  private firstPendingAt = 0;
  private lastChangeAt = 0;
  private timer: unknown = null;

  constructor(
    private readonly requestFetch: (reason: GraphRefreshReason) => void,
    private readonly timers: GraphRefreshSchedulerTimers = defaultTimers,
    private readonly minIntervalMs = 1000,
    private readonly trailingDelayMs = 450,
    private readonly maxWaitMs = 1000,
  ) {}

  /** 图输入变化（签名变了）：记 pending，按尾沿/最大等待/节流调度。 */
  onInputChanged(): void {
    const now = this.timers.now();
    if (!this.pending) {
      this.pending = true;
      this.firstPendingAt = now;
    }
    this.pendingReason = "live";
    this.lastChangeAt = now;
    this.scheduleNext();
  }

  /** 打开 / 手动刷新：清掉等待中的计时，立即取一次。 */
  requestImmediate(reason: "open" | "manual"): void {
    this.clearTimer();
    this.pending = false;
    this.requestFetch(reason);
  }

  /**
   * 一次取回开始时调用，返回本次取回的令牌；取回结束时把令牌交回
   * onFetchSettled。令牌过期（中途被更新的取回取代）的 settled 调用
   * 会被忽略，不会误清新取回的 fetching 态。
   */
  onFetchStarted(): number {
    this.fetching = true;
    this.lastFetchStartedAt = this.timers.now();
    this.fetchToken += 1;
    return this.fetchToken;
  }

  onFetchSettled(token: number): void {
    if (token !== this.fetchToken) return;
    this.fetching = false;
    this.scheduleNext();
  }

  dispose(): void {
    this.clearTimer();
    this.pending = false;
  }

  /** 下次取回时刻：尾沿与最大等待取早者，再服从节流下限。 */
  private targetAt(): number {
    const debounceAt = this.lastChangeAt + this.trailingDelayMs;
    const maxWaitAt = this.firstPendingAt + this.maxWaitMs;
    const throttleAt = this.lastFetchStartedAt === 0 ? 0 : this.lastFetchStartedAt + this.minIntervalMs;
    return Math.max(Math.min(debounceAt, maxWaitAt), throttleAt);
  }

  private scheduleNext(): void {
    if (!this.pending || this.fetching) return;
    const delay = Math.max(0, this.targetAt() - this.timers.now());
    this.clearTimer();
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      this.tryFetch();
    }, delay);
  }

  private tryFetch(): void {
    if (!this.pending || this.fetching) return;
    if (this.timers.now() >= this.targetAt()) {
      const reason = this.pendingReason;
      this.pending = false;
      this.clearTimer();
      this.requestFetch(reason);
    } else {
      this.scheduleNext();
    }
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      this.timers.clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
