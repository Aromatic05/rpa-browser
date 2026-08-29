import crypto from 'node:crypto';
import {chromium, type Page} from 'playwright';
import {createOpenAICompatibleAgentModelRuntime} from '../../../src/agent/model/runtime';
import {runAgentEvalScenario} from '../../../src/agent/execution/eval/harness';
import type {AgentEvalScenarioReport} from '../../../src/agent/execution/eval/harness';
import type {AgentEvalScenario} from '../../../src/agent/execution/eval/contracts';
import type {AgentRunResult} from '../../../src/agent/execution/types';
import {createWorkflowOnFs} from '../../../src/automation/workflow';
import {stepExecutors, type ExecutorFn} from '../../../src/automation/runner/steps/executors';
import {createWorkspaceHarness} from '../../helpers/workspace_harness';
import {resolveLiveModelConfig, type LiveModelConfig} from './model_config';

export type LiveAgentEvalOptions = Readonly<{
    scenario: AgentEvalScenario;
    modelConfig?: LiveModelConfig;
    headed?: boolean;
    executors?: Record<string, ExecutorFn>;
    context?: Record<string, unknown>;
}>;

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
    const {provider, model, baseUrl, apiKey} = options.modelConfig ?? resolveLiveModelConfig();
    const modelRuntime = createOpenAICompatibleAgentModelRuntime({provider, model, baseUrl, apiKey});
    const browser = await chromium.launch({
        headless: options.headed ? false : process.env.RPA_EVAL_HEADED !== '1',
        chromiumSandbox: false,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    try {
        const page = await browser.newPage({viewport: {width: 900, height: 600}});
        if (options.context) {
            options.context.page = page;
        }
        const executors = options.executors ? {...stepExecutors, ...options.executors} : stepExecutors;
        const {registry} = createWorkspaceHarness({
            getPage: async () => page,
            pluginHost: {getExecutors: () => executors} as never,
            agentModelRuntime: modelRuntime,
        });
        const workspaceName = `agent-live-${options.scenario.id}-${crypto.randomUUID()}`;
        const workspace = registry.createWorkspace(workspaceName, createWorkflowOnFs(workspaceName));
        workspace.tabs.createTab({tabName: 'main'});
        workspace.tabs.bindPage('main', page);

        const runner = {
            run: async (request: Parameters<import('../../../src/agent/execution/types').AgentRunner['run']>[0]): Promise<AgentRunResult> => {
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

        return await runAgentEvalScenario(
            {runner, modes: options.scenario.modes},
            options.scenario,
        );
    } finally {
        await browser.close();
    }
};
