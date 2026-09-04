import { z } from "zod";
import { FormStringSchema, SectionLabelSchema, formLabels, parseForm } from "./form.ts";

/**
 * What one letter in a form means musically. `brief` is the prompt handed to
 * Splice when the section is bound to material.
 */
export const SectionSchema = z.object({
  label: SectionLabelSchema,
  brief: z.string().min(1),
  /** Reserved for a later energy/tension input (e.g. a DAW plugin). Nothing reads it yet. */
  intensity: z.number().min(0).max(1).optional(),
});
export type Section = z.infer<typeof SectionSchema>;

const TemplateShape = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** Form string, e.g. `"a8 b8 a8 b8 b8 c4 c4 b8 b8"`. */
  form: FormStringSchema,
  sections: z.record(z.string(), SectionSchema),
  bpm: z.number().positive().optional(),
  createdAt: z.number(),
});

/**
 * A song roadmap: a form string plus the meaning of each letter in it.
 * Every label used by the form must have a section, and each section must be
 * filed under its own label.
 */
export const TemplateSchema = TemplateShape.superRefine((template, ctx) => {
  for (const [key, section] of Object.entries(template.sections)) {
    if (section.label !== key) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sections", key, "label"],
        message: `section filed under ${JSON.stringify(key)} is labelled ${JSON.stringify(section.label)}`,
      });
    }
  }
  let labels: string[];
  try {
    labels = formLabels(parseForm(template.form));
  } catch {
    return;
  }
  for (const label of labels) {
    if (!template.sections[label]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sections"],
        message: `form uses section ${JSON.stringify(label)} but no section defines it`,
      });
    }
  }
});
export type Template = z.infer<typeof TemplateSchema>;

/** One resolved Splice loop inside a bound section. */
export const CompositionLayerSchema = z.object({
  layerType: z.string(),
  soundUuid: z.string(),
  /** Absolute path once downloaded; null while the section is a roadmap only. */
  localPath: z.string().nullable(),
});
export type CompositionLayer = z.infer<typeof CompositionLayerSchema>;

export const CompositionStackSchema = z.object({
  stackUuid: z.string(),
  layers: z.array(CompositionLayerSchema),
});
export type CompositionStack = z.infer<typeof CompositionStackSchema>;

/** A template bound to real Splice material, persisted so re-rendering costs no credits. */
export const CompositionSchema = z.object({
  id: z.string().min(1),
  templateId: z.string().min(1),
  bpm: z.number().positive(),
  /** Section label -> the material chosen for it. */
  stacks: z.record(z.string(), CompositionStackSchema),
  layout: z.array(
    z.object({
      label: SectionLabelSchema,
      startBeat: z.number().min(0),
      lengthBeats: z.number().positive(),
    }),
  ),
  createdAt: z.number(),
});
export type Composition = z.infer<typeof CompositionSchema>;
