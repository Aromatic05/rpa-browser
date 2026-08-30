/**
 * Bounded typed ProductCommand envelope and its single pure dispatcher.
 *
 * The verbs mirror the extension product request surface exactly. Both the WS
 * `agent.product` Action plane and any future adapter route through
 * `dispatchProductCommand` against ONE ProductController, so event/read
 * cursors stay coherent regardless of which transport issued the command.
 */
import type {GuidanceMode, TeachKind} from '../interaction/contracts';
import {ProductCommandError, type ProductController} from './controller';

export type ProductCommand =
    | {verb: 'workspaceView'}
    | {verb: 'listTasks'}
    | {verb: 'startTask'; prompt: string}
    | {verb: 'taskView'; taskId: string}
    | {verb: 'events'; taskId: string; afterSeq: number}
    | {verb: 'stopTask'; taskId: string}
    | {verb: 'approve'; taskId: string; interactionToken: string}
    | {verb: 'deny'; taskId: string; interactionToken: string; reason: string; requestedAlternative?: string}
    | {verb: 'answer'; taskId: string; interactionToken: string; value: unknown}
    | {verb: 'recovery'; taskId: string; interactionToken: string; optionId: string}
    | {verb: 'takeover'; taskId: string; interactionToken: string; mode: GuidanceMode}
    | {verb: 'returnControl'; taskId: string; interactionToken: string; mode: GuidanceMode; savedReference?: string}
    | {verb: 'beginAuthoring'; activity: 'teach'; teachKind: TeachKind}
    | {verb: 'beginAuthoring'; activity: 'annotate'}
    | {verb: 'endAuthoring'; outcome: 'saved' | 'discarded'}
    | {verb: 'librarySummary'};

const GUIDANCE_MODES = new Set<string>(['manual', 'teach', 'annotate']);
const TEACH_KINDS = new Set<string>(['procedure', 'recovery', 'demonstration']);
const AUTHORING_OUTCOMES = new Set<string>(['saved', 'discarded']);

/** additionalProperties:false for the wire envelope: every verb declares its
 *  exact accepted fields; anything else fails closed. */
const PRODUCT_COMMAND_FIELDS: Record<ProductCommand['verb'], ReadonlySet<string>> = {
    workspaceView: new Set(['verb']),
    listTasks: new Set(['verb']),
    startTask: new Set(['verb', 'prompt']),
    taskView: new Set(['verb', 'taskId']),
    events: new Set(['verb', 'taskId', 'afterSeq']),
    stopTask: new Set(['verb', 'taskId']),
    approve: new Set(['verb', 'taskId', 'interactionToken']),
    deny: new Set(['verb', 'taskId', 'interactionToken', 'reason', 'requestedAlternative']),
    answer: new Set(['verb', 'taskId', 'interactionToken', 'value']),
    recovery: new Set(['verb', 'taskId', 'interactionToken', 'optionId']),
    takeover: new Set(['verb', 'taskId', 'interactionToken', 'mode']),
    returnControl: new Set(['verb', 'taskId', 'interactionToken', 'mode', 'savedReference']),
    beginAuthoring: new Set(['verb', 'activity', 'teachKind']),
    endAuthoring: new Set(['verb', 'outcome']),
    librarySummary: new Set(['verb']),
};

function reject(message: string): never {
    throw new ProductCommandError('ERR_BAD_ARGS', message);
}

function asRecord(value: unknown): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        reject('product command must be an object with a verb');
    }
    return value as Record<string, unknown>;
}

function requireText(record: Record<string, unknown>, field: string): string {
    const raw = record[field];
    if (typeof raw !== 'string' || raw.trim().length === 0) {
        reject(`${field} must be a non-empty string`);
    }
    return raw.trim();
}

function optionalText(record: Record<string, unknown>, field: string): string | undefined {
    const raw = record[field];
    if (raw === undefined) {return undefined;}
    if (typeof raw !== 'string') {reject(`${field} must be a string`);}
    return raw;
}

