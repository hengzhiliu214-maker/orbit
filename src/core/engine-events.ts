import fs from "node:fs";
import path from "node:path";

import { parsePositiveIntEnv } from "./history-retention.ts";
import type {
  ConversationAgentCompaction,
  ConversationAgentSessions,
  ConversationCompactionCoverage,
  ConversationCompactionSegment,
} from "../shared/types.ts";

/**
 * 引擎事件旁路记录（会话压缩可见性第三步试点，仅 CodeBuddy）。
 *
 * CodeBuddy 的上下文压缩在 ACP 通道上没有独立事件：压缩摘要以
 * `agent_message_chunk` 形式出现，靠 `_meta["codebuddy.ai/isCompactInternal"]
 * ===true` 区分，主链分类为 ignore 并丢弃。本模块把「观测到标记」这一事实以
 * 元数据形式落到会话目录内的 append-only 文件 engine-events.ndjson（与
 * messages/ 同级），供会话状态派生只读消费。
 *
 * 口径红线（Dot 0128 评审）：这里记录的只是「已观测到的压缩标记」，不是引擎
 * 报告的压缩事件——没有稳定事件身份、也没有开始/结束语义，因此任何上层
 * 呈现都不得称其为精确的「压缩次数」。同一 (agentId, sessionId, runId) 内
 * 相邻标记 chunk 按突发间隔合并为一个「标记段」，这只是观测分组。
 *
 * 留存口径（明确写定，不从消息留存推定）：事件文件本身不做物理删除；派生
 * 读取时按 observedAt 排除与会话消息相同的留存窗口（ORBIT_HISTORY_RETAIN_DAYS，
 * 默认 90 天）之外的事件，并在覆盖信息中以 retentionExcluded 标明。
 */

export const ENGINE_EVENTS_FILE = "engine-events.ndjson";
export const ENGINE_EVENTS_SCHEMA_VERSION = 1;

/** 标记段合并的突发间隔：同键相邻 chunk 间隔不超过此值视为同一段。 */
export const COMPACTION_BURST_GAP_MS = 15_000;

/** 本试点唯一接入的引擎。 */
export const COMPACTION_PILOT_RUNTIME = "codebuddy";

export type EngineEvent = {
  kind: "compaction_marker" | "coverage_start";
  runtime: string;
  agentId?: string;
  runId?: string;
  sessionId?: string;
  messageId?: string;
  observedAt: string;
  schemaVersion: number;
};

export function engineEventsPath(conversationDir: string): string {
  return path.join(conversationDir, ENGINE_EVENTS_FILE);
}

/**
 * 试点捕获开关：逐引擎开启，默认全关。ORBIT_COMPACTION_CAPTURE 为逗号分隔的
 * runtime 列表（如 "codebuddy"）。服务端强制：关时不写、不读、DTO 不变。
 */
export function compactionCaptureEnabled(runtime: string = COMPACTION_PILOT_RUNTIME): boolean {
  const raw = process.env.ORBIT_COMPACTION_CAPTURE;
  if (!raw) return false;
  return raw.split(",").map((entry) => entry.trim()).filter(Boolean).includes(runtime);
}

/** 与会话消息相同的留存窗口（天）。派生读取时按 observedAt 排除窗口外事件。 */
export function engineEventRetentionDays(): number {
  return parsePositiveIntEnv("ORBIT_HISTORY_RETAIN_DAYS", 90);
}

/** 追加一条事件。同步 append-only 写入；IO 失败抛给调用方，调用方只置降级、绝不伤主链。 */
export function appendEngineEvent(conversationDir: string, event: EngineEvent): void {
  fs.mkdirSync(conversationDir, { recursive: true });
  fs.appendFileSync(engineEventsPath(conversationDir), `${JSON.stringify(event)}\n`, "utf8");
}

export type EngineEventsRead = {
  exists: boolean;
  events: EngineEvent[];
  /** 无法解析或结构不合法的行数（含被截断的部分尾行）；>0 即覆盖降级。 */
  badLines: number;
  degraded: boolean;
};

function isEngineEvent(value: unknown): value is EngineEvent {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.kind !== "compaction_marker" && record.kind !== "coverage_start") return false;
  if (typeof record.runtime !== "string" || !record.runtime) return false;
  if (typeof record.observedAt !== "string" || !record.observedAt) return false;
  if (typeof record.schemaVersion !== "number") return false;
  return true;
}

/** 容忍坏行与部分尾行的读取：坏记录只计数并置 degraded，绝不抛给只读视图。 */
export function readEngineEvents(conversationDir: string): EngineEventsRead {
  const file = engineEventsPath(conversationDir);
  if (!fs.existsSync(file)) return { exists: false, events: [], badLines: 0, degraded: false };
  const raw = fs.readFileSync(file, "utf8");
  const events: EngineEvent[] = [];
  let badLines = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isEngineEvent(parsed)) events.push(parsed);
      else badLines += 1;
    } catch {
      badLines += 1;
    }
  }
  return { exists: true, events, badLines, degraded: badLines > 0 };
}

