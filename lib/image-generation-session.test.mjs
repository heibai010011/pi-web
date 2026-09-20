import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  appendImageGenerationTurn,
  parseImageGenerateCommand,
} = await jiti.import("./image-generation-session.ts");
const { IMAGE_GEN_TOOL_NAME } = await jiti.import("./image-gen-shared.ts");

function successResult() {
  return {
    api: "openrouter-images",
    provider: "openrouter",
    model: "black-forest-labs/flux.2-klein",
    output: [
      { type: "image", data: "AAAA", mimeType: "image/png" },
      { type: "text", text: "Generated openrouter/flux, 1 image." },
    ],
    usage: {
      input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
      cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

test("appendImageGenerationTurn writes a coherent user/toolCall/toolResult triple", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-imggen-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const manager = SessionManager.create(dir, dir);
  manager.newSession();

  const { input, request } = parseImageGenerateCommand({
    prompt: "魔王持太极剑",
    imageModel: { provider: "openrouter", modelId: "black-forest-labs/flux.2-klein" },
    images: [{ data: "REF", mimeType: "image/png" }],
    aspectRatio: "3:4",
    count: 2,
    seed: 42,
  });
  const result = successResult();
  const ids = appendImageGenerationTurn(manager, { ...input, request, result, durationMs: 1200 });

  const userEntry = manager.getEntry(ids.userEntryId);
  const assistantEntry = manager.getEntry(ids.assistantEntryId);
  const toolResultEntry = manager.getEntry(ids.toolResultEntryId);

  assert.equal(userEntry.parentId, null);
  assert.equal(assistantEntry.parentId, ids.userEntryId);
  assert.equal(toolResultEntry.parentId, ids.assistantEntryId);
  assert.equal(manager.getLeafId(), ids.toolResultEntryId);

  assert.deepEqual(userEntry.message.content, [
    { type: "text", text: "魔王持太极剑" },
    { type: "image", data: "REF", mimeType: "image/png" },
  ]);

  const toolCall = assistantEntry.message.content[0];
  assert.equal(toolCall.type, "toolCall");
  assert.equal(toolCall.name, IMAGE_GEN_TOOL_NAME);
  assert.equal(toolCall.arguments.model, "openrouter/black-forest-labs/flux.2-klein");
  assert.equal(toolCall.arguments.aspect_ratio, "3:4");
  assert.equal(toolCall.arguments.count, 2);
  assert.equal(toolCall.arguments.seed, 42);
  assert.equal(assistantEntry.message.usage.totalTokens, 15);

  assert.equal(toolResultEntry.message.toolCallId, toolCall.id);
  assert.equal(toolResultEntry.message.isError, false);
  assert.equal(toolResultEntry.message.content[0].type, "image");
  assert.equal(toolResultEntry.message.content[1].type, "text");
  assert.equal(toolResultEntry.message.details.kind, "pi-web-image-generation");
  assert.equal(toolResultEntry.message.details.requestedBy, "composer");

  // The assistant message triggers the first JSONL flush, so the whole turn
  // must already be on disk in on-disk field format.
  const sessionFile = manager.getSessionFile();
  assert.ok(sessionFile);
  const raw = await readFile(sessionFile, "utf8");
  assert.ok(raw.includes("魔王持太极剑"));
  assert.ok(raw.includes(IMAGE_GEN_TOOL_NAME));
  assert.ok(raw.includes("pi-web-image-generation"));
});

test("appendImageGenerationTurn marks failures without inventing images", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-imggen-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const manager = SessionManager.create(dir, dir);
  manager.newSession();

  const { input, request } = parseImageGenerateCommand({
    prompt: "cat",
    imageModel: { provider: "openrouter", modelId: "flux" },
  });
  const ids = appendImageGenerationTurn(manager, {
    ...input,
    request,
    result: {
      api: "openrouter-images",
      provider: "openrouter",
      model: "flux",
      output: [],
      stopReason: "error",
      errorMessage: "no api key",
      timestamp: Date.now(),
    },
    durationMs: 30,
  });

  const toolResultEntry = manager.getEntry(ids.toolResultEntryId);
  assert.equal(toolResultEntry.message.isError, true);
  assert.match(toolResultEntry.message.content[0].text, /no api key/);
  assert.equal(manager.getEntry(ids.assistantEntryId).message.stopReason, "error");
});

test("cancelled generation is persisted as an unsuccessful tool result", () => {
  const messages = [];
  const { input, request } = parseImageGenerateCommand({ prompt: "cat", imageModel: { provider: "p", modelId: "m" } });
  appendImageGenerationTurn({ appendMessage(message) { messages.push(message); return String(messages.length); } }, {
    ...input, request, durationMs: 1,
    result: { ...successResult(), stopReason: "aborted" },
  });
  assert.equal(messages[1].stopReason, "aborted");
  assert.equal(messages[2].isError, true);
  assert.equal(messages[2].content[0].type, "image");
  assert.match(messages[2].content.at(-1).text, /Image generation cancelled/);
});

test("oversized references reject parsing and direct appending before any writes", () => {
  for (const count of [5, 10]) {
    for (const extra of [{ data: "extra", mimeType: "image/png" }, null]) {
      const images = Array.from({ length: count }, (_, index) => index < 4
        ? { data: String(index), mimeType: "image/png" } : extra);
      const command = { prompt: "cat", imageModel: { provider: "p", modelId: "m" }, images };
      assert.throws(() => parseImageGenerateCommand(command), { name: "ImageGenerationValidationError", status: 400 });
      let writes = 0;
      const manager = { appendMessage() { writes++; return "unexpected"; } };
      const request = { prompt: "cat", model: command.imageModel };
      for (const input of [{ images, request }, { request: { ...request, referenceImages: images } }]) {
        assert.throws(() => appendImageGenerationTurn(manager, { prompt: "cat", result: successResult(), durationMs: 1, ...input }),
          { name: "ImageGenerationValidationError", status: 400 });
      }
      assert.equal(writes, 0);
    }
  }
});

test("four references survive parsing and persisted user history", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-imggen-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const manager = SessionManager.create(dir, dir);
  const images = Array.from({ length: 4 }, (_, index) => ({ data: `ref-${index}`, mimeType: "image/png" }));
  const { input, request } = parseImageGenerateCommand({ prompt: "cat", imageModel: { provider: "p", modelId: "m" }, images });
  assert.deepEqual(input.images, images);
  assert.deepEqual(request.referenceImages, images);
  appendImageGenerationTurn(manager, { ...input, request, result: successResult(), durationMs: 1 });
  const entries = (await readFile(manager.getSessionFile(), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const user = entries.find(entry => entry.message?.role === "user");
  assert.deepEqual(user.message.content.slice(1), images.map(image => ({ type: "image", ...image })));
});

test("parseImageGenerateCommand validates payload shape", () => {
  const { request } = parseImageGenerateCommand({
    prompt: "cat",
    imageModel: { provider: "openrouter", modelId: "flux" },
    count: 0,
    images: [{ data: "x", mimeType: "image/png" }, { nope: true }],
  });
  assert.equal(request.count, 1);
  assert.deepEqual(request.referenceImages, [{ data: "x", mimeType: "image/png" }]);

  assert.throws(() => parseImageGenerateCommand({ prompt: "", imageModel: { provider: "a", modelId: "b" } }), /prompt/);
  assert.throws(() => parseImageGenerateCommand({ prompt: "x", imageModel: "openrouter/flux" }), /model/);
});
