const DEFAULT_MOCK_ORIGIN = 'http://localhost:4173';
const DEFAULT_MOCK_PATH = '/pages/start.html#beta';

type StorageLike = {
    get: (key: string) => Promise<Record<string, any>>;
};

const getStorage = (storage?: StorageLike) => storage || chrome.storage.local;

const DEFAULT_URL = `${DEFAULT_MOCK_ORIGIN}${DEFAULT_MOCK_PATH}`;

const normalizeMockBaseUrl = (raw?: string) => {
    const value = (raw || '').trim();
    if (!value) return DEFAULT_URL;
    // If user already provided a full target page URL, keep it as-is.
    if (/^https?:\/\/.+/i.test(value) && (value.includes('.html') || value.includes('#'))) {
        return value;
    }
    try {
        const parsed = new URL(value);
        const origin = parsed.origin.replace(/\/$/, '');
        return `${origin}${DEFAULT_MOCK_PATH}`;
    } catch {
        return DEFAULT_URL;
    }
};

export const getMockStartUrl = async (storage?: StorageLike): Promise<string> => {
    const data = await getStorage(storage).get('mockBaseUrl');
    return normalizeMockBaseUrl(data?.mockBaseUrl as string | undefined);
};
/**
 * Mock 配置服务：构建本地 start page URL。
 *
 * 说明：
 * - 只负责 URL 拼装，支持 storage 覆盖，不关心 UI 或 SW。
 */
