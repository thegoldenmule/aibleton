import type { RecipeDraft } from "./types.ts";

const MAX_PLAYERS = 6;
/** A slug of role plus name must fit the part id shape, so a name has this much room at most. */
const MAX_NAME_LENGTH = 24;

/**
 * Turn the model's recipe JSON (arrays of players per role) into the recipe
 * shape (parallel names/briefs per role), repairing what the schema cannot
 * enforce: roles without players are dropped, weights clamped positive,
 * duplicate optional roles merged, names deduplicated and shortened.
 * @throws when nothing usable remains (no core role with players).
 */
export function normalizeRecipe(raw: unknown): RecipeDraft {
  if (!isRecord(raw)) throw new Error("recipe was not an object");

  const names: Record<string, string[]> = {};
  const briefs: Record<string, string[]> = {};
  for (const entry of asArray(raw.roles)) {
    if (!isRecord(entry)) continue;
    const role = roleWord(entry.role);
    if (!role) continue;
    const seen = new Set<string>();
    const roleNames = names[role] ?? [];
    const roleBriefs = briefs[role] ?? [];
    for (const player of asArray(entry.players)) {
      if (!isRecord(player)) continue;
      const name = text(player.name).slice(0, MAX_NAME_LENGTH).trim();
      const brief = text(player.brief);
      if (!name || !brief || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      roleNames.push(name);
      roleBriefs.push(brief);
      if (roleNames.length === MAX_PLAYERS) break;
    }
    if (roleNames.length > 0) {
      names[role] = roleNames;
      briefs[role] = roleBriefs;
    }
  }

  const core = asArray(raw.core)
    .map(roleWord)
    .filter((role): role is string => role !== null && role in names);
  if (core.length === 0) throw new Error("recipe has no core role with players");

  const optionalWeights = new Map<string, number>();
  for (const entry of asArray(raw.optional)) {
    if (!isRecord(entry)) continue;
    const role = roleWord(entry.role);
    if (!role || !(role in names)) continue;
    const weight = typeof entry.weight === "number" && Number.isFinite(entry.weight) && entry.weight > 0 ? entry.weight : 1;
    optionalWeights.set(role, Math.max(optionalWeights.get(role) ?? 0, weight));
  }
  const optional = [...optionalWeights].map(([role, weight]) => ({ role, weight }));

  const coreCounts = new Map<string, number>();
  for (const role of core) coreCounts.set(role, (coreCounts.get(role) ?? 0) + 1);
  const anchors: Record<string, number> = {};
  for (const entry of asArray(raw.anchors)) {
    if (!isRecord(entry)) continue;
    const role = roleWord(entry.role);
    if (!role || !coreCounts.has(role) || typeof entry.count !== "number") continue;
    const pool = names[role]!.length;
    anchors[role] = Math.min(pool, Math.max(coreCounts.get(role)!, Math.round(entry.count)));
  }

  // A core role needs at least as many players as it repeats.
  for (const [role, count] of coreCounts) {
    if (names[role]!.length < count) throw new Error(`core role ${JSON.stringify(role)} repeats ${count} times but has ${names[role]!.length} players`);
  }

  return { core, optional, names, briefs, anchors };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function text(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** Roles are lowercase words: "Lead Guitar" -> "lead-guitar". */
function roleWord(v: unknown): string | null {
  const t = text(v).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return t || null;
}
