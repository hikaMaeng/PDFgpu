import { DEFAULT_COLOR_ADJUSTMENTS, sameColorAdjustments } from './colorAdjustments.js';
const GPU_TEXTURE_USAGE_COPY_DST = 0x02;
const GPU_TEXTURE_USAGE_TEXTURE_BINDING = 0x04;
const GPU_TEXTURE_USAGE_RENDER_ATTACHMENT = 0x10;
const GPU_BUFFER_USAGE_COPY_DST = 0x08;
const GPU_BUFFER_USAGE_VERTEX = 0x20;
const GPU_BUFFER_USAGE_UNIFORM = 0x40;
const VERTEX_STRIDE = 4;
function getNavigatorGpu() {
    if (typeof navigator === 'undefined')
        return null;
    return navigator.gpu ?? null;
}
function imageSize(source) {
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
function vertexData(tile, frameWidth, frameHeight) {
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
    constructor() {
        this._backend = 'unsupported';
        this.initError = '';
        this.isInitialized = false;
        this.device = null;
        this.context = null;
        this.format = null;
        this.pipeline = null;
        this.sampler = null;
        this.colorUniformBuffer = null;
        this.colorBindGroup = null;
        this.lastColorAdjustments = null;
        // Matches the two f32 fields in the fragment shader's ColorAdjustments struct.
        this.colorUniformData = new Float32Array(4);
        this.frameCanvas = null;
        this.frameContext = null;
        this.frameCount = 0;
        /** Canvas passed to `init`; kept so a lost device can be rebuilt on it. */
        this.targetCanvas = null;
        /**
         * True once `getContext('webgpu')` succeeded on the target canvas. Such a
         * canvas can never return a 2D context, so the 2D fallback must not be
         * attempted on it (it used to throw '2d context unavailable' every frame).
         */
        this.canvasBoundToWebGpu = false;
        this.disposed = false;
        this.recoveryGeneration = 0;
        this.loggedUndrawable = false;
        /** Reports loss and the outcome of device recovery to the viewer. */
        this.onBackendChange = null;
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
        this.gpuTextures = new Map();
        this.gpuBytes = 0;
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
        this.vertexBuffer = null;
        this.vertexBufferBytes = 0;
    }
    async init(canvas) {
        if (this.disposed || this.isInitialized)
            return this._backend;
        this.targetCanvas = canvas;
        const gpu = getNavigatorGpu();
        if (!gpu) {
            this.isInitialized = true;
            return this._backend;
        }
        try {
            const adapter = await gpu.requestAdapter();
            if (this.disposed)
                return this._backend;
            if (!adapter) {
                this.isInitialized = true;
                return this._backend;
            }
            const device = await adapter.requestDevice();
            if (this.disposed) {
                device.destroy();
                return this._backend;
            }
            this.device = device;
            this.watchDeviceLoss(device);
            const format = gpu.getPreferredCanvasFormat();
            this.format = format;
            this.context = canvas.getContext('webgpu');
            if (!this.context) {
                throw new Error('webgpu context unavailable');
            }
            this.canvasBoundToWebGpu = true;
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
            this.colorUniformBuffer = device.createBuffer({
                size: this.colorUniformData.byteLength,
                usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST
            });
            this.colorBindGroup = device.createBindGroup({
                layout: this.pipeline.getBindGroupLayout(1),
                entries: [{ binding: 0, resource: { buffer: this.colorUniformBuffer } }]
            });
            this._backend = 'webgpu';
            console.info('[pdfgpu] webgpu renderer initialized', { format: this.format });
        }
        catch (error) {
            if (this.disposed)
                return this._backend;
            this._backend = this.canvasBoundToWebGpu ? 'error' : 'unsupported';
            this.initError = error instanceof Error ? error.message : 'webgpu init failed';
            this.colorUniformBuffer?.destroy();
            this.clearColorResources();
            this.device?.destroy();
            this.device = null;
            this.context = null;
            this.pipeline = null;
            this.sampler = null;
            console.warn('[pdfgpu] webgpu renderer unavailable', this.initError);
        }
        this.isInitialized = true;
        return this._backend;
    }
    render(canvas, frame) {
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
            }
            catch (error) {
                this._backend = 'error';
                this.initError = error instanceof Error ? error.message : 'webgpu render failed';
                console.error('[pdfgpu] webgpu render failed', this.initError);
            }
        }
        if (this.canvasBoundToWebGpu) {
            // A canvas that has a WebGPU context cannot hand out a 2D context. Keep
            // the last presented image instead of throwing every frame; a lost
            // device is rebuilt by `watchDeviceLoss`, which then requests a repaint.
            if (!this.loggedUndrawable) {
                this.loggedUndrawable = true;
                console.warn('[pdfgpu] canvas is bound to webgpu and the device is unavailable; skipping frame', this.initError);
            }
            return;
        }
        this.render2d(canvas, frame);
    }
    get state() {
        return this._backend;
    }
    get reason() {
        return this.initError;
    }
    /** Number of GPU textures currently held. */
    get gpuTextureCount() {
        return this.gpuTextures.size;
    }
    /** Bytes of GPU texture memory currently held, at 4 bytes per pixel. */
    get gpuTextureBytes() {
        return this.gpuBytes;
    }
    /**
     * Destroys the GPU texture uploaded from `source`, if any.
     *
     * Called by `RasterCache` whenever a raster leaves the cache. Returns true
     * when a texture was destroyed, so callers can account for the release.
     */
    releaseTexture(source) {
        const entry = this.gpuTextures.get(source);
        if (!entry)
            return false;
        this.gpuTextures.delete(source);
        this.gpuBytes -= entry.width * entry.height * 4;
        if (this.gpuBytes < 0)
            this.gpuBytes = 0;
        entry.texture.destroy?.();
        return true;
    }
    /** Destroys every GPU texture held by this renderer. */
    releaseAllTextures() {
        for (const entry of this.gpuTextures.values()) {
            entry.texture.destroy?.();
        }
        this.gpuTextures.clear();
        this.gpuBytes = 0;
    }
    /**
     * Rebuilds the renderer on the same canvas when the GPU device is lost
     * (GPU process restart, driver reset). Textures of the dead device are
     * dropped without `destroy()` - they no longer exist - and re-uploaded from
     * the raster cache on the next frames. A loss caused by our own `dispose()`
     * (reason 'destroyed', or a device that is no longer current) is ignored.
     */
    watchDeviceLoss(device) {
        const lost = device?.lost;
        if (!lost || typeof lost.then !== 'function')
            return;
        void lost.then((info) => {
            if (this.disposed || this.device !== device)
                return;
            if (info?.reason === 'destroyed')
                return;
            console.warn('[pdfgpu] webgpu device lost; rebuilding', info?.reason, info?.message);
            this.gpuTextures.clear();
            this.gpuBytes = 0;
            this.vertexBuffer = null;
            this.vertexBufferBytes = 0;
            this.clearColorResources();
            this.device = null;
            this.pipeline = null;
            this.sampler = null;
            this._backend = 'error';
            this.initError = `device lost: ${info?.message ?? info?.reason ?? 'unknown'}`;
            this.isInitialized = false;
            this.loggedUndrawable = false;
            const generation = ++this.recoveryGeneration;
            const canvas = this.targetCanvas;
            if (canvas) {
                void this.init(canvas).then(() => {
                    if (this.disposed || generation !== this.recoveryGeneration)
                        return;
                    if (this._backend === 'webgpu')
                        this.onBackendChange?.(this._backend);
                });
            }
            this.onBackendChange?.(this._backend);
        });
    }
    dispose() {
        this.disposed = true;
        this.onBackendChange = null;
        this.releaseAllTextures();
        this.releaseVertexBuffer();
        this.colorUniformBuffer?.destroy();
        this.clearColorResources();
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
    renderWebGpu(frame) {
        if (!this.device || !this.context || !this.pipeline || !this.sampler || !this.colorUniformBuffer || !this.colorBindGroup)
            return;
        // Resolve every tile's texture and pack all vertex data into one array
        // before the pass starts, so the pass itself allocates nothing.
        const drawable = [];
        const vertices = new Float32Array(frame.tiles.length * 6 * VERTEX_STRIDE);
        let vertexCursor = 0;
        for (const tile of frame.tiles) {
            const entry = this.getOrCreateTexture(tile.source);
            if (!entry)
                continue;
            const bindGroup = this.getOrCreateBindGroup(entry);
            if (!bindGroup)
                continue;
            vertices.set(vertexData(tile, frame.width, frame.height), vertexCursor * VERTEX_STRIDE);
            drawable.push({ bindGroup, firstVertex: vertexCursor });
            vertexCursor += 6;
        }
        const vertexBuffer = vertexCursor > 0
            ? this.ensureVertexBuffer(vertexCursor * VERTEX_STRIDE * 4)
            : null;
        if (vertexBuffer) {
            const colors = frame.colorAdjustments ?? DEFAULT_COLOR_ADJUSTMENTS;
            if (!this.lastColorAdjustments || !sameColorAdjustments(colors, this.lastColorAdjustments)) {
                this.colorUniformData[0] = colors.invert ? 1 : 0;
                this.colorUniformData[1] = colors.brightness;
                this.colorUniformData[2] = colors.contrast;
                this.colorUniformData[3] = colors.saturation;
                this.device.queue.writeBuffer(this.colorUniformBuffer, 0, this.colorUniformData);
                this.lastColorAdjustments = colors;
            }
            this.device.queue.writeBuffer(vertexBuffer, 0, vertices.buffer, vertices.byteOffset, vertexCursor * VERTEX_STRIDE * 4);
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
            pass.setBindGroup(1, this.colorBindGroup);
            pass.setVertexBuffer(0, vertexBuffer);
            for (const item of drawable) {
                pass.setBindGroup(0, item.bindGroup);
                pass.draw(6, 1, item.firstVertex);
            }
        }
        pass.end();
        this.device.queue.submit([encoder.finish()]);
    }
    getOrCreateTexture(source) {
        if (!this.device)
            return null;
        const existing = this.gpuTextures.get(source);
        if (existing)
            return existing;
        const { width, height } = imageSize(source);
        if (!width || !height)
            return null;
        const texture = this.device.createTexture({
            size: [width, height, 1],
            format: 'rgba8unorm',
            usage: GPU_TEXTURE_USAGE_TEXTURE_BINDING | GPU_TEXTURE_USAGE_COPY_DST | GPU_TEXTURE_USAGE_RENDER_ATTACHMENT
        });
        this.device.queue.copyExternalImageToTexture({ source }, { texture }, [width, height]);
        const entry = {
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
    getOrCreateBindGroup(entry) {
        if (!this.device || !this.pipeline || !this.sampler)
            return null;
        if (!entry.view)
            return null;
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
    ensureVertexBuffer(byteLength) {
        if (!this.device)
            return null;
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
    releaseVertexBuffer() {
        if (this.vertexBuffer) {
            this.vertexBuffer.destroy?.();
            this.vertexBuffer = null;
        }
        this.vertexBufferBytes = 0;
    }
    clearColorResources() {
        this.colorUniformBuffer = null;
        this.colorBindGroup = null;
        this.lastColorAdjustments = null;
    }
    render2d(canvas, frame) {
        const composed = this.getFrameCanvas(frame.width, frame.height);
        if (!composed)
            return;
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
        if (!context2d)
            throw new Error('2d context unavailable');
        canvas.width = composed.width;
        canvas.height = composed.height;
        context2d.clearRect(0, 0, composed.width, composed.height);
        context2d.drawImage(composed, 0, 0, composed.width, composed.height);
        if (this._backend !== 'error' && this._backend !== 'webgpu') {
            this._backend = 'unsupported';
        }
    }
    getFrameCanvas(width, height) {
        if (!this.frameCanvas || this.frameCanvas.width !== Math.max(1, width) || this.frameCanvas.height !== Math.max(1, height)) {
            this.frameCanvas = document.createElement('canvas');
            this.frameCanvas.width = Math.max(1, width);
            this.frameCanvas.height = Math.max(1, height);
            this.frameContext = this.frameCanvas.getContext('2d');
        }
        return this.frameCanvas;
    }
    createPipeline(device, format) {
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

        struct ColorAdjustments {
          invert: f32,
          brightness: f32,
          contrast: f32,
          saturation: f32,
        }

        @group(1) @binding(0) var<uniform> colorAdjustments: ColorAdjustments;

        fn adjustColor(rgb: vec3f) -> vec3f {
          let inverted = select(rgb, vec3f(1.0) - rgb, colorAdjustments.invert != 0.0);
          let brightened = clamp(inverted + vec3f(colorAdjustments.brightness), vec3f(0.0), vec3f(1.0));
          let contrasted = clamp((brightened - vec3f(0.5)) * colorAdjustments.contrast + vec3f(0.5), vec3f(0.0), vec3f(1.0));
          let luminance = dot(contrasted, vec3f(0.2126, 0.7152, 0.0722));
          return clamp(mix(vec3f(luminance), contrasted, colorAdjustments.saturation), vec3f(0.0), vec3f(1.0));
        }

        @fragment
        fn fragmentMain(in: VertexOut) -> @location(0) vec4f {
          let texel = textureSample(pageTexture, pageSampler, in.uv);
          return vec4f(adjustColor(texel.rgb), texel.a);
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
