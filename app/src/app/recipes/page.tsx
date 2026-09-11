"use client";

import { useState } from "react";
import { recipeRoles, type BandRecipe } from "@aibleton/protocol";
import { ErrorNote } from "../../components/ui/ErrorNote";
import { PanelHeader } from "../../components/ui/PanelHeader";
import { WorkspacePanel } from "../../components/WorkspacePanel";
import { useRecipes } from "../../lib/useRecipes";

/**
 * How each genre staffs a band: who is always in the room, who might be, and
 * what each of them is asked to sound like.
 *
 * Read-only but for the delete. Mate ships no recipes and nothing on this page
 * writes one — a recipe appears because something asked for a band in a genre
 * mate had none for, so the list grows while you are looking at it. There is no
 * generator section for that reason; the bands page is where you ask.
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
    <WorkspacePanel title="recipes" meta={loading ? "loading…" : `${recipes.length} ${recipes.length === 1 ? "genre" : "genres"}`}>
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
        <ul className="flex flex-col gap-2">
          {recipes.map((recipe) => (
            <li key={recipe.id} className="flex flex-col gap-2.5 rounded-sm border border-line bg-panel-2 p-2.5">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="text-sm font-medium">{recipe.genre}</span>
                <span className="font-mono text-[10px] text-muted/70">
                  {recipe.core.length} core · {recipe.optional.length} optional · written{" "}
                  {new Date(recipe.createdAt).toLocaleString()}
                </span>
                <span className="ml-auto flex items-center gap-1.5">
                  {confirmId === recipe.id ? (
                    <>
                      <span className="text-[11px] text-audio">forget? the next band rewrites it</span>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void destroy(recipe.id)}
                        className="rounded-sm border border-audio/60 px-2 py-0.5 text-[11px] font-medium text-audio disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        confirm
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmId(null)}
                        className="rounded-sm border border-line px-2 py-0.5 text-[11px] text-muted"
                      >
                        cancel
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setConfirmId(recipe.id)}
                      className="rounded-sm border border-line px-2 py-0.5 text-[11px] text-muted hover:text-audio disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      forget
                    </button>
                  )}
                </span>
              </div>

              <Lineup recipe={recipe} />
              <Players recipe={recipe} />
            </li>
          ))}
        </ul>
      )}
    </WorkspacePanel>
  );
}

/**
 * Who is in the room. Core first and in order — that order is the track order
 * in Ableton — then the optionals with the weight each is drawn by. A role can
 * appear twice in either list, so these are positions, not a set.
 */
function Lineup({ recipe }: { recipe: BandRecipe }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="w-16 shrink-0 text-[10px] uppercase tracking-wider text-muted">core</span>
        {recipe.core.map((role, i) => (
          <span
            key={`${role}-${i}`}
            className="rounded-sm border border-accent/60 px-1.5 py-0.5 font-mono text-[10px] text-accent"
          >
            {i + 1} {role}
          </span>
        ))}
      </div>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="w-16 shrink-0 text-[10px] uppercase tracking-wider text-muted">optional</span>
        {recipe.optional.length === 0 ? (
          <span className="text-[11px] text-muted/60">none — the core is the whole band</span>
        ) : (
          recipe.optional.map((entry, i) => (
            <span
              key={`${entry.role}-${i}`}
              className="rounded-sm border border-line px-1.5 py-0.5 font-mono text-[10px] text-muted"
            >
              {entry.role} <span className="text-muted/60">×{entry.weight}</span>
            </span>
          ))
        )}
      </div>
    </div>
  );
}

/**
 * The names and briefs, per role, paired by index the way the recipe pairs
 * them: the brief on a row is the one that part is searched on Splice with.
 * An anchored role says how far down its own list a core slot may reach.
 */
function Players({ recipe }: { recipe: BandRecipe }) {
  const roles = recipeRoles(recipe);
  return (
    <div className="flex flex-col gap-2 border-t border-line pt-2">
      {roles.map((role) => {
        const names = recipe.names[role] ?? [];
        const briefs = recipe.briefs[role] ?? [];
        const anchor = recipe.anchors[role];
        return (
          <div key={role} className="flex flex-col gap-1">
            <PanelHeader
              title={role}
              level={3}
              meta={anchor === undefined ? undefined : `core draws from the first ${anchor}`}
            />
            <ul className="flex flex-col gap-1">
              {names.map((name, i) => (
                <li key={`${name}-${i}`} className="flex flex-wrap items-baseline gap-x-2">
                  <span
                    className={`font-mono text-[11px] ${anchor !== undefined && i < anchor ? "text-accent" : "text-foreground"}`}
                  >
                    {name}
                  </span>
                  <span className="min-w-0 flex-1 text-[11px] leading-snug text-muted">
                    {briefs[i % Math.max(briefs.length, 1)] ?? "—"}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
