import type { PdfImageSource } from '../types.js';

type GpuTextureEntry = {
  source: PdfImageSource;
  texture: WebGpuTextureLike;
  width: number;
  height: number;
  /**
   * View and bind group for this texture, created once and reused for every
   * frame the texture is drawn in. Both depend only on the texture, the
   * sampler and the pipeline layout, none of which change while the texture
   * lives, so rebuilding them per frame was pure churn. `bindGroupPipeline`
   * records which pipeline the bind group was built against: if the renderer
   * ever rebuilds its pipeline, the stale bind group is replaced instead of
   * being bound to a layout it no longer matches.
   */
  view: WebGpuTextureViewLike | null;
  bindGroup: WebGpuBindGroupLike | null;
  bindGroupPipeline: WebGpuRenderPipelineLike | null;
};

type WebGpuLike = any;
type WebGpuDeviceLike = any;
type WebGpuCanvasContextLike = any;
type WebGpuTextureLike = any;
type WebGpuTextureFormatLike = string;
type WebGpuRenderPipelineLike = any;
type WebGpuSamplerLike = any;
type WebGpuBufferLike = any;
type WebGpuTextureViewLike = any;
type WebGpuBindGroupLike = any;

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

const GPU_TEXTURE_USAGE_COPY_DST = 0x02;
const GPU_TEXTURE_USAGE_TEXTURE_BINDING = 0x04;
const GPU_TEXTURE_USAGE_RENDER_ATTACHMENT = 0x10;
const GPU_BUFFER_USAGE_COPY_DST = 0x08;
const GPU_BUFFER_USAGE_VERTEX = 0x20;

const VERTEX_STRIDE = 4;

function getNavigatorGpu(): WebGpuLike | null {
  if (typeof navigator === 'undefined') return null;
  return (navigator as Navigator & { gpu?: WebGpuLike }).gpu ?? null;
}

function imageSize(source: PdfImageSource): { width: number; height: number } {
  if (typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap) {
    return { width: source.width, height: source.height };
  }
  if (typeof HTMLCanvasElement !== 'undefined' && source instanceof HTMLCanvasElement) {
    return { width: source.width, height: source.height };
  }
  if (typeof HTMLImageElement !== 'undefined' && source instanceof HTMLImageElement) {
    return {
      width: source.naturalWidth || source.width,
      height: source.naturalHeight || source.height
    };
  }
  return { width: 1, height: 1 };
}

function vertexData(tile: RenderedTile, frameWidth: number, frameHeight: number): Float32Array {
  const x0 = tile.left;
  const y0 = tile.top;
  const x1 = tile.left + tile.width;
  const y1 = tile.top + tile.height;
  const cx0 = x0 / frameWidth * 2 - 1;
  const cy0 = 1 - y0 / frameHeight * 2;
  const cx1 = x1 / frameWidth * 2 - 1;
  const cy1 = 1 - y1 / frameHeight * 2;

  return new Float32Array([
    cx0, cy0, 0, 0,
    cx1, cy0, 1, 0,
    cx0, cy1, 0, 1,
    cx0, cy1, 0, 1,
    cx1, cy0, 1, 0,
    cx1, cy1, 1, 1
  ]);
}

export class PageRenderer {
  private lastFrame: Frame | null = null;
  private _backend: 'webgpu' | 'unsupported' | 'error' = 'unsupported';
  private initError = '';
  private isInitialized = false;
  private device: WebGpuDeviceLike | null = null;
  private context: WebGpuCanvasContextLike | null = null;
  private format: WebGpuTextureFormatLike | null = null;
  private pipeline: WebGpuRenderPipelineLike | null = null;
  private sampler: WebGpuSamplerLike | null = null;
  private frameCanvas: HTMLCanvasElement | null = null;
  private frameContext: CanvasRenderingContext2D | null = null;
  private frameCount = 0;
  /**
   * GPU textures uploaded from raster sources.
   *
   * - key: the `PdfImageSource` object identity of a cached raster.
   * - scope: this renderer instance; one entry per distinct raster source.
   * - lifetime: created on first draw of that source, destroyed when the
   *   source leaves `RasterCache` (which calls `releaseTexture`) or on
   *   `dispose`.
   * - bound: the raster cache's byte budget. Every source drawn in a frame is
   *   a live cache entry, so GPU bytes track cache bytes; `gpuTextureBytes`
   *   exposes the running total.
   * - cleared by: `RasterCache`'s `onRelease` hook (eviction, `delete`,
   *   `clear`, and replacing a key) and `dispose`. Nothing else removes
   *   entries, so a missing hook is a leak, not a slow release. A `WeakMap`
   *   cannot do this job: the entry holds `source`, so any strong list of
   *   entries keeps every key alive.
   */
  private readonly gpuTextures = new Map<PdfImageSource, GpuTextureEntry>();
  private gpuBytes = 0;

