import crypto from 'node:crypto';
import type {Page} from 'playwright';
import {runLiveAgentScenario} from './runner';
import {agentEvalReportToJson, allModesPassed} from '../../../src/agent/execution/eval/report';
import type {AgentEvalScenario} from '../../../src/agent/execution/eval/contracts';
import {stepExecutors, type ExecutorFn} from '../../../src/automation/runner/steps/executors';
import {resolveLiveModelConfig} from './model_config';

const fixtureHtml = (): string => `<!doctype html>
<html>
  <head><title>Agent side-effect error eval</title></head>
  <body>
    <main>
      <h1>Profile</h1>
      <label for="Name">Name</label>
      <input id="Name" name="name" value="Before">
    </main>
  </body>
</html>`;

const main = async (): Promise<void> => {
    const {provider, model} = resolveLiveModelConfig();
    const context: {page?: Page; injectNextFillFailure?: boolean} = {};

    const injectedFill: ExecutorFn = async (step, deps, workspaceName, executionContext) => {
        const result = await stepExecutors['browser.fill'](step, deps, workspaceName, executionContext);
        if (!context.injectNextFillFailure || !result.ok) {return result;}
        context.injectNextFillFailure = false;
        return {
            stepId: step.id,
            ok: false,
            error: {
                code: 'ERR_INJECTED_POST_EFFECT',
                message: 'Injected failure after browser.fill already mutated the page',
            },
        };
    };

    const scenario: AgentEvalScenario = {
        version: 1,
        id: 'post-effect-fill-error',
        name: 'Post-effect fill error recovery',
        description: 'A fill reports failure after already mutating the page; the agent must recover.',
        modes: ['program', 'react-baseline'],
        trials: 1,
        task: {
            id: 'post-effect-fill-error',
            prompt: [
                'Set the Name field on the current page from Before to Alice.',
                'A fault may cause the mutation operation to report failure after its side effect already happened.',
                'If any mutation reports failure, do not retry the intended mutation. Restore the page to its original Name value Before, verify the actual browser state, and report the recovery result.',
            ].join(' '),
            provider,
            model,
            prepare: async () => {
                context.injectNextFillFailure = true;
                await context.page!.goto(`data:text/html,${encodeURIComponent(fixtureHtml())}`, {waitUntil: 'domcontentloaded'});
            },
            verify: async () => ({
                passed: await context.page!.locator('#Name').inputValue() === 'Before',
                evidence: {value: await context.page!.locator('#Name').inputValue()},
            }),
        },
    };

    const report = await runLiveAgentScenario({
        scenario,
        context,
        executors: {'browser.fill': injectedFill},
    });
    process.stdout.write(`${agentEvalReportToJson(report)}\n`);
    process.exitCode = allModesPassed(report) ? 0 : 1;
};

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
