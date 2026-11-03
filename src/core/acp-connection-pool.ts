import path from "node:path";

import type { InitializeResponse, SessionNotification } from "@agentclientprotocol/sdk";

import type {
  AcpConnection,
  AcpReusableConnection,
  AcpRunOptions,
  AcpRuntimeDefinition,
} from "./acp-runtime.ts";

export const DEFAULT_ACP_PROCESS_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_IDLE_PROCESSES = 8;

type Entry = {
  key: string;
  connection: AcpReusableConnection;
  initialized?: Promise<InitializeResponse>;
  sessions: Set<string>;
  leased: boolean;
  lastUsedAt: number;
  timer?: NodeJS.Timeout;
  /** 连接世代：条目（即底层 agent 进程）创建时分配，进程内单调递增（Dot 0094）。 */
  generation: number;
};

export type AcpReusableConnectionFactory = (
  definition: AcpRuntimeDefinition,
  options: AcpRunOptions,
  onSessionUpdate: (notification: SessionNotification) => void,
) => AcpReusableConnection;

export type AcpConnectionPoolOptions = {
  ttlMs?: number;
  maxIdleProcesses?: number;
  now?: () => number;
};

export class AcpConnectionPool {
  private readonly entries = new Map<string, Entry>();
  /** 连接世代计数与「会话 → 创建它的连接世代」登记（Dot 0094）：池是进程内
   * 单例，登记不到来源世代的会话必然创建于本 Orbit 进程启动之前（绑定是
   * 从磁盘恢复的），其创建进程已经不存在。 */
  private nextGeneration = 0;
  private readonly sessionGenerations = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly maxIdleProcesses: number;
  private readonly now: () => number;

  constructor(
    private readonly factory: AcpReusableConnectionFactory,
    options: AcpConnectionPoolOptions = {},
  ) {
    this.ttlMs = Math.max(0, options.ttlMs ?? DEFAULT_ACP_PROCESS_TTL_MS);
    this.maxIdleProcesses = Math.max(1, options.maxIdleProcesses ?? DEFAULT_MAX_IDLE_PROCESSES);
    this.now = options.now ?? Date.now;
  }

  acquire(
    definition: AcpRuntimeDefinition,
    options: AcpRunOptions,
    onSessionUpdate: (notification: SessionNotification) => void,
  ): AcpConnection {
    const key = connectionKey(definition, options);
    let entry = this.entries.get(key);
    if (entry && (entry.leased || !entry.connection.isAlive())) {
      if (!entry.leased) this.destroyEntry(entry);
      entry = undefined;
    }

    if (!entry) {
      this.evictIdleOverflow();
      entry = {
        key,
        connection: this.factory(definition, options, onSessionUpdate),
        sessions: new Set(),
        generation: ++this.nextGeneration,
        leased: false,
        lastUsedAt: this.now(),
      };
      this.entries.set(key, entry);
    }

    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
    entry.leased = true;
    entry.connection.rebind(options, onSessionUpdate);
    return this.createLease(entry);
  }

  dispose(): void {
    for (const entry of [...this.entries.values()]) {
      this.destroyEntry(entry);
    }
  }

  size(): number {
    return this.entries.size;
  }

  private createLease(entry: Entry): AcpConnection {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      entry.connection.deactivate();
      entry.leased = false;
      entry.lastUsedAt = this.now();
      if (this.entries.get(entry.key) !== entry) {
        entry.connection.close();
        return;
      }
      this.trimIdleProcesses(this.maxIdleProcesses);
      if (this.ttlMs === 0) {
        this.destroyEntry(entry);
        return;
      }
      if (this.entries.get(entry.key) !== entry) return;
      entry.timer = setTimeout(() => this.destroyEntry(entry), this.ttlMs);
      entry.timer.unref?.();
    };
    const destroy = () => {
      if (released) return;
      released = true;
      this.destroyEntry(entry);
    };

