import type {
    ActStmt,
    CheckpointStmt,
    DslExpr,
    DslProgram,
    DslStmt,
    LinkedEntityActStmt,
    RefExpr,
    ResolveActStmt,
} from '../ast/types';
import type {ComputeExpr, ComputeValue} from '../../compute/types';
import {COMPUTE_OP_ARITY} from '../../compute/ops';
import { createDiagnostic, type DslDiagnostic } from '../diagnostics/diagnostics';
import { collectDefinitelyAssignedVariables } from '../analysis/definite_assignment';

type ValidateScope = {
    vars: Set<string>;
    allowFailureRoot?: boolean;
};

const ROOT_REFS = new Set(['input', 'vars', 'output']);

export type ValidateDslOptions = {
    allowFailureRoot?: boolean;
    initialVars?: Iterable<string>;
};

export const validateDsl = (program: DslProgram, options: ValidateDslOptions = {}): DslDiagnostic[] => {
    const diagnostics: DslDiagnostic[] = [];
    const scope: ValidateScope = {
        vars: new Set(options.initialVars ?? []),
        allowFailureRoot: options.allowFailureRoot,
    };

    for (let index = 0; index < program.body.length; index += 1) {
        validateStmt(program.body[index], scope, diagnostics, `body.${index}`);
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
                diagnostics.push(createDiagnostic(
                    'ERR_DSL_VAR_REDEFINED',
                    `DSL variable already defined: ${stmt.name}`,
                    `${path}.name`,
                ));
                return;
            }
            scope.vars.add(stmt.name);
            return;
        case 'output':
            validateExpr(stmt.expr, scope, diagnostics, `${path}.expr`);
            return;
        case 'ensure':
            validateExpr(stmt.condition, scope, diagnostics, `${path}.condition`);
            return;
        case 'act':
            validateAct(stmt, scope, diagnostics, path);
            return;
        case 'linked_entity_act':
            validateLinkedEntityAct(stmt, scope, diagnostics, path);
            return;
        case 'resolve_act':
            validateResolveAct(stmt, scope, diagnostics, path);
            return;
        case 'form_act':
        case 'table_act':
        case 'entity_act':
            diagnostics.push(createDiagnostic(
                'ERR_DSL_NOT_NORMALIZED',
                `${stmt.kind} must be expanded before validation`,
                path,
            ));
            return;
        case 'checkpoint':
            validateCheckpoint(stmt, scope, diagnostics, path);
            if (stmt.bind) {
                if (scope.vars.has(stmt.bind)) {
                    diagnostics.push(createDiagnostic('ERR_DSL_VAR_REDEFINED', `DSL variable already defined: ${stmt.bind}`, `${path}.bind`));
                } else {
                    scope.vars.add(stmt.bind);
                }
            }
            return;
        case 'if': {
            validateExpr(stmt.condition, scope, diagnostics, `${path}.condition`);
            const thenScope = {vars: new Set(scope.vars), allowFailureRoot: scope.allowFailureRoot};
            for (let index = 0; index < stmt.then.length; index += 1) {
                validateStmt(stmt.then[index], thenScope, diagnostics, `${path}.then.${index}`);
            }
            const elseScope = {vars: new Set(scope.vars), allowFailureRoot: scope.allowFailureRoot};
            for (let index = 0; index < (stmt.else?.length || 0); index += 1) {
                validateStmt(stmt.else![index], elseScope, diagnostics, `${path}.else.${index}`);
            }
            scope.vars = collectDefinitelyAssignedVariables([stmt], scope.vars);
            return;
        }
        case 'for': {
            validateExpr(stmt.iterable, scope, diagnostics, `${path}.iterable`);
            const loopScope = {vars: new Set(scope.vars), allowFailureRoot: scope.allowFailureRoot};
            loopScope.vars.add(stmt.item);
            for (let index = 0; index < stmt.body.length; index += 1) {
                validateStmt(stmt.body[index], loopScope, diagnostics, `${path}.body.${index}`);
            }
            return;
        }
    }
};

