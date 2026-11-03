import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { findStaleSnapshotPreferenceOverwrite } from "../src/core/agent-model-guard.ts";
import { modelChoicesWithSavedPreference } from "../src/ui/App.tsx";
import type { AgentConfig, AgentModelChoice, AgentModelStateSnapshot } from "../src/shared/types.ts";

// 与真实事故同形的取值：dsh 的模型偏好是 [provider, model] 配对 JSON 字符串。
const WORKBUDDY_PAIR = "[\"workbuddy-cn\",\"deepseek-v4.1-flash\"]";
const OFFICIAL_PAIR = "[\"deepseek-official\",\"deepseek-v4-flash\"]";

function dshConfig(model: AgentConfig["model"]): AgentConfig {
  return {
    id: "verification",
    name: "DeepSeek-Harness",
    runtime: "dsh",
    systemPrompt: "按本轮协作规则处理任务并回复。",
    enabled: true,
    ...(model ? { model } : {}),
  };
}

function dshSnapshot(overrides: Partial<AgentModelStateSnapshot> = {}): AgentModelStateSnapshot {
  return {
    agentId: "verification",
    runtimeKind: "dsh",
    configId: "model",
    // 过期快照：接通 workbuddy-cn 之前留下的列表，没有新通道的选项。
    choices: [{ value: OFFICIAL_PAIR, name: "DeepSeek V4 Flash" }],
    currentValue: OFFICIAL_PAIR,
    currentValueSource: "session",
    updatedAt: "2026-11-02T10:40:00.000Z",
    ...overrides,
  };
}

test("设置页选项补齐：快照过期时已保存偏好被补进选项列表，成为可显示的当前值", () => {
  const staleChoices: AgentModelChoice[] = [{ value: OFFICIAL_PAIR, name: "DeepSeek V4 Flash" }];
  const display = modelChoicesWithSavedPreference(staleChoices, WORKBUDDY_PAIR);
  assert.equal(display.length, 2);
  assert.equal(display.filter((choice) => choice.value === WORKBUDDY_PAIR).length, 1);
  // 组件以 config.model 为选中值：补齐后该值在列表中有对应选项，不再无单选被选中。
  assert.ok(display.some((choice) => choice.value === WORKBUDDY_PAIR));
});

test("设置页选项补齐：偏好已在列表中或未设偏好时列表不变", () => {
  const choices: AgentModelChoice[] = [
    { value: OFFICIAL_PAIR, name: "DeepSeek V4 Flash" },
    { value: WORKBUDDY_PAIR, name: "DeepSeek V4.1 Flash" },
  ];
  assert.deepEqual(modelChoicesWithSavedPreference(choices, WORKBUDDY_PAIR), choices);
  assert.deepEqual(modelChoicesWithSavedPreference(choices, undefined), choices);
});

test("保存防护：载荷把偏好盖回过期会话快照的当前值时命中拦截", () => {
  const stored = [dshConfig({ preferredModelId: WORKBUDDY_PAIR, runtimeKind: "dsh" })];
  const incoming = [dshConfig({ preferredModelId: OFFICIAL_PAIR, runtimeKind: "dsh" })];
  const hit = findStaleSnapshotPreferenceOverwrite(stored, incoming, { verification: dshSnapshot() });
  assert.equal(hit?.agentId, "verification");
  assert.equal(hit?.field, "model");
  assert.equal(hit?.storedValue, WORKBUDDY_PAIR);
  assert.equal(hit?.incomingValue, OFFICIAL_PAIR);
});

test("保存防护：直接保存（载荷偏好与库内一致）不拦截", () => {
  const stored = [dshConfig({ preferredModelId: WORKBUDDY_PAIR, runtimeKind: "dsh" })];
  const incoming = [dshConfig({ preferredModelId: WORKBUDDY_PAIR, runtimeKind: "dsh" })];
  assert.equal(findStaleSnapshotPreferenceOverwrite(stored, incoming, { verification: dshSnapshot() }), undefined);
});

test("保存防护：改成与快照无关的新值不拦截", () => {
  const stored = [dshConfig({ preferredModelId: WORKBUDDY_PAIR, runtimeKind: "dsh" })];
  const incoming = [dshConfig({ preferredModelId: "[\"workbuddy-cn\",\"glm-5.3-flash\"]", runtimeKind: "dsh" })];
  assert.equal(findStaleSnapshotPreferenceOverwrite(stored, incoming, { verification: dshSnapshot() }), undefined);
});

