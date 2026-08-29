import type {PausedDslDebugExecution} from '../execution/contracts';
import type {RecoveryBudgetAction} from './contracts';

const failureCode = (pause: Extract<PausedDslDebugExecution, {reason: 'failure'}>): string =>
    pause.failure.kind === 'invariant' ? 'invariant' : pause.failure.code;

export const worldIdentityKey = (
    pause: PausedDslDebugExecution,
): string => {
    const world = pause.world;
    return [
        world.workspaceName,
        world.tabName,
        world.pageUrl,
        world.revision.pageEpoch,
        world.revision.captureRevision,
    ].join('/');
};

export const failurePointKey = (
    pause: Extract<PausedDslDebugExecution, {reason: 'failure'}>,
): string => `${pause.location.programId}@${pause.location.path}#${failureCode(pause)}`;

export const recoveryBudgetKey = (
    pause: PausedDslDebugExecution,
    action: RecoveryBudgetAction,
): string | undefined => {
    if (action === 'rollback') {
        return pause.rollbackAnchor ? `anchor:${pause.rollbackAnchor.id}` : undefined;
    }
    return pause.reason === 'failure'
        ? `world:${worldIdentityKey(pause)}#${failurePointKey(pause)}`
        : undefined;
};