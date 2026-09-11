"use client";

import { Fragment, useState } from "react";
import {
  BandSchema,
  ROLES,
  bandGenre,
  genreKey,
  recipeRoles,
  type Band,
  type BandPart,
  type GenerateBandRequest,
} from "@aibleton/protocol";
import { BandRoster, roleClass, roleTextClass } from "../../components/BandRoster";
import { useBands } from "../../lib/useBands";
import { errorMessage } from "../../lib/errors";
import { ErrorNote } from "../../components/ui/ErrorNote";
import { PanelHeader } from "../../components/ui/PanelHeader";
import { WorkspacePanel } from "../../components/WorkspacePanel";
import { TextField } from "../../components/ui/TextField";

/** Bucket a band with no `metadata.genre` falls into — metadata is free-form, genre is only a convention. */
const UNTAGGED = "untagged";

interface Options {
  name: string;
  seed: string;
  genre: string;
  size: string;
}

const EMPTY_OPTIONS: Options = { name: "", seed: "", genre: "", size: "" };

interface MetaRow {
  rowId: number;
  key: string;
  value: string;
}

interface NewPart {
  role: string;
  name: string;
  brief: string;
}

const EMPTY_PART: NewPart = { role: ROLES[0], name: "", brief: "" };

// Row identity for the metadata editor. Bumped from event handlers only — never
// read or advanced during render.
let metaSeq = 0;
function nextRowId(): number {
  metaSeq += 1;
  return metaSeq;
}

function toMetaRows(metadata: Record<string, string>): MetaRow[] {
  return Object.entries(metadata).map(([key, value]) => ({ rowId: nextRowId(), key, value }));
}

function intField(raw: string, label: string, min?: number, max?: number): number | undefined {
  const text = raw.trim();
  if (!text) return undefined;
  const value = Number(text);
  if (!Number.isFinite(value) || !Number.isInteger(value)) throw new Error(`${label} must be a whole number`);
  if (min !== undefined && value < min) throw new Error(`${label} must be at least ${min}`);
  if (max !== undefined && value > max) throw new Error(`${label} must be at most ${max}`);
  return value;
}

/** Blank fields are left off so the server picks its own default. @throws with a readable message. */
function buildOptions(options: Options): GenerateBandRequest {
  const name = options.name.trim();
  const genre = options.genre.trim();
  return {
    seed: intField(options.seed, "seed"),
    genre: genre || undefined,
    size: intField(options.size, "size", 1, 16),
    name: name || undefined,
  };
}

function freshSeed(): number {
  return Math.floor(Math.random() * 2_147_483_647);
}

/** Part ids are slugs: `/^[a-z0-9][a-z0-9-]{0,31}$/`, so at most this many characters. */
const MAX_ID_LENGTH = 32;

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
}

function clip(slug: string, length: number): string {
  return slug.slice(0, Math.max(1, length)).replace(/-+$/, "");
}

/** A stable slug id for a new part, unique within the band. Mirrors the generator's ids. */
function partId(role: string, name: string, taken: Set<string>): string {
  const base = slugify(`${role}-${name}`) || slugify(role) || "part";
  let id = clip(base, MAX_ID_LENGTH);
  for (let n = 2; taken.has(id); n++) {
    const suffix = `-${n}`;
    id = `${clip(base, MAX_ID_LENGTH - suffix.length)}${suffix}`;
  }
  return id;
}

/** Genres present in the saved list plus the untagged bucket, each with a count. */
function genreBuckets(bands: Band[]): { genre: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const band of bands) {
    const key = bandGenre(band) ?? UNTAGGED;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([genre, count]) => ({ genre, count }))
    .sort((a, b) => {
      if (a.genre === UNTAGGED) return 1;
      if (b.genre === UNTAGGED) return -1;
      return a.genre.localeCompare(b.genre);
    });
}

