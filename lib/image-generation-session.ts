// Appends direct (composer-mode) image generations to a session file as a
// normal user message → assistant toolCall → toolResult entry triple, so the
// result renders through the standard tool-call UI and later turns see the
// images in context exactly like an agent-driven generate_image call.
//
// Writes always go through the SDK's SessionManager (same persistence the
// agent loop uses); callers must ensure the session is idle first.

import type { AssistantImages } from "@earendil-works/pi-ai";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "crypto";
import { IMAGE_GEN_TOOL_NAME, imageGenerationToolDetails } from "./image-gen-extension";
import { normalizeImageGenerationRequest, validateImageReferenceCount, zeroImageUsage, type ImageGenerationRequest } from "./image-gen";

export interface AppendImageGenerationInput {
  prompt: string;
  images?: Array<{ data: string; mimeType: string }>;
}

export interface AppendImageGenerationResult {
  userEntryId: string;
  assistantEntryId: string;
  toolResultEntryId: string;
  toolCallId: string;
}

export function newImageToolCallId(): string {
  return `img_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

/** pi-ai on-disk toolCall block shape (id/name/arguments — pre-normalization). */
function toolCallBlock(toolCallId: string, request: ImageGenerationRequest) {
  const count = request.count ?? 1;
  return {
    type: "toolCall" as const,
    id: toolCallId,
    name: IMAGE_GEN_TOOL_NAME,
    arguments: {
      prompt: request.prompt,
      model: `${request.model.provider}/${request.model.modelId}`,
      ...(request.aspectRatio ? { aspect_ratio: request.aspectRatio } : {}),
      ...(count > 1 ? { count } : {}),
      ...(request.seed !== undefined ? { seed: request.seed } : {}),
    } as Record<string, unknown>,
  };
}

/**
 * Append a completed image generation turn to the session. The assistant
 * entry mirrors what the agent loop would have written for the same tool
 * call, including usage/stopReason from the image API response.
 */
export function appendImageGenerationTurn(
  sessionManager: SessionManager,
  input: AppendImageGenerationInput & { request: ImageGenerationRequest; result: AssistantImages; durationMs: number },
): AppendImageGenerationResult {
  const { request, result, durationMs } = input;
  validateImageReferenceCount(request.referenceImages);
  validateImageReferenceCount(input.images);
  const now = Date.now();

  const userEntryId = sessionManager.appendMessage({
    role: "user",
    content: [
      { type: "text" as const, text: input.prompt },
      ...(input.images ?? []).map((img) => ({
        type: "image" as const,
        data: img.data,
        mimeType: img.mimeType,
      })),
    ],
    timestamp: now,
  });

  const toolCallId = newImageToolCallId();
  const assistantEntryId = sessionManager.appendMessage({
    role: "assistant",
    content: [toolCallBlock(toolCallId, request)],
    api: result.api,
    provider: result.provider,
    model: result.model,
    usage: result.usage ?? zeroImageUsage(),
    stopReason: result.stopReason,
    timestamp: now,
  });

  const isError = result.stopReason !== "stop";
  const imageBlocks = result.output.filter(
    (block): block is { type: "image"; data: string; mimeType: string } => block.type === "image",
  );
  const textBlocks = result.output.filter(
    (block): block is { type: "text"; text: string } => block.type === "text",
  );
  const providerText = textBlocks.map((block) => block.text).join("\n").trim();
  const failureText = result.stopReason === "aborted"
    ? "Image generation cancelled."
    : `Image generation failed: ${result.errorMessage ?? "unknown error"}`;
  const summaryText = isError
    ? [providerText, failureText].filter(Boolean).join("\n")
    : providerText || `Generated ${imageBlocks.length} image${imageBlocks.length === 1 ? "" : "s"}.`;

  const toolResultEntryId = sessionManager.appendMessage({
    role: "toolResult",
    toolCallId,
    toolName: IMAGE_GEN_TOOL_NAME,
    content: [
      ...imageBlocks,
      { type: "text" as const, text: summaryText },
    ],
    details: imageGenerationToolDetails(request, durationMs, "composer"),
    isError,
    timestamp: now,
  });

  return { userEntryId, assistantEntryId, toolResultEntryId, toolCallId };
}

/** Parse and validate the RPC command payload before touching the session. */
export function parseImageGenerateCommand(command: Record<string, unknown>): {
  input: AppendImageGenerationInput;
  request: ImageGenerationRequest;
} {
  const request = normalizeImageGenerationRequest({
    prompt: command.prompt,
    model: command.imageModel,
    referenceImages: command.images,
    aspectRatio: command.aspectRatio,
    count: command.count,
    seed: command.seed,
  });

  return {
    input: {
      prompt: request.prompt,
      ...(request.referenceImages?.length ? { images: request.referenceImages } : {}),
    },
    request,
  };
}
