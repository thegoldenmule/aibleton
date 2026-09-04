import { z } from "zod";

/** Section labels are single lowercase letters: `a`, `b`, `c`, ... */
export const SectionLabelSchema = z
  .string()
  .regex(/^[a-z]$/, "section label must be a single lowercase letter");
export type SectionLabel = z.infer<typeof SectionLabelSchema>;

/**
 * One occurrence of a section in a form: the `a8` in `"a8 b8 a8"`.
 * Length lives on the occurrence, not the section, so `b` can run 8 bars in one
 * place and 4 in another.
 */
export const FormEntrySchema = z.object({
  label: SectionLabelSchema,
  bars: z.number().int().positive(),
});
export type FormEntry = z.infer<typeof FormEntrySchema>;

/** Default bars for a form token written without a length (`"a b a"`). */
export const DEFAULT_SECTION_BARS = 8;

const TOKEN = /^([a-z])(\d*)$/;

/**
 * Parse a form string into its occurrences.
 *
 * `"a8 b8 a8 b8 b8 c4 c4 b8 b8"` is the canonical shape: a letter for the
 * section and a bar count. Commas are allowed as separators and a bare letter
 * takes `defaultBars`, so `"a, b, a, b"` also parses.
 *
 * @throws if the string is empty or holds a token that is not `<letter><bars?>`.
 */
export function parseForm(form: string, defaultBars = DEFAULT_SECTION_BARS): FormEntry[] {
  const tokens = form.trim().split(/[\s,]+/).filter(Boolean);
  if (tokens.length === 0) throw new Error("form is empty");
  return tokens.map((token) => {
    const m = TOKEN.exec(token);
    if (!m) throw new Error(`bad form token ${JSON.stringify(token)}: expected a lowercase letter then bars, e.g. "a8"`);
    const bars = m[2] ? Number(m[2]) : defaultBars;
    if (bars <= 0) throw new Error(`bad form token ${JSON.stringify(token)}: bars must be greater than zero`);
    return { label: m[1]!, bars };
  });
}

/** Render occurrences back to canonical form-string text (always explicit bars). */
export function stringifyForm(entries: readonly FormEntry[]): string {
  return entries.map((e) => `${e.label}${e.bars}`).join(" ");
}

/** Distinct section labels, in order of first appearance. */
export function formLabels(entries: readonly FormEntry[]): SectionLabel[] {
  const seen = new Set<string>();
  const out: SectionLabel[] = [];
  for (const e of entries) {
    if (seen.has(e.label)) continue;
    seen.add(e.label);
    out.push(e.label);
  }
  return out;
}

/** Total length of the form in bars. */
export function formTotalBars(entries: readonly FormEntry[]): number {
  return entries.reduce((n, e) => n + e.bars, 0);
}

/** A string that `parseForm` accepts. Use at API boundaries. */
export const FormStringSchema = z.string().superRefine((value, ctx) => {
  try {
    parseForm(value);
  } catch (err) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: err instanceof Error ? err.message : String(err) });
  }
});
