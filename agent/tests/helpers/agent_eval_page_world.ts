import type {ElementHandle, Page} from 'playwright';
import {createSeededRandom} from '../../src/agent/execution/eval/seed';
import {AGENT_EVAL_WORLD_ERROR_CODES, AgentEvalWorldError} from '../../src/agent/execution/eval/world';
import type {
    AgentEvalFixtureSpec,
    AgentEvalWorld,
    AgentEvalWorldHandle,
} from '../../src/agent/execution/eval/world';

const capitalize = (key: string): string => key.charAt(0).toUpperCase() + key.slice(1);

export const agentEvalFixtureHtml = (spec: AgentEvalFixtureSpec): string => {
    const fields = Object.entries(spec.fields)
        .map(([key, value]) => `<label for="field-${key}">${capitalize(key)}</label>`
            + `<input id="field-${key}" name="${key}" value="${value}">`)
        .join('\n');
    const buttons = (spec.buttons ?? [])
        .map((key) => `<button id="button-${key}">${capitalize(key)}</button>`)
        .join('\n');
    return `<!doctype html>
<html>
  <head><title>${spec.page}</title></head>
  <body>
    <main>
      <h1>${spec.page}</h1>
      ${fields}
      ${buttons}
      <input id="field-result" name="result" value="">
      <script>
        for (const button of document.querySelectorAll('main button')) {
            button.addEventListener('click', () => {
                const result = document.getElementById('field-result');
                if (result instanceof HTMLInputElement) {
                    result.value = button.id.replace('button-', '');
                }
            });
        }
      </script>
    </main>
  </body>
</html>`;
};

const isDetachedHandleError = (error: unknown): boolean => {
    const message = error instanceof Error ? error.message : String(error);
    return /detached|destroyed|missing|Execution context/i.test(message);
};

/**
 * Playwright-backed implementation of the eval world port over one real page.
 * `drift` replaces the live DOM node, so cached element handles go stale in
 * exactly the way real pages do, and the world revision tracks page state.
 */
export const createAgentEvalPageWorld = (page: Page): AgentEvalWorld => {
    const nodeTokens = new Map<string, number>();
    const handles = new Map<string, ElementHandle<HTMLElement | SVGElement>>();
    const buttonKeys = new Set<string>();
    let revision = 0;
    let tokenCounter = 0;
    let randomSource = createSeededRandom(0);

    const selectorFor = (key: string): string =>
        buttonKeys.has(key) ? `#button-${key}` : `#field-${key}`;

    const ensureToken = (key: string): number => {
        const existing = nodeTokens.get(key);
        if (existing === undefined) {
            throw new Error(`unknown field: ${key}`);
        }
        return existing;
    };

    const resolveHandle = async (key: string): Promise<ElementHandle<HTMLElement | SVGElement>> => {
        const cached = handles.get(key);
        if (cached) {
            return cached;
        }
        const handle = await page.$(selectorFor(key));
        if (!handle) {
            throw new AgentEvalWorldError(
                AGENT_EVAL_WORLD_ERROR_CODES.mutationFailed,
                `missing node for ${key}`,
            );
        }
        handles.set(key, handle);
        return handle;
    };

    return Object.freeze({
        reseed: (seed: number) => {
            randomSource = createSeededRandom(seed);
        },
        random: () => randomSource.next(),
        load: async (spec: AgentEvalFixtureSpec) => {
            await page.goto(`data:text/html,${encodeURIComponent(agentEvalFixtureHtml(spec))}`, {waitUntil: 'domcontentloaded'});
            nodeTokens.clear();
            handles.clear();
            buttonKeys.clear();
            for (const key of Object.keys(spec.fields)) {
                nodeTokens.set(key, tokenCounter++);
            }
            nodeTokens.set('result', tokenCounter++);
            for (const button of spec.buttons ?? []) {
                nodeTokens.set(button, tokenCounter++);
                buttonKeys.add(button);
            }
            revision += 1;
        },
        field: (key: string): AgentEvalWorldHandle => ({key, token: ensureToken(key)}),
        read: async (handle: AgentEvalWorldHandle) => {
            const node = await page.$(selectorFor(handle.key));
            if (!node) {
                return null;
            }
            const value = await (node as ElementHandle<HTMLElement>).evaluate(
                (element) => (element as HTMLInputElement).value ?? element.textContent ?? '',
            );
            await node.dispose();
            return value;
        },
        fill: async (handle: AgentEvalWorldHandle, value: string) => {
            if (ensureToken(handle.key) !== handle.token) {
                throw new AgentEvalWorldError(
                    AGENT_EVAL_WORLD_ERROR_CODES.staleTarget,
                    `stale target for ${handle.key}`,
                );
            }
            const node = await resolveHandle(handle.key);
            try {
                await node.fill(value);
            } catch (error) {
                handles.delete(handle.key);
                if (isDetachedHandleError(error)) {
                    throw new AgentEvalWorldError(
                        AGENT_EVAL_WORLD_ERROR_CODES.staleTarget,
                        `detached target for ${handle.key}`,
                    );
                }
                throw error;
            }
            revision += 1;
            return revision;
        },
        click: async (handle: AgentEvalWorldHandle) => {
            if (ensureToken(handle.key) !== handle.token) {
                throw new AgentEvalWorldError(
                    AGENT_EVAL_WORLD_ERROR_CODES.staleTarget,
                    `stale target for ${handle.key}`,
                );
            }
            const node = await resolveHandle(handle.key);
            try {
                await node.click();
            } catch (error) {
                handles.delete(handle.key);
                if (isDetachedHandleError(error)) {
                    throw new AgentEvalWorldError(
                        AGENT_EVAL_WORLD_ERROR_CODES.staleTarget,
                        `detached target for ${handle.key}`,
                    );
                }
                throw error;
            }
            revision += 1;
            return revision;
        },
        drift: async (key: string) => {
            ensureToken(key);
            await page.evaluate((selector) => {
                const element = document.querySelector(selector);
                if (!element) {
                    throw new Error(`missing node for drift: ${selector}`);
                }
                const fresh = element.cloneNode(false);
                if (fresh instanceof HTMLInputElement) {
                    fresh.value = '';
                }
                element.replaceWith(fresh);
            }, selectorFor(key));
            nodeTokens.set(key, tokenCounter++);
            handles.delete(key);
            revision += 1;
        },
        revision: () => revision,
    });
};
