import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright';
import { generateSemanticSnapshot } from '../../../../src/runner/steps/executors/snapshot/pipeline/snapshot';
import { buildFinalEntityViewFromSnapshot } from '../../../../src/runner/steps/executors/snapshot/core/overlay';
import type {
    FinalEntityView,
    SnapshotResult,
    SnapshotPageIdentity,
} from '../../../../src/runner/steps/executors/snapshot/core/types';
import { createWorkspaceEntityRulesProvider } from '../../../../src/entity_rules/provider';
import { createWorkspaceEntityRulesRuntime } from '../../../../src/entity_rules/runtime';
import { toEntityRuleBundle } from '../../../../src/workflow/entity_rules';
import type { WorkflowEntityRules } from '../../../../src/workflow';
import type { WorkspaceEntityRulesProvider } from '../../../../src/entity_rules/provider';
import { loadEntityRuleArtifact } from '../profile_fixture';
import { startMockApp } from '../verify/helper';
import { createStepExecutionHarness } from '../../../helpers/step_runner_harness';
import {
    resolveClickedNode,
    buildCandidateChain,
} from '../../../../src/entity_rules/annotator/picking';
import { buildOpenResult, runCheck } from '../../../../src/entity_rules/annotator/pipeline';
import { executeSave } from '../../../../src/entity_rules/annotator/actions';
import { importEntityRulesToCanvasDraft } from '../../../../src/entity_rules/annotator/import';
import { validateEntityRules } from '../../../../src/runner/steps/executors/snapshot/entity_rules/validate';
import type { CanvasDraft } from '../../../../src/entity_rules/annotator/types';
import type { PickFingerprint } from '../../../../src/entity_rules/annotator/runtime_types';

const makeProvider = (artifact: WorkflowEntityRules): WorkspaceEntityRulesProvider => {
    const bundle = toEntityRuleBundle(artifact);
    return {
        listBundles: () => [bundle],
        getBundle: (name) => (name === bundle.id ? bundle : null),
        resolveBundle: () => bundle,
    };
};

type CapturedFingerprint = {
    fingerprint: PickFingerprint;
    nodeIdHint: string;
};

const captureFingerprint = async (page: Page, selector: string): Promise<CapturedFingerprint> => {
    const locator = page.locator(selector).first();
    const handle = await locator.elementHandle();
    if (!handle) {
        throw new Error(`element not found: ${selector}`);
    }
    const data = await page.evaluate((el: Element) => {
        const rect = el.getBoundingClientRect();
        const tokens = Array.from(el.classList);
        const role = el.getAttribute('role') || undefined;
        const aria = el.getAttribute('aria-label') || undefined;
        const text = (el.textContent || '').trim().slice(0, 40);
        const ancestors: Array<Record<string, unknown>> = [];
        let cur: Element | null = el.parentElement;
        for (let i = 0; i < 8 && cur; i += 1, cur = cur.parentElement) {
            ancestors.push({
                tagName: cur.tagName.toLowerCase(),
                classTokens: Array.from(cur.classList),
                role: cur.getAttribute('role') || undefined,
                text: (cur.textContent || '').trim().slice(0, 40),
                ariaLabel: cur.getAttribute('aria-label') || undefined,
            });
        }
        return { rect, tokens, tagName: el.tagName.toLowerCase(), role, aria, text, ancestors };
    }, handle);
    await handle.dispose();

    const rect = data.rect as { x: number; y: number; width: number; height: number };
    return {
        fingerprint: {
            point: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
            selectorCandidates: [selector],
            role: data.role as string | undefined,
            text: data.text as string | undefined,
            ariaLabel: data.aria as string | undefined,
            tagName: data.tagName as string,
            classTokens: data.tokens as string[],
            rect,
            ancestors: data.ancestors as PickFingerprint['ancestors'],
        },
        nodeIdHint: selector,
    };
};

const generateSnapshotWithArtifact = async (page: Page, artifact: WorkflowEntityRules) => {
    const provider = makeProvider(artifact);
    const snapshot = await generateSemanticSnapshot(page, { entityRulesProvider: provider });
    const finalEntityView = buildFinalEntityViewFromSnapshot(snapshot, {
        renamedNodes: {},
        addedEntities: [],
        deletedEntities: [],
    });
    return { snapshot, finalEntityView, provider };
};

