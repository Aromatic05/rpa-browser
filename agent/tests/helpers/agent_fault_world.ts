import type {Page} from 'playwright';
import {createFakeAgentEvalWorld} from './agent_eval_fake_world';
import {createAgentEvalPageWorld} from './agent_eval_page_world';
import {createFaultInjectingWorld} from '../../src/agent/execution/eval/faults/fault_world';
import type {AgentFaultWorld} from '../../src/agent/execution/eval/faults/contracts';

/**
 * Fault-injecting world over the deterministic in-memory eval world. The
 * navigation fault has no real document to reload here; the wrapper's page
 * epoch gate is what the scenarios assert against.
 */
export const createFakeFaultWorld = (): AgentFaultWorld =>
    createFaultInjectingWorld(createFakeAgentEvalWorld(), {
        navigate: async () => undefined,
    });

/**
 * Fault-injecting world over a real Playwright page. Navigation faults perform
 * an actual document reload, so element handles genuinely detach and stale
 * targets arise the way they do in production.
 */
export const createPageFaultWorld = (page: Page): AgentFaultWorld =>
    createFaultInjectingWorld(createAgentEvalPageWorld(page), {
        navigate: async () => {
            await page.reload({waitUntil: 'domcontentloaded'});
        },
    });
