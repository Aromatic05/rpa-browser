import { Type } from '@earendil-works/pi-ai';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { AgentFaultWorld } from '../../src/agent/execution/eval/faults/contracts';
import type { AgentEvalFixtureSpec } from '../../src/agent/execution/eval/world';
import type { AgentEvalRealFixtureTargets } from './agent_eval_real_worldview';
import { fixtureNodeTargets, readFixtureValues } from './agent_eval_real_worldview';

const textResult = (value: unknown) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    details: value,
});

const errorResult = (code: string, message: string): never => {
    throw new Error(JSON.stringify({ code, message }));
};

export type CreateFixtureAgentToolsOptions = {
    world: AgentFaultWorld;
    spec: AgentEvalFixtureSpec;
};

const targetsFor = (spec: AgentEvalFixtureSpec): AgentEvalRealFixtureTargets =>
    fixtureNodeTargets(spec);

const resolveKey = (
    targets: AgentEvalRealFixtureTargets,
    params: { nodeId?: string; selector?: string },
): string | null => {
    const nodeId = params.nodeId ?? params.selector;
    if (!nodeId) {
        return null;
    }
    return (
        targets.keyForNode[nodeId] ??
        (params.nodeId && targets.keyForNode[params.nodeId] ? params.nodeId : null) ??
        nodeId
    );
};

/**
 * Production-shaped read tools over the fixture world port. These are what the
 * Program-first runner's planning phase and the react-baseline runner see;
 * every read flows through the world port so the verifier's event log observes
 * the agent's actual reads.
 */
export const createFixtureReadTools = (options: CreateFixtureAgentToolsOptions): AgentTool[] => {
    const { world, spec } = options;
    const targets = targetsFor(spec);
    return [
        {
            name: 'browser.snapshot',
            label: 'browser.snapshot',
            description:
                'Read the fixture form fields and buttons with their stable nodeIds and current values.',
            parameters: Type.Unsafe({ type: 'object', additionalProperties: false }),
            execute: async (_toolCallId) => {
                const values = await readFixtureValues(world, spec);
                const fields = Object.entries(targets.field).map(([key, nodeId]) => ({
                    key,
                    nodeId,
                    value: values[key] ?? '',
                }));
                const buttons = Object.entries(targets.button).map(([key, nodeId]) => ({
                    key,
                    nodeId,
                }));
                return textResult({
                    page: spec.page,
                    url: `fixture://${spec.page}`,
                    fields,
                    buttons,
                });
            },
        },
        {
            name: 'browser.get_page_info',
            label: 'browser.get_page_info',
            description: 'Read page metadata.',
            parameters: Type.Unsafe({ type: 'object', additionalProperties: false }),
            execute: async () => textResult({ url: `fixture://${spec.page}`, title: spec.page }),
        },
        {
            name: 'browser.list_tabs',
            label: 'browser.list_tabs',
            description: 'List open tabs.',
            parameters: Type.Unsafe({ type: 'object', additionalProperties: false }),
            execute: async () =>
                textResult([{ tabName: 'main', url: `fixture://${spec.page}`, active: true }]),
        },
        {
            name: 'browser.capture_resolve',
            label: 'browser.capture_resolve',
            description: 'Resolve an observed nodeId into a stable execution target.',
            parameters: Type.Unsafe({
                type: 'object',
                additionalProperties: false,
                properties: { nodeId: { type: 'string' } },
                required: ['nodeId'],
            }),
            execute: async (_toolCallId, params) => {
                const nodeId = (params as { nodeId: string }).nodeId;
                const key = targets.keyForNode[nodeId];
                if (key === undefined) {
                    errorResult('ERR_UNRESOLVED', `unknown fixture nodeId: ${nodeId}`);
                }
                return textResult({
                    nodeId,
                    key,
                    selector: `#${key}`,
                    hint: { target: { nodeId } },
                });
            },
        },
    ];
};

/**
 * Production-shaped browser tools over the fixture world port for the
 * react-baseline runner. Mutations go through the fault world port, so armed
 * faults are observed by the real production tool boundary.
 */
export const createFixtureBrowserTools = (options: CreateFixtureAgentToolsOptions): AgentTool[] => {
    const { world } = options;
    const targets = targetsFor(options.spec);
    const readTools = createFixtureReadTools(options);
    const resolveKeyFor = (params: { nodeId?: string; selector?: string }): string => {
        const key = resolveKey(targets, params);
        if (!key) {
            return errorResult('ERR_BAD_ARGS', 'nodeId or selector is required');
        }
        return key;
    };
    return [
        ...readTools,
        {
            name: 'browser.fill',
            label: 'browser.fill',
            description: 'Fill a fixture field.',
            parameters: Type.Unsafe({
                type: 'object',
                additionalProperties: false,
                properties: {
                    nodeId: { type: 'string' },
                    selector: { type: 'string' },
                    value: { type: 'string' },
                },
                required: ['value'],
            }),
            execute: async (_toolCallId, params) => {
                const input = params as { nodeId?: string; selector?: string; value: string };
                const key = resolveKeyFor(input);
                try {
                    await world.fill(world.field(key), input.value);
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    errorResult(
                        error instanceof Error && 'code' in error
                            ? String((error as { code: unknown }).code)
                            : 'ERR_TOOL_FAILED',
                        message,
                    );
                }
                return textResult({ ok: true, key, value: input.value });
            },
        },
        {
            name: 'browser.click',
            label: 'browser.click',
            description: 'Click a fixture button.',
            parameters: Type.Unsafe({
                type: 'object',
                additionalProperties: false,
                properties: { nodeId: { type: 'string' }, selector: { type: 'string' } },
            }),
            execute: async (_toolCallId, params) => {
                const key = resolveKeyFor(params as { nodeId?: string; selector?: string });
                try {
                    await world.click(world.field(key));
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    errorResult(
                        error instanceof Error && 'code' in error
                            ? String((error as { code: unknown }).code)
                            : 'ERR_TOOL_FAILED',
                        message,
                    );
                }
                return textResult({ ok: true, key });
            },
        },
    ];
};
