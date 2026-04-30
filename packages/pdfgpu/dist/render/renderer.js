const GPU_TEXTURE_USAGE_COPY_DST = 0x02;
const GPU_TEXTURE_USAGE_TEXTURE_BINDING = 0x04;
const GPU_TEXTURE_USAGE_RENDER_ATTACHMENT = 0x10;
const GPU_BUFFER_USAGE_COPY_DST = 0x08;
const GPU_BUFFER_USAGE_VERTEX = 0x20;
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
        this.frameCanvas = null;
        this.frameContext = null;
        this.frameCount = 0;
        this.gpuTextures = new WeakMap();
        this.gpuTextureEntries = new Set();
    }
    async init(canvas) {
        if (this.isInitialized)
            return this._backend;
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
            const format = gpu.getPreferredCanvasFormat();
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
        }
        catch (error) {
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
                console.error('[pdfgpu] webgpu render failed; falling back to 2d', this.initError);
            }
        }
        this.render2d(canvas, frame);
    }
    get state() {
        return this._backend;
    }
    get reason() {
        return this.initError;
    }
    dispose() {
        for (const entry of this.gpuTextureEntries) {
            entry.texture.destroy();
        }
        this.gpuTextureEntries.clear();
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
        if (!this.device || !this.context || !this.pipeline || !this.sampler)
            return;
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
        for (const tile of frame.tiles) {
            const texture = this.getOrCreateTexture(tile.source);
            if (!texture)
                continue;
            const vertices = vertexData(tile, frame.width, frame.height);
            const vertexBuffer = this.device.createBuffer({
                size: vertices.byteLength,
                usage: GPU_BUFFER_USAGE_VERTEX | GPU_BUFFER_USAGE_COPY_DST
            });
            this.device.queue.writeBuffer(vertexBuffer, 0, vertices);
            const bindGroup = this.device.createBindGroup({
                layout: this.pipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: this.sampler },
                    { binding: 1, resource: texture.texture.createView() }
                ]
            });
            pass.setBindGroup(0, bindGroup);
            pass.setVertexBuffer(0, vertexBuffer);
            pass.draw(6);
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
        const entry = { source, texture, width, height };
        this.gpuTextures.set(source, entry);
        this.gpuTextureEntries.add(entry);
        return entry;
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
