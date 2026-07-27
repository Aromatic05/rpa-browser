import { test, expect } from '@playwright/test';
import crypto from 'node:crypto';
import { dispatch, runStep, startAgent } from '../../helpers/e2e_multitab_helper';
import { startFixtureServer } from '../../helpers/server';
import { startMockApp } from '../../integration/entity_rules/verify/helper';
import { loadEntityRuleArtifact } from '../../integration/entity_rules/profile_fixture';
import type { Action } from '../../../src/actions/action_protocol';
import type { StepUnion } from '../../../src/runner/steps/types';

const action = (
    type: string,
    workspaceName: string,
    payload: Record<string, unknown> = {},
): Action => ({
    v: 1,
    id: crypto.randomUUID(),
    type,
    workspaceName,
    payload,
    at: Date.now(),
});

const controlAction = (type: string, payload: Record<string, unknown> = {}): Action => ({
    v: 1,
    id: crypto.randomUUID(),
    type,
    payload,
    at: Date.now(),
});

const step = <T extends StepUnion['name']>(
    id: string,
    name: T,
    args: Extract<StepUnion, { name: T }>['args'],
): Extract<StepUnion, { name: T }> => ({ id, name, args } as Extract<StepUnion, { name: T }>);

test('requires entity selection before recognizing and saving internal annotations', async ({}, testInfo) => {
    testInfo.setTimeout(180_000);
    const fixture = await startFixtureServer();
    const agent = await startAgent();
    const workspaceName = `annotator-entity-first-${Date.now()}`;
    try {
        expect(
            (await dispatch(agent.endpoint, controlAction('workspace.create', { workspaceName })))
                .type,
        ).toBe('workspace.create.result');
        const before = await dispatch(agent.endpoint, action('tab.list', workspaceName));
        const beforeNames = new Set(
            ((before.payload as { tabs?: Array<{ tabName: string }> })?.tabs || []).map(
                (tab) => tab.tabName,
            ),
        );
        expect((await dispatch(agent.endpoint, action('tab.open', workspaceName))).type).toBe(
            'tab.open.result',
        );
        let tabName = '';
        await expect
            .poll(
                async () => {
                    const listed = await dispatch(
                        agent.endpoint,
                        action('tab.list', workspaceName),
                    );
                    tabName =
                        (
                            (listed.payload as { tabs?: Array<{ tabName: string }> })?.tabs || []
                        ).find((tab) => !beforeNames.has(tab.tabName))?.tabName || '';
                    return tabName;
                },
                { timeout: 10_000 },
            )
            .toBeTruthy();
        expect(
            (
                await runStep(
                    agent.endpoint,
                    workspaceName,
                    step('switch', 'browser.switch_tab', { tabName }),
                )
            ).ok,
        ).toBe(true);
        expect(
            (
                await runStep(
                    agent.endpoint,
                    workspaceName,
                    step('goto', 'browser.goto', {
                        url: `${fixture.baseURL}/workflow/order_query.html`,
                    }),
                )
            ).ok,
        ).toBe(true);
        await expect
            .poll(
                async () =>
                    (
                        await runStep(
                            agent.endpoint,
                            workspaceName,
                            step(`fixture-${Date.now()}`, 'browser.evaluate', {
                                expression: `
                return {
                    rows: document.querySelectorAll('.orders-results tbody tr').length,
                    module: Boolean(document.querySelector('.orders-module')),
                };
            `,
                            }),
                        )
                    ).data,
                { timeout: 20_000 },
            )
            .toEqual({ rows: 2, module: true });

        const shadowButtonPoint = async (selector: string): Promise<{ x: number; y: number }> => {
            const point = (
                await runStep(
                    agent.endpoint,
                    workspaceName,
                    step(`shadow-button-${Date.now()}`, 'browser.evaluate', {
                        expression: `
                    const root = document.querySelector('#rpa-entity-annotator-host')?.shadowRoot;
                    const button = root?.querySelector(${JSON.stringify(selector)});
                    if (!(button instanceof HTMLButtonElement) || button.disabled) return null;
                    const rect = button.getBoundingClientRect();
                    return {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2};
                `,
                    }),
                )
            ).data as { x: number; y: number } | null;
            expect(point, `${selector} should be enabled`).not.toBeNull();
            return point!;
        };

        let launcherPoint: {x: number; y: number} | null = null;
        await expect.poll(async () => {
            launcherPoint = (
                await runStep(
                    agent.endpoint,
                    workspaceName,
                    step(`launcher-${Date.now()}`, 'browser.evaluate', {
                        expression: `
                    const root = document.querySelector('#rpa-floating-panel')?.shadowRoot;
                    const button = root?.querySelector('.annotate-launch');
                    if (!(button instanceof HTMLButtonElement)) return null;
                    const rect = button.getBoundingClientRect();
                    return {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2};
                `,
                    }),
                )
            ).data as {x: number; y: number} | null;
            return launcherPoint;
        }, {timeout: 20_000}).not.toBeNull();
        expect(
            (
                await runStep(
                    agent.endpoint,
                    workspaceName,
                    step(`launch-${Date.now()}`, 'browser.mouse', {
                        action: 'click',
                        ...launcherPoint!,
                    }),
                )
            ).ok,
        ).toBe(true);

        await expect
            .poll(
                async () =>
                    (
                        await runStep(
                            agent.endpoint,
                            workspaceName,
                            step(`empty-state-${Date.now()}`, 'browser.evaluate', {
                                expression: `
                const root = document.querySelector('#rpa-entity-annotator-host')?.shadowRoot;
                const shell = root?.querySelector('.annotator-shell');
                return {
                    mode: shell?.getAttribute('data-annotator-mode'),
                    draft: shell?.getAttribute('data-annotator-draft'),
                    selectEntity: Boolean(root?.querySelector('[data-annotator-action="select-entity"]')),
                    recognize: Boolean(root?.querySelector('[data-annotator-action="recognize"]')),
                };
            `,
                            }),
                        )
                    ).data,
                { timeout: 20_000 },
            )
            .toEqual({
                mode: 'editing',
                draft: 'empty',
                selectEntity: true,
                recognize: false,
            });
        const selectEntityPoint = await shadowButtonPoint(
            '[data-annotator-action="select-entity"]',
        );
        const selectHit = (
            await runStep(
                agent.endpoint,
                workspaceName,
                step(`select-hit-${Date.now()}`, 'browser.evaluate', {
                    expression: `
                const root = document.querySelector('#rpa-entity-annotator-host')?.shadowRoot;
                const button = root?.querySelector('[data-annotator-action="select-entity"]');
                const rect = button?.getBoundingClientRect();
                const x = ${selectEntityPoint.x};
                const y = ${selectEntityPoint.y};
                const shadowHit = root?.elementFromPoint?.(x, y);
                const docHit = document.elementFromPoint(x, y);
                return {
                    shadowTag: shadowHit?.tagName || '',
                    shadowText: shadowHit?.textContent?.replace(/\\s+/g, ' ').trim() || '',
                    shadowAction: shadowHit?.closest?.('button')?.getAttribute('data-annotator-action') || '',
                    docId: docHit?.id || '',
                    hostPointer: getComputedStyle(document.querySelector('#rpa-entity-annotator-host')).pointerEvents,
                    rect: rect ? {left: rect.left, top: rect.top, width: rect.width, height: rect.height} : null,
                    viewport: {width: innerWidth, height: innerHeight},
                };
            `,
                }),
            )
        ).data;
        expect(selectHit).toEqual({
            shadowTag: expect.any(String),
            shadowText: expect.stringContaining('在页面中选择区域'),
            shadowAction: 'select-entity',
            docId: 'rpa-entity-annotator-host',
            hostPointer: 'auto',
            rect: expect.any(Object),
            viewport: expect.any(Object),
        });
        expect(
            (
                await runStep(
                    agent.endpoint,
                    workspaceName,
                    step(`select-entity-${Date.now()}`, 'browser.mouse', {
                        action: 'click',
                        ...selectEntityPoint,
                    }),
                )
            ).ok,
        ).toBe(true);

        await expect.poll(async () => (
            await runStep(
                agent.endpoint,
                workspaceName,
                step(`pick-mode-active-${Date.now()}`, 'browser.evaluate', {
                    expression: `
                const root = document.querySelector('#rpa-entity-annotator-host')?.shadowRoot;
                return {
                    pickMode: root?.querySelector('.annotator-shell')?.getAttribute('data-pick-mode') || '',
                    guide: Boolean(root?.querySelector('.pick-guide')),
                };
            `,
                }),
            )
        ).data, {timeout: 10_000}).toEqual({pickMode: 'active', guide: true});

        const tableCellPoint = (
            await runStep(
                agent.endpoint,
                workspaceName,
                step(`table-cell-${Date.now()}`, 'browser.evaluate', {
                    expression: `
                const cell = document.querySelector('.orders-results tbody td');
                if (!(cell instanceof HTMLElement)) return null;
                const rect = cell.getBoundingClientRect();
                return {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2};
            `,
                }),
            )
        ).data as { x: number; y: number } | null;
        expect(tableCellPoint).not.toBeNull();
        expect(
            (
                await runStep(
                    agent.endpoint,
                    workspaceName,
                    step(`pick-entity-${Date.now()}`, 'browser.mouse', {
                        action: 'click',
                        ...tableCellPoint!,
                    }),
                )
            ).ok,
        ).toBe(true);

        await expect
            .poll(
                async () =>
                    (
                        await runStep(
                            agent.endpoint,
                            workspaceName,
                            step(`entity-candidate-${Date.now()}`, 'browser.evaluate', {
                                expression: `
                const root = document.querySelector('#rpa-entity-annotator-host')?.shadowRoot;
                const overlay = root?.querySelector('.annotator-pick-overlay');
                return {
                    open: Boolean(overlay),
                    text: overlay?.textContent?.replace(/\\s+/g, ' ').trim() || '',
                    guide: Boolean(root?.querySelector('.pick-guide')),
                    error: root?.querySelector('.product-error p')?.textContent?.trim() || '',
                };
            `,
                            }),
                        )
                    ).data,
                { timeout: 20_000 },
            )
            .toEqual({
                open: true,
                text: expect.stringContaining('订单查询列表'),
                guide: true,
                error: '',
            });

        const confirmEntityPoint = await shadowButtonPoint('.annotator-pick-confirm');
        expect(
            (
                await runStep(
                    agent.endpoint,
                    workspaceName,
                    step(`confirm-entity-${Date.now()}`, 'browser.mouse', {
                        action: 'click',
                        ...confirmEntityPoint,
                    }),
                )
            ).ok,
        ).toBe(true);

        await expect
            .poll(
                async () =>
                    (
                        await runStep(
                            agent.endpoint,
                            workspaceName,
                            step(`scope-confirmed-${Date.now()}`, 'browser.evaluate', {
                                expression: `
                const root = document.querySelector('#rpa-entity-annotator-host')?.shadowRoot;
                return {
                    draft: root?.querySelector('.annotator-shell')?.getAttribute('data-annotator-draft'),
                    stage: root?.querySelector('.annotator-shell')?.getAttribute('data-product-stage') || '',
                    entityCount: root?.querySelectorAll('.annotator-entity-item').length || 0,
                    recognize: Boolean(root?.querySelector('[data-annotator-action="recognize"]')),
                    objectList: Boolean(root?.querySelector('.annotator-object-list')),
                };
            `,
                            }),
                        )
                    ).data,
                { timeout: 20_000 },
            )
            .toEqual({
                draft: 'present',
                stage: 'recognize',
                entityCount: 1,
                recognize: true,
                objectList: false,
            });

        const recognizePoint = await shadowButtonPoint('[data-annotator-action="recognize"]');
        expect(
            (
                await runStep(
                    agent.endpoint,
                    workspaceName,
                    step(`recognize-${Date.now()}`, 'browser.mouse', {
                        action: 'click',
                        ...recognizePoint,
                    }),
                )
            ).ok,
        ).toBe(true);

        await expect
            .poll(
                async () =>
                    (
                        await runStep(
                            agent.endpoint,
                            workspaceName,
                            step(`recognized-${Date.now()}`, 'browser.evaluate', {
                                expression: `
                const root = document.querySelector('#rpa-entity-annotator-host')?.shadowRoot;
                const shell = root?.querySelector('.annotator-shell');
                return {
                    stage: shell?.getAttribute('data-product-stage') || '',
                    summaryCards: root?.querySelectorAll('.review-summary > div').length || 0,
                    profile: shell?.getAttribute('data-annotator-profile') || '',
                    error: root?.querySelector('.annotator-error-banner p')?.textContent?.trim() || '',
                };
            `,
                            }),
                        )
                    ).data,
                { timeout: 30_000 },
            )
            .toEqual({
                stage: 'review',
                summaryCards: 5,
                profile: expect.stringMatching(/.+/),
                error: '',
            });
        const reviewPoint = await shadowButtonPoint('.review-stage .primary-action');
        expect(
            (
                await runStep(
                    agent.endpoint,
                    workspaceName,
                    step(`review-${Date.now()}`, 'browser.mouse', {
                        action: 'click',
                        ...reviewPoint,
                    }),
                )
            ).ok,
        ).toBe(true);
        const objectCount = (
            await runStep(
                agent.endpoint,
                workspaceName,
                step(`object-count-${Date.now()}`, 'browser.evaluate', {
                    expression: `
                return document.querySelector('#rpa-entity-annotator-host')?.shadowRoot
                    ?.querySelectorAll('.annotator-object-item').length || 0;
            `,
                }),
            )
        ).data as number;
        expect(objectCount).toBeGreaterThan(1);

        const savePoint = await shadowButtonPoint('.annotator-save-action');
        expect(
            (
                await runStep(
                    agent.endpoint,
                    workspaceName,
                    step(`save-${Date.now()}`, 'browser.mouse', { action: 'click', ...savePoint }),
                )
            ).ok,
        ).toBe(true);
        await expect
            .poll(
                async () =>
                    (
                        await runStep(
                            agent.endpoint,
                            workspaceName,
                            step(`saved-${Date.now()}`, 'browser.evaluate', {
                                expression: `
                const root = document.querySelector('#rpa-entity-annotator-host')?.shadowRoot;
                return {
                    status: root?.querySelector('.annotator-status')?.textContent?.trim() || '',
                    error: root?.querySelector('.annotator-error-banner p')?.textContent?.trim() || '',
                };
            `,
                            }),
                        )
                    ).data,
                { timeout: 30_000 },
            )
            .toEqual({ status: '已保存', error: '' });

        const listedRules = await dispatch(
            agent.endpoint,
            action('entity_rules.list', workspaceName),
        );
        expect(listedRules.type).toBe('entity_rules.list.result');
        const savedRules =
            (listedRules.payload as { entityRules?: Array<{ name?: string }> })?.entityRules || [];
        expect(
            savedRules.some((rule) => typeof rule.name === 'string' && rule.name.length > 0),
        ).toBe(true);

        const exitPoint = await shadowButtonPoint('[aria-label="退出页面标注"]');
        expect(
            (
                await runStep(
                    agent.endpoint,
                    workspaceName,
                    step(`exit-${Date.now()}`, 'browser.mouse', { action: 'click', ...exitPoint }),
                )
            ).ok,
        ).toBe(true);
        await expect
            .poll(
                async () =>
                    (
                        await runStep(
                            agent.endpoint,
                            workspaceName,
                            step(`exited-${Date.now()}`, 'browser.evaluate', {
                                expression: `
                const annotator = document.querySelector('#rpa-entity-annotator-host');
                return annotator instanceof HTMLElement && annotator.style.display === 'none';
            `,
                            }),
                        )
                    ).data,
                { timeout: 10_000 },
            )
            .toBe(true);

        const reopenPoint = (
            await runStep(
                agent.endpoint,
                workspaceName,
                step(`reopen-point-${Date.now()}`, 'browser.evaluate', {
                    expression: `
                const button = document.querySelector('#rpa-floating-panel')?.shadowRoot?.querySelector('.annotate-launch');
                if (!(button instanceof HTMLButtonElement)) return null;
                const rect = button.getBoundingClientRect();
                return {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2};
            `,
                }),
            )
        ).data as { x: number; y: number } | null;
        expect(reopenPoint).not.toBeNull();
        expect(
            (
                await runStep(
                    agent.endpoint,
                    workspaceName,
                    step(`reopen-${Date.now()}`, 'browser.mouse', {
                        action: 'click',
                        ...reopenPoint!,
                    }),
                )
            ).ok,
        ).toBe(true);
        await expect
            .poll(
                async () =>
                    (
                        await runStep(
                            agent.endpoint,
                            workspaceName,
                            step(`reopened-${Date.now()}`, 'browser.evaluate', {
                                expression: `
                const root = document.querySelector('#rpa-entity-annotator-host')?.shadowRoot;
                return {
                    draft: root?.querySelector('.annotator-shell')?.getAttribute('data-annotator-draft'),
                    status: root?.querySelector('.annotator-status')?.textContent?.trim() || '',
                    entityCount: root?.querySelectorAll('.annotator-entity-item').length || 0,
                };
            `,
                            }),
                        )
                    ).data,
                { timeout: 20_000 },
            )
            .toEqual({ draft: 'present', status: '已保存', entityCount: 1 });
    } finally {
        await agent.close();
        await fixture.close();
    }
});