const validateResolveAct = (
    stmt: ResolveActStmt,
    scope: ValidateScope,
    diagnostics: DslDiagnostic[],
    path: string,
): void => {
    if (!stmt.resolveId) {
        diagnostics.push(createDiagnostic('ERR_DSL_NOT_LINKED', 'resolve action must be linked before validation', `${path}.target`));
    }
    if (stmt.action === 'click') {
        if (stmt.value) {
            diagnostics.push(createDiagnostic('ERR_DSL_BAD_ACT_ARGS', 'DSL click does not accept a value', `${path}.value`));
        }
        return;
    }
    if (!stmt.value) {
        diagnostics.push(createDiagnostic('ERR_DSL_BAD_ACT_ARGS', `DSL ${stmt.action} requires a ref value`, `${path}.value`));
        return;
    }
    validateRef(stmt.value, scope, diagnostics, `${path}.value`);
};

const validateAct = (
    stmt: ActStmt,
    scope: ValidateScope,
    diagnostics: DslDiagnostic[],
    path: string,
): void => {
    if (stmt.action === 'fill' || stmt.action === 'type' || stmt.action === 'select') {
        if (!stmt.target) {
            diagnostics.push(createDiagnostic(
                'ERR_DSL_BAD_ACT_ARGS',
                `DSL ${stmt.action} requires a ref target`,
                `${path}.target`,
            ));
            return;
        }
        validateRef(stmt.target, scope, diagnostics, `${path}.target`);
        if (!stmt.value) {
            diagnostics.push(createDiagnostic(
                'ERR_DSL_BAD_ACT_ARGS',
                `DSL ${stmt.action} requires a ref value`,
                `${path}.value`,
            ));
            return;
        }
        validateRef(stmt.value, scope, diagnostics, `${path}.value`);
        return;
    }

    if (stmt.action === 'click') {
        if (!stmt.target) {
            diagnostics.push(createDiagnostic(
                'ERR_DSL_BAD_ACT_ARGS',
                'DSL click requires a ref target',
                `${path}.target`,
            ));
            return;
        }
        validateRef(stmt.target, scope, diagnostics, `${path}.target`);
        if (stmt.value) {
            diagnostics.push(createDiagnostic(
                'ERR_DSL_BAD_ACT_ARGS',
                'DSL click does not accept a value',
                `${path}.value`,
            ));
        }
        return;
    }

    if (stmt.action === 'wait') {
        if (typeof stmt.durationMs !== 'number') {
            diagnostics.push(createDiagnostic(
                'ERR_DSL_BAD_ACT_ARGS',
                'DSL wait requires durationMs',
                `${path}.durationMs`,
            ));
        }
        return;
    }

    if (stmt.target) {
        diagnostics.push(createDiagnostic(
            'ERR_DSL_BAD_ACT_ARGS',
            `DSL ${stmt.action} does not accept a target`,
            `${path}.target`,
        ));
    }
    if (stmt.value) {
        diagnostics.push(createDiagnostic(
            'ERR_DSL_BAD_ACT_ARGS',
            `DSL ${stmt.action} does not accept a value`,
            `${path}.value`,
        ));
    }
};

