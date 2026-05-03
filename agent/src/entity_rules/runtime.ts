import { ActionError } from '../actions/results';
import { ERROR_CODES } from '../actions/results';
import type { Workflow, WorkflowDummy, WorkflowEntityRules } from '../workflow';
import { validateEntityRules } from '../runner/steps/executors/snapshot/entity_rules/validate';

const ENTITY_RULES_DUMMY: WorkflowDummy = { kind: 'entity_rules' };

export type WorkspaceEntityRulesRuntime = {
    list: () => WorkflowEntityRules[];
    get: (profileName: string) => WorkflowEntityRules | null;
    save: (artifact: WorkflowEntityRules) => WorkflowEntityRules;
    delete: (profileName: string) => WorkflowEntityRules;
};

export const createWorkspaceEntityRulesRuntime = (workflow: Workflow): WorkspaceEntityRulesRuntime => {
    const list = (): WorkflowEntityRules[] => {
        return workflow
            .list(ENTITY_RULES_DUMMY)
            .map((item) => workflow.get(item.name, ENTITY_RULES_DUMMY))
            .filter((item): item is WorkflowEntityRules => item?.kind === 'entity_rules');
    };

    const get = (profileName: string): WorkflowEntityRules | null => {
        const artifact = workflow.get(profileName, ENTITY_RULES_DUMMY);
        if (!artifact || artifact.kind !== 'entity_rules') {
            return null;
        }
        return artifact;
    };

    const save = (artifact: WorkflowEntityRules): WorkflowEntityRules => {
        const validated = validateEntityRules(artifact.name, artifact.match, artifact.annotation);
        if (!validated.ok) {
            throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, validated.errors.join('; '));
        }
        const saved = workflow.save(artifact);
        if (saved.kind !== 'entity_rules') {
            throw new ActionError(ERROR_CODES.ERR_INTERNAL, 'unexpected entity_rules artifact kind after save');
        }
        return saved;
    };

    const remove = (profileName: string): WorkflowEntityRules => {
        const existing = get(profileName);
        if (!existing) {
            throw new ActionError(ERROR_CODES.ERR_NOT_FOUND, `entity_rules not found: ${profileName}`);
        }
        workflow.delete(profileName, ENTITY_RULES_DUMMY);
        return existing;
    };

    return { list, get, save, delete: remove };
};
