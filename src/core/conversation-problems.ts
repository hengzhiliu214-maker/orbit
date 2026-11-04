import type {
  ChatMessage,
  ConversationGraphNode,
  ConversationGraphProblemCluster,
  ConversationGraphProblemItem,
  ConversationGraphProblems,
} from "../shared/types.ts";

/**
 * 问题台派生层：从落盘消息字段中抽取「阻碍」条目并按指纹保守判同成簇。
 *
 * 约束（Dot 0106 硬约束，本模块即其实现）：
 * - 纯派生投影：只读输入消息，不修改、不落盘，派生结果不作持久事实；
 * - 文本由确定性代码逐字搬运落盘字段，不摘要、不改写。落盘字段本身在
 *   RunManager 结算时可能已经过汇总/截断（summarizeRunError /
 *   truncateActivity，上限 2000 字），故口径是「与记录一致」，不声称
 *   等同未处理的原始错误；界面文案不得称「原始错误」；
 * - 判同指纹 = 失败阶段 + 错误码（有则用）+ 归一化触发文本。口径保守：
 *   宁少并勿错并——无错误码且归一化触发文本过短/信息不足时保持独立，
 *   绝不按措辞相似合并；
 * - 作业量与响应大小有上限（条目/簇），超限置 truncated 如实标注；
 * - 本模块不调用任何模型，同步纯函数。
 */

export const MAX_PROBLEM_ITEMS = 200;
export const MAX_PROBLEM_CLUSTERS = 50;

/** 失败 run 落盘 content 的固定前缀（RunManager.fail 写入「<label> 运行失败：<summary>」）。 */
const RUN_FAILED_MARKER = " 运行失败：";

export type BuildProblemBoardInput = {
  /** 落盘（含现势投影后）的全部消息，与 buildConversationGraph 同一份输入。 */
  messages: ChatMessage[];
  /** 已整形的图节点（按 messageId 索引阻碍归属）。 */
  nodes: ConversationGraphNode[];
};

export function emptyProblems(enabled: boolean, degraded = false): ConversationGraphProblems {
  return {
    enabled,
    ...(degraded ? { degraded: true } : {}),
    items: [],
    clusters: [],
    totalItems: 0,
    truncated: false,
    dataIncomplete: false,
  };
}

export function buildProblemBoard(input: BuildProblemBoardInput): ConversationGraphProblems {
  const nodesByMessageId = new Map(input.nodes.map((node) => [node.messageId, node]));
  const items: ConversationGraphProblemItem[] = [];

  for (const message of input.messages) {
    if (message.discarded) continue;
    const node = nodesByMessageId.get(message.id);
    if (!node) continue;
    items.push(...extractMessageProblems(message, node));
  }

  items.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const totalItems = items.length;
  const truncatedItems = items.slice(0, MAX_PROBLEM_ITEMS);
  let truncated = totalItems > MAX_PROBLEM_ITEMS;

  const clusters = clusterProblems(truncatedItems);
  let visibleClusters = clusters;
  if (clusters.length > MAX_PROBLEM_CLUSTERS) {
    visibleClusters = clusters.slice(0, MAX_PROBLEM_CLUSTERS);
    truncated = true;
  }

  // 历史数据不完整：任一条目仅有结算摘要，或任一 run 已结算（过程事件
  // 从不落盘，历史回看必然缺 L4 事件层）即如实标注。
  const dataIncomplete =
    truncatedItems.some((item) => item.source === "history-summary") ||
    input.nodes.some((node) => node.kind === "run" && Boolean(node.completedAt));

  return {
    enabled: true,
    items: truncatedItems,
    clusters: visibleClusters,
    totalItems,
    truncated,
    dataIncomplete,
  };
}

