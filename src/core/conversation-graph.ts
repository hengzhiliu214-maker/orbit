import type {
  AgentId,
  ChatMessage,
  ConversationGraph,
  ConversationGraphNode,
  ConversationGraphNodeStatus,
  ConversationGraphRoot,
} from "../shared/types.ts";
import { INTERNAL_SUPERVISOR_ID } from "./agent-profiles.ts";
import { assignmentPattern } from "./mention-router.ts";

export type BuildConversationGraphOptions = {
  workspaceId: string;
  conversationId: string;
  messages: ChatMessage[];
  agentLabels: ReadonlyMap<AgentId, string>;
  agentRuntimes?: ReadonlyMap<AgentId, string>;
  now?: Date;
};

/**
 * 把一个会话的落盘消息整形成指令链导图（工作树森林）。
 *
 * 节点只有两类：根用户消息与带 runId 的 agent 执行消息。system 消息不是
 * 节点（它是监工/路由的指令或提示载体），但决定其子运行的 origin：直接父
 * 消息为 system、或父节点的执行者是监工本人时，origin 记 supervisor。
 * 父链上跳过一切非节点消息找最近节点祖先作 parentNodeId；找不到节点祖先
 * 的节点即森林根。discarded 消息整体过滤（前端本来也不渲染）。
 *
 * 数据缺口（如实接受，不造假）：审批未落盘，不成节点；run 过程流不落盘，
 * 历史节点只有结算后的 plan/processTimeline，本函数只取 plan 当前步；
 * 模型名未逐 run 记录，节点只带员工显示名与 runtime。
 */
