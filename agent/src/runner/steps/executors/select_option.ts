import type { Locator, Page } from 'playwright';
import type { Step, StepResult } from '../types';
import type { RunStepsDeps } from '../../run_steps';
import { mapTraceError } from '../helpers/target';
import { pickDelayMs, waitForHumanDelay } from '../helpers/delay';
import { resolveTarget } from '../helpers/resolve_target';

type ChoiceControlType = 'native-select' | 'combobox' | 'popup-choice' | 'autocomplete' | 'unknown';

type ChoiceState = {
    controlType: ChoiceControlType;
    expanded: boolean;
    selectedValues: string[];
    selectedLabels: string[];
    displayText?: string;
    multiple: boolean;
    popupRole?: string;
    popupId?: string;
};

const ensureVisible = async (
    binding: Awaited<ReturnType<RunStepsDeps['runtime']['ensureActivePage']>>,
    selector: string,
    timeout?: number,
) => {
    const scroll = await binding.traceTools['trace.locator.scrollIntoView']({ selector });
    if (!scroll.ok) {return scroll;}
    return await binding.traceTools['trace.locator.waitForVisible']({ selector, timeout });
};

const canResolvePageLocator = (page: unknown): page is Page => {
    return Boolean(page && typeof (page as any).locator === 'function' && typeof (page as any).getByRole === 'function');
};

const normalizeChoiceToken = (value: unknown): string | undefined => {
    if (typeof value !== 'string') {return undefined;}
    const normalized = value.replace(/\s+/g, ' ').trim();
    return normalized || undefined;
};

const normalizeChoiceList = (values: unknown): string[] => {
    if (!Array.isArray(values)) {return [];}
    const normalized = values
        .map((item) => normalizeChoiceToken(item))
        .filter((item): item is string => Boolean(item));
    return [...new Set(normalized)];
};

const lower = (value: string): string => value.replace(/\s+/g, ' ').trim().toLowerCase();

