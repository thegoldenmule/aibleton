"use client";

import { useState } from "react";
import {
  TemplateSchema,
  formLabels,
  formTotalBars,
  parseForm,
  type GenerateTemplateRequest,
  type Template,
} from "@aibleton/protocol";
import { FormStrip, letterClass } from "../../components/FormStrip";
import { useTemplates } from "../../lib/useTemplates";
import { errorMessage } from "../../lib/errors";
import { ErrorNote } from "../../components/ui/ErrorNote";
import { PanelHeader } from "../../components/ui/PanelHeader";
import { WorkspacePanel } from "../../components/WorkspacePanel";
import { TextField } from "../../components/ui/TextField";

/** Letters the generator can use, in order; `home` must be one of the ones in play. */
const ALPHABET = ["a", "b", "c", "d", "e", "f"] as const;
const DEFAULT_ALPHABET = 3;

interface Options {
  name: string;
  seed: string;
  alphabet: string;
  count: string;
  home: string;
  maxRun: string;
  bars: string;
  bpm: string;
}

const EMPTY_OPTIONS: Options = { name: "", seed: "", alphabet: "", count: "", home: "", maxRun: "", bars: "", bpm: "" };

function intField(raw: string, label: string, min?: number, max?: number): number | undefined {
  const text = raw.trim();
  if (!text) return undefined;
  const value = Number(text);
  if (!Number.isFinite(value) || !Number.isInteger(value)) throw new Error(`${label} must be a whole number`);
  if (min !== undefined && value < min) throw new Error(`${label} must be at least ${min}`);
  if (max !== undefined && value > max) throw new Error(`${label} must be at most ${max}`);
  return value;
}

function numberField(raw: string, label: string, min: number): number | undefined {
  const text = raw.trim();
  if (!text) return undefined;
  const value = Number(text);
  if (!Number.isFinite(value)) throw new Error(`${label} must be a number`);
  if (value <= min) throw new Error(`${label} must be greater than ${min}`);
  return value;
}

/** Blank fields are left off so the server picks its own default. @throws with a readable message. */
function buildOptions(options: Options): GenerateTemplateRequest {
  const alphabet = intField(options.alphabet, "alphabet", 2, ALPHABET.length);
  const inPlay = ALPHABET.slice(0, alphabet ?? DEFAULT_ALPHABET);
  const home = options.home.trim().toLowerCase();
  if (home && !inPlay.includes(home as (typeof ALPHABET)[number])) {
    throw new Error(`home must be one of ${inPlay.join(", ")}`);
  }
  const name = options.name.trim();
  return {
    seed: intField(options.seed, "seed"),
    alphabet,
    count: intField(options.count, "count", 1, 64),
    home: home || undefined,
    maxRun: intField(options.maxRun, "maxRun", 1),
    bars: intField(options.bars, "bars", 1),
    name: name || undefined,
    bpm: numberField(options.bpm, "bpm", 0),
  };
}

function freshSeed(): number {
  return Math.floor(Math.random() * 2_147_483_647);
}

function totalBars(form: string): number | null {
  try {
    return formTotalBars(parseForm(form));
  } catch {
    return null;
  }
}

/**
 * Each distinct letter in a form, in order of first appearance, with how often
 * it comes round and how many bars it adds up to across the whole song.
 *
 * Neither number is on the strip or in the legend: a block shows one occurrence
 * and the legend shows one brief, so "the chorus is here four times and that is
 * 32 of the 88 bars" is a fact only this computes. Unreadable forms answer with
 * nothing rather than taking the page down, the same way `totalBars` does.
 */
function sectionStats(form: string): { label: string; times: number; bars: number }[] {
  const rows = new Map<string, { label: string; times: number; bars: number }>();
  try {
    for (const entry of parseForm(form)) {
      const row = rows.get(entry.label) ?? { label: entry.label, times: 0, bars: 0 };
      row.times += 1;
      row.bars += entry.bars;
      rows.set(entry.label, row);
    }
  } catch {
    return [];
  }
  return [...rows.values()];
}

