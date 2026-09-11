"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  applyBandEvent,
  applyMateEvent,
  applyRecipeEvent,
  applyTemplateEvent,
  BAND_EVENT_TYPES,
  BandEventSchema,
  BandLibrarySchema,
  MATE_EVENT_TYPES,
  MateEventSchema,
  RECIPE_EVENT_TYPES,
  RecipeEventSchema,
  RecipeLibrarySchema,
  StateResponseSchema,
  TEMPLATE_EVENT_TYPES,
  TemplateEventSchema,
  TemplateLibrarySchema,
  type Activity,
  type Band,
  type BandEvent,
  type BandRecipe,
  type CommandSummary,
  type DownloadProgress,
  type ExternalCommand,
  type RecipeEvent,
  type Song,
  type StateResponse,
  type Template,
  type TemplateEvent,
} from "@aibleton/protocol";
import { getState, mateUrl, postCommand } from "./mate";
import { arrangeSong, clearActiveSong, deleteTrack, downloadSong, pickSlot, resolveSong, setPlacement } from "./songs";

export type Connection = "connecting" | "open" | "error";

/**
 * The three library folds, re-typed mutable in and out. Neither ever mutates its input and
 * neither hands back anything but a plain array — the `readonly` in the protocol signature
 * is a promise to callers, and the pages below this hook are typed `Band[]`/`Template[]`.
 * Going through the real fold is the point: it returns the *same reference* when an event
 * changes nothing, which is what lets a page's local patch and the streamed event converge.
 */
const foldBands = (bands: Band[], event: BandEvent): Band[] => applyBandEvent(bands, event) as Band[];
const foldTemplates = (templates: Template[], event: TemplateEvent): Template[] =>
  applyTemplateEvent(templates, event) as Template[];
const foldRecipes = (recipes: BandRecipe[], event: RecipeEvent): BandRecipe[] => applyRecipeEvent(recipes, event) as BandRecipe[];

export interface MateView {
  state: StateResponse | null;
  connection: Connection;
  /**
   * Transport only: the request never reached mate, or an action it ran came back failed.
   * Anything the bandmate has an opinion about arrives as its spoken reply in the transcript.
   */
  lastError: string | null;
  /**
   * The one slow thing mate is doing, or null at rest. Owned by the server, so a reload
   * mid-compose still shows it, and so does a second tab.
   */
  activity: Activity | null;
  /** Requests that arrived while mate was working and are waiting their turn, oldest first. */
  queued: CommandSummary[];
  /** Where the current download stands, from mate's progress events; null when none is running. */
  downloadProgress: DownloadProgress | null;
  /**
   * The band library, its own aggregate folded off this same stream. `null` until the
   * opening `bands.snapshot` frame lands, so a page can say "loading…" rather than "0 saved".
   */
  bands: Band[] | null;
  /** The template library, on the same terms as {@link MateView.bands}. */
  templates: Template[] | null;
  /**
   * The recipe library, on the same terms again. It moves without anyone on
   * this page asking: a recipe is written whenever *anything* staffs a band for
   * a genre mate has none for — the bandmate's `generate_band`, a compose that
   * needs a new genre, or another tab. That is why it rides the stream instead
   * of being fetched when this browser happens to press something.
   */
  recipes: BandRecipe[] | null;
  /** Folds a band write the page just made; the SSE event normally lands first, this covers a dropped stream. */
  patchBands: (event: BandEvent) => void;
  /** Folds a template write the page just made, on the same terms as {@link MateView.patchBands}. */
  patchTemplates: (event: TemplateEvent) => void;
  /** Replaces the band library wholesale, the way the snapshot frame does. Backs the manual refresh. */
  replaceBands: (bands: Band[]) => void;
  /** Replaces the template library wholesale, the way the snapshot frame does. */
  replaceTemplates: (templates: Template[]) => void;
  /** Folds a recipe removal the page just made, on the same terms as {@link MateView.patchBands}. */
  patchRecipes: (event: RecipeEvent) => void;
  /** Replaces the recipe library wholesale, the way the snapshot frame does. */
  replaceRecipes: (recipes: BandRecipe[]) => void;
  send: (command: ExternalCommand) => Promise<void>;
  /** Clears the active song so the next request composes a new one. */
  clearSong: () => Promise<void>;
  /** Searches Splice for every slot of a song. */
  resolveSounds: (songId: string) => Promise<void>;
  /** Chooses which candidate a slot downloads. */
  pickSound: (songId: string, slotId: string, soundUuid: string) => Promise<void>;
  /** Downloads every pending pick. The caller confirms the credit spend first. */
  downloadSounds: (songId: string) => Promise<void>;
  /** Drops a part and everything it plays from the song. */
  removeTrack: (songId: string, partId: string) => Promise<void>;
  /** Brings a part in for one occurrence, or rests it. */
  setPlaying: (songId: string, partId: string, occurrence: number, plays: boolean) => Promise<void>;
  /** Builds what the song has on disk into Live. Adds only; safe to repeat. */
  buildInLive: (songId: string) => Promise<void>;
}

