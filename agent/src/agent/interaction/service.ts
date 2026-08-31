import {
    InteractionConcurrencyError,
    InteractionStateError,
    InteractionValidationError,
    checkClarificationAnswer,
    validateInteractionPayload,
    type GuidanceMode,
    type InteractionDecision,
    type InteractionId,
    type InteractionInternal,
    type InteractionKind,
    type InteractionPayload,
    type InteractionRecord,
    type RunId,
    type SessionId,
} from './contracts';
import {isTerminal} from './state';
import type {InteractionRepository} from './repository';

export type RequestInteractionInput = Readonly<{
    runId: RunId;
    sessionId: SessionId;
    kind: InteractionKind;
    payload: InteractionPayload;
    deadlineAt: number;
    createdAt?: number;
    internal?: InteractionInternal;
}>;

export type InteractionService = Readonly<{
    request: (input: RequestInteractionInput) => InteractionRecord;
    approve: (id: InteractionId, expectedRevision: number, approvedBy: string) => InteractionRecord;
    deny: (
        id: InteractionId,
        expectedRevision: number,
        deniedBy: string,
        reason: string,
        requestedAlternative?: string,
    ) => InteractionRecord;
    answer: (id: InteractionId, expectedRevision: number, answeredBy: string, value: unknown) => InteractionRecord;
    choose: (
        id: InteractionId,
        expectedRevision: number,
        chosenBy: string,
        optionId: string,
    ) => InteractionRecord;
    beginGuidance: (
        id: InteractionId,
        expectedRevision: number,
        actor: string,
        mode: GuidanceMode,
    ) => InteractionRecord;
    returnControl: (
        id: InteractionId,
        expectedRevision: number,
        actor: string,
        mode: GuidanceMode,
        savedReference?: string,
    ) => InteractionRecord;
    cancel: (id: InteractionId, expectedRevision: number, cancelledBy: string) => InteractionRecord;
    expire: (id: InteractionId, expectedRevision: number) => InteractionRecord;
    get: (id: InteractionId) => InteractionRecord | null;
    listByRun: (runId: RunId) => ReadonlyArray<InteractionRecord>;
    listBySession: (sessionId: SessionId) => ReadonlyArray<InteractionRecord>;
}>;

export type InteractionServiceOptions = Readonly<{
    repository: InteractionRepository;
    now?: () => number;
}>;

