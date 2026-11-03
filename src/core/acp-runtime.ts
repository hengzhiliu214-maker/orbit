import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";

import {
  PROTOCOL_VERSION,
  client,
  methods,
  ndJsonStream,
  type AgentCapabilities,
  type AvailableCommand,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
  type ContentBlock,
  type ClientConnection,
  type InitializeRequest,
  type InitializeResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type ResumeSessionRequest,
  type ResumeSessionResponse,
  type SessionConfigOption,
  type SessionConfigSelectOptions,
  type SessionNotification,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type ToolCallStatus,
  type ToolKind,
} from "@agentclientprotocol/sdk";

import type {
  AgentActivityEvent,
  AgentCommand,
  AgentElicitationRequest,
  AgentId,
  AgentModelChoice,
  AgentModelStateSnapshot,
  AgentReasoningStateSnapshot,
  AgentRuntimeKind,
  MessageAttachment,
} from "../shared/types.ts";
import { AgentRunCancelledError, type AgentRuntime, type AgentRuntimeRunHandle, type AgentRuntimeRunOptions } from "./agent-runtime.ts";
import { interruptProcessTree } from "./process-tree.ts";
import { extractReadableText } from "./ansi-text-extractor.ts";
import {
  AcpStderrForwarder,
  createAcpFrameLimitTransform,
} from "./acp-output-guard.ts";
import { AcpConnectionPool } from "./acp-connection-pool.ts";

/**
 * 取消宽限期：interrupt 先发 session/cancel 优雅取消；超过该时限仍未结算的
 * 回合强制销毁连接并收口结果，避免运行永久停留在取消中（issue #136）。
 */
export const CANCEL_GRACE_MS = 10_000;

export type AcpRunOptions = AgentRuntimeRunOptions;

