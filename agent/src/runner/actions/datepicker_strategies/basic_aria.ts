import type { Page } from 'playwright';

const monthNames = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
];

const formatLabel = (value: string) => {
    const [year, month, day] = value.split('-').map((part) => Number(part));
    if (!year || !month || !day) return value;
    return `${monthNames[month - 1]} ${day}, ${year}`;
};

export const pickByAria = async (page: Page, value: string) => {
    const label = formatLabel(value);
    const locator = page.locator(`[aria-label*="${label}"], [aria-label*="${value}"]`).first();
    if (await locator.count()) {
        await locator.click();
        return true;
    }
    return false;
};
