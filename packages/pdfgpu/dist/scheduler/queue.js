const PREVIEW_DPI = 96;
const PRIORITY_PREVIEW_ACTIVE = 0;
const PRIORITY_PREVIEW_VISIBLE = 100;
const PRIORITY_PREVIEW_NEIGHBOR = 200;
const PRIORITY_DETAIL_ACTIVE = 1000;
const PRIORITY_DETAIL_VISIBLE_OTHER = 2000;
const TILE_SIZE = 512;
const PREFETCH_RADIUS = 2;
function makePreviewTask(pageIndex, priority) {
    return {
        key: `preview/${pageIndex}/${Math.round(PREVIEW_DPI)}/0/0`,
        kind: 'preview',
        pageIndex,
        dpi: PREVIEW_DPI,
        tileX: 0,
        tileY: 0,
        tileWidth: 0,
        tileHeight: 0,
        priority
    };
}
function toPagePosition(positions, pageIndex) {
    return positions[pageIndex];
}
function chooseActiveCandidate(visiblePages) {
    if (!visiblePages.length)
        return undefined;
    return visiblePages[Math.floor(visiblePages.length / 2)];
}
function buildDetailTasksForPage(page, pageIndex, viewportTop, viewportHeight, dpi, sourceScale = 1) {
    const sourceWidth = Math.max(1, page.width * sourceScale);
    const sourceHeight = Math.max(1, page.height * sourceScale);
    const rows = Math.max(1, Math.ceil(sourceHeight / TILE_SIZE));
    const columns = Math.max(1, Math.ceil(sourceWidth / TILE_SIZE));
    const viewportCenter = viewportTop + viewportHeight / 2;
    const localViewportCenterY = viewportCenter - page.top;
    const items = [];
    for (let tileY = 0; tileY < rows; tileY += 1) {
        for (let tileX = 0; tileX < columns; tileX += 1) {
            const left = tileX * TILE_SIZE;
            const top = tileY * TILE_SIZE;
            const cx = (left + TILE_SIZE / 2) / sourceScale;
            const cy = (top + TILE_SIZE / 2) / sourceScale;
            const distance = Math.hypot(cx - page.width / 2, cy - localViewportCenterY);
            items.push({
                tileX: left,
                tileY: top,
                sortKey: distance
            });
        }
    }
    return items
        .sort((a, b) => a.sortKey - b.sortKey)
        .map((item, index) => ({
        key: `detail/${pageIndex}/${Math.round(dpi)}/${item.tileX}/${item.tileY}`,
        kind: 'detail',
        pageIndex,
        dpi: Math.round(dpi),
        tileX: item.tileX,
        tileY: item.tileY,
        tileWidth: TILE_SIZE,
        tileHeight: TILE_SIZE,
        priority: PRIORITY_DETAIL_ACTIVE + index
    }));
}
export function buildRenderQueue(options) {
    const { layout, pageCount, visiblePages, activePage, viewportTop, viewportHeight, qualityDpi } = options;
    const sourceScale = options.sourceScale ?? 1;
    const visibleSet = new Set(visiblePages);
    const tasks = [];
    const focusPage = activePage ?? chooseActiveCandidate(visiblePages);
    if (focusPage !== undefined && visibleSet.has(focusPage)) {
        tasks.push(makePreviewTask(focusPage, PRIORITY_PREVIEW_ACTIVE));
    }
    else if (visiblePages[0] !== undefined) {
        tasks.push(makePreviewTask(visiblePages[0], PRIORITY_PREVIEW_ACTIVE));
    }
    for (const pageIndex of visiblePages) {
        if (pageIndex === focusPage)
            continue;
        tasks.push(makePreviewTask(pageIndex, PRIORITY_PREVIEW_VISIBLE + Math.abs(pageIndex - (focusPage ?? pageIndex))));
    }
    const neighborPages = [];
    if (focusPage !== undefined) {
        for (let distance = 1; distance <= PREFETCH_RADIUS; distance += 1) {
            neighborPages.push(focusPage + distance, focusPage - distance);
        }
    }
    for (const pageIndex of neighborPages) {
        if (pageIndex < 0 || pageIndex >= pageCount || visibleSet.has(pageIndex))
            continue;
        tasks.push(makePreviewTask(pageIndex, PRIORITY_PREVIEW_NEIGHBOR + Math.abs(pageIndex - (focusPage ?? pageIndex))));
    }
    if (focusPage !== undefined && visibleSet.has(focusPage)) {
        const position = toPagePosition(layout.pagePositions, focusPage);
        if (position) {
            const detail = buildDetailTasksForPage(position, focusPage, viewportTop, viewportHeight, qualityDpi, sourceScale);
            for (const item of detail) {
                tasks.push(item);
            }
        }
    }
    for (const pageIndex of visiblePages) {
        if (pageIndex === focusPage)
            continue;
        const page = toPagePosition(layout.pagePositions, pageIndex);
        if (page) {
            const detail = buildDetailTasksForPage(page, pageIndex, viewportTop, viewportHeight, qualityDpi, sourceScale);
            for (let i = 0; i < detail.length; i += 1) {
                const item = detail[i];
                tasks.push({
                    ...item,
                    priority: PRIORITY_DETAIL_VISIBLE_OTHER + Math.abs(pageIndex - (focusPage ?? pageIndex)) * 100 + i
                });
            }
        }
    }
    const seen = new Set();
    const deduped = [];
    for (const task of tasks) {
        if (seen.has(task.key))
            continue;
        seen.add(task.key);
        deduped.push(task);
    }
    return deduped.sort((a, b) => a.priority - b.priority);
}