export const createInteractionService = (options: InteractionServiceOptions): InteractionService => {
    const repository = options.repository;
    const now = options.now ?? Date.now;

    const requireExists = (id: InteractionId): InteractionRecord => {
        const record = repository.get(id);
        if (!record) {
            throw new InteractionStateError(`interaction not found: ${id}`);
        }
        return record;
    };

    const checkConcurrency = (record: InteractionRecord, expectedRevision: number): void => {
        if (record.revision !== expectedRevision) {
            throw new InteractionConcurrencyError(
                `stale revision for ${record.id}: expected ${expectedRevision}, got ${record.revision}`,
            );
        }
    };

    const decide = (
        id: InteractionId,
        expectedRevision: number,
        build: (at: number) => InteractionDecision,
        options: {duringActiveGuidance?: boolean} = {},
    ): InteractionRecord => {
        const record = requireExists(id);
        checkConcurrency(record, expectedRevision);
        if (isTerminal(record.status)) {
            throw new InteractionStateError(`interaction ${id} is already ${record.status}`);
        }
        if (record.stage === 'active' && !options.duringActiveGuidance) {
            throw new InteractionStateError(`interaction ${id} is under active human guidance; resolve guidance first`);
        }
        const at = now();
        if (at > record.deadlineAt) {
            return repository.expire(id, expectedRevision, at);
        }
        return repository.decide(id, expectedRevision, build(at));
    };

    return {
        request: (input) => {
            const payload = validateInteractionPayload(input.payload);
            const createdAt = input.createdAt ?? now();
            if (input.deadlineAt <= createdAt) {
                throw new InteractionValidationError('deadlineAt must be after createdAt');
            }
            return repository.create({
                runId: input.runId,
                sessionId: input.sessionId,
                kind: input.kind,
                payload,
                deadlineAt: input.deadlineAt,
                createdAt,
                ...(input.internal === undefined ? {} : {internal: input.internal}),
            }).record;
        },
        approve: (id, expectedRevision, _approvedBy) => {
            const record = requireExists(id);
            if (record.status === 'approved' && record.decision?.kind === 'approve') {
                return record;
            }
            if (record.payload.kind !== 'approval') {
                throw new InteractionValidationError(`resolution is not valid for interaction kind ${record.kind}`);
            }
            return decide(id, expectedRevision, (at) => ({kind: 'approve', approvedAt: at}));
        },
        deny: (id, expectedRevision, deniedBy, reason, requestedAlternative) => {
            const record = requireExists(id);
            if (record.status === 'denied' && record.decision?.kind === 'deny') {
                return record;
            }
            if (reason.trim().length === 0) {
                throw new InteractionValidationError('deny reason is required');
            }
            if (record.payload.kind !== 'approval') {
                throw new InteractionValidationError(`resolution is not valid for interaction kind ${record.kind}`);
            }
            return decide(id, expectedRevision, (at) => ({
                kind: 'deny',
                deniedAt: at,
                reason,
                ...(requestedAlternative === undefined ? {} : {requestedAlternative}),
            }));
        },
        answer: (id, expectedRevision, answeredBy, value) => {
            const record = requireExists(id);
            if (record.payload.kind !== 'clarification') {
                throw new InteractionValidationError(`resolution is not valid for interaction kind ${record.kind}`);
            }
            const schema = record.payload.schema;
            const checked = checkClarificationAnswer(schema, value);
            if (!checked.ok) {
                throw new InteractionValidationError(checked.error);
            }
            return decide(id, expectedRevision, (at) => ({kind: 'answer', answeredAt: at, value: checked.value}));
        },
        choose: (id, expectedRevision, chosenBy, optionId) => {
            const record = requireExists(id);
            if (record.payload.kind !== 'recovery_decision') {
                throw new InteractionValidationError(`resolution is not valid for interaction kind ${record.kind}`);
            }
            const option = record.payload.options.find((candidate) => candidate.id === optionId);
            if (!option) {
                throw new InteractionValidationError(`unknown recovery option: ${optionId}`);
            }
            if (!option.eligible) {
                throw new InteractionValidationError(`recovery option ${optionId} is not eligible`);
            }
            return decide(id, expectedRevision, (at) => ({kind: 'choose', chosenAt: at, optionId}));
        },
        beginGuidance: (id, expectedRevision, actor, mode) => {
            const record = requireExists(id);
            if (record.payload.kind !== 'takeover') {
                throw new InteractionValidationError(`resolution is not valid for interaction kind ${record.kind}`);
            }
            if (!record.payload.guidanceModes.includes(mode)) {
                throw new InteractionValidationError(`guidance mode ${mode} is not offered by this takeover`);
            }
            if (isTerminal(record.status)) {
                throw new InteractionStateError(`interaction ${id} is already ${record.status}`);
            }
            checkConcurrency(record, expectedRevision);
            if (record.stage === 'active') {
                return record;
            }
            const at = now();
            if (at > record.deadlineAt) {
                return repository.expire(id, expectedRevision, at);
            }
            return repository.stage(id, expectedRevision, 'active');
        },
        returnControl: (id, expectedRevision, actor, mode, savedReference) => {
            const record = requireExists(id);
            if (record.payload.kind !== 'takeover') {
                throw new InteractionValidationError(`resolution is not valid for interaction kind ${record.kind}`);
            }
            if (!record.payload.guidanceModes.includes(mode)) {
                throw new InteractionValidationError(`guidance mode ${mode} is not offered by this takeover`);
            }
            return decide(id, expectedRevision, (at) => ({
                kind: 'returnControl',
                returnedAt: at,
                mode,
                ...(savedReference === undefined ? {} : {savedReference}),
            }), {duringActiveGuidance: true});
        },
        cancel: (id, expectedRevision, cancelledBy) => {
            const record = requireExists(id);
            if (record.status === 'cancelled' && record.decision?.kind === 'cancel' && record.decision.cancelledBy === cancelledBy) {
                return record;
            }
            checkConcurrency(record, expectedRevision);
            if (isTerminal(record.status)) {
                throw new InteractionStateError(`interaction ${id} is already ${record.status}`);
            }
            return repository.cancel(id, expectedRevision, cancelledBy, now());
        },
        expire: (id, expectedRevision) => {
            const record = requireExists(id);
            if (record.status === 'expired') {
                return record;
            }
            if (record.stage === 'active') {
                return record;
            }
            checkConcurrency(record, expectedRevision);
            if (isTerminal(record.status)) {
                throw new InteractionStateError(`interaction ${id} is already ${record.status}`);
            }
            return repository.expire(id, expectedRevision, now());
        },
        get: (id) => repository.get(id),
        listByRun: (runId) => repository.listByRun(runId),
        listBySession: (sessionId) => repository.listBySession(sessionId),
    };
};