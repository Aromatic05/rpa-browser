import type { DslImport, DslExpr, EntityActStmt, EntityReference, LinkedEntityActStmt } from '../ast/types';
import type { DslDiagnostic } from '../diagnostics';
import { createDiagnostic } from '../diagnostics';
import type { DslEntityRulesProfile, DslEntityRulesResolver } from './types';
import type {EffectDeclaration, EffectSemantics} from '../../effects/contracts';

export type EntityRulesLinkContext = {
    profiles: ReadonlyMap<string, DslEntityRulesProfile>;
    failedAliases: ReadonlySet<string>;
};

type LinkedReference = {
    profileName: string;
    businessTag: string;
    target?: unknown;
    query?: string;
    effect?: EffectSemantics;
};

export const resolveEntityRuleImports = (
    imports: readonly DslImport[],
    resolver: DslEntityRulesResolver | undefined,
    diagnostics: DslDiagnostic[],
): EntityRulesLinkContext => {
    const profiles = new Map<string, DslEntityRulesProfile>();
    const failedAliases = new Set<string>();

    imports.forEach((imported, index) => {
        if (imported.kind !== 'entity_rules') {return;}
        if (!resolver) {
            diagnostics.push(createDiagnostic(
                'ERR_DSL_ENTITY_RESOLVER_REQUIRED',
                `entity_rules resolver is required for profile: ${imported.profileName} (alias ${imported.alias})`,
                `imports.${index}`,
            ));
            failedAliases.add(imported.alias);
            return;
        }

        const resolution = resolver.resolveProfile(imported.profileName);
        for (const diagnostic of resolution.diagnostics) {
            diagnostics.push(createDiagnostic(
                diagnostic.code,
                `${diagnostic.message} (profile ${imported.profileName}, alias ${imported.alias})`,
                `imports.${index}`,
            ));
        }
        if (!resolution.profile) {
            if (resolution.diagnostics.length === 0) {
                diagnostics.push(createDiagnostic(
                    'ERR_DSL_ENTITY_PROFILE_NOT_FOUND',
                    `entity_rules profile not found: ${imported.profileName} (alias ${imported.alias})`,
                    `imports.${index}`,
                ));
            }
            failedAliases.add(imported.alias);
            return;
        }
        if (resolution.profile.profileName !== imported.profileName) {
            diagnostics.push(createDiagnostic(
                'ERR_DSL_ENTITY_PROFILE_MISMATCH',
                `entity_rules resolver returned ${resolution.profile.profileName} for ${imported.profileName}`,
                `imports.${index}`,
            ));
            failedAliases.add(imported.alias);
            return;
        }
        profiles.set(imported.alias, resolution.profile);
    });

    return {profiles, failedAliases};
};

export const linkEntityAction = (
    stmt: EntityActStmt,
    context: EntityRulesLinkContext,
    diagnostics: DslDiagnostic[],
    path: string,
): EntityActStmt | LinkedEntityActStmt => {
    const linked = linkReference(
        stmt.target,
        stmt.action,
        context,
        diagnostics,
        `${path}.target`,
    );
    if (!linked?.target) {return stmt;}
    return {
        kind: 'linked_entity_act',
        action: stmt.action,
        targetQuery: {
            kind: 'query',
            op: 'entity.target',
            businessTag: linked.businessTag,
            payload: linked.target,
            profileName: linked.profileName,
        },
        value: stmt.value,
        ...(linked.effect ? {effect: linked.effect} : {}),
    };
};

export const linkEntityExpr = (
    expr: DslExpr,
    context: EntityRulesLinkContext,
    diagnostics: DslDiagnostic[],
    path: string,
): DslExpr => {
    if (expr.kind !== 'entity_query') {return expr;}
    const linked = linkReference(expr.reference, 'query', context, diagnostics, path);
    if (!linked) {return expr;}
    return linked.query
        ? {
            kind: 'query',
            op: 'entity',
            businessTag: linked.businessTag,
            payload: linked.query,
            profileName: linked.profileName,
        }
        : {
            kind: 'query',
            op: 'entity.target',
            businessTag: linked.businessTag,
            payload: linked.target,
            profileName: linked.profileName,
        };
};

