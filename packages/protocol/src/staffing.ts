import type { BandPart, BandRecipe } from "./bands.ts";
import { mulberry32 } from "./rng.ts";

/**
 * Staffing a band from a recipe: the one deterministic roll, shared.
 *
 * It lives here rather than in mate because both sides run it. Mate staffs the
 * bands it saves; the app rolls one per recipe to show what a genre actually
 * produces, which is a question no amount of the recipe's own prose answers.
 * Pure and synchronous, so the app can call it during a render.
 */

/**
 * Looks a recipe up by genre, and says which genres it has. `RecipeBook` is the
 * real one; tests pass a fixture map with a `genres` of its own.
 *
 * Both are synchronous because `generateBand` is: mate ships no recipes, so
 * everything here comes off a library whose log has already been replayed, and
 * filling a gap is the caller's job before it gets this far. `oneRecipe` is the
 * trivial implementation, for a caller that already holds the one it means.
 */
export interface RecipeLookup {
  get(genre: string): BandRecipe | undefined;
  /** Every genre on hand, in a stable order — what an omitted genre is drawn from. */
  genres(): readonly string[];
}

/** A lookup over exactly one recipe: what the app has when it renders a genre. */
export function oneRecipe(recipe: BandRecipe): RecipeLookup {
  return { get: (genre) => (genre === recipe.id ? recipe : undefined), genres: () => [recipe.id] };
}

export interface GenerateBandOptions {
  /** Any integer. Same seed + options => identical band. */
  seed: number;
  /** Omit to let the seed draw one of the genres `recipes` holds. Otherwise any genre it knows. */
  genre?: string;
  /** Total parts. Clamped to what the genre recipe can staff. */
  size?: number;
}

/** Part ids are slugs: `/^[a-z0-9][a-z0-9-]{0,31}$/`, so at most this many characters. */
const MAX_ID_LENGTH = 32;

function requireInt(value: number, name: string, min: number, max?: number): void {
  if (!Number.isInteger(value)) throw new Error(`${name} must be a whole number, got ${value}`);
  if (value < min) throw new Error(`${name} must be at least ${min}, got ${value}`);
  if (max !== undefined && value > max) throw new Error(`${name} must be at most ${max}, got ${value}`);
}

/** Lowercase, non-alphanumerics collapsed to single dashes, no dashes on either end. */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
}

/** Cuts a slug to `length` without leaving a trailing dash. */
function clip(slug: string, length: number): string {
  return slug.slice(0, Math.max(1, length)).replace(/-+$/, "");
}

/**
 * A stable slug id for one part, e.g. `keys-rhodes`. Collisions (two parts whose
 * role and name slug the same way) take a numeric suffix, and the base is cut
 * short enough that the suffixed id still fits the 32-character shape.
 */
export function partId(role: string, name: string, taken: Set<string>): string {
  const base = slugify(`${role}-${name}`) || slugify(role) || "part";
  let id = clip(base, MAX_ID_LENGTH);
  for (let n = 2; taken.has(id); n++) {
    const suffix = `-${n}`;
    id = `${clip(base, MAX_ID_LENGTH - suffix.length)}${suffix}`;
  }
  taken.add(id);
  return id;
}

/** Picks `count` roles from `optional` by weight, without replacement, in pick order. */
function pickOptional(optional: BandRecipe["optional"], count: number, rng: () => number): string[] {
  const pool = [...optional];
  const picked: string[] = [];
  for (let i = 0; i < count && pool.length > 0; i++) {
    const total = pool.reduce((n, entry) => n + entry.weight, 0);
    let index = pool.length - 1;
    let roll = rng() * total;
    for (let j = 0; j < pool.length; j++) {
      roll -= pool[j]!.weight;
      if (roll < 0) {
        index = j;
        break;
      }
    }
    picked.push(pool[index]!.role);
    pool.splice(index, 1);
  }
  return picked;
}

