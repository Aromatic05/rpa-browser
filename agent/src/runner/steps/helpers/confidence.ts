type A11yLike = { role?: string; name?: string; text?: string };
type ResolveTextHint = { role?: string; name?: string; text?: string };

export type ConfidencePolicy = {
    enabled: boolean;
    minScore: number;
    roleWeight: number;
    nameWeight: number;
    textWeight: number;
    selectorBonus: number;
};

type ConfidenceDetails = {
    score: number;
    roleMatch: boolean;
    nameMatch: boolean;
    textMatch: boolean;
    selectorBonus: boolean;
};

const normalizeForConfidence = (value?: string) =>
    (value || '')
        .replace(/[“”]/g, '"')
        .replace(/[‘’]/g, "'")
        .toLowerCase()
        .replace(/[\s\r\n]+/g, ' ')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();

const includesNormalized = (value: string, needle: string) => {
    if (!needle) return true;
    if (!value) return false;
    return value.includes(needle);
};

export const scoreA11yConfidence = (
    candidate: A11yLike,
    hint: ResolveTextHint | undefined,
    policy: ConfidencePolicy,
    hasSelector: boolean,
): { ok: boolean; details: ConfidenceDetails } => {
    if (!hint || !policy.enabled) {
        return {
            ok: true,
            details: { score: 1, roleMatch: true, nameMatch: true, textMatch: true, selectorBonus: hasSelector },
        };
    }

    const candidateRole = normalizeForConfidence(candidate.role);
    const candidateName = normalizeForConfidence(candidate.name || candidate.text);
    const candidateText = normalizeForConfidence(candidate.text || candidate.name);
    const hintRole = normalizeForConfidence(hint.role);
    const hintName = normalizeForConfidence(hint.name);
    const hintText = normalizeForConfidence(hint.text);

    const roleMatch = !hintRole || candidateRole === hintRole;
    const nameMatch = !hintName || includesNormalized(candidateName, hintName);
    const textMatch = !hintText || includesNormalized(candidateText, hintText);

    let score = 0;
    if (roleMatch) score += policy.roleWeight;
    if (nameMatch) score += policy.nameWeight;
    if (textMatch) score += policy.textWeight;
    if (hasSelector) score += policy.selectorBonus;

    return {
        ok: score >= policy.minScore,
        details: { score, roleMatch, nameMatch, textMatch, selectorBonus: hasSelector },
    };
};
