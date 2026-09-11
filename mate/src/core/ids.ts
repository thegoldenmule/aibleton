/** Ids become filenames, so they are restricted to characters that cannot escape the directory. */
const DOCUMENT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** True when `id` is safe to use as a document filename. */
export function isValidDocumentId(id: string): boolean {
  return DOCUMENT_ID.test(id);
}

/**
 * The same rule, as a throw. `kind` is the noun the message names — "band",
 * "session" — so a caller that is about to build a path says what it was
 * building rather than leaving the drummer a generic complaint.
 */
export function assertValidDocumentId(id: string, kind: string): void {
  if (!isValidDocumentId(id)) {
    throw new Error(
      `invalid ${kind} id ${JSON.stringify(id)}: expected 1-64 characters of A-Z, a-z, 0-9, "_" or "-"`,
    );
  }
}
