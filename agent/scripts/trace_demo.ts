import { chromium } from 'playwright';
import { ConsoleSink, MemorySink, createTraceTools } from '../src/runner/trace';

const START_URL = process.env.RPA_START_URL || 'http://localhost:4173/pages/start.html#beta';

const pickFirstByRole = (tree: any, role: string): string | null => {
    if (!tree) return null;
    if (tree.role === role && tree.id) return tree.id;
    for (const child of tree.children || []) {
        const found = pickFirstByRole(child, role);
        if (found) return found;
    }
    return null;
};

const run = async () => {
    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext();
    const page = await context.newPage();

    const memory = new MemorySink();
    const consoleSink = new ConsoleSink();
    const { tools } = createTraceTools({ page, context, sinks: [memory, consoleSink] });

    await tools['trace.page.goto']({ url: START_URL });
    const snapshot = await tools['trace.page.snapshotA11y']();
    if (!snapshot.ok) {
        console.error('snapshot failed', snapshot.error);
        await browser.close();
        return;
    }

    const tree = JSON.parse(snapshot.data || '{}');
    const buttonId = pickFirstByRole(tree, 'button');
    const textboxId = pickFirstByRole(tree, 'textbox');

    if (buttonId) {
        await tools['trace.locator.click']({ a11yNodeId: buttonId });
    }
    if (textboxId) {
        await tools['trace.locator.fill']({ a11yNodeId: textboxId, value: 'trace demo' });
    }

    console.log('trace events:', memory.getEvents().map((e) => e.op));
    await browser.close();
};

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
