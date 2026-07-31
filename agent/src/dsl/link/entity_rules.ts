import type { DslDiagnostic } from '../diagnostics';
import { createDiagnostic } from '../diagnostics';
import type { DslEntityRulesProfile, DslEntityRulesResolver } from './types';
import type { DslExpr, DslProgram, DslStmt, EntityReference, RefExpr } from '../ast/types';

export type DslLinkResult = {program: DslProgram; diagnostics: DslDiagnostic[]};

export const linkDsl = (program: DslProgram, resolver?: DslEntityRulesResolver): DslLinkResult => {
    const diagnostics: DslDiagnostic[] = [];
    const imports = program.imports || [];
    const profiles = new Map<string, DslEntityRulesProfile>();
    for (let index = 0; index < imports.length; index += 1) {
        const imported = imports[index];
        const profile = resolver?.resolveProfile(imported.profileName) || null;
        if (!profile) {
            diagnostics.push(createDiagnostic(
                resolver ? 'ERR_DSL_ENTITY_PROFILE_NOT_FOUND' : 'ERR_DSL_ENTITY_RESOLVER_REQUIRED',
                resolver
                    ? `entity_rules profile not found: ${imported.profileName} (alias ${imported.alias})`
                    : `entity_rules resolver is required for profile: ${imported.profileName} (alias ${imported.alias})`,
                `imports.${index}`,
            ));
            continue;
        }
        profiles.set(imported.alias, profile);
    }
    return {
        program: {...program, body: linkStatements(program.body, profiles, diagnostics, 'body', {nextTempId: 1})},
        diagnostics,
    };
};

const linkStatements = (
    body: DslStmt[], profiles: ReadonlyMap<string, DslEntityRulesProfile>, diagnostics: DslDiagnostic[], path: string, ctx: {nextTempId: number},
): DslStmt[] => body.flatMap((stmt, index) => linkStmt(stmt, profiles, diagnostics, `${path}.${index}`, ctx));

const linkStmt = (
    stmt: DslStmt, profiles: ReadonlyMap<string, DslEntityRulesProfile>, diagnostics: DslDiagnostic[], path: string, ctx: {nextTempId: number},
): DslStmt[] => {
    if (stmt.kind === 'entity_act') {
        const linked = linkReference(stmt.target, stmt.action, profiles, diagnostics, `${path}.target`);
        if (!linked) {return [stmt];}
        const tempName = `dslEntityTarget${ctx.nextTempId++}`;
        return [{kind: 'let', name: tempName, expr: {kind: 'query', op: 'entity.target', businessTag: linked.businessTag, payload: linked.target, profileName: linked.profileName}}, {
            kind: 'act', action: stmt.action, target: {kind: 'ref', ref: `vars.${tempName}`}, value: stmt.value, profileName: linked.profileName,
        }];
    }
    if (stmt.kind === 'let') {
        return [{...stmt, expr: linkExpr(stmt.expr, profiles, diagnostics, `${path}.expr`)}];
    }
    if (stmt.kind === 'if') {
        return [{...stmt, condition: linkExpr(stmt.condition, profiles, diagnostics, `${path}.condition`), then: linkStatements(stmt.then, profiles, diagnostics, `${path}.then`, ctx), else: stmt.else ? linkStatements(stmt.else, profiles, diagnostics, `${path}.else`, ctx) : undefined}];
    }
    if (stmt.kind === 'for') {
        return [{...stmt, iterable: linkExpr(stmt.iterable, profiles, diagnostics, `${path}.iterable`), body: linkStatements(stmt.body, profiles, diagnostics, `${path}.body`, ctx)}];
    }
    return [stmt];
};

const linkExpr = (
    expr: DslExpr, profiles: ReadonlyMap<string, DslEntityRulesProfile>, diagnostics: DslDiagnostic[], path: string,
): DslExpr => {
    if (expr.kind !== 'entity_query') {return expr;}
    const linked = linkReference(expr.reference, 'query', profiles, diagnostics, path);
    if (!linked) {return expr;}
    return linked.query
        ? {kind: 'query', op: 'entity', businessTag: linked.businessTag, payload: linked.query, profileName: linked.profileName}
        : {kind: 'query', op: 'entity.target', businessTag: linked.businessTag, payload: linked.target, profileName: linked.profileName};
};