  /**
   * Vertex buffer shared by every tile of a frame.
   *
   * - scope: this renderer instance; exactly one buffer at a time.
   * - lifetime: created on the first frame, reallocated only to grow,
   *   destroyed by `dispose`.
   * - bound: the largest frame's tile count x 96 bytes, floor 4KB.
   * - cleared by: `releaseVertexBuffer`, called from `ensureVertexBuffer` when
   *   growing and from `dispose`.
   */
  private vertexBuffer: WebGpuBufferLike | null = null;
  private vertexBufferBytes = 0;

  async init(canvas: HTMLCanvasElement): Promise<'webgpu' | 'unsupported' | 'error'> {
    if (this.isInitialized) return this._backend;

    const gpu = getNavigatorGpu();
    if (!gpu) {
      this.isInitialized = true;
      return this._backend;
    }

    try {
      const adapter = await gpu.requestAdapter();
      if (!adapter) {
        this.isInitialized = true;
        return this._backend;
      }

      this.device = await adapter.requestDevice();
      const format = gpu.getPreferredCanvasFormat() as string;
      this.format = format;
      this.context = canvas.getContext('webgpu');
      if (!this.context) {
        throw new Error('webgpu context unavailable');
      }

      this.context.configure({
        device: this.device,
        format,
        usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT | GPU_TEXTURE_USAGE_COPY_DST,
        alphaMode: 'opaque'
      });

      this.sampler = this.device.createSampler({
        magFilter: 'linear',
        minFilter: 'linear'
      });
      this.pipeline = this.createPipeline(this.device, format);
      this._backend = 'webgpu';
      console.info('[pdfgpu] webgpu renderer initialized', { format: this.format });
    } catch (error) {
      this._backend = 'unsupported';
      this.initError = error instanceof Error ? error.message : 'webgpu init failed';
      this.device = null;
      this.context = null;
      this.pipeline = null;
      this.sampler = null;
      console.warn('[pdfgpu] webgpu renderer unavailable', this.initError);
    }

    this.isInitialized = true;
    return this._backend;
  }

  render(canvas: HTMLCanvasElement, frame: Frame): void {
    this.lastFrame = frame;
    this.frameCount += 1;
    if (this.frameCount <= 3 || this.frameCount % 60 === 0) {
      console.info('[pdfgpu] render frame', {
        frame: this.frameCount,
        backend: this._backend,
        width: frame.width,
        height: frame.height,
        tiles: frame.tiles.length
      });
    }

    if (this._backend === 'webgpu' && this.device && this.context && this.pipeline && this.sampler) {
      try {
        this.renderWebGpu(frame);
        return;
      } catch (error) {
        this._backend = 'error';
        this.initError = error instanceof Error ? error.message : 'webgpu render failed';
        console.error('[pdfgpu] webgpu render failed; falling back to 2d', this.initError);
      }
    }

    this.render2d(canvas, frame);
  }

  renderLastFrameToCanvas(canvas: HTMLCanvasElement): boolean {
    if (!this.lastFrame) return false;
    this.render2d(canvas, this.lastFrame);
    return true;
  }

  renderLastPreviewFrameToCanvas(canvas: HTMLCanvasElement): boolean {
    if (!this.lastFrame) return false;
    const previewTiles = this.lastFrame.tiles.filter((tile) => {
      const { width, height } = imageSize(tile.source);
      return width > 0 && height > 0 && width * height <= 1_500_000;
    });
    if (!previewTiles.length) return false;
    this.render2d(canvas, { ...this.lastFrame, tiles: previewTiles });
    return true;
  }

  get state(): 'webgpu' | 'unsupported' | 'error' {
    return this._backend;
  }

  get reason(): string {
    return this.initError;
  }

  /** Number of GPU textures currently held. */
  get gpuTextureCount(): number {
    return this.gpuTextures.size;
  }

  /** Bytes of GPU texture memory currently held, at 4 bytes per pixel. */
  get gpuTextureBytes(): number {
    return this.gpuBytes;
  }

