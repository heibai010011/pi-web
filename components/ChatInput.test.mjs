import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createContext, Script } from "node:vm";
import { createJiti } from "jiti";
import ts from "typescript";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { ChatInput, ModelErrorBanner, ModelScopeWarningBanner, canClearBuiltinCommandInput, canRestoreUserMessage, canRunBuiltinSlashCommandWhileStreaming, compressImageFile, cycleListIndex, filterModelOptions, getUpwardMenuMaxHeight, getUserMessageText, getUserMessageDraftImages, isExactSlashCommand, modelSupportsImageInput, replaceLinksWithMarkdown, shouldCompressImageFile } = await jiti.import("./ChatInput.tsx");
const { ModelSelector } = await jiti.import("./ModelSelector.tsx");
// ChatInput resolves "@/lib/draft-store" (extensionless). Import the SAME
// module instance so setDraft/getDraft in this test touch the live draft Map;
// the extensionless and ".ts" specifiers are separate jiti modules.
const {
  clearDraft,
  getDraft,
  mergeRestoredSubmissionDraft,
  mergeRestoredSubmissionText,
  rekeyDraft,
  registerDraftRestoration,
  restoreDraftSubmission,
  setDraft,
} = await jiti.import("@/lib/draft-store");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const { MAX_ATTACHED_IMAGES, MAX_ATTACHED_IMAGE_BYTES, isBase64ImageWithinLimits } = await jiti.import("@/lib/image-attachments");

