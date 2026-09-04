import { z } from "zod";
import { SectionLabelSchema } from "./form.ts";

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

/** A song roadmap: a form string plus the meaning of each letter in it. */
export const TemplateSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** Form string, e.g. `"a8 b8 a8 b8 b8 c4 c4 b8 b8"`. */
  form: z.string().min(1),
  sections: z.record(z.string(), SectionSchema),
  bpm: z.number().positive().optional(),
  createdAt: z.number(),
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
