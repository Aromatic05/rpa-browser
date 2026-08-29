import {
    InteractionConcurrencyError,
    InteractionStateError,
    InteractionValidationError,
    validateEvidence,
    type InteractionApproveDecision,
    type InteractionDenyDecision,
    type InteractionId,
    type InteractionKind,
    type InteractionRecord,
    type RunId,
    type SanitizedEvidence,
    type SessionId,
} from './contracts';
import {isTerminal} from './state';
import type {InteractionRepository} from './repository';

export type RequestInteractionInput = Readonly<{
    runId: RunId;
    sessionId: SessionId;
    kind: InteractionKind;
    prompt: string;
    evidence: SanitizedEvidence;
    deadlineAt: number;
    createdAt?: number;
}>;

export type InteractionService = Readonly<{
    request: (input: RequestInteractionInput) => InteractionRecord;
    approve: (id: InteractionId, expectedRevision: number, approvedBy: string) => InteractionRecord;
    deny: (id: InteractionId, expectedRevision: number, deniedBy: string, reason: string) => InteractionRecord;
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

const buildApproveDecision = (approvedBy: string, approvedAt: number): InteractionApproveDecision =>
    Object.freeze({kind: 'approve', approvedBy, approvedAt});

const buildDenyDecision = (deniedBy: string, deniedAt: number, reason: string): InteractionDenyDecision =>
    Object.freeze({kind: 'deny', deniedBy, deniedAt, reason});

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

    return {
        request: (input) => {
            validateEvidence(input.evidence);
            const createdAt = input.createdAt ?? now();
            if (input.deadlineAt <= createdAt) {
                throw new InteractionValidationError('deadlineAt must be after createdAt');
            }
            return repository.create({
                runId: input.runId,
                sessionId: input.sessionId,
                kind: input.kind,
                prompt: input.prompt,
                evidence: input.evidence,
                deadlineAt: input.deadlineAt,
                createdAt,
            }).record;
        },
        approve: (id, expectedRevision, approvedBy) => {
            const record = requireExists(id);
            if (record.status === 'approved' && record.decision?.kind === 'approve' && record.decision.approvedBy === approvedBy) {
                return record;
            }
            checkConcurrency(record, expectedRevision);
            if (isTerminal(record.status)) {
                throw new InteractionStateError(`interaction ${id} is already ${record.status}`);
            }
            const approvedAt = now();
            if (approvedAt > record.deadlineAt) {
                return repository.expire(id, expectedRevision, approvedAt);
            }
            return repository.decide(id, expectedRevision, buildApproveDecision(approvedBy, approvedAt));
        },
        deny: (id, expectedRevision, deniedBy, reason) => {
            const record = requireExists(id);
            if (record.status === 'denied' && record.decision?.kind === 'deny' && record.decision.deniedBy === deniedBy && record.decision.reason === reason) {
                return record;
            }
            checkConcurrency(record, expectedRevision);
            if (isTerminal(record.status)) {
                throw new InteractionStateError(`interaction ${id} is already ${record.status}`);
            }
            const deniedAt = now();
            if (deniedAt > record.deadlineAt) {
                return repository.expire(id, expectedRevision, deniedAt);
            }
            return repository.decide(id, expectedRevision, buildDenyDecision(deniedBy, deniedAt, reason));
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
