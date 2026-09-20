import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const chatInputSource = await readFile(new URL("./ChatInput.tsx", import.meta.url), "utf8");
const chatWindowSource = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const modelSelectorSource = await readFile(new URL("./ModelSelector.tsx", import.meta.url), "utf8");

test("composer exposes an image-generation mode only when models and a handler exist", () => {
  assert.match(chatInputSource, /imageGenAvailable = Boolean\(onImageGenerate && imageModels && imageModels\.length > 0\)/);
  assert.match(chatInputSource, /\{imageGenAvailable && \(/);
  assert.match(chatInputSource, /setImageMode\(true\)/);
  assert.match(chatInputSource, /setImageMode\(false\)/);
});

test("image mode swaps the model selector to the image model list", () => {
  assert.match(chatInputSource, /imageMode && imageGenAvailable\s*\?\s*\(onImageModelChange && \(/);
  assert.match(chatInputSource, /options=\{\(imageModels \?\? \[\]\)\.map\(\(m\) => \(\{ \.\.\.m, kind: "image" as const \}\)\)\}/);
});

test("image mode sends through onImageGenerate with composer parameters", () => {
  const sendSource = chatInputSource.slice(
    chatInputSource.indexOf("const handleSend = useCallback"),
    chatInputSource.indexOf("const slashQuery"),
  );
  assert.match(sendSource, /if \(imageMode\)/);
  assert.match(sendSource, /!onImageGenerate \|\| !activeImageModel/);
  assert.match(sendSource, /onImageGenerate\(msg, attachedImages\.length \? attachedImages : \[\], \{/);
  assert.match(sendSource, /aspectRatio: imageAspectRatio/);
  assert.match(sendSource, /count: imageCount/);
});

test("image parameters persist to browser storage", () => {
  assert.match(chatInputSource, /setImageGenPreferences\(\{/);
  assert.match(chatInputSource, /getImageGenPreferences\(\)/);
});

test("generate button reflects busy state in image mode", () => {
  assert.match(chatInputSource, /disabled=\{overImageLimit \|\| \(!value\.trim\(\) && !attachedImages\.length\) \|\| isGeneratingImage\}/);
  assert.match(chatInputSource, /\{imageMode \? t\("chat\.imageGenSend"\) : t\("chat\.send"\)\}/);
});

test("ChatWindow wires image generation props through to the composer", () => {
  assert.match(chatWindowSource, /imageModelList\.map\(\(m\) => \(\{ provider: m\.provider, modelId: m\.id, name: m\.name \}\)\)/);
  assert.match(chatWindowSource, /onImageGenerate=\{handleImageGenerate\}/);
  assert.match(chatWindowSource, /isGeneratingImage=\{isGeneratingImage\}/);
  assert.match(chatWindowSource, /onReuseImagePrompt=\{reuseImagePrompt\}/);
});

test("ModelSelector renders an image badge for kind=image options", () => {
  assert.match(modelSelectorSource, /kind\?: "image"/);
  assert.match(modelSelectorSource, /kind=\{option\.kind\}/);
  assert.match(modelSelectorSource, /t\("chat\.imageGenBadge"\)/);
});