export type AcpConnection = {
  readonly pid: number;
  initialize(request: InitializeRequest): Promise<InitializeResponse>;
  newSession(request: NewSessionRequest): Promise<NewSessionResponse>;
  loadSession(request: LoadSessionRequest): Promise<LoadSessionResponse>;
  resumeSession(request: ResumeSessionRequest): Promise<ResumeSessionResponse>;
  setConfigOption(request: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse>;
  /**
   * 可选：legacy session/set_model（Codex 变体模型专用）。连接未实现时
   * 为 undefined，调用方必须明确提示而不是回退到 config option 下发。
   */
  setModel?(request: { sessionId: string; modelId: string }): Promise<void>;
  prompt(request: PromptRequest): Promise<PromptResponse>;
  cancel(sessionId: string): Promise<void>;
  hasSession?(sessionId: string): boolean;
  /**
   * 可选：连接世代信息（Dot 0094）。connectionGeneration 是本连接（底层
   * agent 进程）在连接池内的世代序号；sessionGeneration 返回某会话由
   * 哪个世代的连接创建/持有，查不到表示该会话创建于本进程启动之前
   * （绑定从磁盘恢复、创建进程已不存在）。非池化连接可不提供，此时
   * 世代关系不可判定，恢复分类按保守口径处理。
   */
  connectionGeneration?: number;
  sessionGeneration?(sessionId: string): number | undefined;
  close(): void;
  destroy?(): void;
};

export type AcpReusableConnection = AcpConnection & {
  rebind(
    options: AcpRunOptions,
    onSessionUpdate: (notification: SessionNotification) => void,
  ): void;
  deactivate(): void;
  isAlive(): boolean;
};

export type AcpConnector = (
  options: AcpRunOptions,
  onSessionUpdate: (notification: SessionNotification) => void,
) => AcpConnection;

export type AcpCommand = {
  file: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
};

export type AcpAnswerChunkDisposition = "candidate" | "final" | "progress" | "ignore";

/**
 * 每回合共享的分类状态。部分 runtime（如 CodeBuddy）在一个回合内复用同一个
 * ACP messageId 输出多段模型响应，需要靠会话级信号（agentPhase）划分响应边界，
 * 用响应序号代替 messageId 作为 answer 分组键。
 */
export type AcpTurnState = {
  /** 当前分片所处的模型响应序号；runtime 通过 observeSessionUpdate 递增。 */
  modelResponseIndex: number;
  /** 是否处于一次模型响应中（用于去重递增，避免 requesting→streaming 重复计数）。 */
  inModelResponse: boolean;
  /** 池化会话复用时，在 runtime 给出当前回合响应边界前暂存可疑回放。 */
  awaitingResponseBoundary: boolean;
  /** runtime 明确报告的历史回放窗口内（如 CodeBuddy 的 historyReplay start→end）。 */
  inHistoryReplay: boolean;
};

/** 工具调用帧（tool_call / tool_call_update）的收窄类型。 */
export type AcpToolCallUpdate = Extract<
  SessionNotification["update"],
  { sessionUpdate: "tool_call" | "tool_call_update" }
>;

export type AcpRuntimeDefinition = {
  kind: AgentRuntimeKind;
  displayName: string;
  buildCommand: (env?: NodeJS.ProcessEnv) => AcpCommand;
  agentIdEnvNames?: string[];
  toolNameMetaKeys?: string[];
  envForRun?: (options: AcpRunOptions) => NodeJS.ProcessEnv;
  isDiagnosticMessage?: (update: SessionNotification["update"]) => boolean;
  classifyAnswerChunk?: (update: SessionNotification["update"]) => AcpAnswerChunkDisposition | undefined;
  /** 观察所有会话级更新帧，维护 runtime 特定的回合状态（如 CodeBuddy agentPhase 响应边界）。 */
  observeSessionUpdate?: (update: SessionNotification["update"], turn: AcpTurnState) => void;
  /**
   * 解析 answer 分片的分组键；默认使用 ACP messageId。最终答案取"最后一个有内容的组"，
   * 其余组的文本在结算时归入过程文本（process.text 快照）。
   */
  answerGroupKey?: (update: SessionNotification["update"], turn: AcpTurnState) => string | undefined;
  /**
   * 池化连接直接复用已加载 session 时，先缓冲响应边界前的文本。runtime 一旦
   * 发出新的模型响应边界就丢弃缓冲，避免把上一轮回放算作当前答案。
   */
  guardPooledSessionReplay?: boolean;
  /**
   * 判定该会话更新是否属于 runtime 的历史回放（issue #172）。
   *
   * 命中时共享层在推进任何回合状态、发出任何事件之前整帧丢弃，因此回放的
   * 正文、过程叙述、工具帧与计划帧都不会进入实时活动、最终正文或持久化时间线。
   * 这比按到达顺序推断可靠：回放可能落在当前轮首个模型边界之前或之后。
   *
   * 收到 notification 而非 update，便于 runtime 同时检查两级 `_meta`（CodeBuddy
   * 把回放标记写在 update._meta 上，并镜像到通知级 _meta）。实现可以在 turn 上
   * 维护回放窗口状态（如 historyReplay 的 start/end 区间）。
   */
  isReplayedUpdate?: (notification: SessionNotification, turn: AcpTurnState) => boolean;
  /**
   * 工具成功完成后的 runtime 专属投影（issue #161）。共享层先发出原
   * tool.completed，再调用该钩子并发出其返回的活动，保持事件顺序；返回
   * undefined 表示本次完成不投影（工具不在投影范围或数据不完整——消费方
   * 必须保留既有状态，不得清空）。
   */
  projectToolCompletion?: (update: AcpToolCallUpdate) => AgentActivityEvent | undefined;
};

const acpConnectionPool = new AcpConnectionPool(spawnAcpConnection);

export function disposeAcpConnectionPool(): void {
  acpConnectionPool.dispose();
}

function pooledAcpConnector(
  definition: AcpRuntimeDefinition,
  options: AcpRunOptions,
  onSessionUpdate: (notification: SessionNotification) => void,
): AcpConnection {
  return acpConnectionPool.acquire(definition, options, onSessionUpdate);
}

type ToolState = {
  name: string;
  status?: ToolCallStatus | null;
  contentSummary?: string;
  rawSummary?: string;
};

type AnswerMessage = {
  candidateParts: string[];
  finalParts: string[];
};

type AnswerSegmentKind = "answer" | "progress";

/** 按到达顺序记录的文本分片，用于结算时生成"剔除最终回复正文后"的过程文本快照。 */
type AnswerSegment = {
  group: string;
  kind: AnswerSegmentKind;
  text: string;
};

type AnswerState = {
  messages: Map<string, AnswerMessage>;
  order: string[];
  unscopedCandidateParts: string[];
  unscopedFinalParts: string[];
  segments: AnswerSegment[];
  deferredChunks: DeferredAnswerChunk[];
};

type AgentTextUpdate = Extract<SessionNotification["update"], { sessionUpdate: "agent_message_chunk" }> & {
  content: { type: "text"; text: string };
};

type DeferredAnswerChunk = {
  update: AgentTextUpdate;
  disposition: Exclude<AcpAnswerChunkDisposition, "ignore">;
};

export function createAcpRuntime(
  definition: AcpRuntimeDefinition,
  connector: AcpConnector = (options, onSessionUpdate) => pooledAcpConnector(definition, options, onSessionUpdate),
): AgentRuntime {
  return {
    kind: definition.kind,
    transport: "acp",
    protocolVersion: PROTOCOL_VERSION,
    run: (options) => runAcp(options, definition, connector),
  };
}

export function runAcp(
  options: AcpRunOptions,
  definition: AcpRuntimeDefinition,
  connector: AcpConnector = (runOptions, onSessionUpdate) => pooledAcpConnector(definition, runOptions, onSessionUpdate),
): AgentRuntimeRunHandle {
  let acceptingUpdates = false;
  let activeSessionId: string | null = null;
  let cancelled = false;
  let permissionRejected = false;
  let closed = false;
  let forcedCancelled = false;
  let cancelTimer: NodeJS.Timeout | null = null;
  const answerState = createAnswerState();
  const turnState = createTurnState();
  const toolStates = new Map<string, ToolState>();

  const connectorOptions: AcpRunOptions = {
    ...options,
    requestPermission: options.requestPermission
      ? async (request) => {
        const decision = await options.requestPermission!(request);
        if (decision === "reject") permissionRejected = true;
        return decision;
      }
      : undefined,
  };
  // 会话建立窗口期（session/new 请求已发出、响应未返回）通告的斜杠命令快照
  // （issue #160）：activeSessionId 尚未落定，先按会话暂存最新一帧，落定后交付。
  const pendingCommands = new Map<string, SessionNotification>();
  const flushPendingCommands = (sessionId: string) => {
    const pending = pendingCommands.get(sessionId);
    if (!pending) return;
    pendingCommands.delete(sessionId);
    handleSessionUpdate(pending, answerState, turnState, toolStates, options, definition);
  };
  const handleSessionUpdateNotification = (notification: SessionNotification) => {
    if (notification.sessionId !== activeSessionId) {
      // 命令快照在窗口期也要保留；其余会话更新照旧丢弃。
      if (!acceptingUpdates && notification.update.sessionUpdate === "available_commands_update") {
        pendingCommands.set(notification.sessionId, notification);
      }
      return;
    }
    // 斜杠命令通告不依赖回合门（issue #160）：prompt 尚未发出时 runtime 也可能
    // 推送 available_commands_update；会话 ID 匹配即接收，其余更新维持原门控。
    if (!acceptingUpdates && notification.update.sessionUpdate !== "available_commands_update") {
      return;
    }
    handleSessionUpdate(notification, answerState, turnState, toolStates, options, definition);
  };
  // 重试恢复（issue #141）会销毁坏连接并重新 acquire，connection 必须可替换；
  // close/interrupt 等闭包读取该变量，始终作用于当前连接。
  let connection = connector(connectorOptions, handleSessionUpdateNotification);

  let resolveSessionId!: (sessionId: string | null) => void;
  let sessionIdSettled = false;
  const sessionId = new Promise<string | null>((resolve) => {
    resolveSessionId = (value) => {
      if (sessionIdSettled) return;
      sessionIdSettled = true;
      resolve(value);
    };
  });

  // 强制取消收口（issue #136）：runtime 无视 session/cancel 且底层 prompt 永不
  // 结算时，由该 Promise 结束 handle.result，运行不会永久停留在取消中。
  let rejectForcedCancel!: (error: AgentRunCancelledError) => void;
  const forcedCancellation = new Promise<never>((_resolve, reject) => {
    rejectForcedCancel = reject;
  });
  void forcedCancellation.catch(() => undefined);

  const close = (destroy = false) => {
    if (closed) return;
    closed = true;
    if (cancelTimer) clearTimeout(cancelTimer);
    pendingCommands.clear();
    if (destroy) connection.destroy?.();
    else connection.close();
  };

  const cancellationError = () => new AgentRunCancelledError(
    `${definition.displayName} ACP turn was cancelled.`,
    permissionRejected ? "权限申请未获批准，任务已停止。" : "运行已取消。",
  );

  /**
   * 强制收口：先落定 sessionId（AgentSession 的异常路径会 await 它，不能再次
   * 无限等待）、停止接受晚到的会话更新、销毁连接终止进程，最后让 handle.result
   * 以取消错误结束。
   */
  const forceCancel = (diagnostic: string) => {
    if (forcedCancelled || closed) return;
    forcedCancelled = true;
    cancelled = true;
    acceptingUpdates = false;
    if (cancelTimer) {
      clearTimeout(cancelTimer);
      cancelTimer = null;
    }
    resolveSessionId(activeSessionId);
    options.onOutput?.(`${definition.displayName} ${diagnostic}。`);
    close(true);
    rejectForcedCancel(new AgentRunCancelledError(
      `${definition.displayName} ACP turn was force-cancelled: ${diagnostic}`,
      permissionRejected ? "权限申请未获批准，任务已停止。" : "运行已取消。",
    ));
  };

  const turn = (async () => {
    let succeeded = false;
    const initializeRequest = createAcpInitializeRequest();
    try {
      const initialized = await connection.initialize(initializeRequest);
      validateInitializeResponse(initialized, definition.displayName);

      const session = await restoreOrRecoverSession(
        connection,
        options,
        definition,
        initialized.agentCapabilities,
        initializeRequest,
        () => {
          connection.destroy?.();
          connection = connector(connectorOptions, handleSessionUpdateNotification);
          return connection;
        },
      );
      activeSessionId = session.sessionId;
      turnState.awaitingResponseBoundary = Boolean(
        definition.guardPooledSessionReplay && session.reusedConnectionSession,
      );
      resolveSessionId(activeSessionId);
      // 窗口期通告的命令快照现在可以安全交付（会话 ID 已匹配）。
      flushPendingCommands(activeSessionId);

      // 会话建立后、prompt 前：先回调模型快照，再尽力应用员工首选模型
      // （issue #142）。切换失败只输出过程提示，绝不让运行失败。
      if (!cancelled && !forcedCancelled) {
        await applyPreferredModel(connection, activeSessionId, options, definition, session.configOptions, session.models);
      }
      // Cancellation may arrive while applying the preferred model. Do not
      // start a prompt after the turn has already entered cancellation.
      if (cancelled || forcedCancelled) {
        throw cancellationError();
      }

      acceptingUpdates = !forcedCancelled;
      let response: Awaited<ReturnType<AcpConnection["prompt"]>>;
      try {
        response = await connection.prompt({
          sessionId: activeSessionId,
          prompt: buildPromptContent(options.prompt, options.attachments, initialized.agentCapabilities),
        });
      } catch (error) {
        throw normalizePromptError(error, definition.displayName, options.attachments);
      }
      acceptingUpdates = false;

      if (cancelled || response.stopReason === "cancelled") {
        throw cancellationError();
      }
      if (response.stopReason === "refusal") {
        throw new Error(
          `${definition.displayName} ACP refused the request. 建议：请切换到其他可用模型后重试。`,
        );
      }

      // 旧版 CodeBuddy 不提供 agentPhase。只有 prompt 正常结算且始终没有边界
      // 时才接纳缓冲文本；异常、取消或拒绝路径绝不会把历史回放当成本轮答案。
      flushDeferredAnswerChunks(answerState, turnState, options, definition);

      const selection = selectFinalAnswer(answerState);
      const answer = selection.text.trim();
      if (!answer) {
        throw new Error(`${definition.displayName} ACP completed with ${response.stopReason} but no final answer.`);
      }
      const providerError = normalizeProviderAnswer(answer, definition.displayName);
      if (providerError) throw providerError;
      // 结算快照：流式期间所有文本（含将成为最终回复的文本）都以增量形式进入
      // 过程区；结算时剔除归入最终回复的分组文本，整体替换，保证不重复、不残留。
      emitProcessTextSnapshot(options, answerState, selection.group);
      succeeded = true;
      return answer;
    } catch (error: unknown) {
      // Cancellation can happen during initialize/session setup, before the
      // prompt response has a chance to report stopReason=cancelled.
      if (cancelled) throw cancellationError();
      throw error;
    } finally {
      acceptingUpdates = false;
      resolveSessionId(activeSessionId);
      close(!succeeded);
    }
  })();
  // 与正常回合竞速：强制收口时即使底层 prompt 永不结算，handle.result 也落定。
  const result: Promise<string> = Promise.race([turn, forcedCancellation]);

  const interrupt = () => {
    if (cancelled || closed) return;
    cancelled = true;
    if (!activeSessionId) {
      forceCancel("会话尚未建立，已强制终止进程");
      return;
    }

    // 先尝试优雅取消；请求失败或宽限期超时都立即强制收口。
    void connection.cancel(activeSessionId).catch(() => forceCancel("取消请求失败，已强制终止进程"));
    cancelTimer = setTimeout(
      () => forceCancel(`未在 ${CANCEL_GRACE_MS / 1000} 秒内响应取消，已强制终止进程`),
      CANCEL_GRACE_MS,
    );
    cancelTimer.unref?.();
  };

  return {
    process: {
      kill: close,
      pid: connection.pid,
      interrupt,
    },
    result,
    sessionId,
  };
}

const MODEL_PROBE_TIMEOUT_MS = 15_000;

/**
 * 在不发送 prompt 的前提下读取 runtime 的模型配置。设置面板首次打开时使用，
 * 连接和临时 session 都会在读取完成后销毁，不会写入员工的会话记录。
 */
export async function probeAcpModelState(
  definition: AcpRuntimeDefinition,
  options: Pick<AcpRunOptions, "agentId" | "cwd" | "env">,
  connector: AcpConnector = (runOptions, onSessionUpdate) =>
    spawnAcpConnection(definition, runOptions, onSessionUpdate),
): Promise<AgentModelStateSnapshot | null> {
  const probeOptions: AcpRunOptions = {
    ...options,
    prompt: "",
    approvalMode: "full-access",
  };
  let connection: AcpConnection | undefined;
  let timeout: NodeJS.Timeout | undefined;
  try {
    const probe = (async () => {
      connection = connector(probeOptions, () => {});
      const initialized = await connection.initialize(createAcpInitializeRequest());
      validateInitializeResponse(initialized, definition.displayName);
      const created = await connection.newSession({
        cwd: path.resolve(probeOptions.cwd),
        mcpServers: [],
      });
      return toModelSnapshot(created.configOptions, probeOptions, definition, "probe", legacyModelStateOf(created));
    })();
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(
        () => reject(new Error(`${definition.displayName} model discovery timed out.`)),
        MODEL_PROBE_TIMEOUT_MS,
      );
      timeout.unref?.();
    });
    return await Promise.race([probe, deadline]);
  } finally {
    if (timeout) clearTimeout(timeout);
    connection?.destroy?.();
  }
}

