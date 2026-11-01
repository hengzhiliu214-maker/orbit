import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  buildWorkBuddyAcpArgs,
  buildWorkBuddyAcpCommand,
  resolveWorkBuddyCliPath,
} from "../src/core/workbuddy-acp-runtime.ts";

test("workbuddy launch args start ACP over stdio", () => {
  // --serve 才是启动开关、--acp 选 stdio 传输；缺 --serve 时捆绑 lite
  // 构建会立即静默退出（2026-11-02 本机实测）。
  assert.deepEqual(buildWorkBuddyAcpArgs(), ["--serve", "--acp"]);
});

test("workbuddy command selects the lite bundle via the env marker", () => {
  const command = buildWorkBuddyAcpCommand();
  assert.equal(command.env?.CODEBUDDY_FORCE_LITE_WB_BUNDLE, "1");
});

test("workbuddy CLI path always points inside an app bundle, never at PATH", () => {
  const resolved = resolveWorkBuddyCliPath();
  assert.ok(resolved.includes("WorkBuddy"), `path must stay inside the WorkBuddy app: ${resolved}`);
  assert.ok(resolved.includes("app.asar.unpacked"), `path must use the unpacked cli layout: ${resolved}`);
  assert.ok(
    resolved.endsWith("codebuddy") || resolved.endsWith("codebuddy.cmd"),
    `path must name the bundled codebuddy entry: ${resolved}`,
  );
  if (fs.existsSync(resolved)) {
    assert.ok(fs.statSync(resolved).isFile(), "resolved bundle entry must be a file when present");
  }
});
