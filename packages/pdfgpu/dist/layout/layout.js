function getEstimateFrom(pageSizes) {
    const values = [...pageSizes.values()];
    if (!values.length) {
        return 612;
    }
    return Math.round(values.reduce((acc, current) => acc + current.baseHeight / current.baseWidth, 0) / values.length * 612);
}
function pageInfo(pageSizes, index, fallbackHeight) {
    const layout = pageSizes.get(index);
    const intrinsicWidth = layout ? layout.baseWidth : 612;
    const intrinsicHeight = layout ? layout.baseHeight : fallbackHeight;
    return { intrinsicWidth, intrinsicHeight };
}
function scaledPage(pageSizes, index, fallbackHeight, zoom) {
    const { intrinsicWidth, intrinsicHeight } = pageInfo(pageSizes, index, fallbackHeight);
    const width = intrinsicWidth * zoom;
    return {
        index,
        width,
        height: intrinsicHeight / intrinsicWidth * width
    };
}
function centeredLeft(viewportWidth, rowWidth) {
    return Math.max(0, (viewportWidth - rowWidth) / 2);
}
function firstPageEndingAfter(positions, top) {
    let low = 0;
    let high = positions.length - 1;
    let result = positions.length - 1;
    while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const page = positions[middle];
        if (page.top + page.height >= top) {
            result = middle;
            high = middle - 1;
        }
        else {
            low = middle + 1;
        }
    }
    return result;
}
function lastPageStartingBefore(positions, bottom) {
    let low = 0;
    let high = positions.length - 1;
    let result = 0;
    while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const page = positions[middle];
        if (page.top <= bottom) {
            result = middle;
            low = middle + 1;
        }
        else {
            high = middle - 1;
        }
    }
    return result;
}
export function buildLayout(pageCount, pageSizes, zoom, pageGap, options = {}) {
    const positions = [];
    const fallbackHeight = getEstimateFrom(pageSizes);
    const viewportWidth = Math.max(1, options.viewportWidth ?? 1);
    const viewMode = options.viewMode ?? 'single';
    const spreadPlacement = options.spreadPlacement ?? 'first-right';
    const spreadGap = options.spreadGap ?? pageGap;
    let cursor = 0;
    let totalWidth = 0;
    if (viewMode === 'single') {
        for (let i = 0; i < pageCount; i += 1) {
            const page = scaledPage(pageSizes, i, fallbackHeight, zoom);
            totalWidth = Math.max(totalWidth, page.width);
            positions.push({
                index: i,
                left: centeredLeft(viewportWidth, page.width),
                top: cursor,
                height: page.height,
                width: page.width,
                rowIndex: i
            });
            cursor += page.height + pageGap * zoom;
        }
    }
    else {
        const gap = spreadGap * zoom;
        let rowIndex = 0;
        let index = 0;
        if (pageCount > 0) {
            const page = scaledPage(pageSizes, 0, fallbackHeight, zoom);
            // The first page sits alone in one slot of a full two-page row, so it lines
            // up with the left or right column of every following row. 'first-left' used
            // to centre the page instead of putting it in the left slot.
            const rowWidth = page.width * 2 + gap;
            totalWidth = Math.max(totalWidth, rowWidth);
            positions.push({
                index: 0,
                left: spreadPlacement === 'first-right'
                    ? centeredLeft(viewportWidth, rowWidth) + page.width + gap
                    : centeredLeft(viewportWidth, rowWidth),
                top: cursor,
                height: page.height,
                width: page.width,
                rowIndex
            });
            cursor += page.height + pageGap * zoom;
            rowIndex += 1;
            index = 1;
        }
        for (; index < pageCount; index += 2) {
            const leftPage = scaledPage(pageSizes, index, fallbackHeight, zoom);
            const rightIndex = index + 1;
            const rightPage = rightIndex < pageCount ? scaledPage(pageSizes, rightIndex, fallbackHeight, zoom) : undefined;
            const rowHeight = Math.max(leftPage.height, rightPage?.height ?? 0);
            const rowWidth = leftPage.width + (rightPage ? gap + rightPage.width : 0);
            const left = centeredLeft(viewportWidth, rowWidth);
            totalWidth = Math.max(totalWidth, rowWidth);
            positions.push({
                index,
                left,
                top: cursor,
                height: leftPage.height,
                width: leftPage.width,
                rowIndex
            });
            if (rightPage) {
                positions.push({
                    index: rightIndex,
                    left: left + leftPage.width + gap,
                    top: cursor,
                    height: rightPage.height,
                    width: rightPage.width,
                    rowIndex
                });
            }
            cursor += rowHeight + pageGap * zoom;
            rowIndex += 1;
        }
    }
    return {
        pagePositions: positions,
        totalHeight: cursor > 0 ? cursor - pageGap * zoom : 0,
        totalWidth
    };
}
export function resolveViewportWindow(positions, viewportHeight, scrollTop, overscanPages) {
    if (!positions.length) {
        return { from: 0, to: 0 };
    }
    const windowTop = Math.max(0, scrollTop - viewportHeight * overscanPages);
    const windowBottom = scrollTop + viewportHeight * (1 + overscanPages);
    const start = Math.max(0, firstPageEndingAfter(positions, windowTop) - 1);
    const end = Math.min(positions.length - 1, lastPageStartingBefore(positions, windowBottom) + 1);
    return { from: start, to: end };
}
/** Every page in the overscan window (used to keep page shells laid out ahead of scrolling). */
export function windowPageIndices(positions, window) {
    const result = [];
    for (let i = window.from; i <= window.to; i += 1) {
        const item = positions[i];
        if (item)
            result.push(item.index);
    }
    return result;
}
/**
 * Pages that actually intersect the viewport `[scrollTop, scrollTop + viewportHeight)`.
 *
 * Only these get detail tiles and are composited ("화면에 보이는 페이지만 고해상도
 * detail tile로 보강", README). The previous filter `top + height >= 0` is always true
 * in document coordinates, so every page of the overscan window (two viewports above
 * and below) counted as visible and received full-page detail tiles.
 */
export function visiblePageIndices(positions, window, scrollTop, viewportHeight) {
    const viewTop = scrollTop;
    const viewBottom = scrollTop + Math.max(1, viewportHeight);
    const result = [];
    for (let i = window.from; i <= window.to; i += 1) {
        const item = positions[i];
        if (!item)
            continue;
        if (item.top < viewBottom && item.top + item.height > viewTop) {
            result.push(item.index);
        }
    }
    return result;
}
