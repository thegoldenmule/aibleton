"use client";

import { useMemo, useState, type ReactNode } from "react";
import { generateBand, oneRecipe, recipeRoles, type BandRecipe } from "@aibleton/protocol";
import { ErrorNote } from "../../components/ui/ErrorNote";
import { WorkspacePanel } from "../../components/WorkspacePanel";
import { useRecipes } from "../../lib/useRecipes";

/**
 * How each genre staffs a band.
 *
 * A recipe is a *generator*, not a document, so the page leads with what it
 * produces — a band rolled from it, and the shape of the roster — and keeps the
 * briefs folded away. They are Splice search prompts: the thing you want when a
 * search came back wrong, not while you are looking for a genre. Rendering all
 * of them at once was ~1,500 words on one screen.
 *
 * Read-only but for the forget. Nothing here writes a recipe — they arrive on
 * the stream when something asks for a band in a genre mate has none for, which
 * is why the list can grow while you are looking at it.
 */
export default function RecipesPage() {
  const { recipes, loading, busy, lastError, remove } = useRecipes();
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [confirmId, setConfirmId] = useState<string | null>(null);

  function toggle(id: string) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

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
        <ul className="flex flex-col gap-1.5">
          {recipes.map((recipe) => (
            <RecipeRow
              key={recipe.id}
              recipe={recipe}
              open={open.has(recipe.id)}
              onToggle={() => toggle(recipe.id)}
              busy={busy}
              confirming={confirmId === recipe.id}
              onConfirm={() => setConfirmId(recipe.id)}
              onCancel={() => setConfirmId(null)}
              onDelete={() => void destroy(recipe.id)}
            />
          ))}
        </ul>
      )}
    </WorkspacePanel>
  );
}

interface RowProps {
  recipe: BandRecipe;
  open: boolean;
  onToggle: () => void;
  busy: boolean;
  confirming: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onDelete: () => void;
}

