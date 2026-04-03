import type { Page } from 'playwright';
import { getA11yTree } from '../../../trace/getA11yTree';
import { getDomTree } from '../../../trace/getDomTree';
import type { RawData } from './types';

export const collectRawData = async (page: Page): Promise<RawData> => {
    // 采集入口只拼装原始数据，不在这里做复杂语义处理。
    const [domTree, a11yTree] = await Promise.all([getDomTree(page), getA11yTree(page)]);

    return {
        domTree,
        a11yTree,
    };
};
