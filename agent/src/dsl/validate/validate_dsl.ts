import type { ActStmt, CheckpointStmt, DslExpr, DslProgram, DslStmt, RefExpr } from '../ast/types';
import { createDiagnostic, type DslDiagnostic } from '../diagnostics/diagnostics';

type ValidateScope = {
    vars: Set<string>;
};

const ROOT_REFS = new Set(['input', 'vars', 'output']);

export const validateDsl = (program: DslProgram): DslDiagnostic[] => {
    const diagnostics: DslDiagnostic[] = [];
    const scope: ValidateScope = {
        vars: new Set<string>(),
    };

    for (let i = 0; i < program.body.length; i += 1) {
        validateStmt(program.body[i], scope, diagnostics, `body.${i}`);
    }

    return diagnostics;
};

const validateStmt = (
    stmt: DslStmt,
    scope: ValidateScope,
    diagnostics: DslDiagnostic[],
    path: string,
): void => {
    switch (stmt.kind) {
        case 'let':
            validateExpr(stmt.expr, scope, diagnostics, `${path}.expr`);
            if (scope.vars.has(stmt.name)) {
                diagnostics.push(
                    createDiagnostic(
                        'ERR_DSL_VAR_REDEFINED',
                        `DSL variable already defined: ${stmt.name}`,
                        `${path}.name`,
                    ),
                );
                return;
            }
            scope.vars.add(stmt.name);
            return;
        case 'act':
            validateAct(stmt, scope, diagnostics, path);
            return;
        case 'checkpoint':
            validateCheckpoint(stmt, scope, diagnostics, path);
            return;
        case 'if':
            diagnostics.push(createDiagnostic('ERR_DSL_UNSUPPORTED', 'DSL if is not supported yet', path));
            validateExpr(stmt.condition, scope, diagnostics, `${path}.condition`);
            for (let i = 0; i < stmt.then.length; i += 1) {
                validateStmt(stmt.then[i], scope, diagnostics, `${path}.then.${i}`);
            }
            for (let i = 0; i < (stmt.else?.length || 0); i += 1) {
                validateStmt(stmt.else![i], scope, diagnostics, `${path}.else.${i}`);
            }
            return;
        case 'for':
            diagnostics.push(createDiagnostic('ERR_DSL_UNSUPPORTED', 'DSL for is not supported yet', path));
            validateExpr(stmt.iterable, scope, diagnostics, `${path}.iterable`);
            for (let i = 0; i < stmt.body.length; i += 1) {
                validateStmt(stmt.body[i], scope, diagnostics, `${path}.body.${i}`);
            }
            return;
    }
};

const validateAct = (stmt: ActStmt, scope: ValidateScope, diagnostics: DslDiagnostic[], path: string): void => {
    validateRef(stmt.target, scope, diagnostics, `${path}.target`);

    if (stmt.action === 'fill') {
        if (!stmt.value || stmt.value.kind !== 'ref') {
            diagnostics.push(
                createDiagnostic('ERR_DSL_BAD_ACT_ARGS', 'DSL fill requires a ref value', `${path}.value`),
            );
            return;
        }
        validateRef(stmt.value, scope, diagnostics, `${path}.value`);
        return;
    }

    if (stmt.value) {
        diagnostics.push(
            createDiagnostic('ERR_DSL_BAD_ACT_ARGS', 'DSL click does not accept a value', `${path}.value`),
        );
    }
};

const validateCheckpoint = (
    stmt: CheckpointStmt,
    scope: ValidateScope,
    diagnostics: DslDiagnostic[],
    path: string,
): void => {
    if (!stmt.input) {return;}
    for (const [key, value] of Object.entries(stmt.input)) {
        if (value.kind !== 'ref') {
            diagnostics.push(
                createDiagnostic(
                    'ERR_DSL_BAD_CHECKPOINT_INPUT',
                    `DSL checkpoint input must be a ref: ${key}`,
                    `${path}.input.${key}`,
                ),
            );
            continue;
        }
        validateRef(value, scope, diagnostics, `${path}.input.${key}`);
    }
};

const validateExpr = (
    expr: DslExpr,
    scope: ValidateScope,
    diagnostics: DslDiagnostic[],
    path: string,
): void => {
    if (expr.kind === 'ref') {
        validateRef(expr, scope, diagnostics, path);
    }
};

const validateRef = (
    expr: RefExpr,
    scope: ValidateScope,
    diagnostics: DslDiagnostic[],
    path: string,
): void => {
    const [root, firstSegment] = expr.ref.split('.');
    if (!root || !ROOT_REFS.has(root)) {
        return;
    }
    if (root === 'vars' && (!firstSegment || !scope.vars.has(firstSegment))) {
        diagnostics.push(
            createDiagnostic('ERR_DSL_VAR_NOT_DEFINED', `DSL variable is not defined: ${expr.ref}`, path),
        );
    }
};
