import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
});
const { AgentCommandError, isPromptRejectedError, sendAgentCommand } = await jiti.import("./agent-client.ts");

test("agent command HTTP rejections are distinguishable from transport failures", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () => new Response(
    JSON.stringify({
      error: "Authentication failed",
      code: "prompt_rejected",
      accepted: false,
    }),
    { status: 500, headers: { "Content-Type": "application/json" } },
  );

  await assert.rejects(
    sendAgentCommand("session-id", { type: "prompt", message: "hello" }),
    (error) => {
      assert.equal(error instanceof AgentCommandError, true);
      assert.equal(error.status, 500);
      assert.equal(error.message, "Authentication failed");
      assert.equal(error.code, "prompt_rejected");
      assert.equal(error.accepted, false);
      assert.equal(isPromptRejectedError(error), true);
      return true;
    },
  );

  const transportError = new TypeError("connection reset");
  globalThis.fetch = async () => {
    throw transportError;
  };

  await assert.rejects(
    sendAgentCommand("session-id", { type: "prompt", message: "hello" }),
    (error) => {
      assert.equal(error, transportError);
      assert.equal(error instanceof AgentCommandError, false);
      assert.equal(isPromptRejectedError(error), false);
      return true;
    },
  );
});

test("malformed successful command responses are not treated as acknowledgements", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  for (const payload of ["<html>proxy page</html>", "null", "[]", "{}", '{"success":false}']) {
    globalThis.fetch = async () => new Response(payload, { status: 200 });
    await assert.rejects(sendAgentCommand("session-id", { type: "set_model" }), error => {
      assert.equal(error instanceof AgentCommandError, true);
      assert.equal(isPromptRejectedError(error), false);
      return true;
    }, payload);
  }
});

test("valid acknowledgements preserve data and HTTP failures remain ambiguous", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  for (const data of [undefined, null, false, { modelId: "fixture" }]) {
    globalThis.fetch = async () => new Response(JSON.stringify({ success: true, data }));
    assert.deepEqual(await sendAgentCommand("session-id", { type: "get_state" }), data);
  }
  for (const payload of ["null", "<html>unavailable</html>", '{"error":{"detail":"bad gateway"},"accepted":"false","code":42}']) {
    globalThis.fetch = async () => new Response(payload, { status: 502 });
    await assert.rejects(sendAgentCommand("session-id", { type: "prompt" }), error => {
      assert.equal(error instanceof AgentCommandError, true);
      assert.equal(error.status, 502);
      assert.equal(error.message, "HTTP 502");
      assert.equal(isPromptRejectedError(error), false);
      return true;
    });
  }
});

test("only an explicit negative prompt acknowledgement is definitive", () => {
  assert.equal(
    isPromptRejectedError(new AgentCommandError("proxy failure", 502)),
    false,
  );
  assert.equal(
    isPromptRejectedError(new AgentCommandError("generic API failure", 500, "internal_error", false)),
    false,
  );
});