// Run the real imperative methods and React callbacks, with deferred functional
// setters to exercise the synchronous-ref / queued-state recovery race.
const composerSource = ts.createSourceFile("ChatInput.tsx", readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const composerNodes = [];
(function visit(node) { composerNodes.push(node); ts.forEachChild(node, visit); })(composerSource);
function composerCode(name, context) {
  context.maxImages ??= context.imageMode ? 4 : MAX_ATTACHED_IMAGES;
  context.MAX_REFERENCE_IMAGES ??= 4;
  context.mountedRef ??= { current: true };
  context.sendPendingRef ??= { current: false };
  context.streamingRef ??= { current: context.isStreaming ?? false };
  context.draftOwnerRef ??= { current: {} };
  context.draftOwner ??= context.draftOwnerRef.current;
  context.imageModeRef ??= { current: context.imageMode ?? false };
  context.valueRef ??= { current: context.value };
  const node = composerNodes.find(node => (ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name?.getText(composerSource) === name);
  assert.ok(node, name);
  const text = ts.isMethodDeclaration(node)
    ? `function ${node.getText(composerSource)}`
    : ts.isVariableDeclaration(node) ? node.initializer.arguments[0].getText(composerSource) : node.getText(composerSource);
  const expression = name === "handleSend" || name === "sendQueued"
    ? `((value, attachedImages, draftOwner, imageMode, maxImages) => (${text}))(value, attachedImages, draftOwner, imageMode, maxImages)`
    : `(${text})`;
  return new Script(ts.transpileModule(expression, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText).runInContext(context);
}
function recoveredImage(n) { return { data: Buffer.from(`recovered-${n}`).toString("base64"), mimeType: "image/png" }; }
function composerHarness(key, initial = { value: "", images: [] }) {
  const updates = [];
  const context = createContext({
    MAX_ATTACHED_IMAGES, MAX_ATTACHED_IMAGE_BYTES, isBase64ImageWithinLimits,
    getDraft, setDraft, clearDraft, mergeRestoredSubmissionDraft, mergeRestoredSubmissionText,
    registerDraftRestoration, restoreDraftSubmission,
    restorationCleanupRef: { current: null }, initialStoredDraftRef: { current: getDraft(key) },
    rekeyStoredDraft: rekeyDraft, requestAnimationFrame() {}, revokeImagePreview() {},
    draftKey: key, draftKeyRef: { current: key }, textareaRef: { current: null },
    setAtQuery() {}, setHistoryMenuOpen() {},
    setValue(update) { updates.push(() => { context.value = typeof update === "function" ? update(context.value) : update; }); },
    setAttachedImages(update) { updates.push(() => { context.attachedImages = typeof update === "function" ? update(context.attachedImages) : update; }); },
  });
  for (const name of ["imageToDraftImage", "draftImageToAttachedImage", "draftImagesToAttachedImages"]) context[name] = composerCode(name, context);
  context.value = initial.value;
  context.attachedImages = context.draftImagesToAttachedImages(initial.images);
  context.valueRef = { current: context.value };
  context.attachedImagesRef = { current: context.attachedImages };
  context.clearImages = composerCode("clearImages", context);
  context.clearInput = composerCode("clearInput", context);
  context.restoreSubmission = composerCode("restoreSubmission", context);
  context.registerRestorationOwner = composerCode("registerRestorationOwner", context);
  return {
    context, restore: composerCode("restoreSubmission", context), rekey: composerCode("rekeyDraft", context), remove: composerCode("removeImage", context),
    flush() { while (updates.length) updates.shift()(); },
  };
}
function composerEffect(s, name) {
  const node = composerNodes.find(node => ts.isCallExpression(node)
    && ["useEffect", "useLayoutEffect"].includes(node.expression.getText(composerSource))
    && (name === "persist" ? node.arguments[0]?.getText(composerSource).includes("if (!draftKey || draftKeyRef.current !== draftKey) return;")
      : node.arguments[0]?.name?.getText(composerSource) === name));
  assert.ok(node, name);
  return new Script(ts.transpileModule(`(${node.arguments[0].getText(composerSource)})`, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText).runInContext(s.context)();
}

for (const gap of [false, true]) test(`late offscreen recovery reaches remounted A once and survives pending effects/edit (registration gap=${gap})`, () => {
  const a = `late-a-${gap}`, b = `late-b-${gap}`;
  setDraft(a, { value: "newer", images: [recoveredImage(10)] });
  const mounted = composerHarness(a, getDraft(a));
  const other = composerHarness(b, { value: "B", images: [recoveredImage(20)] });
  const cleanupB = composerEffect(other, "registerDraftRestorationEffect");
  let cleanup;
  try {
    if (!gap) cleanup = composerEffect(mounted, "registerDraftRestorationEffect");
    // Edits queued but not committed must be merged from the real live refs.
    if (!gap) { mounted.context.valueRef.current = "newer unflushed"; mounted.context.setValue("newer unflushed"); }
    const oldImages = Array.from({ length: 10 }, (_, n) => recoveredImage(n));
    restoreDraftSubmission(a, "old response", oldImages);
    if (gap) cleanup = composerEffect(mounted, "registerDraftRestorationEffect");
    composerEffect(mounted, "persist"); // passive callback from pre-recovery render
    const expected = `old response\n\n${gap ? "newer" : "newer unflushed"}`;
    assert.equal(getDraft(a).value, expected);
    mounted.flush(); other.flush();
    assert.equal(mounted.context.value, expected);
    assert.equal(mounted.context.attachedImages.length, 11);
    assert.equal(other.context.value, "B");
    assert.equal(other.context.attachedImages.length, 1);
    mounted.context.valueRef.current += "!";
    mounted.context.setValue(mounted.context.valueRef.current);
    composerEffect(mounted, "persist"); mounted.flush();
    assert.equal(getDraft(a).value, expected + "!");
    assert.equal(getDraft(a).images.length, 11);
    mounted.restore("direct", []); mounted.flush();
    assert.equal(mounted.context.value, "direct\n\n" + expected + "!");
  } finally { cleanup?.(); cleanupB(); clearDraft(a); clearDraft(b); }
});

test("restoration owner cleanup is identity safe, promotion moves registration before unchanged return", () => {
  const a = "owner-a", real = "owner-real";
  const stale = composerHarness(a), live = composerHarness(a);
  const cleanStale = composerEffect(stale, "registerDraftRestorationEffect");
  const cleanLive = composerEffect(live, "registerDraftRestorationEffect");
  try {
    cleanStale();
    restoreDraftSubmission(a, "one"); live.flush(); stale.flush();
    assert.equal(live.context.value, "one"); assert.equal(stale.context.value, "");
    live.rekey(a, real);
    restoreDraftSubmission(real, "two"); live.flush();
    assert.equal(live.context.value, "two\n\none");
    restoreDraftSubmission(a, "offscreen");
    assert.equal(live.context.value, "two\n\none");
    cleanLive();
    restoreDraftSubmission(real, "after cleanup");
    assert.equal(live.context.value, "two\n\none");
    assert.equal(getDraft(real).value, "after cleanup\n\ntwo\n\none");
  } finally { cleanStale(); cleanLive(); clearDraft(a); clearDraft(real); }
});

function composerMarkup(key, streaming = false) {
  return renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(ChatInput, {
    draftKey: key, onSend() {}, onAbort() {}, onSteer() {}, onFollowUp() {}, isStreaming: streaming,
  })));
}

test("imperative recovery retains old ten plus newer images before/after React flush, rekey and remount", () => {
  const key = "recovery-callback", destination = "recovery-callback-promoted";
  const old = Array.from({ length: 10 }, (_, n) => recoveredImage(n));
  const newer = [recoveredImage(10), recoveredImage(10)];
  const all = [...old, ...newer];
  const s = composerHarness(key, { value: "newer", images: newer });
  try {
    s.restore("old", [...old, { data: "%%%", mimeType: "image/png" }]);
    assert.deepEqual(JSON.parse(JSON.stringify(s.context.attachedImagesRef.current.map(({ data, mimeType }) => ({ data, mimeType })))), all);
    assert.deepEqual(getDraft(key), { value: "old\n\nnewer", images: all });
    s.rekey(key, destination); // promotion before React commits its setters
    assert.equal(getDraft(key), null);
    assert.deepEqual(JSON.parse(JSON.stringify(getDraft(destination).images)), all);
    s.flush();
    assert.equal(s.context.attachedImages.length, 12);
    assert.equal(s.context.value, "old\n\nnewer");
    const mounted = composerHarness(destination, getDraft(destination));
    assert.equal(mounted.context.attachedImages.length, 12);
    for (const streaming of [false, true]) {
      const html = composerMarkup(destination, streaming);
      assert.equal((html.match(/<img /g) ?? []).length, 12, "actual fresh React render hydrates every preview");
      assert.match(html, /role="alert"/);
      const buttons = html.match(/<button[^>]*>[\s\S]*?<\/button>/g) ?? [];
      for (const label of streaming ? ["Steer", "Follow-up"] : ["Send"]) {
        const button = buttons.find(button => button.includes(`>${label}</button>`));
        assert.ok(button, label);
        assert.match(button, /disabled=""/);
      }
    }
    mounted.remove(0); mounted.flush(); mounted.remove(0); mounted.flush();
    setDraft(destination, { value: mounted.context.value, images: mounted.context.attachedImages.map(mounted.context.imageToDraftImage) });
    assert.equal(getDraft(destination).images.length, 10);
    const sent = [];
    Object.assign(mounted.context, {
      imageMode: false, isStreaming: true, onAudioUnlock() {}, onBuiltinCommand: undefined,
      onPromptWithStreamingBehavior: undefined, onSteer: (text, images) => sent.push({ text, images }),
    });
    composerCode("sendQueued", mounted.context)("steer");
    assert.equal(sent.length, 1, "removal restores actual queue callback admission");
    assert.equal(sent[0].images.length, 10);
    // Restore the persisted snapshot cleared by the successful queue callback.
    setDraft(destination, { value: "old\n\nnewer", images: all.slice(2) });
    assert.doesNotMatch(composerMarkup(destination), /role="alert"/);
    for (const streaming of [false, true]) {
      const html = composerMarkup(destination, streaming);
      const buttons = html.match(/<button[^>]*>[\s\S]*?<\/button>/g) ?? [];
      for (const label of streaming ? ["Steer", "Follow-up"] : ["Send"]) assert.doesNotMatch(buttons.find(button => button.includes(`>${label}</button>`)), /disabled=""/);
    }
  } finally { clearDraft(key); clearDraft(destination); }
});

test("queued clear then recovery preserves all recoverable images instead of old state", () => {
  const key = "recovery-clear-race";
  const images = Array.from({ length: 11 }, (_, n) => recoveredImage(n));
  const s = composerHarness(key, { value: "original", images });
  try {
    s.context.clearInput();
    s.restore("original", images);
    assert.equal(s.context.attachedImagesRef.current.length, 11);
    s.flush();
    assert.equal(s.context.attachedImages.length, 11);
    assert.equal(s.context.value, "original");
    assert.deepEqual(getDraft(key).images, images);
  } finally { clearDraft(key); }
});

test("actual send and queue callbacks block every path before callbacks or clear while over cap", async () => {
  for (const snapshotOnly of [false, true]) {
    for (const [name, imageMode, streaming, value, mode] of [
      ["handleSend", false, false, "normal"], ["handleSend", true, false, "draw"],
      ["handleSend", false, true, "/copy"],
      ["sendQueued", false, true, "normal", "steer"], ["sendQueued", false, true, "normal", "followup"],
      ["sendQueued", false, true, "/skill:review", "steer"], ["sendQueued", false, true, "/skill:review", "followup"],
      ["sendQueued", false, true, "/copy", "followup"],
    ]) {
      const calls = [];
      const images = Array.from({ length: 11 }, (_, n) => recoveredImage(n));
      const context = createContext({
        MAX_ATTACHED_IMAGES, attachedImages: snapshotOnly ? [] : images, attachedImagesRef: { current: images },
        value, imageMode, isStreaming: streaming, isGeneratingImage: false, activeImageModel: {}, imageAspectRatio: "auto", imageCount: 1, imageSeed: null,
        canRunBuiltinSlashCommandWhileStreaming,
      });
      for (const callback of ["clearInput", "onSend", "onImageGenerate", "onSteer", "onFollowUp", "onPromptWithStreamingBehavior", "onAudioUnlock", "runBuiltinCommand", "onBuiltinCommand"]) context[callback] = () => calls.push(callback);
      await composerCode(name, context)(mode);
      assert.deepEqual(calls, [], `${name} ${value} ${mode} snapshotOnly=${snapshotOnly}`);
    }
  }
});

for (const mode of ["steer", "followup"]) {
  function queueHarness(s, calls) {
    Object.assign(s.context, {
      imageMode: false, isStreaming: true, canRunBuiltinSlashCommandWhileStreaming,
      onBuiltinCommand: undefined, onPromptWithStreamingBehavior: undefined,
      onSteer: (text, images) => calls.push(["steer", text, images]),
      onFollowUp: (text, images) => calls.push(["followup", text, images]),
      onAudioUnlock() {},
    });
    return composerCode("sendQueued", s.context);
  }

  test(`${mode}: retained queue cannot erase real recovery before React flush`, async () => {
    const key = `queue-restore-${mode}`;
    const s = composerHarness(key, { value: "newer", images: [] });
    const calls = [];
    const queue = queueHarness(s, calls);
    try {
      s.restore("recovered", [recoveredImage(0)]);
      await queue(mode);
      assert.deepEqual(calls, []);
      assert.deepEqual(getDraft(key), { value: "recovered\n\nnewer", images: [recoveredImage(0)] });
      s.flush();
      assert.equal(s.context.value, "recovered\n\nnewer");
      assert.equal(s.context.attachedImages.length, 1);
      await composerCode("sendQueued", s.context)(mode);
      assert.equal(calls.length, 1, "live render submits the recovered payload");
      assert.equal(calls[0][1], "recovered\n\nnewer");
      assert.equal(calls[0][2].length, 1);
      s.flush();
      assert.equal(s.context.value, "");
      assert.equal(getDraft(key), null);
    } finally { clearDraft(key); }
  });

  test(`${mode}: stale ownership and audio mutations preserve the draft`, async () => {
    for (const change of ["mode", "image-render", "unmount", "navigate", "rekey", "restore", "text", "mutate", "replace", "append"]) {
      const key = `queue-ownership-${mode}-${change}`, next = `${key}-next`;
      const s = composerHarness(key, { value: "newer", images: [recoveredImage(0)] });
      const calls = [];
      try {
        const queue = queueHarness(s, calls);
        const mutate = () => {
          if (change === "mode") s.context.imageModeRef.current = true;
          if (change === "unmount") s.context.mountedRef.current = false;
          if (change === "navigate") s.context.draftOwnerRef.current = {};
          if (change === "rekey") { setDraft(next, { value: "destination", images: [] }); s.rekey(key, next); }
          if (change === "restore") s.restore("recovered", [recoveredImage(1)]);
          if (change === "text") s.context.valueRef.current = "changed";
          if (change === "mutate") s.context.attachedImagesRef.current[0].data = recoveredImage(2).data;
          if (change === "replace") s.context.attachedImagesRef.current = [...s.context.attachedImages];
          if (change === "append") s.context.attachedImagesRef.current.push(recoveredImage(3));
        };
        if (change === "image-render") {
          s.context.imageMode = true; s.context.imageModeRef.current = true;
          const imageQueue = composerCode("sendQueued", s.context);
          s.context.imageModeRef.current = false;
          await imageQueue(mode);
        } else {
          if (["mode", "unmount", "navigate", "rekey"].includes(change)) mutate();
          else s.context.onAudioUnlock = mutate;
          await queue(mode);
        }
        assert.deepEqual(calls, [], change);
        s.flush();
        assert.notEqual(s.context.value, "", change);
        assert.equal(s.context.sendPendingRef.current, false);
      } finally { clearDraft(key); clearDraft(next); }
    }
  });

  test(`${mode}: audio reentry shares Send's guard and absent callbacks never clear`, async () => {
    const s = composerHarness(`queue-reentry-${mode}`, { value: "hello", images: [] });
    const calls = [];
    const queue = queueHarness(s, calls);
    Object.assign(s.context, { runBuiltinCommand: async () => false, onSend: () => calls.push("send") });
    const send = composerCode("handleSend", s.context);
    s.context.onAudioUnlock = () => { void queue(mode); void send(); };
    await queue(mode);
    assert.equal(calls.length, 1);
    s.flush();
    assert.equal(s.context.value, "");
    const missing = composerHarness(`queue-missing-${mode}`, { value: "keep", images: [] });
    const missingCalls = [];
    const missingQueue = queueHarness(missing, missingCalls);
    missing.context[mode === "steer" ? "onSteer" : "onFollowUp"] = undefined;
    await missingQueue(mode);
    missing.flush();
    assert.equal(missing.context.value, "keep");
    assert.deepEqual(missingCalls, []);
  });

  test(`${mode}: queue preserves slash behavior and holds shared guard for read-only builtins`, async () => {
    for (const value of ["/skill:review", "/copy"]) {
      const s = composerHarness(`queue-slash-${mode}`, { value, images: [] });
      const calls = [];
      const queue = queueHarness(s, calls);
      let finish;
      Object.assign(s.context, {
        onBuiltinCommand: () => {},
        onPromptWithStreamingBehavior: (...args) => calls.push(args),
        runBuiltinCommand: () => new Promise(resolve => { calls.push("builtin"); finish = resolve; }),
      });
      const pending = queue(mode);
      if (value === "/copy") {
        assert.equal(s.context.sendPendingRef.current, true);
        await queue(mode);
        assert.deepEqual(calls, ["builtin"]);
        finish(true);
      } else {
        assert.deepEqual(calls, [[value, mode === "steer" ? "steer" : "followUp", undefined]]);
      }
      await pending;
      assert.equal(s.context.sendPendingRef.current, false);
    }
  });
}

test("send rechecks recovered snapshot after awaiting built-in dispatch", async () => {
  const calls = [];
  const ref = { current: [] };
  const context = createContext({
    MAX_ATTACHED_IMAGES, attachedImages: [], attachedImagesRef: ref, value: "draft", imageMode: false, isStreaming: false,
    onAudioUnlock() {}, canRunBuiltinSlashCommandWhileStreaming,
    runBuiltinCommand: async () => { ref.current = Array.from({ length: 11 }, (_, n) => recoveredImage(n)); return false; },
    clearInput: () => calls.push("clear"), onSend: () => calls.push("send"),
  });
  await composerCode("handleSend", context)();
  assert.deepEqual(calls, []);
});

test("lexical send attempt never clears or dispatches a changed draft while awaiting", async () => {
  for (const change of ["restore", "text", "remove", "replace", "mutate", "unmount", "navigate", "mode", "streaming"]) {
    const key = `send-ownership-${change}`;
    const s = composerHarness(key, { value: "/unknown", images: [recoveredImage(0)] });
    const calls = [];
    let resolve;
    Object.assign(s.context, {
      imageMode: false, isStreaming: false, onAudioUnlock() {}, canRunBuiltinSlashCommandWhileStreaming,
      runBuiltinCommand: () => new Promise(done => { resolve = done; }),
      onSend: (...args) => calls.push(args),
    });
    const send = composerCode("handleSend", s.context);
    const first = send();
    if (change === "restore") s.restore("recovered", [recoveredImage(1)]);
    if (change === "text") s.context.valueRef.current = "edited";
    if (change === "remove") { s.remove(0); s.flush(); }
    if (change === "replace") s.context.attachedImagesRef.current = [{ ...s.context.attachedImages[0] }];
    if (change === "mutate") s.context.attachedImagesRef.current[0].data = recoveredImage(2).data;
    if (change === "unmount") s.context.mountedRef.current = false;
    if (change === "navigate") s.context.draftOwnerRef.current = {};
    if (change === "mode") s.context.imageModeRef.current = true;
    if (change === "streaming") s.context.streamingRef.current = true;
    const textBefore = s.context.valueRef.current;
    const imagesBefore = s.context.attachedImagesRef.current;
    resolve(false);
    await first;
    assert.equal(calls.length, 0, change);
    assert.equal(s.context.valueRef.current, textBefore, change);
    assert.equal(s.context.attachedImagesRef.current, imagesBefore, change);
    assert.equal(s.context.sendPendingRef.current, false);
    clearDraft(key);
  }
});

test("send rejects stale render at entry and same-stack reentry; unchanged promotion sends once", async () => {
  const key = "send-promotion", promoted = `${key}-session`;
  const s = composerHarness(key, { value: "hello", images: [] });
  let resolve;
  const calls = [];
  let builtinCalls = 0;
  Object.assign(s.context, {
    imageMode: false, isStreaming: false, onAudioUnlock() {}, canRunBuiltinSlashCommandWhileStreaming,
    runBuiltinCommand: () => { builtinCalls++; return new Promise(done => { resolve = done; }); },
    onSend: (...args) => calls.push(args),
  });
  const send = composerCode("handleSend", s.context);
  s.context.valueRef.current = "newer";
  await send();
  assert.equal(builtinCalls, 0);
  assert.equal(s.context.valueRef.current, "newer");
  s.context.valueRef.current = "hello";
  const first = send();
  await send();
  assert.equal(builtinCalls, 1);
  s.rekey(key, promoted);
  resolve(false);
  await first;
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "hello");
  assert.equal(s.context.valueRef.current, "");
  assert.equal(getDraft(promoted), null);
  clearDraft(key); clearDraft(promoted);
});

test("actual send admits ten chat images, four image references, and blocks five references without truncation", async () => {
  for (const [imageMode, count, expected] of [[false, 10, 1], [true, 4, 1], [true, 5, 0], [true, 10, 0]]) {
    const s = composerHarness("mode-cap", { value: "prompt", images: Array.from({ length: count }, (_, n) => recoveredImage(n)) });
    const calls = [];
    Object.assign(s.context, {
      imageMode, imageModeRef: { current: imageMode }, maxImages: imageMode ? 4 : 10,
      isStreaming: false, isGeneratingImage: false, activeImageModel: {}, imageAspectRatio: "auto", imageCount: 1, imageSeed: null,
      onAudioUnlock() {}, canRunBuiltinSlashCommandWhileStreaming, runBuiltinCommand: async () => false,
      onSend: (...args) => calls.push(args), onImageGenerate: (...args) => calls.push(args),
    });
    await composerCode("handleSend", s.context)();
    assert.equal(calls.length, expected, `${imageMode}/${count}`);
    if (expected) assert.equal(calls[0][1].length, count);
    else {
      assert.equal(s.context.attachedImagesRef.current.length, count);
      assert.equal(s.context.valueRef.current, "prompt");
      // Switching back to chat admits the exact same draft, without slicing it.
      s.context.imageMode = false; s.context.imageModeRef.current = false; s.context.maxImages = 10;
      await composerCode("handleSend", s.context)();
      assert.equal(calls[0][1].length, count);
    }
  }
});

test("hydration filters invalid individual images without capping valid recovery", () => {
  const images = Array.from({ length: 11 }, (_, n) => recoveredImage(n));
  const s = composerHarness("validity", { value: "", images: [
    { data: "%%%", mimeType: "image/png" }, ...images,
    { data: "AQID", mimeType: "text/plain" },
    { data: "AAAA".repeat(Math.ceil((MAX_ATTACHED_IMAGE_BYTES + 1) / 3)), mimeType: "image/png" },
  ] });
  assert.equal(s.context.attachedImages.length, 11);
  assert.deepEqual(JSON.parse(JSON.stringify(s.context.attachedImages.map(s.context.imageToDraftImage))), images);
});

test("normal file attachment capacity still rejects additions to full and recovered drafts", async () => {
  for (const count of [10, 11]) {
    const s = composerHarness("upload-cap", { value: "", images: Array.from({ length: count }, (_, n) => recoveredImage(n)) });
    Object.assign(s.context, { compact: false, pendingImageCountRef: { current: 0 }, compressImageFile() { assert.fail("must not process over-cap uploads"); } });
    await composerCode("processImageFiles", s.context)([{ type: "image/png", size: 3 }]);
    s.flush();
    assert.equal(s.context.attachedImages.length, count);
  }
});

test("preserves pasted HTML links as Markdown without changing plain text layout", () => {
  const link = (label, href, occurrence = 0) => ({ label, href, occurrence });

  assert.equal(
    replaceLinksWithMarkdown(
      "Jobs:\nEngineer\nEngineer\nDone",
      [link("Engineer", "https://example.com/1"), link("Engineer", "https://example.com/2", 1)],
    ),
    "Jobs:\n[Engineer](https://example.com/1)\n[Engineer](https://example.com/2)\nDone",
  );
  assert.equal(
    replaceLinksWithMarkdown("Read [this]", [link("[this]", "https://example.com/a_(b)")]),
    "Read [\\[this\\]](https://example.com/a_\\(b\\))",
  );
  assert.equal(
    replaceLinksWithMarkdown("Engineer and Engineer", [link("Engineer", "https://example.com/job", 1)]),
    "Engineer and [Engineer](https://example.com/job)",
  );
  assert.equal(replaceLinksWithMarkdown("plain text", [link("missing", "https://example.com")]), null);
});

test("follow-up shortcuts preserve newline, IME, mobile and completion behavior", () => {
  const source = ts.createSourceFile("ChatInput.tsx", readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  function findHandler(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === "handleKeyDown") {
      return node.initializer.arguments[0];
    }
    return ts.forEachChild(node, findHandler);
  }
  // Execute the component's actual callback without mounting the rest of the UI.
  const script = new Script(ts.transpileModule(findHandler(source).getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText);
  const cases = [
    ["Enter steers", {}, {}, "steer"],
    ["Alt+Enter follows up", { altKey: true }, {}, "followup"],
    ["idle Alt+Enter sends", { altKey: true }, { isStreaming: false }, "send"],
    ["Shift+Enter inserts a newline", { shiftKey: true }, {}, "native"],
    ["Alt+Shift+Enter keeps native behavior", { altKey: true, shiftKey: true }, {}, "native"],
    ["composition ref blocks sending", { altKey: true }, { isComposingRef: { current: true } }, "native"],
    ["native composition blocks sending", { altKey: true, nativeEvent: { isComposing: true } }, {}, "native"],
    ["IME keyCode blocks sending", { altKey: true, nativeEvent: { keyCode: 229 } }, {}, "native"],
    ["composition grace blocks sending", { altKey: true }, { lastCompositionEndAtRef: { current: 950 } }, "prevented"],
    ["mobile Alt+Enter keeps native behavior", { altKey: true }, { isMobile: true }, "native"],
    ["mobile composition grace cannot send", { altKey: true }, { isMobile: true, lastCompositionEndAtRef: { current: 950 } }, "native"],
    ["mobile Ctrl+Alt+Enter follows up", { altKey: true, ctrlKey: true }, { isMobile: true }, "followup"],
    ["mobile Cmd+Alt+Enter follows up", { altKey: true, metaKey: true }, { isMobile: true }, "followup"],
    ["mobile modified Enter respects composition grace", { altKey: true, ctrlKey: true }, { isMobile: true, lastCompositionEndAtRef: { current: 950 } }, "prevented"],
    ["Enter falls back to follow-up", {}, { onSteer: undefined }, "followup"],
    ["Alt+Enter falls back to steer", { altKey: true }, { onFollowUp: undefined }, "steer"],
    ["slash completion takes priority", { altKey: true }, { slashMenuOpen: true, slashQuery: "help" }, "slash"],
    ["available built-in commands take priority", { altKey: true }, { slashMenuOpen: true, slashQuery: "copy", value: "/copy", displayedSlashCommands: [{ name: "copy", source: "builtin", availableWhileStreaming: true }] }, "send"],
    ["file completion takes priority", { altKey: true }, { atMenuOpen: true, atQuery: {} }, "file"],
    ["history selection takes priority", { altKey: true }, { historyMenuOpen: true }, "history"],
  ];
  for (const [name, keys, state, expected] of cases) {
    let action = "native";
    const handler = script.runInNewContext({
      Date: { now: () => 1000 },
      COMPOSITION_END_ENTER_GRACE_MS: 100,
      imageMode: false, isMobile: false, isStreaming: true,
      isComposingRef: { current: false }, lastCompositionEndAtRef: { current: 0 },
      historyMenuOpen: false, inputHistory: ["previous"], historyActiveIndex: 0,
      slashMenuOpen: false, slashQuery: null, displayedSlashCommands: [{}], slashActiveIndex: 0,
      atMenuOpen: false, atQuery: null, atMatches: [{}], atActiveIndex: 0,
      onSteer() {}, onFollowUp() {},
      sendQueued(mode) { action = mode; }, handleSend() { action = "send"; },
      applySlashCommand() { action = "slash"; },
      isExactSlashCommand, value: "", setSlashMenuOpen() {},
      applyAtCompletion() { action = "file"; },
      applyHistoryInput() { action = "history"; },
      ...state,
    });
    handler({
      key: "Enter", shiftKey: false, altKey: false, ctrlKey: false, metaKey: false,
      nativeEvent: { isComposing: false, keyCode: 13 },
      preventDefault() { action = "prevented"; },
      ...keys,
    });
    assert.equal(action, expected, name);
  }
});

test("file mention arrows wrap around the match list", () => {
  const source = ts.createSourceFile("ChatInput.tsx", readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  function findHandler(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === "handleKeyDown") {
      return node.initializer.arguments[0];
    }
    return ts.forEachChild(node, findHandler);
  }
  const script = new Script(ts.transpileModule(findHandler(source).getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText);

  function move(key, atActiveIndex, length) {
    let next = null;
    const handler = script.runInNewContext({
      Date: { now: () => 1000 },
      COMPOSITION_END_ENTER_GRACE_MS: 100,
      isMobile: false, isStreaming: false,
      isComposingRef: { current: false }, lastCompositionEndAtRef: { current: 0 },
      historyMenuOpen: false, inputHistory: [], historyActiveIndex: 0,
      slashMenuOpen: false, slashQuery: null, displayedSlashCommands: [], slashActiveIndex: 0,
      atMenuOpen: true, atQuery: {}, atMatches: Array.from({ length }, () => ({})), atActiveIndex,
      onSteer() {}, onFollowUp() {},
      sendQueued() {}, handleSend() {},
      applySlashCommand() {},
      isExactSlashCommand() { return false; }, value: "@file",
      setSlashMenuOpen() {}, setAtMenuOpen() {},
      applyAtCompletion() {},
      applyHistoryInput() {},
      cycleListIndex,
      setAtActiveIndex(update) {
        next = typeof update === "function" ? update(atActiveIndex) : update;
      },
    });
    handler({
      key, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false,
      nativeEvent: { isComposing: false, keyCode: 0 },
      preventDefault() {},
    });
    return next;
  }

  assert.equal(move("ArrowDown", 0, 3), 1);
  assert.equal(move("ArrowDown", 2, 3), 0);
  assert.equal(move("ArrowUp", 0, 3), 2);
  assert.equal(move("ArrowUp", 1, 3), 0);
  assert.equal(move("ArrowDown", 0, 1), 0);
  assert.equal(move("ArrowDown", 0, 0), 0);
});

test("cycleListIndex wraps in both directions", () => {
  assert.equal(cycleListIndex(0, 3, 1), 1);
  assert.equal(cycleListIndex(2, 3, 1), 0);
  assert.equal(cycleListIndex(0, 3, -1), 2);
  assert.equal(cycleListIndex(1, 3, -1), 0);
  assert.equal(cycleListIndex(0, 1, 1), 0);
  assert.equal(cycleListIndex(4, 0, 1), 0);
  assert.equal(cycleListIndex(-1, 4, 1), 0);
});

test("shows the follow-up shortcut in the button tooltip", () => {
  const html = renderToStaticMarkup(
    React.createElement(I18nProvider, null, React.createElement(ChatInput, {
      onSend() {}, onAbort() {}, onFollowUp() {}, isStreaming: true,
    })),
  );

  assert.match(html, /title="Queue this message after the agent finishes \(Alt\/Option\+Enter\)"/);
  assert.match(html, /aria-keyshortcuts="Alt\+Enter"/);
});

test("renders the upstream model error", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ModelErrorBanner, {
        error: "Invalid models.json schema:\nproviders.custom.models.0.id must not be empty",
      }),
    ),
  );

  assert.match(html, /role="alert"/);
  assert.match(html, /Model error/);
  assert.match(html, /providers\.custom\.models\.0\.id must not be empty/);
});

