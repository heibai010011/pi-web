// Browser-side persistence for the composer's image-generation selections.
// Mirrors lib/tool-preset-preference.ts: pure localStorage helpers with an
// injectable storage so tests can run without a DOM.

import { isImageAspectRatio, type ImageAspectRatio, type ImageGenerationCount } from "./image-gen-shared";
import { IMAGE_GENERATION_COUNTS } from "./image-gen-shared";

const STORAGE_KEY = "pi-web:image-gen-preferences";

export interface ImageGenPreferences {
  model: { provider: string; modelId: string } | null;
  aspectRatio: ImageAspectRatio;
  count: ImageGenerationCount;
  seed: number | null;
}

export const DEFAULT_IMAGE_GEN_PREFERENCES: ImageGenPreferences = {
  model: null,
  aspectRatio: "3:4",
  count: 1,
  seed: null,
};

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function getBrowserStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function getImageGenPreferences(
  storage: StorageLike | null = getBrowserStorage(),
): ImageGenPreferences {
  if (!storage) return { ...DEFAULT_IMAGE_GEN_PREFERENCES };
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_IMAGE_GEN_PREFERENCES };
    const parsed = JSON.parse(raw) as Partial<{
      model: { provider?: unknown; modelId?: unknown };
      aspectRatio: unknown;
      count: unknown;
      seed: unknown;
    }>;
    const model = parsed.model
      && typeof parsed.model === "object"
      && typeof parsed.model.provider === "string"
      && typeof parsed.model.modelId === "string"
      ? { provider: parsed.model.provider, modelId: parsed.model.modelId }
      : null;
    return {
      model,
      aspectRatio: isImageAspectRatio(parsed.aspectRatio) ? parsed.aspectRatio : DEFAULT_IMAGE_GEN_PREFERENCES.aspectRatio,
      count: (IMAGE_GENERATION_COUNTS as readonly number[]).includes(parsed.count as number)
        ? parsed.count as ImageGenerationCount
        : DEFAULT_IMAGE_GEN_PREFERENCES.count,
      seed: typeof parsed.seed === "number" && Number.isFinite(parsed.seed) ? Math.floor(parsed.seed) : null,
    };
  } catch {
    return { ...DEFAULT_IMAGE_GEN_PREFERENCES };
  }
}

export function setImageGenPreferences(
  preferences: ImageGenPreferences,
  storage: StorageLike | null = getBrowserStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // Browser storage is best-effort.
  }
}
