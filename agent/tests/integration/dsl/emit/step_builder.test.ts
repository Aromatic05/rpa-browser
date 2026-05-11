import test from 'node:test';
import assert from 'node:assert/strict';
import { buildClickStep, buildFillStep, buildQueryStep, buildSelectStep, buildSnapshotStep, buildTypeStep } from '../../../src/dsl/emit';

test('step_builder maps DSL statements to browser steps', () => {
    const query = buildQueryStep({
        kind: 'query',
        op: 'entity.target',
        businessTag: 'order.form',
        payload: { kind: 'form.field', fieldKey: 'buyer' },
    });
    const fill = buildFillStep({ kind: 'nodeId', nodeId: 'buyer-input' }, 'alice');
    const click = buildClickStep({ nodeId: 'submit-btn' });
    const type = buildTypeStep({ nodeId: 'buyer-input' }, 'alice');
    const select = buildSelectStep({ nodeId: 'buyer-input' }, 'approved');
    const snapshot = buildSnapshotStep();

    assert.equal(query.name, 'browser.query');
    assert.deepEqual(query.args, {
        op: 'entity.target',
        businessTag: 'order.form',
        target: { kind: 'form.field', fieldKey: 'buyer' },
    });
    assert.equal(fill.name, 'browser.fill');
    assert.deepEqual(fill.args, { nodeId: 'buyer-input', value: 'alice' });
    assert.equal(click.name, 'browser.click');
    assert.deepEqual(click.args, { nodeId: 'submit-btn' });
    assert.equal(type.name, 'browser.type');
    assert.deepEqual(type.args, { nodeId: 'buyer-input', text: 'alice' });
    assert.equal(select.name, 'browser.select_option');
    assert.deepEqual(select.args, { nodeId: 'buyer-input', values: ['approved'] });
    assert.equal(snapshot.name, 'browser.snapshot');
    assert.deepEqual(snapshot.args, {});
});
