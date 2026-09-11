"use client";

import { useMemo, useState, type ReactNode } from "react";
import { generateBand, oneRecipe, recipeRoles, type BandPart, type BandRecipe } from "@aibleton/protocol";
import { BandRoster, roleClass } from "../../components/BandRoster";
import { ErrorNote } from "../../components/ui/ErrorNote";
import { PanelHeader } from "../../components/ui/PanelHeader";
import { WorkspacePanel } from "../../components/WorkspacePanel";
import { useRecipes } from "../../lib/useRecipes";

/**
 * How each genre staffs a band: a card per genre, and one of them selected.
 *
 * A recipe is a *generator*, not a document, so a card shows only what it
 * produces — how likely each part is to turn up — and the panel beside it rolls
 * the selected recipe into an actual band, rendered with the same `BandRoster`
 * a saved band wears, because that is what this recipe turns into.
 *
 * The inspector is where the detail lives, one recipe at a time. That is the
 * whole reason this page is a selection and not a list: laying every recipe's
 * names and briefs out at once was ~1,500 words across four genres. The briefs
 * still never render as prose — they are Splice search prompts, wanted when a
 * search came back wrong — so each name carries its own on hover.
 *
 * Read-only but for the forget. Nothing here writes a recipe — they arrive on
 * the stream when something asks for a band in a genre mate has none for, which
 * is why the grid can grow while you are looking at it.
 */
export default function RecipesPage() {
  const { recipes, loading, busy, lastError, remove } = useRecipes();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [seed, setSeed] = useState(0);

  // Derived rather than stored, so forgetting the selected recipe falls back to
  // the next one instead of emptying the panel — and so the first card is
  // selected on arrival without an effect to put it there.
  const selected = recipes.find((recipe) => recipe.id === selectedId) ?? recipes[0] ?? null;

  async function destroy(id: string) {
    setConfirmId(null);
    try {
      await remove(id);
    } catch {
      /* surfaced through useRecipes().lastError */
    }
  }

  return (
    <WorkspacePanel
      title="recipes"
      meta={loading ? "loading…" : `${recipes.length} ${recipes.length === 1 ? "genre" : "genres"}`}
    >
      <ErrorNote message={lastError} />

      {loading ? (
        <p className="text-xs text-muted">Loading…</p>
      ) : recipes.length === 0 ? (
        <p className="text-xs text-muted">
          {lastError
            ? "Could not load recipes — see the error above."
            : "Nothing written yet. Mate ships no recipes: ask for a band in a genre on the bands page, or ask the bandmate for one, and its recipe is written here first."}
        </p>
      ) : (
        // The column is a third of the page, so everything here measures itself
        // rather than the viewport — the same container query the band cards
        // use. Narrow, the sample sits under the grid; wide, it sits beside it.
        <div className="@container flex min-h-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1 flex-col gap-2 @min-[40rem]:flex-row">
            <ul className="grid min-w-0 flex-1 auto-rows-min grid-cols-1 gap-2 @min-[47rem]:grid-cols-2 @min-[62rem]:grid-cols-3">
              {recipes.map((recipe) => (
                <RecipeCard
                  key={recipe.id}
                  recipe={recipe}
                  selected={selected?.id === recipe.id}
                  onSelect={() => setSelectedId(recipe.id)}
                  busy={busy}
                  confirming={confirmId === recipe.id}
                  onConfirm={() => setConfirmId(recipe.id)}
                  onCancel={() => setConfirmId(null)}
                  onDelete={() => void destroy(recipe.id)}
                />
              ))}
            </ul>
            {selected ? <Inspector recipe={selected} seed={seed} onRoll={() => setSeed(freshSeed)} /> : null}
          </div>
        </div>
      )}
    </WorkspacePanel>
  );
}

/** A fresh random seed, the same way the band generator's "roll again" gets one. */
function freshSeed(): number {
  return Math.floor(Math.random() * 2_147_483_647);
}

/**
 * Everything about the selected recipe that a card has no room for: a band
 * rolled out of it, and the bench each of those parts was drawn from.
 *
 * It stretches the height of the column rather than sitting in it as a box —
 * the row it lives in is `flex-1`, so when the grid is short this fills, and
 * when either side is tall the workspace panel's own scroller takes it. No
 * second scroller: the column owns exactly one.
 */
