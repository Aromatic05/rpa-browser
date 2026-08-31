import type {CheckpointRuntimeSnapshotImage} from '../../automation/runner/checkpoint/runtime_snapshot';
import {parseCheckpointRuntimeSnapshotImage} from '../../automation/runner/checkpoint/runtime_snapshot';
import {parseProgramExecutionImage} from './image';
import type {ProgramContinuationErrorCode, ProgramExecutionImage} from './contracts';

export const WORKSPACE_CONTINUATION_IMAGE_SCHEMA = 'rpa.workspace-continuation';
export const WORKSPACE_CONTINUATION_IMAGE_VERSION = 1 as const;

export type WorkspaceContinuationImage = Readonly<{
    schema: typeof WORKSPACE_CONTINUATION_IMAGE_SCHEMA;
    version: typeof WORKSPACE_CONTINUATION_IMAGE_VERSION;
    workspaceName: string;
    program: Readonly<{source: string; input: Readonly<Record<string, unknown>>}>;
    execution: ProgramExecutionImage;
    runtime: CheckpointRuntimeSnapshotImage;
}>;

export type WorkspaceContinuationParseResult =
    | Readonly<{ok: true; image: WorkspaceContinuationImage}>
    | Readonly<{
        ok: false;
        error: Readonly<{code: ProgramContinuationErrorCode; message: string}>;
    }>;

const record = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const exactKeys = (
    value: Record<string, unknown>,
    required: readonly string[],
): boolean => {
    const allowed = new Set(required);
    const keys = Object.keys(value);
    return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
        && keys.every((key) => allowed.has(key));
};

const invalid = (message: string): WorkspaceContinuationParseResult => ({
    ok: false,
    error: {code: 'ERR_CONTINUATION_INVALID', message},
});

export const parseWorkspaceContinuationImage = (
    value: unknown,
): WorkspaceContinuationParseResult => {
    if (!record(value) || !exactKeys(value, [
        'schema', 'version', 'workspaceName', 'program', 'execution', 'runtime',
    ])) {
        return invalid('workspace continuation fields are missing or unknown');
    }
    if (value.schema !== WORKSPACE_CONTINUATION_IMAGE_SCHEMA
        || value.version !== WORKSPACE_CONTINUATION_IMAGE_VERSION) {
        return invalid('workspace continuation schema/version is unsupported');
    }
    if (typeof value.workspaceName !== 'string' || value.workspaceName.length === 0) {
        return invalid('workspace continuation workspaceName is invalid');
    }
    if (!record(value.program)
        || !exactKeys(value.program, ['source', 'input'])
        || typeof value.program.source !== 'string'
        || !record(value.program.input)) {
        return invalid('workspace continuation program is invalid');
    }
    if (!record(value.execution) || !record(value.runtime)) {
        return invalid('workspace continuation nested images are invalid');
    }

    const execution = parseProgramExecutionImage(value.execution);
    if (!execution.ok) {return {ok: false, error: execution.error};}
    const runtime = parseCheckpointRuntimeSnapshotImage(value.runtime);
    if (!runtime.ok) {return invalid(runtime.error);}

    try {
        const programInput = JSON.parse(JSON.stringify(value.program.input)) as unknown;
        if (!record(programInput)) {
            return invalid('workspace continuation program input is not JSON-safe');
        }
        const image: WorkspaceContinuationImage = Object.freeze({
            schema: WORKSPACE_CONTINUATION_IMAGE_SCHEMA,
            version: WORKSPACE_CONTINUATION_IMAGE_VERSION,
            workspaceName: value.workspaceName,
            program: Object.freeze({
                source: value.program.source,
                input: Object.freeze(programInput),
            }),
            execution: execution.image,
            runtime: runtime.image,
        });
        return {ok: true, image};
    } catch {
        return invalid('workspace continuation image is not JSON-safe');
    }
};

export const jsonRoundTripWorkspaceContinuationImage = (
    image: WorkspaceContinuationImage,
): WorkspaceContinuationParseResult => {
    try {
        return parseWorkspaceContinuationImage(JSON.parse(JSON.stringify(image)));
    } catch {
        return invalid('workspace continuation image is not JSON-safe');
    }
};
