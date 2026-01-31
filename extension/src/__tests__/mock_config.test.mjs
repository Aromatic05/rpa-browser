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

await log('new tab default URL points to mock start page (#beta)', async () => {
    const url = await getMockStartUrl(createStorage('http://localhost:4173'));
    assert.equal(url, 'http://localhost:4173/pages/start.html#beta');
});
