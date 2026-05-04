import test from 'node:test';
import assert from 'node:assert/strict';
import { queryBusinessEntity, resolveBusinessEntityTarget } from '../../../src/runner/steps/executors/snapshot/core/business_entity_resolver';
import { withEntityRuleSnapshotContext } from './helper';

test('order-list fixture supports query envelope and table row target resolution', async () => {
    await withEntityRuleSnapshotContext(
        { profile: 'oa-ant-orders', app: 'ant', pagePath: '/entity-rules/fixtures/order-list' },
        async ({ snapshot, finalEntityView }) => {
            const rowCount = queryBusinessEntity(snapshot, finalEntityView, 'order.list.main', 'table.rowCount');
            assert.equal(rowCount.ok, true);
            if (rowCount.ok) {
                assert.equal(rowCount.data.kind, 'value');
                assert.equal(typeof rowCount.data.value, 'number');
                assert.equal((rowCount.data.value as number) > 0, true);
                assert.equal((rowCount.data.meta as { businessTag: string }).businessTag, 'order.list.main');
            }

            const tableRow = resolveBusinessEntityTarget(snapshot, finalEntityView, 'order.list.main', {
                kind: 'table.row',
                primaryKey: {
                    fieldKey: 'orderNo',
                    value: 'ORD-2026-001',
                },
            });
            assert.equal(tableRow.ok, true);
            if (tableRow.ok) {
                assert.equal(tableRow.data.kind, 'nodeId');
                assert.equal(typeof tableRow.data.nodeId, 'string');
                assert.equal((tableRow.data.meta as { targetKind: string }).targetKind, 'table.row');
            }
        },
    );
});

test('order-form fixture supports query envelope for form actions', async () => {
    await withEntityRuleSnapshotContext(
        { profile: 'oa-ant-order-form', app: 'ant', pagePath: '/entity-rules/fixtures/order-form' },
        async ({ snapshot, finalEntityView }) => {
            const actions = queryBusinessEntity(snapshot, finalEntityView, 'order.form.main', 'form.actions');
            assert.equal(actions.ok, true);
            if (actions.ok) {
                assert.equal(actions.data.kind, 'value');
                assert.equal(Array.isArray(actions.data.value), true);
                assert.equal((actions.data.meta as { query: string }).query, 'form.actions');
            }
        },
    );
});
