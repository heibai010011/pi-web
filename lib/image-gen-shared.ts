// Browser-safe constants and types shared between the server-side image
// generation core (lib/image-gen.ts, which imports pi-ai) and client
// components. Keep this module free of Node-only imports.

export const IMAGE_ASPECT_RATIOS = ["1:1", "3:4", "4:3", "16:9", "9:16"] as const;
export type ImageAspectRatio = typeof IMAGE_ASPECT_RATIOS[number];

export const IMAGE_GENERATION_COUNTS = [1, 2, 4] as const;
export type ImageGenerationCount = typeof IMAGE_GENERATION_COUNTS[number];

export const MAX_IMAGE_GENERATION_COUNT = 4;
export const MAX_REFERENCE_IMAGES = 4;

export interface ImageModelOption {
  provider: string;
  modelId: string;
  name: string;
}

export interface ImageGenerationRequest {
  prompt: string;
  model: { provider: string; modelId: string };
  referenceImages?: Array<{ data: string; mimeType: string }>;
  aspectRatio?: string;
  count?: number;
  seed?: number;
}

export function isImageAspectRatio(value: unknown): value is ImageAspectRatio {
  return typeof value === "string" && (IMAGE_ASPECT_RATIOS as readonly string[]).includes(value);
}

/** Parameters the composer passes along with a direct image-generation send. */
export interface ImageComposerOptions {
  aspectRatio?: ImageAspectRatio;
  count?: ImageGenerationCount;
  seed?: number;
}

/** Tool name shared by the built-in tool and the composer direct path. */
export const IMAGE_GEN_TOOL_NAME = "generate_image";

/** Metadata persisted on generate_image toolResult entries (UI card rendering). */
export interface ImageGenerationToolDetails {
  kind: "pi-web-image-generation";
  model: { provider: string; modelId: string };
  prompt: string;
  aspectRatio?: string;
  count: number;
  seed?: number;
  durationMs: number;
  requestedBy: "tool" | "composer";
}

export function isImageGenerationToolDetails(value: unknown): value is ImageGenerationToolDetails {
  if (!value || typeof value !== "object") return false;
  const details = value as Partial<ImageGenerationToolDetails>;
  return details.kind === "pi-web-image-generation"
    && typeof details.model === "object" && details.model !== null
    && typeof details.model.provider === "string"
    && typeof details.model.modelId === "string"
    && typeof details.prompt === "string"
    && typeof details.count === "number" && Number.isInteger(details.count) && details.count >= 1
    && typeof details.durationMs === "number" && Number.isFinite(details.durationMs) && details.durationMs >= 0
    && (details.requestedBy === "tool" || details.requestedBy === "composer")
    && (details.aspectRatio === undefined || typeof details.aspectRatio === "string")
    && (details.seed === undefined || (typeof details.seed === "number" && Number.isInteger(details.seed)));
}
