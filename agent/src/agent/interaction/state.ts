import {
    InteractionStateError,
    decisionStatus,
    type InteractionEvent,
    type InteractionRecord,
    type InteractionStatus,
} from './contracts';

export const TERMINAL_STATUSES: ReadonlySet<InteractionStatus> = new Set([
    'approved',
    'denied',
    'answered',
    'resolved',
    'cancelled',
    'expired',
]);

export const isTerminal = (status: InteractionStatus): boolean => TERMINAL_STATUSES.has(status);

const initialStage = (kind: InteractionRecord['kind']): InteractionRecord['stage'] =>
    kind === 'takeover' ? 'offered' : undefined;

export const applyEvent = (record: InteractionRecord, event: InteractionEvent): InteractionRecord => {
    if (event.id !== record.id) {
        throw new InteractionStateError(`event id mismatch: ${event.id} vs ${record.id}`);
    }
    if (event.kind === 'created') {
        throw new InteractionStateError('cannot apply created event to an existing record');
    }
    if (event.revision !== record.revision + 1) {
        throw new InteractionStateError(
            `revision mismatch for ${record.id}: expected ${record.revision + 1}, got ${event.revision}`,
        );
    }
    switch (event.kind) {
        case 'decided': {
            if (record.status !== 'pending') {
                throw new InteractionStateError(`cannot decide interaction in status ${record.status}`);
            }
            if (event.decision.kind === 'returnControl') {
                if (record.kind !== 'takeover') {
                    throw new InteractionStateError('returnControl is only valid for takeover interactions');
                }
                if (record.stage !== 'active') {
                    throw new InteractionStateError('cannot return control before the takeover is active');
                }
            }
            return Object.freeze({
                ...record,
                status: decisionStatus(event.decision),
                decision: event.decision,
                stage: undefined,
                revision: event.revision,
            });
        }
        case 'staged': {
            if (record.status !== 'pending' || record.kind !== 'takeover') {
                throw new InteractionStateError('only a pending takeover interaction can be staged');
            }
            if (event.stage !== 'active') {
                throw new InteractionStateError('a takeover can only move to the active stage');
            }
            if (record.stage === 'active') {
                throw new InteractionStateError('takeover is already active');
            }
            return Object.freeze({
                ...record,
                stage: event.stage,
                revision: event.revision,
            });
        }
        case 'cancelled': {
            if (record.status !== 'pending') {
                throw new InteractionStateError(`cannot cancel interaction in status ${record.status}`);
            }
            return Object.freeze({
                ...record,
                status: 'cancelled',
                decision: Object.freeze({
                    kind: 'cancel' as const,
                    cancelledBy: event.cancelledBy,
                    cancelledAt: event.cancelledAt,
                }),
                revision: event.revision,
            });
        }
        case 'expired': {
            if (record.status !== 'pending') {
                throw new InteractionStateError(`cannot expire interaction in status ${record.status}`);
            }
            return Object.freeze({
                ...record,
                status: 'expired',
                decision: Object.freeze({kind: 'expire' as const, expiredAt: event.expiredAt}),
                revision: event.revision,
            });
        }
    }
};

export const projectRecord = (events: ReadonlyArray<InteractionEvent>): InteractionRecord => {
    if (events.length === 0) {
        throw new InteractionStateError('cannot project from empty event list');
    }
    const first = events[0];
    if (first.kind !== 'created') {
        throw new InteractionStateError('event list must start with created event');
    }
    let record: InteractionRecord = Object.freeze({
        id: first.id,
        runId: first.runId,
        sessionId: first.sessionId,
        kind: first.interactionKind,
        status: 'pending',
        stage: initialStage(first.interactionKind),
        createdAt: first.createdAt,
        deadlineAt: first.deadlineAt,
        revision: first.revision,
        payload: first.payload,
        decision: null,
        ...(first.internal === undefined ? {} : {internal: first.internal}),
    });
    for (let index = 1; index < events.length; index++) {
        record = applyEvent(record, events[index]);
    }
    return record;
};