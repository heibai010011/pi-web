// Image generation core for pi-web.
//
// pi-ai ships a complete image-generation layer (`createImagesModels()` +
// `generateImages()`), but pi's AgentSession never wires it up. This module is
// the single server-side entry point both consumers share:
//   - the built-in `generate_image` tool (lib/image-gen-extension.ts)
//   - the direct composer mode RPC command (`image_generate` in rpc-manager)
//
// Generation parameters map onto OpenRouter's chat-completions image surface:
// `image_config.aspect_ratio` plus a top-level `seed`, injected through
// pi-ai's `onPayload` hook so the SDK request path stays untouched.

import {
  createImagesModels,
  type AssistantImages,
  type ImagesApi,
  type ImagesContext,
  type ImagesModel,
  type ImagesModels,
  type ImagesOptions,
  type Usage,
} from "@earendil-works/pi-ai";
import { openrouterImagesProvider } from "@earendil-works/pi-ai/providers/openrouter-images";
import {
  isImageAspectRatio as isValidAspectRatio,
  MAX_IMAGE_GENERATION_COUNT,
  MAX_REFERENCE_IMAGES,
  type ImageGenerationRequest,
  type ImageModelOption,
} from "./image-gen-shared";

export * from "./image-gen-shared";

/** Structural subset of pi-ai's CredentialStore that ModelRuntime.credentials satisfies. */
export interface ImageCredentialsLike {
  read(providerId: string, options?: unknown): Promise<unknown>;
  list(options?: unknown): Promise<unknown>;
}

/** Minimal structural view of ExtensionContext.modelRegistry used for auth. */
export interface ModelRegistryAuthLike {
  getProviderAuthStatus(provider: string): { configured: boolean } | undefined;
  getProviderAuth(provider: string): Promise<{ auth?: { apiKey?: string } } | undefined>;
}

/**
 * Adapter that lets the built-in tool extension authorize image generation
 * through ExtensionContext.modelRegistry. OAuth-backed access tokens surface
 * as request `auth.apiKey`, so both credential kinds reduce to an api_key
 * entry here. Write paths are intentionally unsupported.
 */
export function imageCredentialsFromModelRegistry(registry: ModelRegistryAuthLike): ImageCredentialsLike {
  return {
    async read(providerId: string) {
      try {
        const resolved = await registry.getProviderAuth(providerId);
        const apiKey = resolved?.auth?.apiKey;
        return apiKey ? { type: "api_key", key: apiKey } : undefined;
      } catch {
        return undefined;
      }
    },
    async list() {
      return [];
    },
  };
}

export function isImageProviderConfigured(registry: ModelRegistryAuthLike, providerId: string): boolean {
  return registry.getProviderAuthStatus(providerId)?.configured === true;
}

export interface ImageGenerationOutcome {
  result: AssistantImages;
  requestedCount: number;
  durationMs: number;
}

declare global {
  var __piImagesModels: WeakMap<object, ImagesModels> | undefined;
}

function getImagesModelsRegistry(): WeakMap<object, ImagesModels> {
  if (!globalThis.__piImagesModels) globalThis.__piImagesModels = new WeakMap();
  return globalThis.__piImagesModels;
}

/**
 * Build (and memoize per credential store) the ImagesModels runtime. The same
 * credential store backing the chat ModelRuntime is reused, so API keys stored
 * through pi's AuthStorage (auth.json) authorize image generation too.
 */
export function getImagesModels(credentials: ImageCredentialsLike): ImagesModels {
  const registry = getImagesModelsRegistry();
  const existing = registry.get(credentials);
  if (existing) return existing;

  const imagesModels = createImagesModels({ credentials: credentials as never });
  for (const provider of defaultImageProviders()) {
    imagesModels.setProvider(provider);
  }
  registry.set(credentials, imagesModels);
  return imagesModels;
}

function defaultImageProviders() {
  return [openrouterImagesProvider()];
}

/** Resolve an image model by provider/id, refreshing nothing — static catalog only. */
export function findImageModel(imagesModels: ImagesModels, provider: string, modelId: string): ImagesModel<ImagesApi> | undefined {
  return imagesModels.getModel(provider, modelId);
}

