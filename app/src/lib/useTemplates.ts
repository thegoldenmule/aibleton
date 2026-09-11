"use client";

import { useCallback, useEffect, useState } from "react";
import type { GenerateTemplateRequest, Template } from "@aibleton/protocol";
import { deleteTemplate, generateTemplate, listTemplates, saveTemplate } from "./templates";
import { errorMessage } from "./errors";

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

/**
 * Holds the saved-template list plus the generate/save/delete actions.
 * There are no SSE events for templates, so this is plain fetch + local state:
 * the list is refetched after every save and delete.
 */
export function useTemplates(): TemplatesView {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);

  // Every setState lands after the first await, so the initial load can be kicked
  // off from an effect without a synchronous cascading render.
  const refresh = useCallback(async () => {
    try {
      const next = await listTemplates();
      setTemplates(next);
      setLastError(null);
    } catch (err) {
      setLastError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load. Mirrors useMateState: the async work lives in the effect and
  // stops touching state once the hook is torn down.
  useEffect(() => {
    let disposed = false;
    const load = async () => {
      try {
        const next = await listTemplates();
        if (disposed) return;
        setTemplates(next);
        setLastError(null);
      } catch (err) {
        if (!disposed) setLastError(errorMessage(err));
      } finally {
        if (!disposed) setLoading(false);
      }
    };
    void load();
    return () => {
      disposed = true;
    };
  }, []);

  const generate = useCallback(async (opts: GenerateTemplateRequest) => {
    setBusy(true);
    try {
      const template = await generateTemplate(opts);
      setLastError(null);
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
        await refresh();
        return saved;
      } catch (err) {
        setLastError(errorMessage(err));
        throw err;
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const remove = useCallback(
    async (id: string) => {
      setBusy(true);
      try {
        const deleted = await deleteTemplate(id);
        setLastError(null);
        await refresh();
        return deleted;
      } catch (err) {
        setLastError(errorMessage(err));
        throw err;
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  return { templates, loading, busy, lastError, refresh, generate, save, remove };
}
