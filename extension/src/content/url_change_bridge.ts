(() => {
    const bridgeKey = '__rpaUrlChangeBridgeInstalled';
    const eventName = 'rpa:url-changed';
    const bridgeWindow = window as unknown as {[bridgeKey: string]: unknown};
    if (bridgeWindow[bridgeKey]) {return;}
    bridgeWindow[bridgeKey] = true;

    const notify = (): void => {
        window.dispatchEvent(new CustomEvent(eventName, {
            detail: {url: location.href},
        }));
    };
    const originalPushState = history.pushState.bind(history);
    const originalReplaceState = history.replaceState.bind(history);
    history.pushState = function pushState(data, unused, url): void {
        originalPushState(data, unused, url);
        notify();
    };
    history.replaceState = function replaceState(data, unused, url): void {
        originalReplaceState(data, unused, url);
        notify();
    };
    window.addEventListener('popstate', notify);
    window.addEventListener('hashchange', notify);
})();