function requireGuidanceMode(record: Record<string, unknown>): GuidanceMode {
    const mode = requireText(record, 'mode');
    if (!GUIDANCE_MODES.has(mode)) {reject("mode must be 'manual', 'teach' or 'annotate'");}
    return mode as GuidanceMode;
}

/** Strictly parses an untrusted payload into the bounded ProductCommand union.
 *  Malformed verbs/fields fail closed with a product/action bad-args error. */
export const parseProductCommand = (value: unknown): ProductCommand => {
    const record = asRecord(value);
    if (typeof record.verb !== 'string' || record.verb.trim().length === 0) {
        reject('product command verb is required');
    }
    const allowedFields = PRODUCT_COMMAND_FIELDS[record.verb as ProductCommand['verb']];
    if (allowedFields === undefined) {
        reject(`unsupported product command verb: ${record.verb}`);
    }
    for (const key of Object.keys(record)) {
        if (!allowedFields.has(key)) {
            reject(`unexpected field '${key}' for product command '${record.verb}'`);
        }
    }
    switch (record.verb) {
        case 'workspaceView':
            return {verb: 'workspaceView'};
        case 'listTasks':
            return {verb: 'listTasks'};
        case 'librarySummary':
            return {verb: 'librarySummary'};
        case 'startTask': {
            if ('provider' in record || 'model' in record) {
                reject('startTask must not carry provider/model; the product surface resolves them from workspace defaults');
            }
            return {verb: 'startTask', prompt: requireText(record, 'prompt')};
        }
        case 'taskView':
            return {verb: 'taskView', taskId: requireText(record, 'taskId')};
        case 'stopTask':
            return {verb: 'stopTask', taskId: requireText(record, 'taskId')};
        case 'events': {
            const afterSeq = record.afterSeq ?? 0;
            if (typeof afterSeq !== 'number' || !Number.isInteger(afterSeq) || afterSeq < 0) {
                reject('afterSeq must be a non-negative integer');
            }
            return {verb: 'events', taskId: requireText(record, 'taskId'), afterSeq};
        }
        case 'approve':
            return {verb: 'approve', taskId: requireText(record, 'taskId'), interactionToken: requireText(record, 'interactionToken')};
        case 'deny': {
            const requestedAlternative = optionalText(record, 'requestedAlternative');
            return {
                verb: 'deny',
                taskId: requireText(record, 'taskId'),
                interactionToken: requireText(record, 'interactionToken'),
                reason: requireText(record, 'reason'),
                ...(requestedAlternative === undefined ? {} : {requestedAlternative}),
            };
        }
        case 'answer':
            return {verb: 'answer', taskId: requireText(record, 'taskId'), interactionToken: requireText(record, 'interactionToken'), value: record.value};
        case 'recovery':
            return {
                verb: 'recovery',
                taskId: requireText(record, 'taskId'),
                interactionToken: requireText(record, 'interactionToken'),
                optionId: requireText(record, 'optionId'),
            };
        case 'takeover':
            return {
                verb: 'takeover',
                taskId: requireText(record, 'taskId'),
                interactionToken: requireText(record, 'interactionToken'),
                mode: requireGuidanceMode(record),
            };
        case 'returnControl': {
            const savedReference = optionalText(record, 'savedReference');
            return {
                verb: 'returnControl',
                taskId: requireText(record, 'taskId'),
                interactionToken: requireText(record, 'interactionToken'),
                mode: requireGuidanceMode(record),
                ...(savedReference === undefined ? {} : {savedReference}),
            };
        }
        case 'beginAuthoring': {
            const activity = requireText(record, 'activity');
            if (activity === 'annotate') {
                if (record.teachKind !== undefined) {reject('annotate authoring must not carry teachKind');}
                return {verb: 'beginAuthoring', activity: 'annotate'};
            }
            if (activity === 'teach') {
                const teachKind = requireText(record, 'teachKind');
                if (!TEACH_KINDS.has(teachKind)) {
                    reject("teachKind must be 'procedure', 'recovery' or 'demonstration'");
                }
                return {verb: 'beginAuthoring', activity: 'teach', teachKind: teachKind as TeachKind};
            }
            return reject("activity must be 'teach' or 'annotate'");
        }
        case 'endAuthoring': {
            const outcome = requireText(record, 'outcome');
            if (!AUTHORING_OUTCOMES.has(outcome)) {reject("outcome must be 'saved' or 'discarded'");}
            return {verb: 'endAuthoring', outcome: outcome as 'saved' | 'discarded'};
        }
        default:
            return reject(`unsupported product command verb: ${record.verb}`);
    }
};