test('renders table columns, repeated row actions and pagination from saved rules', async ({}, testInfo) => {
    testInfo.setTimeout(150_000);
    const mock = await startMockApp('ant');
    const agent = await startAgent();
    const workspaceName = `annotator-table-${Date.now()}`;
    try {
        expect(
            (await dispatch(agent.endpoint, controlAction('workspace.create', { workspaceName })))
                .type,
        ).toBe('workspace.create.result');
        const before = await dispatch(agent.endpoint, action('tab.list', workspaceName));
        const previousNames = new Set(
            ((before.payload as { tabs?: Array<{ tabName?: string }> })?.tabs || [])
                .map((tab) => tab.tabName)
                .filter((name): name is string => Boolean(name)),
        );
        expect((await dispatch(agent.endpoint, action('tab.open', workspaceName))).type).toBe(
            'tab.open.result',
        );
        let tabName = '';
        await expect
            .poll(
                async () => {
                    const listed = await dispatch(
                        agent.endpoint,
                        action('tab.list', workspaceName),
                    );
                    const tabs =
                        (listed.payload as { tabs?: Array<{ tabName?: string }> })?.tabs || [];
                    tabName =
                        tabs.find((tab) => tab.tabName && !previousNames.has(tab.tabName))
                            ?.tabName || '';
                    return tabName;
                },
                { timeout: 20_000 },
            )
            .not.toBe('');
        expect(
            (
                await runStep(
                    agent.endpoint,
                    workspaceName,
                    step(`switch-${Date.now()}`, 'browser.switch_tab', { tabName }),
                )
            ).ok,
        ).toBe(true);

        const artifact = await loadEntityRuleArtifact('oa-ant-orders');
        expect(
            (
                await dispatch(
                    agent.endpoint,
                    action('entity_rules.save', workspaceName, { entityRules: artifact }),
                )
            ).type,
        ).toBe('entity_rules.save.result');
        expect(
            (
                await runStep(
                    agent.endpoint,
                    workspaceName,
                    step(`goto-${Date.now()}`, 'browser.goto', {
                        url: `${mock.baseUrl}/entity-rules/fixtures/order-list`,
                    }),
                )
            ).ok,
        ).toBe(true);
        await expect
            .poll(
                async () =>
                    (
                        await runStep(
                            agent.endpoint,
                            workspaceName,
                            step(`table-ready-${Date.now()}`, 'browser.evaluate', {
                                expression: `
                return document.querySelectorAll('table tbody tr').length;
            `,
                            }),
                        )
                    ).data,
                { timeout: 20_000 },
            )
            .toBeGreaterThan(0);

        const clickPanel = `
            const host = document.querySelector('#rpa-floating-panel');
            const root = host?.shadowRoot;
            if (!root) return false;
            if (!root.querySelector('.panel')?.classList.contains('open')) root.querySelector('.ball')?.click();
            [...root.querySelectorAll('.tabs button')].find((button) => button.textContent?.trim() === 'Flow')?.click();
            const enter = [...root.querySelectorAll('button')]
                .find((button) => button.textContent?.trim() === '进入标注模式');
            if (!(enter instanceof HTMLButtonElement)) return false;
            enter.click();
            return true;
        `;
        expect(
            (
                await runStep(
                    agent.endpoint,
                    workspaceName,
                    step(`open-${Date.now()}`, 'browser.evaluate', { expression: clickPanel }),
                )
            ).data,
        ).toBe(true);

        await expect
            .poll(
                async () =>
                    (
                        await runStep(
                            agent.endpoint,
                            workspaceName,
                            step(`labels-${Date.now()}`, 'browser.evaluate', {
                                expression: `
                const root = document.querySelector('#rpa-entity-annotator-host')?.shadowRoot;
                return [...(root?.querySelectorAll('.annotator-label') || [])]
                    .map((label) => label.textContent?.replace(/\\s+/g, ' ').trim() || '');
            `,
                            }),
                        )
                    ).data,
                { timeout: 20_000 },
            )
            .toEqual(
                expect.arrayContaining([
                    expect.stringContaining('订单编号'),
                    expect.stringContaining('采购人'),
                    expect.stringContaining('金额'),
                    expect.stringContaining('状态'),
                    expect.stringContaining('操作'),
                    expect.stringContaining('编辑'),
                    expect.stringContaining('删除'),
                    expect.stringContaining('nextPage'),
                ]),
            );

        const actionSummary = (
            await runStep(
                agent.endpoint,
                workspaceName,
                step(`action-summary-${Date.now()}`, 'browser.evaluate', {
                    expression: `
                const root = document.querySelector('#rpa-entity-annotator-host')?.shadowRoot;
                const labels = [...(root?.querySelectorAll('.annotator-label') || [])]
                    .map((label) => ({
                        id: label.getAttribute('data-annotation-id') || '',
                        text: label.textContent?.replace(/\\s+/g, ' ').trim() || '',
                    }));
                return {
                    edit: labels.filter((label) => label.text.includes('编辑')),
                    remove: labels.filter((label) => label.text.includes('删除')),
                };
            `,
                }),
            )
        ).data as {
            edit: Array<{ id: string; text: string }>;
            remove: Array<{ id: string; text: string }>;
        };
        expect(actionSummary.edit).toHaveLength(1);
        expect(actionSummary.remove).toHaveLength(1);
        expect(actionSummary.edit[0].text).toMatch(/x\d+/);
        expect(actionSummary.remove[0].text).toMatch(/x\d+/);

        const editLabelPoint = (
            await runStep(
                agent.endpoint,
                workspaceName,
                step(`edit-label-point-${Date.now()}`, 'browser.evaluate', {
                    expression: `
                const root = document.querySelector('#rpa-entity-annotator-host')?.shadowRoot;
                const label = [...(root?.querySelectorAll('.annotator-label') || [])]
                    .find((item) => item.textContent?.includes('编辑'));
                if (!(label instanceof HTMLElement)) return null;
                const rect = label.getBoundingClientRect();
                const x = rect.left + rect.width / 2;
                const y = rect.top + rect.height / 2;
                return {
                    x,
                    y,
                    hitClass: root?.elementFromPoint?.(x, y)?.getAttribute('class') || '',
                };
            `,
                }),
            )
        ).data as { x: number; y: number; hitClass: string } | null;
        expect(editLabelPoint).not.toBeNull();
        expect(editLabelPoint!.hitClass).toContain('annotator-label');
        expect(
            (
                await runStep(
                    agent.endpoint,
                    workspaceName,
                    step(`select-edit-${Date.now()}`, 'browser.mouse', {
                        action: 'click',
                        ...editLabelPoint!,
                    }),
                )
            ).ok,
        ).toBe(true);

        const selectedDiagnostic = (
            await runStep(
                agent.endpoint,
                workspaceName,
                step(`selected-diagnostic-${Date.now()}`, 'browser.evaluate', {
                    expression: `
                const root = document.querySelector('#rpa-entity-annotator-host')?.shadowRoot;
                const hit = root?.elementFromPoint?.(${editLabelPoint!.x}, ${editLabelPoint!.y});
                const label = root?.querySelector('[data-annotation-id="${
                    actionSummary.edit[0].id
                }"]');
                return {
                    hitClass: hit?.getAttribute('class') || '',
                    selected: label?.classList.contains('selected') || false,
                    card: Boolean(root?.querySelector('.annotator-edit-card')),
                };
            `,
                }),
            )
        ).data;
        expect(selectedDiagnostic).toEqual({
            hitClass: expect.stringContaining('annotator-label'),
            selected: true,
            card: true,
        });

        expect(
            (
                await runStep(
                    agent.endpoint,
                    workspaceName,
                    step(`open-advanced-${Date.now()}`, 'browser.evaluate', {
                        expression: `
                const details = document.querySelector('#rpa-entity-annotator-host')?.shadowRoot
                    ?.querySelector('.advanced-settings');
                if (!(details instanceof HTMLDetailsElement)) return false;
                details.open = true;
                return true;
            `,
                    }),
                )
            ).data,
        ).toBe(true);

        let businessKeyPoint: { x: number; y: number; value: string } | null = null;
        await expect
            .poll(
                async () => {
                    businessKeyPoint = (
                        await runStep(
                            agent.endpoint,
                            workspaceName,
                            step(`edit-card-${Date.now()}`, 'browser.evaluate', {
                                expression: `
                    const root = document.querySelector('#rpa-entity-annotator-host')?.shadowRoot;
                    const input = root?.querySelector('.advanced-settings input');
                    if (!(input instanceof HTMLInputElement)) return null;
                    const rect = input.getBoundingClientRect();
                    return {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, value: input.value};
                `,
                            }),
                        )
                    ).data as { x: number; y: number; value: string } | null;
                    return businessKeyPoint;
                },
                { timeout: 10_000 },
            )
            .not.toBeNull();
        expect(businessKeyPoint!.value).toBe('edit');
        expect(
            (
                await runStep(
                    agent.endpoint,
                    workspaceName,
                    step(`fill-key-${Date.now()}`, 'browser.fill', {
                        selector: '#rpa-entity-annotator-host .advanced-settings input',
                        value: 'EDITROW',
                    }),
                )
            ).ok,
        ).toBe(true);
        await expect
            .poll(
                async () =>
                    (
                        await runStep(
                            agent.endpoint,
                            workspaceName,
                            step(`edited-label-${Date.now()}`, 'browser.evaluate', {
                                expression: `
                const root = document.querySelector('#rpa-entity-annotator-host')?.shadowRoot;
                const label = root?.querySelector('.annotator-label[data-annotation-id="${actionSummary.edit[0].id}"]');
                const box = root?.querySelector('.annotator-box[data-annotation-id="${actionSummary.edit[0].id}"] rect');
                return {
                    text: label?.textContent?.replace(/\\s+/g, ' ').trim() || '',
                    dash: box?.getAttribute('stroke-dasharray') || '',
                };
            `,
                            }),
                        )
                    ).data,
                { timeout: 10_000 },
            )
            .toEqual({ text: expect.stringContaining('EDITROW'), dash: '' });
    } finally {
        await agent.close();
        await mock.close();
    }
});
