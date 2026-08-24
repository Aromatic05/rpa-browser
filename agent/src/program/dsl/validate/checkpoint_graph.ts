import type { DslCheckpointProvider } from '../emit';
import { scanDslAssetReferences } from '../asset_references';
import { createDiagnostic, type DslDiagnostic } from '../diagnostics';
import type { Checkpoint } from '../../../runner/checkpoint';
import type { StepResolve } from '../../../runner/steps/types';

const MAX_CHECKPOINT_CALL_DEPTH = 16;

export type ValidateDslCheckpointGraphOptions = {
    callStack?: string[];
    path?: string;
    validateBody?: (input: {
        checkpoint: Checkpoint;
        source: string;
        stepResolves: Record<string, StepResolve>;
    }) => DslDiagnostic[];
};

export const validateDslCheckpointGraph = (
    source: string,
    checkpointProvider: DslCheckpointProvider,
    options: ValidateDslCheckpointGraphOptions = {},
): DslDiagnostic[] => {
    const diagnostics: DslDiagnostic[] = [];
    visitSource(
        source,
        checkpointProvider,
        options.callStack || [],
        options.path || 'body',
        diagnostics,
        options.validateBody,
    );
    return diagnostics;
};

const visitSource = (
    source: string,
    checkpointProvider: DslCheckpointProvider,
    callStack: string[],
    path: string,
    diagnostics: DslDiagnostic[],
    validateBody: ValidateDslCheckpointGraphOptions['validateBody'],
): void => {
    let checkpointIds: string[];
    try {
        checkpointIds = [...scanDslAssetReferences(source).checkpoints].sort();
    } catch (error) {
        diagnostics.push(createDiagnostic(
            'ERR_DSL_CHECKPOINT_BODY_INVALID',
            `checkpoint body DSL is invalid: ${error instanceof Error ? error.message : String(error)}`,
            path,
        ));
        return;
    }

    for (const checkpointId of checkpointIds) {
        const referencePath = `${path}.checkpoint.${checkpointId}`;
        const checkpoint = checkpointProvider.getCheckpoint(checkpointId);
        if (!checkpoint) {
            diagnostics.push(createDiagnostic(
                'ERR_DSL_CHECKPOINT_NOT_FOUND',
                `checkpoint not found: ${checkpointId}`,
                referencePath,
            ));
            continue;
        }
        if (checkpoint.kind && checkpoint.kind !== 'procedure') {
            diagnostics.push(createDiagnostic(
                'ERR_DSL_CHECKPOINT_NOT_CALLABLE',
                `checkpoint is not callable: ${checkpointId}`,
                referencePath,
            ));
            continue;
        }
        if (callStack.includes(checkpointId)) {
            diagnostics.push(createDiagnostic(
                'ERR_DSL_CHECKPOINT_RECURSION',
                `recursive checkpoint call: ${[...callStack, checkpointId].join(' -> ')}`,
                referencePath,
            ));
            continue;
        }
        if (callStack.length >= MAX_CHECKPOINT_CALL_DEPTH) {
            diagnostics.push(createDiagnostic(
                'ERR_DSL_CHECKPOINT_DEPTH',
                `checkpoint call depth exceeded before ${checkpointId}`,
                referencePath,
            ));
            continue;
        }
        if (!checkpoint.body) {continue;}
        const body = checkpointProvider.getCheckpointBody?.(checkpointId);
        if (!body) {
            diagnostics.push(createDiagnostic(
                'ERR_DSL_CHECKPOINT_BODY_MISSING',
                `checkpoint body unavailable: ${checkpointId}`,
                referencePath,
            ));
            continue;
        }
        if (validateBody) {
            try {
                const bodyDiagnostics = validateBody({
                    checkpoint,
                    source: body.source,
                    stepResolves: body.stepResolves,
                });
                diagnostics.push(...bodyDiagnostics.map((diagnostic) => ({
                    ...diagnostic,
                    path: diagnostic.path
                        ? `${referencePath}.${diagnostic.path}`
                        : `${referencePath}.body`,
                })));
            } catch (error) {
                diagnostics.push(createDiagnostic(
                    errorCode(error) || 'ERR_DSL_CHECKPOINT_BODY_INVALID',
                    `checkpoint body DSL is invalid: ${error instanceof Error ? error.message : String(error)}`,
                    `${referencePath}.body`,
                ));
                continue;
            }
        }
        visitSource(
            body.source,
            checkpointProvider,
            [...callStack, checkpointId],
            `${referencePath}.body`,
            diagnostics,
            validateBody,
        );
    }
};

const errorCode = (error: unknown): string | undefined =>
    typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
        ? error.code
        : undefined;
