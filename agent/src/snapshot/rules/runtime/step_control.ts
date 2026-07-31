import type { EntityRuleConfig } from '../../../config';
import {
    normalizeStepEntityRulesControl,
    type StepEntityRulesControl,
    type StepEntityRulesSelection,
} from '../model/selection';
import type { WorkspaceEntityRulesProvider } from './contracts';

export type StepEntityRulesExecutionResolution = {
    status: 'disabled' | 'ready' | 'unavailable' | 'invalid';
    selection: Exclude<StepEntityRulesSelection, 'inherit'>;
    profiles: string[];
    strict: boolean;
    reason?: string;
};

export const resolveStepEntityRulesExecution = (
    control: StepEntityRulesControl | undefined,
    config: EntityRuleConfig,
    provider: WorkspaceEntityRulesProvider | null | undefined,
): StepEntityRulesExecutionResolution => {
    let normalized: StepEntityRulesControl;
    try {
        normalized = normalizeStepEntityRulesControl(control);
    } catch (error) {
        return invalidResolution(config.strict, error instanceof Error ? error.message : String(error));
    }

    const effective = normalized.selection === 'inherit'
        ? fromConfig(config)
        : {
              selection: normalized.selection,
              profiles: normalized.profiles ?? [],
              strict: normalized.strict ?? config.strict,
          };

    if (effective.selection === 'disabled') {
        return {
            status: 'disabled',
            selection: 'disabled',
            profiles: [],
            strict: effective.strict,
        };
    }
    if (provider?.availability !== 'ready') {
        return {
            status: 'unavailable',
            selection: effective.selection,
            profiles: [...effective.profiles],
            strict: effective.strict,
            reason: 'Snapshot V2 entity_rules provider is unavailable',
        };
    }

    const requestedProfiles = effective.selection === 'auto'
        ? provider.listProfiles()
        : unique(effective.profiles);
    const missingProfiles = requestedProfiles.filter((profile) => provider.getProfile(profile) === null);
    if (effective.strict && missingProfiles.length > 0) {
        return {
            status: 'invalid',
            selection: effective.selection,
            profiles: requestedProfiles,
            strict: effective.strict,
            reason: `entity_rules profiles are missing or invalid: ${missingProfiles.join(', ')}`,
        };
    }
    return {
        status: 'ready',
        selection: effective.selection,
        profiles: requestedProfiles.filter((profile) => !missingProfiles.includes(profile)),
        strict: effective.strict,
    };
};

const invalidResolution = (strict: boolean, reason: string): StepEntityRulesExecutionResolution => ({
    status: 'invalid',
    selection: 'disabled',
    profiles: [],
    strict,
    reason,
});

const fromConfig = (config: EntityRuleConfig): {
    selection: Exclude<StepEntityRulesSelection, 'inherit'>;
    profiles: string[];
    strict: boolean;
} => {
    if (!config.enabled || config.selection === 'disabled') {
        return { selection: 'disabled', profiles: [], strict: config.strict };
    }
    return {
        selection: config.selection,
        profiles: config.selection === 'explicit' ? unique(config.profiles) : [],
        strict: config.strict,
    };
};

const unique = (values: readonly string[]): string[] => [...new Set(values.map((value) => value.trim()).filter(Boolean))];
