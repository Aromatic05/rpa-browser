import type {
    RecoveryBudgetAction,
    RecoveryBudgetLimits,
    RecoveryBudgetStore,
    RecoveryBudgetView,
} from './contracts';

export const DEFAULT_RECOVERY_BUDGET_LIMITS: RecoveryBudgetLimits = Object.freeze({
    retry: 2,
    repair: 1,
    rollback: 1,
});

export const createRecoveryBudgetStore = (
    limits: RecoveryBudgetLimits = DEFAULT_RECOVERY_BUDGET_LIMITS,
): RecoveryBudgetStore => {
    const state = new Map<string, RecoveryBudgetView>();
    const empty = (key: string): RecoveryBudgetView =>
        Object.freeze({key, retry: 0, repair: 0, rollback: 0});
    const view = (key: string): RecoveryBudgetView => state.get(key) ?? empty(key);
    return {
        view,
        record: (key, action) => {
            const current = view(key);
            const next = Object.freeze({
                key,
                retry: current.retry + (action === 'retry' ? 1 : 0),
                repair: current.repair + (action === 'repair' ? 1 : 0),
                rollback: current.rollback + (action === 'rollback' ? 1 : 0),
            });
            state.set(key, next);
            return next;
        },
        remaining: (key, action: RecoveryBudgetAction) =>
            Math.max(0, limits[action] - view(key)[action]),
    };
};