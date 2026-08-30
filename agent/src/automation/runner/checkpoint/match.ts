import { getLogger } from '../../../platform/logging/logger';
import { ensureFreshPageSession } from '../session/capture';
import { buildPageSessionEntityView, filterPageSessionEntities } from '../session/entity_view';
import type {StepEntityRulesControl} from '../../snapshot/rules/model';
import {visibleTextEvaluation} from '../page/visible_text';
import type { FailedCtx } from '../failed_ctx';
import type { CheckpointCtx, MatchRule } from './types';
import {
    enterRecovery,
    evalRecoveryMatchRule,
    getEffectiveRecoveryMaxAttempts,
    selectRecovery,
} from './recovery';
import type { RecoveryFailureContext, RecoveryWorldProbe } from './recovery/types';

const log = getLogger('step');

export { getEffectiveRecoveryMaxAttempts as getEffectiveCheckpointMaxAttempts };

const getCheckpointBinding = async (failedCtx: FailedCtx) => {
    const workspace = failedCtx.deps.resolveWorkspace(failedCtx.workspaceName);
    const tabName = workspace.tabs.getActiveTab()?.name;
    if (!tabName) {
        throw new Error(`active tab not found: ${failedCtx.workspaceName}`);
    }
    return await failedCtx.deps.runtime.awaitExecutableTab({
        workspace,
        pageRegistry: workspace.browserSession.pageRegistry,
        tabName,
        timeoutMs: failedCtx.deps.config.waitPolicy.pageReadyTimeoutMs,
    });
};

export const failureContextOf = (failedCtx: FailedCtx): RecoveryFailureContext => ({
    runId: failedCtx.runId,
    workspaceName: failedCtx.workspaceName,
    stepId: failedCtx.step.id,
    stepName: failedCtx.step.name,
    args: failedCtx.step.args,
    error: failedCtx.rawResult.error,
    currentUrl: failedCtx.currentUrl,
    step: failedCtx.step,
});

export const worldProbeOf = (failedCtx: FailedCtx): RecoveryWorldProbe => ({
    currentUrl: async () => {
        try {
            const binding = await getCheckpointBinding(failedCtx);
            const info = await binding.traceTools['trace.page.getInfo']();
            return info.ok ? info.data?.url : undefined;
        } catch {
            return undefined;
        }
    },
    textVisible: async (needle: string) => {
        try {
            const binding = await getCheckpointBinding(failedCtx);
            const evaluated = await binding.traceTools['trace.page.evaluate'](visibleTextEvaluation(needle));
            return evaluated.ok && evaluated.data === true;
        } catch {
            return false;
        }
    },
    entityExists: async (args, entityRules) => {
        try {
            const {entry} = await ensureFreshPageSession(
                failedCtx.deps,
                failedCtx.workspaceName,
                {explicit: true, entityRules},
            );
            const entities = buildPageSessionEntityView(entry).entities;
            const matched = filterPageSessionEntities(entities, {
                kind: args.kind,
                businessTag: args.businessTag,
                query: args.query,
            });
            return matched.length > 0;
        } catch {
            return false;
        }
    },
});

export const maybeEnterCheckpoint = async (ctx: CheckpointCtx): Promise<CheckpointCtx> => {
    const { failedCtx } = ctx;
    const code = failedCtx.rawResult.error?.code;

    const entered = enterRecovery({
        checkpointEnabled: failedCtx.checkpointEnabled,
        inCheckpointFlow: failedCtx.inCheckpointFlow,
        errorCode: code,
    }).entered;

    log.info('checkpoint.enter', {
        entered,
        reason: entered ? undefined : 'checkpoint_not_entered',
        stepId: failedCtx.step.id,
        code,
    });
    if (!entered) {
        return { ...ctx, active: false, stopReason: 'checkpoint_not_entered' };
    }
    return { ...ctx, active: true, meta: { ...(ctx.meta || {}), entered: true } };
};

export const maybePickCheckpoint = async (ctx: CheckpointCtx): Promise<CheckpointCtx> => {
    if (!ctx.active) {return ctx;}

    const selection = await selectRecovery({
        checkpoints: ctx.failedCtx.checkpoints || [],
        failure: failureContextOf(ctx.failedCtx),
        checkpointEnabled: ctx.failedCtx.checkpointEnabled,
        checkpointAttempt: ctx.failedCtx.checkpointAttempt,
        checkpointAttempts: ctx.failedCtx.checkpointAttempts,
        checkpointMaxAttempts: ctx.failedCtx.checkpointMaxAttempts,
        world: worldProbeOf(ctx.failedCtx),
    });

    if (selection.status === 'matched') {
        log.info('checkpoint.pick', { checkpointId: selection.checkpoint.id, checkpointName: selection.checkpoint.name, stepId: ctx.failedCtx.step.id });
        return {
            ...ctx,
            checkpoint: selection.checkpoint,
            meta: {
                ...(ctx.meta || {}),
                checkpointId: selection.checkpoint.id,
                checkpointAttempt: selection.attempt,
            },
        };
    }

    log.info('checkpoint.pick', { checkpointId: null, stepId: ctx.failedCtx.step.id });
    return { ...ctx, active: false, stopReason: 'checkpoint_not_found' };
};

export const evalMatchRule = async (
    rule: MatchRule,
    ctx: CheckpointCtx,
    entityRules?: StepEntityRulesControl,
): Promise<boolean> =>
    await evalRecoveryMatchRule(rule, failureContextOf(ctx.failedCtx), worldProbeOf(ctx.failedCtx), entityRules);