import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeStepArgs } from '../../../../src/automation/runner/step_event_summary';
import type { StepUnion } from '../../../../src/automation/runner/steps/types';
import { createRedactionPolicy } from '../../../../src/security/redaction';

const SECRET = 'exact-registered-secret';

const step = (name: string, args: Record<string, unknown>): StepUnion => ({
    id: 's-1',
    name,
    args,
} as unknown as StepUnion);

test('default summary masks fill/type/select_option values and keeps benign fields', () => {
    const fill = summarizeStepArgs(step('browser.fill', { selector: '#pw', value: SECRET })) as Record<string, unknown>;
    assert.equal(fill.value, '[REDACTED]');
    assert.equal(fill.selector, '#pw');

    const typeArgs = summarizeStepArgs(step('browser.type', { selector: '#n', text: 'typed' })) as Record<string, unknown>;
    assert.equal(typeArgs.text, '[REDACTED]');
    assert.equal(typeArgs.selector, '#n');

    const select = summarizeStepArgs(step('browser.select_option', { selector: '#s', values: ['a', 'b'] })) as Record<string, unknown>;
    assert.equal(select.values, '[REDACTED]');
    assert.equal(select.selector, '#s');
});

test('registered exact secrets never survive in step summaries', () => {
    const policy = createRedactionPolicy({ secrets: [SECRET] });
    const summary = summarizeStepArgs(step('browser.goto', {
        url: 'https://example.test/callback',
        input: { username: 'alice', note: `wrap ${SECRET}` },
    }), policy) as Record<string, unknown>;

    const serialized = JSON.stringify(summary);
    assert.ok(!serialized.includes(SECRET), 'registered secret must not survive, got: ' + serialized);
    assert.equal((summary.input as Record<string, unknown>).username, 'alice');
    assert.equal((summary.input as Record<string, unknown>).note, 'wrap [redacted]');
});

test('sensitive URL parameters are masked while benign params pass through', () => {
    const summary = summarizeStepArgs(step('browser.goto', {
        url: 'https://example.test/callback?token=secret&view=orders',
    })) as Record<string, unknown>;

    const url = String(summary.url);
    assert.match(url, /token=%5BREDACTED%5D/);
    assert.match(url, /view=orders/);
});

test('query primary-key values are masked and nested fields survive', () => {
    const summary = summarizeStepArgs(step('browser.query', {
        op: 'entity.target',
        businessTag: 'order.list',
        target: { kind: 'table.row', primaryKey: { fieldKey: 'orderNo', value: 'SO-42' } },
    })) as { target: { primaryKey: { value: string; fieldKey: string } } };

    assert.equal(summary.target.primaryKey.value, '[REDACTED]');
    assert.equal(summary.target.primaryKey.fieldKey, 'orderNo');
});

test('step summaries are deterministic', () => {
    const policy = createRedactionPolicy({ secrets: [SECRET] });
    const args = {
        url: 'https://example.test/cb?token=abc',
        input: { username: 'bob', session: SECRET },
    };
    const first = summarizeStepArgs(step('browser.checkpoint', args), policy);
    const second = summarizeStepArgs(step('browser.checkpoint', args), policy);
    assert.deepEqual(first, second);
    assert.equal(JSON.stringify(first), JSON.stringify(second));
});