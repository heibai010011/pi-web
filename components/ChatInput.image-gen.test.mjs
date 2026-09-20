import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Script } from "node:vm";
import ts from "typescript";

const text = await readFile(new URL("./ChatInput.tsx", import.meta.url), "utf8");
const source = ts.createSourceFile("ChatInput.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const nodes = [];
function visit(node) { nodes.push(node); ts.forEachChild(node, visit); }
visit(source);
function run(node, context) {
  return new Script(ts.transpileModule(`(${node.getText(source)})`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText).runInNewContext(context);
}
function callback(name, context) {
  const declaration = nodes.find(n => ts.isVariableDeclaration(n) && n.name.getText(source) === name);
  return run(declaration.initializer.arguments[0], context);
}

test("compact non-image composers never overwrite global image preferences", () => {
  const effect = nodes.find(n => ts.isCallExpression(n) && n.expression.getText(source) === "useEffect" && n.arguments[0]?.getText(source).includes("setImageGenPreferences"));
  const writes = [];
  const context = { onImageGenerate: undefined, imageModel: undefined, imageAspectRatio: "3:4", imageCount: 1, imageSeed: null, setImageGenPreferences: p => writes.push(p) };
  run(effect.arguments[0], context)();
  assert.equal(writes.length, 0);
  context.onImageGenerate = () => {};
  context.imageModel = { provider: "test", modelId: "selected" };
  run(effect.arguments[0], context)();
  assert.equal(writes[0].model.modelId, "selected");
});

test("image mode Enter never steers the text agent", () => {
  const calls = [];
  const context = {
    imageMode: true, isMobile: false, isStreaming: true, onSteer() {}, onFollowUp() {},
    lastCompositionEndAtRef: { current: 0 }, isComposingRef: { current: false }, COMPOSITION_END_ENTER_GRACE_MS: 100,
    historyMenuOpen: false, slashMenuOpen: false, atMenuOpen: false,
    sendQueued: () => calls.push("queued"), handleSend: () => calls.push("send"),
  };
  callback("handleKeyDown", context)({ key: "Enter", nativeEvent: {}, preventDefault() {} });
  assert.deepEqual(calls, ["send"]);
});

test("seed zero is retained, blank resets to random", () => {
  const change = nodes.find(n => ts.isJsxAttribute(n) && n.name.getText(source) === "onChange" && n.getText(source).includes("setImageSeed"));
  const values = [];
  const handler = run(change.initializer.expression, { setImageSeed: value => values.push(value) });
  handler({ target: { value: "0" } });
  handler({ target: { value: "" } });
  handler({ target: { value: "123.9" } });
  assert.deepEqual(values, [0, null, 123]);
});

test("missing image model cannot fall through to text send", async () => {
  const calls = [];
  const images = [], owner = {};
  await callback("handleSend", {
    value: "draw", valueRef: { current: "draw" }, attachedImages: images, attachedImagesRef: { current: images },
    sendPendingRef: { current: false }, mountedRef: { current: true }, draftOwner: owner, draftOwnerRef: { current: owner },
    imageModeRef: { current: true }, streamingRef: { current: false }, maxImages: 4,
    onAudioUnlock: undefined, imageMode: true, isStreaming: false, isGeneratingImage: false,
    onImageGenerate() {}, activeImageModel: null, onSend: () => calls.push("text"),
  })();
  assert.deepEqual(calls, []);
});
