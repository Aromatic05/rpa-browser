import type {
    DslBeforeStatementEvent,
    DslEffectDescriptor,
    DslExecutionFrameSnapshot,
    DslScopeSnapshot,
    DslStatementLocation,
    DslValueProvenanceEvent,
} from '../../automation/dsl/debug/contracts';
import type {DebugEffectJournalState} from '../debug/effects/contracts';
import type {DebugStatementExecutionRecord} from '../debug/history/contracts';
import type {DebugProgramView} from '../debug/program/view';
import type {DebugTransactionState} from '../debug/transaction/contracts';
import type {DebugExecutionSavepoint, DslDebugExecutionSession, PausedDslDebugExecution} from '../debug/execution/contracts';
import type {WorldView} from '../worldview/contracts';
import type {CreateDslDebugControllerOptions} from '../../automation/dsl/debug/controller';

export const PROGRAM_EXECUTION_IMAGE_SCHEMA = 'rpa.program-execution-image';
export const PROGRAM_EXECUTION_IMAGE_VERSION = 1;

export type ProgramExecutionImageV1 = Readonly<{
    schema: typeof PROGRAM_EXECUTION_IMAGE_SCHEMA;
    version: typeof PROGRAM_EXECUTION_IMAGE_VERSION;
    mainSource: string;
    debug: CreateDslDebugControllerOptions;
    active: Readonly<{
        continuationId: string;
        location: DslStatementLocation;
        scope: DslScopeSnapshot;
        frames: readonly DslExecutionFrameSnapshot[];
        statementEvent: DslBeforeStatementEvent;
        effect: DslEffectDescriptor;
        view: WorldView;
        effectResolvedAt?: PausedDslDebugExecution['world'];
        automaticSavepointId?: string;
        rollbackSavepointId?: string;
    }>;
    journal: DebugEffectJournalState;
    transaction: DebugTransactionState;
    transactionEffectStartSequence: number;
    recoveryAttempts: Readonly<Record<string, Readonly<Record<string, number>>>>;
    latestEffectRollbackSavepointId?: string;
    executionSavepoints: readonly Readonly<{
        state: DebugExecutionSavepoint;
        provenance: readonly DslValueProvenanceEvent[];
        origin: 'automatic' | 'explicit';
    }>[];
    provenance: readonly DslValueProvenanceEvent[];
    statementHistory: readonly DebugStatementExecutionRecord[];
    programs: readonly DebugProgramView[];
}>;

export type ProgramExecutionImage = ProgramExecutionImageV1;

export type ProgramContinuationErrorCode =
    | 'ERR_CONTINUATION_WORLD_CONFLICT'
    | 'ERR_CONTINUATION_UNSUPPORTED'
    | 'ERR_CONTINUATION_INVALID';

export type ProgramContinuationError = Readonly<{
    code: ProgramContinuationErrorCode;
    message: string;
    details?: unknown;
}>;

export type ProgramExecutionImageExportResult =
    | Readonly<{ok: true; image: ProgramExecutionImage}>
    | Readonly<{ok: false; error: ProgramContinuationError}>;

export type ProgramExecutionRehydrateResult =
    | Readonly<{
        ok: true;
        session: DslDebugExecutionSession;
        pause: Extract<PausedDslDebugExecution, {reason: 'barrier'}>;
    }>
    | Readonly<{ok: false; error: ProgramContinuationError}>;
