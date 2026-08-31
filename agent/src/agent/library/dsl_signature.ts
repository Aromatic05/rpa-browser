import {parseDslDocument} from '../../program/dsl/parser';
import type {DslExpr, DslStmt} from '../../program/dsl/ast/types';
import type {ComputeExpr, ComputeValue} from '../../program/compute/types';

export type DslSignature = Readonly<{
    inputs: readonly string[];
    outputs: readonly string[];
}>;

export const signatureForDslSource = (source: string): DslSignature => {
    let program;
    try {
        program = parseDslDocument(source).program;
    } catch {
        return {inputs: Object.freeze([]), outputs: Object.freeze([])};
    }
    const inputs = new Set<string>();
    const outputs: string[] = [];
    visitStatements(program.body, inputs, outputs);
    return {
        inputs: Object.freeze([...inputs].sort()),
        outputs: Object.freeze(outputs),
    };
};

const visitStatements = (
    body: readonly DslStmt[],
    inputs: Set<string>,
    outputs: string[],
): void => {
    for (const stmt of body) {visitStatement(stmt, inputs, outputs);}
};

const visitStatement = (
    stmt: DslStmt,
    inputs: Set<string>,
    outputs: string[],
): void => {
    if (stmt.kind === 'let') {
        visitExpr(stmt.expr, inputs);
        return;
    }
    if (stmt.kind === 'output') {
        outputs.push(stmt.name);
        visitExpr(stmt.expr, inputs);
        return;
    }
    if (stmt.kind === 'ensure') {
        visitExpr(stmt.condition, inputs);
        return;
    }
    if (stmt.kind === 'act') {
        if (stmt.target) {visitExpr(stmt.target, inputs);}
        if (stmt.value) {visitExpr(stmt.value, inputs);}
        return;
    }
    if (stmt.kind === 'entity_act') {
        if (stmt.target.rowValue) {visitExpr(stmt.target.rowValue, inputs);}
        if (stmt.value) {visitExpr(stmt.value, inputs);}
        return;
    }
    if (stmt.kind === 'resolve_act') {
        if (stmt.value) {visitExpr(stmt.value, inputs);}
        return;
    }
    if (stmt.kind === 'linked_entity_act') {
        if (stmt.value) {visitExpr(stmt.value, inputs);}
        return;
    }
    if (stmt.kind === 'form_act' || stmt.kind === 'table_act') {
        if (stmt.value) {visitExpr(stmt.value, inputs);}
        return;
    }
    if (stmt.kind === 'checkpoint') {
        for (const value of Object.values(stmt.input ?? {})) {visitExpr(value, inputs);}
        return;
    }
    if (stmt.kind === 'if') {
        visitExpr(stmt.condition, inputs);
        visitStatements(stmt.then, inputs, outputs);
        if (stmt.else) {visitStatements(stmt.else, inputs, outputs);}
        return;
    }
    visitExpr(stmt.iterable, inputs);
    visitStatements(stmt.body, inputs, outputs);
};

const visitExpr = (expr: DslExpr, inputs: Set<string>): void => {
    if (expr.kind === 'ref') {
        collectInputRef(expr.ref, inputs);
        return;
    }
    if (expr.kind === 'entity_query') {
        if (expr.reference.rowValue) {visitExpr(expr.reference.rowValue, inputs);}
        return;
    }
    if (expr.kind === 'compute') {
        visitCompute(expr.expr, inputs);
    }
};

const visitCompute = (expr: ComputeExpr, inputs: Set<string>): void => {
    for (const value of expr.args) {visitComputeValue(value, inputs);}
};

const visitComputeValue = (value: ComputeValue, inputs: Set<string>): void => {
    if ('ref' in value) {
        collectInputRef(value.ref.path, inputs);
        return;
    }
    if ('op' in value) {
        visitCompute(value, inputs);
    }
};

const collectInputRef = (ref: string, inputs: Set<string>): void => {
    if (!ref.startsWith('input.')) {return;}
    const field = ref.slice('input.'.length);
    const segment = field.split('.')[0];
    if (segment) {inputs.add(segment);}
};