import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildControlSnapshot,
    buildEntityRuleComponentSnapshots,
    buildLocatorIndex,
    buildPageObservation,
    buildRelationIndex,
    type PageSnapshotCapture,
    type RawCapturedNode,
    type RawPageCapture,
} from '../../../src/snapshot';
import {
    readControlOptionByNodeId,
    readSelectedValuesFromControl,
    resolveRecordTargetBinding,
} from '../../../src/record/pipeline/target_binding';
import type {RecorderEvent} from '../../../src/record/capture/recorder';
import {createTestRecordingState} from '../../helpers/recording_state';

const active = () => ({hiddenByStyle: false, inert: false, selfHasBox: true, rendered: true});

const node = (
    captureId: string,
    tag: string,
    parentCaptureId: string | undefined,
    childCaptureIds: string[],
    attributes: Record<string, string> = {},
    ownText?: string,
): RawCapturedNode => ({
    captureId,
    scopeId: 'main',
    parentCaptureId,
    childCaptureIds,
    tag,
    attributes,
    ownText,
    backendNodeId: captureId,
    activity: active(),
});

const createCapture = (): {capture: PageSnapshotCapture; nodeIds: Record<string, string>} => {
    const completeness = {dom: 'complete', a11y: 'complete', runtime: 'complete', geometry: 'complete'} as const;
    const raw: RawPageCapture = {
        identity: {pageEpoch: 'record-target', captureRevision: 1},
        metadata: {schemaVersion: 1, source: 'fixed-fixture', capturedAt: '2026-07-29T00:00:00.000Z'},
        completeness,
        scopes: [{id: 'main', kind: 'document', rootCaptureId: 'html', status: 'captured', completeness}],
        nodes: [
            node('html', 'html', undefined, ['body']),
            node('body', 'body', 'html', ['trigger', 'popup']),
            node('trigger', 'input', 'body', [], {
                id: 'Status',
                role: 'combobox',
                'aria-controls': 'StatusPopup',
                'aria-expanded': 'true',
            }),
            node('popup', 'div', 'body', ['open', 'closed'], {id: 'StatusPopup', role: 'listbox'}),
            node('open', 'li', 'popup', [], {
                id: 'OpenOption',
                role: 'option',
                'data-value': 'open',
                'aria-selected': 'true',
            }, 'Open'),
            node('closed', 'li', 'popup', [], {
                id: 'ClosedOption',
                role: 'option',
                'data-value': 'closed',
                'aria-selected': 'false',
            }, 'Closed'),
        ],
        accessibility: [],
        runtimeState: {},
        diagnostics: [],
    };
    const observation = buildPageObservation(raw);
    const relations = buildRelationIndex(observation);
    const locators = buildLocatorIndex(observation);
    const control = buildControlSnapshot({observation, relations, locators});
    const components = buildEntityRuleComponentSnapshots(control);
    return {
        capture: {control, form: components.form, table: components.table},
        nodeIds: Object.fromEntries(Object.entries(observation.captureIdToNodeId)),
    };
};

const event = (selector: string): RecorderEvent => ({
    tabName: 'tab-1',
    ts: 1,
    type: 'click',
    selector,
});

test('record target binding resolves V2 custom-select trigger and option nodes', async () => {
    const {capture, nodeIds} = createCapture();
    const resolveSnapshot = async () => capture;
        const trigger = await resolveRecordTargetBinding({
            event: event('#Status'),
            state: createTestRecordingState(),
            workspaceName: 'ws-1',
            resolveSnapshot,
        });
        assert.ok(trigger);
        assert.equal(trigger.componentKind, 'custom_select');
        assert.equal(trigger.targetNodeId, nodeIds.trigger);
        assert.equal(trigger.controlRootNodeId, nodeIds.trigger);

        const option = await resolveRecordTargetBinding({
            event: event('#OpenOption'),
            state: createTestRecordingState(),
            workspaceName: 'ws-1',
            resolveSnapshot,
        });
        assert.ok(option);
        assert.equal(option.component.id, trigger.component.id);
        assert.equal(option.targetNodeId, nodeIds.open);
        assert.equal(readControlOptionByNodeId(option.component, nodeIds.open)?.value, 'open');
        assert.deepEqual(readSelectedValuesFromControl(option.component), ['open']);
});

test('record enhancement emits V2 identity and canonical target facts', async () => {
    const {capture, nodeIds} = createCapture();
    const resolveSnapshot = async () => capture;
        const {enrichRecordedStepWithSnapshot} = await import('../../../src/record/enhancement/build');
        const enhancement = await enrichRecordedStepWithSnapshot({
            event: event('#Status'),
            state: createTestRecordingState(),
            workspaceName: 'ws-1',
            resolveSnapshot,
            tabName: 'tab-1',
        });
        assert.equal(enhancement.snapshot?.snapshotId, 'record-target:1');
        assert.deepEqual(enhancement.snapshot?.pageIdentity, {
            workspaceName: 'ws-1',
            tabName: 'tab-1',
            url: '',
        });
        assert.equal(enhancement.target?.nodeId, nodeIds.trigger);
        assert.equal(enhancement.target?.primaryDomId, 'trigger');
        assert.equal(enhancement.target?.role, 'combobox');
        assert.equal(enhancement.target?.tag, 'input');
        assert.equal(enhancement.resolveHint?.target?.nodeId, nodeIds.trigger);
        assert.equal(enhancement.resolveHint?.raw?.selector, '#Status');
        assert.equal(enhancement.resolveHint?.capture?.source, 'record_enrichment');
});
