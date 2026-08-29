import crypto from 'node:crypto';
import {chromium, type Page} from 'playwright';
import {createOpenAICompatibleAgentModelRuntime} from '../../../src/agent/model/runtime';
import {runAgentEvalScenario} from '../../../src/agent/execution/eval/harness';
import type {AgentEvalScenarioReport} from '../../../src/agent/execution/eval/harness';
import type {AgentEvalScenario} from '../../../src/agent/execution/eval/contracts';
import type {AgentRunResult, AgentRunner} from '../../../src/agent/execution/types';
import type {AgentEvalWorld} from '../../../src/agent/execution/eval/world';
import {createWorkflowOnFs} from '../../../src/automation/workflow';
import {stepExecutors, type ExecutorFn} from '../../../src/automation/runner/steps/executors';
import {createWorkspaceHarness} from '../../helpers/workspace_harness';
import {createAgentEvalPageWorld} from '../../helpers/agent_eval_page_world';
import {resolveLiveModelConfig, type LiveModelConfig} from './model_config';

export type LiveAgentEvalOptions = Readonly<{
    scenario: AgentEvalScenario;
    modelConfig?: LiveModelConfig;
    headed?: boolean;
    executors?: Record<string, ExecutorFn>;
    context?: Record<string, unknown>;
}>;

export type LiveAgentEvalSessionOptions = Readonly<{
    modelConfig?: LiveModelConfig;
    /** 'live' (default) binds the real model runtime; 'none' is page-only for browser fixtures. */
    model?: 'live' | 'none';
    headed?: boolean;
    executors?: Record<string, ExecutorFn>;
}>;

export type LiveAgentEvalSession = Readonly<{
    page: Page;
    world: AgentEvalWorld;
    runnerFor: (scenarioId: string) => AgentRunner;
    close: () => Promise<void>;
}>;

/**
 * Opens one browser and page for a benchmark session. Each scenario gets its
 * own lazily-created Workspace Agent runner bound to the shared page, so a
 * corpus executes N scenarios × trials × modes against the real agent stack.
 */
export const openLiveAgentEvalSession = async (
    options: LiveAgentEvalSessionOptions = {},
): Promise<LiveAgentEvalSession> => {
    const usesModel = options.model !== 'none';
    const {provider, model, baseUrl, apiKey} = usesModel
        ? options.modelConfig ?? resolveLiveModelConfig()
        : {provider: '', model: '', baseUrl: '', apiKey: ''};
    const modelRuntime = usesModel
        ? createOpenAICompatibleAgentModelRuntime({provider, model, baseUrl, apiKey})
        : undefined;
    const browser = await chromium.launch({
        headless: options.headed ? false : process.env.RPA_EVAL_HEADED !== '1',
        chromiumSandbox: false,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const page = await browser.newPage({viewport: {width: 900, height: 600}});
    const executors = options.executors ? {...stepExecutors, ...options.executors} : stepExecutors;
    const runners = new Map<string, AgentRunner>();

    const runnerFor = (scenarioId: string): AgentRunner => {
        const cached = runners.get(scenarioId);
        if (cached) {
            return cached;
        }
        if (!modelRuntime) {
            throw new Error('this eval session was opened without a live agent model');
        }
        const {registry} = createWorkspaceHarness({
            getPage: async () => page,
            pluginHost: {getExecutors: () => executors} as never,
            agentModelRuntime: modelRuntime,
        });
        const workspaceName = `agent-live-${scenarioId}-${crypto.randomUUID()}`;
        const workspace = registry.createWorkspace(workspaceName, createWorkflowOnFs(workspaceName));
        workspace.tabs.createTab({tabName: 'main'});
        workspace.tabs.bindPage('main', page);
        const runner: AgentRunner = {
            run: async (request): Promise<AgentRunResult> => {
                const response = await workspace.router.handle({
                    v: 1,
                    id: crypto.randomUUID(),
                    type: 'agent.run',
                    workspaceName,
                    payload: request,
                }, workspace, registry);
                return response.reply.payload as AgentRunResult;
            },
        };
        runners.set(scenarioId, runner);
        return runner;
    };

    return Object.freeze({
        page,
        world: createAgentEvalPageWorld(page),
        runnerFor,
        close: () => browser.close(),
    });
};

/**
 * Shared live eval harness. Launches one browser, creates a workspace, and runs
 * the requested scenario across its modes/trials using a real model and page.
 *
 * The mutable `context` object, if provided, is populated with `page` before the
 * scenario runs so that scenario `prepare`/`verify` functions can access the
 * live browser state without breaking the pure scenario contract.
 */
export const runLiveAgentScenario = async (
    options: LiveAgentEvalOptions,
): Promise<AgentEvalScenarioReport> => {
    const session = await openLiveAgentEvalSession({
        modelConfig: options.modelConfig,
        headed: options.headed,
        executors: options.executors,
    });
    try {
        if (options.context) {
            options.context.page = session.page;
        }
        return await runAgentEvalScenario(
            {runner: session.runnerFor(options.scenario.id), modes: options.scenario.modes},
            options.scenario,
        );
    } finally {
        await session.close();
    }
};
