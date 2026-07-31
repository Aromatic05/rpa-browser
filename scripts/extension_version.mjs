export const buildIdToManifestVersion = (buildId, fallbackDate = new Date()) => {
    const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(buildId);
    const values = match
        ? match.slice(1).map((value) => Number.parseInt(value, 10))
        : [
            fallbackDate.getUTCFullYear(),
            fallbackDate.getUTCMonth() + 1,
            fallbackDate.getUTCDate(),
            fallbackDate.getUTCHours(),
            fallbackDate.getUTCMinutes(),
            fallbackDate.getUTCSeconds(),
        ];
    const [year, month, day, hour, minute, second] = values;
    return `${String(year)}.${String(month)}.${String(day * 24 + hour)}.${String(minute * 60 + second)}`;
};