test("does not render an empty model error", () => {
  assert.equal(
    renderToStaticMarkup(
      React.createElement(I18nProvider, null, React.createElement(ModelErrorBanner, { error: null })),
    ),
    "",
  );
});

test("renders enabledModels scope warnings", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ModelScopeWarningBanner, {
        warnings: ['No models match pattern "ghost-gateway/*"'],
      }),
    ),
  );

  assert.match(html, /Model scope warning/);
  assert.match(html, /ghost-gateway/);
  assert.equal(
    renderToStaticMarkup(
      React.createElement(I18nProvider, null, React.createElement(ModelScopeWarningBanner, { warnings: [] })),
    ),
    "",
  );
});

test("keeps the model selector visible when a model error leaves no options", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ChatInput, {
        onSend() {},
        onAbort() {},
        onModelChange() {},
        isStreaming: false,
        modelError: "Invalid models.json schema",
        modelList: [],
        modelNames: {},
      }),
    ),
  );

  assert.match(html, />No models</);
  assert.match(html, /title="No available models"/);
});

test("renders the read-only tool preset as the active selection", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ChatInput, {
        onSend() {},
        onAbort() {},
        onToolPresetChange() {},
        isStreaming: false,
        toolPreset: "read-only",
      }),
    ),
  );

  assert.match(html, /title="Change tool preset: read-only"/);
  assert.match(html, />read-only<\/span>/);
});