const readChoiceState = async (locator: Locator): Promise<ChoiceState> => {
    const raw = await locator.evaluate((node) => {
        const element = node as HTMLElement | null;
        if (!element) {
            return {
                controlType: 'unknown',
                expanded: false,
                selectedValues: [] as string[],
                selectedLabels: [] as string[],
                multiple: false,
            };
        }
        const tag = (element.tagName || '').toLowerCase();
        const role = (element.getAttribute('role') || '').toLowerCase();
        const popupId = (element.getAttribute('aria-controls') || element.getAttribute('aria-owns') || '').trim();
        const popup = popupId ? document.getElementById(popupId) : null;
        const popupRole = (popup?.getAttribute('role') || '').toLowerCase() || undefined;
        const expanded = (element.getAttribute('aria-expanded') || '').toLowerCase() === 'true';
        const popupVisible = Boolean(popup && popup.isConnected && popup.clientHeight > 0 && popup.clientWidth > 0);

        if (tag === 'select') {
            const select = element as HTMLSelectElement;
            const selectedOptions = Array.from(select.selectedOptions || []);
            const selectedValues = Array.from(
                new Set(
                    selectedOptions
                        .map((opt) => (opt.value || '').trim())
                        .filter(Boolean),
                ),
            );
            const selectedLabels = Array.from(
                new Set(
                    selectedOptions
                        .map((opt) => (opt.textContent || '').trim())
                        .filter(Boolean),
                ),
            );
            return {
                controlType: 'native-select',
                expanded: expanded || popupVisible,
                selectedValues,
                selectedLabels,
                displayText: selectedLabels[0],
                multiple: Boolean(select.multiple),
                popupRole,
                popupId: popupId || undefined,
            };
        }

        const selectedValues: string[] = [];
        const selectedLabels: string[] = [];
        const value = (element as HTMLInputElement).value || '';
        const text = (element.textContent || '').trim();
        if (value) {
            selectedValues.push(value);
            selectedLabels.push(value);
        }
        if (text) {selectedLabels.push(text);}

        const activeId = (element.getAttribute('aria-activedescendant') || '').trim();
        if (activeId) {
            const active = document.getElementById(activeId);
            const activeText = (active?.textContent || '').trim();
            if (activeText) {selectedLabels.push(activeText);}
            const activeValue =
                (active?.getAttribute('data-value') || active?.getAttribute('value') || active?.getAttribute('aria-label') || '').trim();
            if (activeValue) {selectedValues.push(activeValue);}
        }

        if (popup) {
            const selectedNodes = popup.querySelectorAll(
                '[role="option"][aria-selected="true"], [role="menuitem"][aria-selected="true"], [data-selected="true"], [aria-checked="true"]',
            );
            for (const selectedNode of Array.from(selectedNodes)) {
                const nodeText = (selectedNode.textContent || '').trim();
                if (nodeText) {selectedLabels.push(nodeText);}
                const nodeValue =
                    (selectedNode.getAttribute('data-value') ||
                        selectedNode.getAttribute('value') ||
                        selectedNode.getAttribute('aria-label') ||
                        selectedNode.getAttribute('title') ||
                        '').trim();
                if (nodeValue) {selectedValues.push(nodeValue);}
            }
        }

        const isAutocomplete = tag === 'input' && Boolean(element.getAttribute('aria-autocomplete') || element.getAttribute('list'));
        const hasPopup = role === 'combobox' || Boolean(element.getAttribute('aria-haspopup'));
        const controlType: ChoiceControlType = isAutocomplete
            ? 'autocomplete'
            : role === 'combobox'
              ? 'combobox'
              : hasPopup
                ? 'popup-choice'
                : 'unknown';

        const dedupLabels = Array.from(new Set(selectedLabels.map((item) => item.trim()).filter(Boolean)));
        return {
            controlType,
            expanded: expanded || popupVisible,
            selectedValues: Array.from(new Set(selectedValues.map((item) => item.trim()).filter(Boolean))),
            selectedLabels: dedupLabels,
            displayText: dedupLabels[0],
            multiple: Boolean(element.getAttribute('aria-multiselectable') === 'true' || element.getAttribute('multiple')),
            popupRole,
            popupId: popupId || undefined,
        };
    });
    return {
        controlType:
            raw.controlType === 'native-select' ||
            raw.controlType === 'combobox' ||
            raw.controlType === 'popup-choice' ||
            raw.controlType === 'autocomplete'
                ? raw.controlType
                : 'unknown',
        expanded: raw.expanded,
        selectedValues: normalizeChoiceList(raw.selectedValues),
        selectedLabels: normalizeChoiceList(raw.selectedLabels),
        displayText: normalizeChoiceToken(raw.displayText),
        multiple: raw.multiple,
        popupRole: normalizeChoiceToken(raw.popupRole),
        popupId: normalizeChoiceToken(raw.popupId),
    };
};

const buildStateSignature = (state: ChoiceState): string =>
    JSON.stringify({
        controlType: state.controlType,
        selectedValues: state.selectedValues.map(lower).sort(),
        selectedLabels: state.selectedLabels.map(lower).sort(),
        displayText: state.displayText ? lower(state.displayText) : '',
        expanded: state.expanded,
    });

const validateExpectedAndChanged = (
    stepId: string,
    before: ChoiceState,
    after: ChoiceState,
    expectedRaw: string[],
    details: Record<string, unknown>,
): StepResult | null => {
    const expected = normalizeChoiceList(expectedRaw);
    if (buildStateSignature(before) === buildStateSignature(after)) {
        return {
            stepId,
            ok: false,
            error: {
                code: 'ERR_ASSERTION_FAILED',
                message: 'state not changed after selection',
                details: { ...details, expected, before, after },
            },
        };
    }

    const candidates = new Set(
        [
            ...after.selectedValues,
            ...after.selectedLabels,
            ...(after.displayText ? [after.displayText] : []),
        ]
            .map(lower)
            .filter(Boolean),
    );
    const missing = expected.filter((item) => !candidates.has(lower(item)));
    if (missing.length > 0) {
        return {
            stepId,
            ok: false,
            error: {
                code: 'ERR_NOT_FOUND',
                message: 'option not found',
                details: { ...details, expected, missing, after },
            },
        };
    }
    return null;
};