export default function BandsPage() {
  const { bands, recipes, loading, busy, lastError, generate, save, remove } = useBands();
  const [options, setOptions] = useState<Options>(EMPTY_OPTIONS);
  const [optionError, setOptionError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Band | null>(null);
  const [metaRows, setMetaRows] = useState<MetaRow[]>([]);
  const [newPart, setNewPart] = useState<NewPart>(EMPTY_PART);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [filter, setFilter] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const set = (key: keyof Options) => (value: string) => setOptions((prev) => ({ ...prev, [key]: value }));

  const buckets = genreBuckets(bands);
  const knownGenre = recipes.some((r) => r.id === genreKey(options.genre));
  // A genre can disappear when its last band is deleted; fall back to "all"
  // rather than stranding the list on an empty view.
  const activeFilter = filter && buckets.some((b) => b.genre === filter) ? filter : null;
  const visible = activeFilter ? bands.filter((band) => (bandGenre(band) ?? UNTAGGED) === activeFilter) : bands;

  // Derived rather than stored, and from `visible` rather than `bands`: filtering
  // down to funk can never leave the inspector reading out a band that is not on
  // screen. Deleting the selected band falls through to the next one instead of
  // emptying the pane, and the first card is selected on arrival with no effect
  // to put it there.
  const selected = visible.find((band) => band.id === selectedId) ?? visible[0] ?? null;

  const roll = async (seedOverride?: number) => {
    let opts: GenerateBandRequest;
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
      const band = await generate(opts);
      setDraft(band);
      setMetaRows(toMetaRows(band.metadata));
      setNewPart(EMPTY_PART);
    } catch {
      // surfaced through useBands.lastError
    }
  };

  const discard = () => {
    setDraft(null);
    setMetaRows([]);
    setNewPart(EMPTY_PART);
    setDraftError(null);
  };

  /** Spreads the existing part so reserved fields like `emphasis` survive an edit. */
  const editPart = (id: string, patch: Partial<Pick<BandPart, "name" | "brief">>) =>
    setDraft((prev) =>
      prev ? { ...prev, parts: prev.parts.map((part) => (part.id === id ? { ...part, ...patch } : part)) } : prev,
    );

  const removePart = (id: string) =>
    setDraft((prev) => (prev ? { ...prev, parts: prev.parts.filter((part) => part.id !== id) } : prev));

  const addPart = () => {
    if (!draft) return;
    const role = newPart.role.trim();
    const name = newPart.name.trim();
    const brief = newPart.brief.trim();
    if (!role || !name || !brief) {
      setDraftError("a new part needs a role, a name and a brief");
      return;
    }
    const id = partId(role, name, new Set(draft.parts.map((part) => part.id)));
    setDraft({ ...draft, parts: [...draft.parts, { id, role, name, brief }] });
    setNewPart(EMPTY_PART);
    setDraftError(null);
  };

  const commit = async () => {
    if (!draft) return;
    const metadata: Record<string, string> = {};
    for (const row of metaRows) {
      const key = row.key.trim();
      if (!key) continue;
      // zod sees a Record by then, so a collapsed duplicate key has to be caught here.
      if (Object.hasOwn(metadata, key)) {
        setDraftError(`metadata: duplicate key ${JSON.stringify(key)}`);
        return;
      }
      metadata[key] = row.value;
    }
    const parsed = BandSchema.safeParse({ ...draft, metadata });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      setDraftError(issue ? `${issue.path.join(".") || "band"}: ${issue.message}` : "band is not valid");
      return;
    }
    setDraftError(null);
    try {
      // From the response: that copy is the one mate normalised, and the fold has
      // already landed it, so selecting it by id resolves under the rule above —
      // and answers "where did it go?" without moving the draft into the grid.
      const saved = await save(parsed.data);
      setSelectedId(saved.id);
      discard();
    } catch {
      // surfaced through useBands.lastError
    }
  };

  const destroy = async (id: string) => {
    setConfirmId(null);
    try {
      await remove(id);
    } catch {
      // surfaced through useBands.lastError
    }
  };

  return (
    <WorkspacePanel title="bands" meta={loading ? "loading…" : `${bands.length} saved`}>
      <ErrorNote message={lastError} />

      {/* `shrink-0` on the three sections: the column's scroller is what gives,
          not the generator's fields or the grid below it. */}
      <section className="flex shrink-0 flex-col gap-2 rounded-sm border border-line bg-panel-2 p-2.5">
        <PanelHeader title="generator" level={3} />
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <TextField id="gen-name" label="name" value={options.name} onChange={set("name")} placeholder="auto" />
          <TextField
            id="gen-seed"
            label="seed"
            value={options.seed}
            onChange={set("seed")}
            placeholder="random"
            inputMode="numeric"
          />
          <div className="flex flex-col gap-1">
            <label htmlFor="gen-genre" className="text-[10px] uppercase tracking-wider text-muted">
              genre
              <span className="ml-1 normal-case text-muted/60">
                {knownGenre ? "has a recipe" : options.genre.trim() || recipes.length === 0 ? "new · the model writes a recipe first" : "any"}
              </span>
            </label>
            <input
              id="gen-genre"
              list="gen-genre-options"
              value={options.genre}
              onChange={(e) => set("genre")(e.target.value)}
              placeholder="surprise me"
              className="w-full rounded-sm border border-line bg-panel-2 px-2 py-1 font-mono text-xs outline-none focus:border-accent"
            />
            <datalist id="gen-genre-options">
              {recipes.map((recipe) => (
                <option key={recipe.id} value={recipe.genre}>
                  {recipeRoles(recipe).join(" · ")}
                </option>
              ))}
            </datalist>
          </div>
          <TextField
            id="gen-size"
            label="size"
            hint="1–16"
            value={options.size}
            onChange={set("size")}
            placeholder="auto"
            inputMode="numeric"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void roll()}
            className="rounded-sm bg-accent px-4 py-1.5 text-sm font-semibold text-black disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy && !knownGenre && (options.genre.trim() || recipes.length === 0) ? "writing a recipe…" : "generate"}
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
        <section className="flex shrink-0 flex-col gap-3 rounded-sm border border-accent/50 bg-panel-2 p-2.5">
          <PanelHeader
            title="preview"
            level={3}
            meta={`${draft.parts.length} part${draft.parts.length === 1 ? "" : "s"}`}
            actions={<span className="rounded-sm bg-accent/20 px-1.5 py-0.5 font-mono text-[10px] text-accent">unsaved</span>}
          />

          <BandRoster parts={draft.parts} />

          <label className="flex flex-col gap-1" htmlFor="draft-name">
            <span className="text-[10px] uppercase tracking-wider text-muted">name</span>
            <input
              id="draft-name"
              className="rounded-sm border border-line bg-panel-2 px-2 py-1 text-sm outline-none focus:border-accent"
              value={draft.name}
              onChange={(e) => setDraft((prev) => (prev ? { ...prev, name: e.target.value } : prev))}
            />
          </label>

          <div className="flex flex-col gap-2">
            <PanelHeader title="parts" level={3} />
            {draft.parts.map((part) => (
              <div key={part.id} className="flex flex-col gap-1 rounded-sm border border-line bg-panel-2 p-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`rounded-sm border px-1.5 py-0.5 font-mono text-[10px] ${roleClass(part.role)}`}
                    title={part.role}
                  >
                    {part.role}
                  </span>
                  <span className="font-mono text-[10px] text-muted/60">{part.id}</span>
                  <button
                    type="button"
                    disabled={busy || draft.parts.length <= 1}
                    onClick={() => removePart(part.id)}
                    className="ml-auto rounded-sm border border-line px-2 py-0.5 text-[11px] text-muted hover:text-audio disabled:cursor-not-allowed disabled:opacity-40"
                    title={draft.parts.length <= 1 ? "a band needs at least one part" : "remove this part"}
                  >
                    remove
                  </button>
                </div>
                <label className="flex flex-col gap-1" htmlFor={`draft-part-name-${part.id}`}>
                  <span className="text-[10px] uppercase tracking-wider text-muted">name</span>
                  <input
                    id={`draft-part-name-${part.id}`}
                    className="rounded-sm border border-line bg-panel px-2 py-1 text-xs outline-none focus:border-accent"
                    value={part.name}
                    onChange={(e) => editPart(part.id, { name: e.target.value })}
                  />
                </label>
                <label className="flex flex-col gap-1" htmlFor={`draft-part-brief-${part.id}`}>
                  <span className="text-[10px] uppercase tracking-wider text-muted">brief</span>
                  <textarea
                    id={`draft-part-brief-${part.id}`}
                    rows={2}
                    className="resize-y rounded-sm border border-line bg-panel px-2 py-1 text-xs leading-snug outline-none focus:border-accent"
                    value={part.brief}
                    onChange={(e) => editPart(part.id, { brief: e.target.value })}
                  />
                </label>
              </div>
            ))}
          </div>

          <div className="flex flex-col gap-2 rounded-sm border border-dashed border-line p-2">
            <PanelHeader title="add a part" level={3} />
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-[8rem_1fr]">
              <div className="flex flex-col gap-1">
                <label htmlFor="new-part-role" className="text-[10px] uppercase tracking-wider text-muted">
                  role
                </label>
                <select
                  id="new-part-role"
                  value={newPart.role}
                  onChange={(e) => setNewPart((prev) => ({ ...prev, role: e.target.value }))}
                  className="w-full rounded-sm border border-line bg-panel-2 px-2 py-1 font-mono text-xs outline-none focus:border-accent"
                >
                  {ROLES.map((role) => (
                    <option key={role} value={role}>
                      {role}
                    </option>
                  ))}
                </select>
              </div>
              <TextField
                id="new-part-name"
                label="name"
                value={newPart.name}
                onChange={(value) => setNewPart((prev) => ({ ...prev, name: value }))}
                placeholder="Rhodes"
              />
            </div>
            <label className="flex flex-col gap-1" htmlFor="new-part-brief">
              <span className="text-[10px] uppercase tracking-wider text-muted">brief</span>
              <textarea
                id="new-part-brief"
                rows={2}
                className="resize-y rounded-sm border border-line bg-panel-2 px-2 py-1 text-xs leading-snug outline-none focus:border-accent"
                value={newPart.brief}
                onChange={(e) => setNewPart((prev) => ({ ...prev, brief: e.target.value }))}
                placeholder="warm tine electric piano, sustained ninth chords under the groove"
              />
            </label>
            <span>
              <button
                type="button"
                disabled={busy}
                onClick={addPart}
                className="rounded-sm border border-line bg-panel-2 px-3 py-1 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-40"
              >
                + add part
              </button>
            </span>
          </div>

          <div className="flex flex-col gap-2">
            <PanelHeader title="metadata" level={3} />
            {metaRows.length === 0 ? <p className="text-[11px] text-muted">no tags</p> : null}
            {metaRows.map((row) => (
              <div key={row.rowId} className="flex flex-wrap items-end gap-2">
                <div className="flex flex-col gap-1">
                  <label htmlFor={`meta-key-${row.rowId}`} className="text-[10px] uppercase tracking-wider text-muted">
                    key
                  </label>
                  <input
                    id={`meta-key-${row.rowId}`}
                    value={row.key}
                    onChange={(e) =>
                      setMetaRows((prev) =>
                        prev.map((r) => (r.rowId === row.rowId ? { ...r, key: e.target.value } : r)),
                      )
                    }
                    className="w-40 rounded-sm border border-line bg-panel-2 px-2 py-1 font-mono text-xs outline-none focus:border-accent"
                  />
                </div>
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <label htmlFor={`meta-value-${row.rowId}`} className="text-[10px] uppercase tracking-wider text-muted">
                    value
                  </label>
                  <input
                    id={`meta-value-${row.rowId}`}
                    value={row.value}
                    onChange={(e) =>
                      setMetaRows((prev) =>
                        prev.map((r) => (r.rowId === row.rowId ? { ...r, value: e.target.value } : r)),
                      )
                    }
                    className="w-full rounded-sm border border-line bg-panel-2 px-2 py-1 font-mono text-xs outline-none focus:border-accent"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => setMetaRows((prev) => prev.filter((r) => r.rowId !== row.rowId))}
                  className="rounded-sm border border-line px-2 py-1 text-[11px] text-muted hover:text-audio"
                >
                  remove
                </button>
              </div>
            ))}
            <span>
              <button
                type="button"
                onClick={() => setMetaRows((prev) => [...prev, { rowId: nextRowId(), key: "", value: "" }])}
                className="rounded-sm border border-line bg-panel-2 px-3 py-1 text-xs font-medium"
              >
                + add tag
              </button>
            </span>
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
              onClick={discard}
              className="rounded-sm border border-line bg-panel-2 px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-40"
            >
              discard
            </button>
            {draftError ? <span className="font-mono text-[11px] text-audio">{draftError}</span> : null}
          </div>
        </section>
      ) : null}

      <section className="flex shrink-0 flex-col gap-2 rounded-sm border border-line bg-panel-2 p-2.5">
        <PanelHeader
          title="saved bands"
          level={3}
          actions={
            buckets.length > 0 ? (
              <span className="flex flex-wrap items-center justify-end gap-1">
                <FilterChip label="all" count={bands.length} active={activeFilter === null} onClick={() => setFilter(null)} />
                {buckets.map((bucket) => (
                  <FilterChip
                    key={bucket.genre}
                    label={bucket.genre}
                    count={bucket.count}
                    active={activeFilter === bucket.genre}
                    onClick={() => setFilter(bucket.genre)}
                  />
                ))}
              </span>
            ) : null
          }
        />
        {loading ? (
          <p className="text-xs text-muted">Loading…</p>
        ) : bands.length === 0 ? (
          <p className="text-xs text-muted">
            {lastError ? "Could not load bands — see the error above." : "Nothing saved yet. Generate a band above, then save it."}
          </p>
        ) : (
          // The column is a third of the page, so the row measures itself, not
          // the viewport: a container query keeps one card per row beside a wide
          // conversation pane and three across on a full-width window.
          <div className="@container">
            {/* Content-height, deliberately: the generator above it (and a draft,
                when one is open) come first in the workspace column's scroller,
                so free space there is already negative. A `flex-1` row would
                shrink by `1 × 0` — absorbing none of the deficit — and with
                `min-h-0` removing the content floor it would resolve to nothing
                and take the grid with it. So the row grows with its cards and
                the panel's scroller, the column's only one, does the scrolling;
                the inspector rides along pinned instead of stretched. Sticky
                only at the row breakpoint: stacked, the cross axis flips and
                `items-start` would collapse the aside to its text. */}
            <div className="flex flex-col gap-2 @min-[40rem]:flex-row @min-[40rem]:items-start">
              <ul className="grid min-w-0 flex-1 auto-rows-min grid-cols-1 gap-2 @min-[47rem]:grid-cols-2 @min-[62rem]:grid-cols-3">
                {visible.map((band) => (
                  <BandCard
                    key={band.id}
                    band={band}
                    selected={selected?.id === band.id}
                    onSelect={() => setSelectedId(band.id)}
                    busy={busy}
                    confirming={confirmId === band.id}
                    onConfirm={() => setConfirmId(band.id)}
                    onCancel={() => setConfirmId(null)}
                    onDelete={() => void destroy(band.id)}
                  />
                ))}
              </ul>
              {selected ? <BandInspector band={selected} /> : null}
            </div>
          </div>
        )}
      </section>
    </WorkspacePanel>
  );
}

function FilterChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-sm border px-2 py-0.5 font-mono text-[10px] ${
        active ? "border-accent/60 bg-accent/15 text-accent" : "border-line text-muted hover:text-foreground"
      }`}
    >
      {label} {count}
    </button>
  );
}

interface CardProps {
  band: Band;
  selected: boolean;
  onSelect: () => void;
  busy: boolean;
  confirming: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onDelete: () => void;
}

/** Full class strings only — Tailwind cannot see interpolated names. */
const CARD_CLASS = {
  on: "flex cursor-pointer flex-col gap-2 rounded-sm border border-accent/60 bg-accent/10 p-2.5",
  off: "flex cursor-pointer flex-col gap-2 rounded-sm border border-line bg-panel p-2.5 hover:border-line/80 hover:bg-panel-2",
};

function BandCard({ band, selected, onSelect, busy, confirming, onConfirm, onCancel, onDelete }: CardProps) {
  const genre = bandGenre(band);

  return (
    // Anywhere on the card selects it, which is the mouse affordance. The
    // keyboard one is the name itself, a real button: nesting the delete
    // control inside a `role="button"` card would make one interactive element
    // swallow another, and give the li two contradictory roles at once.
    <li onClick={onSelect} className={selected ? CARD_CLASS.on : CARD_CLASS.off}>
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h4 className="truncate text-sm font-medium">
            <button
              type="button"
              aria-pressed={selected}
              onClick={(e) => {
                e.stopPropagation();
                onSelect();
              }}
              title={band.name}
              className="block w-full truncate text-left"
            >
              {band.name}
            </button>
          </h4>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span
              className={`rounded-sm border px-1.5 py-0.5 font-mono text-[10px] ${
                genre ? "border-accent/60 text-accent" : "border-line text-muted"
              }`}
            >
              {genre ?? UNTAGGED}
            </span>
            <span className="font-mono text-[10px] text-muted/70">
              {band.parts.length} part{band.parts.length === 1 ? "" : "s"}
            </span>
            <span className="font-mono text-[10px] text-muted/70" title={new Date(band.createdAt).toLocaleString()}>
              {new Date(band.createdAt).toLocaleDateString()}
            </span>
            {band.seed !== undefined ? (
              // The seed used to be the name. It is a fact about the roll, so it
              // reads like the other facts — and it is here at all because it is
              // what you type into the generator to staff this roster again.
              <span
                className="font-mono text-[10px] text-muted/50"
                title={`rolled from seed ${band.seed} — generate with it to staff this roster again`}
              >
                #{band.seed}
              </span>
            ) : null}
          </div>
        </div>
        {/* The whole delete cluster, both states, stops the click from reaching
            the card: deleting a band should never also select it on the way. */}
        <span className="flex shrink-0 items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
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

      <BandRoster parts={band.parts} compact />
    </li>
  );
}

/**
 * Everything about the selected band the card has no room for: every brief in
 * full, and whatever else the metadata carries.
 *
 * The briefs are the point. They are Splice search prompts, a sentence or two
 * each, and a card can only truncate them — which is exactly when you want to
 * read one, after a search came back with the wrong thing. Nothing here is
 * `BandRoster`: its wide variant's fixed columns come to ~290px before the
 * brief starts, and its compact one truncates, so this writes its own lanes the
 * way the recipes inspector writes its own bench.
 *
 * No re-roll button, unlike the recipes inspector. A saved band is a record,
 * not a generator: the roll that made it is spent, and its seed is on the card
 * for anyone who wants to make another.
 */
function BandInspector({ band }: { band: Band }) {
  const genre = bandGenre(band);
  const tags = Object.entries(band.metadata);

  return (
    // The frame every other panel wears, and the rhythm too: `PanelHeader` owns
    // the rule under the title and its own padding, so the body pads nothing and
    // each section carries the same full-bleed rule instead. No overflow-y-auto
    // — the workspace column owns the one scroller.
    <aside className="flex shrink-0 flex-col overflow-hidden rounded-md border border-line bg-panel @min-[40rem]:sticky @min-[40rem]:top-0 @min-[40rem]:w-72">
      <PanelHeader title="inspector" />

      <div className="flex flex-col">
        <div className="flex flex-col gap-0.5 border-b border-line px-3 py-2.5">
          <h3 className="truncate text-sm font-medium text-accent" title={band.name}>
            {band.name}
          </h3>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span
              className={`rounded-sm border px-1.5 py-0.5 font-mono text-[10px] ${
                genre ? "border-accent/60 text-accent" : "border-line text-muted"
              }`}
            >
              {genre ?? UNTAGGED}
            </span>
            <span className="font-mono text-[10px] text-muted/70">
              {band.parts.length} part{band.parts.length === 1 ? "" : "s"}
            </span>
            <span className="font-mono text-[10px] text-muted/70" title={new Date(band.createdAt).toLocaleString()}>
              {new Date(band.createdAt).toLocaleDateString()}
            </span>
            {band.seed !== undefined ? (
              <span
                className="font-mono text-[10px] text-muted/50"
                title={`rolled from seed ${band.seed} — generate with it to staff this roster again`}
              >
                #{band.seed}
              </span>
            ) : null}
          </div>
        </div>

        <section className="flex flex-col gap-1.5 border-b border-line px-3 py-2.5">
          <PanelHeader title="lineup" level={3} />
          <ul className="flex flex-col gap-2">
            {band.parts.map((part) => (
              <li key={part.id} className="flex flex-col gap-0.5">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className={`h-2.5 w-1 shrink-0 rounded-sm ${roleClass(part.role)}`} aria-hidden="true" />
                  <span className={`shrink-0 font-mono text-[11px] uppercase tracking-wider ${roleTextClass(part.role)}`}>
                    {part.role}
                  </span>
                  <span className="min-w-0 truncate text-xs" title={part.name}>
                    {part.name}
                  </span>
                </span>
                {/* Wrapped, not truncated. This is the one place the whole brief
                    reads without a hover, and it is why the pane exists. */}
                <span className="text-[11px] leading-snug text-muted">{part.brief}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="flex flex-col gap-1.5 px-3 py-2.5">
          <PanelHeader title="metadata" level={3} />
          {tags.length === 0 ? (
            <p className="text-[11px] text-muted">no tags</p>
          ) : (
            // Free-form: `genre` is the only key anything reads, and everything
            // else a drummer or the bandmate wrote is only ever shown here.
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2.5 gap-y-0.5 font-mono text-[10px] leading-snug">
              {tags.map(([key, value]) => (
                <Fragment key={key}>
                  <dt className="whitespace-nowrap text-muted/70">{key}</dt>
                  <dd className="min-w-0 break-words text-foreground/90">{value}</dd>
                </Fragment>
              ))}
            </dl>
          )}
        </section>
      </div>
    </aside>
  );
}
