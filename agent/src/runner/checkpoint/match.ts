import { getLogger } from '../../logging/logger';
import { ensureFreshPageSession } from '../session/capture';
import { buildPageSessionEntityView, filterPageSessionEntities } from '../session/entity_view';
import type { EntityKind } from '../steps/types';
import type {StepEntityRulesControl} from '../../snapshot/rules/model';
import {visibleTextEvaluation} from '../page/visible_text';
import { getCheckpointMatchRules, isAutomaticRecoveryCheckpoint, type Checkpoint, type CheckpointCtx, type MatchRule } from './types';

const log = getLogger('step');
const getCheckpointBinding = async (ctx: CheckpointCtx) => {
    const workspace = ctx.failedCtx.deps.resolveWorkspace(ctx.failedCtx.workspaceName);
    const tabName = workspace.tabs.getActiveTab()?.name;
    if (!tabName) {
        throw new Error(`active tab not found: ${ctx.failedCtx.workspaceName}`);
    }
    return await ctx.failedCtx.deps.runtime.awaitExecutableTab({
        workspace,
        pageRegistry: workspace.browserSession.pageRegistry,
        tabName,
        timeoutMs: ctx.failedCtx.deps.config.waitPolicy.pageReadyTimeoutMs,
    });
};


const FATAL_ERROR_CODES = new Set(['ERR_BAD_ARGS', 'ERR_INTERNAL']);

const firstRuleStepName = (checkpoint: Checkpoint) => {
    const matched = getCheckpointMatchRules(checkpoint).find((rule) => 'stepName' in rule);
    return matched && 'stepName' in matched ? matched.stepName : undefined;
};

const firstRuleErrorCode = (checkpoint: Checkpoint) => {
    const matched = getCheckpointMatchRules(checkpoint).find((rule) => 'errorCode' in rule);
    return matched && 'errorCode' in matched ? matched.errorCode : undefined;
};

export const maybeEnterCheckpoint = async (ctx: CheckpointCtx): Promise<CheckpointCtx> => {
    const { failedCtx } = ctx;
    const code = failedCtx.rawResult.error?.code;

    if (!failedCtx.checkpointEnabled || failedCtx.inCheckpointFlow) {
        log.info('checkpoint.enter', { entered: false, reason: 'checkpoint_not_entered', stepId: failedCtx.step.id });
        return { ...ctx, active: false, stopReason: 'checkpoint_not_entered' };
    }

    if (code && FATAL_ERROR_CODES.has(code)) {
        log.info('checkpoint.enter', { entered: false, reason: 'checkpoint_not_entered', code, stepId: failedCtx.step.id });
        return { ...ctx, active: false, stopReason: 'checkpoint_not_entered' };
    }

    log.info('checkpoint.enter', { entered: true, stepId: failedCtx.step.id, code });
    return { ...ctx, active: true, meta: { ...(ctx.meta || {}), entered: true } };
};

export const maybePickCheckpoint = async (ctx: CheckpointCtx): Promise<CheckpointCtx> => {
    if (!ctx.active) {return ctx;}

    const candidates = [...(ctx.failedCtx.checkpoints || [])]
        .filter(isAutomaticRecoveryCheckpoint)
        .filter((item) => item.enabled !== false)
        .filter((item) => checkpointAttemptFor(ctx, item.id) < getEffectiveCheckpointMaxAttempts(item, ctx.failedCtx.checkpointMaxAttempts))
        .filter((item) => {
            const scopedStepName = firstRuleStepName(item);
            return !scopedStepName || scopedStepName === ctx.failedCtx.step.name;
        })
        .filter((item) => {
            const scopedErrorCode = firstRuleErrorCode(item);
            return !scopedErrorCode || scopedErrorCode === ctx.failedCtx.rawResult.error?.code;
        })
        .sort((a, b) => (b.priority || 0) - (a.priority || 0));

    log.info('checkpoint.candidates', {
        stepId: ctx.failedCtx.step.id,
        count: candidates.length,
        checkpointIds: candidates.map((candidate) => candidate.id),
    });

    for (const candidate of candidates) {
        let hit = true;
        const rules = getCheckpointMatchRules(candidate);
        for (const rule of rules) {
            if (!(await evalMatchRule(rule, ctx, candidate.trigger?.entityRules))) {
                hit = false;
                break;
            }
        }
        if (hit) {
            log.info('checkpoint.pick', { checkpointId: candidate.id, checkpointName: candidate.name, stepId: ctx.failedCtx.step.id });
            return {
                ...ctx,
                checkpoint: candidate,
                meta: {
                    ...(ctx.meta || {}),
                    checkpointId: candidate.id,
                    checkpointAttempt: checkpointAttemptFor(ctx, candidate.id),
                },
            };
        }
    }

    log.info('checkpoint.pick', { checkpointId: null, stepId: ctx.failedCtx.step.id });
    return { ...ctx, active: false, stopReason: 'checkpoint_not_found' };
};

