import type { DslDiagnostic } from '../diagnostics';
import { createDiagnostic } from '../diagnostics';
import type { DslEntityRulesProfile, DslEntityRulesResolver, DslResolveResolver } from './types';
import type { DslExpr, DslProgram, DslStmt, EntityReference, ResolveActStmt } from '../ast/types';
import type { StepResolve } from '../../runner/steps/types';

export type DslLinkResult = {program: DslProgram; diagnostics: DslDiagnostic[]; stepResolves: Record<string, StepResolve>};

type LinkedReference = {
    profileName: string;
    businessTag: string;
    target?: unknown;
    query?: string;
};

export const linkDsl = (
    program: DslProgram,
    resolver?: DslEntityRulesResolver,
    resolveResolver?: DslResolveResolver,
): DslLinkResult => {
    const diagnostics: DslDiagnostic[] = [];
    const profiles = new Map<string, DslEntityRulesProfile>();
    const resolveBundles = new Map<string, {bundleName: string; resolves: Record<string, StepResolve>}>();
    const stepResolves: Record<string, StepResolve> = {};
    const imports = program.imports || [];

    for (let index = 0; index < imports.length; index += 1) {
        const imported = imports[index];
        if (imported.kind === 'resolves') {
            if (!resolveResolver) {
                diagnostics.push(createDiagnostic(
                    'ERR_DSL_RESOLVE_RESOLVER_REQUIRED',
                    `resolves resolver is required for bundle: ${imported.bundleName} (alias ${imported.alias})`,
                    `imports.${index}`,
                ));
                continue;
            }
            const resolution = resolveResolver.resolveBundle(imported.bundleName);
            for (const diagnostic of resolution.diagnostics) {
                diagnostics.push(createDiagnostic(
                    diagnostic.code,
                    `${diagnostic.message} (bundle ${imported.bundleName}, alias ${imported.alias})`,
                    `imports.${index}`,
                ));
            }
            if (!resolution.resolves) {
                if (resolution.diagnostics.length === 0) {
                    diagnostics.push(createDiagnostic(
                        'ERR_DSL_RESOLVE_BUNDLE_NOT_FOUND',
                        `resolve bundle not found: ${imported.bundleName} (alias ${imported.alias})`,
                        `imports.${index}`,
                    ));
                }
                continue;
            }
            resolveBundles.set(imported.alias, {bundleName: imported.bundleName, resolves: resolution.resolves});
            continue;
        }
        if (!resolver) {
            diagnostics.push(createDiagnostic(
                'ERR_DSL_ENTITY_RESOLVER_REQUIRED',
                `entity_rules resolver is required for profile: ${imported.profileName} (alias ${imported.alias})`,
                `imports.${index}`,
            ));
            continue;
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
            continue;
        }
        if (resolution.profile.profileName !== imported.profileName) {
            diagnostics.push(createDiagnostic(
                'ERR_DSL_ENTITY_PROFILE_MISMATCH',
                `entity_rules resolver returned ${resolution.profile.profileName} for ${imported.profileName}`,
                `imports.${index}`,
            ));
            continue;
        }
        profiles.set(imported.alias, resolution.profile);
    }

    return {
        program: {...program, body: linkStatements(program.body, profiles, resolveBundles, stepResolves, diagnostics, 'body')},
        diagnostics,
        stepResolves,
    };
};

const linkStatements = (
    body: readonly DslStmt[],
    profiles: ReadonlyMap<string, DslEntityRulesProfile>,
    resolveBundles: ReadonlyMap<string, {bundleName: string; resolves: Record<string, StepResolve>}>,
    stepResolves: Record<string, StepResolve>,
    diagnostics: DslDiagnostic[],
    path: string,
): DslStmt[] => body.flatMap((stmt, index) => linkStmt(stmt, profiles, resolveBundles, stepResolves, diagnostics, `${path}.${index}`));

