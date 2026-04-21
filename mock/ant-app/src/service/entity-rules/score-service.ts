import type { OrderFormCase, OrderListCase, ScoreItem, ScoreResult } from '../../types/entity-rules';

export const scoreOrderListCase = (
    caseData: OrderListCase,
    input: { orderNo: string; buyer: string; status: string; submitted: boolean },
): ScoreResult => {
    const items: ScoreItem[] = caseData.scoreRules.map((rule) => {
        if (rule.key === 'submit') {
            return { key: 'submit', ok: input.submitted, score: input.submitted ? rule.score : 0, expected: true, actual: input.submitted };
        }
        const expectedValue = caseData.expected.filters[rule.key as keyof typeof caseData.expected.filters];
        const actualValue = input[rule.key as keyof typeof input];
        const ok = expectedValue === actualValue;
        return { key: rule.key, ok, score: ok ? rule.score : 0, expected: expectedValue, actual: actualValue };
    });

    const score = items.reduce((sum, item) => sum + item.score, 0);
    const maxScore = caseData.scoreRules.reduce((sum, item) => sum + item.score, 0);
    return { caseId: caseData.id, score, maxScore, items };
};

export const scoreOrderFormCase = (
    caseData: OrderFormCase,
    input: { orderNo: string; buyer: string; amount: number; dept: string; submitted: boolean },
): ScoreResult => {
    const items: ScoreItem[] = caseData.scoreRules.map((rule) => {
        if (rule.key === 'submit') {
            return { key: 'submit', ok: input.submitted, score: input.submitted ? rule.score : 0, expected: true, actual: input.submitted };
        }
        const expectedValue = caseData.expected[rule.key as keyof typeof caseData.expected];
        const actualValue = input[rule.key as keyof typeof input];
        const ok = expectedValue === actualValue;
        return { key: rule.key, ok, score: ok ? rule.score : 0, expected: expectedValue, actual: actualValue };
    });

    const score = items.reduce((sum, item) => sum + item.score, 0);
    const maxScore = caseData.scoreRules.reduce((sum, item) => sum + item.score, 0);
    return { caseId: caseData.id, score, maxScore, items };
};
