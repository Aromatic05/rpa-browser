import { getLogger } from '../../logging/logger';
import type { StepUnion } from '../steps/types';
import type { CheckpointCtx } from './types';

const log = getLogger('step');

const resolvePath = (bag: Record<string, unknown>, path: string): unknown => {
    const keys = path.split('.').filter(Boolean);
    let cursor: unknown = bag;
    for (const key of keys) {
        if (!cursor || typeof cursor !== 'object' || !(key in (cursor as Record<string, unknown>))) {
            throw new Error(`missing bind variable: ${path}`);
        }
        cursor = (cursor as Record<string, unknown>)[key];
    }
    return cursor;
};

const bindString = (value: string, bag: Record<string, unknown>): unknown => {
    const fullMatch = value.match(/^\s*\{\{\s*([\w.]+)\s*\}\}\s*$/);
    if (fullMatch) {
        return resolvePath(bag, fullMatch[1]);
    }

    if (!value.includes('{{')) {
        return value;
    }

    return value.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_chunk, token: string) => {
        const resolved = resolvePath(bag, token);
        return typeof resolved === 'string' ? resolved : JSON.stringify(resolved);
    });
};

const bindValue = (value: unknown, bag: Record<string, unknown>): unknown => {
    if (typeof value === 'string') {
        return bindString(value, bag);
    }
    if (Array.isArray(value)) {
        return value.map((item) => bindValue(item, bag));
    }
    if (value && typeof value === 'object') {
        const next: Record<string, unknown> = {};
        for (const [key, val] of Object.entries(value)) {
            next[key] = bindValue(val, bag);
        }
        return next;
    }
    return value;
};

export const maybeBindCheckpoint = async (ctx: CheckpointCtx): Promise<CheckpointCtx> => {
    if (!ctx.active || !ctx.checkpoint) return ctx;
    if (!ctx.checkpoint.content || ctx.checkpoint.content.length === 0) return ctx;

    const hasActionModel = ctx.checkpoint.content.some((item) => item && typeof item === 'object' && 'type' in item);
    if (hasActionModel || ctx.checkpoint.prepare || ctx.checkpoint.output || ctx.checkpoint.kind === 'procedure') {
        return ctx;
    }

    const bag: Record<string, unknown> = {
        run: {
            id: ctx.failedCtx.runId,
            workspaceId: ctx.failedCtx.workspaceId,
        },
        failed: {
            stepId: ctx.failedCtx.step.id,
            stepName: ctx.failedCtx.step.name,
            errorCode: ctx.failedCtx.rawResult.error?.code,
            errorMessage: ctx.failedCtx.rawResult.error?.message,
            url: ctx.failedCtx.currentUrl,
        },
    };

    try {
        const boundContent = ctx.checkpoint.content.map((item) => ({
            ...item,
            args: bindValue((item as StepUnion).args, bag) as StepUnion['args'],
        })) as StepUnion[];
        log.info('checkpoint.bind', { checkpointId: ctx.checkpoint.id, ok: true });
        return { ...ctx, boundContent };
    } catch (error) {
        log.warning('checkpoint.bind', { checkpointId: ctx.checkpoint.id, ok: false, error: String(error) });
        return {
            ...ctx,
            active: false,
            stopReason: 'checkpoint_bind_failed',
            runResult: {
                stepId: ctx.failedCtx.step.id,
                ok: false,
                error: {
                    code: 'ERR_CHECKPOINT_BIND_FAILED',
                    message: error instanceof Error ? error.message : 'checkpoint bind failed',
                },
            },
        };
    }
};
