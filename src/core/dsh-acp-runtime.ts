import os from "node:os";

import {
  createAcpRuntime,
  runAcp,
  type AcpRuntimeDefinition,
  type AcpRunOptions,
} from "./acp-runtime.ts";
import type { AgentRuntime, AgentRuntimeRunHandle } from "./agent-runtime.ts";

export type DshAcpRunOptions = AcpRunOptions;

export function buildDshAcpArgs(): string[] {
  return ["--profile", "acp"];
}

export function buildDshAcpCommand(): { file: string; args: string[] } {
  const args = buildDshAcpArgs();
  if (os.platform() !== "win32") {
    return { file: "dsh", args };
  }

  return { file: "cmd.exe", args: ["/d", "/s", "/c", "dsh.cmd", ...args] };
}

/**
 * DeepSeek Harness (dsh) speaks ACP v1 natively through its `acp` profile
 * (dsh >= 0.2.1-rc.3). It advertises session resume (not load) and does not
 * replay history, so no runtime-specific update hooks are needed: the shared
 * ACP layer's defaults (messageId answer grouping, generic tool projection)
 * apply. Its model choice arrives as a session config option (id "model"),
 * which the shared model-probe already understands.
 */
export const DSH_ACP: AcpRuntimeDefinition = {
  kind: "dsh",
  displayName: "DeepSeek Harness",
  buildCommand: buildDshAcpCommand,
};

export function createDshAcpRuntime(): AgentRuntime {
  return createAcpRuntime(DSH_ACP);
}

export function runDshAcp(options: DshAcpRunOptions): AgentRuntimeRunHandle {
  return runAcp(options, DSH_ACP);
}

export const dshRuntime = createDshAcpRuntime();
