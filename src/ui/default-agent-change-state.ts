/**
 * 默认接收人变更生命周期（Dot 0092 定向复核第 1 项）。
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
 */

export type DefaultAgentChangeContext = {
  workspaceId: string;
  conversationId: string;
};

export type DefaultAgentChangeRequest = DefaultAgentChangeContext & {
  /** 变更序号（单调递增）；响应到达时凭此确认仍是该会话的在途变更。 */
  sequence: number;
};

export function createDefaultAgentChangeTracker() {
  let sequence = 0;
  const pendingByConversation = new Map<string, DefaultAgentChangeRequest>();

  function keyOf(context: DefaultAgentChangeContext): string {
    return `${context.workspaceId}\n${context.conversationId}`;
  }

  return {
    /**
     * 开始一次变更并占用该会话的在途槽位；同一会话已有在途变更时
     * 返回 null（序列化：先等在途变更确认，再接受下一次变更）。
     */
    beginChange(context: DefaultAgentChangeContext): DefaultAgentChangeRequest | null {
      const key = keyOf(context);
      if (pendingByConversation.has(key)) return null;
      const request: DefaultAgentChangeRequest = { ...context, sequence: ++sequence };
      pendingByConversation.set(key, request);
      return request;
    },
    /** 该会话是否有在途变更（渲染态：禁用下拉与发送按钮、展示状态提示）。 */
    isChangePending(context: DefaultAgentChangeContext): boolean {
      return pendingByConversation.has(keyOf(context));
    },
    /**
     * 发送权威拦截：该会话有在途变更时不得发送，避免消息按尚未确认的
     * 旧接收人路由。
     */
    canSend(context: DefaultAgentChangeContext): boolean {
      return !pendingByConversation.has(keyOf(context));
    },
    /**
     * 变更响应（成功或失败）到达：结束对应的在途变更，并判定这份结果
     * 是否仍可应用到界面。仅当序号仍与在途变更一致（未被更新的变更
     * 取代）且当前界面仍停留在发起变更的 workspace/conversation 时
     * 返回 true；迟到、乱序或已切换会话的过期结果返回 false，调用方
     * 必须丢弃（既不回写 conversation，也不在新会话里冒充错误提示）。
     */
    finishChange(request: DefaultAgentChangeRequest, currentContext: DefaultAgentChangeContext): boolean {
      const key = keyOf(request);
      const pending = pendingByConversation.get(key);
      if (!pending || pending.sequence !== request.sequence) return false;
      pendingByConversation.delete(key);
      return currentContext.workspaceId === request.workspaceId
        && currentContext.conversationId === request.conversationId;
    },
  };
}

export type DefaultAgentChangeTracker = ReturnType<typeof createDefaultAgentChangeTracker>;