test("renders the empty tool preset as Chat only", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ChatInput, {
        onSend() {},
        onAbort() {},
        onToolPresetChange() {},
        isStreaming: false,
        toolPreset: "none",
      }),
    ),
  );

  assert.match(html, /title="Change tool preset: Chat only"/);
  assert.match(html, />Chat only<\/span>/);
});

test("renders the compact composer with the standard Send button and no session controls", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ChatInput, {
        onSend() {},
        onAbort() {},
        isStreaming: false,
        compact: true,
      }),
    ),
  );

  assert.match(html, /<textarea/);
  assert.match(html, />Send<\/button>/);
  assert.equal((html.match(/<button\b/g) ?? []).length, 1);
  assert.doesNotMatch(html, /type="file"|Attach image|Change tool preset/);
});

test("shows and locks the optimistic model while a switch is pending", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ChatInput, {
        onSend() {},
        onAbort() {},
        onModelChange() {},
        isStreaming: false,
        model: { provider: "deepseek", modelId: "deepseek-v4-flash" },
        modelList: [{ provider: "deepseek", id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" }],
        modelSwitching: true,
      }),
    ),
  );

  assert.match(html, /title="Switching model"/);
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /disabled=""/);
  assert.match(html, />DeepSeek V4 Flash</);
  assert.match(html, /animation:spin 0\.8s linear infinite/);
});

