import { GENRES } from "@aibleton/protocol";
import type { BandPart, Genre, Role } from "@aibleton/protocol";

/**
 * How one genre staffs a band.
 *
 * `names` and `briefs` are parallel per role: the brief at index `i` describes
 * the instrument named at index `i`, so a "clav" never gets told to swirl its
 * drawbars. Where the arrays differ in length the brief index wraps.
 */
export interface BandRecipe {
  /** Always staffed, in this order — this is the track order in Ableton. A role may repeat (metal has two guitars). */
  core: Role[];
  /** Drawn by weight, without replacement, until `size` is met. A role may repeat a core role. */
  optional: { role: Role; weight: number }[];
  /** Display names per role, drawn without replacement so duplicate roles read differently. */
  names: Partial<Record<Role, string[]>>;
  /** Splice prompt text per role, paired by index with `names`. */
  briefs: Partial<Record<Role, string[]>>;
  /**
   * How many leading `names` entries a *core* slot may be drawn from, per role.
   * Pools are ordered archetype-first, so a rock band's one guitar is the rhythm
   * guitar and the lead only turns up as a second one. Defaults to the role's
   * core multiplicity; widen it where every head-of-pool name is equally
   * foundational (any of the three funk kits will do).
   */
  anchors?: Partial<Record<Role, number>>;
}

export interface GenerateBandOptions {
  /** Any integer. Same seed + options => identical band. */
  seed: number;
  /** Omit to let the seed pick one from GENRES. */
  genre?: Genre;
  /** Total parts. Clamped to what the genre recipe can staff. */
  size?: number;
}

/** Part ids are slugs: `/^[a-z0-9][a-z0-9-]{0,31}$/`, so at most this many characters. */
const MAX_ID_LENGTH = 32;

