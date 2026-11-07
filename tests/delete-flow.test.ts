import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseDeleteErrorMessage, translateDeleteFailure } from "../src/ui/delete-flow.ts";

describe("delete-flow error surfacing", () => {
  it("maps the workspace running-agents 409 to a Chinese explanation", () => {
    const text = translateDeleteFailure(409, "Cannot delete workspace with running agents.", "workspace");
    assert.match(text, /正在运行的 agent/);
    assert.match(text, /不能删除这个工作区/);
  });

  it("maps the conversation running-agents 409 to a Chinese explanation", () => {
    const text = translateDeleteFailure(409, "Cannot delete a conversation with running agents.", "conversation");
    assert.match(text, /正在运行的 agent/);
    assert.match(text, /不能删除这个会话/);
  });

  it("keeps an unknown server message visible instead of swallowing it", () => {
    const text = translateDeleteFailure(404, "Workspace not found.", "workspace");
    assert.match(text, /Workspace not found/);
  });

  it("falls back to the status code when the server gives no message", () => {
    const text = translateDeleteFailure(500, null, "conversation");
    assert.match(text, /500/);
  });

  it("parses message/error fields and rejects empty bodies", () => {
    assert.equal(parseDeleteErrorMessage({ ok: false, message: "boom" }), "boom");
    assert.equal(parseDeleteErrorMessage({ error: "nope" }), "nope");
    assert.equal(parseDeleteErrorMessage({ ok: false }), null);
    assert.equal(parseDeleteErrorMessage(null), null);
    assert.equal(parseDeleteErrorMessage("boom"), null);
  });
});
