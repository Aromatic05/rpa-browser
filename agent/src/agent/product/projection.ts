import type {
    InteractionRecord,
} from '../interaction/contracts';
import type {SessionSnapshot} from '../service/session/types';
import {encodeInteractionToken} from './token';
import type {
    AgentTaskStatus,
    AgentTaskView,
    ClarificationCardSchema,
    ProductInteractionCard,
} from './types';

export const ORPHAN_PAUSE_ERROR_CODE = 'ERR_ORPHAN_PAUSE';

const DEFAULT_PROMPT_SUMMARY_LENGTH = 200;

export const titleFromPrompt = (prompt: string): string => {
    const firstLine = prompt.split('\n')[0]?.trim() ?? '';
    if (firstLine.length === 0) {return 'Untitled task';}
    return firstLine.length <= 64 ? firstLine : `${firstLine.slice(0, 64)}…`;
};

export const promptSummaryFrom = (prompt: string, maxLength = DEFAULT_PROMPT_SUMMARY_LENGTH): string => {
    const trimmed = prompt.trim().replace(/\s+/gu, ' ');
    return trimmed.length <= maxLength ? trimmed : `${trimmed.slice(0, maxLength)}…`;
};

/** Truthful lifecycle mapping. A `paused` session is `waiting_for_user` only
 *  while it has at least one pending interaction; a paused session without a
 *  resolvable interaction must never project as a healthy wait and is mapped to
 *  `failed` (orphan). */
export const deriveTaskStatus = (
    snapshot: SessionSnapshot,
    interactions: ReadonlyArray<InteractionRecord>,
): AgentTaskStatus => {
    switch (snapshot.state) {
        case 'running': return 'running';
        case 'paused': {
            const pending = interactions.some((record) => record.status === 'pending');
            return pending ? 'waiting_for_user' : 'failed';
        }
        case 'completed': return 'completed';
        case 'failed': return 'failed';
        case 'cancelled': return 'cancelled';
        case 'interrupted': return 'interrupted';
    }
};

const clarificationSchema = (record: InteractionRecord): ClarificationCardSchema => {
    if (record.payload.kind !== 'clarification') {return {field: '', type: 'text'};}
    const schema = record.payload.schema;
    return Object.freeze({
        field: schema.field,
        type: schema.type,
        ...(schema.allowed === undefined ? {} : {allowed: schema.allowed}),
        ...(schema.min === undefined ? {} : {min: schema.min}),
        ...(schema.max === undefined ? {} : {max: schema.max}),
        ...(schema.maxLength === undefined ? {} : {maxLength: schema.maxLength}),
        ...(schema.default === undefined ? {} : {default: schema.default}),
    });
};

export const projectInteractionCard = (record: InteractionRecord): ProductInteractionCard => {
    const token = encodeInteractionToken(record.id, record.revision);
    switch (record.payload.kind) {
        case 'approval':
            return Object.freeze({
                kind: 'approval',
                interactionToken: token,
                actionName: record.payload.actionName,
                summary: record.payload.summary,
                risk: record.payload.risk,
                deadlineAt: record.deadlineAt,
            });
        case 'clarification':
            return Object.freeze({
                kind: 'clarification',
                interactionToken: token,
                question: record.payload.question,
                schema: clarificationSchema(record),
                deadlineAt: record.deadlineAt,
            });
        case 'recovery_decision':
            return Object.freeze({
                kind: 'recovery_decision',
                interactionToken: token,
                failureSummary: record.payload.failureSummary,
                options: record.payload.options,
                deadlineAt: record.deadlineAt,
            });
        case 'takeover':
            return Object.freeze({
                kind: 'takeover',
                interactionToken: token,
                reason: record.payload.reason,
                scope: record.payload.scope,
                stage: record.stage === 'active' ? 'active' : 'offered',
                guidanceModes: record.payload.guidanceModes,
                ...(record.payload.teachKind === undefined ? {} : {teachKind: record.payload.teachKind}),
                deadlineAt: record.deadlineAt,
            });
    }
};

export type ProjectAgentTaskViewInput = Readonly<{
    taskId: string;
    snapshot: SessionSnapshot;
    interactions: ReadonlyArray<InteractionRecord>;
    lastSeq: number;
}>;

export const projectAgentTaskView = (input: ProjectAgentTaskViewInput): AgentTaskView => {
    const {taskId, snapshot, interactions, lastSeq} = input;
    const status = deriveTaskStatus(snapshot, interactions);
    const pending = interactions.find((record) => record.status === 'pending');
    const resultError = snapshot.error;

    const view: AgentTaskView = Object.freeze({
        taskId,
        status,
        ...(status === 'waiting_for_user' ? {phase: 'interacting' as const} : {}),
        ...(pending ? {interaction: projectInteractionCard(pending)} : {}),
        title: titleFromPrompt(snapshot.request.prompt),
        promptSummary: promptSummaryFrom(snapshot.request.prompt),
        ...(status === 'completed'
            ? {result: {outcome: 'completed' as const, summary: snapshot.result?.text ?? 'Task completed'}}
            : {}),
        ...(status === 'failed'
            ? {
                result: {
                    outcome: 'failed' as const,
                    summary: resultError?.message ?? 'Task failed',
                },
                error: {
                    code: resultError?.code ?? 'ERR_SESSION_FAILED',
                    message: resultError?.message ?? 'Task failed',
                },
            }
            : {}),
        ...(status === 'cancelled'
            ? {
                result: {outcome: 'cancelled' as const, summary: 'You stopped this task.'},
                error: {
                    code: resultError?.code ?? 'ERR_SESSION_CANCELLED',
                    message: resultError?.message ?? 'You stopped this task.',
                },
            }
            : {}),
        ...(status === 'interrupted'
            ? {
                result: {outcome: 'interrupted' as const, summary: resultError?.message ?? 'Task interrupted'},
                error: {
                    code: resultError?.code ?? 'ERR_SESSION_INTERRUPTED',
                    message: resultError?.message ?? 'Task interrupted and is not resumable',
                },
            }
            : {}),
        reportAvailable: snapshot.reportAvailable,
        resumable: snapshot.resumable,
        createdAt: snapshot.createdAt,
        endedAt: snapshot.endedAt,
        lastSeq,
    });
    return view;
};