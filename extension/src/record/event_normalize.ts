/**
 * event_normalize：将 RawEvent 转为 RecordedStep（Step 模型）。
 */

import type { RecordedStep } from '../shared/types.js';
import type { RawEvent } from './event_capture.js';
import { buildA11yHint } from './locator_builder.js';

export const normalizeEvent = (event: RawEvent, meta: { tabToken: string }): RecordedStep | null => {
    const ts = Date.now();
    if (event.type === 'navigate') {
        return {
            id: self.crypto.randomUUID(),
            name: 'browser.goto',
            args: { url: event.url },
            meta: { ts, tabToken: meta.tabToken, source: 'record' },
        };
    }
    if (event.type === 'click') {
        const hint = buildA11yHint(event.target);
        return {
            id: self.crypto.randomUUID(),
            name: 'browser.click',
            args: { a11yHint: hint },
            meta: { ts, tabToken: meta.tabToken, source: 'record' },
        };
    }
    if (event.type === 'input') {
        const hint = buildA11yHint(event.target);
        return {
            id: self.crypto.randomUUID(),
            name: 'browser.fill',
            args: { a11yHint: hint, value: event.value },
            meta: { ts, tabToken: meta.tabToken, source: 'record' },
        };
    }
    return null;
};