/**
 * Loads /state once, then follows /events over SSE. Re-renders only when an event arrives.
 * Reconnects with capped exponential backoff when the stream drops.
 */
export function useMateState(): MateView {
  const [state, setState] = useState<StateResponse | null>(null);
  const [connection, setConnection] = useState<Connection>("connecting");
  const [lastError, setLastError] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgress | null>(null);
  const [bands, setBands] = useState<Band[] | null>(null);
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [recipes, setRecipes] = useState<BandRecipe[] | null>(null);
  const retryRef = useRef(0);

  useEffect(() => {
    let source: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const scheduleReconnect = () => {
      if (disposed || timer) return;
      const delay = Math.min(30_000, 1_000 * 2 ** retryRef.current);
      retryRef.current += 1;
      timer = setTimeout(() => {
        timer = null;
        void connect();
      }, delay);
    };

    const connect = async () => {
      if (disposed) return;
      setConnection("connecting");
      try {
        const initial = await getState();
        if (disposed) return;
        setState(initial);
        setLastError(null);
      } catch (err) {
        if (disposed) return;
        setConnection("error");
        setLastError(err instanceof Error ? err.message : String(err));
        scheduleReconnect();
        return;
      }

      source = new EventSource(mateUrl("/events"));
      source.onopen = () => {
        retryRef.current = 0;
        setConnection("open");
        setLastError(null);
      };
      source.onerror = () => {
        source?.close();
        source = null;
        setConnection("error");
        scheduleReconnect();
      };
      source.addEventListener("snapshot", (e: MessageEvent<string>) => {
        const parsed = StateResponseSchema.safeParse(JSON.parse(e.data));
        if (parsed.success) setState(parsed.data);
      });
      for (const type of MATE_EVENT_TYPES) {
        source.addEventListener(type, (e: MessageEvent<string>) => {
          const parsed = MateEventSchema.safeParse(JSON.parse(e.data));
          if (!parsed.success) return;
          if (parsed.data.type === "download.progress") setDownloadProgress(parsed.data.progress);
          else {
            // A failed action is the one domain failure with no voice of its own; the rest of what
            // went wrong reaches the drummer as the bandmate's reply in the transcript.
            if (parsed.data.type === "action.applied" && !parsed.data.ok) setLastError(`${parsed.data.action}: ${parsed.data.detail ?? "failed"}`);
            if (parsed.data.type === "activity.changed" && parsed.data.activity === null) setDownloadProgress(null);
            setState((prev) => (prev ? applyMateEvent(prev, parsed.data) : prev));
          }
        });
      }

      // The three libraries are their own aggregates on this same stream — one EventSource, four
      // pictures. Every reconnect re-snapshots, so events missed while the stream was down are
      // simply not needed. Routing is by *which* listener was registered, so nothing unwraps an
      // envelope or dispatches on a tag at runtime.
      source.addEventListener("bands.snapshot", (e: MessageEvent<string>) => {
        const parsed = BandLibrarySchema.safeParse(JSON.parse(e.data));
        if (parsed.success) setBands(parsed.data.bands);
      });
      for (const type of BAND_EVENT_TYPES) {
        source.addEventListener(type, (e: MessageEvent<string>) => {
          const parsed = BandEventSchema.safeParse(JSON.parse(e.data));
          if (!parsed.success) return;
          setBands((prev) => (prev ? foldBands(prev, parsed.data) : prev));
        });
      }

      source.addEventListener("templates.snapshot", (e: MessageEvent<string>) => {
        const parsed = TemplateLibrarySchema.safeParse(JSON.parse(e.data));
        if (parsed.success) setTemplates(parsed.data.templates);
      });
      for (const type of TEMPLATE_EVENT_TYPES) {
        source.addEventListener(type, (e: MessageEvent<string>) => {
          const parsed = TemplateEventSchema.safeParse(JSON.parse(e.data));
          if (!parsed.success) return;
          setTemplates((prev) => (prev ? foldTemplates(prev, parsed.data) : prev));
        });
      }

      source.addEventListener("recipes.snapshot", (e: MessageEvent<string>) => {
        const parsed = RecipeLibrarySchema.safeParse(JSON.parse(e.data));
        if (parsed.success) setRecipes(parsed.data.recipes);
      });
      for (const type of RECIPE_EVENT_TYPES) {
        source.addEventListener(type, (e: MessageEvent<string>) => {
          const parsed = RecipeEventSchema.safeParse(JSON.parse(e.data));
          if (!parsed.success) return;
          setRecipes((prev) => (prev ? foldRecipes(prev, parsed.data) : prev));
        });
      }
    };

    void connect();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      source?.close();
    };
  }, []);

  const send = useCallback(async (command: ExternalCommand) => {
    try {
      await postCommand(command);
      setLastError(null);
    } catch (err) {
      setLastError(err instanceof Error ? err.message : String(err));
      throw err;
    }
  }, []);

  /** Replaces the active song from a response; the SSE event normally lands first, this covers a dropped stream. */
  const replaceSong = useCallback((song: Song) => {
    setState((prev) => (prev && (prev.song === null || prev.song.id === song.id) ? { ...prev, song } : prev));
  }, []);

  /**
   * Folds a library write the page just made through the same reducer the stream folds through;
   * the SSE event normally lands first, this covers a dropped stream. Feeding it the *response*
   * body and not the request body is what carries mate's normalisation, and the fold's
   * same-reference-when-nothing-changed rule is what makes the two land as one.
   */
  const patchBands = useCallback((event: BandEvent) => {
    setBands((prev) => (prev ? foldBands(prev, event) : prev));
  }, []);

  const patchTemplates = useCallback((event: TemplateEvent) => {
    setTemplates((prev) => (prev ? foldTemplates(prev, event) : prev));
  }, []);

  const replaceBands = useCallback((next: Band[]) => {
    setBands(next);
  }, []);

  const replaceTemplates = useCallback((next: Template[]) => {
    setTemplates(next);
  }, []);

  const patchRecipes = useCallback((event: RecipeEvent) => {
    setRecipes((prev) => (prev ? foldRecipes(prev, event) : prev));
  }, []);

  const replaceRecipes = useCallback((next: BandRecipe[]) => {
    setRecipes(next);
  }, []);

  const resolveSounds = useCallback(
    async (songId: string) => {
      try {
        replaceSong((await resolveSong(songId)).song);
        setLastError(null);
      } catch (err) {
        setLastError(err instanceof Error ? err.message : String(err));
        throw err;
      }
    },
    [replaceSong],
  );

  const pickSound = useCallback(
    async (songId: string, slotId: string, soundUuid: string) => {
      try {
        replaceSong(await pickSlot(songId, { slotId, soundUuid }));
        setLastError(null);
      } catch (err) {
        setLastError(err instanceof Error ? err.message : String(err));
        throw err;
      }
    },
    [replaceSong],
  );

  const downloadSounds = useCallback(
    async (songId: string) => {
      try {
        const { song, failed } = await downloadSong(songId);
        replaceSong(song);
        // Partial failure is a 200 and mate says so in its own words; only name the ones that cost nothing.
        setLastError(failed.length ? `${failed.length} download${failed.length === 1 ? "" : "s"} failed` : null);
      } catch (err) {
        setLastError(err instanceof Error ? err.message : String(err));
        throw err;
      } finally {
        setDownloadProgress(null);
      }
    },
    [replaceSong],
  );

  const clearSong = useCallback(async () => {
    try {
      await clearActiveSong();
      setState((prev) => (prev ? { ...prev, song: null } : prev));
      setLastError(null);
    } catch (err) {
      setLastError(err instanceof Error ? err.message : String(err));
      throw err;
    }
  }, []);

  const removeTrack = useCallback(
    async (songId: string, partId: string) => {
      try {
        replaceSong(await deleteTrack(songId, partId));
        setLastError(null);
      } catch (err) {
        setLastError(err instanceof Error ? err.message : String(err));
        throw err;
      }
    },
    [replaceSong],
  );

  const setPlaying = useCallback(
    async (songId: string, partId: string, occurrence: number, plays: boolean) => {
      try {
        replaceSong(await setPlacement(songId, { partId, occurrence, plays }));
        setLastError(null);
      } catch (err) {
        setLastError(err instanceof Error ? err.message : String(err));
        throw err;
      }
    },
    [replaceSong],
  );

  const buildInLive = useCallback(
    async (songId: string) => {
      try {
        // What was built, what Live could not do and what is still missing all come back as
        // mate's own line in the conversation; the page only reports a request that never landed.
        replaceSong((await arrangeSong(songId)).song);
        setLastError(null);
      } catch (err) {
        setLastError(err instanceof Error ? err.message : String(err));
        throw err;
      }
    },
    [replaceSong],
  );

  return {
    state,
    connection,
    lastError,
    activity: state?.activity ?? null,
    queued: state?.queued ?? [],
    downloadProgress,
    bands,
    templates,
    recipes,
    patchBands,
    patchTemplates,
    patchRecipes,
    replaceBands,
    replaceTemplates,
    replaceRecipes,
    send,
    clearSong,
    resolveSounds,
    pickSound,
    downloadSounds,
    removeTrack,
    setPlaying,
    buildInLive,
  };
}