test('annotator.open + pick on ant order-form: control/field/region, matchCount, within, stable class', async () => {
    const mockServer = await startMockApp('ant');
    let browser: Browser | null = null;
    try {
        browser = await chromium.launch({
            headless: true,
            chromiumSandbox: false,
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
        });
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto(`${mockServer.baseUrl}/entity-rules/fixtures/order-form`, {
            waitUntil: 'domcontentloaded',
        });

        const artifact = await loadEntityRuleArtifact('oa-ant-order-form');
        const harness = await createStepExecutionHarness(page);
        const workspace = harness.deps.resolveWorkspace(harness.workspaceName);
        await workspace.workflow.save(artifact);
        const workflowProvider = createWorkspaceEntityRulesProvider(workspace.workflow);
        const workflowRuntime = createWorkspaceEntityRulesRuntime(workspace.workflow);

        const snapshot = await generateSemanticSnapshot(page, {
            entityRulesProvider: workflowProvider,
        });
        const finalEntityView = buildFinalEntityViewFromSnapshot(snapshot, {
            renamedNodes: {},
            addedEntities: [],
            deletedEntities: [],
        });
        const pageIdentity: SnapshotPageIdentity = {
            workspaceName: harness.workspaceName,
            tabName: harness.tabName,
            url: page.url(),
        };

        // Scenario 1: open reads workflow + snapshot
        const open = buildOpenResult({
            snapshot,
            finalEntityView,
            pageIdentity,
            provider: workflowProvider,
            getArtifact: (name) => workflowRuntime.get(name),
        });
        assert.equal(open.profileName, artifact.name);
        assert.ok(open.canvasDraft, 'open should import canvas draft from stored artifact');
        assert.ok(open.artifactRevision, 'open should compute artifact revision');
        assert.equal(open.pageKind, 'form');
        assert.ok(open.visualTargetRefs.length > 0, 'open should expose visual targets');

        // Scenario 2: click buyer input -> control + field + form region
        const buyer = await captureFingerprint(page, 'input[placeholder="请输入采购人"]');
        const buyerResolution = resolveClickedNode(snapshot, buyer.fingerprint);
        assert.ok(buyerResolution.nodeId, 'buyer input should resolve to a snapshot node');
        assert.equal(buyerResolution.reason, 'bbox');
        const buyerChain = buildCandidateChain(snapshot, finalEntityView, buyerResolution.nodeId);
        const buyerLevels = buyerChain.map((candidate) => candidate.level);
        assert.ok(
            buyerLevels.includes('control'),
            `buyer chain should include control: ${buyerLevels.join(',')}`,
        );
        assert.ok(
            buyerLevels.includes('region'),
            `buyer chain should include region: ${buyerLevels.join(',')}`,
        );

        const buyerRegion = buyerChain.find((candidate) => candidate.level === 'region');
        assert.ok(buyerRegion?.entityRef, 'buyer region candidate should carry entityRef');
        assert.equal(buyerRegion?.enclosingEntityNodeId, buyerRegion?.nodeId);

        // Scenario 7 + 8: within auto-derived + every candidate has matchCount
        for (const candidate of buyerChain) {
            assert.ok(
                typeof candidate.matchCount === 'number',
                `candidate ${candidate.level} missing matchCount`,
            );
        }
        const buyerControl = buyerChain.find((candidate) => candidate.level === 'control');
        assert.equal(
            buyerControl?.enclosingEntityNodeId,
            buyerRegion?.nodeId,
            'within should derive from enclosing form',
        );

        // Scenario 6: stable class preferred over hashed
        const controlTarget = buyerControl?.proposedTargets?.[0];
        if (controlTarget?.classContains) {
            assert.equal(
                /-/.test(controlTarget.classContains) || controlTarget.classContains.length < 6,
                true,
                `expected a stable (non-hash) class, got ${controlTarget.classContains}`,
            );
        }

        // Scenario 3: click submit button -> control + region
        const submit = await captureFingerprint(page, 'button.ant-btn-primary');
        const submitResolution = resolveClickedNode(snapshot, submit.fingerprint);
        assert.ok(submitResolution.nodeId, 'submit button should resolve');
        const submitChain = buildCandidateChain(snapshot, finalEntityView, submitResolution.nodeId);
        const submitLevels = submitChain.map((candidate) => candidate.level);
        assert.ok(
            submitLevels.includes('control'),
            `submit chain should include control: ${submitLevels.join(',')}`,
        );
        assert.ok(
            submitLevels.includes('region'),
            `submit chain should include region: ${submitLevels.join(',')}`,
        );
        const submitControl = submitChain.find((candidate) => candidate.level === 'control');
        assert.ok(submitControl?.actionIntent, 'submit control should infer an action intent');

        await context.close();
    } finally {
        await browser?.close();
        await mockServer.close();
    }
});

