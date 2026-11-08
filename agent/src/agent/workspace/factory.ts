import {getLogger} from '../../platform/logging/logger';
import type {AgentServiceBinding, InteractionPolicy, RetentionPolicy} from '../../platform/config';
import type {WorkspaceAgentFactory} from '../../automation/runtime/workspace/agent';
import type {WorkspaceMcpToolDeps} from '../../automation/runtime/mcp/tool_handlers';
import type {RunStepsDeps} from '../../automation/runner/run_steps';
import type {KnowledgeEntityRulesPort} from '../execution/knowledge';
import type {AgentExecutionMode} from '../execution/types';
import {createReactAgentRunner} from '../execution/react_runner';
import {createProgramFirstAgentRunner} from '../execution/program/runner';
import {createAgentExecutionRouter} from '../execution/router';
import type {AgentModelRuntime} from '../model/runtime';
import type {AgentModelSettings} from '../model/settings';
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
    /** Static defaults retained for embedded/test compositions. */
    productDefaults?: Readonly<{provider: string; model: string; executionMode?: AgentExecutionMode}>;
    /** Shared process-level model setup. Every workspace sees the same dynamic
     * runtime/defaults and product Setup status. */
    productModelSettings?: AgentModelSettings;
};

/**
 * The workspace is created and registered only AFTER this factory returns (see
 * createWorkspace -> createRuntimeWorkspace), so resolution is deferred to the
 * first knowledge inspect call. The adapter implements ONLY the narrow
 * read-only port the Knowledge seam uses; every method resolves the real,
 * committed workspace Entity Rules provider at call time. No provider status,
 * availability or identity is fabricated here.
 */
const lazyWorkspaceEntityRules = (workspaceName: string, runStepsDeps: RunStepsDeps): KnowledgeEntityRulesPort => {
    const resolveProvider = () => {
        const workspace = runStepsDeps.resolveWorkspace(workspaceName);
        return workspace.entityRules.getProvider(workspace.workflow);
    };
    return {
        getProfile: (name) => resolveProvider().getProfile(name),
        resolveExports: (name) => resolveProvider().resolveExports(name),
    };
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
    const workspaceLibrary = createWorkspaceLibrary({
        workspaceName: deps.workspaceName,
        deps: deps.runStepsDeps,
    });
    const programExecutor = createWorkspaceProgramExecutor({
        workspaceName: deps.workspaceName,
        deps: deps.runStepsDeps,
        runWorkspaceExecution: deps.runWorkspaceExecution,
        credentialResolver: options.credentialResolver,
    });
    const programSaver = createWorkspaceProgramSaver({
        workspaceName: deps.workspaceName,
        deps: deps.runStepsDeps,
    });
    const programRunner = createProgramFirstAgentRunner({
        readTools: createWorkspaceAgentReadTools(toolDeps),
        executeProgram: programExecutor,
        programLibrary: createWorkspaceProgramLibrary({
            workspaceName: deps.workspaceName,
            deps: deps.runStepsDeps,
        }),
        saveProgram: programSaver,
        knowledge: {
            library: workspaceLibrary,
            entityRules: lazyWorkspaceEntityRules(deps.workspaceName, deps.runStepsDeps),
        },
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
        ...(options.productDefaults === undefined ? {} : {productDefaults: options.productDefaults}),
        ...(options.productModelSettings === undefined ? {} : {productModelSettings: options.productModelSettings}),
        productLibrary: () => workspaceLibrary.list(),
        playbackView: deps.playbackView,
        productSaveAutomation: programSaver,
        continuationRestorer: async (request, image) => {
            const restored = await programExecutor.restoreContinuation(image);
            if (!restored.ok) {return restored;}
            return {
                ok: true as const,
                result: await programRunner.restore(request, restored.start),
            };
        },
        log: (...args) => { getLogger('infra').info('[RPA:agent]', ...args); },
    });
    return {
        service,
        acquirePlayback: () => {
            const owner = {kind: 'playback' as const};
            if (!service.sessions.activityAcquire(owner).ok) {return null;}
            return () => {service.sessions.activityRelease(owner);};
        },
        control: createAgentControl(service),
    };
};
