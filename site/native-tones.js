// The firmware owns continuous-dose and load compensation. Wire codes now name
// relative darkness; applying a second photographic curve here would distort it.
const palettes = new Map();
export const NATIVE_ROW_TONES = 10;

export function nativePalette(levels) {
  if (!Number.isInteger(levels) || levels < 2 || levels > 256) throw new Error('Tone count must be an integer from 2 to 256.');
  if (!palettes.has(levels)) {
    const doses = [], coverage = [];
    for (let i = 0; i < levels; i++) {
      const dose = Math.round(i * 255 / (levels - 1));
      doses.push(dose);
      coverage.push(dose / 255);
    }
    palettes.set(levels, Object.freeze({ doses: Object.freeze(doses), coverage: Object.freeze(coverage) }));
  }
  return palettes.get(levels);
}

export function nativeRowPalette(values, levels, preserveBlack = false) {
  const { coverage } = nativePalette(levels), last = levels - 1;
  if (last <= NATIVE_ROW_TONES) return Array.from({ length: levels }, (_, i) => i);
  const histogram = new Float64Array(levels);
  const bracket = value => {
    let low = 0, high = last;
    while (high - low > 1) {
      const middle = (low + high) >> 1;
      if (coverage[middle] < value) low = middle; else high = middle;
    }
    return [low, high];
  };
  for (const value of values) {
    const target = Math.max(0, Math.min(1, 1 - value / 255));
    const [low, high] = bracket(target);
    const fraction = (target - coverage[low]) / (coverage[high] - coverage[low]);
    // Keep both neighbors of a fractional shade so diffusion can reproduce it.
    histogram[low] += 1 - fraction;
    histogram[high] += fraction;
  }
  const occupied = [...histogram.keys()].filter(i => i && histogram[i] > 1e-9);
  if (preserveBlack && !occupied.includes(last)) occupied.push(last);
  if (occupied.length <= NATIVE_ROW_TONES) return [0, ...occupied];
  const black = preserveBlack || histogram[last] > 1e-9;
  const weight = new Float64Array(levels + 1), sum = weight.slice(), square = weight.slice();
  for (let i = 1; i < levels; i++) {
    weight[i + 1] = weight[i] + histogram[i];
    sum[i + 1] = sum[i] + histogram[i] * coverage[i];
    square[i + 1] = square[i] + histogram[i] * coverage[i] ** 2;
  }
  const stats = (lo, hi) => {
    const n = weight[hi + 1] - weight[lo], s = sum[hi + 1] - sum[lo];
    if (!n) return { code: lo, cost: 0, n };
    const mean = s / n, [a, b] = bracket(mean);
    const code = Math.max(lo, Math.min(hi, mean - coverage[a] <= coverage[b] - mean ? a : b));
    const cost = square[hi + 1] - square[lo] - 2 * coverage[code] * s + coverage[code] ** 2 * n;
    return { code, cost, n };
  };
  const bin = (lo, hi) => {
    const result = { lo, hi, ...stats(lo, hi), gain: 0, cut: lo };
    for (let cut = lo; cut < hi; cut++) {
      const left = stats(lo, cut), right = stats(cut + 1, hi);
      if (!left.n || !right.n) continue;
      const gain = result.cost - left.cost - right.cost;
      if (gain > result.gain) Object.assign(result, { gain, cut });
    }
    return result;
  };
  const bins = [bin(1, last - Number(black))];
  while (bins.length < NATIVE_ROW_TONES - Number(black)) {
    const best = bins.reduce((a, b) => b.gain > a.gain ? b : a);
    if (best.gain <= 1e-12) break;
    bins.splice(bins.indexOf(best), 1, bin(best.lo, best.cut), bin(best.cut + 1, best.hi));
  }
  return [0, ...bins.map(b => b.code), ...(black ? [last] : [])].sort((a, b) => a - b);
}
