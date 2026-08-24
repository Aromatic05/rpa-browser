import type {ComputeValue} from '../../../program/compute/types';
import type {DslExpr} from '../../../program/dsl/ast/types';

export const collectDslExpressionDependencies = (expr: DslExpr): readonly string[] => {
    const values = new Set<string>();
    if (expr.kind === 'ref') {
        values.add(expr.ref);
    } else if (expr.kind === 'compute') {
        collectComputeDependencies(expr.expr.args, values);
    } else if (expr.kind === 'query') {
        collectPayloadDependencies(expr.payload, values);
    }
    return Object.freeze([...values].sort());
};

export const collectDslExpressionsDependencies = (
    expressions: Iterable<DslExpr>,
): readonly string[] => Object.freeze([
    ...new Set([...expressions].flatMap((expr) => collectDslExpressionDependencies(expr))),
].sort());

const collectComputeDependencies = (values: readonly ComputeValue[], output: Set<string>): void => {
    for (const value of values) {
        if ('ref' in value) {
            output.add(value.ref.path);
        } else if ('op' in value) {
            collectComputeDependencies(value.args, output);
        }
    }
};

const collectPayloadDependencies = (value: unknown, output: Set<string>): void => {
    if (!value || typeof value !== 'object') {return;}
    if (Array.isArray(value)) {
        value.forEach((item) => {collectPayloadDependencies(item, output);});
        return;
    }
    const record = value as Record<string, unknown>;
    if (record.kind === 'ref' && typeof record.ref === 'string') {
        output.add(record.ref);
        return;
    }
    Object.values(record).forEach((item) => {collectPayloadDependencies(item, output);});
};
