import type { ScoreResult } from '../types/entity-rules';

export type EntityRulesStore = {
    lastScore?: ScoreResult;
};

export const entityRulesStore: EntityRulesStore = {};

export const setLastScore = (score: ScoreResult) => {
    entityRulesStore.lastScore = score;
};
