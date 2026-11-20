import type { PdfGpuColorAdjustments, PdfGpuColorAdjustmentState } from '../types.js';
export declare const DEFAULT_COLOR_ADJUSTMENTS: PdfGpuColorAdjustmentState;
export declare function sameColorAdjustments(a: PdfGpuColorAdjustmentState, b: PdfGpuColorAdjustmentState): boolean;
export declare function updateColorAdjustments(current: PdfGpuColorAdjustmentState, update: PdfGpuColorAdjustments): PdfGpuColorAdjustmentState;
