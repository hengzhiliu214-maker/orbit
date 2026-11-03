import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isInsideWorkspaces, resolveRevealTarget } from "../src/server/local-path-reveal.ts";

test("isInsideWorkspaces accepts exact roots and nested paths with separator tolerance", () => {
  const roots = ["D:\\Projects\\Orbit"];
  assert.equal(isInsideWorkspaces("D:/Projects/Orbit", roots), true);
  assert.equal(isInsideWorkspaces("D:\\Projects\\Orbit\\src\\ui", roots), true);
  assert.equal(isInsideWorkspaces("D:/Projects/Orbit/", roots), true);
  assert.equal(isInsideWorkspaces("D:/Projects/Orbit-other", roots), false, "prefix without separator must not match");
  assert.equal(isInsideWorkspaces("E:/elsewhere", roots), false);
  assert.equal(isInsideWorkspaces("D:/Projects/Orbit", []), false, "no configured roots means nothing is allowed");
});

// Windows 与 macOS 文件系统不区分大小写，比较时折叠大小写；Linux 精确
// 比较，异大小写路径不会在工作区内被假放行。
test("isInsideWorkspaces folds case only on case-insensitive platforms", () => {
  const roots = ["D:\\Projects\\Orbit"];
  if (process.platform === "linux") {
    assert.equal(isInsideWorkspaces("D:/projects/orbit", roots), false, "linux must compare case-sensitively");
    return;
  }
  assert.equal(isInsideWorkspaces("D:/projects/orbit", roots), true);
  assert.equal(isInsideWorkspaces("d:\\projects\\orbit\\src\\ui", roots), true);
});