/** List image models with a `configured` flag derived from stored credentials. */
export async function listImageModels(
  imagesModels: ImagesModels,
  isProviderConfigured: (providerId: string) => boolean,
): Promise<ImageModelOption[]> {
  const seen = new Set<string>();
  const models: ImageModelOption[] = [];
  for (const model of imagesModels.getModels()) {
    const key = `${model.provider}:${model.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!isProviderConfigured(model.provider)) continue;
    models.push({ provider: model.provider, modelId: model.id, name: model.name });
  }
  return models;
}

function normalizeImageCount(count: unknown): number {
  const integer = typeof count === "number" && Number.isFinite(count) ? Math.floor(count) : 1;
  return Math.min(MAX_IMAGE_GENERATION_COUNT, Math.max(1, integer));
}

export class ImageGenerationValidationError extends Error {
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = "ImageGenerationValidationError";
  }
}

/** Count submitted slots before filtering so malformed extras cannot evade the limit. */
export function validateImageReferenceCount(referenceImages: unknown): void {
  if (Array.isArray(referenceImages) && referenceImages.length > MAX_REFERENCE_IMAGES) {
    throw new ImageGenerationValidationError(`Image generation supports at most ${MAX_REFERENCE_IMAGES} reference images; received ${referenceImages.length}.`);
  }
}

export function normalizeImageGenerationRequest(input: {
  prompt?: unknown;
  model?: unknown;
  referenceImages?: unknown;
  aspectRatio?: unknown;
  count?: unknown;
  seed?: unknown;
}): ImageGenerationRequest {
  validateImageReferenceCount(input.referenceImages);
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  if (!prompt) throw new Error("Image generation requires a prompt");

  const model = (typeof input.model === "object" && input.model !== null
    ? input.model as { provider?: unknown; modelId?: unknown }
    : {});
  const provider = typeof model.provider === "string" ? model.provider.trim() : "";
  const modelId = typeof model.modelId === "string" ? model.modelId.trim() : "";
  if (!provider || !modelId) {
    throw new Error("Image generation requires a model (provider + modelId)");
  }

  const referenceImages = Array.isArray(input.referenceImages)
    ? input.referenceImages
        .filter((img): img is { data: string; mimeType: string } => (
          typeof img === "object" && img !== null
          && typeof (img as { data?: unknown }).data === "string"
          && typeof (img as { mimeType?: unknown }).mimeType === "string"
        ))
    : undefined;

  const count = normalizeImageCount(input.count);

  return {
    prompt,
    model: { provider, modelId },
    ...(referenceImages?.length ? { referenceImages } : {}),
    ...(isValidAspectRatio(input.aspectRatio) ? { aspectRatio: input.aspectRatio } : {}),
    count,
    ...(typeof input.seed === "number" && Number.isFinite(input.seed) ? { seed: Math.floor(input.seed) } : {}),
  };
}

/**
 * Merge generation params into an OpenRouter chat-completions payload.
 * Exported for tests; applied through pi-ai's onPayload hook.
 */
export function applyImageGenerationParams(payload: unknown, request: ImageGenerationRequest): unknown {
  if (typeof payload !== "object" || payload === null) return payload;
  const next: Record<string, unknown> = { ...(payload as Record<string, unknown>) };
  if (request.aspectRatio) {
    next.image_config = {
      ...(typeof next.image_config === "object" && next.image_config !== null ? next.image_config : {}),
      aspect_ratio: request.aspectRatio,
    };
  }
  if (request.seed !== undefined) next.seed = request.seed;
  return next;
}

function buildImagesContext(request: ImageGenerationRequest): ImagesContext {
  return {
    input: [
      { type: "text" as const, text: request.prompt },
      ...(request.referenceImages ?? []).map((img) => ({
        type: "image" as const,
        data: img.data,
        mimeType: img.mimeType,
      })),
    ],
  };
}

/**
 * Run one image generation request. `count > 1` fans out to parallel calls and
 * merges outputs, because the chat-completions image surface returns one image
 * per response. Failures never reject: they merge as an error result, matching
 * pi-ai's AssistantImages contract.
 */
export async function runImageGeneration(
  imagesModels: ImagesModels,
  request: ImageGenerationRequest,
  signal?: AbortSignal,
): Promise<ImageGenerationOutcome> {
  validateImageReferenceCount(request.referenceImages);
  const model = findImageModel(imagesModels, request.model.provider, request.model.modelId);
  if (!model) {
    throw new Error(`Image model not found: ${request.model.provider}/${request.model.modelId}`);
  }

  const context = buildImagesContext(request);
  const requestedCount = normalizeImageCount(request.count);
  const startedAt = Date.now();

  const runOne = async (): Promise<AssistantImages> => {
    const options: ImagesOptions = {
      ...(signal ? { signal } : {}),
      onPayload: (payload) => applyImageGenerationParams(payload, request),
    };
    try {
      signal?.throwIfAborted();
      return await imagesModels.generateImages(model, context, options);
    } catch (error) {
      // Isolate provider rejections so sibling images and usage are not lost.
      return {
        api: model.api,
        provider: model.provider,
        model: model.id,
        output: [],
        stopReason: signal?.aborted ? "aborted" : "error",
        errorMessage: error instanceof Error ? error.message : "Image provider request failed",
        timestamp: Date.now(),
      };
    }
  };

  const results = requestedCount === 1
    ? [await runOne()]
    : await Promise.all(Array.from({ length: requestedCount }, () => runOne()));

  return {
    result: mergeAssistantImages(results),
    requestedCount,
    durationMs: Date.now() - startedAt,
  };
}

/** Merge parallel generation responses into one AssistantImages. */
export function mergeAssistantImages(results: readonly AssistantImages[]): AssistantImages {
  const first = results[0];
  if (!first) {
    throw new Error("No image generation results to merge");
  }
  if (results.length === 1 && (first.stopReason !== "stop" || first.output.some((block) => block.type === "image"))) return first;

  const output = results.flatMap((result) => result.output);
  const usage = results.reduce<Usage | undefined>((acc, result) => {
    if (!result.usage) return acc;
    if (!acc) return result.usage;
    return {
      input: acc.input + result.usage.input,
      output: acc.output + result.usage.output,
      cacheRead: acc.cacheRead + result.usage.cacheRead,
      cacheWrite: acc.cacheWrite + result.usage.cacheWrite,
      totalTokens: acc.totalTokens + result.usage.totalTokens,
      cost: {
        input: acc.cost.input + result.usage.cost.input,
        output: acc.cost.output + result.usage.cost.output,
        cacheRead: acc.cost.cacheRead + result.usage.cost.cacheRead,
        cacheWrite: acc.cost.cacheWrite + result.usage.cost.cacheWrite,
        total: acc.cost.total + result.usage.cost.total,
      },
    };
  }, undefined);

  const emptyResponses = results.filter((result) => result.stopReason === "stop"
    && !result.output.some((block) => block.type === "image"));
  const error = results.find((result) => result.stopReason === "error")
    ?? results.find((result) => result.stopReason === "aborted")
    ?? (emptyResponses.length ? {
      stopReason: "error" as const,
      errorMessage: `Image generation returned no images in ${emptyResponses.length} of ${results.length} requests`,
    } : undefined);
  const images = output.filter((block): block is Extract<typeof block, { type: "image" }> => block.type === "image");

  return {
    api: first.api,
    provider: first.provider,
    model: first.model,
    output,
    responseId: first.responseId,
    ...(usage ? { usage } : {}),
    stopReason: error || images.length === 0 ? (error?.stopReason ?? "error") : "stop",
    ...(error?.errorMessage || images.length === 0
      ? {
          errorMessage: error?.errorMessage
            ?? (error?.stopReason === "aborted" ? "Image generation cancelled"
              : `Image generation returned no images (${results.length} requests)`),
        }
      : {}),
    timestamp: Math.min(...results.map((result) => result.timestamp)),
  };
}

export function zeroImageUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/** Human-readable summary appended to tool results so non-image consumers still see state. */
export function summarizeImageGeneration(request: ImageGenerationRequest, outcome: ImageGenerationOutcome): string {
  const { result, requestedCount, durationMs } = outcome;
  const images = result.output.filter((block) => block.type === "image");
  const parts = [
    `${request.model.provider}/${request.model.modelId}`,
    request.aspectRatio ? `aspect ${request.aspectRatio}` : undefined,
    `${images.length}/${requestedCount} image${requestedCount > 1 ? "s" : ""}`,
    request.seed !== undefined ? `seed ${request.seed}` : undefined,
    `${(durationMs / 1000).toFixed(1)}s`,
  ].filter(Boolean);
  if (result.stopReason === "aborted") {
    return `Image generation cancelled (${parts.join(", ")}).`;
  }
  if (result.stopReason === "error") {
    return `Image generation failed: ${result.errorMessage ?? "unknown error"} (${parts.join(", ")})`;
  }
  return `Generated ${parts.join(", ")}.`;
}
