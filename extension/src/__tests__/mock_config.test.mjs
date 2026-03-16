import assert from 'node:assert/strict';
import { getMockStartUrl } from '../../dist/services/mock_config.js';

const log = (name, fn) => {
    try {
        const result = fn();
        if (result && typeof result.then === 'function') {
            return result.then(
                () => console.log(`ok - ${name}`),
                (error) => {
                    console.error(`fail - ${name}`);
                    throw error;
                },
            );
        }
        console.log(`ok - ${name}`);
    } catch (error) {
        console.error(`fail - ${name}`);
        throw error;
    }
};

const createStorage = (mockBaseUrl) => ({
    get: async () => ({ mockBaseUrl }),
});

await log('new tab default URL points to start extension page', async () => {
    const url = await getMockStartUrl(createStorage('http://localhost:4173'));
    assert.equal(url, 'http://localhost:4173');
});

await log('full page url in mockBaseUrl should be kept as-is', async () => {
    const url = await getMockStartUrl(createStorage('http://127.0.0.1:34263/run_steps_fixture_a.html'));
    assert.equal(url, 'http://127.0.0.1:34263/run_steps_fixture_a.html');
});

await log('invalid mockBaseUrl falls back to default start url', async () => {
    const url = await getMockStartUrl(createStorage('not-a-url'));
    assert.equal(url, 'chrome://newtab/');
});
