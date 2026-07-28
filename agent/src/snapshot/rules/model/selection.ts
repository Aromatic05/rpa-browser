export type StepEntityRulesSelection = 'inherit' | 'disabled' | 'auto' | 'explicit';

export type StepEntityRulesControl = {
    selection: StepEntityRulesSelection;
    profiles?: string[];
    strict?: boolean;
};

export const normalizeStepEntityRulesControl = (
    value: StepEntityRulesControl | undefined,
): StepEntityRulesControl => {
    if (!value) {
        return { selection: 'inherit' };
    }
    const selection = value.selection;
    if (!['inherit', 'disabled', 'auto', 'explicit'].includes(selection)) {
        throw new Error(`invalid entityRules selection: ${String(selection)}`);
    }
    if (value.strict !== undefined && typeof value.strict !== 'boolean') {
        throw new Error('entityRules.strict must be a boolean');
    }
    const profiles = uniqueProfiles(value.profiles);
    if (selection === 'explicit' && profiles.length === 0) {
        throw new Error('entityRules explicit selection requires at least one profile');
    }
    if (selection !== 'explicit' && profiles.length > 0) {
        throw new Error(`entityRules profiles require explicit selection, got ${selection}`);
    }
    return {
        selection,
        profiles: selection === 'explicit' ? profiles : undefined,
        strict: value.strict,
    };
};

export const assertStepEntityRulesControl = (
    value: unknown,
    path = 'entityRules',
): StepEntityRulesControl => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${path} must be an object`);
    }
    try {
        return normalizeStepEntityRulesControl(value as StepEntityRulesControl);
    } catch (error) {
        throw new Error(`${path} is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
};

const uniqueProfiles = (profiles: string[] | undefined): string[] => {
    if (profiles === undefined) {return [];}
    if (!Array.isArray(profiles)) {
        throw new Error('entityRules.profiles must be an array');
    }
    const result: string[] = [];
    const seen = new Set<string>();
    for (const profile of profiles) {
        if (typeof profile !== 'string' || !profile.trim()) {
            throw new Error('entityRules.profiles must contain non-empty strings');
        }
        const normalized = profile.trim();
        if (seen.has(normalized)) {continue;}
        seen.add(normalized);
        result.push(normalized);
    }
    return result;
};
