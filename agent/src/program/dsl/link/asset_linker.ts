import type { DslExpr, DslProgram, DslStmt } from '../ast/types';
import type { DslDiagnostic } from '../diagnostics';
import type { StepResolve } from '../../../automation/runner/steps/types';
import {
    linkEntityAction,
    linkEntityExpr,
    resolveEntityRuleImports,
    type EntityRulesLinkContext,
} from './entity_rules';
import { linkResolveAction, resolveDslResolveImports, type ResolveLinkContext } from './resolves';
import type { DslEntityRulesResolver, DslResolveResolver } from './types';

export type DslLinkResult = {
    program: DslProgram;
    diagnostics: DslDiagnostic[];
    stepResolves: Record<string, StepResolve>;
};

export const linkDsl = (
    program: DslProgram,
    entityRulesResolver?: DslEntityRulesResolver,
    resolveResolver?: DslResolveResolver,
): DslLinkResult => {
    const diagnostics: DslDiagnostic[] = [];
    const imports = program.imports || [];
    const entityRules = resolveEntityRuleImports(imports, entityRulesResolver, diagnostics);
    const resolves = resolveDslResolveImports(imports, resolveResolver, diagnostics);

    return {
        program: {
            ...program,
            body: linkStatements(program.body, entityRules, resolves, diagnostics, 'body'),
        },
        diagnostics,
        stepResolves: resolves.stepResolves,
    };
};

const linkStatements = (
    body: readonly DslStmt[],
    entityRules: EntityRulesLinkContext,
    resolves: ResolveLinkContext,
    diagnostics: DslDiagnostic[],
    path: string,
): DslStmt[] => body.flatMap((stmt, index) =>
    linkStmt(stmt, entityRules, resolves, diagnostics, `${path}.${index}`));

const linkStmt = (
    stmt: DslStmt,
    entityRules: EntityRulesLinkContext,
    resolves: ResolveLinkContext,
    diagnostics: DslDiagnostic[],
    path: string,
): DslStmt[] => {
    if (stmt.kind === 'resolve_act') {
        return [linkResolveAction(stmt, resolves, diagnostics, path)];
    }
    if (stmt.kind === 'entity_act') {
        return [linkEntityAction(stmt, entityRules, diagnostics, path)];
    }
    if (stmt.kind === 'let') {
        return [{...stmt, expr: linkExpr(stmt.expr, entityRules, diagnostics, `${path}.expr`)}];
    }
    if (stmt.kind === 'if') {
        return [{
            ...stmt,
            condition: linkExpr(stmt.condition, entityRules, diagnostics, `${path}.condition`),
            then: linkStatements(stmt.then, entityRules, resolves, diagnostics, `${path}.then`),
            else: stmt.else
                ? linkStatements(stmt.else, entityRules, resolves, diagnostics, `${path}.else`)
                : undefined,
        }];
    }
    if (stmt.kind === 'for') {
        return [{
            ...stmt,
            iterable: linkExpr(stmt.iterable, entityRules, diagnostics, `${path}.iterable`),
            body: linkStatements(stmt.body, entityRules, resolves, diagnostics, `${path}.body`),
        }];
    }
    return [stmt];
};

const linkExpr = (
    expr: DslExpr,
    entityRules: EntityRulesLinkContext,
    diagnostics: DslDiagnostic[],
    path: string,
): DslExpr => linkEntityExpr(expr, entityRules, diagnostics, path);
