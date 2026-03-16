const DEFAULT_START_URL = 'chrome://newtab/';

type StorageLike = {
    get: (key: string) => Promise<Record<string, any>>;
};

const getStorage = (storage?: StorageLike) => storage || chrome.storage.local;

const normalizeMockBaseUrl = (raw?: string) => {
    const value = (raw || '').trim();
    if (!value) return DEFAULT_START_URL;
    // If user already provided a full target page URL, keep it as-is.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
        return value;
    }
    try {
        const parsed = new URL(value);
        return parsed.toString();
    } catch {
        return DEFAULT_START_URL;
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