test("thinking selection is unavailable until model switching and its reload finish", () => {
  const render = (modelSwitching) => renderToStaticMarkup(React.createElement(I18nProvider, null,
    React.createElement(ChatInput, {
      onSend() {}, onAbort() {}, onThinkingLevelChange() {},
      isStreaming: false, modelSwitching, thinkingLevel: "high",
    })));
  const idle = render(false);
  const busy = render(true);
  assert.match(idle, /aria-label="Change reasoning level"/);
  assert.doesNotMatch(busy, /aria-label="Change reasoning level"/);
});

test("filters model options by name and id", () => {
  const options = [
    { provider: "ollama", modelId: "qwen3:latest", name: "Qwen 3" },
    { provider: "anthropic", modelId: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
    { provider: "openai", modelId: "gpt-5.4", name: "GPT-5.4" },
  ];

  assert.deepEqual(filterModelOptions(options, "QWEN"), [options[0]]);
  assert.deepEqual(filterModelOptions(options, "claude-sonnet"), [options[1]]);
  assert.equal(filterModelOptions(options, "OpenAI").length, 0);
  assert.equal(filterModelOptions(options, "anthropic/claude").length, 0);
  assert.equal(filterModelOptions(options, "missing").length, 0);
  assert.equal(filterModelOptions(options, "  "), options);
});

test("renders the shared field model selector as a disabled gray control", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ModelSelector, {
        options: [{ provider: "openai", modelId: "gpt-5.6-sol", name: "GPT-5.6 Sol" }],
        value: null,
        onChange() {},
        onClear() {},
        emptyLabel: "Parent default",
        ariaLabel: "Model override",
        disabled: true,
        variant: "field",
      }),
    ),
  );

  assert.match(html, /aria-label="Model override"/);
  assert.match(html, /disabled=""/);
  assert.match(html, /background:var\(--bg-panel\)/);
  assert.match(html, />Parent default</);
});

