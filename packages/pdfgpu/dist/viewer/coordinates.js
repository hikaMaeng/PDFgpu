export function viewportToPageRect(page, start, end, scrollTop) {
    const left = Math.max(page.left, Math.min(start.x, end.x));
    const right = Math.min(page.left + page.width, Math.max(start.x, end.x));
    const top = Math.max(page.top, Math.min(start.y + scrollTop, end.y + scrollTop));
    const bottom = Math.min(page.top + page.height, Math.max(start.y + scrollTop, end.y + scrollTop));
    return { x: Math.max(0, left - page.left) / page.width, y: Math.max(0, top - page.top) / page.height, width: Math.max(0, right - left) / page.width, height: Math.max(0, bottom - top) / page.height };
}
export function pageRectToViewportRect(page, rect, scrollTop) {
    return { left: page.left + rect.x * page.width, top: page.top + rect.y * page.height - scrollTop, width: rect.width * page.width, height: rect.height * page.height };
}
export function findPageAtViewportPoint(layout, point, scrollTop) {
    const documentY = point.y + scrollTop;
    return layout.pagePositions.find((page) => point.x >= page.left && point.x <= page.left + page.width && documentY >= page.top && documentY <= page.top + page.height);
}
export function projectOverlaysForVisiblePages(layout, overlays, visiblePages, scrollTop, pageSizes) {
    const visible = new Set(visiblePages);
    return overlays.flatMap((item) => {
        if (!visible.has(item.pageIndex))
            return [];
        const page = layout.pagePositions[item.pageIndex];
        const absoluteSize = pageSizes[item.pageIndex];
        if (!page || !absoluteSize || absoluteSize.width <= 0 || absoluteSize.height <= 0)
            return [];
        const normalized = {
            x: item.rect.x / absoluteSize.width,
            y: item.rect.y / absoluteSize.height,
            width: item.rect.width / absoluteSize.width,
            height: item.rect.height / absoluteSize.height,
        };
        return [{ pageIndex: item.pageIndex, ...pageRectToViewportRect(page, normalized, scrollTop), borderColor: item.borderColor, fillColor: item.fillColor, fillOpacity: item.fillOpacity, comment: item.comment }];
    });
}
export function screenRectToAbsoluteRect(page, start, end, scrollTop, pageWidth, pageHeight) {
    const normalized = viewportToPageRect(page, start, end, scrollTop);
    return { x: normalized.x * pageWidth, y: normalized.y * pageHeight, width: normalized.width * pageWidth, height: normalized.height * pageHeight };
}
