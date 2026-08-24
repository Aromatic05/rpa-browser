import {getLogger} from '../../platform/logging/logger';
import type {WorkspaceAgentFactory} from '../../automation/runtime/workspace/agent';
import type {WorkspaceMcpToolDeps} from '../../automation/runtime/mcp/tool_handlers';
import {createReactAgentRunner} from '../execution/react_runner';
import type {AgentModelRuntime} from '../model/runtime';
import {createAgentControl} from '../service/control';
import {createWorkspaceAgentService} from '../service/runtime';
import {createWorkspaceAgentTools, readWorkspaceWorldRevision} from '../tools/adapter';

export type WorkspaceAgentFactoryOptions = {
    modelRuntime?: AgentModelRuntime;
};

export const createWorkspaceAgentFactory = (
    options: WorkspaceAgentFactoryOptions = {},
): WorkspaceAgentFactory => (deps) => {
    const toolDeps: WorkspaceMcpToolDeps = {
        workspace: {name: deps.workspaceName, tabs: deps.tabs},
        runStepsDeps: deps.runStepsDeps,
        config: deps.runnerConfig,
        runWorkspaceExecution: deps.runWorkspaceExecution,
        awaitTabPage: (tabName, timeoutMs) => deps.tabs.awaitTabPage(tabName, timeoutMs),
    };
    const runner = createReactAgentRunner({
        tools: createWorkspaceAgentTools(toolDeps),
        modelRuntime: options.modelRuntime,
        readWorldRevision: () => readWorkspaceWorldRevision(toolDeps),
    });
    const service = createWorkspaceAgentService({
        workspaceName: deps.workspaceName,
        portAllocator: deps.portAllocator,
        runner,
        log: (...args) => { getLogger('infra').info('[RPA:agent]', ...args); },
    });
    return {
        service,
        control: createAgentControl(service),
    };
};
