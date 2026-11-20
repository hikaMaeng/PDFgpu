import type { PdfGpuColorAdjustments, PdfGpuColorAdjustmentState } from '../types.js';

export const DEFAULT_COLOR_ADJUSTMENTS: PdfGpuColorAdjustmentState = Object.freeze({
  invert: false,
  brightness: 0
});

export function updateColorAdjustments(
  current: PdfGpuColorAdjustmentState,
  update: PdfGpuColorAdjustments
): PdfGpuColorAdjustmentState {
  const invert = typeof update.invert === 'boolean' ? update.invert : current.invert;
  const value = update.brightness;
  const brightness = typeof value === 'number' && Number.isFinite(value)
    ? Math.max(-1, Math.min(1, value))
    : current.brightness;
  if (invert === current.invert && brightness === current.brightness) return current;
  return Object.freeze({ invert, brightness });
}
