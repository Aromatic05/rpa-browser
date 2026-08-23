import type {DslScope} from '../runtime/scope';
import type {DslScopeSnapshot} from './contracts';

export const snapshotDslScope = (scope: DslScope): DslScopeSnapshot => deepFreeze(structuredClone({
    input: scope.input,
    ...(scope.failure ? {failure: scope.failure} : {}),
    vars: scope.vars,
    output: scope.output,
}));

const deepFreeze = <T>(value: T): T => {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) {return value;}
    for (const child of Object.values(value as Record<string, unknown>)) {deepFreeze(child);}
    return Object.freeze(value);
};
