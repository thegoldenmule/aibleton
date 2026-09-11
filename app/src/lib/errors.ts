/**
 * The readable half of a failed `request()`.
 *
 * The routes answer a refusal with `{ error }` and the shared helper wraps it as
 * `mate POST /sessions -> 409: {"error":"…"}`. A 409 from a busy mate is normal
 * — it says *why* it cannot act right now — so the sentence is worth more to the
 * drummer than the status line around it.
 */
export function errorMessage(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  const split = text.indexOf(": ");
  if (split < 0) return text;
  try {
    const parsed: unknown = JSON.parse(text.slice(split + 2));
    if (parsed && typeof parsed === "object" && typeof (parsed as { error?: unknown }).error === "string") {
      return (parsed as { error: string }).error;
    }
  } catch {
    // Not a JSON body — a network failure, or prose. Show what was thrown.
  }
  return text;
}
