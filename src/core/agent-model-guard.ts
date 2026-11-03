import type { AgentConfig, AgentModelStateSnapshot } from "../shared/types.ts";

/**
 * 设置页保存防护（settings-save-guard）。
 *
 * 背景：员工设置页以整表 PUT /api/agents 保存，服务端对载荷里的 model 偏好
 * 原样落盘、不与库内现值比对。模型快照（agent-model-state）是 runtime 会话
 * 的运行时记录，可能过期（例如新模型通道接通之前留下的快照：可选列表里没有
 * 新通道，上次会话模型还是旧值）；设置页又把这份快照的上次会话值标注为
 * 「当前」、把不在过期列表里的已保存偏好标注为「当前不可用」，过期的当前值
 * 因此可能被带进保存载荷，把较新的偏好静默盖回旧值。
 *
 * 本函数只识别这一签名：某员工的已保存偏好存在，载荷偏好与之不同，且载荷
 * 偏好恰好等于该员工会话快照的 currentValue（来源为真实会话）。命中即由
 * 调用方拒绝保存并提示先刷新模型列表——刷新后快照被探测结果更新，来源变
 * 为 probe，签名不再成立，同一保存即可通过。正常修改偏好（值来自最新列表、
 * 或与快照当前值无关）不受影响；员工没有已保存偏好时首次设定也不拦截。
 */
export type StalePreferenceField = "model" | "reasoning";

export type StalePreferenceOverwrite = {
  agentId: AgentConfig["id"];
  agentName: string;
  field: StalePreferenceField;
  storedValue: string;
  incomingValue: string;
};

function effectiveModelPreference(config: AgentConfig): string | undefined {
  return config.model?.runtimeKind === config.runtime
    ? config.model?.preferredModelId?.trim() || undefined
    : undefined;
}

function effectiveReasoningPreference(config: AgentConfig): string | undefined {
  return config.model?.runtimeKind === config.runtime
    ? config.model?.preferredReasoningValue?.trim() || undefined
    : undefined;
}

export function findStaleSnapshotPreferenceOverwrite(
  stored: AgentConfig[],
  incoming: AgentConfig[],
  snapshots: Record<string, AgentModelStateSnapshot>,
): StalePreferenceOverwrite | undefined {
  const storedById = new Map(stored.map((config) => [config.id, config]));
  for (const next of incoming) {
    const current = storedById.get(next.id);
    // 新员工、或本次保存同时切换了运行时：偏好归属已经变化，不按旧快照判断。
    if (!current || current.runtime !== next.runtime) continue;
    const snapshot = snapshots[next.id];
    if (!snapshot || snapshot.runtimeKind !== next.runtime) continue;

    const storedModel = effectiveModelPreference(current);
    const incomingModel = effectiveModelPreference(next);
    if (
      storedModel !== undefined
      && incomingModel !== undefined
      && incomingModel !== storedModel
      && snapshot.currentValueSource === "session"
      && snapshot.currentValue === incomingModel
    ) {
      return {
        agentId: next.id,
        agentName: next.name || next.id,
        field: "model",
        storedValue: storedModel,
        incomingValue: incomingModel,
      };
    }

    const storedReasoning = effectiveReasoningPreference(current);
    const incomingReasoning = effectiveReasoningPreference(next);
    const reasoning = snapshot.reasoning;
    if (
      storedReasoning !== undefined
      && incomingReasoning !== undefined
      && incomingReasoning !== storedReasoning
      && reasoning?.currentValueSource === "session"
      && reasoning.currentValue === incomingReasoning
    ) {
      return {
        agentId: next.id,
        agentName: next.name || next.id,
        field: "reasoning",
        storedValue: storedReasoning,
        incomingValue: incomingReasoning,
      };
    }
  }
  return undefined;
}
