// Built-in `generate_image` tool, registered as an inline extension the same
// way pi-web's subagent tools are (see lib/subagent-extension.ts). Any chat
// model can call it; results carry ImageContent blocks that pi-ai provider
// adapters already know how to serialize (text for the LLM, images preserved
// for vision-capable follow-up turns and the web UI).

import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import {
  getImagesModels,
  imageCredentialsFromModelRegistry,
  isImageProviderConfigured,
  runImageGeneration,
  normalizeImageGenerationRequest,
  summarizeImageGeneration,
  type ImageGenerationRequest,
} from "./image-gen";
import {
  IMAGE_GEN_TOOL_NAME,
  type ImageGenerationToolDetails,
} from "./image-gen-shared";
import { MAX_IMAGE_GENERATION_COUNT } from "./image-gen-shared";

export { IMAGE_GEN_TOOL_NAME };
export type { ImageGenerationToolDetails };

export const HOST_IMAGE_EXTENSION_NAME = "pi-web-image-gen";

export function imageGenerationToolDetails(
  request: ImageGenerationRequest,
  durationMs: number,
  requestedBy: "tool" | "composer",
): ImageGenerationToolDetails {
  return {
    kind: "pi-web-image-generation",
    model: request.model,
    prompt: request.prompt,
    ...(request.aspectRatio ? { aspectRatio: request.aspectRatio } : {}),
    count: request.count ?? 1,
    ...(request.seed !== undefined ? { seed: request.seed } : {}),
    durationMs,
    requestedBy,
  };
}

export function createImageGenerationExtension(): InlineExtension {
  return {
    name: HOST_IMAGE_EXTENSION_NAME,
    hidden: true,
    factory: (pi) => {
      pi.registerTool(defineTool({
        name: IMAGE_GEN_TOOL_NAME,
        label: "Generate image",
        description: "Generate images from a text prompt with a configured image model (text-to-image). "
          + "Returns the generated images as image content blocks. "
          + "Prefer this whenever the user asks to draw, create, or paint an image or illustration. "
          + 'The optional model parameter takes "provider/modelId"; omit it to use the default configured image model.',
        promptSnippet: "Generate an image from a text prompt",
        promptGuidelines: [
          "Use generate_image whenever the user asks for a picture, illustration, wallpaper, or icon.",
          "Write a rich, concrete visual prompt; include subject, style, composition, lighting, and mood.",
          "Iterate on feedback by calling generate_image again with an improved prompt.",
        ],
        parameters: Type.Object({
          prompt: Type.String({ description: "Detailed visual description of the image to generate." }),
          model: Type.Optional(Type.String({
            description: 'Image model as "provider/modelId". Omit to use the first configured model.',
          })),
          aspect_ratio: Type.Optional(Type.Union([
            Type.Literal("1:1"),
            Type.Literal("3:4"),
            Type.Literal("4:3"),
            Type.Literal("16:9"),
            Type.Literal("9:16"),
          ], { description: "Output aspect ratio. Omit for the model default." })),
          count: Type.Optional(Type.Number({
            description: `Number of images to generate (1-${MAX_IMAGE_GENERATION_COUNT}). Default 1.`,
            minimum: 1,
            maximum: MAX_IMAGE_GENERATION_COUNT,
          })),
          seed: Type.Optional(Type.Number({ description: "Seed for reproducible generation, when supported." })),
        }),
        async execute(_toolCallId, params, signal, _onUpdate, ctx) {
          try {
            if (!params.prompt.trim()) throw new Error("Image generation requires a prompt");
            const imagesModels = getImagesModels(imageCredentialsFromModelRegistry(ctx.modelRegistry));

            let model = params.model !== undefined ? splitModelRef(params.model) : undefined;
            if (params.model !== undefined && !model) {
              throw new Error('Invalid image model: expected "provider/modelId"');
            }
            if (!model) {
              const first = imagesModels.getModels().find(
                (candidate) => isImageProviderConfigured(ctx.modelRegistry, candidate.provider),
              );
              if (!first) {
                return {
                  content: [{
                    type: "text",
                    text: "No image model is configured. Store an OpenRouter API key in Models settings first.",
                  }],
                  details: undefined,
                  isError: true,
                };
              }
              model = { provider: first.provider, modelId: first.id };
            }

            const request = normalizeImageGenerationRequest({
              prompt: params.prompt,
              model,
              aspectRatio: params.aspect_ratio,
              count: params.count,
              seed: params.seed,
            });

            const outcome = await runImageGeneration(imagesModels, request, signal);
            const text = summarizeImageGeneration(request, outcome);
            const images = outcome.result.output.filter(
              (block): block is { type: "image"; data: string; mimeType: string } => block.type === "image",
            );
            return {
              content: [
                ...images,
                ...outcome.result.output.filter((block) => block.type === "text"),
                { type: "text", text },
              ],
              details: imageGenerationToolDetails(request, outcome.durationMs, "tool"),
              ...(outcome.result.stopReason !== "stop" ? { isError: true } : {}),
            };
          } catch (error) {
            return {
              content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
              details: undefined,
              isError: true,
            };
          }
        },
      }));
    },
  };
}

export function splitModelRef(ref: string): { provider: string; modelId: string } | undefined {
  const separator = ref.indexOf("/");
  if (separator <= 0 || separator === ref.length - 1) return undefined;
  const provider = ref.slice(0, separator).trim();
  const modelId = ref.slice(separator + 1).trim();
  if (!provider || !modelId) return undefined;
  return { provider, modelId };
}