test("caps an upward menu to the visible space above its anchor", () => {
  assert.equal(getUpwardMenuMaxHeight(343, 36), 299);
  assert.equal(getUpwardMenuMaxHeight(40, 36), 0);
  // Composer sitting under a 36px top bar with only ~160px of air: a 400px
  // file list would paint through the bar and hide the leading matches.
  assert.equal(getUpwardMenuMaxHeight(200, 36), 156);
  assert.ok(getUpwardMenuMaxHeight(200, 36) < 400);
});

test("file mention menu applies the measured upward height cap", () => {
  const source = readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8");
  const start = source.indexOf("{atMenuOpen && atQuery !== null && (() => {");
  assert.notEqual(start, -1);
  const block = source.slice(start, start + 4000);
  assert.match(block, /ref=\{atMenuRef\}/);
  assert.match(block, /min\(48vh, 400px, \$\{atMenuMaxHeight\}px\)/);
  assert.match(block, /flexDirection: "column"/);
  assert.match(block, /minHeight: 0/);
  assert.equal(block.includes("maxHeight: \"min(48vh, 400px)\""), false);
});

test("file mention menu remeasures when its layout container shifts the anchor", () => {
  const source = readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8");
  const start = source.indexOf("function subscribeUpwardMenuMaxHeight");
  assert.notEqual(start, -1);
  const block = source.slice(start, start + 1800);
  assert.match(block, /const layoutContainer = parent\?\.parentElement;/);
  assert.match(block, /anchorObserver\?\.observe\(layoutContainer\)/);
});

