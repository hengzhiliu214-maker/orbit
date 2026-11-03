import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type RevealResolution =
  | { ok: true; target: string; isDirectory: boolean }
  | { ok: false; status: 400 | 403 | 404; message: string };

// 比较前归一化：统一分隔符、去掉尾部斜杠。Windows 与 macOS 的默认文件
// 系统不区分大小写，转小写比较；Linux 区分大小写，保留原样精确比较——
// 小写化会让 /SRV/app 在工作区 /srv/app 下被误判为界内（假放行）。返回
// 给 UI 的 target 始终保留 fs.realpath 的真实大小写。
const caseInsensitiveFs = process.platform === "win32" || process.platform === "darwin";

function normalizeForCompare(p: string): string {
  const unified = p.replace(/\\/g, "/").replace(/\/+$/, "");
  return caseInsensitiveFs ? unified.toLowerCase() : unified;
}

export function isInsideWorkspaces(candidate: string, roots: string[]): boolean {
  const normalized = normalizeForCompare(candidate);
  return roots.some((root) => {
    const base = normalizeForCompare(root);
    if (!base) return false;
    return normalized === base || normalized.startsWith(`${base}/`);
  });
}

async function realpathOrNull(p: string): Promise<string | null> {
  try {
    return await fs.promises.realpath(p);
  } catch {
    return null;
  }
}

export async function resolveRevealTarget(rawPath: string, roots: string[]): Promise<RevealResolution> {
  if (typeof rawPath !== "string" || !rawPath.trim()) {
    return { ok: false, status: 400, message: "path is required." };
  }
  let candidate = rawPath.trim();
  if (candidate === "~") {
    candidate = os.homedir();
  } else if (candidate.startsWith("~/") || candidate.startsWith("~\\")) {
    candidate = path.join(os.homedir(), candidate.slice(2));
  }
  let resolved = await realpathOrNull(candidate);
  if (!resolved) {
    // 源码引用常带 :line 或 :line:col 后缀（styles.css:5127），realpath 失败
    // 时剥掉后缀重试，让入口仍能定位到文件本身。
    const withoutLine = candidate.replace(/:\d+(?::\d+)?$/, "");
    if (withoutLine !== candidate) {
      resolved = await realpathOrNull(withoutLine);
    }
  }
  if (!resolved) {
    return { ok: false, status: 404, message: `路径不存在：${candidate}` };
  }
  // 默认决策 D2：仅允许定位到已配置工作区内的路径，防止消息内容把资源
  // 管理器指向任意本机目录（issue #143）。
  // candidate 已经走过 fs.realpath，是真实路径；而 roots 来自配置串，可能是
  // 软链或未真实化的路径。比较前把每个根也解析为真实路径，使两侧对称——
  // 否则 macOS 上 /var → /private/var 会让界内目标被误判为界外（403），
  // 生产同样受影响。不存在 / 空 / 非法的根直接丢弃：既不扩大授权范围，
  // 也不会因 realpath 失败抛错产生 500。realpath 必须传配置原值：目录名的
  // 尾部空格是路径的一部分，trim 会把它换成另一个真实目录，使本应界外拒绝
  // 的目标被错误放行。
  const resolvedRoots: string[] = [];
  for (const root of roots) {
    // trim 只用于判空：纯空白根不能被当成相对路径交给 realpath 按 cwd 解析；
    // 交给 realpath 的仍是配置原值，保留目录名尾部空格。其余解析失败由
    // realpathOrNull 返回 null 丢弃（fail-closed，不抛 500）。
    if (typeof root !== "string" || root.trim().length === 0) continue;
    const realRoot = await realpathOrNull(root);
    if (realRoot) resolvedRoots.push(realRoot);
  }
  if (!isInsideWorkspaces(resolved, resolvedRoots)) {
    return {
      ok: false,
      status: 403,
      message: "该路径不在任何已配置的工作区内，出于安全考虑不在资源管理器中打开。",
    };
  }
  const stats = await fs.promises.stat(resolved);
  return { ok: true, target: resolved, isDirectory: stats.isDirectory() };
}

export async function revealInFileManager(target: string, isDirectory: boolean): Promise<void> {
  if (process.platform === "win32") {
    try {
      if (isDirectory) {
        await execFileAsync("explorer", [target]);
      } else {
        await execFileAsync("explorer", [`/select,${target}`]);
      }
    } catch (err) {
      // explorer.exe 即使成功打开窗口也常以退出码 1 结束，这里不能据此报错。
      const code = (err as { code?: number | string } | null)?.code;
      if (code !== 1) throw err;
    }
    return;
  }
  if (process.platform === "darwin") {
    await execFileAsync("open", isDirectory ? [target] : ["-R", target]);
    return;
  }
  await execFileAsync("xdg-open", [isDirectory ? target : path.dirname(target)]);
}
