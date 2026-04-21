import { getLogger } from '../../logging/logger';
import { ensureFreshSnapshot } from '../steps/executors/snapshot/core/session_store';
import { generateSemanticSnapshot } from '../steps/executors/snapshot/pipeline/snapshot';
import { filterFinalEntities } from '../steps/executors/snapshot/core/entity_query';
import type { EntityKind } from '../steps/executors/snapshot/core/types';
import type { Checkpoint, CheckpointCtx, MatchRule } from './types';

const log = getLogger('step');

const TRANSIENT_ERROR_CODES = new Set(['ERR_TIMEOUT']);
const FATAL_ERROR_CODES = new Set(['ERR_BAD_ARGS', 'ERR_INTERNAL']);

let checkpointStore: Checkpoint[] = [];

export const setCheckpoints = (checkpoints: Checkpoint[]) => {
    checkpointStore = [...checkpoints];
};

export const listCheckpoints = (injected?: Checkpoint[]) => (injected ? [...injected] : [...checkpointStore]);

const firstRuleStepName = (checkpoint: Checkpoint) => {
    const matched = (checkpoint.matchRules || checkpoint.policy?.trigger?.matchRules || []).find((rule) => 'stepName' in rule);
    return matched && 'stepName' in matched ? matched.stepName : undefined;
};

const firstRuleErrorCode = (checkpoint: Checkpoint) => {
    const matched = (checkpoint.matchRules || checkpoint.policy?.trigger?.matchRules || []).find((rule) => 'errorCode' in rule);
    return matched && 'errorCode' in matched ? matched.errorCode : undefined;
};

export const maybeEnterCheckpoint = async (ctx: CheckpointCtx): Promise<CheckpointCtx> => {
    const { failedCtx } = ctx;
    const code = failedCtx.rawResult.error?.code;

    if (!failedCtx.checkpointEnabled || failedCtx.inCheckpointFlow || failedCtx.checkpointAttempt >= failedCtx.checkpointMaxAttempts) {
        log.info('checkpoint.enter', { entered: false, reason: 'checkpoint_not_entered', stepId: failedCtx.step.id });
        return { ...ctx, active: false, stopReason: 'checkpoint_not_entered' };
    }

    if (code && (TRANSIENT_ERROR_CODES.has(code) || FATAL_ERROR_CODES.has(code))) {
        log.info('checkpoint.enter', { entered: false, reason: 'checkpoint_not_entered', code, stepId: failedCtx.step.id });
        return { ...ctx, active: false, stopReason: 'checkpoint_not_entered' };
    }

    log.info('checkpoint.enter', { entered: true, stepId: failedCtx.step.id, code });
    return { ...ctx, active: true, meta: { ...(ctx.meta || {}), entered: true } };
};

export const maybePickCheckpoint = async (ctx: CheckpointCtx): Promise<CheckpointCtx> => {
    if (!ctx.active) return ctx;

    const candidates = listCheckpoints(ctx.failedCtx.checkpoints)
        .filter((item) => item.enabled !== false)
        .filter((item) => {
            const scopedStepName = firstRuleStepName(item);
            return !scopedStepName || scopedStepName === ctx.failedCtx.step.name;
        })
        .filter((item) => {
            const scopedErrorCode = firstRuleErrorCode(item);
            return !scopedErrorCode || scopedErrorCode === ctx.failedCtx.rawResult.error?.code;
        })
        .sort((a, b) => (b.priority || 0) - (a.priority || 0));

    for (const candidate of candidates) {
        let hit = true;
        const rules = candidate.matchRules || candidate.policy?.trigger?.matchRules || [];
        for (const rule of rules) {
            if (!(await evalMatchRule(rule, ctx))) {
                hit = false;
                break;
            }
        }
        if (hit) {
            log.info('checkpoint.pick', { checkpointId: candidate.id, checkpointName: candidate.name, stepId: ctx.failedCtx.step.id });
            return { ...ctx, checkpoint: candidate, meta: { ...(ctx.meta || {}), checkpointId: candidate.id } };
        }
    }

    log.info('checkpoint.pick', { checkpointId: null, stepId: ctx.failedCtx.step.id });
    return { ...ctx, active: false, stopReason: 'checkpoint_not_found' };
};

const evalUrlIncludesRule = async (needle: string, ctx: CheckpointCtx): Promise<boolean> => {
    const binding = await ctx.failedCtx.deps.runtime.ensureActivePage(ctx.failedCtx.workspaceId);
    const info = await binding.traceTools['trace.page.getInfo']();
    if (!info.ok) return false;
    return (info.data?.url || '').includes(needle);
};

const evalTextVisibleRule = async (needle: string, ctx: CheckpointCtx): Promise<boolean> => {
    const binding = await ctx.failedCtx.deps.runtime.ensureActivePage(ctx.failedCtx.workspaceId);
    const evaluated = await binding.traceTools['trace.page.evaluate']({
        expression: `({ needle }) => {
            const text = String(needle || '').trim();
            if (!text) return false;
            const isVisible = (el) => {
                if (!(el instanceof Element)) return false;
                const style = window.getComputedStyle(el);
                if (!style) return false;
                if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') <= 0) return false;
                const rect = el.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0;
            };
            const elements = Array.from(document.querySelectorAll('body *'));
            return elements.some((el) => isVisible(el) && (el.textContent || '').includes(text));
        }`,
        arg: { needle },
    });
    return evaluated.ok && evaluated.data === true;
};

const evalEntityExistsRule = async (
    args: { query: string; kind?: EntityKind | EntityKind[]; businessTag?: string | string[] },
    ctx: CheckpointCtx,
): Promise<boolean> => {
    const binding = await ctx.failedCtx.deps.runtime.ensureActivePage(ctx.failedCtx.workspaceId);
    const ensured = await ensureFreshSnapshot(binding, {
        refreshReason: 'checkpoint.match.entityExists',
        collectBaseSnapshot: async (context) =>
            generateSemanticSnapshot(binding.page, {
                captureRuntimeState: context.fromDirty,
                entityRuleConfig: ctx.failedCtx.deps.config.entityRules,
            }),
    });

    const finalEntities = ensured.entry.finalEntityView?.entities || [];
    const filtered = filterFinalEntities(finalEntities, {
        kind: args.kind,
        businessTag: args.businessTag,
        query: args.query,
    });
    return filtered.length > 0;
};

export const evalMatchRule = async (rule: MatchRule, ctx: CheckpointCtx): Promise<boolean> => {
    if ('errorCode' in rule) {
        return ctx.failedCtx.rawResult.error?.code === rule.errorCode;
    }
    if ('stepName' in rule) {
        return ctx.failedCtx.step.name === rule.stepName;
    }
    if ('urlIncludes' in rule) {
        return evalUrlIncludesRule(rule.urlIncludes, ctx);
    }
    if ('textVisible' in rule) {
        return evalTextVisibleRule(rule.textVisible, ctx);
    }
    if ('entityExists' in rule) {
        return evalEntityExistsRule(rule.entityExists, ctx);
    }
    return false;
};
