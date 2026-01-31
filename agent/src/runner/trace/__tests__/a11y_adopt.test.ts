import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Locator } from 'playwright';
import { adoptA11yNode } from '../a11y_adopt';
import type { TraceCache } from '../types';

test('adoptA11yNode returns ERR_NOT_FOUND when cache missing', async () => {
    const cache: TraceCache = {};
    const page = {} as any;
    const result = await adoptA11yNode(page, 'n0', cache);
    assert.equal(result.ok, false);
    if (!result.ok) {
        assert.equal(result.error.code, 'ERR_NOT_FOUND');
    }
});

test('adoptA11yNode returns ERR_AMBIGUOUS when multiple matches', async () => {
    const cache: TraceCache = {
        a11yNodeMap: new Map([
            [
                'n0',
                {
                    id: 'n0',
                    role: 'button',
                    name: 'Confirm',
                },
            ],
        ]),
    };

    const locator: Partial<Locator> = {
        count: async () => 2,
        evaluateAll: async () => [{ tag: 'button', text: 'Confirm' }],
    };

    const page = {
        getByRole: () => locator,
    } as any;

    const result = await adoptA11yNode(page, 'n0', cache);
    assert.equal(result.ok, false);
    if (!result.ok) {
        assert.equal(result.error.code, 'ERR_AMBIGUOUS');
    }
});
