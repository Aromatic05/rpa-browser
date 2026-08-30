import {
    InteractionConcurrencyError,
    InteractionStateError,
    newInteractionId,
    type InteractionCancelledEvent,
    type InteractionCreatedEvent,
    type InteractionDecidedEvent,
    type InteractionDecision,
    type InteractionEvent,
    type InteractionExpiredEvent,
    type InteractionId,
    type InteractionInternal,
    type InteractionKind,
    type InteractionPayload,
    type InteractionRecord,
    type InteractionStagedEvent,
    type RunId,
    type SessionId,
} from './contracts';
import {projectRecord} from './state';

export type CreateInteractionInput = Readonly<{
    runId: RunId;
    sessionId: SessionId;
    kind: InteractionKind;
    payload: InteractionPayload;
    deadlineAt: number;
    createdAt: number;
    internal?: InteractionInternal;
}>;

export type InteractionRepository = Readonly<{
    create: (input: CreateInteractionInput) => {record: InteractionRecord; event: InteractionCreatedEvent};
    get: (id: InteractionId) => InteractionRecord | null;
    getEvents: (id: InteractionId) => ReadonlyArray<InteractionEvent> | null;
    list: () => ReadonlyArray<InteractionRecord>;
    listByRun: (runId: RunId) => ReadonlyArray<InteractionRecord>;
    listBySession: (sessionId: SessionId) => ReadonlyArray<InteractionRecord>;
    decide: (
        id: InteractionId,
        expectedRevision: number,
        decision: InteractionDecision,
    ) => InteractionRecord;
    stage: (id: InteractionId, expectedRevision: number, stage: 'active') => InteractionRecord;
    cancel: (id: InteractionId, expectedRevision: number, cancelledBy: string, cancelledAt: number) => InteractionRecord;
    expire: (id: InteractionId, expectedRevision: number, expiredAt: number) => InteractionRecord;
    projectFromEvents: (events: ReadonlyArray<InteractionEvent>) => InteractionRecord;
}>;

const assertFound = (events: ReadonlyArray<InteractionEvent> | undefined, id: InteractionId) => {
    if (!events) {
        throw new InteractionStateError(`interaction not found: ${id}`);
    }
    return events;
};

const assertRevision = (record: InteractionRecord, expectedRevision: number) => {
    if (record.revision !== expectedRevision) {
        throw new InteractionConcurrencyError(
            `stale revision for ${record.id}: expected ${expectedRevision}, got ${record.revision}`,
        );
    }
};

const assertPending = (record: InteractionRecord, operation: string) => {
    if (record.status !== 'pending') {
        throw new InteractionStateError(
            `cannot ${operation} interaction ${record.id} in status ${record.status}`,
        );
    }
};

export type InteractionRepositoryOptions = Readonly<{
    initial?: ReadonlyArray<ReadonlyArray<InteractionEvent>>;
}>;

export const createInteractionRepository = (options: InteractionRepositoryOptions = {}): InteractionRepository => {
    const log = new Map<InteractionId, Array<InteractionEvent>>();

    if (options.initial) {
        for (const events of options.initial) {
            if (events.length === 0) {continue;}
            const record = projectRecord(events);
            log.set(record.id, [...events]);
        }
    }

    const append = (id: InteractionId, event: InteractionEvent): InteractionRecord => {
        const events = log.get(id);
        if (!events) {
            throw new InteractionStateError(`interaction not found: ${id}`);
        }
        events.push(event);
        return projectRecord(events);
    };

    return {
        create: (input) => {
            const id = newInteractionId();
            const event: InteractionCreatedEvent = Object.freeze({
                kind: 'created',
                id,
                runId: input.runId,
                sessionId: input.sessionId,
                interactionKind: input.kind,
                createdAt: input.createdAt,
                deadlineAt: input.deadlineAt,
                payload: input.payload,
                ...(input.internal === undefined ? {} : {internal: input.internal}),
                revision: 0,
            });
            log.set(id, [event]);
            return {record: projectRecord([event]), event};
        },
        get: (id) => {
            const events = log.get(id);
            return events ? projectRecord(events) : null;
        },
        getEvents: (id) => {
            const events = log.get(id);
            return events ? Object.freeze([...events]) : null;
        },
        list: () => Array.from(log.values(), (events) => projectRecord(events)),
        listByRun: (runId) =>
            Array.from(log.values())
                .map((events) => projectRecord(events))
                .filter((record) => record.runId === runId),
        listBySession: (sessionId) =>
            Array.from(log.values())
                .map((events) => projectRecord(events))
                .filter((record) => record.sessionId === sessionId),
        decide: (id, expectedRevision, decision) => {
            const events = assertFound(log.get(id), id);
            const record = projectRecord(events);
            assertRevision(record, expectedRevision);
            assertPending(record, 'decide');
            const event: InteractionDecidedEvent = Object.freeze({
                kind: 'decided',
                id,
                decision,
                revision: record.revision + 1,
            });
            return append(id, event);
        },
        stage: (id, expectedRevision, stage) => {
            const events = assertFound(log.get(id), id);
            const record = projectRecord(events);
            assertRevision(record, expectedRevision);
            assertPending(record, 'stage');
            if (record.kind !== 'takeover') {
                throw new InteractionStateError(`only takeover interactions can be staged, got ${record.kind}`);
            }
            const event: InteractionStagedEvent = Object.freeze({
                kind: 'staged',
                id,
                stage,
                revision: record.revision + 1,
            });
            return append(id, event);
        },
        cancel: (id, expectedRevision, cancelledBy, cancelledAt) => {
            const events = assertFound(log.get(id), id);
            const record = projectRecord(events);
            assertRevision(record, expectedRevision);
            assertPending(record, 'cancel');
            const event: InteractionCancelledEvent = Object.freeze({
                kind: 'cancelled',
                id,
                cancelledBy,
                cancelledAt,
                revision: record.revision + 1,
            });
            return append(id, event);
        },
        expire: (id, expectedRevision, expiredAt) => {
            const events = assertFound(log.get(id), id);
            const record = projectRecord(events);
            assertRevision(record, expectedRevision);
            assertPending(record, 'expire');
            const event: InteractionExpiredEvent = Object.freeze({
                kind: 'expired',
                id,
                expiredAt,
                revision: record.revision + 1,
            });
            return append(id, event);
        },
        projectFromEvents: (events) => projectRecord(events),
    };
};