/** mulberry32: tiny, fast, good enough for band shapes. Pure — no `Math.random()`. */
function mulberry32(seed: number): () => number {
  let a = (seed | 0) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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
function partId(role: string, name: string, taken: Set<string>): string {
  const base = slugify(`${role}-${name}`) || slugify(role) || "part";
  let id = clip(base, MAX_ID_LENGTH);
  for (let n = 2; taken.has(id); n++) {
    const suffix = `-${n}`;
    id = `${clip(base, MAX_ID_LENGTH - suffix.length)}${suffix}`;
  }
  taken.add(id);
  return id;
}

/**
 * The recipe table: who plays in each genre, what they are called and how they
 * are asked to sound. This is data — `generateBand` has no per-genre branches.
 */
export const RECIPES: Record<Genre, BandRecipe> = {
  funk: {
    core: ["drums", "bass", "guitar", "keys"],
    anchors: { drums: 3, bass: 3, guitar: 3, keys: 3 },
    optional: [
      { role: "horns", weight: 4 },
      { role: "percussion", weight: 3.5 },
      { role: "keys", weight: 2.5 },
      { role: "vocals", weight: 2 },
      { role: "guitar", weight: 1.5 },
      { role: "synth", weight: 1.2 },
      { role: "fx", weight: 1 },
    ],
    names: {
      drums: ["breakbeat kit", "tight funk kit", "loose live kit"],
      bass: ["P-bass", "slap bass", "Mu-tron bass"],
      guitar: ["chicken-scratch guitar", "wah rhythm guitar", "clean single-coil comping"],
      keys: ["Rhodes", "clav", "Hammond B3", "Wurlitzer"],
      horns: ["horn section stabs", "baritone sax", "muted trumpet"],
      percussion: ["congas", "tambourine", "cowbell and shaker"],
      vocals: ["lead vocal ad-libs", "call-and-response backing vocals"],
      synth: ["Moog lead", "ARP string synth"],
      fx: ["tape delay throws", "phaser sweeps"],
    },
    briefs: {
      drums: [
        "dry breakbeat, heavy ghost notes on the snare",
        "tight sixteenth-note hats and a fat backbeat, almost no room on the kit",
        "loose live kit pushing and pulling against the click, open hats on the upbeats",
      ],
      bass: [
        "fingered electric bass locked to the kick, short muted sixteenths",
        "slap and pop line with wide octave jumps and dead notes for percussion",
        "envelope-filtered bass, wet quacking attack on every downbeat",
      ],
      guitar: [
        "muted sixteenth-note scratching, all treble, no sustain",
        "wah-pedal chops on the offbeats, thin and nasal",
        "clean ninth chords stabbed on the one and left to ring",
      ],
      keys: [
        "warm tine electric piano, sustained ninth chords under the groove",
        "percussive staccato sixteenths with a wah on the clavinet",
        "drawbar organ swells on a slow rotary, filling the gaps between stabs",
        "gritty reed electric piano with tremolo on, chunky triads on the backbeat",
      ],
      horns: [
        "tight three-piece horn stabs, punchy and short, answering the vocal",
        "honking baritone sax riff doubling the bass line",
        "muted trumpet curling around the top of the groove",
      ],
      percussion: [
        "congas riding the sixteenths, open tones on the offbeats",
        "tambourine on every backbeat, dry and close-miked",
        "cowbell on the quarters with a shaker filling the gaps",
      ],
      vocals: [
        "shouted ad-libs and grunts over the turnaround, no full verse",
        "group answers to the lead, tight harmony on short phrases",
      ],
      synth: [
        "fat monosynth lead, resonant filter sweeping across the phrase",
        "chorused analog string pad holding the changes",
      ],
      fx: [
        "quarter-note tape delay thrown on the last word of each phrase",
        "slow phaser sweeping over the whole band, one cycle every eight bars",
      ],
    },
  },
  jazz: {
    core: ["drums", "bass", "keys"],
    anchors: { drums: 3, bass: 2, keys: 3 },
    optional: [
      { role: "horns", weight: 5 },
      { role: "guitar", weight: 3 },
      { role: "horns", weight: 2.5 },
      { role: "vocals", weight: 2 },
      { role: "percussion", weight: 1.5 },
      { role: "strings", weight: 1 },
    ],
    names: {
      drums: ["brushed kit", "ride-led bop kit", "small dry kit"],
      bass: ["upright bass", "walking bass", "arco upright"],
      keys: ["grand piano", "Hammond organ", "Rhodes"],
      horns: ["tenor sax", "muted trumpet", "trombone", "alto sax", "flugelhorn"],
      guitar: ["hollowbody comping", "octave lead guitar"],
      vocals: ["scat vocal", "smoky lead vocal"],
      percussion: ["shaker and triangle", "congas"],
      strings: ["string quartet pad", "cello counterline"],
    },
    briefs: {
      drums: [
        "brushes swirling on the snare, feathered kick, no backbeat at all",
        "ride cymbal carrying the time while the snare and kick comp underneath",
        "small tuned-up kit, hats on two and four, quiet and dry",
      ],
      bass: [
        "woody upright walking in quarter notes, string buzz left in",
        "walking line with chromatic approach notes into every chord",
        "bowed upright holding long tones under the changes",
      ],
      keys: [
        "sparse rootless voicings comped behind the soloist",
        "drawbar organ with the bass pedals walking, slow rotary",
        "dark reverbed electric piano block chords",
      ],
      horns: [
        "breathy tenor lines behind the beat, plenty of air in the tone",
        "cup-muted trumpet stating the head, dry and close",
        "trombone counter-line under the melody, smearing into the notes",
        "bright alto phrases, fast bebop runs over the changes",
        "round flugelhorn melody, soft attack, no vibrato",
      ],
      guitar: [
        "archtop comping four to the bar, tone rolled off, no sustain",
        "thumb-picked octave melody lines, soft and warm",
      ],
      vocals: [
        "wordless scat trading phrases with the horn",
        "close-miked lead dragging lazily behind the beat",
      ],
      percussion: [
        "light shaker on the swung eighths with a triangle at the phrase ends",
        "hand drums under the ride, latin feel through the a-section",
      ],
      strings: [
        "muted quartet sustaining the changes behind the head",
        "cello moving in contrary motion to the bass",
      ],
    },
  },
  rock: {
    core: ["drums", "bass", "guitar"],
    anchors: { drums: 3, bass: 3 },
    optional: [
      { role: "guitar", weight: 5 },
      { role: "vocals", weight: 4.5 },
      { role: "keys", weight: 2.5 },
      { role: "percussion", weight: 1.5 },
      { role: "guitar", weight: 1.2 },
      { role: "fx", weight: 1 },
    ],
    names: {
      drums: ["big room kit", "dry close-miked kit", "stadium kit"],
      bass: ["P-bass with a pick", "fuzz bass", "Rickenbacker bass"],
      guitar: ["rhythm guitar", "lead guitar", "acoustic strums", "jangly twelve-string"],
      keys: ["Hammond organ", "upright piano", "Mellotron"],
      vocals: ["lead vocal", "gang backing vocals"],
      percussion: ["tambourine", "shaker"],
      fx: ["riser and impact", "feedback swells"],
    },
    briefs: {
      drums: [
        "hard backbeat with the room mics up, a crash on every section change",
        "tight dead kit, tape-compressed, eighth notes on the hats",
        "huge gated snare and toms, slow and heavy",
      ],
      bass: [
        "picked eighth notes riding the root, bright attack",
        "distorted bass doubling the guitar riff an octave down",
        "clanky midrange bass playing melodic fills between the riffs",
      ],
      guitar: [
        "overdriven power chords, palm-muted in the verse and open in the chorus",
        "cutting single-note lead over the top, bends and heavy vibrato",
        "strummed steel-string filling the middle out, no distortion",
        "chiming arpeggios with all the high end up and a chorus pedal on",
      ],
      keys: [
        "organ pad under the chorus, leslie speeding up into the last one",
        "hammered eighth-note piano chords, slightly out of tune",
        "wobbly tape-flute pad, lo-fi, shadowing the vocal melody",
      ],
      vocals: [
        "raw front-of-the-band lead, pushed into the mic on the chorus",
        "shouted group vocals on the hook, doubled and wide",
      ],
      percussion: [
        "tambourine on the backbeat, choruses only",
        "shaker holding eighth notes under the verses",
      ],
      fx: [
        "noise riser into each chorus with an impact on the downbeat",
        "controlled amp feedback swelling over the last chord",
      ],
    },
  },
  metal: {
    core: ["drums", "bass", "guitar", "guitar"],
    anchors: { drums: 3, bass: 2 },
    optional: [
      { role: "vocals", weight: 5 },
      { role: "synth", weight: 2.5 },
      { role: "guitar", weight: 2 },
      { role: "fx", weight: 2 },
      { role: "keys", weight: 1.5 },
      { role: "strings", weight: 1 },
    ],
    names: {
      drums: ["double-kick kit", "blast-beat kit", "trigger-tight kit"],
      bass: ["distorted pick bass", "growling five-string"],
      guitar: ["down-tuned rhythm guitar", "doubled rhythm guitar", "lead guitar", "harmonized twin lead"],
      vocals: ["screamed lead vocal", "clean chorus vocal"],
      synth: ["dark analog pad", "orchestral hit stack"],
      fx: ["riser and impact hits", "reverse cymbal swells"],
      keys: ["church organ", "gothic piano"],
      strings: ["cinematic string section"],
    },
    briefs: {
      drums: [
        "relentless double kick under the riff, china cymbal on the accents",
        "blast beats through the verse dropping to half time for the chorus",
        "triggered clicky kick and cracking snare, tight and gridded",
      ],
      bass: [
        "picked bass following the riff note for note, heavy grit in the mids",
        "low-B chugs, distorted and sitting just under the guitars",
      ],
      guitar: [
        "palm-muted chugs on the low string, tight gate, hard left",
        "the same riff tracked again and panned hard right for width",
        "shredding lead over the riff, pinch harmonics and fast runs",
        "two leads in thirds held long over the breakdown",
      ],
      vocals: [
        "throat-shredding screams, short barked phrases on the riff accents",
        "soaring clean melody over the chorus, doubled and wide",
      ],
      synth: [
        "low ominous pad filling under the guitars, no top end",
        "stabbed orchestral hits landing on the riff accents",
      ],
      fx: [
        "long riser into the breakdown with a deep impact on the drop",
        "reversed cymbals pulling into every section change",
      ],
      keys: [
        "full pipe organ doubling the riff, cathedral reverb",
        "cold single-note piano motif over the intro, drenched in reverb",
      ],
      strings: ["staccato low strings tracking the riff rhythm, no vibrato"],
    },
  },
  house: {
    core: ["drums", "bass", "synth"],
    anchors: { drums: 3, bass: 3, synth: 3 },
    optional: [
      { role: "keys", weight: 4 },
      { role: "vocals", weight: 3.5 },
      { role: "percussion", weight: 3 },
      { role: "fx", weight: 2.5 },
      { role: "synth", weight: 2 },
      { role: "guitar", weight: 1 },
    ],
    names: {
      drums: ["909 kit", "swung house kit", "clap-led 707"],
      bass: ["deep sub bass", "filtered Moog bass", "rolling analog bass"],
      synth: ["stab chords", "supersaw lead", "filtered pluck"],
      keys: ["Rhodes chords", "Juno pad", "house piano"],
      vocals: ["chopped vocal hook", "soulful topline"],
      percussion: ["shaker and rimshot", "congas", "open hat sixteenths"],
      fx: ["white-noise sweep", "filtered riser"],
      guitar: ["muted disco guitar"],
    },
    briefs: {
      drums: [
        "four-on-the-floor kick, open hat on every offbeat, clap on two and four",
        "shuffled hats with a swung sixteenth feel, kick straight underneath",
        "machine loop built around a big layered clap, hats rolled off",
      ],
      bass: [
        "round sub tone on the offbeats, one note a bar, no attack",
        "resonant filter sweeping slowly open across sixteen bars",
        "rolling sixteenth-note bassline, short and plucky, ducking under the kick",
      ],
      synth: [
        "short organ-ish chord stabs on the offbeats, drenched in reverb",
        "wide detuned lead riding the drop, sidechained hard to the kick",
        "plucky filtered arpeggio with a dotted-eighth delay behind it",
      ],
      keys: [
        "lazy electric piano chords, swung and slightly behind the grid",
        "warm chorused pad holding the chords through the breakdown",
        "bright piano chords hammering the offbeats, loud and classic",
      ],
      vocals: [
        "one phrase chopped and retriggered on the offbeats, heavily filtered",
        "full sung topline over the chorus, wide and reverbed",
      ],
      percussion: [
        "shaker on the sixteenths with rim clicks answering the clap",
        "hand drums rolling under the drop, latin-house flavour",
        "extra open hats filling the second half of every bar",
      ],
      fx: [
        "noise sweep rising over eight bars into the drop",
        "the whole loop high-passed and swept back open across the breakdown",
      ],
      guitar: ["muted sixteenth chops, thin and filtered, buried in the mix"],
    },
  },
  hiphop: {
    core: ["drums", "bass", "keys"],
    anchors: { drums: 3, bass: 3, keys: 3 },
    optional: [
      { role: "vocals", weight: 5 },
      { role: "synth", weight: 3 },
      { role: "fx", weight: 2.5 },
      { role: "percussion", weight: 2 },
      { role: "horns", weight: 1.5 },
      { role: "guitar", weight: 1.5 },
      { role: "strings", weight: 1 },
    ],
    names: {
      drums: ["dusty boom-bap kit", "808 kit", "trap hats and sub kick"],
      bass: ["808 sub", "sampled upright", "sine sub bass"],
      keys: ["dusty Rhodes loop", "detuned upright piano", "soul organ chop"],
      vocals: ["rap lead vocal", "chopped vocal sample"],
      synth: ["detuned lead", "warped pad"],
      fx: ["vinyl crackle bed", "tape stop and reverse"],
      percussion: ["shaker", "rim clicks and tambourine"],
      horns: ["muted trumpet sample", "soul horn stab"],
      guitar: ["filtered soul guitar loop"],
      strings: ["chopped string sample"],
    },
    briefs: {
      drums: [
        "sampled breakbeat, swung and filtered, snare cracking on two and four",
        "hard machine kick and a snappy clap, sparse and wide open",
        "rolling triplet hats over a long sub kick, half-time feel",
      ],
      bass: [
        "long gliding sub notes sliding between roots, distorted at the tail",
        "dusty upright loop walking under the beat, vinyl noise left in",
        "clean sine sub doubling the kick, no harmonics at all",
      ],
      keys: [
        "warm electric piano loop, filtered and slightly off-speed",
        "out-of-tune piano playing a two-bar motif with tape wobble on it",
        "chopped organ stab retriggered on the offbeat",
      ],
      vocals: [
        "dry conversational flow sitting right on top of the beat",
        "one sung phrase chopped into the hook and pitched down",
      ],
      synth: [
        "thin detuned lead riff repeating every two bars, heavy delay",
        "wobbling pad drifting in pitch, filling the low mids",
      ],
      fx: [
        "constant record noise and hiss under everything",
        "tape stop into the hook with a reversed cymbal on the way back in",
      ],
      percussion: [
        "loose shaker on the eighths, sitting behind the beat",
        "rim clicks and a dry tambourine filling the second bar",
      ],
      horns: [
        "a lonely muted trumpet phrase, filtered like an old record",
        "one horn stab landing on the downbeat of every four",
      ],
      guitar: ["clean guitar loop with a wah flavour, all the high end rolled off"],
      strings: ["lush string swell chopped to two bars and looped"],
    },
  },
  ambient: {
    core: ["synth", "fx"],
    anchors: { synth: 4, fx: 4 },
    optional: [
      { role: "strings", weight: 4 },
      { role: "keys", weight: 3.5 },
      { role: "bass", weight: 3 },
      { role: "synth", weight: 3 },
      { role: "guitar", weight: 2.5 },
      { role: "percussion", weight: 2 },
      { role: "vocals", weight: 2 },
      { role: "drums", weight: 1.2 },
    ],
    names: {
      synth: ["evolving pad", "drone layer", "granular texture", "bell arpeggio"],
      fx: ["field recording bed", "tape hiss and hum", "reversed reverb tails", "shimmer wash"],
      strings: ["bowed cello drone", "high string swell"],
      keys: ["felt piano", "prepared piano", "harmonium"],
      bass: ["sub drone", "soft sine bass"],
      guitar: ["ebow swells", "looped harmonics"],
      percussion: ["bowed cymbals", "sparse hand drum"],
      vocals: ["wordless vocal pad", "processed vocal fragments"],
      drums: ["distant brushed kit", "soft pulse kit"],
    },
    briefs: {
      synth: [
        "slow pad swelling in and out over sixteen bars, no rhythm at all",
        "one sustained drone, detuned oscillators beating against each other",
        "grains of a longer sample smeared into a shifting cloud",
        "soft bell tones arpeggiating slowly, long tails, almost no attack",
      ],
      fx: [
        "distant outdoor recording under everything, rain and room tone",
        "warm tape noise and mains hum, always there, never in front",
        "everything played backwards into a long reverb and back out again",
        "pitch-shifted reverb haze rising an octave above the pad",
      ],
      strings: [
        "cello held on one note, bow noise audible, very slow crescendo",
        "high strings swelling in every eight bars and fading away",
      ],
      keys: [
        "muted felt piano, a few notes a bar, hammers audible",
        "damped and buzzing piano notes, sparse and metallic",
        "reedy harmonium chords breathing in and out",
      ],
      bass: [
        "one low note held for the whole section, felt more than heard",
        "rounded bass moving once every four bars, no attack",
      ],
      guitar: [
        "bowed guitar tones fading in with no pick attack, long delay",
        "harmonics looped and layered until they blur together",
      ],
      percussion: [
        "cymbals bowed into a metallic wash, never struck",
        "one soft hand drum hit every couple of bars, unquantised",
      ],
      vocals: [
        "hummed choir tone stacked and stretched, no words",
        "syllables chopped and scattered wide with long reverb",
      ],
      drums: [
        "barely-there brushed kit far back in the room, no backbeat",
        "a soft muffled pulse on the quarters, almost a heartbeat",
      ],
    },
  },
  reggae: {
    core: ["drums", "bass", "guitar", "keys"],
    anchors: { drums: 3, bass: 2, keys: 3 },
    optional: [
      { role: "keys", weight: 4 },
      { role: "percussion", weight: 3.5 },
      { role: "horns", weight: 3 },
      { role: "vocals", weight: 3 },
      { role: "fx", weight: 2.5 },
      { role: "guitar", weight: 1.5 },
    ],
    names: {
      drums: ["one-drop kit", "rockers kit", "steppers kit"],
      bass: ["heavy round bass", "melodic dub bass"],
      guitar: ["skank guitar", "muted lead lines", "acoustic chops"],
      keys: ["organ bubble", "piano skank", "clav bubble", "melodica"],
      percussion: ["shaker and tambourine", "congas", "woodblock and cowbell"],
      horns: ["trombone line", "tenor sax counter-melody", "trumpet stabs"],
      vocals: ["toasted lead vocal", "harmony backing vocals"],
      fx: ["dub delay throws", "spring reverb splashes"],
    },
    briefs: {
      drums: [
        "one drop: nothing on the one, kick and rim landing together on three",
        "kick on every quarter with a cracking rim shot on three",
        "four-to-the-floor kick under a busy hi-hat, driving and steady",
      ],
      bass: [
        "deep round bass with the top rolled all the way off, a riff that repeats every two bars",
        "melodic bass leading the tune, wandering between the chords",
      ],
      guitar: [
        "short clean chops on every offbeat, spring reverb, no sustain",
        "single-note lines picked between the vocal phrases, thin and muted",
        "dry acoustic upstrokes doubling the skank an octave up",
      ],
      keys: [
        "the bubble: offbeat organ chords over a sixteenth-note shuffle",
        "hard piano chops on the offbeats doubling the guitar skank",
        "percussive clavinet bubble, thin and wiry, drenched in delay",
        "breathy melodica melody over the top, slightly out of tune",
      ],
      percussion: [
        "shaker on the eighths with a tambourine landing on three",
        "hand drums rolling through the turnaround, open tones on the offbeat",
        "woodblock and cowbell marking the offbeats, dry and close",
      ],
      horns: [
        "warm trombone playing the melody under the vocal, laid back",
        "tenor sax answering the vocal lines, breathy and loose",
        "short trumpet stabs on the offbeats of the turnaround",
      ],
      vocals: [
        "half-sung half-spoken lead riding the riddim, heavy delay on the phrase ends",
        "three-part harmony answers on the chorus, wide and soft",
      ],
      fx: [
        "tape delay thrown on the snare and the last word of each line, feeding back",
        "spring reverb crashed on the drum fills, springs left rattling",
      ],
    },
  },
};

/** Picks `count` roles from `optional` by weight, without replacement, in pick order. */
function pickOptional(optional: BandRecipe["optional"], count: number, rng: () => number): Role[] {
  const pool = [...optional];
  const picked: Role[] = [];
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
 * never "keys 1" and "keys 2" — and the brief paired with that name.
 *
 * The seeded part count is always drawn, even when `size` is given, so
 * `{ seed, size: n }` is byte-identical to `{ seed }` whenever the seed picked
 * `n` on its own. Same for `genre`.
 *
 * Returns the parts and the metadata only; the caller supplies `id`, `name` and
 * `createdAt`, the way `defaultSections` leaves those to the route.
 * `emphasis` is left unset — that field is reserved and nothing reads it.
 *
 * @throws if the seed is not a whole number, `size` is below 1, or the genre is unknown.
 */
export function generateBand(opts: GenerateBandOptions): { parts: BandPart[]; metadata: Record<string, string> } {
  if (!Number.isInteger(opts.seed)) throw new Error(`seed must be a whole number, got ${opts.seed}`);
  if (opts.size !== undefined) requireInt(opts.size, "size", 1);
  if (opts.genre !== undefined && !GENRES.includes(opts.genre)) {
    throw new Error(`genre ${JSON.stringify(opts.genre)} is not one of ${GENRES.join(", ")}`);
  }

  const rng = mulberry32(opts.seed);

  const seededGenre = GENRES[Math.floor(rng() * GENRES.length) % GENRES.length]!;
  const genre = opts.genre ?? seededGenre;
  const recipe = RECIPES[genre];

  const min = recipe.core.length;
  const max = min + recipe.optional.length;
  // Average of two rolls: a triangular pull towards a mid-sized band, so an
  // omitted `size` is neither always the minimum nor always the full roster.
  const seededSize = min + Math.round(((rng() + rng()) / 2) * recipe.optional.length);
  const size = Math.min(max, Math.max(min, opts.size ?? seededSize));

  const roles: Role[] = [...recipe.core, ...pickOptional(recipe.optional, size - min, rng)];

  const usedNames = new Map<Role, Set<number>>();
  const takenIds = new Set<string>();
  const parts: BandPart[] = [];

  for (const role of roles) {
    const namePool = recipe.names[role] ?? [role];
    const briefPool = recipe.briefs[role] ?? [`${role} for a ${genre} track`];
    const used = usedNames.get(role) ?? new Set<number>();
    usedNames.set(role, used);

    const free: number[] = [];
    for (let i = 0; i < namePool.length; i++) if (!used.has(i)) free.push(i);

    let name: string;
    let index: number;
    if (free.length > 0) {
      index = free[Math.floor(rng() * free.length) % free.length]!;
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
