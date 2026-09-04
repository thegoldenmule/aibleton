import type { BandRecipe } from "@aibleton/protocol";

export interface RecipeRequest {
  /** The genre as the user wrote it, trimmed. */
  genre: string;
}

/** The staffing a writer produces; the book adds id, genre, source and createdAt. */
export type RecipeDraft = Pick<BandRecipe, "core" | "optional" | "names" | "briefs" | "anchors">;

/**
 * Writes a band recipe for a genre mate has none for. One structured call in
 * the anthropic writer; the scripted one is deterministic and offline.
 */
export interface RecipeWriter {
  readonly kind: "anthropic" | "scripted";
  write(request: RecipeRequest, signal: AbortSignal): Promise<RecipeDraft>;
}
