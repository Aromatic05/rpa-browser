import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { MemorySink } from '../sink';
import { createTraceTools } from '../tools';

const fixtureUrl = () => {
    const filePath = path.resolve(
        process.cwd(),
        'src/runner/trace/demo/fixtures/trace_fixture.html',
    );
    return pathToFileURL(filePath).toString();
};

const findNodeId = (tree: any, role: string, name: string): string | null => {
    if (!tree) return null;
    if (tree.role === role && tree.name === name) return tree.id;
    for (const child of tree.children || []) {
        const found = findNodeId(child, role, name);
        if (found) return found;
    }
    return null;
};

const run = async () => {
    const browser = await chromium.launch({
        headless: false,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-crash-reporter'],
    });
    const context = await browser.newContext();
    const page = await context.newPage();

    const sink = new MemorySink();
    const { tools } = createTraceTools({ page, context, sinks: [sink] });

    await tools['trace.page.goto']({ url: fixtureUrl() });
    const snapshot = await tools['trace.page.snapshotA11y']();
    if (!snapshot.ok) {
        console.error('snapshot failed', snapshot.error);
        await browser.close();
        return;
    }

    const tree = JSON.parse(snapshot.data || '{}');
    const buttonId = findNodeId(tree, 'button', 'Do Action');
    const inputId = findNodeId(tree, 'textbox', 'Name');
    if (buttonId) {
        await tools['trace.locator.click']({ a11yNodeId: buttonId });
    }
    if (inputId) {
        await tools['trace.locator.fill']({ a11yNodeId: inputId, value: 'headed demo' });
    }
    await tools['trace.page.screenshot']({ fullPage: false });

    console.log('Headed demo finished, please visually verify browser actions.');
    await browser.close();
};

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
