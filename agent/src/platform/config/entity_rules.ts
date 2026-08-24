export type EntityRuleConfig = {
    enabled: boolean;
    rootDir: string;
    selection: 'disabled' | 'explicit' | 'auto';
    profiles: string[];
    strict: boolean;
};

export const defaultEntityRuleRootDir = '.rpa/entity_rules';

export const defaultEntityRuleConfig: EntityRuleConfig = {
    enabled: false,
    rootDir: defaultEntityRuleRootDir,
    selection: 'disabled',
    profiles: [],
    strict: true,
};

export const selectEntityRuleProfiles = (config: EntityRuleConfig): readonly string[] =>
    config.enabled ? [...config.profiles] : [];