type MarkerSegmentDraft = {
  agentId: string;
  sessionId?: string;
  runId?: string;
  startedAt: string;
  endedAt: string;
  chunkCount: number;
};

/** 把标记事件按 (agentId, sessionId, runId) 分组、按突发间隔切段。 */
export function groupMarkerSegments(events: readonly EngineEvent[]): MarkerSegmentDraft[] {
  const markers = events
    .filter((event) => event.kind === "compaction_marker")
    .slice()
    .sort((a, b) => a.observedAt.localeCompare(b.observedAt));
  const segments: MarkerSegmentDraft[] = [];
  for (const marker of markers) {
    const agentId = marker.agentId ?? "";
    const last = segments[segments.length - 1];
    const sameKey = last
      && last.agentId === agentId
      && last.sessionId === marker.sessionId
      && last.runId === marker.runId;
    const gapMs = last ? Date.parse(marker.observedAt) - Date.parse(last.endedAt) : Number.NaN;
    if (sameKey && Number.isFinite(gapMs) && gapMs <= COMPACTION_BURST_GAP_MS) {
      last.endedAt = marker.observedAt;
      last.chunkCount += 1;
      continue;
    }
    segments.push({
      agentId,
      ...(marker.sessionId ? { sessionId: marker.sessionId } : {}),
      ...(marker.runId ? { runId: marker.runId } : {}),
      startedAt: marker.observedAt,
      endedAt: marker.observedAt,
      chunkCount: 1,
    });
  }
  return segments;
}

export type CompactionDerivation = {
  coverage: ConversationCompactionCoverage;
  /** agentId → 该员工的已观测压缩标记视图（仅有标记段的员工出现）。 */
  byAgent: Map<string, ConversationAgentCompaction>;
};

/**
 * 由引擎事件 + 第一步会话段派生「已观测压缩标记」视图。
 * 归段口径：标记段 sessionId 与会话段 sessionId 相同、且标记段起始时刻落在
 * 会话段 [startedAt, lastActivityAt] 窗口内时才归段；命中不唯一（零个或多个）
 * 一律计未归段，不猜测。
 */
export function buildCompactionDerivation(args: {
  read: EngineEventsRead;
  agents: readonly ConversationAgentSessions[];
  now?: Date;
}): CompactionDerivation {
  const now = args.now ?? new Date();
  const retentionDays = engineEventRetentionDays();
  const cutoffMs = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
  const retained: EngineEvent[] = [];
  let retentionExcluded = false;
  for (const event of args.read.events) {
    if (Date.parse(event.observedAt) < cutoffMs) {
      retentionExcluded = true;
      continue;
    }
    retained.push(event);
  }

  const starts = retained
    .filter((event) => event.kind === "coverage_start")
    .map((event) => event.observedAt)
    .sort();
  const sortedRetained = retained.slice().sort((a, b) => a.observedAt.localeCompare(b.observedAt));
  const lastObservedAt = sortedRetained.length ? sortedRetained[sortedRetained.length - 1]!.observedAt : undefined;
  const intervals = starts.map((from, index) => {
    const nextStart = starts[index + 1];
    const to = nextStart ?? (lastObservedAt && lastObservedAt > from ? lastObservedAt : from);
    return { from, to };
  });

  const coverage: ConversationCompactionCoverage = {
    intervals,
    degraded: args.read.degraded,
    retentionExcluded,
    retentionDays,
  };

  const drafts = groupMarkerSegments(retained);
  const byAgent = new Map<string, ConversationAgentCompaction>();
  for (const draft of drafts) {
    const agent = args.agents.find((entry) => entry.agentId === draft.agentId);
    let assignedIndex: number | undefined;
    if (agent && draft.sessionId) {
      const matches = agent.blocks.filter((block) =>
        block.type === "segment"
        && block.sessionId === draft.sessionId
        && draft.startedAt >= block.startedAt
        && draft.startedAt <= block.lastActivityAt);
      if (matches.length === 1) assignedIndex = (matches[0] as { index: number }).index;
    }
    const segment: ConversationCompactionSegment = {
      ...(draft.sessionId ? { sessionId: draft.sessionId } : {}),
      ...(draft.runId ? { runId: draft.runId } : {}),
      startedAt: draft.startedAt,
      endedAt: draft.endedAt,
      chunkCount: draft.chunkCount,
      assigned: assignedIndex !== undefined,
      ...(assignedIndex !== undefined ? { segmentIndex: assignedIndex } : {}),
    };
    const view = byAgent.get(draft.agentId) ?? { markerSegmentCount: 0, unassignedSegmentCount: 0, segments: [] };
    view.markerSegmentCount += 1;
    if (!segment.assigned) view.unassignedSegmentCount += 1;
    view.segments.push(segment);
    byAgent.set(draft.agentId, view);
  }
  return { coverage, byAgent };
}