export default function TemplatesPage() {
  const { templates, loading, busy, lastError, generate, save, remove } = useTemplates();
  const [options, setOptions] = useState<Options>(EMPTY_OPTIONS);
  const [optionError, setOptionError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Template | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const set = (key: keyof Options) => (value: string) => setOptions((prev) => ({ ...prev, [key]: value }));

  const roll = async (seedOverride?: number) => {
    let opts: GenerateTemplateRequest;
    try {
      opts = buildOptions(options);
    } catch (err) {
      setOptionError(errorMessage(err));
      return;
    }
    if (seedOverride !== undefined) {
      opts = { ...opts, seed: seedOverride };
      setOptions((prev) => ({ ...prev, seed: String(seedOverride) }));
    }
    setOptionError(null);
    setDraftError(null);
    try {
      setDraft(await generate(opts));
    } catch {
      // surfaced through useTemplates.lastError
    }
  };

  const editBrief = (label: string, brief: string) =>
    setDraft((prev) =>
      prev ? { ...prev, sections: { ...prev.sections, [label]: { ...prev.sections[label], label, brief } } } : prev,
    );

  const commit = async () => {
    if (!draft) return;
    const parsed = TemplateSchema.safeParse(draft);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      setDraftError(issue ? `${issue.path.join(".") || "template"}: ${issue.message}` : "template is not valid");
      return;
    }
    setDraftError(null);
    try {
      await save(parsed.data);
      setDraft(null);
    } catch {
      // surfaced through useTemplates.lastError
    }
  };

  const destroy = async (id: string) => {
    setConfirmId(null);
    try {
      await remove(id);
    } catch {
      // surfaced through useTemplates.lastError
    }
  };

  const draftLabels = draft ? safeLabels(draft.form) : [];
  const draftBars = draft ? totalBars(draft.form) : null;

  return (
    <WorkspacePanel title="templates" meta={loading ? "loading…" : `${templates.length} saved`}>
      <ErrorNote message={lastError} />

      <section className="flex flex-col gap-2 rounded-sm border border-line bg-panel-2 p-2.5">
        <PanelHeader title="generator" level={3} />
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          <TextField id="gen-name" label="name" value={options.name} onChange={set("name")} placeholder="auto" />
          <TextField
            id="gen-seed"
            label="seed"
            value={options.seed}
            onChange={set("seed")}
            placeholder="random"
            inputMode="numeric"
          />
          <TextField
            id="gen-alphabet"
            label="alphabet"
            hint="2–6"
            value={options.alphabet}
            onChange={set("alphabet")}
            placeholder="3"
            inputMode="numeric"
          />
          <TextField
            id="gen-count"
            label="count"
            hint="1–64"
            value={options.count}
            onChange={set("count")}
            placeholder="9"
            inputMode="numeric"
          />
          <TextField id="gen-home" label="home" hint="letter" value={options.home} onChange={set("home")} placeholder="b" />
          <TextField
            id="gen-maxrun"
            label="maxRun"
            hint="≥1"
            value={options.maxRun}
            onChange={set("maxRun")}
            placeholder="2"
            inputMode="numeric"
          />
          <TextField
            id="gen-bars"
            label="bars"
            hint="≥1"
            value={options.bars}
            onChange={set("bars")}
            placeholder="8"
            inputMode="numeric"
          />
          <TextField
            id="gen-bpm"
            label="bpm"
            value={options.bpm}
            onChange={set("bpm")}
            placeholder="—"
            inputMode="decimal"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void roll()}
            className="rounded-sm bg-accent px-4 py-1.5 text-sm font-semibold text-black disabled:cursor-not-allowed disabled:opacity-40"
          >
            generate
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void roll(freshSeed())}
            className="rounded-sm border border-accent-2/60 bg-panel-2 px-3 py-1.5 text-sm font-medium text-accent-2 disabled:cursor-not-allowed disabled:opacity-40"
            title="Regenerate with a fresh random seed, keeping the other options"
          >
            ↻ roll again
          </button>
          <span className="text-[11px] text-muted">every field is optional — blank means the server decides</span>
          {optionError ? <span className="font-mono text-[11px] text-audio">{optionError}</span> : null}
        </div>
      </section>

      {draft ? (
        <section className="flex flex-col gap-3 rounded-sm border border-accent/50 bg-panel-2 p-2.5">
          <PanelHeader
            title="preview"
            level={3}
            meta={`${draft.form} · ${draftBars ?? "?"} bars${draft.bpm ? ` · ${draft.bpm} bpm` : ""}`}
            actions={<span className="rounded-sm bg-accent/20 px-1.5 py-0.5 font-mono text-[10px] text-accent">unsaved</span>}
          />

          <FormStrip form={draft.form} sections={draft.sections} showLegend={false} />

          <div className="flex flex-col gap-2">
            <label className="flex flex-col gap-1" htmlFor="draft-name">
              <span className="text-[10px] uppercase tracking-wider text-muted">name</span>
              <input
                id="draft-name"
                className="rounded-sm border border-line bg-panel-2 px-2 py-1 text-sm outline-none focus:border-accent"
                value={draft.name}
                onChange={(e) => setDraft((prev) => (prev ? { ...prev, name: e.target.value } : prev))}
              />
            </label>
            {draftLabels.map((label) => (
              <label key={label} className="flex flex-col gap-1" htmlFor={`draft-brief-${label}`}>
                <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted">
                  <span className={`h-2.5 w-2.5 rounded-sm border ${letterClass(label)}`} />
                  brief <span className="font-mono text-foreground">{label}</span>
                </span>
                <textarea
                  id={`draft-brief-${label}`}
                  rows={2}
                  className="resize-y rounded-sm border border-line bg-panel-2 px-2 py-1 text-xs leading-snug outline-none focus:border-accent"
                  value={draft.sections[label]?.brief ?? ""}
                  onChange={(e) => editBrief(label, e.target.value)}
                />
              </label>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void commit()}
              className="rounded-sm bg-accent-2 px-4 py-1.5 text-sm font-semibold text-black disabled:cursor-not-allowed disabled:opacity-40"
            >
              save
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setDraft(null);
                setDraftError(null);
              }}
              className="rounded-sm border border-line bg-panel-2 px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-40"
            >
              discard
            </button>
            {draftError ? <span className="font-mono text-[11px] text-audio">{draftError}</span> : null}
          </div>
        </section>
      ) : null}

      <section className="flex flex-col gap-2 rounded-sm border border-line bg-panel-2 p-2.5">
        <PanelHeader title="saved templates" level={3} />
        {loading ? (
          <p className="text-xs text-muted">Loading…</p>
        ) : templates.length === 0 ? (
          <p className="text-xs text-muted">
            {lastError ? "Could not load templates — see the error above." : "Nothing saved yet. Generate a form above, then save it."}
          </p>
        ) : (
          // Three library pages, one idiom: the column is a third of the page,
          // so the grid measures itself with a container query rather than the
          // viewport. Two columns at most, unlike bands — a form strip wants the
          // width a roster does not.
          <div className="@container">
            <ul className="grid auto-rows-min grid-cols-1 gap-2 @min-[47rem]:grid-cols-2">
              {templates.map((template) => (
                <TemplateCard
                  key={template.id}
                  template={template}
                  busy={busy}
                  confirming={confirmId === template.id}
                  onConfirm={() => setConfirmId(template.id)}
                  onCancel={() => setConfirmId(null)}
                  onDelete={() => void destroy(template.id)}
                />
              ))}
            </ul>
          </div>
        )}
      </section>
    </WorkspacePanel>
  );
}

