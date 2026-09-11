"use client";

import { useCallback, useState } from "react";
import type { GenerateTemplateRequest, Template } from "@aibleton/protocol";
import { deleteTemplate, generateTemplate, listTemplates, saveTemplate } from "./templates";
import { errorMessage } from "./errors";
import { useMate } from "./useMate";

export interface TemplatesView {
  templates: Template[];
  /** True until the first list load settles. */
  loading: boolean;
  /** True while a generate/save/delete request is in flight. */
  busy: boolean;
  lastError: string | null;
  refresh: () => Promise<void>;
  generate: (opts: GenerateTemplateRequest) => Promise<Template>;
  save: (template: Template) => Promise<Template>;
  remove: (id: string) => Promise<boolean>;
}

/** One empty list, so a library that has not arrived yet does not re-render the page every time. */
const NO_TEMPLATES: Template[] = [];

/**
 * Holds the saved-template list plus the generate/save/delete actions.
 *
 * The list itself is not this hook's state: templates are an event-sourced aggregate riding the
 * one `/events` stream, so `useMate()` holds the fold and every open tab sees a save the moment it
 * happens. What is left here is the mutators, each of which patches its own result in through the
 * same reducer for the case where the stream is down.
 */
export function useTemplates(): TemplatesView {
  const { templates, patchTemplates, replaceTemplates } = useMate();
  const [busy, setBusy] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);

  /** Manual re-fetch. Nothing calls it on a schedule — the stream is the loader. */
  const refresh = useCallback(async () => {
    try {
      replaceTemplates(await listTemplates());
      setLastError(null);
    } catch (err) {
      setLastError(errorMessage(err));
    }
  }, [replaceTemplates]);

  const generate = useCallback(async (opts: GenerateTemplateRequest) => {
    setBusy(true);
    try {
      const template = await generateTemplate(opts);
      setLastError(null);
      // Nothing to fold: generating does not save, so the library is untouched until the
      // drummer posts this template back.
      return template;
    } catch (err) {
      setLastError(errorMessage(err));
      throw err;
    } finally {
      setBusy(false);
    }
  }, []);

  const save = useCallback(
    async (template: Template) => {
      setBusy(true);
      try {
        const saved = await saveTemplate(template);
        setLastError(null);
        // From the response, not the argument: that copy is the one mate normalised.
        // The SSE event normally lands first, this covers a dropped stream.
        patchTemplates({ type: "template.saved", template: saved });
        return saved;
      } catch (err) {
        setLastError(errorMessage(err));
        throw err;
      } finally {
        setBusy(false);
      }
    },
    [patchTemplates],
  );

  const remove = useCallback(
    async (id: string) => {
      setBusy(true);
      try {
        const deleted = await deleteTemplate(id);
        setLastError(null);
        // Only a real delete is an event; mate appends nothing for an id it never held.
        if (deleted) patchTemplates({ type: "template.deleted", id });
        return deleted;
      } catch (err) {
        setLastError(errorMessage(err));
        throw err;
      } finally {
        setBusy(false);
      }
    },
    [patchTemplates],
  );

  return { templates: templates ?? NO_TEMPLATES, loading: templates === null, busy, lastError, refresh, generate, save, remove };
}
