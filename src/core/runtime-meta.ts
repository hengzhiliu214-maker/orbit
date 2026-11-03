import type { AgentRuntimeKind } from "../shared/types.ts";

/** Preference order whenever a runtime is picked implicitly (supervisor seeding,
 * preset fallback pools, settings-page defaults). Codex is the default first pick;
 * claude-code remains selectable but is never the implicit default. */
export const AGENT_RUNTIME_PRIORITY: readonly AgentRuntimeKind[] = ["codex", "codebuddy", "dsh", "workbuddy", "claude-code"];

/** Map AgentRuntimeKind to the executable used by its transport. */
export function runtimeKindToCliKey(runtime: string): string {
  if (runtime === "claude-code") return "claude-agent-acp";
  if (runtime === "codex") return "codex-acp";
  return runtime;
}

/** Shared runtime metadata — labels, setup commands, and install URLs in one place */
export type RuntimeMeta = { label: string; installUrl: string; installCommand: string };

export function runtimeMeta(runtime: string): RuntimeMeta {
  switch (runtime) {
    case "claude-code":
      return {
        label: "Claude Code",
        installUrl: "https://docs.anthropic.com/en/docs/claude-code/overview",
        installCommand: "",
      };
    case "codex":
      return {
        label: "OpenAI Codex",
        installUrl: "https://github.com/openai/codex",
        installCommand: "",
      };
    case "codebuddy":
      return {
        label: "CodeBuddy",
        installUrl: "https://www.codebuddy.ai/docs/cli/installation",
        installCommand: "npm install -g @tencent-ai/codebuddy-code",
      };
    case "dsh":
      return {
        label: "DeepSeek Harness",
        installUrl: "https://github.com/deepseek-ai/deepseek-harness",
        installCommand: "",
      };
    case "workbuddy":
      return {
        label: "WorkBuddy",
        installUrl: "https://www.workbuddy.ai",
        installCommand: "",
      };
    default:
      return { label: runtime, installUrl: "", installCommand: "" };
  }
}