  /**
   * Destroys the GPU texture uploaded from `source`, if any.
   *
   * Called by `RasterCache` whenever a raster leaves the cache. Returns true
   * when a texture was destroyed, so callers can account for the release.
   */
  releaseTexture(source: PdfImageSource): boolean {
    const entry = this.gpuTextures.get(source);
    if (!entry) return false;
    this.gpuTextures.delete(source);
    this.gpuBytes -= entry.width * entry.height * 4;
    if (this.gpuBytes < 0) this.gpuBytes = 0;
    entry.texture.destroy?.();
    return true;
  }

  /** Destroys every GPU texture held by this renderer. */
  releaseAllTextures(): void {
    for (const entry of this.gpuTextures.values()) {
      entry.texture.destroy?.();
    }
    this.gpuTextures.clear();
    this.gpuBytes = 0;
  }

  dispose() {
    this.releaseAllTextures();
    this.releaseVertexBuffer();
    this.lastFrame = null;
    if (this.device) {
      this.device.destroy?.();
      this.device = null;
    }
    this.context = null;
    this.pipeline = null;
    this.sampler = null;
    this.frameCanvas = null;
    this.frameContext = null;
  }

  private renderWebGpu(frame: Frame) {
    if (!this.device || !this.context || !this.pipeline || !this.sampler) return;

    // Resolve every tile's texture and pack all vertex data into one array
    // before the pass starts, so the pass itself allocates nothing.
    const drawable: { bindGroup: WebGpuBindGroupLike; firstVertex: number }[] = [];
    const vertices = new Float32Array(frame.tiles.length * 6 * VERTEX_STRIDE);
    let vertexCursor = 0;
    for (const tile of frame.tiles) {
      const entry = this.getOrCreateTexture(tile.source);
      if (!entry) continue;
      const bindGroup = this.getOrCreateBindGroup(entry);
      if (!bindGroup) continue;
      vertices.set(vertexData(tile, frame.width, frame.height), vertexCursor * VERTEX_STRIDE);
      drawable.push({ bindGroup, firstVertex: vertexCursor });
      vertexCursor += 6;
    }

    const vertexBuffer = vertexCursor > 0
      ? this.ensureVertexBuffer(vertexCursor * VERTEX_STRIDE * 4)
      : null;
    if (vertexBuffer) {
      this.device.queue.writeBuffer(
        vertexBuffer,
        0,
        vertices.buffer,
        vertices.byteOffset,
        vertexCursor * VERTEX_STRIDE * 4
      );
    }

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.context.getCurrentTexture().createView(),
          clearValue: { r: 1, g: 1, b: 1, a: 1 },
          loadOp: 'clear',
          storeOp: 'store'
        }
      ]
    });

    pass.setPipeline(this.pipeline);
    if (vertexBuffer) {
      pass.setVertexBuffer(0, vertexBuffer);
      for (const item of drawable) {
        pass.setBindGroup(0, item.bindGroup);
        pass.draw(6, 1, item.firstVertex);
      }
    }

    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  private getOrCreateTexture(source: PdfImageSource): GpuTextureEntry | null {
    if (!this.device) return null;
    const existing = this.gpuTextures.get(source);
    if (existing) return existing;

    const { width, height } = imageSize(source);
    if (!width || !height) return null;
    const texture = this.device.createTexture({
      size: [width, height, 1],
      format: 'rgba8unorm',
      usage: GPU_TEXTURE_USAGE_TEXTURE_BINDING | GPU_TEXTURE_USAGE_COPY_DST | GPU_TEXTURE_USAGE_RENDER_ATTACHMENT
    });
    this.device.queue.copyExternalImageToTexture(
      { source },
      { texture },
      [width, height]
    );

    const entry: GpuTextureEntry = {
      source,
      texture,
      width,
      height,
      view: texture.createView?.() ?? null,
      bindGroup: null,
      bindGroupPipeline: null
    };
    this.gpuTextures.set(source, entry);
    this.gpuBytes += width * height * 4;
    return entry;
  }

  /**
   * Bind group for `entry`, built once per (texture, pipeline) pair.
   *
   * Returns null when the device, pipeline or sampler is missing, or when the
   * texture has no view, so the caller skips the tile rather than drawing with
   * a half-built binding.
   */
  private getOrCreateBindGroup(entry: GpuTextureEntry): WebGpuBindGroupLike | null {
    if (!this.device || !this.pipeline || !this.sampler) return null;
    if (!entry.view) return null;
    if (entry.bindGroup && entry.bindGroupPipeline === this.pipeline) {
      return entry.bindGroup;
    }
    const bindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.sampler },
        { binding: 1, resource: entry.view }
      ]
    });
    entry.bindGroup = bindGroup;
    entry.bindGroupPipeline = this.pipeline;
    return bindGroup;
  }

  /**
   * Shared vertex buffer large enough for `byteLength`.
   *
   * One buffer holds every tile of a frame; each tile draws from it with a
   * `firstVertex` offset. The buffer is reallocated only when a frame needs
   * more room than the last one did, and it grows monotonically, so a viewer
   * that settles at a tile count stops allocating entirely. Capacity is
   * bounded by the tile count the scheduler produces, and `dispose`
   * (via `releaseVertexBuffer`) is what frees it.
   */
  private ensureVertexBuffer(byteLength: number): WebGpuBufferLike | null {
    if (!this.device) return null;
    if (this.vertexBuffer && this.vertexBufferBytes >= byteLength) {
      return this.vertexBuffer;
    }
    this.releaseVertexBuffer();
    const size = Math.max(byteLength, 4096);
    this.vertexBuffer = this.device.createBuffer({
      size,
      usage: GPU_BUFFER_USAGE_VERTEX | GPU_BUFFER_USAGE_COPY_DST
    });
    this.vertexBufferBytes = size;
    return this.vertexBuffer;
  }

  private releaseVertexBuffer(): void {
    if (this.vertexBuffer) {
      this.vertexBuffer.destroy?.();
      this.vertexBuffer = null;
    }
    this.vertexBufferBytes = 0;
  }

  private render2d(canvas: HTMLCanvasElement, frame: Frame): void {
    const composed = this.getFrameCanvas(frame.width, frame.height);
    if (!composed) return;

    composed.width = Math.max(1, frame.width);
    composed.height = Math.max(1, frame.height);
    if (this.frameContext) {
      this.frameContext.clearRect(0, 0, frame.width, frame.height);
      this.frameContext.fillStyle = '#fff';
      this.frameContext.fillRect(0, 0, frame.width, frame.height);
    }

    for (const tile of frame.tiles) {
      this.frameContext?.drawImage(tile.source, tile.left, tile.top, tile.width, tile.height);
    }

    const context2d = canvas.getContext('2d');
    if (!context2d) throw new Error('2d context unavailable');
    canvas.width = composed.width;
    canvas.height = composed.height;
    context2d.clearRect(0, 0, composed.width, composed.height);
    context2d.drawImage(composed, 0, 0, composed.width, composed.height);
    if (this._backend !== 'error' && this._backend !== 'webgpu') {
      this._backend = 'unsupported';
    }
  }

  private getFrameCanvas(width: number, height: number) {
    if (!this.frameCanvas || this.frameCanvas.width !== Math.max(1, width) || this.frameCanvas.height !== Math.max(1, height)) {
      this.frameCanvas = document.createElement('canvas');
      this.frameCanvas.width = Math.max(1, width);
      this.frameCanvas.height = Math.max(1, height);
      this.frameContext = this.frameCanvas.getContext('2d');
    }
    return this.frameCanvas;
  }

  private createPipeline(device: WebGpuDeviceLike, format: WebGpuTextureFormatLike) {
    const module = device.createShaderModule({
      code: `
        struct VertexOut {
          @builtin(position) position: vec4f,
          @location(0) uv: vec2f
        }

        @vertex
        fn vertexMain(
          @location(0) position: vec2f,
          @location(1) uv: vec2f
        ) -> VertexOut {
          var out: VertexOut;
          out.position = vec4f(position, 0.0, 1.0);
          out.uv = uv;
          return out;
        }

        @group(0) @binding(0) var pageSampler: sampler;
        @group(0) @binding(1) var pageTexture: texture_2d<f32>;

        @fragment
        fn fragmentMain(in: VertexOut) -> @location(0) vec4f {
          return textureSample(pageTexture, pageSampler, in.uv);
        }
      `
    });

    return device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module,
        entryPoint: 'vertexMain',
        buffers: [
          {
            arrayStride: VERTEX_STRIDE * Float32Array.BYTES_PER_ELEMENT,
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x2' },
              { shaderLocation: 1, offset: 2 * Float32Array.BYTES_PER_ELEMENT, format: 'float32x2' }
            ]
          }
        ]
      },
      fragment: {
        module,
        entryPoint: 'fragmentMain',
        targets: [{ format }]
      },
      primitive: {
        topology: 'triangle-list'
      }
    });
  }
}
