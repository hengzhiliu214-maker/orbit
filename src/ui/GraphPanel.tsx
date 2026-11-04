import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import "@xyflow/react/dist/style.css";

import type {
  ConversationGraph,
  ConversationGraphNode,
  ConversationGraphNodeStatus,
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

type GraphNodeData = {
  graphNode: ConversationGraphNode;
  hasChildren: boolean;
  collapsed: boolean;
  onToggleCollapse: (nodeId: string) => void;
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
        {node.runtime ? <span className="graphRuntimeBadge">{node.runtime}</span> : null}
        {node.origin === "supervisor" && !isRoot ? <span className="graphOriginBadge">监工派发</span> : null}
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
  const [flowNodes, setFlowNodes, onNodesChange] = useNodesState<FlowNode>([]);
  const [flowEdges, setFlowEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const positionsRef = useRef(new Map<string, { x: number; y: number }>());
  const structureKeyRef = useRef("");
  const fittedRootRef = useRef("");
  const reactFlow = useReactFlow();

  useEffect(() => {
    setCollapsedIds(new Set());
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
  }, [graph, selectedRootId, collapsedIds]);

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
  }, [visible, graph.nodes, selectedRootId, collapsedIds, toggleCollapse, reactFlow, setFlowNodes, setFlowEdges]);

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

export function GraphPanel(props: {
  workspaceId: string;
  conversationId: string;
  /** 会话消息签名：变化即（防抖后）重拉导图数据，跟随实时执行。 */
  liveSignature: string;
  overlay?: boolean;
  onLocateMessage: (messageId: string) => void;
  onClose: () => void;
}) {
  const [graph, setGraph] = useState<ConversationGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedRootId, setSelectedRootId] = useState<string>("");
  const followLatestRef = useRef(true);
  const graphRef = useRef<ConversationGraph | null>(null);
  graphRef.current = graph;

  const fetchGraph = useCallback(async (signal: AbortSignal) => {
    if (!props.workspaceId || !props.conversationId) return;
    const query = new URLSearchParams({ workspaceId: props.workspaceId, conversationId: props.conversationId });
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
  }, [props.workspaceId, props.conversationId]);

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
      {roots.length > 1 ? (
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
    </aside>
  );
}
