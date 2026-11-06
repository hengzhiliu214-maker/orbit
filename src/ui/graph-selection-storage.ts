/**
 * 指令链选中根持久化（P2a，0136 第四节）。
 *
 * 存储形态：localStorage，键按 workspaceId + conversationId 区分，
 * 值带存储版本号（v1），内容为 { version, workspaceId, conversationId,
 * rootId, followLatest }。键与值都校验归属，串会话/脏数据不恢复。
 *
 * 语义（调用方 GraphPanel 负责时序，本模块只做纯存取与纯决议）：
 * - 首次进入（无 stored）：followLatest = 开。
 * - 手选任一根即关跟随，永不因“恰好在看最新根”自动重开。
 * - 恢复选择只在成功拿到完整图之后；加载中 / 失败 / 空图不消费、不清。
 * - 双窗口不互抢：各窗口内存选择独立；持久化只影响下次打开，
 *   不监听 storage 事件去拽另一个窗口。
 */

export type GraphSelection = {
  rootId: string;
  followLatest: boolean;
};

/** localStorage 的最小子集：便于测试注入假存储，也兼容浏览器原对象。 */
export type GraphSelectionStore = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

export const GRAPH_SELECTION_STORAGE_VERSION = 1;

export function graphSelectionKey(workspaceId: string, conversationId: string): string {
  return `orbit.graphSelection.v${GRAPH_SELECTION_STORAGE_VERSION}:${encodeURIComponent(workspaceId)}:${encodeURIComponent(conversationId)}`;
}

export function loadGraphSelection(
  store: GraphSelectionStore,
  workspaceId: string,
  conversationId: string,
): GraphSelection | null {
  let raw: string | null;
  try {
    raw = store.getItem(graphSelectionKey(workspaceId, conversationId));
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const data: unknown = JSON.parse(raw);
    if (!data || typeof data !== "object") return null;
    const record = data as Record<string, unknown>;
    if (record.version !== GRAPH_SELECTION_STORAGE_VERSION) return null;
    if (record.workspaceId !== workspaceId || record.conversationId !== conversationId) return null;
    if (typeof record.rootId !== "string" || record.rootId === "") return null;
    if (typeof record.followLatest !== "boolean") return null;
    return { rootId: record.rootId, followLatest: record.followLatest };
  } catch {
    return null;
  }
}

export function saveGraphSelection(
  store: GraphSelectionStore,
  workspaceId: string,
  conversationId: string,
  selection: GraphSelection,
): void {
  try {
    store.setItem(
      graphSelectionKey(workspaceId, conversationId),
      JSON.stringify({
        version: GRAPH_SELECTION_STORAGE_VERSION,
        workspaceId,
        conversationId,
        rootId: selection.rootId,
        followLatest: selection.followLatest,
      }),
    );
  } catch {
    // 存储不可用时仅本次会话内生效，不抛错打断面板。
  }
}

export type GraphRootRef = { id: string };

export type ResolvedGraphSelection = {
  rootId: string;
  followLatest: boolean;
  /** stored/已选根被成功快照确认不存在（调用方据此提示用户）。 */
  missingStoredRoot: boolean;
};

function latestRootId(roots: readonly GraphRootRef[]): string {
  return roots.at(-1)?.id ?? "";
}

/**
 * 首次成功拿到完整图后的恢复决议。空图返回 null（调用方不消费、
 * 不清 stored、不标记已恢复，等下一次成功快照再议）。
 */
export function resolveRestoredSelection(
  stored: GraphSelection | null,
  roots: readonly GraphRootRef[],
): ResolvedGraphSelection | null {
  if (roots.length === 0) return null;
  const latest = latestRootId(roots);
  if (!stored) return { rootId: latest, followLatest: true, missingStoredRoot: false };
  if (stored.followLatest) return { rootId: latest, followLatest: true, missingStoredRoot: false };
  if (roots.some((root) => root.id === stored.rootId)) {
    return { rootId: stored.rootId, followLatest: false, missingStoredRoot: false };
  }
  return { rootId: latest, followLatest: false, missingStoredRoot: true };
}

/**
 * 已恢复后、每次成功快照到达时的选中决议。空图返回 null（保持原选择）。
 * 跟随开 → 跳最新；跟随关且已选根仍在 → 保持；已选根被快照确认不在 →
 * 落到最新可用根并报 missing（跟随保持关）。
 */
export function resolveSelectionOnSnapshot(
  currentRootId: string,
  followLatest: boolean,
  roots: readonly GraphRootRef[],
): ResolvedGraphSelection | null {
  if (roots.length === 0) return null;
  const latest = latestRootId(roots);
  if (followLatest) return { rootId: latest, followLatest: true, missingStoredRoot: false };
  if (currentRootId && roots.some((root) => root.id === currentRootId)) {
    return { rootId: currentRootId, followLatest: false, missingStoredRoot: false };
  }
  return {
    rootId: latest,
    followLatest: false,
    missingStoredRoot: currentRootId !== "",
  };
}
