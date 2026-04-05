import type { Page } from 'playwright';
import { getA11yTree } from '../../../../trace/a11y/getA11yTree';
import { getDomTree } from '../../../../trace/dom/getDomTree';
import type { RawData } from '../core/types';

export const collectRawData = async (page: Page): Promise<RawData> => {
    // 采集入口只拼装原始数据，不在这里做复杂语义处理。
    const [domTree, a11yTree] = await Promise.all([getDomTree(page), getA11yTree(page)]);

    return {
        domTree,
        a11yTree,
    };
};