const COMMAND_PROBE_TIMEOUT_MS = 15_000;
const COMMAND_PROBE_ANNOUNCE_GRACE_MS = 1_500;

/**
 * 在不发送 prompt 的前提下获取 runtime 会话通告的斜杠命令（issue #160）。
 * “输入 / 却毫无反应”的冷启动缺口（issue #160 收尾）：ACP 没有独立的命令
 * 列表请求，命令由会话在建立时通过 `available_commands_update` 推送，因此
 * 探测路径与模型探测一致——临时连接 + 临时 session，读取完成后销毁，不写入
 * 员工的会话记录。通告可能在 session/new 响应前后到达，会话创建后再等一个
 * 短宽限窗口；runtime 完全不通告时返回空数组（无法与“会话没有命令”区分，
 * UI 统一按“没有可用命令”展示）。
 */
export async function probeAcpCommands(
  definition: AcpRuntimeDefinition,
  options: Pick<AcpRunOptions, "agentId" | "cwd" | "env">,
  connector: AcpConnector = (runOptions, onSessionUpdate) =>
    spawnAcpConnection(definition, runOptions, onSessionUpdate),
  timing: { timeoutMs?: number; announceGraceMs?: number } = {},
): Promise<AgentCommand[]> {
  const timeoutMs = timing.timeoutMs ?? COMMAND_PROBE_TIMEOUT_MS;
  const graceMs = timing.announceGraceMs ?? COMMAND_PROBE_ANNOUNCE_GRACE_MS;
  const probeOptions: AcpRunOptions = {
    ...options,
    prompt: "",
    approvalMode: "full-access",
  };
  let connection: AcpConnection | undefined;
  let timeout: NodeJS.Timeout | undefined;
  let graceTimer: NodeJS.Timeout | undefined;
  try {
    const probe = (async () => {
      // 用属性容器规避闭包赋值的窄化问题；只保留最新一帧通告。
      const found: { latest: AgentCommand[] | null } = { latest: null };
      let notifyAnnounced: () => void = () => {};
      const announcedOnce = new Promise<void>((resolve) => {
        notifyAnnounced = resolve;
      });
      connection = connector(probeOptions, (notification) => {
        if (notification.update.sessionUpdate !== "available_commands_update") return;
        const raw = notification.update.availableCommands;
        found.latest = toAgentCommands(Array.isArray(raw) ? raw : []);
        notifyAnnounced();
      });
      const initialized = await connection.initialize(createAcpInitializeRequest());
      validateInitializeResponse(initialized, definition.displayName);
      await connection.newSession({
        cwd: path.resolve(probeOptions.cwd),
        mcpServers: [],
      });
      if (found.latest === null) {
        const grace = new Promise<void>((resolve) => {
          graceTimer = setTimeout(resolve, graceMs);
          graceTimer.unref?.();
        });
        await Promise.race([announcedOnce, grace]);
      }
      return found.latest ?? [];
    })();
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(
        () => reject(new Error(`${definition.displayName} slash-command discovery timed out.`)),
        timeoutMs,
      );
      timeout.unref?.();
    });
    return await Promise.race([probe, deadline]);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (graceTimer) clearTimeout(graceTimer);
    connection?.destroy?.();
  }
}

/** 会话建立结果：sessionId 加上本次建立路径拿到的 config options 快照。 */
export type AcpSessionSetup = {
  sessionId: string;
  configOptions: Array<SessionConfigOption> | null | undefined;
  reusedConnectionSession: boolean;
  /** legacy models 状态（Codex 变体）；适配器未返回时为 undefined。 */
  models?: AcpLegacyModelState;
};

/**
 * legacy ACP models 状态（session/new、load、resume 响应里的非标准字段，
 * codex-acp 返回）：availableModels 是带思考强度的变体 modelId 清单，
 * 只能原样使用、不拼造；configOptions 的 model 只有基础 id，变体经
 * set_config_option 下发会被适配器拒绝（实测 -32602）。
 */
export type AcpLegacyModelState = {
  availableModels: Array<{ modelId: string; name?: string }>;
  currentModelId?: string;
};

export function legacyModelStateOf(response: unknown): AcpLegacyModelState | undefined {
  if (!response || typeof response !== "object") return undefined;
  const models = (response as { models?: unknown }).models;
  if (!models || typeof models !== "object") return undefined;
  const available = (models as { availableModels?: unknown }).availableModels;
  if (!Array.isArray(available)) return undefined;
  const list: Array<{ modelId: string; name?: string }> = [];
  for (const entry of available) {
    if (!entry || typeof entry !== "object") continue;
    const modelId = (entry as { modelId?: unknown }).modelId;
    if (typeof modelId !== "string" || !modelId) continue;
    const name = (entry as { name?: unknown }).name;
    list.push({ modelId, ...(typeof name === "string" && name ? { name } : {}) });
  }
  if (list.length === 0) return undefined;
  const current = (models as { currentModelId?: unknown }).currentModelId;
  return { availableModels: list, ...(typeof current === "string" && current ? { currentModelId: current } : {}) };
}

async function prepareSession(
  connection: AcpConnection,
  capabilities: AgentCapabilities | undefined,
  cwd: string,
  existingSessionId?: string,
  displayName = "Agent",
): Promise<AcpSessionSetup> {
  const absoluteCwd = path.resolve(cwd);
  if (!existingSessionId) {
    const created = await connection.newSession({ cwd: absoluteCwd, mcpServers: [] });
    return {
      sessionId: created.sessionId,
      configOptions: created.configOptions,
      reusedConnectionSession: false,
      models: legacyModelStateOf(created),
    };
  }

  if (connection.hasSession?.(existingSessionId)) {
    // 池复用捷径：不发任何 RPC，没有新快照；调用方用上一次快照补发模型偏好。
    return { sessionId: existingSessionId, configOptions: undefined, reusedConnectionSession: true };
  }

  const request = {
    sessionId: existingSessionId,
    cwd: absoluteCwd,
    mcpServers: [],
  };
  if (capabilities?.sessionCapabilities?.resume) {
    const resumed = await connection.resumeSession(request satisfies ResumeSessionRequest);
    return {
      sessionId: existingSessionId,
      configOptions: resumed.configOptions,
      reusedConnectionSession: false,
      models: legacyModelStateOf(resumed),
    };
  }
  if (capabilities?.loadSession) {
    const loaded = await connection.loadSession(request);
    return {
      sessionId: existingSessionId,
      configOptions: loaded.configOptions,
      reusedConnectionSession: false,
      models: legacyModelStateOf(loaded),
    };
  }

  throw new Error(
    `${displayName} ACP could not resume the session because the agent does not advertise session/load or session/resume.`,
  );
}

export type AcpSessionRestoreClassification = "recoverable" | "unrecoverable" | "ambiguous";

/**
 * 会话恢复失败的保守分类（issue #141；Dot 0092 第 2 项收窄）。只把 runtime
 * 明确报告的会话状态冲突或损坏归为不可恢复；传输断开、网络超时、进程退出
 * 归为可恢复（会话本身仍有效，换一条连接即可）。泛化内部错误（JSON-RPC
 * -32603 / "internal error"）不带会话状态细节，单次出现不足以证明原会话
 * 已失效，归为「证据不足」：先在新连接上重试同一绑定；按 Dot 0094 的
 * 收窄，还须证明恢复发生在与创建该会话不同的进程/连接世代，两次同类
 * 拒绝才构成失效实据（见 restoreOrRecoverSession）。识别不了的一律
 * 返回 null，按普通错误落定，不自动降级。
 */
export function classifySessionRestoreError(error: unknown): AcpSessionRestoreClassification | null {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (/thread-store conflict|active writer|session (not found|corrupt|damaged|expired)|invalid session/.test(message)) {
    return "unrecoverable";
  }
  // Agent 以 JSON-RPC 内部错误拒绝恢复（实测 dsh 跨进程 resume 返回 -32603
  // "Internal error"）：这类错误也可能只是 runtime 的一时内部故障，通用
  // 内部错误不等于会话失效，不得据此单次确定性降级。
  const errorCode = (error as { code?: unknown } | null | undefined)?.code;
  if (errorCode === -32603 || message.includes("internal error")) {
    return "ambiguous";
  }
  if (/transport|connection closed|timeout|timed out|process exited|process failed|econnreset|econnrefused|epipe|socket hang up|aborted/.test(message)) {
    return "recoverable";
  }
  return null;
}