function Inspector({ recipe, seed, onRoll }: { recipe: BandRecipe; seed: number; onRoll: () => void }) {
  const roles = recipeRoles(recipe);

  /**
   * The selected recipe, rolled. Free — `generateBand` is pure — and it says in
   * four names what a page of briefs cannot: what you get.
   *
   * The seed is shown because it is the handle, not decoration: `POST
   * /bands/generate` runs this very function, so the same seed and genre staff
   * this exact roster for real. Nothing on this page saves anything.
   */
  const sample = useMemo<BandPart[]>(() => {
    try {
      return generateBand({ seed, genre: recipe.id }, oneRecipe(recipe)).parts;
    } catch {
      return [];
    }
  }, [recipe, seed]);

  return (
    // The frame every other panel wears. `PanelHeader` at its default level owns
    // the rule under it *and* its own padding, so this must not pad its own top.
    // No `overflow-y-auto` on the body — the workspace column owns the one scroller.
    <aside className="flex shrink-0 flex-col overflow-hidden rounded-md border border-line bg-panel @min-[40rem]:w-72">
      <PanelHeader
        title="inspector"
        meta={<span title={new Date(recipe.createdAt).toLocaleString()}>written {new Date(recipe.createdAt).toLocaleDateString()}</span>}
      />

      <div className="flex flex-col gap-3 p-3">
        <h3 className="truncate text-sm font-medium text-accent" title={recipe.genre}>
          {recipe.genre}
        </h3>

        <section className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Label>a band from this recipe</Label>
            <span className="ml-auto flex items-center gap-1.5">
              <span
                className="font-mono text-[10px] text-muted/50"
                title={`rolled from seed ${seed} — generate with it on the bands page to staff this roster for real`}
              >
                #{seed}
              </span>
              <button
                type="button"
                onClick={onRoll}
                title="Roll another band from this recipe. Nothing is saved — the bands page is where one is kept."
                className="rounded-sm border border-accent-2/60 px-2 py-0.5 font-mono text-[11px] text-accent-2"
              >
                ↻ roll again
              </button>
            </span>
          </div>
          {sample.length > 0 ? (
            <BandRoster parts={sample} compact />
          ) : (
            <p className="text-xs text-muted">This recipe could not be rolled.</p>
          )}
        </section>

        <section className="flex flex-col gap-1.5">
          <Label>who else can play</Label>
          <Bench recipe={recipe} roles={roles} />
        </section>
      </div>
    </aside>
  );
}

function Label({ children }: { children: ReactNode }) {
  return <span className="font-mono text-[10px] uppercase tracking-wider text-muted/50">{children}</span>;
}

/**
 * Everyone on the bench, per role. Names only — the roster above already shows
 * what a brief reads like, and the question this answers is "who else could
 * turn up", which the names answer on their own. Each carries its brief as a
 * tooltip, the way a part in `BandRoster` does.
 *
 * A name in the role's colour is one a *core* slot can reach (the recipe's
 * `anchors`); the muted ones only ever arrive as extra parts.
 */
