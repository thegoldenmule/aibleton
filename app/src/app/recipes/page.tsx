"use client";

import { useMemo, useState } from "react";
import { generateBand, oneRecipe, recipeRoles, type BandPart, type BandRecipe } from "@aibleton/protocol";
import { BandRoster, roleClass } from "../../components/BandRoster";
import { ErrorNote } from "../../components/ui/ErrorNote";
import { PanelHeader } from "../../components/ui/PanelHeader";
import { WorkspacePanel } from "../../components/WorkspacePanel";
import { useRecipes } from "../../lib/useRecipes";

/**
 * How each genre staffs a band, one card per genre.
 *
 * A recipe is a *generator*, not a document, so the card leads with what it
 * produces: the lineup, and a band actually rolled from it — rendered with the
 * same `BandRoster` a saved band wears, because that is what this recipe turns
 * into. The briefs stay folded away. They are Splice search prompts, wanted
 * when a search came back wrong rather than while you are looking for a genre,
 * and all of them at once is ~1,500 words on one screen.
 *
 * Read-only but for the forget. Nothing here writes a recipe — they arrive on
 * the stream when something asks for a band in a genre mate has none for, which
 * is why the grid can grow while you are looking at it.
 */
export default function RecipesPage() {
  const { recipes, loading, busy, lastError, remove } = useRecipes();
  const [confirmId, setConfirmId] = useState<string | null>(null);

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

      <section className="flex flex-col gap-2 rounded-sm border border-line bg-panel-2 p-2.5">
        <PanelHeader title="written recipes" level={3} count={recipes.length > 0 ? recipes.length : undefined} />
        {loading ? (
          <p className="text-xs text-muted">Loading…</p>
        ) : recipes.length === 0 ? (
          <p className="text-xs text-muted">
            {lastError
              ? "Could not load recipes — see the error above."
              : "Nothing written yet. Mate ships no recipes: ask for a band in a genre on the bands page, or ask the bandmate for one, and its recipe is written here first."}
          </p>
        ) : (
          // The column is a third of the page, so the grid measures itself, not
          // the viewport — the same container query the band cards use.
          <div className="@container">
            <ul className="grid grid-cols-1 gap-2 @min-[34rem]:grid-cols-2 @min-[54rem]:grid-cols-3">
              {recipes.map((recipe) => (
                <RecipeCard
                  key={recipe.id}
                  recipe={recipe}
                  busy={busy}
                  confirming={confirmId === recipe.id}
                  onConfirm={() => setConfirmId(recipe.id)}
                  onCancel={() => setConfirmId(null)}
                  onDelete={() => void destroy(recipe.id)}
                />
              ))}
            </ul>
          </div>
        )}
      </section>
    </WorkspacePanel>
  );
}

interface CardProps {
  recipe: BandRecipe;
  busy: boolean;
  confirming: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onDelete: () => void;
}

function RecipeCard({ recipe, busy, confirming, onConfirm, onCancel, onDelete }: CardProps) {
  const [bench, setBench] = useState(false);
  const roles = recipeRoles(recipe);
  const min = recipe.core.length;
  const max = min + recipe.optional.length;

  /**
   * One band actually rolled from this recipe. Free — `generateBand` is pure —
   * and it says in four names what the briefs below cannot: what you get. A
   * fixed seed, so it does not reshuffle on every render.
   */
  const sample = useMemo<BandPart[]>(() => {
    try {
      return generateBand({ seed: 0, genre: recipe.id }, oneRecipe(recipe)).parts;
    } catch {
      return [];
    }
  }, [recipe]);

  const odds = useMemo(() => partOdds(recipe), [recipe]);

  return (
    <li className="flex flex-col gap-2 rounded-sm border border-line bg-panel p-2.5">
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h4 className="truncate text-sm font-medium" title={recipe.genre}>
            {recipe.genre}
          </h4>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-mono text-[10px] text-muted/70">
              {min === max ? `${min} parts` : `${min}–${max} parts`}
            </span>
            <span className="font-mono text-[10px] text-muted/70">
              {roles.length} role{roles.length === 1 ? "" : "s"}
            </span>
            <span className="font-mono text-[10px] text-muted/70" title={new Date(recipe.createdAt).toLocaleString()}>
              {new Date(recipe.createdAt).toLocaleDateString()}
            </span>
          </div>
        </div>
        {confirming ? (
          <span className="flex shrink-0 items-center gap-1.5">
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
          </span>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className="shrink-0 rounded-sm border border-line px-2 py-0.5 text-[11px] text-muted hover:text-audio disabled:cursor-not-allowed disabled:opacity-40"
          >
            forget
          </button>
        )}
      </div>

      <PartOdds odds={odds} />

      {sample.length > 0 ? (
        <div className="flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-wider text-muted/50">a band from this recipe</span>
          <BandRoster parts={sample} compact />
        </div>
      ) : null}

      <div className="flex flex-col gap-1">
        <button
          type="button"
          onClick={() => setBench((prev) => !prev)}
          aria-expanded={bench}
          className="flex items-center gap-1.5 self-start text-[11px] text-muted hover:text-foreground"
        >
          <Chevron open={bench} />
          who else can play
        </button>
        {bench ? <Bench recipe={recipe} roles={roles} /> : null}
      </div>
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

/**
 * Everyone on the bench, per role. Names only — the sample roster above already
 * shows what a brief reads like, and the question this answers is "who else
 * could turn up", which the names answer on their own. Each carries its brief
 * as a tooltip, the way a part in `BandRoster` does.
 *
 * A name in the role's colour is one a *core* slot can reach (the recipe's
 * `anchors`); the muted ones only ever arrive as extra parts.
 */
function Bench({ recipe, roles }: { recipe: BandRecipe; roles: string[] }) {
  return (
    <ul className="flex flex-col gap-1.5 border-t border-line pt-1.5">
      {roles.map((role) => {
        const names = recipe.names[role] ?? [];
        const briefs = recipe.briefs[role] ?? [];
        const anchor = recipe.anchors[role];
        const reach = anchor !== undefined && anchor < names.length ? anchor : names.length;
        return (
          <li key={role} className="flex flex-col gap-1">
            <span className="flex items-center gap-1.5">
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

/** Full class strings only — Tailwind cannot see interpolated names. */
const CHEVRON_CLASS = {
  open: "shrink-0 rotate-90 transition-transform",
  shut: "shrink-0 transition-transform",
};

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width={10}
      height={10}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={3}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={open ? CHEVRON_CLASS.open : CHEVRON_CLASS.shut}
    >
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}
