import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./MessageView.tsx", import.meta.url), "utf8");

test("generate_image tool calls render through the dedicated card", () => {
  assert.match(source, /import \{ IMAGE_GEN_TOOL_NAME, isImageGenerationToolDetails \} from "@\/lib\/image-gen-shared"/);
  assert.match(source, /if \(block\.toolName === IMAGE_GEN_TOOL_NAME && !isEditTool\)/);
  assert.match(source, /<ImageGenerationCard/);
});

test("the card shows the prompt, model meta, and result actions", () => {
  const cardSource = source.slice(source.indexOf("function ImageGenerationCard"));
  assert.match(cardSource, /image-gen-card-head/);
  assert.match(cardSource, /image-gen-prompt/);
  assert.match(cardSource, /PROMPT/);
  assert.match(cardSource, /image-gen-foot/);
  assert.match(cardSource, /onClick=\{\(\) => onReuseImagePrompt\(prompt\)\}/);
  assert.match(cardSource, /\/api\/images\/save/);
  assert.match(cardSource, /downloadImageGenImage/);
});

test("the card renders a pending placeholder state before the result arrives", () => {
  const cardSource = source.slice(source.indexOf("function ImageGenerationCard"));
  assert.match(cardSource, /isPending = !result/);
  assert.match(cardSource, /image-gen-placeholder/);
  assert.match(cardSource, /chat\.imageGenCardGenerating/);
});

test("collapsed tool cards show image thumbnails from the paired result", () => {
  const blockSource = source.slice(source.indexOf("function ToolCallBlock"), source.indexOf("function ImageGenerationCard"));
  assert.match(blockSource, /\{!expanded && resultImages\.length > 0 && \(/);
  assert.match(blockSource, /className="tool-result-thumbs"/);
});

test("image generation card actions stay in the message flow width", () => {
  const cardSource = source.slice(source.indexOf("function ImageGenerationCard"));
  assert.match(cardSource, /imageGridCountClass\(images\.length, requestedCount\)/);
  assert.match(cardSource, /imageGenRatioClass\(aspectRatio\)/);
});
