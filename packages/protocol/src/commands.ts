import { z } from "zod";

export const CommandSourceSchema = z.enum(["api", "timer", "midi", "loop", "ableton", "test"]);
export type CommandSource = z.infer<typeof CommandSourceSchema>;

export const EnvelopeSchema = z.object({
  id: z.string(),
  at: z.number(),
  source: CommandSourceSchema,
});
export type Envelope = z.infer<typeof EnvelopeSchema>;

/**
 * Where the drummer was standing when they typed.
 *
 * The same words mean different things in different places — "make it sparser"
 * on the song is about the song; on the templates page it is about the template
 * — so the app sends the view along with the text and lets the bandmate read
 * the room.
 *
 * The page comes from the route; everything after it is whatever that page has
 * selected — the recipe, the band or the template the drummer is looking at.
 * This is the seam the rest of the view state grows on (which slot is open,
 * where the arrangement is scrolled), so **every field added here must be
 * optional**: context is a hint, and a client that knows less than mate does
 * must still be able to talk.
 *
 * Every field is a bounded string rather than an enum for the same reason. A
 * newer app naming a page an older mate has never heard of should not get its
 * message rejected — the worst case has to be an ignored hint, not a refusal.
 *
 * Which is why every selection carries `.catch(undefined)`: a band named past
 * the bound would otherwise fail `PostCommandRequestSchema` and answer the
 * drummer's whole message with a 400, the one thing this docblock promises
 * cannot happen. An over-long hint is dropped and the words go through. `page`
 * is not caught — it is required, and a request with no view to report is a
 * client bug worth hearing about.
 */
export const RequestContextSchema = z.object({
  /** The workspace being looked at: `song`, `templates`, `bands`, `recipes`. */
  page: z.string().min(1).max(40),
  /**
   * The genre whose recipe is selected on the recipes page, as it reads rather
   * than as its key — "drum and bass", not "drumandbass" — because it is going
   * into a sentence, and every tool that takes a genre takes free text.
   */
  recipe: z.string().min(1).max(80).optional().catch(undefined),
  /**
   * The band selected on the bands page, by the **name** as it reads on the
   * card rather than by its id. It goes into a sentence, and `find_bands`
   * matches words in a name; an id would land above the composer as a chip
   * nobody can read.
   */
  band: z.string().min(1).max(120).optional().catch(undefined),
  /**
   * The template selected on the templates page, by name for the same reason —
   * `find_templates` searches names, and a chip has to be readable.
   */
  template: z.string().min(1).max(120).optional().catch(undefined),
});
export type RequestContext = z.infer<typeof RequestContextSchema>;

/** Commands that may enter mate from outside (the API accepts exactly these). */
export const ExternalCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("userRequest"), text: z.string().min(1), context: RequestContextSchema.optional() }),
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