function safeLabels(form: string): string[] {
  try {
    return formLabels(parseForm(form));
  } catch {
    return [];
  }
}



interface CardProps {
  template: Template;
  busy: boolean;
  confirming: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onDelete: () => void;
}

function TemplateCard({ template, busy, confirming, onConfirm, onCancel, onDelete }: CardProps) {
  const bars = totalBars(template.form);
  const sections = sectionStats(template.form).length;

  return (
    <li className="flex flex-col gap-2 rounded-sm border border-line bg-panel p-2.5">
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h4 className="truncate text-sm font-medium" title={template.name}>
            {template.name}
          </h4>
          {/* Facts, each its own span, the way a band card reads them. The date
              is short with the full timestamp on hover: `toLocaleString` ran the
              full width of a card that is now a third of one. */}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10px] text-muted/70">
            <span>{bars ?? "?"} bars</span>
            <span>
              {sections} section{sections === 1 ? "" : "s"}
            </span>
            {template.bpm ? <span>{template.bpm} bpm</span> : null}
            <span title={new Date(template.createdAt).toLocaleString()}>
              {new Date(template.createdAt).toLocaleDateString()}
            </span>
            {template.seed !== undefined ? (
              <span
                className="text-muted/50"
                title={`rolled from seed ${template.seed} — generate with it to lay this form again`}
              >
                #{template.seed}
              </span>
            ) : null}
          </div>
        </div>
        <span className="flex shrink-0 items-center gap-1.5">
          {confirming ? (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={onDelete}
                className="rounded-sm border border-audio/60 px-2 py-0.5 text-[11px] font-medium text-audio disabled:cursor-not-allowed disabled:opacity-40"
              >
                delete?
              </button>
              <button
                type="button"
                onClick={onCancel}
                className="rounded-sm border border-line px-2 py-0.5 text-[11px] text-muted"
              >
                cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={onConfirm}
              className="rounded-sm border border-line px-2 py-0.5 text-[11px] text-muted hover:text-audio disabled:cursor-not-allowed disabled:opacity-40"
            >
              delete
            </button>
          )}
        </span>
      </div>

      {/* No legend: at a third of the page it truncates every brief to a few
          words, and the strip alone is what a card is for. */}
      <FormStrip form={template.form} sections={template.sections} showLegend={false} />
    </li>
  );
}
