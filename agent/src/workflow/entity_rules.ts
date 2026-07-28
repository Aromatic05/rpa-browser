import { DslRuntimeError } from '../dsl/diagnostics/errors';
import type { WorkflowCodec } from './store';

export type WorkflowEntityRules = {
    kind: 'entity_rules';
    name: string;
    match: unknown;
    annotation: unknown;
};

const notImplemented = (): never => {
    throw new DslRuntimeError(
        'Snapshot V2 entity_rules workflow artifacts are not implemented',
        'ERR_ENTITY_RULES_NOT_IMPLEMENTED',
    );
};

export const createEntityRulesCodec = (_workflowName: string): WorkflowCodec<WorkflowEntityRules> => ({
    kind: 'entity_rules',
    is: (value: unknown): value is WorkflowEntityRules => {
        const record = value as Partial<WorkflowEntityRules>;
        return Boolean(record)
            && record.kind === 'entity_rules'
            && typeof record.name === 'string'
            && record.name.trim().length > 0;
    },
    load: () => notImplemented(),
    list: () => notImplemented(),
    save: () => notImplemented(),
    delete: () => notImplemented(),
});

export const toEntityRuleBundle = (_value: WorkflowEntityRules): never => notImplemented();