test("compresses large images while preserving small images and GIFs", async () => {
  assert.equal(shouldCompressImageFile({ size: 1024 * 1024, type: "image/png" }), false);
  assert.equal(shouldCompressImageFile({ size: 1024 * 1024 + 1, type: "image/png" }), true);
  assert.equal(shouldCompressImageFile({ size: 2 * 1024 * 1024, type: "image/gif" }), false);

  const originals = {
    FileReader: globalThis.FileReader,
    createImageBitmap: globalThis.createImageBitmap,
    document: globalThis.document,
  };
  let bitmapCalls = 0;
  let closed = false;
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ fillStyle: "", fillRect() {}, drawImage() {} }),
    toDataURL: () => "data:image/jpeg;base64,COMPRESSED",
  };

  globalThis.FileReader = class {
    readAsDataURL() {
      this.result = "data:image/png;base64,ORIGINAL";
      this.onload();
    }
  };
  globalThis.createImageBitmap = async () => {
    bitmapCalls += 1;
    return { width: 2048, height: 1024, close() { closed = true; } };
  };
  globalThis.document = { createElement: () => canvas };

  try {
    assert.deepEqual(await compressImageFile({ size: 1024, type: "image/png" }), {
      data: "ORIGINAL",
      mimeType: "image/png",
    });
    assert.deepEqual(await compressImageFile({ size: 2 * 1024 * 1024, type: "image/png" }), {
      data: "COMPRESSED",
      mimeType: "image/jpeg",
    });
    assert.equal(bitmapCalls, 1);
    assert.equal(canvas.width, 1024);
    assert.equal(canvas.height, 512);
    assert.equal(closed, true);
  } finally {
    globalThis.FileReader = originals.FileReader;
    globalThis.createImageBitmap = originals.createImageBitmap;
    globalThis.document = originals.document;
  }
});

test("recognizes exact slash commands for one-Enter submission", () => {
  const builtin = { name: "copy", description: "", source: "builtin" };
  assert.equal(isExactSlashCommand("/copy", builtin), true);
  assert.equal(isExactSlashCommand("  /copy  ", builtin), true);
  assert.equal(isExactSlashCommand("/co", builtin), false);
  assert.equal(isExactSlashCommand("/copy extra", builtin), false);
  assert.equal(isExactSlashCommand("/copy", { ...builtin, source: "extension" }), false);
});

test("clears a completed built-in only while its submitted input is unchanged", () => {
  assert.equal(canClearBuiltinCommandInput("/copy", 0, "/copy"), true);
  assert.equal(canClearBuiltinCommandInput("new follow-up", 0, "/copy"), false);
  assert.equal(canClearBuiltinCommandInput("/copy", 1, "/copy"), false);
});

