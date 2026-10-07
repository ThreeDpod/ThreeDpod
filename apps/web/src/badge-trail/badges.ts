/**
 * The vocabulary and the colour of the badge trail.
 *
 * The words are all 3D modelling terms, which is not decoration: the trail sits on a page about
 * building scenes, and a stream of *nouns from that trade* reads as the machine thinking out
 * loud rather than as lorem ipsum with a tint applied.
 *
 * Colour is a walk rather than a list. Picking at random from a fixed palette puts two matching
 * badges next to each other about as often as not, and a trail whose neighbours match reads as
 * one smeared shape; stepping a fixed distance means consecutive badges can never be the same
 * colour. `COLORS` still exists because the static fallback has no walk to take — it renders
 * four badges once and wants four deliberately chosen, quiet ones.
 *
 * The whole ramp stays in warm paper tones — ambers, sands and one burnt orange — because the
 * page is white and a rainbow trail would be the loudest thing on it. Depth comes from
 * lightness, not hue: neighbours differ in how deep they are, never in what colour they are.
 */

export const WORDS = [
  "mesh",
  "vertex",
  "bevel",
  "extrude",
  "topology",
  "spline",
  "boolean",
  "chamfer",
  "normal",
  "lathe",
  "array",
  "gizmo",
  "viewport",
  "wireframe",
  "keyframe",
  "shader",
  "texture",
  "polygon",
  "subdivide",
  "sculpt",
  "retopo",
  "nurbs",
  "facet",
  "loft",
] as const;

export const COLORS = ["#ece3cd", "#e2d3b4", "#d5bf95", "#c6a878", "#a98f63", "#c2410c"] as const;

/**
 * Far enough round the warm band that neighbours are plainly different depths. The band itself
 * is narrow on purpose — ambers only, never green or blue — so the walk reads as shades of one
 * warm paper rather than as a tour of the wheel.
 */
const HUE_STEP = 24;

function hslHex(h: number, s: number, l: number): string {
  const hue = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hue < 60) [r, g, b] = [c, x, 0];
  else if (hue < 120) [r, g, b] = [x, c, 0];
  else if (hue < 180) [r, g, b] = [0, c, x];
  else if (hue < 240) [r, g, b] = [0, x, c];
  else if (hue < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const channel = (v: number) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

/**
 * Returns the next colour in the walk. `intensity` is how fast the cursor was moving when the
 * badge dropped, and it drives depth rather than hue: a slow drift lays down pale paper, a
 * flick lays down a deep amber, so the trail records the gesture and not just the path. The hue
 * advances every call regardless within a narrow warm band, which is what keeps neighbours
 * distinct without ever leaving paper tones.
 */
export function makeHueWalker(seedHue: number): (intensity: number) => string {
  let h = seedHue;
  return (intensity: number) => {
    h += HUE_STEP;
    const t = Math.max(0, Math.min(1, intensity));
    return hslHex(32 + (h % 36), 0.3 + 0.28 * t, 0.84 - 0.2 * t);
  };
}

/**
 * Sorts by a random key rather than swapping in place. Fisher–Yates is the usual answer and is
 * fine, but under `noUncheckedIndexedAccess` every swap needs two undefined checks that can
 * never fire, and the arrays here are two dozen items long once every two dozen badges.
 */
export function shuffle<T>(items: readonly T[], rnd: () => number): T[] {
  return items
    .map((value) => ({ value, key: rnd() }))
    .sort((a, b) => a.key - b.key)
    .map((entry) => entry.value);
}