test("保存防护：快照来源为 probe 时同样的值不拦截（刷新不会自动改回已保存偏好，Dot 0094）", () => {
  // 本用例只验证函数对 probe 来源快照本身的判定。对已有会话确认值的
  // 员工，设置页刷新按合同保留会话来源（探针不得覆盖会话确认的
  // currentValue 与来源），且 mergeProbedConfigs 保留本地未保存的
  // model 选择，刷新后同一保存仍会被拦——因此不能把本用例读作
  // 「点刷新即可解开拦截」；准确口径见 agent-model-guard.ts。
  const stored = [dshConfig({ preferredModelId: WORKBUDDY_PAIR, runtimeKind: "dsh" })];
  const incoming = [dshConfig({ preferredModelId: OFFICIAL_PAIR, runtimeKind: "dsh" })];
  const probed = dshSnapshot({ currentValueSource: "probe" });
  assert.equal(findStaleSnapshotPreferenceOverwrite(stored, incoming, { verification: probed }), undefined);
});

test("保存防护：没有已保存偏好时首次设定不拦截；清除偏好不拦截", () => {
  const stored = [dshConfig(undefined)];
  const incoming = [dshConfig({ preferredModelId: OFFICIAL_PAIR, runtimeKind: "dsh" })];
  assert.equal(findStaleSnapshotPreferenceOverwrite(stored, incoming, { verification: dshSnapshot() }), undefined);

  const storedWithPref = [dshConfig({ preferredModelId: WORKBUDDY_PAIR, runtimeKind: "dsh" })];
  const cleared = [dshConfig(undefined)];
  assert.equal(findStaleSnapshotPreferenceOverwrite(storedWithPref, cleared, { verification: dshSnapshot() }), undefined);
});

test("保存防护：切换运行时的保存不按旧快照判断", () => {
  const stored = [dshConfig({ preferredModelId: WORKBUDDY_PAIR, runtimeKind: "dsh" })];
  const switched: AgentConfig = { ...dshConfig({ preferredModelId: OFFICIAL_PAIR, runtimeKind: "codex" }), runtime: "codex" };
  assert.equal(findStaleSnapshotPreferenceOverwrite(stored, [switched], { verification: dshSnapshot() }), undefined);
});

test("409 文案（Dot 0094）：不承诺刷新自动重置，给出经验证的恢复步骤，并保留特定签名口径", () => {
  const serverSource = fs.readFileSync(
    path.resolve(import.meta.dirname, "../src/server/index.ts"),
    "utf-8",
  );
  const guardSource = fs.readFileSync(
    path.resolve(import.meta.dirname, "../src/core/agent-model-guard.ts"),
    "utf-8",
  );
  // 旧误导口径（刷新会以已保存偏好为选中项提交）不得再出现。
  assert.ok(!serverSource.includes("并以已保存偏好为选中项提交"), "409 文案不得再暗示刷新会以已保存偏好提交");
  assert.ok(!guardSource.includes("并作为选中"), "守卫注释不得再暗示刷新会以已保存偏好提交");
  // 经代码验证的恢复步骤：关面板不保存、重开后改回标注「已保存的首选」项。
  assert.ok(serverSource.includes("关闭设置面板且不要保存"), "409 文案须给出关面板重开的恢复步骤");
  assert.ok(serverSource.includes("已保存的首选"), "409 文案须指向标注「已保存的首选」的选项");
  assert.ok(serverSource.includes("不会自动把已修改的选择改回已保存偏好"), "409 文案须明确刷新不自动重置");
  assert.ok(serverSource.includes("特定签名"), "409 文案须保留守卫只拦特定签名的口径");
  assert.ok(guardSource.includes("mergeProbedConfigs"), "守卫注释须记录刷新保留未保存选择的机制依据");
});

test("保存防护：思考强度被盖回过期会话值同样命中", () => {
  const stored = [dshConfig({ preferredModelId: WORKBUDDY_PAIR, preferredReasoningValue: "max", runtimeKind: "dsh" })];
  const incoming = [dshConfig({ preferredModelId: WORKBUDDY_PAIR, preferredReasoningValue: "high", runtimeKind: "dsh" })];
  const snapshot = dshSnapshot({
    currentValue: WORKBUDDY_PAIR,
    reasoning: {
      configId: "reasoning_effort",
      choices: [
        { value: "high", name: "High" },
        { value: "max", name: "Max" },
      ],
      currentValue: "high",
      currentValueSource: "session",
      updatedAt: "2026-11-02T10:40:00.000Z",
    },
  });
  const hit = findStaleSnapshotPreferenceOverwrite(stored, incoming, { verification: snapshot });
  assert.equal(hit?.field, "reasoning");
  assert.equal(hit?.storedValue, "max");
  assert.equal(hit?.incomingValue, "high");
});
