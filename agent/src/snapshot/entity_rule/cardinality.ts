import type { RuleExpectedCardinality } from './contracts';

export const cardinalitySatisfied = (
    expected: RuleExpectedCardinality,
    count: number,
): boolean => expected === 'unique' ? count === 1 : count >= 1;
