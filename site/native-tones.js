// Uniform patches photographed 2026-11-14, normalized to their white/black lanes.
// One global, provisional response: neighboring masks and temperature also affect tone.
const RESPONSE = [[0, 0], [1, 0.259], [32, 0.369], [85, 0.441], [170, 0.858], [255, 1]];
const palettes = new Map();

function interpolate(value, input) {
  const output = 1 - input;
  for (let i = 1; i < RESPONSE.length; i++) {
    const a = RESPONSE[i - 1], b = RESPONSE[i];
    if (value <= b[input]) return a[output] + (b[output] - a[output]) * (value - a[input]) / (b[input] - a[input]);
  }
  return RESPONSE.at(-1)[output];
}

export function nativePalette(levels) {
  if (!Number.isInteger(levels) || levels < 2 || levels > 256) throw new Error('Tone count must be an integer from 2 to 256.');
  if (!palettes.has(levels)) {
    const doses = [], coverage = [];
    for (let i = 0; i < levels; i++) {
      const target = i / (levels - 1), continuous = interpolate(target, 1);
      const lower = Math.floor(continuous), upper = Math.ceil(continuous);
      // Choose by measured brightness, including the jump from white to minimum heat.
      const dose = target - interpolate(lower, 0) <= interpolate(upper, 0) - target ? lower : upper;
      doses.push(dose);
      coverage.push(interpolate(dose, 0));
    }
    palettes.set(levels, Object.freeze({ doses: Object.freeze(doses), coverage: Object.freeze(coverage) }));
  }
  return palettes.get(levels);
}
