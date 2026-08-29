import {ActionError, ERROR_CODES} from '../../interface/actions/results';
import {DslValidationError} from '../../program/dsl/diagnostics';
import type {StepResolve} from '../runner/steps/types';
import {validateStepResolveFileForSerialization} from '../runner/serialization/types';
import type {Workflow, WorkflowDsl} from '../workflow';
import type {DslCheckpointProvider} from './emit';
import {createDslResolveResolver, type DslEntityRulesResolver, type DslResolveResolver} from './link';
import {validateDslSource} from './runtime';
import {validateDslCheckpointGraph} from './validate';

export type SaveWorkflowDslInput = Readonly<{
    workflow: Workflow;
    checkpointProvider: DslCheckpointProvider;
    entityRulesResolver?: DslEntityRulesResolver;
    dslName: string;
    content: string;
    stepResolves?: Record<string, StepResolve>;
    expectedRevision?: string | null;
}>;

export const saveWorkflowDsl = (input: SaveWorkflowDslInput): WorkflowDsl => {
    const stepResolves = input.stepResolves === undefined
        ? existingDslResolves(input.workflow, input.dslName)
        : validateStepResolves(input.stepResolves);
    const resolveResolver = createDslResolveResolver(
        input.workflow,
        new Map([[input.dslName, stepResolves]]),
    );
    validateSourceForSave(
        input.content,
        input.checkpointProvider,
        input.entityRulesResolver,
        resolveResolver,
    );
    const saved = input.workflow.save(
        {kind: 'dsl', name: input.dslName, content: input.content, stepResolves},
        {expectedRevision: input.expectedRevision},
    );
    if (saved.kind !== 'dsl') {
        throw new ActionError(ERROR_CODES.ERR_INTERNAL, 'unexpected DSL artifact kind after save');
    }
    return saved;
};

const validateSourceForSave = (
    source: string,
    checkpointProvider: DslCheckpointProvider,
    entityRulesResolver: DslEntityRulesResolver | undefined,
    resolveResolver: DslResolveResolver,
): void => {
    const validation = validateDslSource(source, entityRulesResolver, resolveResolver);
    if (validation.diagnostics.length > 0) {throw new DslValidationError(validation.diagnostics);}
    const checkpointDiagnostics = validateDslCheckpointGraph(source, checkpointProvider, {
        validateBody: ({checkpoint, source: bodySource, stepResolves}) => validateDslSource(
            bodySource,
            entityRulesResolver,
            withCheckpointResolveBundle(resolveResolver, checkpoint.id, stepResolves),
        ).diagnostics,
    });
    if (checkpointDiagnostics.length > 0) {throw new DslValidationError(checkpointDiagnostics);}
};

const withCheckpointResolveBundle = (
    base: DslResolveResolver,
    checkpointId: string,
    stepResolves: Record<string, StepResolve>,
): DslResolveResolver => ({
    resolveBundle: (name) => name === checkpointId
        ? {resolves: stepResolves, diagnostics: []}
        : base.resolveBundle(name),
});

const existingDslResolves = (workflow: Workflow, dslName: string): Record<string, StepResolve> => {
    const existing = workflow.get(dslName, {kind: 'dsl'});
    return existing?.kind === 'dsl' ? structuredClone(existing.stepResolves) : {};
};

const validateStepResolves = (value: unknown): Record<string, StepResolve> => {
    try {
        const resolves = structuredClone(value) as Record<string, StepResolve>;
        validateStepResolveFileForSerialization({version: 1, resolves});
        return resolves;
    } catch (error) {
        throw new ActionError(
            ERROR_CODES.ERR_WORKFLOW_BAD_ARGS,
            `invalid DSL resolve sidecar: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
};
