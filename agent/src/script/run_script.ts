/**
 * script runner：将简单脚本/JSON 转为 Step，并通过 runSteps 执行。
 *
 * 约定（v0）：
 * - JSON 数组：直接视为 StepUnion[]
 * - 行式脚本：
 *   - goto <url>
 *   - snapshot
 *   - click <a11yNodeId>
 *   - fill <a11yNodeId> <value>
 */

import crypto from 'crypto';
import type { StepUnion } from '../runner/steps/types';
import type { RunStepsResult } from '../runner/steps/types';
import { runSteps } from '../runner/run_steps';

type ScriptInput = string | StepUnion[];

export const runScript = async (
    workspaceId: string,
    input: ScriptInput,
    opts?: { stopOnError?: boolean },
): Promise<RunStepsResult> => {
    const steps = Array.isArray(input) ? input : parseScript(input);
    return runSteps({
        workspaceId,
        steps,
        options: { stopOnError: opts?.stopOnError ?? true },
    });
};

const parseScript = (script: string): StepUnion[] => {
    const lines = script
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith('#'));
    const steps: StepUnion[] = [];
    for (const line of lines) {
        const [cmd, ...rest] = line.split(' ');
        if (cmd === 'goto' && rest[0]) {
            steps.push({
                id: crypto.randomUUID(),
                name: 'browser.goto',
                args: { url: rest.join(' ') },
                meta: { source: 'script', ts: Date.now() },
            });
            continue;
        }
        if (cmd === 'snapshot') {
            steps.push({
                id: crypto.randomUUID(),
                name: 'browser.snapshot',
                args: { includeA11y: true },
                meta: { source: 'script', ts: Date.now() },
            });
            continue;
        }
        if (cmd === 'click' && rest[0]) {
            steps.push({
                id: crypto.randomUUID(),
                name: 'browser.click',
                args: { a11yNodeId: rest[0] },
                meta: { source: 'script', ts: Date.now() },
            });
            continue;
        }
        if (cmd === 'fill' && rest.length >= 2) {
            steps.push({
                id: crypto.randomUUID(),
                name: 'browser.fill',
                args: { a11yNodeId: rest[0], value: rest.slice(1).join(' ') },
                meta: { source: 'script', ts: Date.now() },
            });
            continue;
        }
        steps.push({
            id: crypto.randomUUID(),
            name: 'browser.snapshot',
            args: { includeA11y: true },
            meta: { source: 'script', ts: Date.now() },
        });
    }
    return steps;
};
