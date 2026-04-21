import type { ScoreItem, ScoreResult, UserFormCase, UserListCase } from '../../types/entity-rules';

export const scoreUserListCase = (
    caseData: UserListCase,
    input: { userNo: string; userName: string; status: string; submitted: boolean },
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

export const scoreUserFormCase = (
    caseData: UserFormCase,
    input: { userNo: string; userName: string; phone: string; role: string; submitted: boolean },
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
