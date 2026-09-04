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
