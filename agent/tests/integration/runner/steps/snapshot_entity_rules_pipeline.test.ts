import test from 'node:test';
import assert from 'node:assert/strict';
import { applyBusinessEntityRules } from '../../../src/runner/steps/executors/snapshot/entity_rules/apply';
import { buildSnapshot } from '../../../src/runner/steps/executors/snapshot/pipeline/build_snapshot';
import { buildExternalIndexes } from '../../../src/runner/steps/executors/snapshot/indexes/external_indexes';
import { buildLocatorIndex } from '../../../src/runner/steps/executors/snapshot/indexes/locator';
import { buildFinalEntityViewFromSnapshot } from '../../../src/runner/steps/executors/snapshot/core/overlay';
import { setNodeAttr } from '../../../src/runner/steps/executors/snapshot/core/runtime_store';
import type { EntityIndex, UnifiedNode } from '../../../src/runner/steps/executors/snapshot/core/types';
import type { NormalizedEntityRuleBundle } from '../../../src/runner/steps/executors/snapshot/entity_rules/types';

const createFixture = () => {
    const orderNoInput: UnifiedNode = { id: 'input_order_no', role: 'textbox', name: 'Order No', children: [] };
    const submitBtn: UnifiedNode = { id: 'btn_submit', role: 'button', name: 'Submit', children: [] };
    const form: UnifiedNode = { id: 'form_1', role: 'form', name: 'Order Form', children: [orderNoInput, submitBtn] };
    const root: UnifiedNode = { id: 'root', role: 'root', children: [form] };
    setNodeAttr(form, 'backendDOMNodeId', '101');
    setNodeAttr(orderNoInput, 'backendDOMNodeId', '103');
    setNodeAttr(submitBtn, 'backendDOMNodeId', '102');
    setNodeAttr(submitBtn, 'aria-label', 'Submit Form');

    const entityIndex: EntityIndex = {
        entities: {
            ent_form: {
                id: 'ent_form',
                type: 'region',
                kind: 'form',
                nodeId: 'form_1',
                name: 'Order Form',
            },
        },
        byNodeId: {
            form_1: [{ type: 'region', entityId: 'ent_form', role: 'container' }],
            input_order_no: [{ type: 'region', entityId: 'ent_form', role: 'descendant' }],
            btn_submit: [{ type: 'region', entityId: 'ent_form', role: 'descendant' }],
        },
    };

    const bundle: NormalizedEntityRuleBundle = {
        id: 'order-form',
        page: { kind: 'form' },
        matchRules: [
            {
                ruleId: 'main_form',
                source: 'region',
                expect: 'unique',
                order: 0,
                match: { kind: 'form', nameContains: 'Order' },
            },
            {
                ruleId: 'order_no_input',
                source: 'node',
                expect: 'unique',
                order: 1,
                within: 'main_form',
                match: { textContains: 'Order No' },
            },
            {
                ruleId: 'submit_action',
                source: 'node',
                expect: 'unique',
                order: 2,
                within: 'main_form',
                match: { ariaContains: 'submit' },
            },
        ],
        annotationByRuleId: {
            main_form: {
                ruleId: 'main_form',
                businessTag: 'order.form.main',
                businessName: 'Order Form Main',
                fields: [
                    {
                        fieldKey: 'orderNo',
                        name: 'Order No',
                        kind: 'input',
                        controlRuleId: 'order_no_input',
                    },
                ],
                actions: [
                    {
                        actionIntent: 'submit',
                        text: 'Submit',
                        nodeRuleId: 'submit_action',
                    },
                ],
            },
            submit_action: {
                ruleId: 'submit_action',
                fieldKey: 'submit',
                actionIntent: 'submit',
            },
        },
    };

    return { root, entityIndex, bundle };
};

test('snapshot pipeline integration merges business entity overlay into finalEntityView and node attrs', () => {
    const { root, entityIndex, bundle } = createFixture();
    const ruleEntityOverlay = applyBusinessEntityRules({ root, entityIndex, bundle });

    const { nodeIndex, bboxIndex, attrIndex, contentStore } = buildExternalIndexes(root);
    const locatorIndex = buildLocatorIndex({ root, entityIndex });
    const snapshot = buildSnapshot({
        root,
        nodeIndex,
        entityIndex,
        locatorIndex,
        bboxIndex,
        attrIndex,
        contentStore,
        ruleEntityOverlay,
    });

    const finalEntityView = buildFinalEntityViewFromSnapshot(snapshot, {
        renamedNodes: {},
        addedEntities: [],
        deletedEntities: [],
    });

    assert.equal(finalEntityView.entities.length, 1);
    assert.equal(finalEntityView.entities[0].businessTag, 'order.form.main');
    assert.equal(finalEntityView.entities[0].businessName, 'Order Form Main');
    assert.equal(finalEntityView.bindingIndex.fieldsByEntity[finalEntityView.entities[0].id]?.orderNo?.controlNodeId, 'input_order_no');
    assert.equal(finalEntityView.bindingIndex.actionsByEntity[finalEntityView.entities[0].id]?.submit?.nodeId, 'btn_submit');

    assert.equal(snapshot.attrIndex.btn_submit?.fieldKey, 'submit');
    assert.equal(snapshot.attrIndex.btn_submit?.actionIntent, 'submit');
});
