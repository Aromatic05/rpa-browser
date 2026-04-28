import type { DslExpr, DslProgram, DslStmt, FormActStmt, RefExpr } from '../ast/types';

type NormalizeContext = {
    nextTempId: number;
};

export const normalizeDsl = (program: DslProgram): DslProgram => {
    const ctx: NormalizeContext = { nextTempId: 1 };
    return {
        body: normalizeStatements(program.body, ctx),
    };
};

const normalizeStatements = (body: DslStmt[], ctx: NormalizeContext): DslStmt[] => {
    const normalized: DslStmt[] = [];
    for (const stmt of body) {
        normalized.push(...normalizeStmt(stmt, ctx));
    }
    return normalized;
};

const normalizeStmt = (stmt: DslStmt, ctx: NormalizeContext): DslStmt[] => {
    if (stmt.kind === 'let') {
        return [{
            ...stmt,
            expr: normalizeExpr(stmt.expr),
        }];
    }
    if (stmt.kind === 'form_act') {
        return expandFormActStmt(stmt, ctx);
    }
    if (stmt.kind === 'act') {
        return [{
            ...stmt,
            ...(stmt.target ? { target: normalizeRef(stmt.target) } : {}),
            ...(stmt.value ? { value: normalizeRef(stmt.value) } : {}),
        }];
    }
    if (stmt.kind === 'checkpoint') {
        return [{
            ...stmt,
            input: stmt.input
                ? Object.fromEntries(Object.entries(stmt.input).map(([key, value]) => [key, normalizeExpr(value)]))
                : undefined,
        }];
    }
    if (stmt.kind === 'if') {
        return [{
            ...stmt,
            condition: normalizeExpr(stmt.condition),
            then: normalizeStatements(stmt.then, ctx),
            else: stmt.else ? normalizeStatements(stmt.else, ctx) : undefined,
        }];
    }
    return [{
        ...stmt,
        iterable: normalizeExpr(stmt.iterable),
        body: normalizeStatements(stmt.body, ctx),
    }];
};

const normalizeExpr = <T extends DslExpr>(expr: T): T => {
    if (expr.kind !== 'ref') {return expr;}
    return normalizeRef(expr) as T;
};

const normalizeRef = (expr: RefExpr): RefExpr => {
    if (expr.ref.startsWith('input.') || expr.ref.startsWith('vars.') || expr.ref.startsWith('output.')) {
        return expr;
    }
    return {
        ...expr,
        ref: `vars.${expr.ref}`,
    };
};

const expandFormActStmt = (stmt: FormActStmt, ctx: NormalizeContext): DslStmt[] => {
    const tempName = `__dsl_form_target_${ctx.nextTempId}`;
    ctx.nextTempId += 1;

    const letStmt: DslStmt = {
        kind: 'let',
        name: tempName,
        expr: {
            kind: 'query',
            op: 'entity.target',
            businessTag: stmt.businessTag,
            payload:
                stmt.target.kind === 'field'
                    ? { kind: 'form.field', fieldKey: stmt.target.fieldKey }
                    : { kind: 'form.action', actionIntent: stmt.target.actionIntent },
        },
    };

    const actStmt: DslStmt =
        stmt.action === 'fill'
            ? {
                  kind: 'act',
                  action: 'fill',
                  target: { kind: 'ref', ref: `vars.${tempName}` },
                  value: normalizeRef(stmt.value!),
              }
            : {
                  kind: 'act',
                  action: 'click',
                  target: { kind: 'ref', ref: `vars.${tempName}` },
              };

    return [letStmt, actStmt];
};
