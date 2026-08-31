import {
    PROGRAM_EXECUTION_IMAGE_SCHEMA,
    PROGRAM_EXECUTION_IMAGE_VERSION,
    type ProgramContinuationError,
    type ProgramExecutionImage,
} from './contracts';

const EFFECT_REVERSIBILITIES = new Set(['unknown', 'reversible', 'compensatable', 'irreversible']);
const STATEMENT_KINDS = new Set([
    'let', 'output', 'ensure', 'act', 'entity_act', 'resolve_act', 'linked_entity_act',
    'form_act', 'table_act', 'checkpoint', 'if', 'for',
]);
const FRAME_KINDS = new Set(['if', 'for', 'checkpoint']);
const PROVENANCE_KINDS = new Set(['query', 'compute', 'ref', 'checkpoint', 'loop']);
const PAUSE_REASONS = new Set(['statement', 'effect', 'barrier', 'failure']);

const invalid = (message: string, details?: unknown): ProgramContinuationError => Object.freeze({
    code: 'ERR_CONTINUATION_INVALID' as const,
    message,
    ...(details === undefined ? {} : {details}),
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
    Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const exactKeys = (
    value: Record<string, unknown>,
    required: readonly string[],
    optional: readonly string[] = [],
): boolean => {
    const keys = Object.keys(value);
    const allowed = new Set([...required, ...optional]);
    return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
        && keys.every((key) => allowed.has(key));
};

const isNonNegativeInteger = (value: unknown): value is number =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0;
const isPositiveInteger = (value: unknown): value is number => isNonNegativeInteger(value) && value > 0;
const isStringArray = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((entry) => typeof entry === 'string');

const isRevision = (value: unknown): boolean => isRecord(value)
    && exactKeys(value, ['pageEpoch', 'captureRevision'])
    && typeof value.pageEpoch === 'string'
    && isNonNegativeInteger(value.captureRevision);

const isDescriptor = (value: unknown): boolean => isRecord(value)
    && exactKeys(value, ['workspaceName', 'tabName', 'pageUrl', 'revision'])
    && typeof value.workspaceName === 'string'
    && typeof value.tabName === 'string'
    && typeof value.pageUrl === 'string'
    && isRevision(value.revision);

const isPageEntry = (value: unknown): boolean => isRecord(value)
    && exactKeys(value, [
        'pageUrl', 'identity', 'refreshReason', 'capture',
        'semanticBindingsByProfile', 'semanticSuggestionsByProfile',
    ])
    && typeof value.pageUrl === 'string'
    && isRevision(value.identity)
    && typeof value.refreshReason === 'string'
    && isRecord(value.capture)
    && isRecord(value.semanticBindingsByProfile)
    && isRecord(value.semanticSuggestionsByProfile);

const isWorldView = (value: unknown): boolean => {
    if (!isRecord(value)
        || !exactKeys(value, ['workspaceName', 'tabName', 'pageUrl', 'revision', 'entry'])
        || !isDescriptor({
            workspaceName: value.workspaceName,
            tabName: value.tabName,
            pageUrl: value.pageUrl,
            revision: value.revision,
        })
        || !isPageEntry(value.entry)) {
        return false;
    }
    const entry = value.entry as Record<string, unknown>;
    return entry.pageUrl === value.pageUrl
        && isRecord(entry.identity)
        && entry.identity.pageEpoch === (value.revision as Record<string, unknown>).pageEpoch
        && entry.identity.captureRevision === (value.revision as Record<string, unknown>).captureRevision;
};

const isSourceLocation = (value: unknown): boolean => isRecord(value)
    && exactKeys(value, ['line', 'column', 'endLine', 'endColumn'])
    && isNonNegativeInteger(value.line)
    && isNonNegativeInteger(value.column)
    && isNonNegativeInteger(value.endLine)
    && isNonNegativeInteger(value.endColumn);

const isLoop = (value: unknown): boolean => isRecord(value)
    && exactKeys(value, ['path', 'iteration'])
    && typeof value.path === 'string'
    && isNonNegativeInteger(value.iteration);

const isLocation = (value: unknown): boolean => isRecord(value)
    && exactKeys(value, ['programId', 'path', 'kind', 'loops', 'callStack'], ['source'])
    && typeof value.programId === 'string'
    && typeof value.path === 'string'
    && typeof value.kind === 'string'
    && STATEMENT_KINDS.has(value.kind)
    && Array.isArray(value.loops)
    && value.loops.every(isLoop)
    && isStringArray(value.callStack)
    && (value.source === undefined || isSourceLocation(value.source));

const isScope = (value: unknown): boolean => isRecord(value)
    && exactKeys(value, ['input', 'vars', 'output'], ['failure'])
    && isRecord(value.input)
    && isRecord(value.vars)
    && isRecord(value.output)
    && (value.failure === undefined || isRecord(value.failure));

const isStatement = (value: unknown): boolean => isRecord(value)
    && typeof value.kind === 'string'
    && STATEMENT_KINDS.has(value.kind);

const isFrame = (value: unknown): boolean => {
    if (!isRecord(value) || typeof value.kind !== 'string' || !FRAME_KINDS.has(value.kind)) {return false;}
    if (value.kind === 'if') {
        return exactKeys(value, [
            'kind', 'statementPath', 'parentBlockPath', 'statementIndex', 'branch',
            'parentScope', 'beforeVars', 'loops',
        ])
            && typeof value.statementPath === 'string'
            && typeof value.parentBlockPath === 'string'
            && isNonNegativeInteger(value.statementIndex)
            && (value.branch === 'then' || value.branch === 'else')
            && isScope(value.parentScope)
            && isStringArray(value.beforeVars)
            && Array.isArray(value.loops) && value.loops.every(isLoop);
    }
    if (value.kind === 'for') {
        return exactKeys(value, [
            'kind', 'statementPath', 'parentBlockPath', 'statementIndex', 'parentScope',
            'item', 'items', 'iteration', 'loops',
        ])
            && typeof value.statementPath === 'string'
            && typeof value.parentBlockPath === 'string'
            && isNonNegativeInteger(value.statementIndex)
            && isScope(value.parentScope)
            && typeof value.item === 'string'
            && Array.isArray(value.items)
            && isNonNegativeInteger(value.iteration)
            && Array.isArray(value.loops) && value.loops.every(isLoop);
    }
    return exactKeys(value, [
        'kind', 'checkpointId', 'invocationId', 'statementPath', 'parentBlockPath',
        'statementIndex', 'parentProgramId', 'parentScope', 'dependencies', 'loops', 'callStack',
    ], ['bind'])
        && typeof value.checkpointId === 'string'
        && typeof value.invocationId === 'string'
        && typeof value.statementPath === 'string'
        && typeof value.parentBlockPath === 'string'
        && isNonNegativeInteger(value.statementIndex)
        && typeof value.parentProgramId === 'string'
        && isScope(value.parentScope)
        && (value.bind === undefined || typeof value.bind === 'string')
        && isStringArray(value.dependencies)
        && Array.isArray(value.loops) && value.loops.every(isLoop)
        && isStringArray(value.callStack);
};

const isSemantics = (value: unknown): boolean => {
    if (!isRecord(value)
        || !exactKeys(value, ['reversibility'], ['source'])
        || typeof value.reversibility !== 'string'
        || !EFFECT_REVERSIBILITIES.has(value.reversibility)) {
        return false;
    }
    if (value.source === undefined) {return true;}
    return isRecord(value.source)
        && exactKeys(value.source, ['kind', 'profileName', 'entityKey', 'memberKind', 'member'])
        && value.source.kind === 'entity_rules'
        && typeof value.source.profileName === 'string'
        && typeof value.source.entityKey === 'string'
        && (value.source.memberKind === 'field' || value.source.memberKind === 'action' || value.source.memberKind === 'rowAction')
        && typeof value.source.member === 'string';
};

const isEffect = (value: unknown): boolean => {
    if (!isRecord(value)
        || !exactKeys(value, ['stepId', 'stepName', 'args', 'semantics'], ['logicalTarget'])
        || typeof value.stepId !== 'string'
        || typeof value.stepName !== 'string'
        || !isSemantics(value.semantics)) {
        return false;
    }
    if (value.logicalTarget === undefined) {return true;}
    return isRecord(value.logicalTarget)
        && exactKeys(value.logicalTarget, ['kind', 'query'], ['resolvedAt'])
        && value.logicalTarget.kind === 'query'
        && isRecord(value.logicalTarget.query)
        && (value.logicalTarget.resolvedAt === undefined || isRevision(value.logicalTarget.resolvedAt));
};

const isOutcome = (value: unknown): boolean => {
    if (!isRecord(value) || typeof value.status !== 'string') {return false;}
    if (value.status === 'succeeded') {return exactKeys(value, ['status']);}
    return value.status === 'failed'
        && exactKeys(value, ['status', 'error'])
        && isRecord(value.error)
        && exactKeys(value.error, ['code', 'message'], ['details'])
        && typeof value.error.code === 'string'
        && typeof value.error.message === 'string';
};

const isCompensationLink = (value: unknown): boolean => isRecord(value)
    && exactKeys(value, ['effectSequence'])
    && isPositiveInteger(value.effectSequence);

const isEffectJournalEntry = (value: unknown, index: number): boolean => {
    if (!isRecord(value)
        || !exactKeys(value, ['record', 'worldBefore', 'worldAfter'])
        || !isWorldView(value.worldBefore)
        || !isWorldView(value.worldAfter)
        || !isRecord(value.record)
        || !exactKeys(value.record, [
            'sequence', 'location', 'effect', 'outcome', 'worldBefore', 'worldAfter',
        ], ['compensates'])
        || value.record.sequence !== index + 1
        || !isLocation(value.record.location)
        || !isEffect(value.record.effect)
        || !isOutcome(value.record.outcome)
        || !isDescriptor(value.record.worldBefore)
        || !isDescriptor(value.record.worldAfter)
        || (value.record.compensates !== undefined && !isCompensationLink(value.record.compensates))) {
        return false;
    }
    return descriptorMatchesWorld(value.record.worldBefore, value.worldBefore)
        && descriptorMatchesWorld(value.record.worldAfter, value.worldAfter);
};

const descriptorMatchesWorld = (descriptor: unknown, world: unknown): boolean => {
    if (!isRecord(descriptor) || !isRecord(world) || !isRecord(descriptor.revision) || !isRecord(world.revision)) {return false;}
    return descriptor.workspaceName === world.workspaceName
        && descriptor.tabName === world.tabName
        && descriptor.pageUrl === world.pageUrl
        && descriptor.revision.pageEpoch === world.revision.pageEpoch
        && descriptor.revision.captureRevision === world.revision.captureRevision;
};

const isSavepoint = (value: unknown): boolean => isRecord(value)
    && exactKeys(value, ['id', 'effectSequence', 'world'], ['name'])
    && typeof value.id === 'string'
    && (value.name === undefined || typeof value.name === 'string')
    && isNonNegativeInteger(value.effectSequence)
    && isDescriptor(value.world);

const isTransactionSavepoint = (value: unknown): boolean => isRecord(value)
    && exactKeys(value, ['savepoint', 'world', 'visible'])
    && isSavepoint(value.savepoint)
    && isWorldView(value.world)
    && typeof value.visible === 'boolean'
    && isRecord(value.savepoint)
    && descriptorMatchesWorld(value.savepoint.world, value.world);

const isProvenance = (value: unknown): boolean => {
    if (!isRecord(value)
        || !exactKeys(value, ['target', 'location', 'source'])
        || typeof value.target !== 'string'
        || !isLocation(value.location)
        || !isRecord(value.source)
        || typeof value.source.kind !== 'string'
        || !PROVENANCE_KINDS.has(value.source.kind)
        || !isStringArray(value.source.dependencies)) {
        return false;
    }
    switch (value.source.kind) {
        case 'query':
            return typeof value.source.stepId === 'string'
                && isRecord(value.source.expression)
                && (value.source.query === undefined || isRecord(value.source.query))
                && (value.source.observedAt === undefined || isRevision(value.source.observedAt));
        case 'compute':
            return isRecord(value.source.expression);
        case 'ref':
            return typeof value.source.ref === 'string';
        case 'checkpoint':
            return typeof value.source.checkpointId === 'string';
        case 'loop':
            return isRecord(value.source.expression) && isNonNegativeInteger(value.source.iteration);
        default:
            return false;
    }
};

const isExecutionSavepointState = (value: unknown): boolean => isRecord(value)
    && exactKeys(value, ['savepoint', 'reason', 'location', 'scope', 'frames', 'historySequence', 'world'])
    && isSavepoint(value.savepoint)
    && typeof value.reason === 'string' && PAUSE_REASONS.has(value.reason)
    && isLocation(value.location)
    && isScope(value.scope)
    && Array.isArray(value.frames) && value.frames.every(isFrame)
    && isNonNegativeInteger(value.historySequence)
    && isDescriptor(value.world);

const isExecutionSavepoint = (value: unknown): boolean => isRecord(value)
    && exactKeys(value, ['state', 'provenance', 'origin'])
    && isExecutionSavepointState(value.state)
    && Array.isArray(value.provenance) && value.provenance.every(isProvenance)
    && (value.origin === 'automatic' || value.origin === 'explicit');

const isHistoryRecord = (value: unknown): boolean => isRecord(value)
    && exactKeys(value, ['sequence', 'location', 'statement'])
    && isPositiveInteger(value.sequence)
    && isLocation(value.location)
    && isStatement(value.statement);

const isImport = (value: unknown): boolean => isRecord(value)
    && typeof value.kind === 'string'
    && (value.kind === 'entity_rules'
        ? exactKeys(value, ['kind', 'profileName', 'alias'])
            && typeof value.profileName === 'string' && typeof value.alias === 'string'
        : value.kind === 'resolves'
            && exactKeys(value, ['kind', 'bundleName', 'alias'])
            && typeof value.bundleName === 'string' && typeof value.alias === 'string');

const isProgramStatement = (value: unknown): boolean => isRecord(value)
    && exactKeys(value, ['path', 'statement'], ['source'])
    && typeof value.path === 'string'
    && isStatement(value.statement)
    && (value.source === undefined || isSourceLocation(value.source));

const isProgram = (value: unknown): boolean => isRecord(value)
    && exactKeys(value, ['programId', 'source', 'imports', 'statements'])
    && typeof value.programId === 'string'
    && typeof value.source === 'string'
    && Array.isArray(value.imports) && value.imports.every(isImport)
    && Array.isArray(value.statements) && value.statements.every(isProgramStatement);

const isDebugOptions = (value: unknown): boolean => {
    if (!isRecord(value)
        || !exactKeys(value, [], [
            'initialMode', 'breakpoints', 'breakBeforeEffects', 'breakOnFailure',
            'barrierOn', 'barrierResumeMode',
        ])) {
        return false;
    }
    return (value.initialMode === undefined || value.initialMode === 'continue' || value.initialMode === 'step')
        && (value.breakpoints === undefined || isStringArray(value.breakpoints))
        && (value.breakBeforeEffects === undefined || typeof value.breakBeforeEffects === 'boolean')
        && (value.breakOnFailure === undefined || typeof value.breakOnFailure === 'boolean')
        && (value.barrierOn === undefined || (Array.isArray(value.barrierOn)
            && value.barrierOn.every((item) => typeof item === 'string' && EFFECT_REVERSIBILITIES.has(item))))
        && (value.barrierResumeMode === undefined || value.barrierResumeMode === 'continue' || value.barrierResumeMode === 'step');
};

const sameLocation = (left: unknown, right: unknown): boolean => {
    try {return JSON.stringify(left) === JSON.stringify(right);} catch {return false;}
};

const validateCore = (value: Record<string, unknown>): string | null => {
    if (!exactKeys(value, [
        'schema', 'version', 'mainSource', 'debug', 'active', 'journal', 'transaction',
        'transactionEffectStartSequence', 'recoveryAttempts', 'executionSavepoints', 'provenance',
        'statementHistory', 'programs',
    ], ['latestEffectRollbackSavepointId'])) {return 'image fields are missing or unknown';}
    if (value.schema !== PROGRAM_EXECUTION_IMAGE_SCHEMA) {return 'unknown continuation image schema';}
    if (value.version !== PROGRAM_EXECUTION_IMAGE_VERSION) {return 'unknown continuation image version';}
    if (typeof value.mainSource !== 'string' || value.mainSource.trim().length === 0) {return 'mainSource must be a non-empty string';}
    if (!isDebugOptions(value.debug)) {return 'debug options are invalid';}

    if (!isRecord(value.active) || !exactKeys(value.active, [
        'continuationId', 'location', 'scope', 'frames', 'statementEvent', 'effect', 'view',
    ], ['effectResolvedAt', 'automaticSavepointId', 'rollbackSavepointId'])) {return 'active barrier is invalid';}
    if (typeof value.active.continuationId !== 'string' || value.active.continuationId.length === 0
        || !isLocation(value.active.location)
        || !isScope(value.active.scope)
        || !Array.isArray(value.active.frames) || !value.active.frames.every(isFrame)
        || !isEffect(value.active.effect)
        || !isWorldView(value.active.view)
        || (value.active.effectResolvedAt !== undefined && !isDescriptor(value.active.effectResolvedAt))
        || (value.active.automaticSavepointId !== undefined && typeof value.active.automaticSavepointId !== 'string')
        || (value.active.rollbackSavepointId !== undefined && typeof value.active.rollbackSavepointId !== 'string')) {
        return 'active barrier fields are invalid';
    }
    if (!isRecord(value.active.statementEvent)
        || !exactKeys(value.active.statementEvent, ['location', 'scope', 'statement', 'frames'])
        || !isLocation(value.active.statementEvent.location)
        || !isScope(value.active.statementEvent.scope)
        || !isStatement(value.active.statementEvent.statement)
        || !Array.isArray(value.active.statementEvent.frames)
        || !value.active.statementEvent.frames.every(isFrame)
        || !sameLocation(value.active.statementEvent.location, value.active.location)) {
        return 'active statement event is invalid';
    }

    if (!isRecord(value.journal)
        || !exactKeys(value.journal, ['entries'])
        || !Array.isArray(value.journal.entries)
        || !value.journal.entries.every(isEffectJournalEntry)) {
        return 'effect journal is invalid';
    }

    if (!isRecord(value.transaction)
        || !exactKeys(value.transaction, ['id', 'baseline', 'savepoints'])
        || typeof value.transaction.id !== 'string'
        || !isWorldView(value.transaction.baseline)
        || !Array.isArray(value.transaction.savepoints)
        || !value.transaction.savepoints.every(isTransactionSavepoint)) {
        return 'transaction is invalid';
    }

    if (!isNonNegativeInteger(value.transactionEffectStartSequence)
        || value.transactionEffectStartSequence > value.journal.entries.length) {
        return 'transaction effect sequence is invalid';
    }
    if (!isRecord(value.recoveryAttempts)
        || !Object.values(value.recoveryAttempts).every((attempts) => isRecord(attempts)
            && Object.values(attempts).every((count) => isPositiveInteger(count)))) {
        return 'recovery attempt state is invalid';
    }
    if (value.latestEffectRollbackSavepointId !== undefined && typeof value.latestEffectRollbackSavepointId !== 'string') {
        return 'latest rollback savepoint id is invalid';
    }
    if (!Array.isArray(value.executionSavepoints) || !value.executionSavepoints.every(isExecutionSavepoint)
        || !Array.isArray(value.provenance) || !value.provenance.every(isProvenance)
        || !Array.isArray(value.statementHistory) || !value.statementHistory.every(isHistoryRecord)
        || !Array.isArray(value.programs) || !value.programs.every(isProgram)) {
        return 'continuation collections are invalid';
    }

    const journalSequences = new Set(value.journal.entries.map((entry) => (entry as Record<string, unknown>).record)
        .filter(isRecord).map((record) => record.sequence));
    for (const entry of value.journal.entries) {
        const record = (entry as Record<string, unknown>).record as Record<string, unknown>;
        if (isRecord(record.compensates) && !journalSequences.has(record.compensates.effectSequence)) {
            return 'effect journal compensation link is invalid';
        }
    }

    const transactionIds = new Set(value.transaction.savepoints.map((entry) =>
        ((entry as Record<string, unknown>).savepoint as Record<string, unknown>).id));
    if (value.latestEffectRollbackSavepointId !== undefined && !transactionIds.has(value.latestEffectRollbackSavepointId)) {
        return 'latest rollback savepoint does not exist';
    }
    if (value.active.rollbackSavepointId !== undefined && !transactionIds.has(value.active.rollbackSavepointId)) {
        return 'active rollback savepoint does not exist';
    }
    if (value.active.automaticSavepointId !== undefined && !transactionIds.has(value.active.automaticSavepointId)) {
        return 'active automatic savepoint does not exist';
    }
    const executionIds = value.executionSavepoints.map((entry) =>
        (((entry as Record<string, unknown>).state as Record<string, unknown>).savepoint as Record<string, unknown>).id);
    if (new Set(executionIds).size !== executionIds.length
        || executionIds.some((id) => !transactionIds.has(id))) {
        return 'execution savepoint references are invalid';
    }

    const programIds = value.programs.map((program) => (program as Record<string, unknown>).programId);
    if (new Set(programIds).size !== programIds.length || !programIds.includes('main')) {
        return 'program views are invalid';
    }
    const historySequences = value.statementHistory.map((entry) => (entry as Record<string, unknown>).sequence);
    if (historySequences.some((sequence, index) => sequence !== index + 1)) {
        return 'statement history sequence is invalid';
    }
    return null;
};

export const jsonRoundTripProgramExecutionImage = (
    image: ProgramExecutionImage,
): {ok: true; image: ProgramExecutionImage} | {ok: false; error: ProgramContinuationError} => {
    try {
        const json = JSON.stringify(image);
        if (json === undefined) {return {ok: false, error: invalid('continuation image is not JSON serializable')};}
        return parseProgramExecutionImage(JSON.parse(json));
    } catch (error) {
        return {ok: false, error: invalid('continuation image is not JSON serializable', String(error))};
    }
};

export const parseProgramExecutionImage = (
    input: unknown,
): {ok: true; image: ProgramExecutionImage} | {ok: false; error: ProgramContinuationError} => {
    if (!isRecord(input)) {return {ok: false, error: invalid('continuation image must be an object')};}
    const problem = validateCore(input);
    if (problem) {return {ok: false, error: invalid(problem)};}
    return {ok: true, image: structuredClone(input) as ProgramExecutionImage};
};
