import { z } from "zod";

export const CommandSourceSchema = z.enum(["api", "timer", "midi", "loop", "ableton", "test"]);
export type CommandSource = z.infer<typeof CommandSourceSchema>;

export const EnvelopeSchema = z.object({
  id: z.string(),
  at: z.number(),
  source: CommandSourceSchema,
});
export type Envelope = z.infer<typeof EnvelopeSchema>;

/** Commands that may enter mate from outside (the API accepts exactly these). */
export const ExternalCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("userRequest"), text: z.string().min(1) }),
  z.object({ type: z.literal("goalSet"), text: z.string() }),
  z.object({
    type: z.literal("abletonChanged"),
    hint: z.enum(["tempo", "clips", "tracks", "transport"]).optional(),
  }),
  z.object({
    type: z.literal("midiNote"),
    note: z.number().int().min(0).max(127),
    velocity: z.number().int().min(0).max(127),
    channel: z.number().int().min(0).max(15),
  }),
  z.object({ type: z.literal("pause") }),
  z.object({ type: z.literal("resume") }),
  z.object({ type: z.literal("cancel") }),
]);
export type ExternalCommand = z.infer<typeof ExternalCommandSchema>;

/** What the API reports about a command that passed through the mailbox. */
export const CommandSummarySchema = EnvelopeSchema.extend({
  type: z.string(),
  summary: z.string(),
});
export type CommandSummary = z.infer<typeof CommandSummarySchema>;