/**
 * 世代判定（Dot 0094）：本次恢复尝试是否发生在与创建该会话不同的进程/
 * 连接世代。返回 true = 跨世代（创建会话的进程已不存在：绑定从磁盘恢复
 * 且本进程内查不到创建世代，或创建世代与当前连接世代不同）——进程内
 * 内存态的旧会话在新进程里必然不存在，拒绝即构成失效证据。返回 false
 * = 同世代（创建会话的正是当前连接的进程，它却以泛化内部错误拒绝恢复
 * 自己的会话，更可能是持续服务故障）。连接不提供世代信息时返回 null
 * （不可判定），调用方按保守口径处理，不据此降级。
 */
export function isCrossGenerationRestore(connection: AcpConnection, sessionId: string): boolean | null {
  const generation = connection.connectionGeneration;
  if (typeof generation !== "number") return null;
  const origin = connection.sessionGeneration?.(sessionId);
  if (origin === undefined) return true;
  return origin !== generation;
}

function summarizeRestoreFailure(error: unknown): string {
  const firstLine = (error instanceof Error ? error.message : String(error)).split("\n")[0]!.trim();
  return firstLine.length > 120 ? `${firstLine.slice(0, 117)}…` : firstLine;
}

/**
 * 恢复既有会话，失败时按分类处理（issue #141；Dot 0092 第 2 项收窄）：
 * - 不可恢复（会话状态冲突或损坏，有明确实据）：直接新建会话降级；
 * - 可恢复（传输断开/超时/进程退出）与证据不足（泛化内部错误）：都先销毁
 *   当前 lease，用新连接和同一个 sessionId 重试一次。可恢复路径重试再
 *   失败按普通错误落定；证据不足路径的降级还须满足 Dot 0094 的世代
 *   条件：两次泛化内部错误本身不能证明会话失效（可能只是持续服务
 *   故障）——只有当恢复尝试发生在与创建该会话不同的进程/连接世代
 *   （isCrossGenerationRestore 为 true：创建进程已不存在，进程内内存态
 *   的旧会话必然无处可寻），且同一绑定在新连接上再被同类错误拒绝，
 *   才构成「原会话确已失效」的实据并降级；重试被明确报告为不可恢复
 *   （会话状态冲突/损坏的实据）时同样降级。同世代、或世代不可判定
 *   时一律按普通错误落定，保留原绑定并明确报错，不重绑新会话。
 * 降级新建的会话与全新会话共用同一份 options.prompt（由调用方统一经
 * buildAgentContext 组装）；但历史组装是从该 agent 最近完成消息之后
 * 截取的，可能为空，且有单条与总量长度上限和附件限制——降级提示必须
 * 如实说明历史可能不完整（见 downgradeToFreshSession），不得承诺
 * 上下文完整；降级提示走过程叙述流持久留痕。
 */
async function restoreOrRecoverSession(
  connection: AcpConnection,
  options: AcpRunOptions,
  definition: AcpRuntimeDefinition,
  capabilities: AgentCapabilities | undefined,
  initializeRequest: InitializeRequest,
  reconnect: () => AcpConnection,
): Promise<AcpSessionSetup> {
  const absoluteCwd = path.resolve(options.cwd);
  if (!options.resumeSessionId) {
    const created = await connection.newSession({ cwd: absoluteCwd, mcpServers: [] });
    return {
      sessionId: created.sessionId,
      configOptions: created.configOptions,
      reusedConnectionSession: false,
      models: legacyModelStateOf(created),
    };
  }
  try {
    return await prepareSession(connection, capabilities, options.cwd, options.resumeSessionId, definition.displayName);
  } catch (error) {
    const classification = classifySessionRestoreError(error);
    if (!classification) throw error;

    if (classification === "unrecoverable") {
      return downgradeToFreshSession(connection, options, definition, absoluteCwd, error);
    }

    const replacement = reconnect();
    const reinitialized = await replacement.initialize(initializeRequest);
    validateInitializeResponse(reinitialized, definition.displayName);
    try {
      const setup = await prepareSession(
        replacement,
        reinitialized.agentCapabilities,
        options.cwd,
        options.resumeSessionId,
        definition.displayName,
      );
      options.onOutput?.(classification === "recoverable"
        ? `${definition.displayName} 会话恢复时连接中断，已在新连接上恢复原会话。`
        : `${definition.displayName} 会话恢复被拒绝，已在新连接上恢复原会话。`);
      return setup;
    } catch (retryError) {
      if (classification === "ambiguous") {
        const retryClassification = classifySessionRestoreError(retryError);
        if (retryClassification === "unrecoverable") {
          // 重试给出了会话状态冲突/损坏的明确实据：与世代无关，按实据降级。
          return downgradeToFreshSession(replacement, options, definition, absoluteCwd, retryError);
        }
        if (
          retryClassification === "ambiguous"
          && isCrossGenerationRestore(connection, options.resumeSessionId) === true
        ) {
          // Dot 0094：跨世代 + 两次同类拒绝——创建会话的进程已不存在，
          // 进程内内存态的旧会话必然失效，构成降级实据。同世代（创建
          // 进程自己拒绝恢复）或世代不可判定（保守口径）时不降级：
          // 落入下方普通错误，保留原绑定并明确报错。
          return downgradeToFreshSession(replacement, options, definition, absoluteCwd, retryError);
        }
      }
      throw retryError;
    }
  }
}

/**
 * 降级新建会话：让调用方的 sessionId 落定新值（AgentSession 随后持久化新
 * 绑定；Orbit 侧会话、消息历史与员工配置一律不变）。提示必须在持久时间线
 * 留痕，因此与模型切换提示一样走过程叙述流（process.text，见
 * emitModelNotice），不走 onOutput 的终端文本——后者会被分类进最终回复
 * 分组并在结算时剔除（2026-11-03 实测：降级提示只出现在实时流，未进入
 * 持久时间线）。
 */
async function downgradeToFreshSession(
  connection: AcpConnection,
  options: AcpRunOptions,
  definition: AcpRuntimeDefinition,
  absoluteCwd: string,
  error: unknown,
): Promise<AcpSessionSetup> {
  const created = await connection.newSession({ cwd: absoluteCwd, mcpServers: [] });
  emitModelNotice(
    options,
    `原 ${definition.displayName} 会话无法恢复（${summarizeRestoreFailure(error)}），已重建新会话继续；新会话会带入按当前规则组装的近期对话历史，但这份历史是从该员工最近完成的消息之后截取的，可能为空或被截断、较早内容可能缺失，不保证上下文完整。`,
  );
  return {
    sessionId: created.sessionId,
    configOptions: created.configOptions,
    reusedConnectionSession: false,
    models: legacyModelStateOf(created),
  };
}

/**
 * 已核实的思考强度配置项（按 runtime 限定语义）：只有 id 与 category 同时命中
 * 才被认作思考强度。category 只是显示元数据，不是权限分类；sandbox、mode、
 * multitask 等其他 select 永远不会被当作思考强度持久化或重放。value 集合与
 * 名称一律以 runtime 实际返回为准，不做跨 runtime 的同义转换。
 */
const REASONING_CONFIG_OPTIONS: Partial<Record<AgentRuntimeKind, { id: string; category: string }>> = {
  codebuddy: { id: "thought_level", category: "thought_level" },
  // dsh 实测（2026-11-02 session/new 原始响应）：id 为 reasoning_effort，
  // category 却是 thought_level——配对以 runtime 实际返回为准，不假设
  // id 与 category 同名。
  dsh: { id: "reasoning_effort", category: "thought_level" },
};

/**
 * 从 runtime 返回的 config options 中抽取思考强度快照。runtime 未提供已核实
 * 的思考强度配置项时返回 undefined（快照不带 reasoning 字段，UI 不展示该组）。
 */
