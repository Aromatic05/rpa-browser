import type { Workflow } from '../../workflow';
import type { DslEntityRulesResolver } from './types';

type WorkflowWithDslEntityRulesResolver = {
    getDslEntityRulesResolver?: () => DslEntityRulesResolver | undefined;
};

// The Workflow export half supplies this narrow method. Keeping the structural
// adapter here lets this DSL half compile independently until both land together.
export const resolveWorkflowDslEntityRulesResolver = (workflow: Workflow): DslEntityRulesResolver | undefined =>
    (workflow as Workflow & WorkflowWithDslEntityRulesResolver).getDslEntityRulesResolver?.();
