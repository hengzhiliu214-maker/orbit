import type { ChatMessage } from "../shared/types.ts";

/**
 * 指令链面板的实时签名（P2a/P2b，0136 第二节 + Dot 0137 / gobot 0138）。
 *
 * 签名覆盖服务端 `buildConversationGraph` 实际取用的图输入，而不是只看
 * 状态生命周期（旧签名只含 id:runStatus:status:completedAt）：
 *
 * - 每条消息：id / kind / agentId / runId / runStatus / status /
 *   createdAt / startedAt / completedAt
 * - 正文：长度 + 简易散列（同长度替换也能检出）
 * - 图结构：parentMessageId / routeDepth / routeState
 * - 会话状态派生：sessionId；content 长度（段字数派生用）
 * - discarded 标记翻转
 * - plan 当前步（items 格式的 in_progress 步；DTO 的 planCurrentStep
 *   只取这一步，其余格式/条目不进入导图，故不进签名）
 * - 问题台派生：processTimeline（工具结算计数；文本条目按长度+散列）
 * - 员工名 / runtime 映射散列（另见 hashAgentLabels；异步晚到也触发刷新）
 *
 * 有意不含的字段（逐项核对过派生实现，不是漏项）：
 * - activity：问题台与导图都不读它（工具失败只认结算后的
 *   processTimeline 计数；运行中 activity 只在服务端 live 投影里
 *   出现，不进 DTO）。activity 单独变化不改变导图，故不触发刷新；
 *   运行中工具失败要等结算落盘才进图，是既有派生口径。
 * - plan 的 markdown/file 格式内容、非当前步条目：DTO 的
 *   planCurrentStep 只取 items 格式的 in_progress 步，其余不影响导图。
 * - attachments / clientMessageId / interactionMode / approvalMode /
 *   runIndex / agent status：导图派生不读这些字段。
 * - 检查点：不由消息派生，创建/删除走面板 onGraphChanged 手动刷新。
 * - generatedAt：服务端每次请求现生成的时刻，不是图输入。
 *
 * 成本（Dot 0137 反例 a）：逐消息 token 按消息对象身份缓存
 * （WeakMap）；消息对象不变时复用，不随逐字草稿重算——useMemo 依赖
 * 只挂 state.messages / conversationId / 员工映射散列，不挂
 * content/cursor 草稿状态。调用方不得原地修改消息对象后交同一引用
 * （P1 已立禁令）；新对象即重新计 token。
 *
 * 散列局限（Dot 0137 / gobot 0138）：32 位 FNV-1a 简易散列不提供
 * 严格无碰撞保证；面板保留手动刷新按钮兜底。
 */

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash | 0;
}

function hashText(text: string): string {
  return (fnv1a(text) >>> 0).toString(36);
}

/** plan 当前步 token：只有 items 格式的 in_progress 步进入导图。 */
function planCurrentStepToken(plan: ChatMessage["plan"]): string {
  if (!plan || plan.format !== "items") return "-";
  const current = plan.entries.find((entry) => entry.status === "in_progress");
  return current ? hashText(current.content) : "none";
}

/** processTimeline 紧凑 token：问题台只读 tools 条目的结算计数。 */
function processTimelineToken(message: ChatMessage): string {
  const timeline = message.processTimeline;
  if (!timeline || timeline.length === 0) return "-";
  return timeline
    .map((entry) =>
      entry.type === "tools"
        ? `tools:${entry.count}:${entry.failedCount}`
        : `text:${entry.text.length}:${hashText(entry.text)}`,
    )
    .join(",");
}

function computeMessageGraphToken(message: ChatMessage): string {
  return [
    message.id,
    message.kind,
    message.agentId ?? "-",
    message.runId ?? "-",
    message.runStatus ?? "-",
    message.status ?? "-",
    message.createdAt,
    message.startedAt ?? "-",
    message.completedAt ?? "-",
    `${message.content.length}:${hashText(message.content)}`,
    message.parentMessageId ?? "-",
    message.routeDepth ?? "-",
    message.routeState ?? "-",
    message.sessionId ?? "-",
    message.discarded ? "1" : "0",
    planCurrentStepToken(message.plan),
    processTimelineToken(message),
  ].join("|");
}

/** 逐消息 token 缓存：对象身份不变即复用，只对真正变化的消息重算。 */
const messageTokenCache = new WeakMap<ChatMessage, string>();

export function messageGraphToken(message: ChatMessage): string {
  const cached = messageTokenCache.get(message);
  if (cached !== undefined) return cached;
  const token = computeMessageGraphToken(message);
  messageTokenCache.set(message, token);
  return token;
}

/**
 * 员工名 / runtime 映射散列：按 agentId 排序后拼 label:runtime 再散列。
 * 员工改名、runtime 变化、员工增减都会改变散列；异步晚到的标签同样触发。
 */
export function hashAgentLabels(
  agents: ReadonlyMap<string, { label: string; runtime?: string }>,
): string {
  const entries = [...agents.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  let hash = entries.length;
  for (const [id, agent] of entries) {
    const token = `${id}:${agent.label}:${agent.runtime ?? ""};`;
    for (let i = 0; i < token.length; i++) hash = (hash * 31 + token.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

/**
 * 图实时签名：会话 id + 消息 token 序列散列 + 员工映射散列。
 * 只有图输入变化时字符串才变化；面板据此调度刷新。
 */
export function buildGraphLiveSignature(
  messages: readonly ChatMessage[],
  conversationId: string,
  agentLabelsHash: string,
): string {
  let hash = messages.length;
  for (const message of messages) {
    const token = messageGraphToken(message);
    for (let i = 0; i < token.length; i++) hash = (hash * 31 + token.charCodeAt(i)) | 0;
    hash = (hash * 31 + 0x3b) | 0; // 消息间分隔，避免拼接歧义
  }
  return `${conversationId}:${(hash >>> 0).toString(36)}:${agentLabelsHash}`;
}
