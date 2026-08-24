import test from 'node:test';
import assert from 'node:assert/strict';
import {planPhysicalCompensation} from '../../../../../../src/agent/debug/transaction/compensation/planner';
import {classifyEffectSemanticRisk} from '../../../../../../src/agent/debug/transaction/compensation/semantics';
import type {DebugEffectJournalEntry} from '../../../../../../src/agent/debug/effects/contracts';
import type {WorldView} from '../../../../../../src/agent/worldview/contracts';
import {describeWorldView} from '../../../../../../src/agent/worldview/descriptor';
import {PageSnapshotSessionStore} from '../../../../../../src/automation/snapshot';
import type {RuntimeStateRecord} from '../../../../../../src/automation/snapshot/observation/model/contracts';
import {createV2BusinessPage} from '../../../../../helpers/v2_business_page';

const createView = async (): Promise<WorldView> => {
    const store = new PageSnapshotSessionStore<object>();
    const fixture = createV2BusinessPage();
    const entry = await store.ensureFresh({
        pageKey: {},
        pageUrl: '/orders',
        capture: async () => fixture.capture,
    });
    return Object.freeze({
        workspaceName: 'ws-compensation',
        tabName: 'main',
        pageUrl: entry.pageUrl,
        revision: Object.freeze({...entry.identity}),
        entry,
    });
};

const withRuntimeValue = (view: WorldView, nodeId: string, value: string): WorldView => {
    const entry = structuredClone(view.entry);
    const runtimeState = entry.capture.control.observation.runtimeState as unknown as Record<
        string,
        RuntimeStateRecord | undefined
    >;
    runtimeState[nodeId] = {stateId: `state:${nodeId}`, value};
    return Object.freeze({...view, entry});
};

const effectEntry = (
    before: WorldView,
    effect: {
        stepName: 'browser.fill' | 'browser.click';
        args: unknown;
        reversibility?: 'unknown' | 'reversible' | 'compensatable' | 'irreversible';
    },
): DebugEffectJournalEntry => Object.freeze({
    record: Object.freeze({
        sequence: 1,
        location: Object.freeze({
            programId: 'main',
            path: 'body.0',
            kind: 'act' as const,
            loops: Object.freeze([]),
            callStack: Object.freeze([]),
        }),
        effect: Object.freeze({
            stepId: 'effect-1',
            stepName: effect.stepName,
            args: effect.args,
            semantics: Object.freeze({reversibility: effect.reversibility ?? 'unknown'}),
        }),
        outcome: Object.freeze({status: 'succeeded' as const}),
        worldBefore: describeWorldView(before),
        worldAfter: describeWorldView(before),
    }),
    worldBefore: before,
    worldAfter: before,
});

test('effect semantic risk stays unknown instead of inferring reversibility from browser verb', async () => {
    const view = await createView();
    for (const entry of [
        effectEntry(view, {stepName: 'browser.fill', args: {nodeId: 'field', value: 'new'}}),
        effectEntry(view, {stepName: 'browser.click', args: {nodeId: 'submit'}}),
    ]) {
        assert.equal(classifyEffectSemanticRisk(entry.record.effect), 'unknown');
    }
});

test('fill with explicit nodeId can produce a physical restore-value compensation plan', async () => {
    const view = withRuntimeValue(await createView(), 'buyer-input', 'old value');
    const plan = planPhysicalCompensation(effectEntry(view, {
        stepName: 'browser.fill',
        args: {nodeId: 'buyer-input', value: 'new value'},
    }));

    assert.deepEqual(plan, {
        status: 'available',
        semanticRisk: 'unknown',
        capability: 'restore_value',
        effectSequence: 1,
        operation: {
            name: 'browser.fill',
            args: {nodeId: 'buyer-input', value: 'old value'},
        },
    });
});

test('explicit irreversible semantics block physical compensation even for a fill with a recoverable value', async () => {
    const view = withRuntimeValue(await createView(), 'buyer-input', 'old value');
    const entry = effectEntry(view, {
        stepName: 'browser.fill',
        args: {nodeId: 'buyer-input', value: 'new value'},
        reversibility: 'irreversible',
    });

    assert.equal(classifyEffectSemanticRisk(entry.record.effect), 'irreversible');
    assert.deepEqual(planPhysicalCompensation(entry), {
        status: 'unavailable',
        semanticRisk: 'irreversible',
        reason: 'explicit_irreversible',
        effectSequence: 1,
    });
});

test('physical compensation planner refuses ambiguous or unsupported effects', async () => {
    const view = await createView();

    assert.deepEqual(planPhysicalCompensation(effectEntry(view, {
        stepName: 'browser.fill',
        args: {selector: '#buyer', value: 'new'},
    })), {
        status: 'unavailable',
        semanticRisk: 'unknown',
        reason: 'explicit_target_required',
        effectSequence: 1,
    });

    assert.deepEqual(planPhysicalCompensation(effectEntry(view, {
        stepName: 'browser.fill',
        args: {nodeId: 'buyer-input', value: 'new'},
    })), {
        status: 'unavailable',
        semanticRisk: 'unknown',
        reason: 'previous_value_unavailable',
        effectSequence: 1,
    });

    assert.deepEqual(planPhysicalCompensation(effectEntry(view, {
        stepName: 'browser.click',
        args: {nodeId: 'submit'},
    })), {
        status: 'unavailable',
        semanticRisk: 'unknown',
        reason: 'unsupported_effect',
        effectSequence: 1,
    });
});
