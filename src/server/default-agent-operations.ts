import type { AgentId } from "../shared/types.ts";

/**
 * 默认接收人变更的操作登记与终结屏障（Dot 0096）。
 *
 * 0095 的确认方式是客户端在 PUT 结果不确定时用 GET /api/state 重读，
 * 以读回值解锁。Dot 0096 指出单次读取不是原 PUT 已终结的屏障：读取
 * 可能发生在 PUT 提交之前（读到旧值），而 PUT 随后才提交；反过来
 * PUT 响应失败后先读到旧值、原 PUT 随后提交，同样让界面与服务器
 * 不一致。本登记把「某次变更是否已终结」从值推断改为操作状态：
 *
 * - 客户端每次变更生成唯一 operationId 随 PUT 带来；服务端在处理
 *   前登记为 pending，处理完成（已持久化且读回与目标一致）记
 *   committed，失败记 failed（含失败原因）；
 * - 同一会话的变更经 runExclusive 串行执行，不并发交错，后到者必须
 *   等前一个终结；
 * - 客户端在结果不确定时凭 operationId 查询操作状态：pending 继续
 *   等；committed/failed 才是终结，才可解锁。操作记录只存服务端
 *   内存：服务端重启后查不到——此时不存在仍在途的 PUT（随旧进程
 *   消亡），客户端才可改以状态重读值作为终局权威值。
 *
 * 记录按会话保留最近若干条（客户端只查自己最新一次变更，但迟到的
 * 查询可能指向已被后续变更覆盖的操作号，保留少量历史可让终结状态
 * 仍可查得）。
 */

export type DefaultAgentOperationStatus = "pending" | "committed" | "failed";

export type DefaultAgentOperation = {
  operationId: string;
  status: DefaultAgentOperationStatus;
  /** 目标接收人；committed 时即已提交并落盘的值（null 表示清除默认）。 */
  agentId: AgentId | null;
  /** failed 时的失败原因（服务端错误消息原文）。 */
  message?: string;
  updatedAt: string;
};

const MAX_OPERATIONS_PER_CONVERSATION = 8;

export class DefaultAgentOperationRegistry {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly operations = new Map<string, Map<string, DefaultAgentOperation>>();

  /**
   * 同一 key（会话）的任务串行执行：task 在前一个任务完全结束（包括
   * 其响应写出）后才开始。不同 key 互不阻塞。task 抛错不毒化队列，
   * 后续任务仍可运行。
   */
  runExclusive<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.tails.set(key, tail);
    const settle = () => {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    };
    return previous.then(task).then(
      (value) => {
        settle();
        return value;
      },
      (error) => {
        settle();
        throw error;
      },
    );
  }

  /** 登记一次变更为 pending；同 operationId 重复登记是幂等的，返回既有记录。 */
  begin(key: string, operationId: string, agentId: AgentId | null): DefaultAgentOperation {
    let byId = this.operations.get(key);
    if (!byId) {
      byId = new Map();
      this.operations.set(key, byId);
    }
    const existing = byId.get(operationId);
    if (existing) return existing;
    const record: DefaultAgentOperation = {
      operationId,
      status: "pending",
      agentId,
      updatedAt: new Date().toISOString(),
    };
    byId.set(operationId, record);
    while (byId.size > MAX_OPERATIONS_PER_CONVERSATION) {
      const oldest = byId.keys().next().value as string;
      byId.delete(oldest);
    }
    return record;
  }

  /** 把操作标记为已提交（已落盘且读回一致）。未知 operationId 返回 undefined。 */
  commit(key: string, operationId: string, agentId: AgentId | null): DefaultAgentOperation | undefined {
    return this.finish(key, operationId, { status: "committed", agentId });
  }

  /** 把操作标记为已失败（未提交）。未知 operationId 返回 undefined。 */
  fail(key: string, operationId: string, message: string): DefaultAgentOperation | undefined {
    return this.finish(key, operationId, { status: "failed", message });
  }

  private finish(
    key: string,
    operationId: string,
    outcome: { status: "committed"; agentId: AgentId | null } | { status: "failed"; message: string },
  ): DefaultAgentOperation | undefined {
    const record = this.operations.get(key)?.get(operationId);
    if (!record) return undefined;
    record.status = outcome.status;
    if (outcome.status === "committed") {
      record.agentId = outcome.agentId;
      delete record.message;
    } else {
      record.message = outcome.message;
    }
    record.updatedAt = new Date().toISOString();
    return record;
  }

  /** 查询一次变更的操作状态；从未登记或已被淘汰时返回 undefined。 */
  get(key: string, operationId: string): DefaultAgentOperation | undefined {
    return this.operations.get(key)?.get(operationId);
  }
}
