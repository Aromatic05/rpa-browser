import type { Page } from 'playwright';
import type { RawData } from './types';

export const collectRawData = async (_page: Page): Promise<RawData> => {
    // 先返回最小占位结构，后续接入 trace 基础采集能力。
    return {
        domTree: null,
        a11yTree: null,
    };
};