export function toReasoningSnapshot(
  configOptions: Array<SessionConfigOption> | null | undefined,
  definition: AcpRuntimeDefinition,
  currentValueSource: "probe" | "session" = "session",
): AgentReasoningStateSnapshot | undefined {
  if (!configOptions) return undefined;
  const expected = REASONING_CONFIG_OPTIONS[definition.kind];
  if (!expected) return undefined;
  const option = configOptions.find(
    (candidate): candidate is Extract<SessionConfigOption, { type: "select" }> =>
      candidate.type === "select" && candidate.id === expected.id && candidate.category === expected.category,
  );
  if (!option) return undefined;
  return {
    configId: option.id,
    choices: flattenModelChoices(option.options),
    currentValue: currentValueSource === "session" ? option.currentValue : undefined,
    currentValueSource,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * 从 runtime 返回的 config options 中抽取模型选择快照（issue #142）。只认
 * category 为 "model" 的 select 选项；configOptions 缺失（runtime 未返回配置）
 * 时返回 null，不产生快照。runtime 返回了配置但没有模型选项时给出空列表，
 * 调用方据此隐藏模型选择器。
 */
export function toModelSnapshot(
  configOptions: Array<SessionConfigOption> | null | undefined,
  options: AcpRunOptions,
  definition: AcpRuntimeDefinition,
  currentValueSource: "probe" | "session" = "session",
  legacyModels?: AcpLegacyModelState,
): AgentModelStateSnapshot | null {
  if (!configOptions) return null;
  const modelOption = configOptions.find(
    (option): option is Extract<SessionConfigOption, { type: "select" }> =>
      option.type === "select" && option.category === "model",
  );
  const reasoning = toReasoningSnapshot(configOptions, definition, currentValueSource);
  // Codex 变体路径：适配器枚举出变体清单时，模型清单与当前值以变体为准，
  // configOptions 的基础 model 不再作为 choices 来源（两条路径不得混用）。
  if (definition.kind === "codex" && legacyModels && legacyModels.availableModels.length > 0) {
    return {
      agentId: options.agentId,
      runtimeKind: definition.kind,
      configId: modelOption?.id ?? "",
      choices: legacyModels.availableModels.map((entry) => ({
        value: entry.modelId,
        name: entry.name ?? entry.modelId,
      })),
      currentValue: currentValueSource === "session" ? legacyModels.currentModelId : undefined,
      currentValueSource,
      modelApplyPath: "session_model",
      ...(reasoning ? { reasoning } : {}),
      updatedAt: new Date().toISOString(),
    };
  }
  // 承接规则：本次没有变体数据（如 config_option_update 只带 config
  // options）时，不得把已确认的变体快照覆盖回基础模型形态——沿用上一次
  // 会话快照的变体清单与当前值。
  const carry = !legacyModels &&
    options.lastSessionConfig?.modelApplyPath === "session_model" &&
    options.lastSessionConfig.runtimeKind === definition.kind &&
    options.lastSessionConfig.agentId === options.agentId
    ? options.lastSessionConfig
    : undefined;
  return {
    agentId: options.agentId,
    runtimeKind: definition.kind,
    configId: modelOption?.id ?? "",
    choices: carry ? carry.choices : modelOption ? flattenModelChoices(modelOption.options) : [],
    currentValue: carry
      ? carry.currentValue
      : currentValueSource === "session" ? modelOption?.currentValue : undefined,
    currentValueSource,
    ...(carry ? { modelApplyPath: "session_model" as const } : {}),
    ...(reasoning ? { reasoning } : {}),
    updatedAt: new Date().toISOString(),
  };
}

function flattenModelChoices(values: SessionConfigSelectOptions): AgentModelChoice[] {
  const choices: AgentModelChoice[] = [];
  for (const value of values) {
    if ("value" in value) {
      choices.push({ value: value.value, name: value.name });
      continue;
    }
    for (const inner of value.options) {
      choices.push({ value: inner.value, name: inner.name });
    }
  }
  return choices;
}

function modelLabel(snapshot: { choices: AgentModelChoice[] }, value: string): string {
  return snapshot.choices.find((choice) => choice.value === value)?.name || value;
}

/**
 * 会话建立后、prompt 前应用员工首选模型（issue #142）。模型切换是尽力而为的
 * 过程提示：runtime 不提供模型选项、首选值不在列表或切换失败时都只提示并继续
 * 用当前模型，绝不新建会话、绝不让运行失败。
 *
 * 池复用捷径（hasSession 命中，本次没有响应可读）没有新快照，改用上一次运行
 * 的快照（lastSessionConfig）无条件幂等下发 set_config_option。
 *
 * 模型之后再处理思考强度（applyPreferredReasoning）：强度偏好的校验依据是
 * 模型切换响应携带的最新 config options，因为可选强度可能随模型变化。
 */
async function applyPreferredModel(
  connection: AcpConnection,
  sessionId: string,
  options: AcpRunOptions,
  definition: AcpRuntimeDefinition,
  configOptions: Array<SessionConfigOption> | null | undefined,
  legacyModels?: AcpLegacyModelState,
): Promise<void> {
  const snapshot = toModelSnapshot(configOptions, options, definition, "session", legacyModels);
  if (snapshot) options.onSessionConfig?.(snapshot);
  let latestConfigOptions = configOptions;
  const preferred = options.preferredModelId?.trim();
  if (preferred) {
    const last = options.lastSessionConfig;
    const reference =
      snapshot
      ?? (last && last.runtimeKind === definition.kind && last.agentId === options.agentId ? last : null);
    if (reference && reference.modelApplyPath === "session_model" && reference.choices.length > 0) {
      // Codex 变体路径（唯一权威路径）：只经 legacy session/set_model 下发
      // 枚举到的变体 modelId；绝不回退 config option（变体 id 会被适配器
      // 拒绝，基础 id 会丢掉强度）。适配器对 set_model 不发确认通知，
      // 成功后以偏好值回写已确认当前值，快照即生效记录。
      if (reference.currentValue === preferred) {
        // 已是首选变体，无需下发。
      } else if (!reference.choices.some((choice) => choice.value === preferred)) {
        const current = reference.currentValue ? modelLabel(reference, reference.currentValue) : "默认模型";
        emitModelNotice(
          options,
          `${definition.displayName} 首选模型 ${preferred} 未在当前变体清单内，未做替换，继续使用 ${current}。`,
        );
      } else if (!connection.setModel) {
        const current = reference.currentValue ? modelLabel(reference, reference.currentValue) : "默认模型";
        emitModelNotice(
          options,
          `${definition.displayName} 连接不支持变体模型下发，未做替换，继续使用 ${current}。`,
        );
      } else {
        try {
          await connection.setModel({ sessionId, modelId: preferred });
          options.onSessionConfig?.({
            ...reference,
            currentValue: preferred,
            currentValueSource: "session",
            updatedAt: new Date().toISOString(),
          });
          emitModelNotice(options, `${definition.displayName} 模型已切换为 ${modelLabel(reference, preferred)}。`);
        } catch (error) {
          emitModelNotice(
            options,
            `${definition.displayName} 模型切换失败（${summarizeRestoreFailure(error)}），继续使用当前模型。`,
          );
        }
      }
    } else if (reference && reference.configId && reference.choices.length > 0) {
      if (reference.currentValue === preferred) {
        // 已是首选模型，无需下发。
      } else if (!reference.choices.some((choice) => choice.value === preferred)) {
        const current = reference.currentValue ? modelLabel(reference, reference.currentValue) : "默认模型";
        emitModelNotice(
          options,
          `${definition.displayName} 首选模型 ${modelLabel(reference, preferred)} 当前不可用，继续使用 ${current}。`,
        );
      } else {
        try {
          const response = await connection.setConfigOption({
            sessionId,
            configId: reference.configId,
            value: preferred,
          });
          latestConfigOptions = response.configOptions ?? latestConfigOptions;
          const updated = toModelSnapshot(response.configOptions, options, definition);
          if (updated) options.onSessionConfig?.(updated);
          emitModelNotice(options, `${definition.displayName} 模型已切换为 ${modelLabel(updated ?? reference, preferred)}。`);
        } catch (error) {
          emitModelNotice(
            options,
            `${definition.displayName} 模型切换失败（${summarizeRestoreFailure(error)}），继续使用当前模型。`,
          );
        }
      }
    }
  }
  await applyPreferredReasoning(connection, sessionId, options, definition, latestConfigOptions);
}

/**
 * 应用员工首选思考强度（在模型之后调用）。合同：
 * - 以目标会话的实时 config options 为准；本次有响应时只认响应里的选项，
 *   池复用无响应时才回退 lastSessionConfig 的思考强度快照；
 * - 偏好为空即跟随运行时默认，不下发、不落盘为偏好；
 * - 偏好不在最新选项内时明确提示「当前不可用、未做替换」，绝不静默换档，
 *   也不谎称已应用；命中且与当前值不同才下发 set_config_option；
 * - 恢复会话每回合都会重走本函数，等于每次都重新校验。
 */
async function applyPreferredReasoning(
  connection: AcpConnection,
  sessionId: string,
  options: AcpRunOptions,
  definition: AcpRuntimeDefinition,
  configOptions: Array<SessionConfigOption> | null | undefined,
): Promise<void> {
  const preferred = options.preferredReasoningValue?.trim();
  if (!preferred) return;
  if (!REASONING_CONFIG_OPTIONS[definition.kind]) return;
  let reference: AgentReasoningStateSnapshot | undefined;
  if (configOptions) {
    reference = toReasoningSnapshot(configOptions, definition);
  } else {
    const last = options.lastSessionConfig;
    if (last && last.runtimeKind === definition.kind && last.agentId === options.agentId) {
      reference = last.reasoning;
    }
  }
  if (!reference || reference.choices.length === 0) {
    emitModelNotice(
      options,
      `${definition.displayName} 首选思考强度当前不可用（运行时未提供该选项），未做替换，继续使用当前设置。`,
    );
    return;
  }
  if (reference.currentValue === preferred) return;
  if (!reference.choices.some((choice) => choice.value === preferred)) {
    const current = reference.currentValue ? modelLabel(reference, reference.currentValue) : "运行时默认";
    emitModelNotice(
      options,
      `${definition.displayName} 首选思考强度 ${preferred} 当前不可用，继续使用 ${current}，未做替换。`,
    );
    return;
  }
  try {
    const response = await connection.setConfigOption({
      sessionId,
      configId: reference.configId,
      value: preferred,
    });
    const updated = toModelSnapshot(response.configOptions, options, definition);
    if (updated) options.onSessionConfig?.(updated);
    emitModelNotice(
      options,
      `${definition.displayName} 思考强度已切换为 ${modelLabel(updated?.reasoning ?? reference, preferred)}。`,
    );
  } catch (error) {
    emitModelNotice(
      options,
      `${definition.displayName} 思考强度切换失败（${summarizeRestoreFailure(error)}），继续使用当前设置。`,
    );
  }
}

/**
 * 模型切换提示走过程叙述流（process.text）：在回复卡片的过程区可见并随消息
 * 持久化，不混入最终回复正文，也不会被 terminal 噪声分类降级成通用状态。
 */
function emitModelNotice(options: AcpRunOptions, text: string): void {
  // Keep runtime notices visually separate from the following model narration.
  options.onActivity?.({ type: "process.text", text: `${text}\n\n`, timestamp: new Date().toISOString(), stream: "progress" });
}

function validateInitializeResponse(response: InitializeResponse, displayName: string): void {
  if (response.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error(
      `Unsupported ${displayName} ACP protocol version ${response.protocolVersion}; Orbit requires ${PROTOCOL_VERSION}.`,
    );
  }
}

function createAcpInitializeRequest(): InitializeRequest {
  return {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {
      elicitation: {
        form: {},
        url: {},
      },
      plan: {},
      session: { configOptions: {} },
    },
    clientInfo: { name: "Orbit", version: "1.0.0" },
  } satisfies InitializeRequest;
}

/**
 * 组装 ACP Prompt 内容块（PR #147 M2/M3）。类型矩阵：
 * - 图片且 Agent 声明 `promptCapabilities.image`：原生 `image` 块，数据从
 *   永久附件路径读取，MIME 取服务端固化元数据。
 * - 其余一切（图片能力关闭时的图片、PDF/文本/代码）：`resource_link`，
 *   URI、MIME、文件名、大小全部来自服务端已校验的 MessageAttachment，
 *   本地优先场景用 `file://` URI 指向 `~/.orbit` 下的永久附件。
 *   `resource_link` 属于 ACP v1 Prompt 基础内容类型，无需能力协商。
 * 按输入顺序输出，附件元数据绝不信前端原始值。
 */
export function buildPromptContent(
  prompt: string,
  attachments: readonly MessageAttachment[] | undefined,
  capabilities: AgentCapabilities | undefined,
): ContentBlock[] {
  const blocks: ContentBlock[] = prompt ? [{ type: "text", text: prompt }] : [];
  if (!attachments?.length) return blocks;

  const imageEnabled = capabilities?.promptCapabilities?.image === true;
  for (const attachment of attachments) {
    if (attachment.kind === "image" && imageEnabled) {
      blocks.push({
        type: "image",
        data: fs.readFileSync(attachment.path).toString("base64"),
        mimeType: attachment.mimeType,
        uri: pathToFileURL(attachment.path).href,
      });
      continue;
    }
    blocks.push({
      type: "resource_link",
      uri: pathToFileURL(attachment.path).href,
      name: attachment.filename,
      mimeType: attachment.mimeType,
      size: attachment.size,
    });
  }
  return blocks;
}

function normalizePromptError(
  error: unknown,
  displayName: string,
  attachments: readonly MessageAttachment[] | undefined,
): Error {
  const original = error instanceof Error ? error.message : String(error);
  const hasImage = attachments?.some((attachment) => attachment.kind === "image") === true;
  const mentionsImageInput = /image|vision|multimodal|content block|图片|图像/i.test(original);
  const indicatesRejection = /unsupported|not support|invalid|reject|denied|cannot|can't|不支持|无效|拒绝|无法/i.test(original);
  if (hasImage && mentionsImageInput && indicatesRejection) {
    return new Error(
      `${displayName} 原始报错：${original}\n建议：当前模型不支持图片输入，请切换支持图片的模型，或移除图片附件后重试。`,
    );
  }
  return error instanceof Error ? error : new Error(original);
}

function normalizeProviderAnswer(answer: string, displayName: string): Error | null {
  if (/^selected model is at capacity\.?$/i.test(answer.trim())
    || /^model capacity has been reached\.?$/i.test(answer.trim())
    || /^模型容量已满[。.]?$/.test(answer.trim())) {
    return new Error(
      `${displayName} 原始报错：${answer.trim()}\n建议：当前模型容量已满，请切换到其他可用模型后重试。`,
    );
  }
  return null;
}

function handleSessionUpdate(
  notification: SessionNotification,
  answerState: AnswerState,
  turnState: AcpTurnState,
  toolStates: Map<string, ToolState>,
  options: AcpRunOptions,
  definition: AcpRuntimeDefinition,
): void {
  const update = notification.update;
  if (definition.isReplayedUpdate?.(notification, turnState)) {
    // 历史回放整帧丢弃（issue #172）：先于状态推进，避免回放里的陈旧 agentPhase
    // 推进响应序号、或把上一轮内容算进最终答案；也先于事件发射，因此过程时间线
    // 与持久化投影都不会看到它。
    return;
  }
  definition.observeSessionUpdate?.(update, turnState);
  if (turnState.awaitingResponseBoundary && turnState.modelResponseIndex > 0) {
    // 当前回合的首个可靠模型边界已经出现；此前收到的文本属于上一轮回放。
    answerState.deferredChunks.length = 0;
    turnState.awaitingResponseBoundary = false;
  }
  if (update.sessionUpdate === "config_option_update") {
    // 部分运行时（如 CodeBuddy）会在运行中主动推送配置变化；刷新模型快照即可。
    const snapshot = toModelSnapshot(update.configOptions, options, definition);
    if (snapshot) options.onSessionConfig?.(snapshot);
    return;
  }
  if (update.sessionUpdate === "available_commands_update") {
    // 斜杠命令快照整体替换（issue #160）；空列表同样有效，表示会话没有命令。
    // 字段缺失或不是数组时按空列表处理，不让畸形帧打断会话。
    const rawCommands = Array.isArray(update.availableCommands) ? update.availableCommands : [];
    options.onSessionCommands?.(toAgentCommands(rawCommands), notification.sessionId);
    return;
  }
  if (update.sessionUpdate === "plan") {
    emitActivity(options, {
      type: "plan.updated",
      plan: { format: "items", entries: update.entries.map(toAgentPlanEntry) },
      timestamp: new Date().toISOString(),
    });
    return;
  }

  if (update.sessionUpdate === "plan_update") {
    const plan = update.plan;
    if (plan.type === "items") {
      emitActivity(options, {
        type: "plan.updated",
        plan: { id: plan.planId, format: "items", entries: plan.entries.map(toAgentPlanEntry) },
        timestamp: new Date().toISOString(),
      });
    } else if (plan.type === "markdown") {
      emitActivity(options, {
        type: "plan.updated",
        plan: { id: plan.planId, format: "markdown", content: plan.content },
        timestamp: new Date().toISOString(),
      });
    } else {
      emitActivity(options, {
        type: "plan.updated",
        plan: { id: plan.planId, format: "file", uri: plan.uri },
        timestamp: new Date().toISOString(),
      });
    }
    return;
  }

  if (update.sessionUpdate === "plan_removed") {
    emitActivity(options, {
      type: "plan.removed",
      planId: update.planId,
      timestamp: new Date().toISOString(),
    });
    return;
  }

  if (update.sessionUpdate === "agent_message_chunk") {
    if (update.content.type === "text") {
      if (definition.isDiagnosticMessage?.(update)) {
        const text = update.content.text.trim();
        if (text) {
          options.onOutput?.(update.content.text);
          emitActivity(options, {
            type: "status",
            text,
            timestamp: new Date().toISOString(),
          });
        }
        return;
      }

      const disposition = definition.classifyAnswerChunk?.(update) ?? "candidate";
      if (disposition === "ignore") return;
      if (turnState.awaitingResponseBoundary) {
        answerState.deferredChunks.push({ update: update as AgentTextUpdate, disposition });
        return;
      }
      acceptAnswerChunk(answerState, update as AgentTextUpdate, disposition, turnState, options, definition);
    }
    return;
  }

  if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") {
    return;
  }

  const previous = toolStates.get(update.toolCallId);
  const name = update.name ?? update.title ?? previous?.name ?? update.kind ?? "tool";
  const status = update.status ?? previous?.status;
  // ACP updates may send content before the terminal status and replace the
  // collection on later updates. Keep only bounded displayable text.
  const contentSummary = update.content == null
    ? previous?.contentSummary
    : formatValue(update.content.flatMap((item) =>
      item.type === "content" && item.content.type === "text" ? [item.content.text] : [],
    ).join("\n")) || undefined;
  const rawSummary = update.rawOutput === undefined ? previous?.rawSummary : formatValue(update.rawOutput);
  const summary = rawSummary ?? contentSummary;
  toolStates.set(update.toolCallId, { name, status, contentSummary, rawSummary });

  if (!previous && status !== "completed" && status !== "failed") {
    emitActivity(options, {
      type: "tool.started",
      toolCallId: update.toolCallId,
      name,
      ...(update.rawInput === undefined ? {} : { input: formatValue(update.rawInput) }),
      timestamp: new Date().toISOString(),
    });
  }
  if (status === "completed" && previous?.status !== "completed") {
    emitActivity(options, {
      type: "tool.completed",
      toolCallId: update.toolCallId,
      name,
      ...(summary === undefined ? {} : { summary }),
      timestamp: new Date().toISOString(),
    });
    const projected = definition.projectToolCompletion?.(update);
    if (projected) emitActivity(options, projected);
  }
  if (status === "failed" && previous?.status !== "failed") {
    emitActivity(options, {
      type: "tool.failed",
      toolCallId: update.toolCallId,
      name,
      ...(summary === undefined ? {} : { summary }),
      timestamp: new Date().toISOString(),
    });
  }
}

function toAgentPlanEntry(entry: {
  content: string;
  priority: "high" | "medium" | "low";
  status: "pending" | "in_progress" | "completed";
}) {
  return {
    content: entry.content,
    priority: entry.priority,
    status: entry.status,
  };
}

/** ACP AvailableCommand → Orbit AgentCommand；畸形条目（无名/无描述）直接丢弃。 */
function toAgentCommands(commands: readonly AvailableCommand[]): AgentCommand[] {
  const result: AgentCommand[] = [];
  for (const command of commands) {
    if (typeof command?.name !== "string" || !command.name.trim()) continue;
    if (typeof command?.description !== "string" || !command.description.trim()) continue;
    const hint = command.input?.hint;
    result.push({
      name: command.name,
      description: command.description,
      ...(typeof hint === "string" && hint.trim() ? { inputHint: hint } : {}),
    });
  }
  return result;
}

function createAnswerState(): AnswerState {
  return {
    messages: new Map(),
    order: [],
    unscopedCandidateParts: [],
    unscopedFinalParts: [],
    segments: [],
    deferredChunks: [],
  };
}

function createTurnState(): AcpTurnState {
  return {
    modelResponseIndex: 0,
    inModelResponse: false,
    awaitingResponseBoundary: false,
    inHistoryReplay: false,
  };
}

function acceptAnswerChunk(
  state: AnswerState,
  update: AgentTextUpdate,
  disposition: Exclude<AcpAnswerChunkDisposition, "ignore">,
  turnState: AcpTurnState,
  options: AcpRunOptions,
  definition: AcpRuntimeDefinition,
): void {
  options.onOutput?.(update.content.text);
  if (disposition === "progress") {
    recordSegment(state, { group: "", kind: "progress", text: update.content.text });
    emitProcessText(options, update.content.text, "progress", "");
    return;
  }

  const answerGroup = appendAnswerChunk(
    state,
    update,
    disposition,
    update.content.text,
    definition,
    turnState,
  );
  emitProcessText(options, update.content.text, "answer", answerGroup, disposition === "final");
}

function flushDeferredAnswerChunks(
  state: AnswerState,
  turnState: AcpTurnState,
  options: AcpRunOptions,
  definition: AcpRuntimeDefinition,
): void {
  if (!turnState.awaitingResponseBoundary || state.deferredChunks.length === 0) return;
  turnState.awaitingResponseBoundary = false;
  const chunks = state.deferredChunks.splice(0);
  for (const chunk of chunks) {
    acceptAnswerChunk(state, chunk.update, chunk.disposition, turnState, options, definition);
  }
}

function recordSegment(state: AnswerState, segment: AnswerSegment): void {
  state.segments.push(segment);
}

function appendAnswerChunk(
  state: AnswerState,
  update: SessionNotification["update"],
  disposition: "candidate" | "final",
  text: string,
  definition: AcpRuntimeDefinition,
  turnState: AcpTurnState,
): string {
  const group = definition.answerGroupKey?.(update, turnState) ?? getAgentMessageId(update) ?? "";
  recordSegment(state, { group, kind: "answer", text });
  if (!group) {
    const parts = disposition === "final" ? state.unscopedFinalParts : state.unscopedCandidateParts;
    parts.push(text);
    return group;
  }

  let message = state.messages.get(group);
  if (!message) {
    message = { candidateParts: [], finalParts: [] };
    state.messages.set(group, message);
    state.order.push(group);
  }
  if (disposition === "final") {
    if (message.candidateParts.length) {
      message.finalParts.push(...message.candidateParts);
      message.candidateParts.length = 0;
    }
    message.finalParts.push(text);
    return group;
  }

  const parts = message.finalParts.length ? message.finalParts : message.candidateParts;
  parts.push(text);
  return group;
}

function getAgentMessageId(update: SessionNotification["update"]): string | undefined {
  if ("messageId" in update && typeof update.messageId === "string" && update.messageId) {
    return update.messageId;
  }

  const meta = update._meta;
  if (!meta || typeof meta !== "object") return undefined;
  const flatMessageId = meta["codebuddy.ai/messageId"];
  if (typeof flatMessageId === "string" && flatMessageId) return flatMessageId;

  const codeBuddyMeta = meta["codebuddy.ai"];
  if (!codeBuddyMeta || typeof codeBuddyMeta !== "object") return undefined;
  const nestedMessageId = (codeBuddyMeta as Record<string, unknown>).messageId;
  return typeof nestedMessageId === "string" && nestedMessageId ? nestedMessageId : undefined;
}

function selectFinalAnswer(state: AnswerState): { text: string; group: string } {
  for (let index = state.order.length - 1; index >= 0; index -= 1) {
    const group = state.order[index]!;
    const message = state.messages.get(group);
    if (message?.finalParts.length) return { text: message.finalParts.join(""), group };
  }
  if (state.unscopedFinalParts.length) return { text: state.unscopedFinalParts.join(""), group: "" };

  for (let index = state.order.length - 1; index >= 0; index -= 1) {
    const group = state.order[index]!;
    const message = state.messages.get(group);
    if (message?.candidateParts.length) return { text: message.candidateParts.join(""), group };
  }
  return { text: state.unscopedCandidateParts.join(""), group: "" };
}

function emitProcessText(
  options: AcpRunOptions,
  text: string,
  stream: "progress" | "answer",
  answerGroup: string,
  isFinal = false,
): void {
  if (!text) return;
  emitActivity(options, {
    type: "process.text",
    text,
    stream,
    answerGroup,
    ...(isFinal ? { isFinal: true } : {}),
    timestamp: new Date().toISOString(),
  });
}

function emitProcessTextSnapshot(options: AcpRunOptions, state: AnswerState, finalGroup: string): void {
  if (state.segments.length === 0) return;
  const text = state.segments
    .filter((segment) => !(segment.kind === "answer" && segment.group === finalGroup))
    .map((segment) => segment.text)
    .join("");
  emitActivity(options, {
    type: "process.text",
    text,
    snapshot: true,
    excludedAnswerGroup: finalGroup,
    timestamp: new Date().toISOString(),
  });
}

function emitActivity(options: AcpRunOptions, activity: AgentActivityEvent): void {
  options.onActivity?.(activity);
}

function formatValue(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return "";
  return text.length > 500 ? `${text.slice(0, 497)}...` : text;
}

export function decideAcpPermission(
  request: RequestPermissionRequest,
): RequestPermissionResponse {
  return selectAcpPermission(request, "allow");
}

export async function resolveAcpPermission(
  request: RequestPermissionRequest,
  options: AcpRunOptions,
  definition: AcpRuntimeDefinition,
): Promise<RequestPermissionResponse> {
  const toolName = acpToolName(request, definition.toolNameMetaKeys);
  const kind = resolvePermissionKind(request, toolName);
  if (options.approvalMode !== "full-access") {
    if (!options.requestPermission) return selectAcpPermission(request, "reject");
    const decision = await options.requestPermission({
      id: request.toolCall.toolCallId,
      title: request.toolCall.title || toolName || toolKindLabel(kind),
      ...(kind ? { kind } : {}),
      ...(request.toolCall.rawInput === undefined ? {} : { input: formatValue(request.toolCall.rawInput) }),
      ...(request.toolCall.locations?.length
        ? { locations: request.toolCall.locations.map((location) => location.path) }
        : {}),
    });
    return selectAcpPermission(request, decision);
  }

  return decideAcpPermission(request);
}

export async function resolveAcpElicitation(
  request: CreateElicitationRequest,
  options: AcpRunOptions,
): Promise<CreateElicitationResponse> {
  if (!options.requestElicitation) {
    return { action: "cancel" };
  }

  return options.requestElicitation(toAgentElicitationRequest(request));
}

function toAgentElicitationRequest(request: CreateElicitationRequest): AgentElicitationRequest {
  const raw = request as unknown as Record<string, unknown>;
  return {
    message: request.message,
    mode: request.mode,
    ...(typeof raw.sessionId === "string" ? { sessionId: raw.sessionId } : {}),
    ...(typeof raw.requestId === "string" || typeof raw.requestId === "number" ? { id: String(raw.requestId) } : {}),
    ...(typeof raw.toolCallId === "string" ? { toolCallId: raw.toolCallId } : {}),
    ...(request.mode === "form" && raw.requestedSchema && typeof raw.requestedSchema === "object"
      ? { requestedSchema: raw.requestedSchema as AgentElicitationRequest["requestedSchema"] }
      : {}),
    ...(request.mode === "url" && typeof raw.elicitationId === "string" && typeof raw.url === "string"
      ? { elicitationId: raw.elicitationId, url: raw.url }
      : {}),
  };
}

function selectAcpPermission(
  request: RequestPermissionRequest,
  decision: "allow" | "reject",
): RequestPermissionResponse {
  const selectedKind = decision === "allow" ? "allow_once" : "reject_once";
  const selected = request.options.find((option) => option.kind === selectedKind);
  return selected
    ? { outcome: { outcome: "selected", optionId: selected.optionId } }
    : { outcome: { outcome: "cancelled" } };
}

type PermissionKind = ToolKind | "write";

function acpToolName(
  request: RequestPermissionRequest,
  metaKeys: readonly string[] | undefined,
): string | undefined {
  for (const key of metaKeys ?? []) {
    const value = request.toolCall._meta?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function resolvePermissionKind(
  request: RequestPermissionRequest,
  toolName: string | undefined,
): PermissionKind | undefined {
  if (request.toolCall.kind && request.toolCall.kind !== "other") return request.toolCall.kind;
  const normalized = toolName?.toLowerCase().replace(/[\s_/-]+/g, "");
  switch (normalized) {
    case "read":
    case "readfile":
      return "read";
    case "glob":
    case "grep":
    case "search":
    case "find":
    case "ls":
      return "search";
    case "webfetch":
    case "websearch":
      return "fetch";
    case "write":
    case "writefile":
      return "write";
    case "edit":
    case "notebookedit":
    case "applypatch":
    case "multiedit":
      return "edit";
    case "delete":
    case "remove":
      return "delete";
    case "move":
    case "rename":
      return "move";
    case "bash":
    case "shell":
    case "execute":
    case "terminal":
    case "runcommand":
      return "execute";
    case "askuserquestion":
    case "todowrite":
      return "think";
    case "exitplanmode":
      return "switch_mode";
    default:
      return request.toolCall.kind ?? undefined;
  }
}

function toolKindLabel(kind: PermissionKind | null | undefined): string {
  switch (kind) {
    case "read": return "读取文件";
    case "search": return "搜索文件";
    case "fetch": return "访问网络";
    case "write": return "写入文件";
    case "edit": return "编辑文件";
    case "delete": return "删除文件";
    case "move": return "移动文件";
    case "execute": return "执行命令";
    default: return "执行操作";
  }
}

export function spawnAcpConnection(
  definition: AcpRuntimeDefinition,
  options: AcpRunOptions,
  onSessionUpdate: (notification: SessionNotification) => void,
): AcpReusableConnection {
  const baseEnv = options.env ?? process.env;
  const command = definition.buildCommand(baseEnv);
  const child = spawn(command.file, command.args, {
    cwd: options.cwd,
    env: createEnv(definition, options.agentId, {
      ...baseEnv,
      ...definition.envForRun?.(options),
      ...command.env,
    }),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    detached: os.platform() !== "win32",
  });
  let context: { options: AcpRunOptions; onSessionUpdate: typeof onSessionUpdate } | null = {
    options,
    onSessionUpdate,
  };
  const stderrForwarder = new AcpStderrForwarder();
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    const readable = extractReadableText(chunk);
    if (!readable) return;
    for (const output of stderrForwarder.forward(readable)) {
      context?.options.onOutput?.(output);
    }
  });

  const app = client({ name: "Orbit" })
    .onRequest(methods.client.session.requestPermission, ({ params }) => (
      context ? resolveAcpPermission(params, context.options, definition) : selectAcpPermission(params, "reject")
    ))
    .onRequest(methods.client.elicitation.create, ({ params }) => (
      context ? resolveAcpElicitation(params, context.options) : Promise.resolve({ action: "cancel" })
    ))
    .onNotification(methods.client.elicitation.complete, ({ params }) => {
      context?.options.onActivity?.({
        type: "status",
        text: `外部输入流程已完成：${params.elicitationId}`,
        timestamp: new Date().toISOString(),
      });
    })
    .onNotification(methods.client.session.update, ({ params }) => {
      context?.onSessionUpdate(params);
    });
  const guardedStdout = child.stdout.pipe(createAcpFrameLimitTransform());
  const stream = ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(guardedStdout) as ReadableStream<Uint8Array>,
  );
  const acp = app.connect(stream);

  // stdout EOF（传输断开）的连接即使进程还活着也不可复用（issue #141）。
  let stdoutEnded = false;
  guardedStdout.once("end", () => {
    stdoutEnded = true;
  });

  const connection = connectionFromProcess(child, acp, definition.displayName, guardedStdout, () => stderrForwarder.tailText());
  return {
    ...connection,
    rebind(nextOptions, nextOnSessionUpdate) {
      context = { options: nextOptions, onSessionUpdate: nextOnSessionUpdate };
      stderrForwarder.reset();
    },
    deactivate() {
      context = null;
    },
    isAlive() {
      return child.exitCode === null && child.signalCode === null && !stdoutEnded;
    },
  };
}