const checkpointAttemptFor = (ctx: CheckpointCtx, checkpointId: string): number =>
    ctx.failedCtx.checkpointAttempts?.[checkpointId] ?? ctx.failedCtx.checkpointAttempt;

const evalUrlIncludesRule = async (needle: string, ctx: CheckpointCtx): Promise<boolean> => {
    const binding = await getCheckpointBinding(ctx);
    const info = await binding.traceTools['trace.page.getInfo']();
    if (!info.ok) {return false;}
    return (info.data?.url || '').includes(needle);
};

const evalTextVisibleRule = async (needle: string, ctx: CheckpointCtx): Promise<boolean> => {
    const binding = await getCheckpointBinding(ctx);
    const evaluated = await binding.traceTools['trace.page.evaluate'](visibleTextEvaluation(needle));
    return evaluated.ok && evaluated.data === true;
};

const evalEntityExistsRule = async (
    args: { query: string; kind?: EntityKind | EntityKind[]; businessTag?: string | string[] },
    ctx: CheckpointCtx,
    entityRules?: StepEntityRulesControl,
): Promise<boolean> => {
    const {entry} = await ensureFreshPageSession(
        ctx.failedCtx.deps,
        ctx.failedCtx.workspaceName,
        {explicit: true, entityRules},
    );
    const entities = buildPageSessionEntityView(entry).entities;
    const matched = filterPageSessionEntities(entities, {
        kind: args.kind,
        businessTag: args.businessTag,
        query: args.query,
    });
    log.info('checkpoint.entity_exists', {
        args,
        executionStatus: entry.capture.entityRules?.status,
        selectedProfiles: entry.capture.entityRules?.selectedProfiles,
        entityCount: entities.length,
        matchedCount: matched.length,
    });
    return matched.length > 0;
};

export const evalMatchRule = async (
    rule: MatchRule,
    ctx: CheckpointCtx,
    entityRules?: StepEntityRulesControl,
): Promise<boolean> => {
    if ('errorCode' in rule) {
        return ctx.failedCtx.rawResult.error?.code === rule.errorCode;
    }
    if ('stepName' in rule) {
        return ctx.failedCtx.step.name === rule.stepName;
    }
    if ('urlIncludes' in rule) {
        return await evalUrlIncludesRule(rule.urlIncludes, ctx);
    }
    if ('textVisible' in rule) {
        return await evalTextVisibleRule(rule.textVisible, ctx);
    }
    if ('entityExists' in rule) {
        return await evalEntityExistsRule(rule.entityExists, ctx, entityRules);
    }
    return false;
};

export const getEffectiveCheckpointMaxAttempts = (checkpoint: Checkpoint, fallbackMaxAttempts: number): number => {
    const candidateMaxAttempts = checkpoint.policy?.maxAttempts;
    const policyMaxAttempts = typeof candidateMaxAttempts === 'number'
        && Number.isSafeInteger(candidateMaxAttempts)
        && candidateMaxAttempts >= 0
        ? candidateMaxAttempts
        : 1;
    return Math.min(policyMaxAttempts, fallbackMaxAttempts);
};
