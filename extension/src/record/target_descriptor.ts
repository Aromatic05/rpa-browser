/**
 * target_descriptor：生成可序列化的 TargetDescriptor。
 *
 * 设计说明：
 * - 不能携带 Element 引用（无法序列化）
 * - selector 保持轻量，避免复杂定位策略
 * - text 仅保留少量信息，防止拼接整页内容
 */

export type TargetDescriptor = {
    tag: string;
    id?: string;
    nameAttr?: string;
    typeAttr?: string;
    roleAttr?: string;
    ariaLabel?: string;
    text?: string;
    selector?: string;
    inputValue?: string;
};

const collapseSpaces = (value: string) => value.replace(/\s+/g, ' ').trim();

const safeAttrValue = (value: string) => value.replace(/"/g, '\\"');

const pickSelector = (el: Element) => {
    const tag = el.tagName.toLowerCase();
    const id = el.getAttribute('id');
    if (id) return `#${id}`;
    const nameAttr = el.getAttribute('name');
    if (nameAttr && nameAttr.length < 64) {
        return `${tag}[name=\"${safeAttrValue(nameAttr)}\"]`;
    }
    const classList = Array.from(el.classList || []).filter(Boolean).slice(0, 2);
    if (classList.length > 0) {
        return `${tag}.${classList.join('.')}`;
    }
    return tag;
};

const pickText = (el: Element) => {
    const tag = el.tagName.toLowerCase();
    if (tag === 'select' && el instanceof HTMLSelectElement) {
        const selected = el.selectedOptions?.[0]?.text || '';
        const trimmed = collapseSpaces(selected);
        return trimmed ? trimmed.slice(0, 80) : undefined;
    }
    const raw = el.textContent || '';
    const trimmed = collapseSpaces(raw);
    if (!trimmed) return undefined;
    return trimmed.length > 80 ? trimmed.slice(0, 80) : trimmed;
};

export const describeTarget = (
    el: Element,
    opts?: {
        includeInputValue?: boolean;
    },
): TargetDescriptor => {
    const tag = el.tagName.toLowerCase();
    const id = el.getAttribute('id') || undefined;
    const nameAttr = el.getAttribute('name') || undefined;
    const typeAttr = el.getAttribute('type') || undefined;
    const roleAttr = el.getAttribute('role') || undefined;
    const ariaLabel = el.getAttribute('aria-label') || undefined;

    const target: TargetDescriptor = {
        tag,
        id,
        nameAttr,
        typeAttr,
        roleAttr,
        ariaLabel,
        text: pickText(el),
        selector: pickSelector(el),
    };

    if (opts?.includeInputValue) {
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
            target.inputValue = el.value;
        }
    }

    return target;
};
