import type { AgentId, ChatMessage, ConversationAgentSessions, ConversationGraphSessions, ConversationSessionBlock } from "../shared/types.ts";
import { INTERNAL_SUPERVISOR_ID } from "./agent-profiles.ts";

/** 自首次观测以来的消息投影，受消息保留期（默认 90 天）限制；不读取会话存储。 */
export function emptySessions(enabled: boolean, degraded = false): ConversationGraphSessions {
  return { enabled, ...(degraded ? { degraded: true } : {}), agents: [], hasUnknownIntervals: false };
}

export function buildConversationSessions(input: {
  messages: ChatMessage[];
  agentLabels: ReadonlyMap<AgentId, string>;
  agentRuntimes?: ReadonlyMap<AgentId, string>;
}): ConversationGraphSessions {
  const byId = new Map(input.messages.map((message) => [message.id, message]));
  const nodeIds = new Set(input.messages.filter((message) =>
    message.kind === "user" || (message.kind === "agent" && Boolean(message.runId)),
  ).map((message) => message.id));
  const parentNode = (message: ChatMessage): string | undefined => {
    const visited = new Set([message.id]);
    let current = message.parentMessageId ? byId.get(message.parentMessageId) : undefined;
    while (current) {
      if (visited.has(current.id)) return undefined;
      visited.add(current.id);
      if (nodeIds.has(current.id)) return current.id;
      current = current.parentMessageId ? byId.get(current.parentMessageId) : undefined;
    }
    return undefined;
  };
  const parents = new Map(input.messages.filter((message) => nodeIds.has(message.id)).map((message) => [message.id, parentNode(message)]));
  const userRoot = (message: ChatMessage): string | undefined => {
    let current = nodeIds.has(message.id) ? message.id : parentNode(message);
    const visited = new Set<string>();
    while (current) {
      if (visited.has(current)) break;
      visited.add(current);
      const parent = parents.get(current);
      if (!parent) break;
      current = parent;
    }
    return current && byId.get(current)?.kind === "user" ? current : undefined;
  };

  const sorted = input.messages.filter((message) => message.kind === "agent" && message.agentId)
    .slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const groups = new Map<AgentId, ChatMessage[]>();
  for (const message of sorted) {
    const id = message.agentId!;
    const group = groups.get(id) ?? [];
    group.push(message);
    groups.set(id, group);
  }
  const orderedIds = [...input.agentLabels.keys()].filter((id) => groups.has(id) && id !== INTERNAL_SUPERVISOR_ID);
  for (const id of groups.keys()) {
    if (id !== INTERNAL_SUPERVISOR_ID && !input.agentLabels.has(id)) orderedIds.push(id);
  }
  if (groups.has(INTERNAL_SUPERVISOR_ID)) orderedIds.push(INTERNAL_SUPERVISOR_ID);

  const agents: ConversationAgentSessions[] = orderedIds.map((agentId) => {
    const chunks: ChatMessage[][] = [];
    for (const message of groups.get(agentId)!) {
      const chunk = chunks.at(-1);
      if (chunk && (chunk[0].sessionId || undefined) === (message.sessionId || undefined)) chunk.push(message);
      else chunks.push([message]);
    }
    const firstObserved = new Map<string, string>();
    let segmentCount = 0;
    let switchCount = 0;
    let lastSessionId: string | undefined;
    const blocks: ConversationSessionBlock[] = chunks.map((chunk) => {
      const first = chunk[0];
      const last = chunk[chunk.length - 1];
      const common = { startedAt: first.createdAt, lastActivityAt: last.createdAt, messageCount: chunk.length, charCount: chunk.reduce((sum, message) => sum + message.content.length, 0) };
      if (!first.sessionId) return { type: "unknown", ...common };
      const sessionId = first.sessionId;
      if (!firstObserved.has(sessionId)) firstObserved.set(sessionId, first.createdAt);
      if (lastSessionId && lastSessionId !== sessionId) switchCount++;
      lastSessionId = sessionId;
      const roots = new Set(chunk.map(userRoot).filter((id): id is string => Boolean(id)));
      const runs = new Set(chunk.map((message) => message.runId).filter((id): id is string => Boolean(id)));
      return { type: "segment", index: ++segmentCount, sessionId, sessionShortId: sessionId.slice(0, 8), ...common, firstObservedAt: firstObserved.get(sessionId)!, userTurns: roots.size, runCount: runs.size };
    });
    const segments = blocks.filter((block) => block.type === "segment");
    const unknown = blocks.filter((block) => block.type === "unknown");
    const agentLabel = input.agentLabels.get(agentId);
    const runtime = input.agentRuntimes?.get(agentId);
    // 四项 totals 只累加会话段；未知区间仅计自身字段及 unknownMessageCount。
    return {
      agentId, ...(agentLabel !== undefined ? { agentLabel } : {}), ...(runtime !== undefined ? { runtime } : {}),
      isSupervisor: agentId === INTERNAL_SUPERVISOR_ID, blocks, segmentCount, switchCount,
      distinctSessionCount: firstObserved.size, unknownIntervalCount: unknown.length,
      unknownMessageCount: unknown.reduce((sum, block) => sum + block.messageCount, 0),
      totalUserTurns: segments.reduce((sum, block) => sum + block.userTurns, 0),
      totalRuns: segments.reduce((sum, block) => sum + block.runCount, 0),
      totalMessages: segments.reduce((sum, block) => sum + block.messageCount, 0),
      totalChars: segments.reduce((sum, block) => sum + block.charCount, 0),
    };
  });
  return { enabled: true, agents, hasUnknownIntervals: agents.some((agent) => agent.unknownIntervalCount > 0) };
}
