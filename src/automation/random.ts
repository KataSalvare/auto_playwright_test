export type Random = () => number;

export function createSeededRandom(initialSeed: number): Random {
  let seed = initialSeed >>> 0;

  return () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let value = seed;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomBetween(random: Random, min: number, max: number): number {
  return min + random() * (max - min);
}

export function randomInteger(random: Random, min: number, max: number): number {
  return Math.floor(randomBetween(random, min, max + 1));
}

export function pick<T>(random: Random, values: readonly T[]): T {
  if (values.length === 0) throw new Error('不能从空数组中选择随机值');
  return values[randomInteger(random, 0, values.length - 1)];
}

export function chance(random: Random, probability: number): boolean {
  if (probability <= 0) return false;
  if (probability >= 1) return true;
  return random() < probability;
}
