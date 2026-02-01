/**
 * locator_builder：生成稳定的 a11y hint（优先 role/name，其次 text）。
 *
 * 设计说明：
 * - 录制阶段不依赖 agent 的 snapshot
 * - 输出 hint 供 agent 在 snapshot 阶段匹配 a11y 节点
 */

import type { A11yHint } from '../shared/types.js';

const getLabelText = (el: Element) => {
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) {
        return '';
    }
    const id = el.getAttribute('id');
    if (id) {
        const label = document.querySelector(`label[for="${id}"]`);
        if (label) return (label.textContent || '').trim();
    }
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) return ariaLabel.trim();
    return '';
};

const inferRole = (el: Element) => {
    const role = el.getAttribute('role');
    if (role) return role;
    const tag = el.tagName.toLowerCase();
    if (tag === 'button') return 'button';
    if (tag === 'a') return 'link';
    if (tag === 'input' || tag === 'textarea') return 'textbox';
    return undefined;
};

const inferName = (el: Element) => {
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) return ariaLabel.trim();
    const labelText = getLabelText(el);
    if (labelText) return labelText;
    const text = (el.textContent || '').trim();
    if (text) return text;
    return undefined;
};

export const buildA11yHint = (el: Element): A11yHint => {
    const role = inferRole(el);
    const name = inferName(el);
    const text = name;
    return { role, name, text };
};
