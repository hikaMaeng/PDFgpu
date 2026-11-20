export const DEFAULT_COLOR_ADJUSTMENTS = Object.freeze({
    invert: false,
    brightness: 0,
    contrast: 1,
    saturation: 1
});
export function sameColorAdjustments(a, b) {
    return a.invert === b.invert && a.brightness === b.brightness && a.contrast === b.contrast && a.saturation === b.saturation;
}
function bounded(value, fallback, min, max) {
    return typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}
export function updateColorAdjustments(current, update) {
    const invert = typeof update.invert === 'boolean' ? update.invert : current.invert;
    const brightness = bounded(update.brightness, current.brightness, -1, 1);
    const contrast = bounded(update.contrast, current.contrast, 0, 2);
    const saturation = bounded(update.saturation, current.saturation, 0, 2);
    const next = { invert, brightness, contrast, saturation };
    return sameColorAdjustments(next, current) ? current : Object.freeze(next);
}
