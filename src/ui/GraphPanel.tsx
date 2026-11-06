import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import * as dagre from "@dagrejs/dagre";
// 注意：@xyflow/react 的样式表在入口 main.tsx 统一导入——组件内导入 .css
// 会让以 node:test 直接加载 App.tsx 的前端测试报 ERR_UNKNOWN_FILE_EXTENSION。

import type {
  ConversationAgentSessions,
  ConversationGraph,
  ConversationGraphCheckpoints,
  ConversationGraphNode,
  ConversationGraphNodeStatus,
  ConversationGraphNodeType,
  ConversationGraphProblemItem,
  ConversationGraphProblemKind,
} from "../shared/types.ts";

const NODE_WIDTH = 216;
const NODE_HEIGHT = 78;

const STATUS_LABELS: Record<ConversationGraphNodeStatus, string> = {
  queued: "排队中",
  running: "执行中",
  cancelling: "取消中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

const NODE_TYPE_LABELS: Record<ConversationGraphNodeType, string> = {
  instruction: "指令",
  execution: "执行",
  conclusion: "结论",
};

const PROBLEM_KIND_LABELS: Record<ConversationGraphProblemKind, string> = {
  "run-failed": "执行失败",
  "run-cancelled": "执行取消",
  "route-blocked": "派发被阻断",
  "tool-failed": "工具失败",
};

type GraphNodeData = {
  graphNode: ConversationGraphNode;
  hasChildren: boolean;
  collapsed: boolean;
  onToggleCollapse: (nodeId: string) => void;
  retryExpanded: boolean;
  onToggleRetry: (groupId: string) => void;
  [key: string]: unknown;
};

type FlowNode = Node<GraphNodeData, "graphNode">;

function GraphNodeCard({ data }: NodeProps<FlowNode>) {
  const node = data.graphNode;
  const isRoot = node.kind === "root";
  const author = isRoot ? "你" : node.agentLabel ?? node.agentId ?? "数字员工";
  return (
    <div className={`graphNodeCard ${node.kind} ${node.status ? `status-${node.status}` : ""}${node.dimmed ? " dimmed" : ""}`}>
      <Handle type="target" position={Position.Top} className="graphHandle" />
      <div className="graphNodeHead">
        <span className={`graphStatusDot ${node.status ?? "root"}`} aria-hidden="true" />
        <strong className="graphNodeAuthor">{author}</strong>
        <span className={`graphTypeBadge type-${node.nodeType}`}>{NODE_TYPE_LABELS[node.nodeType]}</span>
        {node.runtime ? <span className="graphRuntimeBadge">{node.runtime}</span> : null}
        {node.origin === "supervisor" && !isRoot ? <span className="graphOriginBadge">监工派发</span> : null}
        {node.obstacleCount > 0 ? <span className="graphObstacleBadge">阻碍 ×{node.obstacleCount}</span> : null}
        {data.hasChildren ? (
          <button
            type="button"
            className="graphCollapseBtn"
            title={data.collapsed ? "展开子树" : "折叠子树"}
            onClick={(event) => {
              event.stopPropagation();
              data.onToggleCollapse(node.id);
            }}
          >
            {data.collapsed ? `+${node.childCount}` : "−"}
          </button>
        ) : null}
      </div>
      <div className="graphNodeTitle" title={node.title}>{node.title}</div>
      {node.retry && !node.retry.folded && node.retry.totalAttempts > 1 ? (
        <button
          type="button"
          className="graphRetryBtn"
          title={data.retryExpanded ? "收起之前的尝试" : "展开之前的尝试"}
          onClick={(event) => {
            event.stopPropagation();
            data.onToggleRetry(node.retry!.groupId);
          }}
        >
          第 {node.retry.attempt} 次尝试 · 含 {node.retry.totalAttempts - 1} 次重试{data.retryExpanded ? "（收起）" : "（展开）"}
        </button>
      ) : null}
      {node.retry?.folded ? <div className="graphNodeStep">第 {node.retry.attempt} 次尝试（已折叠）</div> : null}
      {node.planCurrentStep ? <div className="graphNodeStep">当前步：{node.planCurrentStep}</div> : null}
      <div className="graphNodeMeta">
        {node.status ? <span>{STATUS_LABELS[node.status]}</span> : <span>任务</span>}
        {node.routeDepth ? <span> · 第 {node.routeDepth} 层</span> : null}
        <span> · {formatTime(node.completedAt ?? node.startedAt ?? node.createdAt)}</span>
      </div>
      <Handle type="source" position={Position.Bottom} className="graphHandle" />
    </div>
  );
}

const nodeTypes = { graphNode: GraphNodeCard };

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function layoutWithDagre(nodeIds: string[], edges: { source: string; target: string }[]): Map<string, { x: number; y: number }> {
  const graph = new dagre.graphlib.Graph();
  graph.setGraph({ rankdir: "TB", nodesep: 28, ranksep: 46, marginx: 16, marginy: 16 });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const id of nodeIds) graph.setNode(id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  for (const edge of edges) graph.setEdge(edge.source, edge.target);
  dagre.layout(graph);
  const positions = new Map<string, { x: number; y: number }>();
  for (const id of nodeIds) {
    const point = graph.node(id);
    if (point) positions.set(id, { x: point.x - NODE_WIDTH / 2, y: point.y - NODE_HEIGHT / 2 });
  }
  return positions;
}

function GraphCanvas(props: {
  graph: ConversationGraph;
  selectedRootId: string;
  onLocateMessage: (messageId: string) => void;
}) {
  const { graph, selectedRootId } = props;
  const [collapsedIds, setCollapsedIds] = useState<ReadonlySet<string>>(new Set());
  const [expandedRetryGroups, setExpandedRetryGroups] = useState<ReadonlySet<string>>(new Set());

  const toggleRetry = useCallback((groupId: string) => {
    setExpandedRetryGroups((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }, []);
  const [flowNodes, setFlowNodes, onNodesChange] = useNodesState<FlowNode>([]);
  const [flowEdges, setFlowEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const positionsRef = useRef(new Map<string, { x: number; y: number }>());
  const structureKeyRef = useRef("");
  const fittedRootRef = useRef("");
  const reactFlow = useReactFlow();

  useEffect(() => {
    setCollapsedIds(new Set());
    setExpandedRetryGroups(new Set());
    positionsRef.current.clear();
    structureKeyRef.current = "";
    fittedRootRef.current = "";
  }, [graph.conversationId]);

  const toggleCollapse = useCallback((nodeId: string) => {
    setCollapsedIds((current) => {
      const next = new Set(current);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  }, []);

  const visible = useMemo(() => {
    const members = graph.nodes.filter((node) => node.rootId === selectedRootId);
    const memberIds = new Set(members.map((node) => node.id));
    const childrenByParent = new Map<string, string[]>();
    for (const node of members) {
      if (node.parentNodeId && memberIds.has(node.parentNodeId)) {
        childrenByParent.set(node.parentNodeId, [...(childrenByParent.get(node.parentNodeId) ?? []), node.id]);
      }
    }
    const hidden = new Set<string>();
    const stack = members.filter((node) => collapsedIds.has(node.id)).map((node) => node.id);
    // 重试折叠：非末次尝试默认隐藏（连同其后代），在末次尝试节点上可展开。
    for (const node of members) {
      if (node.retry?.folded && !expandedRetryGroups.has(node.retry.groupId)) {
        hidden.add(node.id);
        stack.push(node.id);
      }
    }
    while (stack.length > 0) {
      const current = stack.pop()!;
      for (const child of childrenByParent.get(current) ?? []) {
        if (!hidden.has(child)) {
          hidden.add(child);
          stack.push(child);
        }
      }
    }
    const visibleNodes = members.filter((node) => !hidden.has(node.id));
    const visibleIds = new Set(visibleNodes.map((node) => node.id));
    const visibleEdges = graph.edges.filter(
      (edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target),
    );
    return { visibleNodes, visibleEdges };
  }, [graph, selectedRootId, collapsedIds, expandedRetryGroups]);

  useEffect(() => {
    const { visibleNodes, visibleEdges } = visible;
    const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
    // 结构键：节点/边集合不变（仅状态变化）时不重排，位置完全复用，避免实时刷新时图面跳动。
    const structureKey = [
      selectedRootId,
      visibleNodes.map((node) => node.id).sort().join(","),
      visibleEdges.map((edge) => edge.id).sort().join(","),
    ].join("|");
    if (structureKey !== structureKeyRef.current) {
      const laidOut = layoutWithDagre(
        visibleNodes.map((node) => node.id),
        visibleEdges.map((edge) => ({ source: edge.source, target: edge.target })),
      );
      for (const [id, position] of laidOut) {
        // 已有节点尽量保持旧位置（dagre 对未变前缀的布局通常接近，硬保留可防跳动；
        // 仅当旧位置与新位置相距过远——结构大变——才采用新位置）。
        const previous = positionsRef.current.get(id);
        if (!previous || Math.abs(previous.x - position.x) > 480 || Math.abs(previous.y - position.y) > 320) {
          positionsRef.current.set(id, position);
        }
      }
      structureKeyRef.current = structureKey;
    }
    setFlowNodes(visibleNodes.map((node) => ({
      id: node.id,
      type: "graphNode" as const,
      position: positionsRef.current.get(node.id) ?? { x: 0, y: 0 },
      data: {
        graphNode: node,
        hasChildren: node.childCount > 0,
        collapsed: collapsedIds.has(node.id),
        onToggleCollapse: toggleCollapse,
        retryExpanded: node.retry ? expandedRetryGroups.has(node.retry.groupId) : false,
        onToggleRetry: toggleRetry,
      },
    })));
    setFlowEdges(visibleEdges.map((edge) => {
      const target = nodesById.get(edge.target);
      return {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        animated: target?.status === "running" || target?.status === "cancelling",
        className: edge.dimmed ? "graphEdgeDimmed" : undefined,
        style: edge.routeState === "blocked" ? { strokeDasharray: "5 4" } : undefined,
      };
    }));
    if (fittedRootRef.current !== selectedRootId && visibleNodes.length > 0) {
      fittedRootRef.current = selectedRootId;
      const timer = window.setTimeout(() => {
        void reactFlow.fitView({ padding: 0.18, maxZoom: 1, duration: 200 });
      }, 60);
      return () => window.clearTimeout(timer);
    }
  }, [visible, graph.nodes, selectedRootId, collapsedIds, toggleCollapse, expandedRetryGroups, toggleRetry, reactFlow, setFlowNodes, setFlowEdges]);

  if (graph.roots.length === 0) {
    return <div className="graphEmpty">本会话还没有任务链。发出一条指派消息后，这里会长出工作树。</div>;
  }
  if (visible.visibleNodes.length === 0) {
    return <div className="graphEmpty">所选任务暂无可展示的节点。</div>;
  }
  return (
    <ReactFlow
      nodes={flowNodes}
      edges={flowEdges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onNodeClick={(_, node) => props.onLocateMessage((node.data as GraphNodeData).graphNode.messageId)}
      nodeTypes={nodeTypes}
      nodesDraggable
      nodesConnectable={false}
      elementsSelectable={false}
      minZoom={0.2}
      maxZoom={1.6}
    >
      <Background gap={18} size={1} />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}

function ProblemItemCard(props: {
  item: ConversationGraphProblemItem;
  expanded: boolean;
  onToggleExpand: (itemId: string) => void;
  onLocateMessage: (messageId: string) => void;
}) {
  const { item } = props;
  const longText = item.text.length > 220;
  return (
    <div className="problemItem">
      <div className="problemItemHead">
        <span className={`problemKindBadge kind-${item.kind}`}>{PROBLEM_KIND_LABELS[item.kind]}</span>
        {item.agentLabel ? <span className="problemAgent">{item.agentLabel}</span> : null}
        <span className="problemTime">{formatTime(item.completedAt ?? item.createdAt)}</span>
        <span className="problemSource">
          {item.source === "history-summary" ? "历史摘要／事件未留存" : "与记录一致"}
        </span>
      </div>
      <div className={`problemText${longText && !props.expanded ? " clamped" : ""}`}>{item.text}</div>
      {longText ? (
        <button type="button" className="problemExpandBtn" onClick={() => props.onToggleExpand(item.id)}>
          {props.expanded ? "收起" : "展开全文（仅显示折叠，原文未删）"}
        </button>
      ) : null}
      <div className="problemItemFoot">
        <span className="problemNodeId">节点 {item.nodeId}</span>
        <button type="button" className="problemLocateBtn" onClick={() => props.onLocateMessage(item.messageId)}>
          回到原节点
        </button>
      </div>
    </div>
  );
}

function ProblemBoard(props: {
  graph: ConversationGraph | null;
  error: string | null;
  problemsEnabled: boolean;
  onToggleProblems: (enabled: boolean) => void;
  onLocateMessage: (messageId: string) => void;
}) {
  const [expandedItems, setExpandedItems] = useState<ReadonlySet<string>>(new Set());
  const [expandedClusters, setExpandedClusters] = useState<ReadonlySet<string>>(new Set());
  const toggleItem = useCallback((itemId: string) => {
    setExpandedItems((current) => {
      const next = new Set(current);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  }, []);
  const toggleCluster = useCallback((clusterId: string) => {
    setExpandedClusters((current) => {
      const next = new Set(current);
      if (next.has(clusterId)) next.delete(clusterId);
      else next.add(clusterId);
      return next;
    });
  }, []);

  const header = (
    <div className="problemBoardHead">
      <span className="problemBoardNote">
        只抽取阻碍条目，同因成簇。条目文字与落盘记录逐字一致；记录在服务端可能已汇总或截断，不代表原始错误全文。
      </span>
      <label className="problemToggle">
        <input
          type="checkbox"
          checked={props.problemsEnabled}
          onChange={(event) => props.onToggleProblems(event.target.checked)}
        />
        聚类
      </label>
    </div>
  );

  if (!props.graph) {
    return (
      <div className="problemBoard">
        {header}
        <div className="graphEmpty">{props.error ?? "加载中…"}</div>
      </div>
    );
  }
  const problems = props.graph.problems;
  if (!problems || !problems.enabled) {
    return (
      <div className="problemBoard">
        {header}
        <div className="graphEmpty">聚类已关闭，问题台未启用。左侧指令链不受影响，照常显示。</div>
      </div>
    );
  }
  if (problems.degraded) {
    return (
      <div className="problemBoard">
        {header}
        <div className="graphEmpty">问题台暂时不可用（聚类派生异常，已自动降级）。左侧指令链不受影响。</div>
      </div>
    );
  }
  const itemsById = new Map(problems.items.map((item) => [item.id, item]));
  return (
    <div className="problemBoard">
      {header}
      {problems.dataIncomplete ? (
        <div className="problemIncomplete">数据不完整：历史仅保留结算记录，过程事件未留存；工具类条目只有结算计数。</div>
      ) : null}
      {problems.truncated ? (
        <div className="problemIncomplete">条目较多，已按上限截断显示（共 {problems.totalItems} 条）。</div>
      ) : null}
      {problems.items.length === 0 ? (
        <div className="graphEmpty">目前没有记录到阻碍。</div>
      ) : (
        problems.clusters.map((cluster) => {
          const items = cluster.itemIds
            .map((id) => itemsById.get(id))
            .filter((item): item is ConversationGraphProblemItem => Boolean(item));
          if (items.length === 0) return null;
          const first = items[0];
          const multi = items.length > 1;
          const open = !multi || expandedClusters.has(cluster.id);
          return (
            <div key={cluster.id} className="problemCluster">
              <button
                type="button"
                className="problemClusterHead"
                onClick={() => multi && toggleCluster(cluster.id)}
                aria-expanded={open}
              >
                <span className={`problemKindBadge kind-${cluster.kind}`}>{PROBLEM_KIND_LABELS[cluster.kind]}</span>
                {cluster.errorCode ? <span className="problemCode">{cluster.errorCode}</span> : null}
                <span className="problemClusterTitle">{first.text}</span>
                {multi ? <span className="problemClusterCount">同因 ×{items.length}{open ? "（收起）" : "（展开）"}</span> : null}
              </button>
              {open
                ? items.map((item) => (
                    <ProblemItemCard
                      key={item.id}
                      item={item}
                      expanded={expandedItems.has(item.id)}
                      onToggleExpand={toggleItem}
                      onLocateMessage={props.onLocateMessage}
                    />
                  ))
                : null}
            </div>
          );
        })
      )}
    </div>
  );
}

const SESSION_BUDGET_KEY = "orbit.sessionTurnBudget";

function parseSessionBudget(value: string): number | null {
  if (!/^[0-9]+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

type CompactionAgentState = "enabled" | "disabled" | "unsupported";

/** 已观测压缩标记行（第三步试点）：只呈现观测事实，不出现「压缩次数」类措辞。 */
function CompactionLine(props: { agent: ConversationAgentSessions; state?: CompactionAgentState }) {
  const compaction = props.agent.compaction;
  if (compaction) {
    return <>
      <div className="sessionSummary">已观测压缩标记 {compaction.markerSegmentCount} 段{compaction.unassignedSegmentCount > 0 ? <> · 未归段 {compaction.unassignedSegmentCount} 段</> : null}（同一回合内的相邻标记合并为一段；这只是观测到的标记，不是引擎报告的压缩事件）</div>
      {compaction.segments.length > 0 ? <div className="sessionBlockList">{compaction.segments.map((segment, index) =>
        <div className="sessionBlock" key={index}>标记段 · {formatDateTime(segment.startedAt)} · {segment.chunkCount} 个标记 chunk · {segment.assigned ? <>归入第 {segment.segmentIndex} 段</> : <>未归段</>}</div>)}
      </div> : null}
    </>;
  }
  if (props.state === "disabled") return <div className="sessionSummary">压缩标记：捕获未开启（CodeBuddy 试点，需 ORBIT_COMPACTION_CAPTURE 开启）</div>;
  if (props.state === "unsupported") return <div className="sessionSummary">压缩标记：未接入 / 未验证</div>;
  if (props.state === "enabled") return <div className="sessionSummary">已观测压缩标记：暂无覆盖记录</div>;
  return null;
}

function SessionBoard(props: {
  graph: ConversationGraph | null;
  error: string | null;
  sessionsEnabled: boolean;
  onToggleSessions: (enabled: boolean) => void;
  workspaceId: string;
  conversationId: string;
  checkpointsEnabled: boolean;
  onToggleCheckpoints: (enabled: boolean) => void;
  onGraphChanged: () => void;
}) {
  const [budgetInput, setBudgetInput] = useState(() => {
    try {
      const stored = window.localStorage.getItem(SESSION_BUDGET_KEY) ?? "";
      if (stored && parseSessionBudget(stored) === null) window.localStorage.removeItem(SESSION_BUDGET_KEY);
      return parseSessionBudget(stored) === null ? "" : stored;
    } catch { return ""; }
  });
  const budget = parseSessionBudget(budgetInput);
  const [compactionStates, setCompactionStates] = useState<Map<string, CompactionAgentState>>(new Map());
  useEffect(() => {
    let cancelled = false;
    const query = `workspaceId=${encodeURIComponent(props.workspaceId)}&conversationId=${encodeURIComponent(props.conversationId)}`;
    void fetch(`/api/conversations/${encodeURIComponent(props.conversationId)}/engine-events/status?${query}`)
      .then(async (response) => {
        if (!response.ok) return;
        const data = await response.json() as { agents?: { agentId: string; state: CompactionAgentState }[] };
        if (cancelled || !Array.isArray(data.agents)) return;
        setCompactionStates(new Map(data.agents.map((entry) => [entry.agentId, entry.state])));
      })
      .catch(() => { /* 状态端点不可用时不呈现捕获状态 */ });
    return () => { cancelled = true; };
  }, [props.workspaceId, props.conversationId]);
  const header = <>
    <div className="problemBoardHead">
      <span className="sessionBoardNote">按落盘消息派生，自首次观测以来；受消息保留期（默认 90 天）限制，更早的历史不可见。段按消息时间（createdAt，同刻按消息 id）排序切分。段界只记『已观测 sessionId 切换』，不等于已证实的会话重建。无 sessionId 的消息列入未知区间，不并入任何计数。</span>
      <label className="problemToggle"><input type="checkbox" checked={props.sessionsEnabled} onChange={(event) => props.onToggleSessions(event.target.checked)} />启用</label>
    </div>
    <label className="sessionBudgetRow">提醒预算（可选）：某位员工当前会话段的用户轮次超过 <input type="number" min="1" step="1" value={budgetInput} onChange={(event) => {
      const value = event.target.value;
      setBudgetInput(value);
      try {
        if (parseSessionBudget(value) === null) window.localStorage.removeItem(SESSION_BUDGET_KEY);
        else window.localStorage.setItem(SESSION_BUDGET_KEY, value);
      } catch { /* 存储不可用时仅在当前页面生效。 */ }
    }} /> 次时给出提醒</label>
  </>;
  if (!props.graph) return <div className="sessionBoard">{header}<div className="graphEmpty">{props.error ?? "加载中…"}</div></div>;
  const sessions = props.graph.sessions;
  const checkpointSection = <CheckpointSection
    workspaceId={props.workspaceId}
    conversationId={props.conversationId}
    checkpoints={props.graph.checkpoints}
    checkpointsEnabled={props.checkpointsEnabled}
    onToggleCheckpoints={props.onToggleCheckpoints}
    onChanged={props.onGraphChanged}
  />;
  if (!sessions?.enabled) return <div className="sessionBoard">{header}<div className="graphEmpty">会话状态已关闭。</div>{checkpointSection}</div>;
  if (sessions.degraded) return <div className="sessionBoard">{header}<div className="graphEmpty">会话状态暂时不可用（统计已降级）。</div>{checkpointSection}</div>;
  return <div className="sessionBoard">{header}
    {checkpointSection}
    {sessions.compactionCoverage ? <div className="sessionSummary">压缩标记覆盖区间 {sessions.compactionCoverage.intervals.length} 个{sessions.compactionCoverage.degraded ? <> · 覆盖存在缺口（事件记录含坏行）</> : null}{sessions.compactionCoverage.retentionExcluded ? <> · 部分早期事件已超 {sessions.compactionCoverage.retentionDays} 天留存窗口，未计入</> : null}</div> : null}
    {sessions.agents.length === 0 ? <div className="graphEmpty">本会话还没有员工执行记录。</div> : sessions.agents.map((agent) => {
      const lastSegment = agent.blocks.filter((block) => block.type === "segment").at(-1);
      const overBudget = budget !== null && lastSegment !== undefined && lastSegment.userTurns > budget;
      return <section className="sessionAgent" key={agent.agentId}>
        <div className="sessionAgentHead"><strong>{agent.agentLabel ?? agent.agentId}</strong>
          {agent.runtime ? <span className="graphRuntimeBadge">{agent.runtime}</span> : null}
          {agent.isSupervisor ? <span className="sessionCurrentTag">监工</span> : null}
          {overBudget ? <span className="sessionOverBadge">超预算</span> : null}
        </div>
        <div className="sessionSummary">已观测会话段 {agent.segmentCount} · 已观测切换 {agent.switchCount} 次 · 不同会话 {agent.distinctSessionCount} 个 · 用户轮次 {agent.totalUserTurns} · 执行 {agent.totalRuns} 次 · 消息 {agent.totalMessages} 条 · 共 {agent.totalChars} 字
          {agent.unknownIntervalCount > 0 ? <> · 未知区间 {agent.unknownIntervalCount} 处（{agent.unknownMessageCount} 条消息未记录 sessionId，未并入计数）</> : null}
        </div>
        <CompactionLine agent={agent} state={compactionStates.get(agent.agentId)} />
        <div className="sessionBlockList">{agent.blocks.map((block, index) => block.type === "unknown" ?
          <div className="sessionBlock unknown" key={index}>未知区间 · {formatDateTime(block.startedAt)} – {formatDateTime(block.lastActivityAt)} · {block.messageCount} 条消息未记录 sessionId</div> :
          <div className="sessionBlock" key={index}>第 {block.index} 段 · 会话 <span className="sessionSegId" title={block.sessionId}>{block.sessionShortId}…</span> · 首次观测 {formatDateTime(block.firstObservedAt)} · 最近活动 {formatDateTime(block.lastActivityAt)} · 用户轮次 {block.userTurns} · 执行 {block.runCount} 次 · 消息 {block.messageCount} 条 · {block.charCount} 字
            {block === lastSegment ? <span className="sessionCurrentTag">现行</span> : null}
            {block === lastSegment && overBudget ? <span className="sessionOverBadge">超预算</span> : null}
          </div>)}</div>
      </section>;
    })}
  </div>;
}


type HandoffPreviewData = {
  ok: boolean;
  fullText: string;
  excerptHash: string;
  excerptChars: number;
  omitted: string[];
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function CheckpointSection(props: {
  workspaceId: string;
  conversationId: string;
  checkpoints: ConversationGraphCheckpoints | undefined;
  checkpointsEnabled: boolean;
  onToggleCheckpoints: (enabled: boolean) => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [handoffFor, setHandoffFor] = useState<string | null>(null);
  const [preview, setPreview] = useState<HandoffPreviewData | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const checkpoints = props.checkpoints;
  const base = `/api/conversations/${encodeURIComponent(props.conversationId)}/checkpoints`;
  const query = `workspaceId=${encodeURIComponent(props.workspaceId)}&conversationId=${encodeURIComponent(props.conversationId)}`;

  const request = async (url: string, init?: RequestInit): Promise<Record<string, unknown>> => {
    const response = await fetch(url, init);
    const data = (await response.json().catch(() => ({}))) as { ok?: boolean; message?: string };
    if (!response.ok || data.ok === false) throw new Error(data.message ?? `请求失败：${response.status}`);
    return data as Record<string, unknown>;
  };
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErrorText(null);
    setNotice(null);
    try {
      await fn();
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const create = () => void run(async () => {
    const data = await request(`${base}?${query}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    setNotice(data.created ? `检查点已生成：${String(data.checkpointId)}` : "内容未变化，已有相同检查点，直接复用。");
    props.onChanged();
  });
  const remove = (checkpointId: string) => void run(async () => {
    await request(`${base}/${encodeURIComponent(checkpointId)}?${query}`, { method: "DELETE" });
    setConfirmDeleteId(null);
    setNotice(`检查点 ${checkpointId} 已移入回收站（.trash，保留期后清除）。`);
    props.onChanged();
  });
  const openHandoff = (checkpointId: string) => {
    setHandoffFor(checkpointId);
    setPreview(null);
    setPreviewError(null);
    void (async () => {
      try {
        const data = await request(`${base}/${encodeURIComponent(checkpointId)}/handoff-preview?${query}`);
        setPreview(data as unknown as HandoffPreviewData);
      } catch (error) {
        setPreviewError(error instanceof Error ? error.message : String(error));
      }
    })();
  };
  const confirmHandoff = () => {
    if (!handoffFor || !preview) return;
    void run(async () => {
      const data = await request(`${base}/${encodeURIComponent(handoffFor)}/handoff?${query}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ excerptHash: preview.excerptHash }),
      });
      setHandoffFor(null);
      setPreview(null);
      setNotice(data.alreadyDone ? "该检查点已交接过，未重复创建新会话。" : `交接完成，新会话：${String(data.newConversationId)}`);
      props.onChanged();
    });
  };

  const head = (
    <div className="checkpointHead">
      <strong>检查点（防崩存档）</strong>
      <label className="problemToggle"><input type="checkbox" checked={props.checkpointsEnabled} onChange={(event) => props.onToggleCheckpoints(event.target.checked)} />启用</label>
    </div>
  );
  if (!checkpoints || !checkpoints.enabled) {
    return <section className="checkpointSection">{head}<div className="graphEmpty">检查点已关闭。</div></section>;
  }
  return <section className="checkpointSection">
    {head}
    <div className="checkpointUsage">
      本会话 {checkpoints.count} 个 · {formatBytes(checkpoints.totalBytes)} · 工作区共 {formatBytes(checkpoints.workspaceTotalBytes)}（上限：每会话 {checkpoints.maxPerConversation} 个 · 工作区 {formatBytes(checkpoints.maxWorkspaceBytes)}）
    </div>
    <div className="checkpointNote">
      稳妥版：检查点只存索引与结构，不含消息正文；正文只在交接时经你预览确认后即时摘录。
      {checkpoints.writeEnabled ? null : " 当前写操作已由服务端关闭。"}
      {checkpoints.degraded ? " 检查点数据暂时不可用（已降级）。" : null}
    </div>
    <div className="checkpointToolbar">
      <button type="button" disabled={busy || !checkpoints.writeEnabled} onClick={create}>生成检查点</button>
    </div>
    {notice ? <div className="checkpointNotice">{notice}</div> : null}
    {errorText ? <div className="checkpointError">{errorText}</div> : null}
    {checkpoints.items.length === 0 ? <div className="graphEmpty">还没有检查点。</div> : checkpoints.items.map((item) => (
      <div className="checkpointItem" key={`${item.checkpointId}:${item.status}`}>
        <div className="checkpointItemMain">
          <span className="checkpointId">{item.checkpointId}</span>
          {item.status === "deleted" ? <span className="checkpointTag deleted">源已删除</span> : null}
          {item.degraded ? <span className="checkpointTag">包损坏</span> : null}
          {item.handoffState === "done" ? <span className="checkpointTag done">已交接 → {item.handoffNewConversationId}</span> : null}
          {item.handoffState === "in-progress" ? <span className="checkpointTag">交接进行中</span> : null}
          {item.handoffState === "failed" ? <span className="checkpointTag">交接失败，可重试</span> : null}
          <span className="checkpointMeta">
            {item.createdAt ? formatDateTime(item.createdAt) : ""} · 消息 {item.messageCount} 条
            {item.sourceFrom ? ` · ${formatDateTime(item.sourceFrom)} ~ ${item.sourceTo ? formatDateTime(item.sourceTo) : ""}` : ""} · {formatBytes(item.sizeBytes)}
          </span>
        </div>
        {item.status === "ready" && !item.degraded ? (
          <div className="checkpointActions">
            <button type="button" disabled={busy || !checkpoints.writeEnabled} onClick={() => openHandoff(item.checkpointId)}>交接</button>
            {confirmDeleteId === item.checkpointId ? (
              <button type="button" disabled={busy} onClick={() => remove(item.checkpointId)}>确认删除</button>
            ) : (
              <button type="button" disabled={busy || !checkpoints.writeEnabled} onClick={() => setConfirmDeleteId(item.checkpointId)}>删除</button>
            )}
          </div>
        ) : null}
      </div>
    ))}
    {handoffFor ? (
      <div className="modalOverlay" onClick={() => { setHandoffFor(null); setPreview(null); }}>
        <div className="handoffDialog" onClick={(event) => event.stopPropagation()}>
          <div className="handoffDialogHead"><strong>交接到新会话</strong><span>{handoffFor}</span></div>
          {previewError ? <div className="checkpointError">{previewError}</div> : !preview ? (
            <div className="graphEmpty">正在组装入口材料…</div>
          ) : <>
            <div className="checkpointNote">
              入口材料以「只导入上下文」方式写入新会话，不触发员工执行；新会话不继承旧会话授权。
              摘录 {preview.excerptChars} 字{preview.omitted.length ? `；省略 ${preview.omitted.length} 项（见文末说明）` : ""}。
            </div>
            <pre className="handoffExcerpt">{preview.fullText}</pre>
            <div className="handoffDialogActions">
              <button type="button" onClick={() => { setHandoffFor(null); setPreview(null); }}>取消</button>
              <button type="button" disabled={busy} onClick={confirmHandoff}>确认交接</button>
            </div>
          </>}
        </div>
      </div>
    ) : null}
  </section>;
}

function GraphPanelView(props: {
  workspaceId: string;
  conversationId: string;
  /** 会话消息签名：变化即（防抖后）重拉导图数据，跟随实时执行。 */
  liveSignature: string;
  overlay?: boolean;
  onLocateMessage: (messageId: string) => void;
  onClose: () => void;
  onSessionsIssueChange?: (issue: boolean) => void;
}) {
  const [graph, setGraph] = useState<ConversationGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedRootId, setSelectedRootId] = useState<string>("");
  const [activeTab, setActiveTab] = useState<"tree" | "problems" | "sessions">("tree");
  const [problemsEnabled, setProblemsEnabled] = useState(true);
  const [sessionsEnabled, setSessionsEnabled] = useState(true);
  const [checkpointsEnabled, setCheckpointsEnabled] = useState(true);
  const issueRef = useRef(false);
  const issueCallbackRef = useRef(props.onSessionsIssueChange);
  issueCallbackRef.current = props.onSessionsIssueChange;
  const followLatestRef = useRef(true);
  const graphRef = useRef<ConversationGraph | null>(null);
  graphRef.current = graph;

  const fetchGraph = useCallback(async (signal: AbortSignal) => {
    if (!props.workspaceId || !props.conversationId) return;
    const query = new URLSearchParams({ workspaceId: props.workspaceId, conversationId: props.conversationId });
    if (!problemsEnabled) query.set("problems", "0");
    if (!sessionsEnabled) query.set("sessions", "0");
    if (!checkpointsEnabled) query.set("checkpoints", "0");
    const response = await fetch(
      `/api/conversations/${encodeURIComponent(props.conversationId)}/graph?${query.toString()}`,
      { signal },
    );
    if (!response.ok) throw new Error(`Graph request failed: ${response.status}`);
    const data = (await response.json()) as ConversationGraph;
    if (signal.aborted) return;
    setGraph(data);
    setError(null);
    setSelectedRootId((current) => {
      const latest = data.roots.at(-1)?.id ?? "";
      if (!current || followLatestRef.current || !data.roots.some((root) => root.id === current)) {
        followLatestRef.current = true;
        return latest;
      }
      return current;
    });
  }, [props.workspaceId, props.conversationId, problemsEnabled, sessionsEnabled, checkpointsEnabled]);

  const refreshGraph = useCallback(() => {
    const controller = new AbortController();
    fetchGraph(controller.signal).catch(() => {
      // 操作后的刷新失败时保留上一份图，下一次实时事件会再试。
    });
  }, [fetchGraph]);

  useEffect(() => {
    const controller = new AbortController();
    fetchGraph(controller.signal).catch((reason: unknown) => {
      if ((reason as { name?: string }).name !== "AbortError" && !graphRef.current) {
        setError("指令链暂时无法加载");
      }
    });
    return () => controller.abort();
  }, [fetchGraph]);

  useEffect(() => {
    if (!props.liveSignature) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      fetchGraph(controller.signal).catch(() => {
        // 实时刷新失败时保留上一份图，不打断观看；下一次事件会再试。
      });
    }, 450);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [props.liveSignature, fetchGraph]);

  useEffect(() => {
    followLatestRef.current = true;
    setSelectedRootId("");
    setGraph(null);
    setActiveTab("tree");
  }, [props.conversationId]);

  useEffect(() => {
    const sessions = graph?.conversationId === props.conversationId ? graph.sessions : undefined;
    const issue = Boolean(sessions?.enabled && (sessions.degraded || sessions.hasUnknownIntervals));
    if (issue !== issueRef.current) {
      issueRef.current = issue;
      issueCallbackRef.current?.(issue);
    }
  }, [graph, props.conversationId]);

  useEffect(() => () => {
    issueRef.current = false;
    issueCallbackRef.current?.(false);
  }, [props.conversationId]);

  const roots = graph?.roots ?? [];
  return (
    <aside className={`graphPanel${props.overlay ? " overlay" : ""}`} aria-label="指令链工作树">
      <header className="graphPanelHeader">
        <div className="graphPanelTitle">
          <strong>指令链</strong>
          <span>谁派活给谁，实时跟随</span>
        </div>
        <button type="button" className="graphPanelClose" onClick={props.onClose} title="隐藏指令链面板" aria-label="隐藏指令链面板">
          ×
        </button>
      </header>
      <div className="graphTabs" role="tablist" aria-label="指令链面板页签">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "tree"}
          className={`graphTabBtn${activeTab === "tree" ? " active" : ""}`}
          onClick={() => setActiveTab("tree")}
        >
          指令链
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "problems"}
          className={`graphTabBtn${activeTab === "problems" ? " active" : ""}`}
          onClick={() => setActiveTab("problems")}
        >
          问题台
          {graph?.problems?.enabled && graph.problems.totalItems > 0 ? (
            <span className="graphTabCount">{graph.problems.totalItems}</span>
          ) : null}
        </button>
        <button type="button" role="tab" aria-selected={activeTab === "sessions"} className={`graphTabBtn${activeTab === "sessions" ? " active" : ""}`} onClick={() => setActiveTab("sessions")}>
          会话状态
          {graph?.sessions?.enabled && graph.sessions.hasUnknownIntervals ? <span className="graphTabWarn" title="存在未记录 sessionId 的未知区间">!</span> : null}
        </button>
      </div>
      {activeTab === "sessions" ? <SessionBoard graph={graph} error={error} sessionsEnabled={sessionsEnabled} onToggleSessions={setSessionsEnabled} workspaceId={props.workspaceId} conversationId={props.conversationId} checkpointsEnabled={checkpointsEnabled} onToggleCheckpoints={setCheckpointsEnabled} onGraphChanged={refreshGraph} /> : null}
      {activeTab === "problems" ? (
        <ProblemBoard
          graph={graph}
          error={error}
          problemsEnabled={problemsEnabled}
          onToggleProblems={setProblemsEnabled}
          onLocateMessage={props.onLocateMessage}
        />
      ) : null}
      {activeTab === "tree" && roots.length > 1 ? (
        <div className="graphRootBar" role="tablist" aria-label="选择根任务">
          {roots.map((root) => (
            <button
              key={root.id}
              type="button"
              role="tab"
              aria-selected={root.id === selectedRootId}
              className={`graphRootChip ${root.id === selectedRootId ? "active" : ""}`}
              title={root.title}
              onClick={() => {
                followLatestRef.current = root.id === roots.at(-1)?.id;
                setSelectedRootId(root.id);
              }}
            >
              <span className={`graphStatusDot ${root.status}`} aria-hidden="true" />
              <span className="graphRootChipTitle">{root.title}</span>
            </button>
          ))}
        </div>
      ) : null}
      {activeTab === "tree" ? (
        <div className="graphCanvasWrap">
          {graph ? (
            <ReactFlowProvider>
              <GraphCanvas graph={graph} selectedRootId={selectedRootId} onLocateMessage={props.onLocateMessage} />
            </ReactFlowProvider>
          ) : error ? (
            <div className="graphEmpty">{error}</div>
          ) : (
            <div className="graphEmpty">加载中…</div>
          )}
        </div>
      ) : null}
    </aside>
  );
}

// P1 第一步：面板 memo 隔离。调用方（App）保证 props 引用稳定
// （字符串 props 按值比较、回调 useCallback 化），草稿输入不再让
// 面板与画布随每次按键重渲染；liveSignature 真变化时照常更新。
export const GraphPanel = memo(GraphPanelView);
