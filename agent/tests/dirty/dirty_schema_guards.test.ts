import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    browserCloseTabInputSchema,
    browserSwitchTabInputSchema,
    toolInputJsonSchemas,
} from '../../src/mcp/schemas';
import type { RecordingManifest } from '../../src/record/recording';
import type { RecordingTabManifest } from '../../src/record/recording';
import type { RecordedStepEnhancement } from '../../src/record/types';
import type { SnapshotPageIdentity } from '../../src/runner/steps/executors/snapshot/core/types';

type ExpectTrue<T extends true> = T;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const expectTrue = <T extends true>(_value: T) => {};

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

type RecordingTabManifestKeys = keyof RecordingTabManifest;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _recordingTabManifestKeys = expectTrue<
    Equal<
        RecordingTabManifestKeys,
        'tabName' | 'tabRef' | 'firstSeenUrl' | 'lastSeenUrl' | 'firstSeenAt' | 'lastSeenAt'
    >
>(true);

type RecordingManifestTabKeys = keyof NonNullable<RecordingManifest['tabs']>[number];
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _recordingManifestTabKeys = expectTrue<
    Equal<RecordingManifestTabKeys, 'tabName' | 'tabRef' | 'firstSeenUrl' | 'lastSeenUrl' | 'firstSeenAt' | 'lastSeenAt'>
>(true);

type RecordedPageIdentity = NonNullable<NonNullable<RecordedStepEnhancement['snapshot']>['pageIdentity']>;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _recordedPageIdentityKeys = expectTrue<
    Equal<keyof RecordedPageIdentity, 'workspaceName' | 'tabName' | 'url'>
>(true);

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _snapshotPageIdentityKeys = expectTrue<
    Equal<keyof SnapshotPageIdentity, 'workspaceName' | 'tabName' | 'url'>
>(true);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..', '..');

test('mcp zod schemas accept expected tab args', () => {
    const switchResult = browserSwitchTabInputSchema.safeParse({
        tabName: 'tab-a',
        tabRef: 'ref-a',
        tabUrl: 'https://example.com',
    });
    assert.equal(switchResult.success, true);

    const closeResult = browserCloseTabInputSchema.safeParse({
        tabName: 'tab-a',
        tabRef: 'ref-a',
    });
    assert.equal(closeResult.success, true);
});

test('mcp tool schemas expose single tabName fields', () => {
    const switchProps = toolInputJsonSchemas['browser.switch_tab'].properties as Record<string, unknown>;
    const closeProps = toolInputJsonSchemas['browser.close_tab'].properties as Record<string, unknown>;

    assert.deepEqual(Object.keys(switchProps).sort(), ['tabName', 'tabRef', 'tabUrl'].sort());
    assert.deepEqual(Object.keys(closeProps).sort(), ['tabName', 'tabRef'].sort());
});

test('guards avoid duplicate legacy address checks', () => {
    const dispatcherText = fs.readFileSync(path.join(ROOT, 'src/actions/dispatcher.ts'), 'utf8');
    const indexText = fs.readFileSync(path.join(ROOT, 'src/index.ts'), 'utf8');
    const actionCallText = fs.readFileSync(path.join(ROOT, 'src/control/action_bridge.ts'), 'utf8');

    assert.equal(dispatcherText.includes("'tabName' in payload"), false);
    assert.equal(indexText.includes("'workspaceName' in rec"), false);
    assert.equal(actionCallText.includes("'tabName' in params || 'tabName' in params"), false);
    assert.equal(indexText.includes("'workspaceName' in rec ||"), false);
});