/**
 * Staff a band for a genre from a seed.
 *
 * Core roles are always present, in recipe order, before any optionals; the
 * optionals are drawn by weight without replacement. Each part takes an unused
 * name from its role's pool — so two keys players read "Rhodes" and "clav",
 * never "keys 1" and "keys 2" — and the brief paired with that name. A core
 * slot draws only from the head of the pool (`anchors`), so the band's one
 * guitar is always a rhythm guitar and the lead only appears alongside it.
 *
 * The seeded part count is always drawn, even when `size` is given, so
 * `{ seed, size: n }` is byte-identical to `{ seed }` whenever the seed picked
 * `n` on its own. Same for `genre`.
 *
 * Returns the parts and the metadata only; the caller supplies `id`, `name` and
 * `createdAt`, the way `defaultSections` leaves those to the route.
 * `emphasis` is left unset — that field is reserved and nothing reads it.
 *
 * @throws if the seed is not a whole number, `size` is below 1, `recipes` is
 * empty, or it has no recipe for the genre.
 */
export function generateBand(opts: GenerateBandOptions, recipes: RecipeLookup): { parts: BandPart[]; metadata: Record<string, string> } {
  if (!Number.isInteger(opts.seed)) throw new Error(`seed must be a whole number, got ${opts.seed}`);
  if (opts.size !== undefined) requireInt(opts.size, "size", 1);

  const rng = mulberry32(opts.seed);

  // Always drawn, so an explicit genre that matches the seeded one changes
  // nothing. The pool is the library rather than a shipped list, so the draw is
  // stable for a given set of recipes and not across installs — writing a new
  // recipe changes what an omitted genre resolves to for every seed.
  const known = recipes.genres();
  if (known.length === 0) throw new Error("no recipes yet — name a genre so one can be written");
  const seededGenre = known[Math.floor(rng() * known.length) % known.length]!;
  const recipe = opts.genre !== undefined ? recipes.get(opts.genre) : recipes.get(seededGenre);
  if (!recipe) throw new Error(`no recipe for genre ${JSON.stringify(opts.genre ?? seededGenre)}`);
  const genre = recipe.genre;

  const min = recipe.core.length;
  const max = min + recipe.optional.length;
  // Average of two rolls: a triangular pull towards a mid-sized band, so an
  // omitted `size` is neither always the minimum nor always the full roster.
  const seededSize = min + Math.round(((rng() + rng()) / 2) * recipe.optional.length);
  const size = Math.min(max, Math.max(min, opts.size ?? seededSize));

  const roles: string[] = [...recipe.core, ...pickOptional(recipe.optional, size - min, rng)];

  const coreCounts = new Map<string, number>();
  for (const role of recipe.core) coreCounts.set(role, (coreCounts.get(role) ?? 0) + 1);

  const usedNames = new Map<string, Set<number>>();
  const takenIds = new Set<string>();
  const parts: BandPart[] = [];

  for (const [position, role] of roles.entries()) {
    const namePool = recipe.names[role] ?? [role];
    const briefPool = recipe.briefs[role] ?? [`${role} for a ${genre} track`];
    const used = usedNames.get(role) ?? new Set<number>();
    usedNames.set(role, used);

    // Core slots see only the archetypes at the head of the pool; optionals see
    // all of it. The window is never narrower than the role's core multiplicity,
    // so every core slot has a name left to take.
    const anchor = Math.max(recipe.anchors[role] ?? 0, coreCounts.get(role) ?? 0);
    const window = position < recipe.core.length ? Math.min(namePool.length, anchor) : namePool.length;

    const free: number[] = [];
    for (let i = 0; i < window; i++) if (!used.has(i)) free.push(i);

    // A window with no slack is taken in pool order, so metal's two core
    // guitars come out as the down-tuned one and then its double, in that order.
    const inOrder = position < recipe.core.length && window <= (coreCounts.get(role) ?? 0);

    let name: string;
    let index: number;
    if (free.length > 0) {
      index = inOrder ? free[0]! : free[Math.floor(rng() * free.length) % free.length]!;
      used.add(index);
      name = namePool[index]!;
    } else {
      // Pool exhausted: cycle it with a numeric suffix so names still differ.
      index = used.size % namePool.length;
      name = `${namePool[index]!} ${Math.floor(used.size / namePool.length) + 1}`;
      used.add(used.size);
    }

    parts.push({
      id: partId(role, name, takenIds),
      role,
      name,
      brief: briefPool[index % briefPool.length]!,
    });
  }

  return { parts, metadata: { genre } };
}
