import {getLogger} from '../../platform/logging/logger';
import type {AgentServiceBinding, InteractionPolicy, RetentionPolicy} from '../../platform/config';
import type {WorkspaceAgentFactory} from '../../automation/runtime/workspace/agent';
import type {WorkspaceMcpToolDeps} from '../../automation/runtime/mcp/tool_handlers';
import {createReactAgentRunner} from '../execution/react_runner';
import {createProgramFirstAgentRunner} from '../execution/program/runner';
import {createAgentExecutionRouter} from '../execution/router';
import type {AgentModelRuntime} from '../model/runtime';
import type {GovernanceController, GovernancePolicy} from '../governance';
import type {CredentialResolver} from '../../security/credentials';
import {createAgentControl} from '../service/control';
import {createWorkspaceAgentService} from '../service/runtime';
import type {AgentServiceSecurityOptions} from '../service/security/contracts';
import {createWorkspaceLibrary} from '../library';
import {
    createWorkspaceAgentReadTools,
    createWorkspaceAgentTools,
    readWorkspaceWorldRevision,
} from '../tools/adapter';
import {createWorkspaceProgramExecutor} from './program_executor';
import {createWorkspaceProgramSaver} from './program_persistence';
import {createWorkspaceProgramLibrary} from './program_library';

export type WorkspaceAgentFactoryOptions = {
    modelRuntime?: AgentModelRuntime;
    governancePolicy?: GovernancePolicy;
    governanceController?: GovernanceController;
    credentialResolver?: CredentialResolver;
    dataDir?: string;
    security?: AgentServiceSecurityOptions;
    service?: AgentServiceBinding;
    retention?: RetentionPolicy;
    interaction?: InteractionPolicy;
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
    const reactGovernance = options.governancePolicy || options.governanceController
        ? {controller: options.governanceController, policy: options.governancePolicy}
        : undefined;
    const baselineRunner = createReactAgentRunner({
        tools: createWorkspaceAgentTools(toolDeps),
        modelRuntime: options.modelRuntime,
        readWorldRevision: () => readWorkspaceWorldRevision(toolDeps),
        governance: reactGovernance,
    });
    const programRunner = createProgramFirstAgentRunner({
        readTools: createWorkspaceAgentReadTools(toolDeps),
        executeProgram: createWorkspaceProgramExecutor({
            workspaceName: deps.workspaceName,
            deps: deps.runStepsDeps,
            runWorkspaceExecution: deps.runWorkspaceExecution,
            credentialResolver: options.credentialResolver,
        }),
        programLibrary: createWorkspaceProgramLibrary({
            workspaceName: deps.workspaceName,
            deps: deps.runStepsDeps,
        }),
        saveProgram: createWorkspaceProgramSaver({
            workspaceName: deps.workspaceName,
            deps: deps.runStepsDeps,
        }),
        readWorldRevision: () => readWorkspaceWorldRevision(toolDeps),
        modelRuntime: options.modelRuntime,
        governancePolicy: options.governancePolicy,
        governanceController: options.governanceController,
    });
    const runner = createAgentExecutionRouter({
        baseline: baselineRunner,
        program: programRunner,
        defaultMode: 'program',
    });
    const workspaceLibrary = createWorkspaceLibrary({
        workspaceName: deps.workspaceName,
        deps: deps.runStepsDeps,
    });
    const service = createWorkspaceAgentService({
        workspaceName: deps.workspaceName,
        portAllocator: deps.portAllocator,
        runner,
        dataDir: options.dataDir,
        security: options.security,
        host: options.service?.host,
        agentPath: options.service?.agentPath,
        healthPath: options.service?.healthPath,
        fixedPort: options.service && options.service.port > 0 ? options.service.port : undefined,
        retention: options.retention,
        interaction: options.interaction,
        productLibrary: () => workspaceLibrary.list(),
        log: (...args) => { getLogger('infra').info('[RPA:agent]', ...args); },
    });
    return {
        service,
        control: createAgentControl(service),
    };
};
