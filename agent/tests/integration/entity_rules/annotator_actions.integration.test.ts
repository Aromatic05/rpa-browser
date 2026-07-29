import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {chromium} from 'playwright';
import {createRunnerAnnotatorController} from '../../../src/runner/annotator';
import {createEntityRulesRuntime} from '../../../src/snapshot/rules/runtime';
import {ActionError, ERROR_CODES} from '../../../src/actions/results';
import type {Action} from '../../../src/actions/action_protocol';
import type {Workflow} from '../../../src/workflow';
import type {
    AnnotatorPickReply,
    AnnotatorProjectionReply,
} from '../../../../shared/annotator-contract/index.js';
import {completeRunStepsDeps} from '../../helpers/run_steps_workspace';

const action = (type: string, payload?: Record<string, unknown>): Action => ({
    v: 1,
    id: crypto.randomUUID(),
    type,
    workspaceName: 'ws-1',
    payload,
});

const workflow: Workflow = {
    name: 'ws-1',
    save: (artifact) => artifact,
    get: () => null,
    list: () => [],
    delete: () => false,
};

const invoke = async (
    runtime: ReturnType<typeof createEntityRulesRuntime>,
    type: string,
    payload?: Record<string, unknown>,
) => await runtime.handle({
    action: action(type, payload),
    workspace: {name: 'ws-1', workflow} as never,
    workspaceRegistry: {} as never,
});

test('annotator open pick recognize and visualize use one PageSession projection contract', async () => {
    const browser = await chromium.launch({headless: true});
    try {
        const page = await browser.newPage({viewport: {width: 900, height: 700}});
        await page.setContent(`
          <main>
            <form id="OrderForm">
              <label for="Buyer">Buyer</label>
              <input id="Buyer" name="buyer">
              <button id="Save" type="submit">Save order</button>
            </form>
          </main>
        `);
        const deps = completeRunStepsDeps({pluginHost: {} as never}, {workspaceName: 'ws-1', page});
        const runtime = createEntityRulesRuntime({
            annotator: createRunnerAnnotatorController({runStepsDeps: deps}),
        });

        const opened = await invoke(runtime, 'entity_rules.annotator.open');
        const openPayload = opened.reply.payload as AnnotatorProjectionReply;
        assert.equal(openPayload.projection.schemaVersion, 1);
        assert.equal(openPayload.projection.selection.status, 'none');
        const actionTarget = openPayload.projection.targets.find((target) =>
            target.kind === 'action' && target.geometry.length > 0);
        assert.ok(actionTarget);
        const rect = actionTarget.geometry[0];

        const pickedResult = await invoke(runtime, 'entity_rules.annotator.pick', {
            point: {x: rect.x + rect.width / 2, y: rect.y + rect.height / 2},
        });
        const picked = pickedResult.reply.payload as AnnotatorPickReply;
        assert.equal(picked.picked.status, 'resolved');
        if (picked.picked.status !== 'resolved') {return;}
        assert.equal(picked.projection.selection.status, 'resolved');
        assert.equal(picked.projection.selection.status === 'resolved'
            ? picked.projection.selection.anchor.backendNodeId
            : undefined, picked.picked.anchor.backendNodeId);
        const confirmedAnchor = picked.picked.anchor;

        const recognized = await invoke(runtime, 'entity_rules.annotator.recognize');
        const recognizedPayload = recognized.reply.payload as AnnotatorProjectionReply;
        assert.equal(recognizedPayload.projection.selection.status, 'resolved');
        if (recognizedPayload.projection.selection.status === 'resolved') {
            assert.equal(
                recognizedPayload.projection.selection.anchor.backendNodeId,
                confirmedAnchor.backendNodeId,
            );
        }

        const missing = await invoke(runtime, 'entity_rules.annotator.pick', {
            point: {x: -1000, y: -1000},
        });
        const missingPayload = missing.reply.payload as AnnotatorPickReply;
        assert.equal(missingPayload.picked.status, 'not_found');
        assert.equal(missingPayload.projection.selection.status, 'resolved');

        const visualized = await invoke(runtime, 'entity_rules.annotator.visualize');
        const visualizePayload = visualized.reply.payload as AnnotatorProjectionReply;
        assert.equal(visualizePayload.projection.identity.pageEpoch, picked.projection.identity.pageEpoch);
    } finally {
        await browser.close();
    }
});

test('annotator pick rejects selector-based extension recovery payloads', async () => {
    const browser = await chromium.launch({headless: true});
    try {
        const page = await browser.newPage();
        await page.setContent('<button id="Save">Save</button>');
        const deps = completeRunStepsDeps({pluginHost: {} as never}, {workspaceName: 'ws-1', page});
        const runtime = createEntityRulesRuntime({
            annotator: createRunnerAnnotatorController({runStepsDeps: deps}),
        });

        await assert.rejects(
            async () => await invoke(runtime, 'entity_rules.annotator.pick', {
                point: {x: 1, y: 1},
                selector: '#Save',
            }),
            (error: unknown) => error instanceof ActionError && error.code === ERROR_CODES.ERR_BAD_ARGS,
        );
    } finally {
        await browser.close();
    }
});