function RecipeRow({ recipe, open, onToggle, busy, confirming, onConfirm, onCancel, onDelete }: RowProps) {
  const min = recipe.core.length;
  const max = min + recipe.optional.length;

  /**
   * One band actually rolled from this recipe. Free — `generateBand` is pure —
   * and it says in four words what the prose below cannot: what you get.
   * A fixed seed so it does not reshuffle on every render.
   */
  const sample = useMemo(() => {
    try {
      return generateBand({ seed: 0, genre: recipe.id }, oneRecipe(recipe)).parts.map((p) => p.name);
    } catch {
      return [];
    }
  }, [recipe]);

  return (
    <li className="rounded-sm border border-line bg-panel-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2.5 py-2">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="flex min-w-0 shrink items-center gap-1.5 text-left"
        >
          <Chevron open={open} />
          <span className="truncate text-sm font-medium">{recipe.genre}</span>
        </button>
        <span className="font-mono text-[10px] text-muted/70">
          {min === max ? `${min} parts` : `${min}–${max} parts`}
        </span>
        <span className="ml-auto flex items-center gap-1.5">
          {confirming ? (
            <>
              <span className="text-[11px] text-audio">forget? the next band rewrites it</span>
              <button
                type="button"
                disabled={busy}
                onClick={onDelete}
                className="rounded-sm border border-audio/60 px-2 py-0.5 text-[11px] font-medium text-audio disabled:cursor-not-allowed disabled:opacity-40"
              >
                confirm
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

      <div className="flex flex-col gap-1 px-2.5 pb-2">
        {!open && (
          <div className="flex flex-wrap items-center gap-1">
            {recipe.core.map((role, i) => (
              <RoleChip key={`${role}-${i}`} role={role} core />
            ))}
            {recipe.optional.length > 0 ? (
              <span className="font-mono text-[10px] text-muted/60">+{recipe.optional.length} optional</span>
            ) : null}
          </div>
        )}
        <Sample names={sample} clamp={open ? undefined : 6} />
      </div>

      {open ? <Detail recipe={recipe} /> : null}
    </li>
  );
}

/** A band this recipe actually makes. The headline, in both states. */
function Sample({ names, clamp }: { names: string[]; clamp?: number }) {
  if (names.length === 0) return null;
  const shown = clamp ? names.slice(0, clamp) : names;
  return (
    <p className="text-[11px] leading-snug text-muted">
      <span className="font-mono text-[10px] uppercase tracking-wider text-muted/50">e.g. </span>
      <span className="text-foreground/80">{shown.join(" · ")}</span>
      {shown.length < names.length ? <span className="text-muted/50"> +{names.length - shown.length}</span> : null}
    </p>
  );
}

function Detail({ recipe }: { recipe: BandRecipe }) {
  const roles = recipeRoles(recipe);
  const heaviest = Math.max(...recipe.optional.map((o) => o.weight), 1);
  return (
    <div className="flex flex-col gap-3 border-t border-line px-2.5 py-2.5">
      <section className="flex flex-col gap-1.5">
        <Label>core · track order</Label>
        <div className="flex flex-wrap items-center gap-1">
          {recipe.core.map((role, i) => (
            <RoleChip key={`${role}-${i}`} role={role} core position={i + 1} />
          ))}
        </div>
      </section>

      {recipe.optional.length > 0 ? (
        <section className="flex flex-col gap-1">
          <Label>optional · drawn by weight</Label>
          <ul className="flex flex-col gap-0.5">
            {recipe.optional.map((entry, i) => (
              <li key={`${entry.role}-${i}`} className="flex items-center gap-2">
                <span className="w-24 shrink-0 truncate font-mono text-[11px] text-muted">{entry.role}</span>
                <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-sm bg-line">
                  <span
                    className="block h-full rounded-sm bg-accent/50"
                    style={{ width: `${Math.round((entry.weight / heaviest) * 100)}%` }}
                  />
                </span>
                <span className="w-8 shrink-0 text-right font-mono text-[10px] text-muted/60">{entry.weight}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="flex flex-col gap-1.5">
        <Label>who can play each part</Label>
        <ul className="flex flex-col gap-1">
          {roles.map((role) => (
            <RoleRow key={role} recipe={recipe} role={role} />
          ))}
        </ul>
      </section>
    </div>
  );
}

/**
 * One role's bench. Names are the scannable half — "skank chop", "talking drum"
 * — so they show as chips; the briefs behind them are one click away, because
 * that is a debugging question and there are a hundred-odd of them per page.
 */
function RoleRow({ recipe, role }: { recipe: BandRecipe; role: string }) {
  const [open, setOpen] = useState(false);
  const names = recipe.names[role] ?? [];
  const briefs = recipe.briefs[role] ?? [];
  const anchor = recipe.anchors[role];
  /** Where the core's reach ends: names past this one are only ever extra parts. */
  const split = anchor !== undefined && anchor < names.length ? anchor : null;

  return (
    <li className="rounded-sm border border-line/60">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-1.5 py-1 text-left"
      >
        <Chevron open={open} />
        <span className="w-20 shrink-0 truncate font-mono text-[11px] text-foreground">{role}</span>
        {open ? (
          <span className="font-mono text-[10px] text-muted/60">
            {names.length} {names.length === 1 ? "name" : "names"}
            {split !== null ? ` · core picks from the first ${split}` : ""}
          </span>
        ) : (
          <span className="min-w-0 flex-1 truncate text-[11px] text-muted">{names.join(" · ")}</span>
        )}
      </button>

      {open ? (
        <ul className="flex flex-col gap-1 px-1.5 pb-1.5">
          {names.map((name, i) => (
            <li key={`${name}-${i}`} className="flex flex-col gap-0.5">
              {split !== null && i === split ? (
                <span className="mt-1 font-mono text-[10px] uppercase tracking-wider text-muted/40">
                  — extra parts only —
                </span>
              ) : null}
              <span className={`font-mono text-[11px] ${split !== null && i < split ? "text-accent" : "text-foreground"}`}>
                {name}
              </span>
              <span className="max-w-[65ch] pl-2 text-[11px] leading-relaxed text-muted">
                {briefs[i % Math.max(briefs.length, 1)] ?? "—"}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function Label({ children }: { children: ReactNode }) {
  return <span className="text-[10px] uppercase tracking-wider text-muted">{children}</span>;
}

function RoleChip({ role, core, position }: { role: string; core?: boolean; position?: number }) {
  return (
    <span
      className={
        core
          ? "rounded-sm border border-accent/60 px-1.5 py-0.5 font-mono text-[10px] text-accent"
          : "rounded-sm border border-line px-1.5 py-0.5 font-mono text-[10px] text-muted"
      }
    >
      {position !== undefined ? <span className="text-accent/50">{position} </span> : null}
      {role}
    </span>
  );
}

/** Full class strings only — Tailwind cannot see interpolated names. */
const CHEVRON_CLASS = {
  open: "shrink-0 rotate-90 text-muted transition-transform",
  shut: "shrink-0 text-muted transition-transform",
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
