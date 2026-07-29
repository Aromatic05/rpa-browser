import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {chromium} from 'playwright';
import {createRunnerAnnotatorController} from '../../../src/runner/annotator';
import {createEntityRulesRuntime} from '../../../src/snapshot/rules/runtime';
import {ActionError, ERROR_CODES} from '../../../src/actions/results';
import type {Action} from '../../../src/actions/action_protocol';
import type {Workflow, WorkflowArtifact, WorkflowEntityRules} from '../../../src/workflow';
import type {
    AnnotatorCheckReply,
    AnnotatorDraft,
    AnnotatorPickReply,
    AnnotatorProjectionReply,
    AnnotatorSaveReply,
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
    targetWorkflow: Workflow = workflow,
) => await runtime.handle({
    action: action(type, payload),
    workspace: {name: 'ws-1', workflow: targetWorkflow} as never,
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


const createMemoryWorkflow = (): {workflow: Workflow; profiles: Map<string, WorkflowEntityRules>} => {
    const profiles = new Map<string, WorkflowEntityRules>();
    const memoryWorkflow: Workflow = {
        name: 'ws-1',
        save: (artifact: WorkflowArtifact) => {
            if (artifact.kind === 'entity_rules') {profiles.set(artifact.name, structuredClone(artifact));}
            return structuredClone(artifact);
        },
        get: (name, dummy) => dummy.kind === 'entity_rules' ? structuredClone(profiles.get(name) ?? null) : null,
        list: (dummy) => dummy.kind === 'entity_rules'
            ? [...profiles.values()].map((profile) => ({
                kind: 'entity_rules' as const,
                name: profile.name,
                title: profile.name,
                summary: 'entity_rules',
                createdAt: 1,
                updatedAt: 1,
                enabled: true,
            }))
            : [],
        delete: (name, dummy) => dummy.kind === 'entity_rules' && profiles.delete(name),
    };
    return {workflow: memoryWorkflow, profiles};
};

const validDraft = (): AnnotatorDraft => ({
    profileName: 'order-form',
    page: {kind: 'form', urlPattern: '.*'},
    match: {
        version: 2,
        rules: [
            {ruleId: 'form-root', source: 'region', expect: 'unique', match: {kind: 'form', idEquals: 'OrderForm'}},
            {ruleId: 'buyer', source: 'node', expect: 'unique', within: 'form-root', match: {idEquals: 'Buyer'}},
            {ruleId: 'submit', source: 'node', expect: 'unique', within: 'form-root', match: {idEquals: 'Save'}},
        ],
    },
    annotation: {
        version: 2,
        bindings: [
            {ruleId: 'form-root', businessTag: 'order.form'},
            {ruleId: 'buyer', fieldKey: 'buyer'},
            {ruleId: 'submit', actionIntent: 'submit'},
        ],
    },
});

test('annotator check save and reopen share QueryPlan semantics without check-time writes', async () => {
    const browser = await chromium.launch({headless: true});
    try {
        const page = await browser.newPage({viewport: {width: 900, height: 700}});
        await page.setContent(`
          <form id="OrderForm">
            <label for="Buyer">Buyer</label>
            <input id="Buyer" name="buyer">
            <button id="Save" type="submit">Save order</button>
          </form>
        `);
        const deps = completeRunStepsDeps({pluginHost: {} as never}, {workspaceName: 'ws-1', page});
        const runtime = createEntityRulesRuntime({
            annotator: createRunnerAnnotatorController({runStepsDeps: deps}),
        });
        const memory = createMemoryWorkflow();
        const draft = validDraft();

        const checkedResult = await invoke(runtime, 'entity_rules.annotator.check', {draft}, memory.workflow);
        const checked = checkedResult.reply.payload as AnnotatorCheckReply;
        assert.equal(checked.validation.ok, true);
        assert.equal(checked.validation.domain, 'form');
        assert.equal(memory.profiles.size, 0);
        assert.equal(checked.projection.semanticBindings.some((binding) =>
            binding.annotation.businessTag === 'order.form'), true);

        const savedResult = await invoke(runtime, 'entity_rules.annotator.save', {draft}, memory.workflow);
        const saved = savedResult.reply.payload as AnnotatorSaveReply;
        assert.equal(saved.validation.ok, true);
        assert.equal(memory.profiles.has('order-form'), true);
        assert.equal((saved.profile as WorkflowEntityRules).name, 'order-form');
        assert.deepEqual((saved.profile as WorkflowEntityRules).page, {kind: 'form', urlPattern: '.*'});

        const reopenedResult = await invoke(runtime, 'entity_rules.annotator.open', {
            profileName: 'order-form',
        }, memory.workflow);
        const reopened = reopenedResult.reply.payload as AnnotatorProjectionReply;
        assert.equal(reopened.validation?.ok, true);
        assert.deepEqual((reopened.profile as WorkflowEntityRules).page, {kind: 'form', urlPattern: '.*'});
        assert.equal(reopened.projection.semanticBindings.some((binding) =>
            binding.annotation.fieldKey === 'buyer'), true);
        const submitTarget = reopened.projection.targets.find((target) =>
            target.kind === 'semantic-binding' && target.label === 'submit');
        assert.ok(submitTarget);
        assert.ok(submitTarget.geometry.length > 0);

        const invalid = validDraft();
        invalid.match.rules[0] = {
            ruleId: 'form-root',
            source: 'region',
            expect: 'unique',
            match: {kind: 'form', idEquals: 'MissingForm'},
        };
        const invalidCheckResult = await invoke(runtime, 'entity_rules.annotator.check', {
            draft: invalid,
        }, memory.workflow);
        const invalidCheck = invalidCheckResult.reply.payload as AnnotatorCheckReply;
        assert.equal(invalidCheck.validation.ok, false);
        assert.equal(memory.profiles.get('order-form')?.match.rules[0].match.idEquals, 'OrderForm');

        await assert.rejects(
            async () => await invoke(runtime, 'entity_rules.annotator.save', {draft: invalid}, memory.workflow),
            (error: unknown) => error instanceof ActionError && error.code === ERROR_CODES.ERR_BAD_ARGS,
        );
        assert.equal(memory.profiles.get('order-form')?.match.rules[0].match.idEquals, 'OrderForm');
    } finally {
        await browser.close();
    }
});

test('annotator visualize refreshes live geometry and preserves only exact selection identity', async () => {
    const browser = await chromium.launch({headless: true});
    try {
        const page = await browser.newPage({viewport: {width: 900, height: 700}});
        await page.setContent(`
          <form id="OrderForm" style="padding:24px">
            <label for="Buyer">Buyer</label>
            <input id="Buyer" name="buyer">
            <button id="Save" type="submit">Save order</button>
          </form>
        `);
        const deps = completeRunStepsDeps({pluginHost: {} as never}, {workspaceName: 'ws-1', page});
        const runtime = createEntityRulesRuntime({
            annotator: createRunnerAnnotatorController({runStepsDeps: deps}),
        });

        const opened = await invoke(runtime, 'entity_rules.annotator.open');
        const initial = opened.reply.payload as AnnotatorProjectionReply;
        const initialTarget = initial.projection.targets.find((target) =>
            target.kind === 'action' && target.label === 'Save order');
        assert.ok(initialTarget?.geometry[0]);
        const initialRect = initialTarget.geometry[0];

        const pickedResult = await invoke(runtime, 'entity_rules.annotator.pick', {
            point: {
                x: initialRect.x + initialRect.width / 2,
                y: initialRect.y + initialRect.height / 2,
            },
        });
        const picked = pickedResult.reply.payload as AnnotatorPickReply;
        assert.equal(picked.picked.status, 'resolved');
        if (picked.picked.status !== 'resolved') {return;}
        const backendNodeId = picked.picked.anchor.backendNodeId;

        await page.locator('#Save').evaluate((element) => {
            (element as HTMLElement).style.marginLeft = '240px';
        });
        const visualizedResult = await invoke(runtime, 'entity_rules.annotator.visualize');
        const visualized = visualizedResult.reply.payload as AnnotatorProjectionReply;
        assert.equal(visualized.projection.identity.pageEpoch, initial.projection.identity.pageEpoch);
        assert.ok(
            visualized.projection.identity.captureRevision > picked.projection.identity.captureRevision,
            'visualize must recapture current geometry',
        );
        assert.equal(visualized.projection.selection.status, 'resolved');
        if (visualized.projection.selection.status === 'resolved') {
            assert.equal(visualized.projection.selection.anchor.backendNodeId, backendNodeId);
        }
        const movedTarget = visualized.projection.targets.find((target) =>
            target.kind === 'action' && target.label === 'Save order');
        assert.ok(movedTarget?.geometry[0]);
        assert.ok(movedTarget.geometry[0].x > initialRect.x + 200);

        await page.locator('#Save').evaluate((element) => {
            element.replaceWith(element.cloneNode(true));
        });
        const replacedResult = await invoke(runtime, 'entity_rules.annotator.visualize');
        const replaced = replacedResult.reply.payload as AnnotatorProjectionReply;
        assert.equal(replaced.projection.identity.pageEpoch, initial.projection.identity.pageEpoch);
        assert.equal(replaced.projection.selection.status, 'stale');
    } finally {
        await browser.close();
    }
});

test('annotator visualize preserves canonical selection across real scroll and page zoom', async () => {
    const browser = await chromium.launch({headless: true});
    try {
        const page = await browser.newPage({viewport: {width: 900, height: 700}});
        await page.setContent(`
          <div style="height:300px"></div>
          <form id="OrderForm">
            <label for="Buyer">Buyer</label>
            <input id="Buyer" name="buyer">
            <button id="Save" type="submit">Save order</button>
          </form>
          <div style="height:1800px"></div>
        `);
        const deps = completeRunStepsDeps({pluginHost: {} as never}, {workspaceName: 'ws-1', page});
        const runtime = createEntityRulesRuntime({
            annotator: createRunnerAnnotatorController({runStepsDeps: deps}),
        });

        const openedResult = await invoke(runtime, 'entity_rules.annotator.open');
        const opened = openedResult.reply.payload as AnnotatorProjectionReply;
        const initialTarget = opened.projection.targets.find((target) =>
            target.kind === 'action' && target.label === 'Save order');
        assert.ok(initialTarget?.geometry[0]);
        const initialRect = initialTarget.geometry[0];
        const pickedResult = await invoke(runtime, 'entity_rules.annotator.pick', {
            point: {
                x: initialRect.x + initialRect.width / 2,
                y: initialRect.y + initialRect.height / 2,
            },
        });
        const picked = pickedResult.reply.payload as AnnotatorPickReply;
        assert.equal(picked.picked.status, 'resolved');
        if (picked.picked.status !== 'resolved') {return;}
        const backendNodeId = picked.picked.anchor.backendNodeId;

        await page.evaluate(() => window.scrollTo(0, 220));
        const scrolledResult = await invoke(runtime, 'entity_rules.annotator.visualize');
        const scrolled = scrolledResult.reply.payload as AnnotatorProjectionReply;
        const scrolledTarget = scrolled.projection.targets.find((target) =>
            target.kind === 'action' && target.label === 'Save order');
        assert.ok(scrolledTarget?.geometry[0]);
        assert.ok(scrolledTarget.geometry[0].y < initialRect.y - 150);
        assert.equal(scrolled.projection.selection.status, 'resolved');
        if (scrolled.projection.selection.status === 'resolved') {
            assert.equal(scrolled.projection.selection.anchor.backendNodeId, backendNodeId);
        }

        const cdp = await page.context().newCDPSession(page);
        await cdp.send('Emulation.setPageScaleFactor', {pageScaleFactor: 1.5});
        const scale = await page.evaluate(() => window.visualViewport?.scale ?? 1);
        assert.ok(scale >= 1.4);
        const zoomedResult = await invoke(runtime, 'entity_rules.annotator.visualize');
        const zoomed = zoomedResult.reply.payload as AnnotatorProjectionReply;
        assert.ok(zoomed.projection.identity.captureRevision > scrolled.projection.identity.captureRevision);
        assert.equal(zoomed.projection.identity.pageEpoch, opened.projection.identity.pageEpoch);
        assert.equal(zoomed.projection.selection.status, 'resolved');
        if (zoomed.projection.selection.status === 'resolved') {
            assert.equal(zoomed.projection.selection.anchor.backendNodeId, backendNodeId);
        }
        const zoomedTarget = zoomed.projection.targets.find((target) =>
            target.kind === 'action' && target.label === 'Save order');
        assert.ok(zoomedTarget?.geometry[0]);
        for (const value of Object.values(zoomedTarget.geometry[0])) {
            assert.equal(Number.isFinite(value), true);
        }
    } finally {
        await browser.close();
    }
});