    const sessionGenerations = this.sessionGenerations;
    return {
      pid: entry.connection.pid,
      // 连接世代信息（Dot 0094）：供会话恢复分类判定「恢复尝试是否发生在
      // 与创建该会话不同的进程世代」。
      connectionGeneration: entry.generation,
      sessionGeneration: (sessionId: string) => sessionGenerations.get(sessionId),
      initialize: (request) => {
        entry.initialized ??= entry.connection.initialize(request);
        return entry.initialized;
      },
      newSession: async (request) => {
        const created = await entry.connection.newSession(request);
        entry.sessions.add(created.sessionId);
        sessionGenerations.set(created.sessionId, entry.generation);
        return created;
      },
      loadSession: async (request) => {
        const loaded = await entry.connection.loadSession(request);
        entry.sessions.add(request.sessionId);
        sessionGenerations.set(request.sessionId, entry.generation);
        return loaded;
      },
      resumeSession: async (request) => {
        const resumed = await entry.connection.resumeSession(request);
        entry.sessions.add(request.sessionId);
        sessionGenerations.set(request.sessionId, entry.generation);
        return resumed;
      },
      setConfigOption: (request) => entry.connection.setConfigOption(request),
      // 可选能力按底层连接的实际实现转发：底层没有 setModel 时包装层也
      // 不得凭空造出（调用方以缺席判定「不支持变体下发」）。
      ...(entry.connection.setModel
        ? { setModel: (request: { sessionId: string; modelId: string }) => entry.connection.setModel!(request) }
        : {}),
      prompt: (request) => entry.connection.prompt(request),
      cancel: (sessionId) => entry.connection.cancel(sessionId),
      hasSession: (sessionId) => entry.sessions.has(sessionId),
      close: release,
      destroy,
    };
  }

  private evictIdleOverflow(): void {
    this.trimIdleProcesses(this.maxIdleProcesses - 1);
  }

  private trimIdleProcesses(limit: number): void {
    const idle = [...this.entries.values()]
      .filter((entry) => !entry.leased)
      .sort((left, right) => left.lastUsedAt - right.lastUsedAt);
    while (idle.length > Math.max(0, limit)) {
      this.destroyEntry(idle.shift()!);
    }
  }

  private destroyEntry(entry: Entry): void {
    if (entry.timer) clearTimeout(entry.timer);
    if (this.entries.get(entry.key) === entry) {
      this.entries.delete(entry.key);
    }
    // 强制销毁与正常释放不同：先解除会话绑定，再走底层 destroy 终止进程并结束
    // 所有 pending 请求；连接绝不回到空闲池（issue #136）。
    entry.connection.deactivate();
    if (entry.connection.destroy) {
      entry.connection.destroy();
      return;
    }
    entry.connection.close();
  }
}

// 代理环境变量参与连接键（issue #141）：切换系统代理后，池中旧连接仍走旧
// 出口，必须视为不可复用；代理值变化会产生不同的键，从而另起新进程。
const PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"] as const;

function proxyEnvKey(baseEnv: NodeJS.ProcessEnv, runEnv: NodeJS.ProcessEnv): Record<string, string> {
  const snapshot: Record<string, string> = {};
  for (const key of PROXY_ENV_KEYS) {
    // runEnv 覆盖 baseEnv（与 spawn 时的展开顺序一致）；大小写变体取先定义者，
    // 统一以大写键写入快照，避免仅大小写不同的环境相互复用连接。
    const value = runEnv[key] ?? runEnv[key.toLowerCase()] ?? baseEnv[key] ?? baseEnv[key.toLowerCase()];
    if (value !== undefined) snapshot[key] = value;
  }
  return snapshot;
}

function connectionKey(definition: AcpRuntimeDefinition, options: AcpRunOptions): string {
  const baseEnv = options.env ?? process.env;
  const command = definition.buildCommand(baseEnv);
  const runEnv = definition.envForRun?.(options) ?? {};
  return JSON.stringify({
    runtime: definition.kind,
    cwd: path.resolve(options.cwd),
    owner: options.poolKey ?? options.agentId,
    approvalMode: options.approvalMode ?? "ask",
    command: [command.file, ...command.args],
    runEnv: Object.entries(runEnv).sort(([left], [right]) => left.localeCompare(right)),
    proxyEnv: proxyEnvKey(baseEnv, runEnv),
  });
}
