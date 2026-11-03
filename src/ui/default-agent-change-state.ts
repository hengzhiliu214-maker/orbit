/**
 * 默认接收人变更生命周期（Dot 0092 定向复核第 1 项；Dot 0094 补充不确定结果）。
 *
 * 输入区的「发送给」下拉切换默认接收人是一个异步 PUT：响应回来之前
 * `state.conversation.lastDirectAgentId` 仍是旧值，此时发送消息会按旧
 * 接收人路由；若用户在响应到达前切换到别的会话，旧响应还会把旧会话的
 * conversation 覆盖到当前会话的界面状态上。该跟踪器把每次变更绑定到
 * 发起时的 workspace/conversation 快照并单调编号：
 * - 同一会话同一时刻只允许一个在途变更（序列化），重复变更被忽略；
 * - 发送前的权威拦截读取同步的在途状态（渲染态仅用于按钮禁用与状态
 *   提示），保证「变更未确认不允许发送」不依赖 React 渲染时序；
 * - 响应到达时，仅当它仍是该会话的在途变更、且界面仍停留在发起变更
 *   的 workspace/conversation 时才允许应用；迟到、乱序或已切换会话的
 *   过期响应一律丢弃（服务端状态会在回到该会话时重新拉取）。
 *
 * Dot 0094 补充：PUT 的结果可能「不确定」——网络失败或响应解析失败时，
 * 服务端可能已经提交切换、也可能没有。此时绝不能按确定失败解锁回旧值
 * （界面显示旧接收人而服务器已切换，下一条消息就会错发）。不确定结果
 * 把在途变更转入「确认中」阶段：继续阻断发送、继续占用序列化槽位，
 * 由调用方用状态读取路径重读该会话的已保存值，以重读结果为准解锁
 * （resolveWithReread）；重读也失败则保持确认态，等待后续状态刷新
 * 带来的新状态再解锁（resolveConfirming）。只有收到明确的错误响应
 * （如 4xx 带 JSON 错误体）才算确定失败，走 finishChange 立即解锁。
 *
 * Dot 0096 终结屏障：在此基础上再进一步——单次重读不是原 PUT 已终结
 * 的屏障（重读可能读到 PUT 提交前的值、PUT 随后才提交）。每次变更
 * 因此携带唯一 operationId，服务端按操作登记 pending/committed/
 * failed 并串行执行；确认阶段的裁决依据改为操作状态（终结才解锁，
 * resolveWithOperation），不再以读回值本身裁决。resolveWithReread
 * 收窄为唯一回退场景：操作记录查不到（服务端已重启——在途 PUT 随
 * 旧进程消亡，不可能再提交），此时重读值才是终局权威值。App 的状态
 * 刷新路径也不再凭一次刷新直接解锁（刷新可能带着 PUT 前读到的旧
 * 值），只触发一次操作状态确认；resolveConfirming 保留为跟踪器原语
 * （其单测覆盖语义），App 不再直接调用它解锁。
 */

export type DefaultAgentChangeContext = {
  workspaceId: string;
  conversationId: string;
};

export type DefaultAgentChangeRequest = DefaultAgentChangeContext & {
  /** 变更序号（单调递增）；响应到达时凭此确认仍是该会话的在途变更。 */
  sequence: number;
  /**
   * 客户端操作号（Dot 0096）：随 PUT 发给服务端登记操作状态；结果
   * 不确定时凭此查询该次变更是否已终结（committed / failed）。
   */
  operationId: string;
};

/** 在途变更的阶段：等待 PUT 结果，或结果不确定、等待重读确认。 */
export type DefaultAgentChangePhase = "awaiting" | "confirming";

type PendingChange = {
  request: DefaultAgentChangeRequest;
  phase: DefaultAgentChangePhase;
};

