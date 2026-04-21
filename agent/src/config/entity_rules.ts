import path from 'node:path';
import type { EntityKind } from '../runner/steps/executors/snapshot/core/types';

export type EntityRuleConfig = {
    enabled: boolean;
    rootDir: string;
    selection: 'disabled' | 'explicit' | 'auto';
    profiles: string[];
    strict: boolean;
};

export type EntityRuleProfileMeta = {
    name: string;
    pageKind?: EntityKind;
    urlPattern?: string;
};

export type EntityRuleProfileSelectionResult = {
    selected: string[];
    errors: string[];
    warnings: string[];
};

export const defaultEntityRuleRootDir = () => path.resolve(process.cwd(), '.artifacts/entity_rules');

export const defaultEntityRuleConfig: EntityRuleConfig = {
    enabled: false,
    rootDir: defaultEntityRuleRootDir(),
    selection: 'explicit',
    profiles: [],
    strict: true,
};

export const selectEntityRuleProfiles = (
    config: EntityRuleConfig,
    candidates: EntityRuleProfileMeta[],
    page: { kind?: EntityKind; url?: string },
): EntityRuleProfileSelectionResult => {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!config.enabled || config.selection === 'disabled') {
        return {
            selected: [],
            errors,
            warnings,
        };
    }

    const candidateNames = new Set(candidates.map((item) => item.name));
    let selected: string[] = [];

    if (config.selection === 'explicit') {
        selected = [...new Set(config.profiles.map((name) => name.trim()).filter(Boolean))];
        if (selected.length === 0) {
            pushStrictIssue(config, errors, warnings, 'entity rules selection is explicit but profiles is empty');
        }

        for (const name of selected) {
            if (!candidateNames.has(name)) {
                pushStrictIssue(config, errors, warnings, `entity profile not found: ${name}`);
            }
        }
    }

    if (config.selection === 'auto') {
        for (const candidate of candidates) {
            if (!matchesAutoPage(candidate, page)) continue;
            selected.push(candidate.name);
        }
    }

    selected = [...new Set(selected)].sort((left, right) => left.localeCompare(right));

    if (selected.length > 1) {
        pushStrictIssue(config, errors, warnings, `entity profile conflict: ${selected.join(', ')}`);
    }

    if (selected.length === 0) {
        pushStrictIssue(config, errors, warnings, 'entity profile not selected');
    }

    return {
        selected,
        errors,
        warnings,
    };
};

const matchesAutoPage = (
    candidate: EntityRuleProfileMeta,
    page: { kind?: EntityKind; url?: string },
): boolean => {
    if (page.kind && candidate.pageKind && candidate.pageKind !== page.kind) return false;
    if (page.kind && !candidate.pageKind) return false;

    if (!candidate.urlPattern) return true;
    if (!page.url) return false;

    try {
        return new RegExp(candidate.urlPattern).test(page.url);
    } catch {
        return false;
    }
};

const pushStrictIssue = (
    config: EntityRuleConfig,
    errors: string[],
    warnings: string[],
    message: string,
) => {
    if (config.strict) {
        errors.push(message);
        return;
    }
    warnings.push(message);
};
