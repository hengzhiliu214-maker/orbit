import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createAcpRuntime,
  runAcp,
  type AcpCommand,
  type AcpRuntimeDefinition,
  type AcpRunOptions,
} from "./acp-runtime.ts";
import type { AgentRuntime, AgentRuntimeRunHandle } from "./agent-runtime.ts";

export type WorkBuddyAcpRunOptions = AcpRunOptions;

/**
 * WorkBuddy 的 ACP CLI 藏在桌面应用内，与 CodeBuddy Code 的独立 CLI 同名
 * （`codebuddy`）。按 PATH 查找必然先命中独立版，因此只能在应用包内定位，
 * 绝不与 codebuddy 席位混用（路径判定思路与 Codync 的公开实现一致，
 * 其许可证为 Apache-2.0；此处为自行实现的等价逻辑）。
 */
const APP_NAMES = ["WorkBuddy.app", "WorkBuddy AI.app"] as const;
const CLI_RELATIVE_PARTS = ["Contents", "Resources", "app.asar.unpacked", "cli", "bin", "codebuddy"] as const;

function candidateCliPaths(): string[] {
  if (os.platform() === "win32") {
    const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
    return ["WorkBuddy", "WorkBuddy AI"].map((folder) =>
      path.join(localAppData, "Programs", folder, "resources", "app.asar.unpacked", "cli", "bin", "codebuddy.cmd"),
    );
  }
  const roots = ["/Applications", path.join(os.homedir(), "Applications")];
  const candidates: string[] = [];
  for (const root of roots) {
    for (const app of APP_NAMES) {
      candidates.push(path.join(root, app, ...CLI_RELATIVE_PARTS));
    }
  }
  return candidates;
}

export function resolveWorkBuddyCliPath(): string {
  const candidates = candidateCliPaths();
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  // 回退到首选候选：可用性探测会以 existsSync 如实报告未安装。
  return candidates[0]!;
}

export function buildWorkBuddyAcpArgs(): string[] {
  // `--serve` 才是启动 ACP 服务端的开关；`--acp` 只选 stdio 传输
  // （捆绑 lite 构建实测：仅 `--acp` 会立即静默退出）。
  return ["--serve", "--acp"];
}

export function buildWorkBuddyAcpCommand(): AcpCommand {
  const args = buildWorkBuddyAcpArgs();
  const env = {
    // 桌面应用只随附 lite 构建（codebuddy-lite-wb.mjs）；不置位时启动器
    // 会去加载应用内不存在的 headless 构建。
    CODEBUDDY_FORCE_LITE_WB_BUNDLE: "1",
  };
  if (os.platform() === "win32") {
    // .cmd 不能直接 spawn，与 codebuddy/dsh 的 Windows 处理一致地包一层
    // cmd.exe（该分支未在本机实测，macOS 为已验证平台）。
    return { file: "cmd.exe", args: ["/d", "/s", "/c", resolveWorkBuddyCliPath(), ...args], env };
  }
  return { file: resolveWorkBuddyCliPath(), args, env };
}

/**
 * WorkBuddy 执行席位：驱动桌面应用捆绑的 lite CLI（WorkBuddy.app 5.9.3
 * 捆绑 2.165.0，2026-11-02 本机探针实测）。与 codebuddy 席位是独立身份：
 * 二进制来源、模型清单与会话状态互不相干。initialize 与 session/new
 * 无需交互登录即可应答；其 ACP 能力面（loadSession、configOptions 的
 * mode/model/thought_level 等）由共享层按运行时实际返回处理。
 *
 * 已知形态：进程启动时会在 stdout 先打印一段横幅（非 JSON 行），并
 * 同时在本机回环地址上开启一个带口令的 HTTP 服务端
 * （`--serve` 的固有行为，进程退出即关闭）。无 runtime 专属钩子：历史
 * 回放/恢复语义未单独验证，与 dsh 接入时的证据口径相同。
 */
export const WORKBUDDY_ACP: AcpRuntimeDefinition = {
  kind: "workbuddy",
  displayName: "WorkBuddy",
  buildCommand: buildWorkBuddyAcpCommand,
};

export function createWorkBuddyAcpRuntime(): AgentRuntime {
  return createAcpRuntime(WORKBUDDY_ACP);
}

export function runWorkBuddyAcp(options: WorkBuddyAcpRunOptions): AgentRuntimeRunHandle {
  return runAcp(options, WORKBUDDY_ACP);
}

export const workbuddyRuntime = createWorkBuddyAcpRuntime();