function connectionFromProcess(
  child: ChildProcessWithoutNullStreams,
  acp: ClientConnection,
  displayName: string,
  guardedStdout?: NodeJS.ReadableStream,
  stderrText?: () => string,
): AcpConnection {
  const pid = child.pid ?? 0;
  let closed = false;
  let transportEnded = false;
  let rejectProcessFailure!: (error: Error) => void;
  const processFailure = new Promise<never>((_resolve, reject) => {
    rejectProcessFailure = reject;
  });
  void processFailure.catch(() => undefined);
  guardedStdout?.once("end", () => {
    transportEnded = true;
  });
  child.once("error", (error) => rejectProcessFailure(new Error(
    `${displayName} ACP process failed (pid ${pid}): ${error.message}`,
  )));
  guardedStdout?.once("error", (error) => rejectProcessFailure(new Error(
    `${displayName} ACP transport failed (pid ${pid}): ${error.message}`,
  )));
  // 进程活着但 stdout 提前 EOF（runtime 崩溃或只关闭了输出流）时，pending
  // 请求会永久挂在 Promise.race 上；把传输结束也视为进程失败（issue #141）。
  // Windows 上崩溃进程的 stdout EOF 会先于 exit 事件到达，这里延迟一拍落定，
  // 让进程退出场景由 exit 监听给出带退出码的诊断；只有进程确实仍在运行才
  // 报 transport closed。
  guardedStdout?.once("end", () => {
    if (closed) return;
    const transportClosedTimer = setTimeout(() => {
      if (closed) return;
      if (child.exitCode !== null || child.signalCode !== null) return;
      const stderr = stderrText?.().trim();
      rejectProcessFailure(new Error(
        `${displayName} ACP transport closed (stdout ended while pid ${pid} was still running).` +
        (stderr ? `\n${stderr}` : ""),
      ));
    }, 50);
    transportClosedTimer.unref?.();
  });
  child.once("exit", (code, signal) => {
    if (!closed) {
      const stderr = stderrText?.().trim();
      rejectProcessFailure(new Error(
        `${displayName} ACP process exited unexpectedly (pid ${pid}, ${code === null ? `signal ${signal}` : `code ${code}`}).` +
        (stderr ? `\n${stderr}` : ""),
      ));
    }
  });
  // 失败诊断统一带 runtime displayName 与 pid（issue #141）：进程退出或连接
  // 被关闭时，ACP SDK 可能抢先以裸 "ACP connection closed" 拒绝 pending 请求，
  // 这里补上进程上下文；连接健康时的业务错误与本模块已带前缀的诊断保持原样。
  const request = <T>(operation: Promise<T>): Promise<T> =>
    Promise.race([operation, processFailure]).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      const connectionDead = closed || transportEnded || child.exitCode !== null || child.signalCode !== null;
      if (!connectionDead || message.startsWith(`${displayName} ACP `)) throw error;
      throw new Error(`${displayName} ACP request failed (pid ${pid}): ${message}`);
    });

  const terminate = () => {
    if (closed) return;
    closed = true;
    const processStillRunning = child.exitCode === null && child.signalCode === null;
    if (pid > 0 && processStillRunning) {
      if (os.platform() === "win32") {
        // Finish tree termination before closing stdio. If cmd.exe exits first,
        // taskkill can no longer discover and terminate the nested agent process.
        spawnSync("taskkill", ["/pid", String(pid), "/F", "/T"], {
          windowsHide: true,
          stdio: "ignore",
        });
      } else {
        interruptProcessTree(pid);
      }
    } else {
      child.kill();
    }
    acp.close();
  };

  const close = () => {
    terminate();
  };

  /**
   * 强制销毁（issue #136）：close() 置位 closed 后，进程 exit 事件不再触发
   * processFailure 拒绝，pending 请求会永久挂在 Promise.race 上。destroy 必须
   * 显式拒绝 processFailure，让所有未结算的 ACP 请求立即结束。
   */
  const destroy = () => {
    terminate();
    rejectProcessFailure(new Error(`${displayName} ACP connection was destroyed.`));
  };

  return {
    pid,
    initialize: (params) => request(acp.agent.request(methods.agent.initialize, params)),
    newSession: (params) => request(acp.agent.request(methods.agent.session.new, params)),
    loadSession: (params) => request(acp.agent.request(methods.agent.session.load, params)),
    resumeSession: (params) => request(acp.agent.request(methods.agent.session.resume, params)),
    setConfigOption: (params) => request(acp.agent.request(methods.agent.session.setConfigOption, params)),
    setModel: (params) => request(acp.agent.request("session/set_model", params)).then(() => undefined),
    prompt: (params) => request(acp.agent.request(methods.agent.session.prompt, params)),
    cancel: (sessionId) => request(acp.agent.notify(methods.agent.session.cancel, { sessionId })),
    close,
    destroy,
  };
}

function createEnv(
  definition: AcpRuntimeDefinition,
  agentId: AgentId,
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {
    ...env,
    ORBIT_AGENT_ID: agentId,
  };
  for (const name of definition.agentIdEnvNames ?? []) {
    result[name] = agentId;
  }
  return result;
}