const linkStmt = (
    stmt: DslStmt,
    profiles: ReadonlyMap<string, DslEntityRulesProfile>,
    resolveBundles: ReadonlyMap<string, {bundleName: string; resolves: Record<string, StepResolve>}>,
    stepResolves: Record<string, StepResolve>,
    diagnostics: DslDiagnostic[],
    path: string,
): DslStmt[] => {
    if (stmt.kind === 'resolve_act') {
        return [linkResolveAction(stmt, resolveBundles, stepResolves, diagnostics, path)];
    }
    if (stmt.kind === 'entity_act') {
        const linked = linkReference(stmt.target, stmt.action, profiles, diagnostics, `${path}.target`);
        if (!linked?.target) {return [stmt];}
        return [{
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
        }];
    }
    if (stmt.kind === 'let') {
        return [{...stmt, expr: linkExpr(stmt.expr, profiles, diagnostics, `${path}.expr`)}];
    }
    if (stmt.kind === 'if') {
        return [{
            ...stmt,
            condition: linkExpr(stmt.condition, profiles, diagnostics, `${path}.condition`),
            then: linkStatements(stmt.then, profiles, resolveBundles, stepResolves, diagnostics, `${path}.then`),
            else: stmt.else ? linkStatements(stmt.else, profiles, resolveBundles, stepResolves, diagnostics, `${path}.else`) : undefined,
        }];
    }
    if (stmt.kind === 'for') {
        return [{
            ...stmt,
            iterable: linkExpr(stmt.iterable, profiles, diagnostics, `${path}.iterable`),
            body: linkStatements(stmt.body, profiles, resolveBundles, stepResolves, diagnostics, `${path}.body`),
        }];
    }
    return [stmt];
};

const linkResolveAction = (
    stmt: ResolveActStmt,
    bundles: ReadonlyMap<string, {bundleName: string; resolves: Record<string, StepResolve>}>,
    stepResolves: Record<string, StepResolve>,
    diagnostics: DslDiagnostic[],
    path: string,
): ResolveActStmt => {
    const bundle = bundles.get(stmt.target.alias);
    const ref = `${stmt.target.alias}.${stmt.target.symbol}`;
    if (!bundle) {
        diagnostics.push(createDiagnostic('ERR_DSL_RESOLVE_BUNDLE_NOT_FOUND', `resolve alias is not linked: ${stmt.target.alias}`, `${path}.target`));
        return stmt;
    }
    const resolve = bundle.resolves[stmt.target.symbol];
    if (!resolve) {
        diagnostics.push(createDiagnostic(
            'ERR_DSL_RESOLVE_SYMBOL_NOT_FOUND',
            `resolve symbol not found: ${bundle.bundleName}.${ref}`,
            `${path}.target`,
        ));
        return stmt;
    }
    const resolveId = `dsl:${stmt.target.alias}:${stmt.target.symbol}`;
    stepResolves[resolveId] = resolve;
    return {...stmt, target: {...stmt.target, bundleName: bundle.bundleName}, resolveId};
};

const linkExpr = (
    expr: DslExpr,
    profiles: ReadonlyMap<string, DslEntityRulesProfile>,
    diagnostics: DslDiagnostic[],
    path: string,
): DslExpr => {
    if (expr.kind !== 'entity_query') {return expr;}
    const linked = linkReference(expr.reference, 'query', profiles, diagnostics, path);
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
    profiles: ReadonlyMap<string, DslEntityRulesProfile>,
    diagnostics: DslDiagnostic[],
    path: string,
): LinkedReference | null => {
    const profile = profiles.get(reference.alias);
    if (!profile) {
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
        });
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
        });
    }
    if (actions.length === 1) {
        if (operation !== 'click') {
            diagnostics.push(createDiagnostic('ERR_DSL_ENTITY_OPERATION_INVALID', `action only supports click: ${prefix}`, path));
            return null;
        }
        return linkedTarget(profile.profileName, entity.businessTag, {
            kind: actions[0].targetKind,
            actionIntent: reference.member,
        });
    }

    diagnostics.push(createDiagnostic('ERR_DSL_ENTITY_MEMBER_NOT_FOUND', `entity member not found: ${prefix}`, path));
    return null;
};

const linkedTarget = (profileName: string, businessTag: string, target: unknown): LinkedReference => ({
    profileName,
    businessTag,
    target,
});

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
