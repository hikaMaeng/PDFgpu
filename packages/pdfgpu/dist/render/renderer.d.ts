import type { PdfImageSource } from '../types.js';
export type RenderedTile = {
    source: PdfImageSource;
    left: number;
    top: number;
    width: number;
    height: number;
};
export type Frame = {
    width: number;
    height: number;
    tiles: RenderedTile[];
};
export declare class PageRenderer {
    private _backend;
    private initError;
    private isInitialized;
    private device;
    private context;
    private format;
    private pipeline;
    private sampler;
    private frameCanvas;
    private frameContext;
    private frameCount;
    private readonly gpuTextures;
    private readonly gpuTextureEntries;
    init(canvas: HTMLCanvasElement): Promise<'webgpu' | 'unsupported' | 'error'>;
    render(canvas: HTMLCanvasElement, frame: Frame): void;
    get state(): 'webgpu' | 'unsupported' | 'error';
    get reason(): string;
    dispose(): void;
    private renderWebGpu;
    private getOrCreateTexture;
    private render2d;
    private getFrameCanvas;
    private createPipeline;
}