const validateLinkedEntityAct = (
    stmt: LinkedEntityActStmt,
    scope: ValidateScope,
    diagnostics: DslDiagnostic[],
    path: string,
): void => {
    if (stmt.targetQuery.op !== 'entity.target') {
        diagnostics.push(createDiagnostic(
            'ERR_DSL_BAD_ACT_ARGS',
            'linked entity action requires an entity.target query',
            `${path}.targetQuery`,
        ));
    }
    validateQueryPayload(stmt.targetQuery.payload, scope, diagnostics, `${path}.targetQuery.payload`);
    if (stmt.action === 'click') {
        if (stmt.value) {
            diagnostics.push(createDiagnostic(
                'ERR_DSL_BAD_ACT_ARGS',
                'DSL click does not accept a value',
                `${path}.value`,
            ));
        }
        return;
    }
    if (!stmt.value) {
        diagnostics.push(createDiagnostic(
            'ERR_DSL_BAD_ACT_ARGS',
            `DSL ${stmt.action} requires a value`,
            `${path}.value`,
        ));
        return;
    }
    validateRef(stmt.value, scope, diagnostics, `${path}.value`);
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
            diagnostics.push(createDiagnostic(
                'ERR_DSL_BAD_CHECKPOINT_INPUT',
                `DSL checkpoint input must be a ref: ${key}`,
                `${path}.input.${key}`,
            ));
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
    if (expr.kind === 'querySugar') {
        diagnostics.push(createDiagnostic(
            'ERR_DSL_NOT_NORMALIZED',
            'querySugar must be expanded before validation',
            path,
        ));
        return;
    }
    if (expr.kind === 'entity_query') {
        diagnostics.push(createDiagnostic(
            'ERR_DSL_NOT_LINKED',
            'entity query must be linked before validation',
            path,
        ));
        return;
    }
    if (expr.kind === 'ref') {
        validateRef(expr, scope, diagnostics, path);
        return;
    }
    if (expr.kind === 'compute') {
        validateComputeExpr(expr.expr, scope, diagnostics, path);
        return;
    }
    validateQueryPayload(expr.payload, scope, diagnostics, `${path}.payload`);
};

const validateComputeExpr = (
    expr: ComputeExpr,
    scope: ValidateScope,
    diagnostics: DslDiagnostic[],
    path: string,
): void => {
    const expected = COMPUTE_OP_ARITY[expr.op];
    if (expr.args.length !== expected) {
        diagnostics.push(createDiagnostic(
            'ERR_DSL_BAD_COMPUTE_ARITY',
            `DSL compute ${expr.op} expects ${expected} args`,
            `${path}.expr`,
        ));
    }
    expr.args.forEach((value, index) => {
        validateComputeValue(value, scope, diagnostics, `${path}.args.${index}`);
    });
};

const validateComputeValue = (
    value: ComputeValue,
    scope: ValidateScope,
    diagnostics: DslDiagnostic[],
    path: string,
): void => {
    if ('op' in value) {
        validateComputeExpr(value, scope, diagnostics, path);
        return;
    }
    if ('literal' in value) {return;}
    validateRef({kind: 'ref', ref: value.ref.path}, scope, diagnostics, path);
};

const validateQueryPayload = (
    value: unknown,
    scope: ValidateScope,
    diagnostics: DslDiagnostic[],
    path: string,
): void => {
    if (isRefExpr(value)) {
        validateRef(value, scope, diagnostics, path);
        return;
    }
    if (Array.isArray(value)) {
        value.forEach((item, index) => {validateQueryPayload(item, scope, diagnostics, `${path}.${index}`);});
        return;
    }
    if (!isRecord(value)) {return;}
    for (const [key, item] of Object.entries(value)) {
        validateQueryPayload(item, scope, diagnostics, `${path}.${key}`);
    }
};

const validateRef = (
    expr: RefExpr,
    scope: ValidateScope,
    diagnostics: DslDiagnostic[],
    path: string,
): void => {
    const [root, firstSegment] = expr.ref.split('.');
    if (!root || (!ROOT_REFS.has(root) && !(root === 'failure' && scope.allowFailureRoot))) {
        diagnostics.push(createDiagnostic('ERR_DSL_INVALID_REF_ROOT', `invalid DSL ref root: ${expr.ref}`, path));
        return;
    }
    if (root === 'vars' && (!firstSegment || !scope.vars.has(firstSegment))) {
        diagnostics.push(createDiagnostic(
            'ERR_DSL_VAR_NOT_DEFINED',
            `DSL variable is not defined: ${expr.ref}`,
            path,
        ));
    }
};

const isRefExpr = (value: unknown): value is RefExpr =>
    isRecord(value) && value.kind === 'ref' && typeof value.ref === 'string';

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
