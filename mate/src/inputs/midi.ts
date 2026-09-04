import type { Intelligence } from "../intelligence/types.ts";

/**
 * Future hardware input. A real implementation will open a MIDI port (e.g. via a native
 * binding or Web MIDI in a helper process) and map incoming events to commands:
 *   note on  -> { type: "midiNote", note, velocity, channel }  (source: "midi")
 *   a configured pad/CC could map to pause / resume / cancel / userRequest presets.
 */
export interface MidiSource {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly connected: boolean;
}

/** Placeholder used until a controller is wired in. Never emits anything. */
export class NoopMidiSource implements MidiSource {
  readonly connected = false;
  constructor(private readonly _intelligence: Intelligence) {}
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
}