export function createDefaultAgentChangeTracker() {
  let sequence = 0;
  const pendingByConversation = new Map<string, PendingChange>();

  function keyOf(context: DefaultAgentChangeContext): string {
    return `${context.workspaceId}\n${context.conversationId}`;
  }

  return {
    /**
     * 开始一次变更并占用该会话的在途槽位；同一会话已有在途变更时
     * 返回 null（序列化：先等在途变更确认，再接受下一次变更）。
     * operationId 缺省由跟踪器生成（序号 + 时间 + 随机后缀，页面生命
     * 周期内唯一）；测试可传入固定值。
     */
    beginChange(context: DefaultAgentChangeContext, operationId?: string): DefaultAgentChangeRequest | null {
      const key = keyOf(context);
      if (pendingByConversation.has(key)) return null;
      const request: DefaultAgentChangeRequest = {
        ...context,
        sequence: ++sequence,
        operationId: operationId
          ?? `op-${sequence.toString(36)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      };
      pendingByConversation.set(key, { request, phase: "awaiting" });
      return request;
    },
    /** 该会话是否有在途变更（渲染态：禁用下拉与发送按钮、展示状态提示）。 */
    isChangePending(context: DefaultAgentChangeContext): boolean {
      return pendingByConversation.has(keyOf(context));
    },
    /** 该会话的在途变更是否处于「结果不确定、确认中」阶段（渲染态文案）。 */
    isChangeConfirming(context: DefaultAgentChangeContext): boolean {
      return pendingByConversation.get(keyOf(context))?.phase === "confirming";
    },
    /**
     * 发送权威拦截：该会话有在途变更（含确认中）时不得发送，避免消息
     * 按尚未确认的旧接收人路由。
     */
    canSend(context: DefaultAgentChangeContext): boolean {
      return !pendingByConversation.has(keyOf(context));
    },
    /**
     * 变更有了确定结果（成功，或明确的错误响应）：结束对应的在途变更，
     * 并判定这份结果是否仍可应用到界面。仅当序号仍与在途变更一致（未被
     * 更新的变更取代）且当前界面仍停留在发起变更的 workspace/conversation
     * 时返回 true；迟到、乱序或已切换会话的过期结果返回 false，调用方
     * 必须丢弃（既不回写 conversation，也不在新会话里冒充错误提示）。
     */
    finishChange(request: DefaultAgentChangeRequest, currentContext: DefaultAgentChangeContext): boolean {
      const key = keyOf(request);
      const pending = pendingByConversation.get(key);
      if (!pending || pending.request.sequence !== request.sequence) return false;
      pendingByConversation.delete(key);
      return currentContext.workspaceId === request.workspaceId
        && currentContext.conversationId === request.conversationId;
    },
    /**
     * PUT 结果不确定（网络失败、响应解析失败等，服务端可能已提交）：
     * 把在途变更转入确认中阶段，保持发送阻断与槽位占用，等待重读确认。
     * 序号不匹配（已被更新的变更取代）时返回 false，调用方丢弃。
     */
    markUncertain(request: DefaultAgentChangeRequest): boolean {
      const pending = pendingByConversation.get(keyOf(request));
      if (!pending || pending.request.sequence !== request.sequence) return false;
      pending.phase = "confirming";
      return true;
    },
    /**
     * 该会话处于确认中阶段的在途变更（Dot 0096）：状态刷新等外部触发
     * 凭此找到需要做操作状态确认的变更，而不是凭刷新直接解锁。
     * 不在确认中（无在途变更、或仍在等 PUT 结果）时返回 null。
     */
    confirmingRequest(context: DefaultAgentChangeContext): DefaultAgentChangeRequest | null {
      const pending = pendingByConversation.get(keyOf(context));
      return pending && pending.phase === "confirming" ? pending.request : null;
    },
    /**
     * 操作状态已终结（Dot 0096：服务端操作记录 committed 或 failed）
     * 时解锁确认中变更：结束在途变更，返回值判定该终结结果是否仍可
     * 应用到界面（同 finishChange 的过期规则）。提交值或失败原因由
     * 调用方按操作记录应用。只有确认中阶段的变更可经此解锁。
     */
    resolveWithOperation(request: DefaultAgentChangeRequest, currentContext: DefaultAgentChangeContext): boolean {
      const key = keyOf(request);
      const pending = pendingByConversation.get(key);
      if (!pending || pending.request.sequence !== request.sequence || pending.phase !== "confirming") return false;
      pendingByConversation.delete(key);
      return currentContext.workspaceId === request.workspaceId
        && currentContext.conversationId === request.conversationId;
    },
    /**
     * 以重读到的服务端状态为准解锁确认中变更：结束在途变更，返回值
     * 判定重读结果是否仍可应用到界面（同 finishChange 的过期规则）。
     * 只有确认中阶段的变更可经此解锁；重读值本身由调用方应用，本函数
     * 不猜测目标值是否达成——重读值即权威值，无论与目标一致与否都解锁。
     * Dot 0096 后本路径只用于操作记录查不到的回退场景（服务端重启，
     * 在途 PUT 已随旧进程消亡，重读值才是终局权威值）；操作记录还在
     * 时必须走 resolveWithOperation 以操作终结状态裁决。
     */
    resolveWithReread(request: DefaultAgentChangeRequest, currentContext: DefaultAgentChangeContext): boolean {
      const key = keyOf(request);
      const pending = pendingByConversation.get(key);
      if (!pending || pending.request.sequence !== request.sequence || pending.phase !== "confirming") return false;
      pendingByConversation.delete(key);
      return currentContext.workspaceId === request.workspaceId
        && currentContext.conversationId === request.conversationId;
    },
    /**
     * 后续状态刷新已带来该会话的新状态（刷新本身即一次重读）时，解锁
     * 其确认中变更。返回是否确有确认中变更被解锁。Dot 0096 后 App 的
     * 刷新路径不再直接调用本函数解锁（刷新可能带着 PUT 提交前读到的
     * 旧值，凭它解锁会重演单次重读的乱序问题），改为经
     * confirmingRequest 触发操作状态确认；本函数保留为跟踪器原语。
     */
    resolveConfirming(context: DefaultAgentChangeContext): boolean {
      const key = keyOf(context);
      const pending = pendingByConversation.get(key);
      if (!pending || pending.phase !== "confirming") return false;
      pendingByConversation.delete(key);
      return true;
    },
  };
}

export type DefaultAgentChangeTracker = ReturnType<typeof createDefaultAgentChangeTracker>;
