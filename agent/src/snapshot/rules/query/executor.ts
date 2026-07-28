import { deepFreeze } from '../../observation/model/freeze';
import type {
    EntityRuleQueryExecutionResult,
    EntityRuleQueryPlan,
    EntityRuleQueryPurpose,
    QueryPlanSnapshots,
} from './contracts';
import { executeFormQueryPlan } from './form';
import { queryDiagnostic } from './shared';
import { executeTableQueryPlan } from './table';

export const executeEntityRuleQueryPlan = (
    plan: EntityRuleQueryPlan,
    snapshots: QueryPlanSnapshots,
    options: { purpose: EntityRuleQueryPurpose },
): EntityRuleQueryExecutionResult => {
    const snapshot = plan.domain === 'form' ? snapshots.form : snapshots.table;
    if (!snapshot) {
        const diagnostic = queryDiagnostic({
            profileName: plan.profileName,
            code: 'query-plan.snapshot.missing',
            message: `${plan.domain} snapshot is unavailable for query plan: ${plan.id}`,
            targetKind: 'query-plan',
        });
        return deepFreeze({
            planId: plan.id,
            profileName: plan.profileName,
            domain: plan.domain,
            purpose: options.purpose,
            byRuleId: {},
            diagnostics: [diagnostic],
            ok: false,
        });
    }
    const execution = plan.domain === 'form'
        ? executeFormQueryPlan(plan, snapshots.form!)
        : executeTableQueryPlan(plan, snapshots.table!);
    return deepFreeze({
        planId: plan.id,
        profileName: plan.profileName,
        domain: plan.domain,
        purpose: options.purpose,
        byRuleId: execution.byRuleId,
        diagnostics: execution.diagnostics,
        ok: Object.values(execution.byRuleId).every((binding) => binding.ok)
            && !execution.diagnostics.some((diagnostic) => diagnostic.severity === 'error'),
    });
};
