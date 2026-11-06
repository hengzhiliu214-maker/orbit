import test from "node:test";
import assert from "node:assert/strict";

import {
  graphSelectionKey,
  loadGraphSelection,
  resolveRestoredSelection,
  resolveSelectionOnSnapshot,
  saveGraphSelection,
  type GraphSelectionStore,
} from "../src/ui/graph-selection-storage.ts";

function fakeStore(): GraphSelectionStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value); },
    removeItem: (key) => { map.delete(key); },
  };
}

const WS = "ws_1";
const CONV = "conv_1";
const roots = [{ id: "root_a" }, { id: "root_b" }, { id: "root_c" }];

test("键按 workspaceId + conversationId 区分并带版本号", () => {
  assert.equal(graphSelectionKey(WS, CONV), "orbit.graphSelection.v1:ws_1:conv_1");
  assert.notEqual(graphSelectionKey(WS, CONV), graphSelectionKey(WS, "conv_2"));
  assert.notEqual(graphSelectionKey(WS, CONV), graphSelectionKey("ws_2", CONV));
});

test("存储恢复：保存后按会话读回 rootId + followLatest", () => {
  const store = fakeStore();
  saveGraphSelection(store, WS, CONV, { rootId: "root_a", followLatest: false });
  assert.deepEqual(loadGraphSelection(store, WS, CONV), { rootId: "root_a", followLatest: false });
  saveGraphSelection(store, WS, CONV, { rootId: "root_c", followLatest: true });
  assert.deepEqual(loadGraphSelection(store, WS, CONV), { rootId: "root_c", followLatest: true });
});

test("存储恢复：脏数据不恢复（版本/归属/类型错一律 null）", () => {
  const store = fakeStore();
  const key = graphSelectionKey(WS, CONV);
  store.setItem(key, "not json");
  assert.equal(loadGraphSelection(store, WS, CONV), null);
  store.setItem(key, JSON.stringify({ version: 99, workspaceId: WS, conversationId: CONV, rootId: "root_a", followLatest: false }));
  assert.equal(loadGraphSelection(store, WS, CONV), null);
  store.setItem(key, JSON.stringify({ version: 1, workspaceId: WS, conversationId: "conv_other", rootId: "root_a", followLatest: false }));
  assert.equal(loadGraphSelection(store, WS, CONV), null);
  store.setItem(key, JSON.stringify({ version: 1, workspaceId: WS, conversationId: CONV, rootId: "", followLatest: false }));
  assert.equal(loadGraphSelection(store, WS, CONV), null);
  store.setItem(key, JSON.stringify({ version: 1, workspaceId: WS, conversationId: CONV, rootId: "root_a", followLatest: "yes" }));
  assert.equal(loadGraphSelection(store, WS, CONV), null);
  // 无存储时返回 null，不抛错
  assert.equal(loadGraphSelection(fakeStore(), WS, CONV), null);
});

test("恢复决议：首次进入无 stored，落最新根且跟随开", () => {
  assert.deepEqual(resolveRestoredSelection(null, roots), { rootId: "root_c", followLatest: true, missingStoredRoot: false });
});

test("恢复决议：跟随开时取最新根（不取 stored 的旧 rootId）", () => {
  assert.deepEqual(
    resolveRestoredSelection({ rootId: "root_a", followLatest: true }, roots),
    { rootId: "root_c", followLatest: true, missingStoredRoot: false },
  );
});

test("恢复决议：跟随关且旧根仍在，恢复旧根并保持关", () => {
  assert.deepEqual(
    resolveRestoredSelection({ rootId: "root_a", followLatest: false }, roots),
    { rootId: "root_a", followLatest: false, missingStoredRoot: false },
  );
});

test("恢复决议：旧根消失，落最新根、保持关并报 missing", () => {
  assert.deepEqual(
    resolveRestoredSelection({ rootId: "root_gone", followLatest: false }, roots),
    { rootId: "root_c", followLatest: false, missingStoredRoot: true },
  );
});

test("恢复决议：空图返回 null（不消费、不清 stored）", () => {
  assert.equal(resolveRestoredSelection({ rootId: "root_a", followLatest: false }, []), null);
  assert.equal(resolveRestoredSelection(null, []), null);
});

test("快照决议：跟随开跳最新；跟随关且已选根仍在保持", () => {
  assert.deepEqual(resolveSelectionOnSnapshot("root_a", true, roots), { rootId: "root_c", followLatest: true, missingStoredRoot: false });
  assert.deepEqual(resolveSelectionOnSnapshot("root_a", false, roots), { rootId: "root_a", followLatest: false, missingStoredRoot: false });
});

test("快照决议：跟随关但已选根消失，落最新根、保持关并报 missing", () => {
  assert.deepEqual(
    resolveSelectionOnSnapshot("root_gone", false, roots),
    { rootId: "root_c", followLatest: false, missingStoredRoot: true },
  );
});

test("快照决议：空图返回 null（保持原选择）", () => {
  assert.equal(resolveSelectionOnSnapshot("root_a", false, []), null);
});
