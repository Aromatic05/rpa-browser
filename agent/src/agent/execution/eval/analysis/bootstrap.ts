import {createSeededRandom} from '../seed';
import type {ConfidenceInterval} from './contracts';

/**
 * Deterministic seeded bootstrap confidence intervals. No external dependency
 * and no network: the mulberry32 PRNG from the committed seed module replays a
 * fixed sequence for a given seed, so identical inputs produce byte-identical
 * intervals. Percentile intervals use linear interpolation (R-7 type).
 */

const fnv1a32 = (text: string): number => {
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index++) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash >>> 0;
};

export const analysisBootstrapSeed = (
    baseSeed: number,
    scope: string,
    metric: string,
    kind: string,
): number => fnv1a32(`${baseSeed >>> 0}:${scope}:${metric}:${kind}`) >>> 0;

export type BootstrapOptions = Readonly<{
    iterations?: number;
    level?: number;
    seed: number;
}>;

export const DEFAULT_BOOTSTRAP_ITERATIONS = 1000;
export const DEFAULT_BOOTSTRAP_LEVEL = 0.95;

const quantile = (sorted: readonly number[], probability: number): number => {
    if (sorted.length === 1) {
        return sorted[0];
    }
    const h = (sorted.length - 1) * probability;
    const lower = Math.floor(h);
    if (lower >= sorted.length - 1) {
        return sorted[sorted.length - 1];
    }
    const fraction = h - lower;
    return sorted[lower] * (1 - fraction) + sorted[lower + 1] * fraction;
};

const percentileConfidenceInterval = (
    values: readonly number[],
    level: number,
): {lower: number; upper: number} => {
    const sorted = [...values].sort((a, b) => a - b);
    const tail = (1 - level) / 2;
    return {
        lower: quantile(sorted, tail),
        upper: quantile(sorted, 1 - tail),
    };
};

const finishInterval = (
    resampled: readonly number[],
    options: BootstrapOptions,
    level: number,
): ConfidenceInterval => {
    const {lower, upper} = percentileConfidenceInterval(resampled, level);
    return Object.freeze({
        level,
        iterations: options.iterations ?? DEFAULT_BOOTSTRAP_ITERATIONS,
        seed: options.seed,
        lower,
        upper,
    });
};

export const pairedMeanDeltaCI = (
    diffs: readonly number[],
    options: BootstrapOptions,
): ConfidenceInterval | null => {
    const n = diffs.length;
    if (n === 0) {
        return null;
    }
    const level = options.level ?? DEFAULT_BOOTSTRAP_LEVEL;
    const iterations = options.iterations ?? DEFAULT_BOOTSTRAP_ITERATIONS;
    const random = createSeededRandom(options.seed);
    const resampledMeans: number[] = [];
    for (let iteration = 0; iteration < iterations; iteration++) {
        let sum = 0;
        for (let index = 0; index < n; index++) {
            sum += diffs[Math.floor(random.next() * n)];
        }
        resampledMeans.push(sum / n);
    }
    return finishInterval(resampledMeans, options, level);
};

export type PairedBinary = Readonly<{
    program: boolean;
    baseline: boolean;
}>;

export const pairedRateDeltaCI = (
    pairs: readonly PairedBinary[],
    options: BootstrapOptions,
): ConfidenceInterval | null => {
    const n = pairs.length;
    if (n === 0) {
        return null;
    }
    const level = options.level ?? DEFAULT_BOOTSTRAP_LEVEL;
    const iterations = options.iterations ?? DEFAULT_BOOTSTRAP_ITERATIONS;
    const random = createSeededRandom(options.seed);
    const resampledDeltas: number[] = [];
    for (let iteration = 0; iteration < iterations; iteration++) {
        let program = 0;
        let baseline = 0;
        for (let index = 0; index < n; index++) {
            const sample = pairs[Math.floor(random.next() * n)];
            if (sample.program) {
                program += 1;
            }
            if (sample.baseline) {
                baseline += 1;
            }
        }
        resampledDeltas.push(program / n - baseline / n);
    }
    return finishInterval(resampledDeltas, options, level);
};

export const cohensDz = (diffs: readonly number[]): number | null => {
    const n = diffs.length;
    if (n < 2) {
        return null;
    }
    const mean = diffs.reduce((acc, value) => acc + value, 0) / n;
    const variance = diffs.reduce((acc, value) => acc + (value - mean) ** 2, 0) / (n - 1);
    const sd = Math.sqrt(variance);
    if (!Number.isFinite(sd) || sd === 0) {
        return null;
    }
    return mean / sd;
};

export const cohensH = (first: number, second: number): number =>
    2 * (Math.asin(Math.sqrt(first)) - Math.asin(Math.sqrt(second)));