test("locks built-in command submission until it settles", async () => {
  const sourceText = readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8");
  const source = ts.createSourceFile("ChatInput.tsx", sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  function findCallback(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === "runBuiltinCommand") {
      return node.initializer.arguments[0];
    }
    return ts.forEachChild(node, findCallback);
  }
  const callback = new Script(ts.transpileModule(findCallback(source).getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText).runInNewContext({
    attachedImages: [],
    attachedImagesRef: { current: [] },
    builtinCommandPendingRef: { current: false },
    mountedRef: { current: true }, draftOwnerRef: { current: {} },
    canClearBuiltinCommandInput,
    clearInput() {},
    onBuiltinCommand: async () => new Promise((resolve) => { callback.resolve = resolve; }),
    setBuiltinCommandPending(value) { callback.pendingStates.push(value); },
    valueRef: { current: "/reload" },
  });
  callback.pendingStates = [];

  const first = callback("/reload");
  assert.deepEqual(callback.pendingStates, [true]);
  assert.equal(await callback("/reload"), true);
  assert.deepEqual(callback.pendingStates, [true]);
  callback.resolve({ handled: true });
  assert.equal(await first, true);
  assert.deepEqual(callback.pendingStates, [true, false]);
  assert.match(sourceText, /<fieldset\s+disabled=\{builtinCommandPending\}\s+aria-busy=\{builtinCommandPending\}/);
});

test("keeps only read-only built-ins available while a run is active", () => {
  assert.equal(canRunBuiltinSlashCommandWhileStreaming("/copy"), true);
  assert.equal(canRunBuiltinSlashCommandWhileStreaming("/session"), true);
  assert.equal(canRunBuiltinSlashCommandWhileStreaming("/compact"), false);
  assert.equal(canRunBuiltinSlashCommandWhileStreaming("/auto-compact"), false);
  assert.equal(canRunBuiltinSlashCommandWhileStreaming("/reload"), false);
});

test("restores text and base64 images when editing a user message", () => {
  const message = {
    role: "user",
    content: [
      { type: "text", text: "Review this image @src/example.ts " },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AQID" } },
    ],
  };

  assert.equal(getUserMessageText(message), "Review this image @src/example.ts ");
  assert.deepEqual(getUserMessageDraftImages(message), [
    { data: "AQID", mimeType: "image/png" },
  ]);
});

test("restores legacy flat image entries when editing a user message", () => {
  const message = {
    role: "user",
    content: [
      { type: "image", data: "AQID", mimeType: "image/jpeg" },
    ],
  };

  assert.deepEqual(getUserMessageDraftImages(message), [
    { data: "AQID", mimeType: "image/jpeg" },
  ]);
});

test("does not restore a historical message over a pending image attachment", () => {
  assert.equal(canRestoreUserMessage("", 0, 0), true);
  assert.equal(canRestoreUserMessage("", 1, 0), false);
  assert.equal(canRestoreUserMessage("", 0, 1), false);
  assert.equal(canRestoreUserMessage("draft", 0, 0), false);
});

test("restores a cleared submission using the queued React state", () => {
  let value = "failed submission";
  const updates = [
    () => "",
    (current) => mergeRestoredSubmissionText("failed submission", current),
  ];

  for (const update of updates) value = update(value);

  assert.equal(value, "failed submission");
  assert.equal(
    mergeRestoredSubmissionText("failed submission", "new draft"),
    "failed submission\n\nnew draft",
  );
  assert.equal(
    mergeRestoredSubmissionText("failed submission", "failed submission"),
    "failed submission\n\nfailed submission",
  );
});

test("keeps a failed first submission recoverable across a composer remount", () => {
  const image = { data: "AQID", mimeType: "image/png" };
  const restored = mergeRestoredSubmissionDraft(
    "failed submission",
    [image],
    "",
    [],
  );

  assert.deepEqual(restored, {
    value: "failed submission",
    images: [image],
  });
  assert.deepEqual(
    mergeRestoredSubmissionDraft("failed submission", [image], "new draft", []),
    {
      value: "failed submission\n\nnew draft",
      images: [image],
    },
  );
});

test("preserves duplicate image attachments when restoring a submission", () => {
  const image = { data: "AQID", mimeType: "image/png" };
  const restored = mergeRestoredSubmissionDraft("", [image, image], "", [image]);

  assert.deepEqual(restored.images, [image, image, image]);
});

test("moves a provisional new-session draft to the real session key", () => {
  const provisionalKey = "new:/tmp/rekey-test";
  const sessionKey = "session-rekey-test";
  clearDraft(provisionalKey);
  clearDraft(sessionKey);
  setDraft(provisionalKey, { value: "queued while preflight ran", images: [] });

  assert.deepEqual(rekeyDraft(provisionalKey, sessionKey), {
    value: "queued while preflight ran",
    images: [],
  });
  assert.equal(getDraft(provisionalKey), null);
  assert.deepEqual(getDraft(sessionKey), {
    value: "queued while preflight ran",
    images: [],
  });

  clearDraft(sessionKey);
});

test("rekey keeps a synchronously restored draft when React state is still empty", () => {
  const provisionalKey = "new:/tmp/rekey-race";
  const sessionKey = "session-rekey-race";
  clearDraft(provisionalKey);
  clearDraft(sessionKey);
  setDraft(provisionalKey, { value: "restored before state flush", images: [] });

  assert.deepEqual(
    rekeyDraft(provisionalKey, sessionKey, { value: "", images: [] }),
    { value: "restored before state flush", images: [] },
  );
  assert.equal(getDraft(provisionalKey), null);
  assert.deepEqual(getDraft(sessionKey), {
    value: "restored before state flush",
    images: [],
  });

  clearDraft(sessionKey);
});

test("renders compact errors above the input as a wrapping alert", () => {
  const error = "Compaction failed: OpenAI API error (403): <html>request forbidden</html>";
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ChatInput, {
        onSend() {},
        onAbort() {},
        onCompact() {},
        isStreaming: false,
        compactError: error,
      }),
    ),
  );

  assert.match(html, /role="alert"/);
  assert.match(html, /Compaction failed: OpenAI API error/);
  assert.match(html, /&lt;html&gt;request forbidden&lt;\/html&gt;/);
  assert.match(html, /white-space:pre-wrap/);
  assert.ok(html.indexOf('role="alert"') < html.indexOf("<textarea"));
});

test("modelSupportsImageInput warns only when modality info is known and lacks image", () => {
  const modelList = [
    { id: "text-only", name: "Text Only", provider: "ollama", input: ["text"] },
    { id: "vision", name: "Vision", provider: "anthropic", input: ["text", "image"] },
    { id: "unknown", name: "Unknown", provider: "custom", input: undefined },
  ];

  assert.equal(modelSupportsImageInput({ provider: "ollama", modelId: "text-only" }, modelList), false);
  assert.equal(modelSupportsImageInput({ provider: "anthropic", modelId: "vision" }, modelList), true);
  // Unknown modality info never blocks the user.
  assert.equal(modelSupportsImageInput({ provider: "custom", modelId: "unknown" }, modelList), true);
  // Model missing from the list is treated as unknown.
  assert.equal(modelSupportsImageInput({ provider: "x", modelId: "missing" }, modelList), true);
  assert.equal(modelSupportsImageInput(null, modelList), true);
  assert.equal(modelSupportsImageInput({ provider: "ollama", modelId: "text-only" }, undefined), true);
});

test("renders image warnings for known text-only defaults without an explicit model selection", () => {
  const draftKey = "new:/tmp/image-warning-default";
  const modelList = [
    { id: "text-only", name: "Text Only", provider: "custom", input: ["text"] },
    { id: "vision", name: "Vision", provider: "custom", input: ["text", "image"] },
    { id: "unknown", name: "Unknown", provider: "custom" },
  ];
  setDraft(draftKey, {
    value: "Describe this image",
    images: [{ data: "aW1hZ2U=", mimeType: "image/png" }],
  });

  try {
    for (const [modelId, warningExpected] of [["text-only", true], ["vision", false], ["unknown", false], [null, false]]) {
      const html = renderToStaticMarkup(
        React.createElement(
          I18nProvider,
          null,
          React.createElement(ChatInput, {
            onSend() {},
            onAbort() {},
            isStreaming: false,
            isAutoModelSelection: true,
            model: modelId ? { provider: "custom", modelId } : null,
            modelList,
            draftKey,
          }),
        ),
      );

      assert.match(html, /<img/);
      assert.equal(html.includes("Images may not be sent"), warningExpected, `default model: ${modelId}`);
      if (warningExpected) {
        assert.match(html, /The selected model \(Text Only\) does not support image input/);
        assert.ok(html.indexOf('role="alert"') < html.indexOf("<textarea"));
      }
    }
  } finally {
    clearDraft(draftKey);
  }
});