function Bench({ recipe, roles }: { recipe: BandRecipe; roles: string[] }) {
  return (
    <ul className="flex flex-col gap-1.5">
      {roles.map((role) => {
        const names = recipe.names[role] ?? [];
        const briefs = recipe.briefs[role] ?? [];
        const anchor = recipe.anchors[role];
        const reach = anchor !== undefined && anchor < names.length ? anchor : names.length;
        return (
          <li key={role} className="flex flex-col gap-1">
            <span className="flex flex-wrap items-center gap-1.5">
              <span className={`shrink-0 rounded-sm border px-1 py-px font-mono text-[9px] ${roleClass(role)}`}>{role}</span>
              {reach < names.length ? (
                <span className="font-mono text-[9px] text-muted/50">core picks from the first {reach}</span>
              ) : null}
            </span>
            <span className="flex flex-wrap gap-1">
              {names.map((name, i) => (
                <span
                  key={`${name}-${i}`}
                  title={briefs[i % Math.max(briefs.length, 1)] ?? undefined}
                  className={
                    i < reach
                      ? `cursor-help rounded-sm border px-1 py-px font-mono text-[10px] ${roleClass(role)}`
                      : "cursor-help rounded-sm border border-line px-1 py-px font-mono text-[10px] text-muted"
                  }
                >
                  {name}
                </span>
              ))}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

interface CardProps {
  recipe: BandRecipe;
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

function RecipeCard({ recipe, selected, onSelect, busy, confirming, onConfirm, onCancel, onDelete }: CardProps) {
  const odds = useMemo(() => partOdds(recipe), [recipe]);

  return (
    // Anywhere on the card selects it, which is the mouse affordance. The
    // keyboard one is the genre itself, a real button: nesting the forget
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
              title={recipe.genre}
              className="block w-full truncate text-left"
            >
              {recipe.genre}
            </button>
          </h4>
          <span className="font-mono text-[10px] text-muted/70" title={new Date(recipe.createdAt).toLocaleString()}>
            {new Date(recipe.createdAt).toLocaleDateString()}
          </span>
        </div>
        <span className="flex shrink-0 items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
          {confirming ? (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={onDelete}
                title="the next band in this genre has a new recipe written, which costs a model call"
                className="rounded-sm border border-audio/60 px-2 py-0.5 text-[11px] font-medium text-audio disabled:cursor-not-allowed disabled:opacity-40"
              >
                forget?
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
              forget
            </button>
          )}
        </span>
      </div>

      <PartOdds odds={odds} />
    </li>
  );
}

/**
 * How often each part actually turns up, measured by rolling the recipe rather
 * than read off the weights.
 *
 * A weight is not a chance: `pickOptional` draws without replacement, and the
 * size of the band is its own seeded draw, so how likely a part is depends on
 * the whole recipe and not on its own number. Gospel's `keys ×0.8` beats
 * `horns ×0.6` by a third on paper and by a tenth in practice — and since keys
 * is already core, that row is a *second* keys player, which no weight says at
 * all.
 *
 * One row per part the band could have: the core in track order, then everyone
 * else by how likely they are. `nth > 1` is another player of a role already in
 * the band.
 */
export interface PartChance {
  role: string;
  /** Which player of this role: 1 is the first, 2 a second alongside it. */
  nth: number;
  /** 0–1, the share of rolls this part appeared in. 1 for a core slot. */
  chance: number;
  /** True when the recipe always staffs it, so no percentage is worth showing. */
  always: boolean;
}

/**
 * Enough rolls to settle the bars to about a percent, and cheap: ~3ms for one
 * recipe. Fixed seeds from zero, so the graph is the same on every machine and
 * does not shimmer between renders.
 */
const ODDS_SAMPLES = 1000;

function partOdds(recipe: BandRecipe): PartChance[] {
  const look = oneRecipe(recipe);
  const core = new Map<string, number>();
  for (const role of recipe.core) core.set(role, (core.get(role) ?? 0) + 1);
  const most = new Map(core);
  for (const entry of recipe.optional) most.set(entry.role, (most.get(entry.role) ?? 0) + 1);

  const seen = new Map<string, number[]>();
  for (const [role, max] of most) seen.set(role, new Array<number>(max + 1).fill(0));

  for (let seed = 0; seed < ODDS_SAMPLES; seed++) {
    let parts: { role: string }[];
    try {
      parts = generateBand({ seed, genre: recipe.id }, look).parts;
    } catch {
      return [];
    }
    const counts = new Map<string, number>();
    for (const part of parts) counts.set(part.role, (counts.get(part.role) ?? 0) + 1);
    for (const [role, tally] of seen) {
      const n = Math.min(counts.get(role) ?? 0, tally.length - 1);
      for (let j = 1; j <= n; j++) tally[j] = tally[j]! + 1;
    }
  }

  const rest: PartChance[] = [];
  for (const [role, tally] of seen) {
    for (let nth = 1; nth < tally.length; nth++) {
      if (nth <= (core.get(role) ?? 0)) continue; // core is listed in track order below
      rest.push({ role, nth, chance: tally[nth]! / ODDS_SAMPLES, always: false });
    }
  }
  rest.sort((a, b) => b.chance - a.chance || a.role.localeCompare(b.role) || a.nth - b.nth);

  // Core first, in recipe order — that order is the track order in Ableton.
  const placed = new Map<string, number>();
  const first: PartChance[] = recipe.core.map((role) => {
    const nth = (placed.get(role) ?? 0) + 1;
    placed.set(role, nth);
    return { role, nth, chance: 1, always: true };
  });
  return [...first, ...rest];
}

/** The label a row wears: `keys`, or `keys +1` for a second one alongside it. */
function partLabel(part: PartChance, core: ReadonlyMap<string, number>): string {
  const base = core.get(part.role) ?? 0;
  if (part.nth <= Math.max(base, 1)) return part.role;
  return `${part.role} +${part.nth - Math.max(base, 1)}`;
}

function PartOdds({ odds }: { odds: PartChance[] }) {
  const core = useMemo(() => {
    const counts = new Map<string, number>();
    for (const part of odds) if (part.always) counts.set(part.role, (counts.get(part.role) ?? 0) + 1);
    return counts;
  }, [odds]);
  if (odds.length === 0) return null;
  return (
    <ul className="flex flex-col gap-0.5">
      {odds.map((part, i) => {
        const label = partLabel(part, core);
        return (
          <li key={`${part.role}-${part.nth}`} className="flex items-center gap-1.5">
            <span className="w-3 shrink-0 text-right font-mono text-[9px] text-muted/40">
              {part.always ? i + 1 : ""}
            </span>
            <span
              className={`w-[4.5rem] shrink-0 truncate rounded-sm border px-1 py-px font-mono text-[9px] ${roleClass(part.role)}`}
              title={label}
            >
              {label}
            </span>
            <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-sm bg-line">
              <span
                className={part.always ? "block h-full rounded-sm bg-accent/70" : "block h-full rounded-sm bg-accent/35"}
                style={{ width: `${Math.round(part.chance * 100)}%` }}
              />
            </span>
            <span className="w-9 shrink-0 text-right font-mono text-[9px] text-muted/60">
              {part.always ? "always" : `${Math.round(part.chance * 100)}%`}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

