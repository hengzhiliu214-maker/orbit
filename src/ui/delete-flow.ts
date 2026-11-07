export type DeleteKind = "workspace" | "conversation";

/** Extract the server-provided message from a DELETE error body, if any. */
export function parseDeleteErrorMessage(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  const message = record.message ?? record.error;
  return typeof message === "string" && message.trim() ? message.trim() : null;
}

/**
 * Turn a failed DELETE response into text the user can act on.
 * Known server reasons are shown in Chinese; anything else keeps the
 * server's own message so the cause is never silently swallowed.
 */
export function translateDeleteFailure(status: number, serverMessage: string | null | undefined, kind: DeleteKind): string {
  const message = (serverMessage ?? "").trim();
  if (message.includes("running agents")) {
    return kind === "workspace"
      ? "有正在运行的 agent，不能删除这个工作区。请先等任务结束或取消后再试。"
      : "有正在运行的 agent，不能删除这个会话。请先等任务结束或取消后再试。";
  }
  if (message) return `删除失败：${message}`;
  return `删除失败（服务器返回 ${status}），请稍后再试。`;
}
