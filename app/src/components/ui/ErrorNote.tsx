/**
 * What a library operation refused to do, in mate's own words (see
 * `lib/errors.ts`). Renders nothing when there is nothing to say, so callers
 * can hand it a nullable `lastError` directly.
 */
export function ErrorNote({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p className="rounded-sm border border-audio/40 bg-audio/10 px-3 py-1.5 font-mono text-[11px] text-audio">
      {message}
    </p>
  );
}