/** 从一条节点消息抽取阻碍条目：一个 run 可产出多条（失败本体 + 工具失败计数）。 */
function extractMessageProblems(
  message: ChatMessage,
  node: ConversationGraphNode,
): ConversationGraphProblemItem[] {
  const items: ConversationGraphProblemItem[] = [];
  const base = {
    nodeId: node.id,
    messageId: message.id,
    ...(message.agentId ? { agentId: message.agentId } : {}),
    ...(node.agentLabel ? { agentLabel: node.agentLabel } : {}),
    createdAt: message.createdAt,
    ...(message.completedAt ? { completedAt: message.completedAt } : {}),
  };
  let seq = 0;
  const nextId = () => `${node.id}#problem-${seq++}`;

  if (message.kind === "agent" && message.runStatus === "failed") {
    items.push({
      ...base,
      id: nextId(),
      kind: "run-failed",
      stage: "run",
      ...errorCodeField(extractErrorCode(message.content)),
      // 逐字搬运：剥掉固定的「<label> 运行失败：」前缀后即落盘的错误汇总原文，一字不改。
      text: extractFailedErrorText(message.content),
      source: "record",
    });
  }

  if (message.kind === "agent" && message.runStatus === "cancelled") {
    items.push({
      ...base,
      id: nextId(),
      kind: "run-cancelled",
      stage: "run",
      text: message.content,
      source: "record",
    });
  }

  if (message.routeState === "blocked") {
    items.push({
      ...base,
      id: nextId(),
      kind: "route-blocked",
      stage: "route",
      // 阻断没有独立的错误字段：逐字搬运被阻断消息的落盘正文。
      text: message.content,
      source: "record",
    });
  }

  // 工具失败只有结算计数落盘（过程明细未留存）：按计数生成事实性条目，
  // 明确标 history-summary，不虚构工具名与错误文本。
  for (const entry of message.processTimeline ?? []) {
    if (entry.type === "tools" && entry.failedCount > 0) {
      items.push({
        ...base,
        id: nextId(),
        kind: "tool-failed",
        stage: "tool",
        text: `工具调用共 ${entry.count} 次，其中失败 ${entry.failedCount} 次（过程明细未留存，仅有结算计数）`,
        source: "history-summary",
      });
    }
  }

  return items;
}

/** 落盘 content 形如「<label> 运行失败：<错误汇总>」时取后段；不匹配则整段原文。 */
export function extractFailedErrorText(content: string): string {
  const markerAt = content.indexOf(RUN_FAILED_MARKER);
  if (markerAt >= 0) return content.slice(markerAt + RUN_FAILED_MARKER.length);
  return content;
}

const JSON_RPC_CODE = /(?<![\d-])-\d{4,5}\b/;
const NAMED_CODE = /\b(ENOENT|EACCES|EPERM|ENOTFOUND|ETIMEDOUT|ECONNABORTED|ECONNREFUSED|ECONNRESET|EPIPE|ENOSPC)\b/;
const SNAKE_CODE = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/;
const EXIT_CODE = /exit(?:\s+code)?\s+(-?\d+)\b/i;

/** 错误码抽取（规则）：JSON-RPC 负码 > 系统命名码 > SNAKE_CASE 码 > exit 码。无则 undefined。 */
export function extractErrorCode(text: string): string | undefined {
  const jsonRpc = text.match(JSON_RPC_CODE);
  if (jsonRpc) return jsonRpc[0];
  const named = text.match(NAMED_CODE);
  if (named) return named[0];
  const snake = text.match(SNAKE_CODE);
  if (snake) return snake[0];
  const exit = text.match(EXIT_CODE);
  if (exit) return `exit:${exit[1]}`;
  return undefined;
}

function errorCodeField(code: string | undefined): { errorCode?: string } {
  return code ? { errorCode: code } : {};
}

/**
 * 触发条件归一化：小写、折叠空白、数字与路径掩码。只用于判同指纹，
 * 不回写条目文本（原文保持逐字）。
 */
export function normalizeTrigger(text: string): string {
  return text
    .toLowerCase()
    .replace(/\/[\w.@-]+(?:\/[\w.@-]+)+/g, "<path>")
    .replace(/-?\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

/**
 * 可判同条件（保守）：有错误码，或归一化触发文本足够长（>=16）且非取消类。
 * 取消条目正文是固定短句（如「运行已取消。」），信息不足以判同，保持独立。
 */
function clusterKey(item: ConversationGraphProblemItem): string | null {
  const trigger = normalizeTrigger(item.text);
  const clusterable = Boolean(item.errorCode) || (item.kind !== "run-cancelled" && trigger.length >= 16);
  if (!clusterable) return null;
  return `${item.stage}|${item.errorCode ?? ""}|${trigger}`;
}

function clusterProblems(items: ConversationGraphProblemItem[]): ConversationGraphProblemCluster[] {
  const clusters: ConversationGraphProblemCluster[] = [];
  const byKey = new Map<string, ConversationGraphProblemCluster>();
  for (const item of items) {
    const key = clusterKey(item);
    if (key !== null) {
      const existing = byKey.get(key);
      if (existing) {
        existing.itemIds.push(item.id);
        continue;
      }
      const cluster: ConversationGraphProblemCluster = {
        id: `cluster-${clusters.length}`,
        fingerprint: key,
        kind: item.kind,
        stage: item.stage,
        ...errorCodeField(item.errorCode),
        itemIds: [item.id],
      };
      byKey.set(key, cluster);
      clusters.push(cluster);
    } else {
      clusters.push({
        id: `cluster-${clusters.length}`,
        fingerprint: `single|${item.id}`,
        kind: item.kind,
        stage: item.stage,
        ...errorCodeField(item.errorCode),
        itemIds: [item.id],
      });
    }
  }
  return clusters;
}
