const hash32 = (text: string): number => {
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index++) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash >>> 0;
};

/**
 * Derive a stable per-trial seed from the corpus seed, scenario id and trial
 * index. Two runs of the same corpus with the same seed produce identical
 * trial seeds.
 */
export const deriveTrialSeed = (corpusSeed: number, scenarioId: string, trialIndex: number): number =>
    hash32(`${corpusSeed >>> 0}:${scenarioId}:${trialIndex >>> 0}`) >>> 0;

export type SeededRandom = Readonly<{
    next: () => number;
}>;

/**
 * Deterministic mulberry32 PRNG. Used by fixture worlds so a given trial seed
 * always replays the same pseudo-random sequence.
 */
export const createSeededRandom = (seed: number): SeededRandom => {
    let state = seed >>> 0;
    return Object.freeze({
        next: () => {
            state = (state + 0x6d2b79f5) >>> 0;
            let t = state;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        },
    });
};

export const DEFAULT_AGENT_EVAL_SEED = 20260829;
