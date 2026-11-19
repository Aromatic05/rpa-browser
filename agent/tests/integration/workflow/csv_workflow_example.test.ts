import assert from 'node:assert/strict';
import test from 'node:test';
import {parseCsvRows} from '../../../scripts/examples/run_csv_workflow';

test('CSV rows retain strings, quoted separators and physical line numbers', () => {
    assert.deepEqual(parseCsvRows('\uFEFFcustomer,account\r\n"A ""quoted"", name",001\r\n"two\r\nlines",002\r\nlast,003'), [
        {line: 2, input: {customer: 'A "quoted", name', account: '001'}},
        {line: 3, input: {customer: 'two\r\nlines', account: '002'}},
        {line: 5, input: {customer: 'last', account: '003'}},
    ]);
});

test('CSV validation rejects malformed records before dispatch', () => {
    assert.throws(() => parseCsvRows('a,a\n1,2'), /distinct/);
    assert.throws(() => parseCsvRows('__proto__\n1'), /distinct/);
    assert.throws(() => parseCsvRows('a,b\n1,2\n3'), /line 3: expected 2 columns/);
    assert.throws(() => parseCsvRows('a\n"unterminated'), /line 2: unclosed/);
});
