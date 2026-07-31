import {promises as fs} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import type {Page} from 'playwright';

const agentDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repositoryDirectory = path.resolve(agentDirectory, '..');

export type BuiltFrameworkApp = {
    script: string;
    style: string;
};

export const buildFrameworkApp = async (input: {
    root: string;
    name: string;
    packages: string[];
    source: string;
    extension?: 'ts' | 'tsx';
}): Promise<BuiltFrameworkApp> => {
    const directory = path.join(input.root, input.name);
    await preparePackageLinks(directory, input.packages);
    const entry = path.join(directory, `entry.${input.extension ?? 'tsx'}`);
    await fs.writeFile(entry, input.source);
    const outputDirectory = path.join(directory, 'dist');
    const result = await build({
        entryPoints: [entry],
        bundle: true,
        format: 'iife',
        platform: 'browser',
        outdir: outputDirectory,
        write: true,
        metafile: true,
        define: {'process.env.NODE_ENV': '"production"'},
    });
    const outputs = Object.keys(result.metafile.outputs);
    const script = outputs.find((item) => item.endsWith('.js'));
    const style = outputs.find((item) => item.endsWith('.css'));
    if (!script) {throw new Error(`framework app did not emit JavaScript: ${input.name}`);}
    return {
        script: await fs.readFile(path.resolve(script), 'utf8'),
        style: style ? await fs.readFile(path.resolve(style), 'utf8') : '',
    };
};

export const mountFrameworkApp = async (
    page: Page,
    app: BuiltFrameworkApp,
    readySelectors: readonly string[],
): Promise<void> => {
    await page.setContent('<!doctype html><html><head></head><body><div id="app"></div></body></html>');
    if (app.style) {await page.addStyleTag({content: app.style});}
    await page.addScriptTag({content: app.script});
    for (const selector of readySelectors) {
        await page.locator(selector).first().waitFor({state: 'visible', timeout: 10000});
    }
    await page.evaluate(() => new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
};

const preparePackageLinks = async (directory: string, packageNames: readonly string[]): Promise<void> => {
    const nodeModules = path.join(directory, 'node_modules');
    await fs.mkdir(nodeModules, {recursive: true});
    for (const packageName of packageNames) {
        const packageDirectory = await resolvePnpmPackage(packageName);
        const link = path.join(nodeModules, ...packageName.split('/'));
        await fs.mkdir(path.dirname(link), {recursive: true});
        await fs.symlink(packageDirectory, link, 'dir');
    }
};

const resolvePnpmPackage = async (packageName: string): Promise<string> => {
    const store = path.join(repositoryDirectory, 'node_modules/.pnpm');
    for (const entry of (await fs.readdir(store)).sort()) {
        const candidate = path.join(store, entry, 'node_modules', ...packageName.split('/'));
        try {
            const metadata = JSON.parse(await fs.readFile(path.join(candidate, 'package.json'), 'utf8')) as {
                name?: string;
            };
            if (metadata.name === packageName) {return candidate;}
        } catch {
            // Continue searching the pnpm virtual store.
        }
    }
    throw new Error(`package not found: ${packageName}`);
};