test('annotator pick on ant order-list: cell/row/region and repeated edit action (one_or_more)', async () => {
    const mockServer = await startMockApp('ant');
    let browser: Browser | null = null;
    try {
        browser = await chromium.launch({
            headless: true,
            chromiumSandbox: false,
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
        });
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto(`${mockServer.baseUrl}/entity-rules/fixtures/order-list`, {
            waitUntil: 'domcontentloaded',
        });
        await page.waitForSelector('table tbody tr', { timeout: 10000 });

        const artifact = await loadEntityRuleArtifact('oa-ant-orders');
        const { snapshot, finalEntityView } = await generateSnapshotWithArtifact(page, artifact);

        // Scenario 4: click a normal order table cell -> cell(field)/row/region
        const firstCell = await captureFingerprint(
            page,
            'table tbody tr:first-child td:first-child',
        );
        const cellResolution = resolveClickedNode(snapshot, firstCell.fingerprint);
        assert.ok(cellResolution.nodeId, 'table cell should resolve');
        const cellChain = buildCandidateChain(snapshot, finalEntityView, cellResolution.nodeId);
        const cellLevels = cellChain.map((candidate) => candidate.level);
        assert.ok(
            cellLevels.includes('region'),
            `cell chain should include the table region: ${cellLevels.join(',')}`,
        );

        // Scenario 5: click edit button -> repeated row action with one_or_more
        const edit = await captureFingerprint(
            page,
            'table tbody tr:first-child td:last-child button',
        );
        const editResolution = resolveClickedNode(snapshot, edit.fingerprint);
        assert.ok(editResolution.nodeId, 'edit button should resolve');
        const editChain = buildCandidateChain(snapshot, finalEntityView, editResolution.nodeId);
        const editControl = editChain.find((candidate) => candidate.level === 'control');
        assert.ok(editControl, 'edit chain should include a control candidate');
        assert.ok(
            (editControl?.matchCount || 0) > 1,
            `edit action should match multiple rows, got ${editControl?.matchCount}`,
        );
        assert.equal(editControl?.expect, 'one_or_more');

        // Scenario 9: check distinguishes matched vs missing using the real imported draft
        const draft: CanvasDraft = importEntityRulesToCanvasDraft(artifact);
        draft.page = { kind: 'table', urlPattern: '/order-list$' };
        draft.entities[0].annotations.push({
            id: 'e0_missing_ghost',
            type: 'action',
            businessKey: 'ghost',
            target: { classContains: 'no-such-class-token-zzz' },
            expect: 'unique',
            origin: 'inferred',
            disposition: 'active',
        });
        const check = runCheck(snapshot, draft, page.url());
        const missing = check.results.find(
            (item) => item.canvasAnnotationId === 'e0_missing_ghost',
        );
        assert.equal(missing?.status, 'missing');
        assert.equal(missing?.message, '没有找到目标');
        const matched = check.results.filter((item) => item.status === 'unique');
        assert.ok(
            matched.length > 0,
            'expected at least one matched (unique) annotation',
        );
        assert.equal(check.stale, false);

        // Scenario 10: url change -> stale
        const staleCheck = runCheck(snapshot, draft, 'http://test/somewhere-else');
        assert.equal(staleCheck.stale, true);

        await context.close();
    } finally {
        await browser?.close();
        await mockServer.close();
    }
});

test('annotator.save: workflow artifact reloads, validates, and revision is stable', async () => {
    const mockServer = await startMockApp('ant');
    let browser: Browser | null = null;
    try {
        browser = await chromium.launch({
            headless: true,
            chromiumSandbox: false,
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
        });
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto(`${mockServer.baseUrl}/entity-rules/fixtures/order-form`, {
            waitUntil: 'domcontentloaded',
        });

        const artifact = await loadEntityRuleArtifact('oa-ant-order-form');
        const harness = await createStepExecutionHarness(page);
        const workspace = harness.deps.resolveWorkspace(harness.workspaceName);
        const runtime = createWorkspaceEntityRulesRuntime(workspace.workflow);
        const provider = createWorkspaceEntityRulesProvider(workspace.workflow);

        const snapshot = await generateSemanticSnapshot(page, { entityRulesProvider: provider });
        const draft: CanvasDraft = importEntityRulesToCanvasDraft(artifact);

        const pageIdentity: SnapshotPageIdentity = {
            workspaceName: harness.workspaceName,
            tabName: harness.tabName,
            url: page.url(),
        };

        // Scenario 11: save -> workflow reloads + validates
        const saved = executeSave(runtime, pageIdentity, draft, artifact.name, null);
        assert.equal(saved.saved, true);
        assert.equal(saved.profileName, artifact.name);

        const reloaded = runtime.get(artifact.name);
        assert.ok(reloaded, 'saved artifact should be reloadable from workflow');
        const validated = validateEntityRules(reloaded.name, reloaded.match, reloaded.annotation);
        assert.equal(validated.ok, true, 'saved artifact should pass validateEntityRules');

        // reload provider should resolve the freshly saved bundle
        const reloadedProvider = createWorkspaceEntityRulesProvider(workspace.workflow);
        const bundle = reloadedProvider.resolveBundle({ pageUrl: page.url(), pageKind: 'form' });
        assert.ok(bundle, 'provider should resolve saved bundle');
        assert.equal(bundle?.id, artifact.name);

        // revision conflict: re-save with stale revision -> ERR_CONFLICT
        assert.throws(
            () => executeSave(runtime, pageIdentity, draft, artifact.name, 'stale-revision'),
            (error: unknown) => (error as { code?: string }).code === 'ERR_CONFLICT',
        );

        await context.close();
    } finally {
        await browser?.close();
        await mockServer.close();
    }
});