test("resolveRevealTarget resolves files inside a configured workspace", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-reveal-"));
  try {
    const file = path.join(root, "styles.css");
    fs.writeFileSync(file, "body {}");
    const result = await resolveRevealTarget(file, [root]);
    assert.ok(result.ok);
    assert.equal(result.target, fs.realpathSync(file));
    assert.equal(result.isDirectory, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolveRevealTarget strips :line suffixes so source references still resolve", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-reveal-"));
  try {
    const file = path.join(root, "App.tsx");
    fs.writeFileSync(file, "export {}");
    const result = await resolveRevealTarget(`${file}:5127`, [root]);
    assert.ok(result.ok);
    assert.equal(result.target, fs.realpathSync(file));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolveRevealTarget resolves directories", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-reveal-"));
  try {
    const dir = path.join(root, "src");
    fs.mkdirSync(dir);
    const result = await resolveRevealTarget(dir, [root]);
    assert.ok(result.ok);
    assert.equal(result.isDirectory, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolveRevealTarget rejects paths outside every configured workspace", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-reveal-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-outside-"));
  try {
    const file = path.join(outside, "secret.txt");
    fs.writeFileSync(file, "x");
    const result = await resolveRevealTarget(file, [root]);
    assert.ok(!result.ok);
    assert.equal(result.status, 403);
    assert.ok(result.message.includes("工作区"), `expected workspace denial message in: ${result.message}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("resolveRevealTarget reports missing paths as 404", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-reveal-"));
  try {
    const result = await resolveRevealTarget(path.join(root, "missing.txt:12"), [root]);
    assert.ok(!result.ok);
    assert.equal(result.status, 404);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolveRevealTarget expands ~ against the user home directory", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-reveal-"));
  t.mock.method(os, "homedir", () => root);
  try {
    const file = path.join(root, "notes.md");
    fs.writeFileSync(file, "note");
    const result = await resolveRevealTarget("~/notes.md", [root]);
    assert.ok(result.ok);
    assert.equal(result.target, fs.realpathSync(file));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolveRevealTarget rejects empty input", async () => {
  const result = await resolveRevealTarget("   ", []);
  assert.ok(!result.ok);
  assert.equal(result.status, 400);
});

// 路径归一化回归：candidate 走 fs.realpath，而 roots 曾经用原样配置串直接
// 比较，两侧不对称。显式构造软链，使回归不依赖 tmpdir 本身是否为软链
// （macOS 的 os.tmpdir() 常为 /var → /private/var，Linux 上 /tmp 则通常
// 已真实化），在 Linux / Windows 同样能复现。win32 用 junction 建目录软链，
// 不需要管理员权限；建不出来时跳过，避免在受限环境误报红。
function makeDirSymlink(target: string, linkPath: string): boolean {
  try {
    fs.symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch {
    return false;
  }
}

test("resolveRevealTarget accepts a symlinked workspace root with a real target", async (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-symlink-"));
  try {
    const realDir = path.join(parent, "real");
    fs.mkdirSync(realDir);
    const file = path.join(realDir, "styles.css");
    fs.writeFileSync(file, "body {}");
    const linkRoot = path.join(parent, "link");
    if (!makeDirSymlink(realDir, linkRoot)) {
      t.skip("directory symlinks unavailable");
      return;
    }
    // 根给的是软链路径、目标是真实目录下的文件：两侧都 realpath 后应判界内。
    const result = await resolveRevealTarget(file, [linkRoot]);
    assert.ok(result.ok, `expected ok, got ${JSON.stringify(result)}`);
    assert.equal(result.target, fs.realpathSync(file));
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("resolveRevealTarget accepts a real workspace root reached through a symlinked target", async (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-symlink-"));
  try {
    const realDir = path.join(parent, "real");
    fs.mkdirSync(realDir);
    const file = path.join(realDir, "App.tsx");
    fs.writeFileSync(file, "export {}");
    const linkRoot = path.join(parent, "link");
    if (!makeDirSymlink(realDir, linkRoot)) {
      t.skip("directory symlinks unavailable");
      return;
    }
    // 反向：根是真实路径，目标经软链进入；realpath 后仍应判界内。
    const viaLink = path.join(linkRoot, "App.tsx");
    const result = await resolveRevealTarget(viaLink, [realDir]);
    assert.ok(result.ok, `expected ok, got ${JSON.stringify(result)}`);
    assert.equal(result.target, fs.realpathSync(file));
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("resolveRevealTarget rejects an in-workspace symlink that escapes out of the workspace", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-reveal-ws-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-reveal-out-"));
  try {
    const secret = path.join(outside, "secret.txt");
    fs.writeFileSync(secret, "x");
    const escapeLink = path.join(workspace, "escape");
    if (!makeDirSymlink(outside, escapeLink)) {
      t.skip("directory symlinks unavailable");
      return;
    }
    const escaped = await resolveRevealTarget(path.join(escapeLink, "secret.txt"), [workspace]);
    assert.ok(!escaped.ok, "an escaping symlink must not be revealed");
    assert.equal(escaped.status, 403);

    // 正向对照：界内软链不应被过度拒绝。
    const sub = path.join(workspace, "sub");
    fs.mkdirSync(sub);
    const insideFile = path.join(sub, "notes.md");
    fs.writeFileSync(insideFile, "note");
    const innerLink = path.join(workspace, "inner");
    assert.ok(makeDirSymlink(sub, innerLink));
    const allowed = await resolveRevealTarget(path.join(innerLink, "notes.md"), [workspace]);
    assert.ok(allowed.ok, `in-workspace symlink must be allowed, got ${JSON.stringify(allowed)}`);
    assert.equal(allowed.target, fs.realpathSync(insideFile));
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("resolveRevealTarget ignores invalid roots without widening access or throwing", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-reveal-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-reveal-out-"));
  // 造一个保证不存在的根目录字符串。
  const missing = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-reveal-missing-"));
  fs.rmSync(missing, { recursive: true, force: true });
  try {
    const file = path.join(root, "file.txt");
    fs.writeFileSync(file, "x");
    const outsideFile = path.join(outside, "secret.txt");
    fs.writeFileSync(outsideFile, "x");

    // 仅无效根 / 无根 / 空根混合：授权范围不扩大，且不能抛错（500）。
    for (const invalidRoots of [[missing], [], ["", "   ", missing]]) {
      const inside = await resolveRevealTarget(file, invalidRoots);
      assert.ok(!inside.ok, `invalid roots must not authorize: ${JSON.stringify(invalidRoots)}`);
      assert.equal(inside.status, 403);
      const out = await resolveRevealTarget(outsideFile, invalidRoots);
      assert.ok(!out.ok);
      assert.equal(out.status, 403);
    }

    // 有效根与无效根并存时，有效根仍生效，界外路径仍拒绝。
    const mixed = await resolveRevealTarget(file, [missing, root]);
    assert.ok(mixed.ok, `valid root must still authorize, got ${JSON.stringify(mixed)}`);
    const mixedOutside = await resolveRevealTarget(outsideFile, [missing, root]);
    assert.ok(!mixedOutside.ok);
    assert.equal(mixedOutside.status, 403);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

// 配置根必须以「原值」参与真实路径解析：目录名的尾部空格是路径的一部分。
// 若对根做 trim，<parent>/ws␠ 会变成 <parent>/ws 这个不同的真实目录，
// 使界外目录 <parent>/ws 里的文件被误判为界内而错误放行。
test("resolveRevealTarget keeps the configured root's original value (does not trim trailing spaces)", async (t) => {
  if (process.platform === "win32") {
    t.skip("Win32 strips trailing spaces from path components; this counterexample is POSIX-only");
    return;
  }
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-root-value-"));
  try {
    const workspace = path.join(parent, "ws ");   // 配置工作区：目录名带尾部空格
    const outside = path.join(parent, "ws");      // 界外目录：仅差这一个空格
    fs.mkdirSync(workspace);
    fs.mkdirSync(outside);
    const secret = path.join(outside, "secret.txt");
    fs.writeFileSync(secret, "x");
    const insideFile = path.join(workspace, "ok.txt");
    fs.writeFileSync(insideFile, "ok");

    // 反例：根若被 trim 成 <parent>/ws，secret.txt 会被错误放行；按原值应 403。
    const leaked = await resolveRevealTarget(secret, [workspace]);
    assert.ok(!leaked.ok, `trailing-space root must not authorize its trimmed sibling: ${JSON.stringify(leaked)}`);
    assert.equal(leaked.status, 403);

    // 正向对照：落在带尾空格工作区内的文件仍应放行，确认修复不过度拒绝。
    const allowed = await resolveRevealTarget(insideFile, [workspace]);
    assert.ok(allowed.ok, `file inside the trailing-space workspace must be allowed: ${JSON.stringify(allowed)}`);
    assert.equal(allowed.target, fs.realpathSync(insideFile));
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

// 纯空白根必须在判空阶段被跳过，而不是作为相对路径交给 realpath 按进程 cwd
// 解析：若守卫写回 root.length === 0，"   " 不会被跳过；当 cwd 下恰好存在
// 名字就是这几个空格的目录时，realpath("   ") 会成功并把它收进 resolvedRoots，
// 等于凭空多出一个配置里本不存在的授权根（fail-open）。
test("resolveRevealTarget does not authorize a whitespace-only root even when that directory exists", async (t) => {
  if (process.platform === "win32") {
    t.skip("Win32 cannot create a whitespace-only path component; this counterexample is POSIX-only");
    return;
  }
  const whitespace = "   ";
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-whitespace-root-"));
  const blankDir = path.join(parent, whitespace);  // 目录名就是纯空格串，确实存在
  fs.mkdirSync(blankDir);
  const secret = path.join(blankDir, "secret.txt");
  fs.writeFileSync(secret, "x");

  const originalCwd = process.cwd();
  try {
    // realpath("   ") 以进程 cwd 为基准解析；切到 parent 才能让"同名目录存在"
    // 这一条件真正成立。守卫跳过纯空白根后，secret.txt 应 403；若退回
    // root.length === 0，该根会被解析成 <parent>/   并错误放行。
    process.chdir(parent);
    const leaked = await resolveRevealTarget(secret, [whitespace]);
    assert.ok(!leaked.ok, `whitespace-only root must not authorize even when the directory exists: ${JSON.stringify(leaked)}`);
    assert.equal(leaked.status, 403);
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
