import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {captureRawPage} from '../../../src/automation/snapshot';

const SECRETS = [
    'dom-password-canary',
    'runtime-password-canary',
    'hidden-token-canary',
    'api-key-canary',
    '654321',
];

test('Snapshot V2 never exposes sensitive control plaintext through DOM, runtime, or accessibility capture', async () => {
    const browser = await chromium.launch({headless: true});
    try {
        const page = await browser.newPage();
        await page.setContent(`
            <!doctype html>
            <html><body>
              <input id="username" name="username" type="text" value="alice">
              <input id="password" name="password" type="password" autocomplete="current-password" value="dom-password-canary">
              <input id="csrf" name="csrfToken" type="hidden" value="hidden-token-canary">
              <input id="api-key" name="apiKey" type="text" value="api-key-canary">
              <input id="otp" name="verificationCode" type="text" autocomplete="one-time-code" value="654321">
            </body></html>
        `, {waitUntil: 'domcontentloaded'});
        await page.locator('#password').fill('runtime-password-canary');

        const captured = await captureRawPage(page, {captureRuntimeState: true});
        try {
            const raw = captured.capture;
            const byId = (id: string) => raw.nodes.find((node) => node.attributes.id === id);
            const normal = byId('username');
            const password = byId('password');
            const hidden = byId('csrf');
            const apiKey = byId('api-key');
            const otp = byId('otp');
            assert.ok(normal && password && hidden && apiKey && otp);

            assert.equal(normal.attributes.value, 'alice', 'ordinary field values remain observable');
            assert.equal(raw.runtimeState[normal.runtimeStateToken!]?.value, 'alice');

            for (const node of [password, hidden, apiKey, otp]) {
                assert.equal(node.attributes.value, '[redacted]');
                assert.equal(raw.runtimeState[node.runtimeStateToken!]?.value, '[redacted]');
                const ax = raw.accessibility.find((record) =>
                    record.backendNodeId !== undefined && record.backendNodeId === node.backendNodeId);
                if (ax?.value !== undefined) {assert.equal(ax.value, '[redacted]');}
            }

            const serialized = JSON.stringify(raw);
            for (const secret of SECRETS) {
                assert.equal(serialized.includes(secret), false, `Snapshot must not contain ${secret}`);
            }
        } finally {
            await captured.cleanup();
        }
    } finally {
        await browser.close();
    }
});