const linkReference = (
    reference: EntityReference,
    operation: 'fill' | 'click' | 'type' | 'select' | 'query',
    context: EntityRulesLinkContext,
    diagnostics: DslDiagnostic[],
    path: string,
): LinkedReference | null => {
    const profile = context.profiles.get(reference.alias);
    if (!profile) {
        if (context.failedAliases.has(reference.alias)) {return null;}
        diagnostics.push(createDiagnostic(
            'ERR_DSL_ENTITY_PROFILE_NOT_FOUND',
            `entity_rules alias is not linked: ${reference.alias}`,
            path,
        ));
        return null;
    }

    const entities = profile.entities.filter((entity) => entity.entityKey === reference.entityKey);
    if (entities.length !== 1) {
        diagnostics.push(createDiagnostic(
            entities.length === 0 ? 'ERR_DSL_ENTITY_SYMBOL_NOT_FOUND' : 'ERR_DSL_ENTITY_SYMBOL_AMBIGUOUS',
            `entity_rules ${entities.length === 0 ? 'symbol not found' : 'symbol is ambiguous'}: ${profile.profileName}.${reference.alias}.${reference.entityKey}`,
            path,
        ));
        return null;
    }

    const entity = entities[0];
    const prefix = `${profile.profileName}.${reference.alias}.${reference.entityKey}.${reference.member}`;
    if (reference.rowValue) {
        if (entity.kind !== 'table') {
            diagnostics.push(createDiagnostic('ERR_DSL_ENTITY_MEMBER_KIND', `row() requires a table entity: ${prefix}`, path));
            return null;
        }
        const primaryKey = resolvePrimaryKey(entity, prefix, diagnostics, path);
        if (!primaryKey) {return null;}
        if (reference.member === 'row') {
            if (operation !== 'query') {
                diagnostics.push(createDiagnostic(
                    'ERR_DSL_ENTITY_OPERATION_INVALID',
                    `row() only supports query without a row action: ${prefix}`,
                    path,
                ));
                return null;
            }
            return linkedTarget(profile.profileName, entity.businessTag, {
                kind: 'table.row',
                primaryKey: {fieldKey: primaryKey, value: reference.rowValue},
            });
        }
        if (operation !== 'click') {
            diagnostics.push(createDiagnostic('ERR_DSL_ENTITY_OPERATION_INVALID', `row action only supports click: ${prefix}`, path));
            return null;
        }
        const rowActions = entity.rowActions.filter((item) => item.actionIntent === reference.member);
        if (rowActions.length !== 1) {
            diagnostics.push(createDiagnostic(
                rowActions.length === 0 ? 'ERR_DSL_ENTITY_MEMBER_NOT_FOUND' : 'ERR_DSL_ENTITY_MEMBER_AMBIGUOUS',
                `row action ${rowActions.length === 0 ? 'not found' : 'is ambiguous'}: ${prefix}`,
                path,
            ));
            return null;
        }
        return linkedTarget(profile.profileName, entity.businessTag, {
            kind: rowActions[0].targetKind,
            primaryKey: {fieldKey: primaryKey, value: reference.rowValue},
            actionIntent: reference.member,
        }, effectSemantics(rowActions[0].effect, profile.profileName, entity.entityKey, 'rowAction', reference.member));
    }

    if (operation === 'query') {
        const query = entity.kind === 'table'
            ? `table.${reference.member}`
            : entity.kind === 'form'
                ? `form.${reference.member}`
                : reference.member;
        if (!entity.supportedQueries.includes(query)) {
            diagnostics.push(createDiagnostic('ERR_DSL_ENTITY_QUERY_INVALID', `unsupported entity query: ${prefix}`, path));
            return null;
        }
        return {profileName: profile.profileName, businessTag: entity.businessTag, query};
    }

    const fields = entity.fields.filter((item) => item.fieldKey === reference.member);
    const actions = entity.actions.filter((item) => item.actionIntent === reference.member);
    if (fields.length > 1 || actions.length > 1 || (fields.length > 0 && actions.length > 0)) {
        diagnostics.push(createDiagnostic('ERR_DSL_ENTITY_MEMBER_AMBIGUOUS', `entity member is ambiguous: ${prefix}`, path));
        return null;
    }
    if (fields.length === 1) {
        if (!['fill', 'type', 'select'].includes(operation)) {
            diagnostics.push(createDiagnostic(
                'ERR_DSL_ENTITY_OPERATION_INVALID',
                `field only supports fill, type or select: ${prefix}`,
                path,
            ));
            return null;
        }
        return linkedTarget(profile.profileName, entity.businessTag, {
            kind: fields[0].targetKind,
            fieldKey: reference.member,
        }, effectSemantics(fields[0].effect, profile.profileName, entity.entityKey, 'field', reference.member));
    }
    if (actions.length === 1) {
        if (operation !== 'click') {
            diagnostics.push(createDiagnostic('ERR_DSL_ENTITY_OPERATION_INVALID', `action only supports click: ${prefix}`, path));
            return null;
        }
        return linkedTarget(profile.profileName, entity.businessTag, {
            kind: actions[0].targetKind,
            actionIntent: reference.member,
        }, effectSemantics(actions[0].effect, profile.profileName, entity.entityKey, 'action', reference.member));
    }

    diagnostics.push(createDiagnostic('ERR_DSL_ENTITY_MEMBER_NOT_FOUND', `entity member not found: ${prefix}`, path));
    return null;
};

const linkedTarget = (
    profileName: string,
    businessTag: string,
    target: unknown,
    effect?: EffectSemantics,
): LinkedReference => ({
    profileName,
    businessTag,
    target,
    ...(effect ? {effect} : {}),
});

const effectSemantics = (
    declaration: EffectDeclaration | undefined,
    profileName: string,
    entityKey: string,
    memberKind: 'field' | 'action' | 'rowAction',
    member: string,
): EffectSemantics | undefined => declaration ? Object.freeze({
    ...declaration,
    source: Object.freeze({
        kind: 'entity_rules' as const,
        profileName,
        entityKey,
        memberKind,
        member,
    }),
}) : undefined;

const resolvePrimaryKey = (
    entity: DslEntityRulesProfile['entities'][number],
    prefix: string,
    diagnostics: DslDiagnostic[],
    path: string,
): string | null => {
    if (!entity.primaryKey?.fieldKey) {
        diagnostics.push(createDiagnostic('ERR_DSL_ENTITY_PRIMARY_KEY_REQUIRED', `table primary key is required: ${prefix}`, path));
        return null;
    }
    const matches = entity.columns.filter((column) => column.fieldKey === entity.primaryKey!.fieldKey).length;
    if (matches === 1) {return entity.primaryKey.fieldKey;}
    diagnostics.push(createDiagnostic(
        matches === 0 ? 'ERR_DSL_ENTITY_PRIMARY_KEY_INVALID' : 'ERR_DSL_ENTITY_PRIMARY_KEY_AMBIGUOUS',
        matches === 0
            ? `table primary key column is not declared: ${prefix}`
            : `table primary key column is ambiguous: ${prefix}`,
        path,
    ));
    return null;
};
