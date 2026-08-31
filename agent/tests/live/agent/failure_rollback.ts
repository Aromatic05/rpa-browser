import type {Page} from 'playwright';
import {runLiveAgentScenario} from './runner';
import {agentEvalReportToJson, allModesPassed} from '../../../src/agent/execution/eval/report';
import type {AgentEvalScenario} from '../../../src/agent/execution/eval/contracts';
import {resolveLiveModelConfig} from './model_config';

const fixtureHtml = (): string => `<!doctype html>
<html>
  <head><title>Agent rollback live eval</title></head>
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
    const context: {page?: Page} = {};

    const scenario: AgentEvalScenario = {
        version: 1,
        id: 'physical-rollback-recovery',
        name: 'Physical rollback recovery',
        description: 'Trigger an invariant failure after a fill and roll back the world change.',
        modes: ['program'],
        trials: 1,
        task: {
            id: 'physical-rollback-recovery',
            prompt: [
                'This is a fault-injection recovery evaluation.',
                'Inspect the current page and resolve the Name field target.',
                'Submit one DSL Program that fills Name with Alice and then intentionally fails an invariant by executing `ensure compute eq(input.actual, input.expected)` with structured input actual=1 and expected=2.',
                'After the invariant fails, do not retry the fill. Use the inherited rollbackAnchor with debug.rollback strategy="physical" to undo the earlier fill.',
                'Terminate the failed retained execution after recovery, then verify that the Name field is back to Before.',
                'Report compensated versus restored exactly as the debugger reports it.',
            ].join(' '),
            provider,
            model,
            prepare: async () => {
                await context.page!.goto(`data:text/html,${encodeURIComponent(fixtureHtml())}`, {waitUntil: 'domcontentloaded'});
            },
            verify: async () => ({
                passed: await context.page!.locator('#Name').inputValue() === 'Before',
                evidence: {value: await context.page!.locator('#Name').inputValue()},
            }),
        },
    };

    const report = await runLiveAgentScenario({scenario, context});
    process.stdout.write(`${agentEvalReportToJson(report)}\n`);
    process.exitCode = allModesPassed(report) ? 0 : 1;
};

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
