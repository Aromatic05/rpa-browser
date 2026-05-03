import type { Workflow } from '../../workflow';
import type { WorkspaceTabs } from './tabs';
import type { RecordControl } from '../../record/control';
import type { DslControl } from '../../dsl/control';
import type { CheckpointControl } from '../../checkpoint/control';
import type { EntityRulesControl } from '../../entity_rules/control';
import type { RunnerControl } from '../../runner/control';
import type { McpControl } from '../../mcp/control';

export type RuntimeWorkspace = {
    name: string;
    workflow: Workflow;
    tabs: WorkspaceTabs;
    record: RecordControl;
    dsl: DslControl;
    checkpoint: CheckpointControl;
    entityRules: EntityRulesControl;
    runner: RunnerControl;
    mcp: McpControl;
    createdAt: number;
    updatedAt: number;
};

export type CreateRuntimeWorkspaceDeps = {
    name: string;
    workflow: Workflow;
    tabs: WorkspaceTabs;
    record: RecordControl;
    dsl: DslControl;
    checkpoint: CheckpointControl;
    entityRules: EntityRulesControl;
    runner: RunnerControl;
    mcp: McpControl;
};

export const createRuntimeWorkspace = (deps: CreateRuntimeWorkspaceDeps): RuntimeWorkspace => {
    const now = Date.now();
    return {
        name: deps.name,
        workflow: deps.workflow,
        tabs: deps.tabs,
        record: deps.record,
        dsl: deps.dsl,
        checkpoint: deps.checkpoint,
        entityRules: deps.entityRules,
        runner: deps.runner,
        mcp: deps.mcp,
        createdAt: now,
        updatedAt: now,
    };
};
