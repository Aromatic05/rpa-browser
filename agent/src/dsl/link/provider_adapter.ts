import type { WorkspaceEntityRulesProvider } from '../../snapshot/rules/runtime';
import type { DslEntityRulesProfile, DslEntityRulesResolver } from './types';

export const createDslEntityRulesResolver = (
    provider: WorkspaceEntityRulesProvider,
): DslEntityRulesResolver => ({
    resolveProfile: (profileName) => {
        const resolution = provider.resolveExports(profileName);
        if (!resolution.index) {
            const diagnostics = resolution.diagnostics
                .filter((diagnostic) => diagnostic.code !== 'entity_rule_exports.profile_not_found')
                .map((diagnostic) => ({
                    code: 'ERR_DSL_ENTITY_EXPORT_INVALID',
                    message: `${diagnostic.code}: ${diagnostic.message}`,
                }));
            return {profile: null, diagnostics};
        }
        return {
            profile: toDslProfile(resolution.index),
            diagnostics: [],
        };
    },
});

const toDslProfile = (
    index: NonNullable<ReturnType<WorkspaceEntityRulesProvider['resolveExports']>['index']>,
): DslEntityRulesProfile => ({
    profileName: index.profileName,
    entities: index.entities.map((entity) => ({
        entityKey: entity.entityKey,
        businessTag: entity.businessTag,
        kind: entity.kind,
        fields: entity.fields,
        actions: entity.actions,
        columns: entity.columns,
        rowActions: entity.rowActions,
        supportedQueries: entity.supportedQueries,
        ...(entity.primaryKey ? {primaryKey: {fieldKey: entity.primaryKey.fieldKey}} : {}),
    })),
});
