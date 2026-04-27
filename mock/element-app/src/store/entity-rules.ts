import type { ScoreResult } from '../types/entity-rules';

export const entityRuleStore: { lastScore?: ScoreResult } = {};

export const setLastScore = (score: ScoreResult) => {
    entityRuleStore.lastScore = score;
};