const resolvePageLocator = async (
    page: Page,
    selector: string,
): Promise<{ ok: true; locator: Locator } | { ok: false; error: StepResult['error'] }> => {
    const locator = page.locator(selector);
    const count = await locator.count();
    if (count === 0) {
        return {
            ok: false,
            error: { code: 'ERR_NOT_FOUND', message: 'selector not found', details: { selector } },
        };
    }
    if (count > 1) {
        return {
            ok: false,
            error: { code: 'ERR_AMBIGUOUS', message: 'selector matches multiple elements', details: { selector, count } },
        };
    }
    return { ok: true, locator: locator.first() };
};

const isLocatorVisible = async (locator: Locator): Promise<boolean> => {
    const count = await locator.count();
    if (count === 0) {return false;}
    try {
        return await locator.first().isVisible();
    } catch {
        return false;
    }
};

const listVisiblePopupIds = async (page: Page): Promise<string[]> => {
    const candidates = page.locator('[role="listbox"], [role="menu"], [role="dialog"]');
    const count = await candidates.count();
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) {
        const candidate = candidates.nth(i);
        if (!(await isLocatorVisible(candidate))) {continue;}
        const id = normalizeChoiceToken(await candidate.getAttribute('id'));
        if (id) {ids.push(id);}
    }
    return ids;
};

const escapeCssId = (value: string): string => value.replace(/[^A-Za-z0-9_-]/g, '\\$&');
const escapeCssText = (value: string): string => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

const openChoicePopup = async (
    page: Page,
    control: Locator,
    before: ChoiceState,
    timeout?: number,
): Promise<Locator | null> => {
    const visiblePopupIdsBefore = await listVisiblePopupIds(page);
    if (!before.expanded) {
        try {
            await control.click({ timeout });
        } catch {
            await control.focus();
            await page.keyboard.press('ArrowDown');
        }
    }

    const relation = await control.evaluate((node) => ({
        popupId: ((node as Element | null)?.getAttribute('aria-controls') || (node as Element | null)?.getAttribute('aria-owns') || '').trim(),
    }));
    const popupId = normalizeChoiceToken(relation.popupId);
    if (popupId) {
        const linked = page.locator(`#${escapeCssId(popupId)}`);
        if ((await linked.count()) === 1 && (await isLocatorVisible(linked.first()))) {return linked.first();}
    }

    const candidates = page.locator('[role="listbox"], [role="menu"], [role="dialog"]');
    const count = await candidates.count();
    const beforeSet = new Set(visiblePopupIdsBefore);
    let fallback: Locator | null = null;
    for (let i = 0; i < count; i += 1) {
        const candidate = candidates.nth(i);
        if (!(await isLocatorVisible(candidate))) {continue;}
        const id = normalizeChoiceToken(await candidate.getAttribute('id'));
        if (id && !beforeSet.has(id)) {return candidate;}
        if (!fallback) {fallback = candidate;}
    }
    return fallback;
};

const findUniqueVisible = async (locator: Locator): Promise<Locator | null> => {
    const count = await locator.count();
    let found: Locator | null = null;
    for (let i = 0; i < count; i += 1) {
        const current = locator.nth(i);
        if (!(await isLocatorVisible(current))) {continue;}
        if (found) {return null;}
        found = current;
    }
    return found;
};

const findOptionInPopup = async (popup: Locator, value: string): Promise<Locator | null> => {
    const prioritySelectors = [
        `[role="option"][value="${escapeCssText(value)}"]`,
        `[role="option"][data-value="${escapeCssText(value)}"]`,
        `[role="option"][data-key="${escapeCssText(value)}"]`,
        `[role="menuitem"][value="${escapeCssText(value)}"]`,
        `[role="menuitem"][data-value="${escapeCssText(value)}"]`,
        `[role="menuitem"][data-key="${escapeCssText(value)}"]`,
        `[role="option"]:text-is("${escapeCssText(value)}")`,
        `[role="menuitem"]:text-is("${escapeCssText(value)}")`,
        `[role="option"][aria-label="${escapeCssText(value)}"]`,
        `[role="menuitem"][aria-label="${escapeCssText(value)}"]`,
        `[role="option"][title="${escapeCssText(value)}"]`,
        `[role="menuitem"][title="${escapeCssText(value)}"]`,
    ];
    for (const selector of prioritySelectors) {
        const located = await findUniqueVisible(popup.locator(selector));
        if (located) {return located;}
    }
    return null;
};