const linkReference = (
    reference: EntityReference, operation: 'fill' | 'click' | 'type' | 'select' | 'query', profiles: ReadonlyMap<string, DslEntityRulesProfile>, diagnostics: DslDiagnostic[], path: string,
): {profileName: string; businessTag: string; target: unknown; query?: string} | null => {
    const profile = profiles.get(reference.alias);
    if (!profile) {
        diagnostics.push(createDiagnostic('ERR_DSL_ENTITY_PROFILE_NOT_FOUND', `entity_rules alias is not linked: ${reference.alias}`, path));
        return null;
    }
    const entities = profile.entities.filter((entity) => entity.entityKey === reference.entityKey);
    if (entities.length !== 1) {
        diagnostics.push(createDiagnostic(entities.length === 0 ? 'ERR_DSL_ENTITY_SYMBOL_NOT_FOUND' : 'ERR_DSL_ENTITY_SYMBOL_AMBIGUOUS', `entity_rules ${entities.length === 0 ? 'symbol not found' : 'symbol is ambiguous'}: ${profile.profileName}.${reference.alias}.${reference.entityKey}`, path));
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
        if (!primaryKey) {
            return null;
        }
        if (reference.member === 'row') {
            if (operation !== 'query') {
                diagnostics.push(createDiagnostic('ERR_DSL_ENTITY_OPERATION_INVALID', `row() only supports query without a row action: ${prefix}`, path));
                return null;
            }
            return target(profile.profileName, entity.businessTag, {kind: 'table.row', primaryKey: {fieldKey: primaryKey, value: reference.rowValue}});
        }
        if (operation !== 'click') {
            diagnostics.push(createDiagnostic('ERR_DSL_ENTITY_OPERATION_INVALID', `row action only supports click: ${prefix}`, path));
            return null;
        }
        if (count(entity.rowActions || [], 'actionIntent', reference.member) !== 1) {
            diagnostics.push(createDiagnostic('ERR_DSL_ENTITY_MEMBER_NOT_FOUND', `row action not found or ambiguous: ${prefix}`, path));
            return null;
        }
        return target(profile.profileName, entity.businessTag, {kind: 'table.row_action', primaryKey: {fieldKey: primaryKey, value: reference.rowValue}, actionIntent: reference.member});
    }
    if (operation === 'query') {
        const query = entity.kind === 'table' ? `table.${reference.member}` : entity.kind === 'form' ? `form.${reference.member}` : reference.member;
        if (!entity.supportedQueries.includes(query)) {
            diagnostics.push(createDiagnostic('ERR_DSL_ENTITY_QUERY_INVALID', `unsupported entity query: ${prefix}`, path));
            return null;
        }
        return {...target(profile.profileName, entity.businessTag, undefined), query};
    }
    const fields = count(entity.fields, 'fieldKey', reference.member);
    const actions = count(entity.actions, 'actionIntent', reference.member);
    if (fields > 1 || actions > 1 || (fields && actions)) {
        diagnostics.push(createDiagnostic('ERR_DSL_ENTITY_MEMBER_AMBIGUOUS', `entity member is ambiguous: ${prefix}`, path));
        return null;
    }
    if (fields === 1) {
        if (operation !== 'fill' && operation !== 'select') {
            diagnostics.push(createDiagnostic('ERR_DSL_ENTITY_OPERATION_INVALID', `field only supports fill or select: ${prefix}`, path));
            return null;
        }
        return target(profile.profileName, entity.businessTag, {kind: fieldTargetKind(entity.kind), fieldKey: reference.member});
    }
    if (actions === 1) {
        if (operation !== 'click') {
            diagnostics.push(createDiagnostic('ERR_DSL_ENTITY_OPERATION_INVALID', `action only supports click: ${prefix}`, path));
            return null;
        }
        return target(profile.profileName, entity.businessTag, {kind: actionTargetKind(entity.kind), actionIntent: reference.member});
    }
    diagnostics.push(createDiagnostic('ERR_DSL_ENTITY_MEMBER_NOT_FOUND', `entity member not found: ${prefix}`, path));
    return null;
};

const target = (profileName: string, businessTag: string, targetValue: unknown) => ({profileName, businessTag, target: targetValue});
const count = <T extends Record<string, unknown>>(values: readonly T[], key: keyof T, value: string): number => values.filter((item) => item[key] === value).length;
const resolvePrimaryKey = (
    entity: DslEntityRulesProfile['entities'][number], prefix: string, diagnostics: DslDiagnostic[], path: string,
): string | null => {
    if (!entity.primaryKey?.fieldKey) {
        diagnostics.push(createDiagnostic('ERR_DSL_ENTITY_PRIMARY_KEY_REQUIRED', `table primary key is required: ${prefix}`, path));
        return null;
    }
    const matches = count(entity.fields, 'fieldKey', entity.primaryKey.fieldKey);
    if (matches === 1) {return entity.primaryKey.fieldKey;}
    diagnostics.push(createDiagnostic(
        matches === 0 ? 'ERR_DSL_ENTITY_PRIMARY_KEY_INVALID' : 'ERR_DSL_ENTITY_PRIMARY_KEY_AMBIGUOUS',
        matches === 0 ? `table primary key field is not declared: ${prefix}` : `table primary key field is ambiguous: ${prefix}`,
        path,
    ));
    return null;
};
const fieldTargetKind = (kind: DslEntityRulesProfile['entities'][number]['kind']): 'entity.field' | 'form.field' | 'table.filter' => kind === 'table' ? 'table.filter' : kind === 'form' ? 'form.field' : 'entity.field';
const actionTargetKind = (kind: DslEntityRulesProfile['entities'][number]['kind']): 'entity.action' | 'form.action' | 'table.module_action' => kind === 'table' ? 'table.module_action' : kind === 'form' ? 'form.action' : 'entity.action';