export function buildConversationGraph(options: BuildConversationGraphOptions): ConversationGraph {
  const now = options.now ?? new Date();
  const visible = options.messages.filter((message) => !message.discarded);
  const messagesById = new Map(visible.map((message) => [message.id, message]));

  const nodeMessages = visible.filter(
    (message) => message.kind === "user" || (message.kind === "agent" && Boolean(message.runId)),
  );
  const nodeIds = new Set(nodeMessages.map((message) => message.id));

  const parentNodeIdById = new Map<string, string | undefined>();
  for (const message of nodeMessages) {
    parentNodeIdById.set(message.id, findParentNodeId(message, messagesById, nodeIds));
  }

  const rootIdById = new Map<string, string>();
  for (const message of nodeMessages) {
    rootIdById.set(message.id, findRootId(message.id, parentNodeIdById));
  }

  const childCountById = new Map<string, number>();
  for (const message of nodeMessages) {
    const parentNodeId = parentNodeIdById.get(message.id);
    if (parentNodeId) childCountById.set(parentNodeId, (childCountById.get(parentNodeId) ?? 0) + 1);
  }

  const nodes: ConversationGraphNode[] = nodeMessages.map((message) => {
    const isRoot = message.kind === "user";
    const status = isRoot ? undefined : runStatus(message);
    const routeState = message.routeState;
    return {
      id: message.id,
      kind: isRoot ? "root" : "run",
      messageId: message.id,
      ...(message.runId ? { runId: message.runId } : {}),
      ...(message.agentId ? { agentId: message.agentId } : {}),
      ...(message.agentId
        ? {
            agentLabel: options.agentLabels.get(message.agentId) ?? message.agentId,
            ...(options.agentRuntimes?.get(message.agentId)
              ? { runtime: options.agentRuntimes.get(message.agentId) }
              : {}),
          }
        : {}),
      origin: isRoot ? "user" : runOrigin(message, messagesById),
      ...(parentNodeIdById.get(message.id) ? { parentNodeId: parentNodeIdById.get(message.id) } : {}),
      rootId: rootIdById.get(message.id) ?? message.id,
      ...(message.routeDepth !== undefined ? { routeDepth: message.routeDepth } : {}),
      ...(routeState ? { routeState } : {}),
      dimmed: routeState === "blocked" || (isRoot && routeState === "ignored"),
      ...(status ? { status } : {}),
      title: nodeTitle(message, options.agentLabels),
      createdAt: message.createdAt,
      ...(message.startedAt ? { startedAt: message.startedAt } : {}),
      ...(message.completedAt ? { completedAt: message.completedAt } : {}),
      ...(status === "running" || status === "cancelling"
        ? { ...(planCurrentStep(message) ? { planCurrentStep: planCurrentStep(message) } : {}) }
        : {}),
      childCount: childCountById.get(message.id) ?? 0,
    };
  });
  const nodesById = new Map(nodes.map((node) => [node.id, node]));

  const edges = nodes.flatMap((node) => {
    if (!node.parentNodeId) return [];
    const source = nodesById.get(node.parentNodeId);
    if (!source) return [];
    return [{
      id: `${node.parentNodeId}->${node.id}`,
      source: node.parentNodeId,
      target: node.id,
      ...(source.routeState ? { routeState: source.routeState } : {}),
      dimmed: node.dimmed || source.routeState === "blocked",
    }];
  });

  const roots: ConversationGraphRoot[] = nodes
    .filter((node) => !node.parentNodeId)
    .map((root) => {
      const members = nodes.filter((node) => node.rootId === root.id);
      const runs = members.filter((node) => node.kind === "run");
      return {
        id: root.id,
        title: root.title,
        createdAt: root.createdAt,
        status: rootStatus(runs),
        nodeCount: members.length,
        latestActivityAt: members
          .flatMap((node) => [node.completedAt, node.startedAt, node.createdAt])
          .filter((value): value is string => Boolean(value))
          .sort()
          .at(-1) ?? root.createdAt,
      };
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  return {
    workspaceId: options.workspaceId,
    conversationId: options.conversationId,
    generatedAt: now.toISOString(),
    roots,
    nodes,
    edges,
  };
}

/** 最近节点祖先：沿 parentMessageId 上溯，跳过 system 等非节点消息。 */
function findParentNodeId(
  message: ChatMessage,
  messagesById: ReadonlyMap<string, ChatMessage>,
  nodeIds: ReadonlySet<string>,
): string | undefined {
  const visited = new Set<string>([message.id]);
  let current = message.parentMessageId ? messagesById.get(message.parentMessageId) : undefined;
  while (current) {
    if (visited.has(current.id)) return undefined;
    visited.add(current.id);
    if (nodeIds.has(current.id)) return current.id;
    current = current.parentMessageId ? messagesById.get(current.parentMessageId) : undefined;
  }
  return undefined;
}

function findRootId(nodeId: string, parentNodeIdById: ReadonlyMap<string, string | undefined>): string {
  const visited = new Set<string>();
  let current = nodeId;
  while (true) {
    if (visited.has(current)) return current;
    visited.add(current);
    const parent = parentNodeIdById.get(current);
    if (!parent) return current;
    current = parent;
  }
}

/**
 * 运行的发起方：看直接父消息——system 消息是监工/路由的指令载体，记
 * supervisor；父节点执行者是监工本人时同样记 supervisor；父消息为 agent
 * 执行记 agent；为用户消息（或父链缺失）记 user。与 RunManager 在源消息
 * kind 上的缺省推导口径一致（supervisor 显式 origin 不落盘，只能如此推导）。
 */
function runOrigin(message: ChatMessage, messagesById: ReadonlyMap<string, ChatMessage>): "user" | "agent" | "supervisor" {
  const parent = message.parentMessageId ? messagesById.get(message.parentMessageId) : undefined;
  if (!parent) return "user";
  if (parent.kind === "system") return "supervisor";
  if (parent.kind === "agent") {
    return parent.agentId === INTERNAL_SUPERVISOR_ID ? "supervisor" : "agent";
  }
  return "user";
}

function runStatus(run: ChatMessage): ConversationGraphNodeStatus {
  if (run.runStatus === "queued") return "queued";
  if (run.runStatus === "cancelling") return "cancelling";
  if (run.runStatus === "running" || !run.completedAt) return "running";
  if (run.runStatus === "failed") return "failed";
  if (run.runStatus === "cancelled") return "cancelled";
  return "completed";
}

function rootStatus(runs: ConversationGraphNode[]): ConversationGraphRoot["status"] {
  if (runs.length === 0) return "idle";
  if (runs.some((run) => run.status === "running" || run.status === "queued" || run.status === "cancelling")) {
    return "running";
  }
  const terminal = runs.filter((run) => run.completedAt);
  const latest = [...terminal].sort((a, b) => (a.completedAt ?? "").localeCompare(b.completedAt ?? "")).at(-1);
  if (latest?.status === "failed") return "failed";
  if (latest?.status === "cancelled") return "cancelled";
  return "completed";
}

function planCurrentStep(message: ChatMessage): string | undefined {
  if (!message.plan || message.plan.format !== "items") return undefined;
  const current = message.plan.entries.find((entry) => entry.status === "in_progress");
  if (!current) return undefined;
  return current.content.length > 60 ? `${current.content.slice(0, 59)}…` : current.content;
}

function nodeTitle(message: ChatMessage, agentLabels: ReadonlyMap<AgentId, string>): string {
  const isPlaceholder = message.kind === "agent"
    && (message.content.endsWith(" is working...") || message.content.endsWith(" queued..."));
  const title = isPlaceholder
    ? ""
    : message.content.replace(assignmentPattern, "").replace(/\s+/g, " ").trim();
  if (title) return title.length > 80 ? `${title.slice(0, 79)}…` : title;
  if (message.kind === "user") return "未命名任务";
  if (message.agentId) return agentLabels.get(message.agentId) ?? message.agentId;
  return "执行";
}