const chooseInCustomChoicePopup = async (
    page: Page,
    control: Locator,
    before: ChoiceState,
    values: string[],
    timeout?: number,
): Promise<{ ok: true } | { ok: false; error: StepResult['error'] }> => {
    const popup = await openChoicePopup(page, control, before, timeout);
    if (!popup) {
        return { ok: false, error: { code: 'ERR_NOT_FOUND', message: 'popup not found' } };
    }
    for (const value of normalizeChoiceList(values)) {
        const option = await findOptionInPopup(popup, value);
        if (!option) {
            return { ok: false, error: { code: 'ERR_NOT_FOUND', message: 'option not found', details: { value } } };
        }
        await option.click({ timeout });
    }
    return { ok: true };
};

export const executeBrowserSelectOption = async (
    step: Step<'browser.select_option'>,
    deps: RunStepsDeps,
    workspaceId: string,
): Promise<StepResult> => {
    const binding = await deps.runtime.ensureActivePage(workspaceId);
    const resolved = await resolveTarget(binding, {
        nodeId: step.args.nodeId,
        selector: step.args.selector,
        resolve: step.resolve,
    });
    if (!resolved.ok) {return { stepId: step.id, ok: false, error: resolved.error };}

    const timeout = step.args.timeout ?? deps.config.waitPolicy.visibleTimeoutMs;
    const visible = await ensureVisible(binding, resolved.target.selector, timeout);
    if (!visible.ok) {
        return { stepId: step.id, ok: false, error: mapTraceError(visible.error) };
    }

    if (!canResolvePageLocator(binding.page)) {
        const select = await binding.traceTools['trace.locator.selectOption']({
            selector: resolved.target.selector,
            values: step.args.values,
            timeout,
        });
        if (!select.ok) {return { stepId: step.id, ok: false, error: mapTraceError(select.error) };}
        const state = await binding.traceTools['trace.locator.readSelectState']({
            selector: resolved.target.selector,
        });
        if (!state.ok) {return { stepId: step.id, ok: false, error: mapTraceError(state.error) };}
        const result = validateExpectedAndChanged(
            step.id,
            { controlType: 'unknown', expanded: false, selectedValues: [], selectedLabels: [], multiple: false },
            {
                controlType: 'unknown',
                expanded: false,
                selectedValues: normalizeChoiceList(state.data?.selectedValues),
                selectedLabels: normalizeChoiceList(state.data?.selectedLabels),
                displayText: normalizeChoiceToken((state.data?.selectedLabels || [])[0]),
                multiple: false,
            },
            step.args.values,
            { target: resolved.target, path: 'trace-fallback' },
        );
        if (result) {return result;}
    } else {
        const pageLocatorResolved = await resolvePageLocator(binding.page, resolved.target.selector);
        if (!pageLocatorResolved.ok) {
            return { stepId: step.id, ok: false, error: pageLocatorResolved.error };
        }
        const control = pageLocatorResolved.locator;
        const before = await readChoiceState(control);

        if (before.controlType === 'native-select') {
            const select = await binding.traceTools['trace.locator.selectOption']({
                selector: resolved.target.selector,
                values: step.args.values,
                timeout,
            });
            if (!select.ok) {
                return { stepId: step.id, ok: false, error: mapTraceError(select.error) };
            }
        } else if (before.controlType === 'combobox' || before.controlType === 'popup-choice' || before.controlType === 'autocomplete') {
            const custom = await chooseInCustomChoicePopup(binding.page, control, before, step.args.values, timeout);
            if (!custom.ok) {
                return { stepId: step.id, ok: false, error: custom.error };
            }
        } else {
            return {
                stepId: step.id,
                ok: false,
                error: {
                    code: 'ERR_BAD_ARGS',
                    message: 'control type unsupported',
                    details: { target: resolved.target, state: before },
                },
            };
        }

        const after = await readChoiceState(control);
        const result = validateExpectedAndChanged(step.id, before, after, step.args.values, {
            target: resolved.target,
            controlType: before.controlType,
        });
        if (result) {return result;}
    }

    if (deps.config.humanPolicy.enabled) {
        const delayMs = pickDelayMs(deps.config.humanPolicy.typeDelayMsRange.min, deps.config.humanPolicy.typeDelayMsRange.max);
        if (delayMs > 0) {await waitForHumanDelay(binding.page, delayMs);}
    }
    return { stepId: step.id, ok: true };
};
