import type { DslExpr, DslProgram, DslStmt, RefExpr } from '../ast/types';

export const normalizeDsl = (program: DslProgram): DslProgram => ({
    body: program.body.map(normalizeStmt),
});

const normalizeStmt = (stmt: DslStmt): DslStmt => {
    if (stmt.kind === 'let') {
        return {
            ...stmt,
            expr: normalizeExpr(stmt.expr),
        };
    }
    if (stmt.kind === 'act') {
        return {
            ...stmt,
            ...(stmt.target ? { target: normalizeRef(stmt.target) } : {}),
            ...(stmt.value ? { value: normalizeRef(stmt.value) } : {}),
        };
    }
    if (stmt.kind === 'checkpoint') {
        return {
            ...stmt,
            input: stmt.input
                ? Object.fromEntries(Object.entries(stmt.input).map(([key, value]) => [key, normalizeExpr(value)]))
                : undefined,
        };
    }
    if (stmt.kind === 'if') {
        return {
            ...stmt,
            condition: normalizeExpr(stmt.condition),
            then: stmt.then.map(normalizeStmt),
            else: stmt.else?.map(normalizeStmt),
        };
    }
    return {
        ...stmt,
        iterable: normalizeExpr(stmt.iterable),
        body: stmt.body.map(normalizeStmt),
    };
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
