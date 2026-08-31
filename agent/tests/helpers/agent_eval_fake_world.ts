import {createSeededRandom} from '../../src/agent/execution/eval/seed';
import {AGENT_EVAL_WORLD_ERROR_CODES, AgentEvalWorldError} from '../../src/agent/execution/eval/world';
import type {
    AgentEvalFixtureSpec,
    AgentEvalWorld,
    AgentEvalWorldHandle,
} from '../../src/agent/execution/eval/world';

type FakeNode = {token: number; value: string};

/**
 * In-memory deterministic implementation of the eval world port. `load`
 * replaces the page state, `drift` bumps the node token so existing handles
 * become stale, and every accepted mutation bumps the revision counter.
 */
export const createFakeAgentEvalWorld = (): AgentEvalWorld => {
    const nodes = new Map<string, FakeNode>();
    const buttons = new Set<string>();
    let revision = 0;
    let tokenCounter = 0;
    let randomSource = createSeededRandom(0);

    const register = (key: string, value: string): void => {
        nodes.set(key, {token: tokenCounter++, value});
    };

    const liveNode = (key: string): FakeNode => {
        const node = nodes.get(key);
        if (!node) {
            throw new Error(`unknown field: ${key}`);
        }
        return node;
    };

    return Object.freeze({
        reseed: (seed: number) => {
            randomSource = createSeededRandom(seed);
        },
        random: () => randomSource.next(),
        load: async (spec: AgentEvalFixtureSpec) => {
            nodes.clear();
            buttons.clear();
            for (const [key, value] of Object.entries(spec.fields)) {
                register(key, value);
            }
            register('result', '');
            for (const button of spec.buttons ?? []) {
                buttons.add(button);
            }
            revision += 1;
        },
        field: (key: string): AgentEvalWorldHandle => {
            if (key !== 'result' && !nodes.has(key) && !buttons.has(key)) {
                throw new Error(`unknown field: ${key}`);
            }
            if (buttons.has(key)) {
                return {key, token: -1};
            }
            return {key, token: liveNode(key).token};
        },
        read: async (handle: AgentEvalWorldHandle) => {
            const node = nodes.get(handle.key);
            return node ? node.value : null;
        },
        fill: async (handle: AgentEvalWorldHandle, value: string) => {
            const node = liveNode(handle.key);
            if (node.token !== handle.token) {
                throw new AgentEvalWorldError(
                    AGENT_EVAL_WORLD_ERROR_CODES.staleTarget,
                    `stale target for ${handle.key}`,
                );
            }
            node.value = value;
            revision += 1;
            return revision;
        },
        click: async (handle: AgentEvalWorldHandle) => {
            if (!buttons.has(handle.key)) {
                throw new AgentEvalWorldError(
                    AGENT_EVAL_WORLD_ERROR_CODES.mutationFailed,
                    `not a button: ${handle.key}`,
                );
            }
            const result = liveNode('result');
            result.value = handle.key;
            revision += 1;
            return revision;
        },
        drift: async (key: string) => {
            const node = liveNode(key);
            node.token = tokenCounter++;
            node.value = '';
            revision += 1;
        },
        revision: () => revision,
    });
};