const requireTaskView = <T extends {taskId: string} | null>(view: T, taskId: string): NonNullable<T> => {
    if (view === null) {
        throw new ProductCommandError('ERR_NOT_FOUND', `task not found: ${taskId}`);
    }
    return view;
};

/** The single pure dispatch entry: parse (fail-closed) then route onto the
 *  injected controller. No transport, no state, no second event log. */
export const dispatchProductCommand = async (
    product: ProductController,
    command: unknown,
): Promise<unknown> => {
    const parsed = parseProductCommand(command);
    switch (parsed.verb) {
        case 'workspaceView':
            return product.workspaceView();
        case 'listTasks':
            return product.listTasks();
        case 'startTask':
            return requireTaskView(product.startTask({prompt: parsed.prompt}), 'new task');
        case 'taskView':
            return requireTaskView(product.taskView(parsed.taskId), parsed.taskId);
        case 'events':
            return product.events(parsed.taskId, parsed.afterSeq);
        case 'stopTask':
            return requireTaskView(product.stopTask({taskId: parsed.taskId}), parsed.taskId);
        case 'approve':
            return requireTaskView(
                await product.approveTask({taskId: parsed.taskId, interactionToken: parsed.interactionToken}),
                parsed.taskId,
            );
        case 'deny':
            return requireTaskView(
                await product.denyTask({
                    taskId: parsed.taskId,
                    interactionToken: parsed.interactionToken,
                    reason: parsed.reason,
                    ...(parsed.requestedAlternative === undefined ? {} : {requestedAlternative: parsed.requestedAlternative}),
                }),
                parsed.taskId,
            );
        case 'answer':
            return requireTaskView(
                await product.answerTask({
                    taskId: parsed.taskId,
                    interactionToken: parsed.interactionToken,
                    value: parsed.value,
                }),
                parsed.taskId,
            );
        case 'recovery':
            return requireTaskView(
                await product.chooseRecoveryTask({
                    taskId: parsed.taskId,
                    interactionToken: parsed.interactionToken,
                    optionId: parsed.optionId,
                }),
                parsed.taskId,
            );
        case 'takeover':
            return requireTaskView(
                product.beginGuidanceTask({
                    taskId: parsed.taskId,
                    interactionToken: parsed.interactionToken,
                    mode: parsed.mode,
                }),
                parsed.taskId,
            );
        case 'returnControl':
            return requireTaskView(
                await product.returnControlTask({
                    taskId: parsed.taskId,
                    interactionToken: parsed.interactionToken,
                    mode: parsed.mode,
                    ...(parsed.savedReference === undefined ? {} : {savedReference: parsed.savedReference}),
                }),
                parsed.taskId,
            );
        case 'beginAuthoring':
            return product.beginAuthoring(
                parsed.activity === 'teach'
                    ? {activity: 'teach', teachKind: parsed.teachKind}
                    : {activity: 'annotate'},
            );
        case 'endAuthoring':
            return product.endAuthoring({outcome: parsed.outcome});
        case 'librarySummary': {
            const summary = await product.librarySummary();
            if (summary === null) {
                throw new ProductCommandError('ERR_NOT_FOUND', 'library projection is unavailable on this workspace service');
            }
            return summary;
        }
    }
};
