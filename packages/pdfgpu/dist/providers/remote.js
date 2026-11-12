const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
/** Creates a local function provider and marks it as an in-memory supply path. */
export function createInMemoryPdfRasterProvider(provider) {
    return Object.assign(provider, { kind: 'in-memory' });
}
/** Creates an HTTP provider for parser services that accept uploaded PDF bytes and return raster images. */
export function createWebApiPdfRasterProvider(endpoint) {
    return new WebApiPdfRasterProvider(endpoint);
}
/** Creates a WebSocket provider for parser services using the pdfgpu JSON RPC protocol. */
export function createWebSocketPdfRasterProvider(endpoint) {
    return new WebSocketPdfRasterProvider(endpoint);
}
class WebApiPdfRasterProvider {
    constructor(endpoint) {
        this.kind = 'webapi';
        this.documentId = null;
        this.endpoint = endpoint.replace(/\/+$/, '');
    }
    async open(source) {
        const bytes = await sourceToBase64(source);
        const response = await fetch(`${this.endpoint}/documents`, {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify({ bytes })
        });
        const body = await readJson(response);
        this.documentId = body.documentId;
        return { ...body.manifest, documentId: body.documentId };
    }
    async renderPreview(request) {
        const documentId = this.requireDocumentId();
        const query = new URLSearchParams({ pageIndex: String(request.pageIndex) });
        // Forward the requested resolution; capture asks for >= 192 DPI. The
        // server may still answer at another dpi, so consumers must read the
        // raster's actual size (see viewer/capture.ts).
        if (request.dpi !== undefined)
            query.set('dpi', String(request.dpi));
        const response = await fetch(`${this.endpoint}/documents/${encodeURIComponent(documentId)}/preview?${query}`, {
            signal: request.signal
        });
        return remoteImageToRaster(await readJson(response));
    }
    async renderTile(request) {
        const documentId = this.requireDocumentId();
        const query = new URLSearchParams({
            pageIndex: String(request.pageIndex),
            dpi: String(request.dpi),
            tileX: String(request.tileX),
            tileY: String(request.tileY),
            tileWidth: String(request.tileWidth),
            tileHeight: String(request.tileHeight)
        });
        const response = await fetch(`${this.endpoint}/documents/${encodeURIComponent(documentId)}/tile?${query}`, {
            signal: request.signal
        });
        return remoteImageToRaster(await readJson(response));
    }
    dispose() {
        this.documentId = null;
    }
    requireDocumentId() {
        if (!this.documentId)
            throw new Error('remote document is not opened');
        return this.documentId;
    }
}
class WebSocketPdfRasterProvider {
    constructor(endpoint) {
        this.kind = 'websocket';
        this.documentId = null;
        this.socketPromise = null;
        this.sequence = 0;
        this.pending = new Map();
        this.endpoint = endpoint;
    }
    async open(source) {
        const bytes = await sourceToBase64(source);
        const response = await this.rpc({ method: 'open', payload: { bytes } });
        this.documentId = response.documentId;
        return { ...response.manifest, documentId: response.documentId };
    }
    async renderPreview(request) {
        const response = await this.rpc({
            method: 'renderPreview',
            payload: {
                documentId: this.requireDocumentId(),
                pageIndex: request.pageIndex,
                ...(request.dpi !== undefined ? { dpi: request.dpi } : {})
            }
        }, request.signal);
        return remoteImageToRaster(response);
    }
    async renderTile(request) {
        const response = await this.rpc({
            method: 'renderTile',
            payload: {
                documentId: this.requireDocumentId(),
                pageIndex: request.pageIndex,
                dpi: request.dpi,
                tileX: request.tileX,
                tileY: request.tileY,
                tileWidth: request.tileWidth,
                tileHeight: request.tileHeight
            }
        }, request.signal);
        return remoteImageToRaster(response);
    }
    dispose() {
        this.documentId = null;
        if (this.socketPromise) {
            this.socketPromise.then((socket) => socket.close()).catch(() => { });
        }
        this.socketPromise = null;
        for (const pending of this.pending.values()) {
            pending.reject(new DOMException('provider disposed', 'AbortError'));
        }
        this.pending.clear();
    }
    async rpc(message, signal) {
        if (signal?.aborted)
            throw new DOMException('request aborted', 'AbortError');
        const socket = await this.connect();
        const id = String(++this.sequence);
        const request = { id, ...message };
        return new Promise((resolve, reject) => {
            const abort = () => {
                this.pending.delete(id);
                reject(new DOMException('request aborted', 'AbortError'));
            };
            signal?.addEventListener('abort', abort, { once: true });
            this.pending.set(id, {
                resolve: (value) => {
                    signal?.removeEventListener('abort', abort);
                    resolve(value);
                },
                reject: (reason) => {
                    signal?.removeEventListener('abort', abort);
                    reject(reason);
                }
            });
            socket.send(JSON.stringify(request));
        });
    }
    connect() {
        if (this.socketPromise)
            return this.socketPromise;
        this.socketPromise = new Promise((resolve, reject) => {
            const socket = new WebSocket(this.endpoint);
            socket.addEventListener('open', () => resolve(socket), { once: true });
            socket.addEventListener('error', () => reject(new Error('websocket provider failed to connect')), { once: true });
            socket.addEventListener('message', (event) => this.handleMessage(event));
            socket.addEventListener('close', () => {
                this.socketPromise = null;
            });
        });
        return this.socketPromise;
    }
    handleMessage(event) {
        const message = JSON.parse(String(event.data));
        const pending = this.pending.get(message.id);
        if (!pending)
            return;
        this.pending.delete(message.id);
        if (message.ok) {
            pending.resolve(message.result);
        }
        else {
            pending.reject(new Error(message.error));
        }
    }
    requireDocumentId() {
        if (!this.documentId)
            throw new Error('remote document is not opened');
        return this.documentId;
    }
}
async function readJson(response) {
    if (!response.ok) {
        throw new Error(`remote provider failed: ${response.status} ${await response.text()}`);
    }
    return response.json();
}
async function sourceToBytes(source) {
    if (source instanceof Uint8Array)
        return source;
    if (source instanceof ArrayBuffer)
        return new Uint8Array(source);
    if (source instanceof Blob || source instanceof File)
        return new Uint8Array(await source.arrayBuffer());
    const response = await fetch(source.toString());
    return new Uint8Array(await response.arrayBuffer());
}
async function sourceToBase64(source) {
    const bytes = await sourceToBytes(source);
    let binary = '';
    const chunkSize = 0x8000;
    for (let index = 0; index < bytes.length; index += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
    }
    return btoa(binary);
}
async function remoteImageToRaster(response) {
    const image = await loadImage(`data:${response.contentType};base64,${response.image}`);
    return {
        source: image,
        width: response.width,
        height: response.height,
        dpi: response.dpi,
        pageIndex: response.pageIndex,
        kind: response.kind,
        tileX: response.tileX,
        tileY: response.tileY,
        tileWidth: response.tileWidth,
        tileHeight: response.tileHeight
    };
}
function loadImage(src) {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.decoding = 'async';
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('remote raster image failed to decode'));
        image.src = src;
    });
}
