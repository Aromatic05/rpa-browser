const DEFAULT_MOCK_ORIGIN = 'http://localhost:4173';
const DEFAULT_MOCK_PATH = '/pages/start.html#beta';

type StorageLike = {
    get: (key: string) => Promise<Record<string, any>>;
};

const getStorage = (storage?: StorageLike) => storage || chrome.storage.local;

export const getMockStartUrl = async (storage?: StorageLike): Promise<string> => {
    const data = await getStorage(storage).get('mockBaseUrl');
    const base = (data?.mockBaseUrl as string | undefined) || DEFAULT_MOCK_ORIGIN;
    const normalized = base.endsWith('/') ? base.slice(0, -1) : base;
    return `${normalized}${DEFAULT_MOCK_PATH}`;
};
/**
 * Mock 配置服务：构建本地 start page URL。
 *
 * 说明：
 * - 只负责 URL 拼装，支持 storage 覆盖，不关心 UI 或 SW。
 */
