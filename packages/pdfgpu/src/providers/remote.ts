import type {
  PdfDocumentManifest,
  PdfDocumentSource,
  PdfPreviewRenderRequest,
  PdfRasterProvider,
  PdfRasterResult,
  PdfTileRenderRequest
} from '../types.js';

type RemoteOpenResponse = {
  documentId: string;
  manifest: PdfDocumentManifest;
};

type RemoteImageResponse = {
  image: string;
  contentType: string;
  width: number;
  height: number;
  dpi: number;
  pageIndex: number;
  kind: 'preview' | 'detail';
  tileX?: number;
  tileY?: number;
  tileWidth?: number;
  tileHeight?: number;
};

type RpcRequest =
  | { id: string; method: 'open'; payload: { bytes: string } }
  | { id: string; method: 'renderPreview'; payload: { documentId: string; pageIndex: number; dpi?: number } }
  | { id: string; method: 'renderTile'; payload: { documentId: string; pageIndex: number; dpi: number; tileX: number; tileY: number; tileWidth: number; tileHeight: number } };

type RpcResponse =
  | { id: string; ok: true; result: RemoteOpenResponse | RemoteImageResponse }
  | { id: string; ok: false; error: string };

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

/** Creates a local function provider and marks it as an in-memory supply path. */
export function createInMemoryPdfRasterProvider(provider: PdfRasterProvider): PdfRasterProvider {
  return Object.assign(provider, { kind: 'in-memory' as const });
}

/** Creates an HTTP provider for parser services that accept uploaded PDF bytes and return raster images. */
export function createWebApiPdfRasterProvider(endpoint: string): PdfRasterProvider {
  return new WebApiPdfRasterProvider(endpoint);
}

/** Creates a WebSocket provider for parser services using the pdfgpu JSON RPC protocol. */
export function createWebSocketPdfRasterProvider(endpoint: string): PdfRasterProvider {
  return new WebSocketPdfRasterProvider(endpoint);
}

class WebApiPdfRasterProvider implements PdfRasterProvider {
  readonly kind = 'webapi' as const;
  /**
   * Concurrent raster requests the viewer may keep in flight. Without it the
   * viewer defaulted to 1, so the documented "up to 3" for remote providers
   * never happened (Chrome status showed QueueDepth: 1).
   */
  readonly queueDepth = 3;
  readonly endpoint: string;
  private documentId: string | null = null;
  private openGeneration = 0;

  constructor(endpoint: string) {
    this.endpoint = endpoint.replace(/\/+$/, '');
  }

  async open(source: PdfDocumentSource): Promise<PdfDocumentManifest> {
    const generation = ++this.openGeneration;
    const bytes = await sourceToBase64(source);
    if (generation !== this.openGeneration) throw new DOMException('open aborted', 'AbortError');
    const response = await fetch(`${this.endpoint}/documents`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ bytes })
    });
    const body = await readJson<RemoteOpenResponse>(response);
    if (generation !== this.openGeneration) throw new DOMException('open aborted', 'AbortError');
    this.documentId = body.documentId;
    return { ...body.manifest, documentId: body.documentId };
  }

  async renderPreview(request: PdfPreviewRenderRequest): Promise<PdfRasterResult> {
    const documentId = this.requireDocumentId();
    const query = new URLSearchParams({ pageIndex: String(request.pageIndex) });
    // Forward the requested resolution; capture asks for >= 192 DPI. The
    // server may still answer at another dpi, so consumers must read the
    // raster's actual size (see viewer/capture.ts).
    if (request.dpi !== undefined) query.set('dpi', String(request.dpi));
    const response = await fetch(`${this.endpoint}/documents/${encodeURIComponent(documentId)}/preview?${query}`, {
      signal: request.signal
    });
    return remoteImageToRaster(await readJson<RemoteImageResponse>(response));
  }

  async renderTile(request: PdfTileRenderRequest): Promise<PdfRasterResult> {
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
    return remoteImageToRaster(await readJson<RemoteImageResponse>(response));
  }

  dispose(): void {
    this.openGeneration += 1;
    this.documentId = null;
  }

  private requireDocumentId() {
    if (!this.documentId) throw new Error('remote document is not opened');
    return this.documentId;
  }
}

class WebSocketPdfRasterProvider implements PdfRasterProvider {
  readonly kind = 'websocket' as const;
  /**
   * Concurrent raster requests the viewer may keep in flight. Without it the
   * viewer defaulted to 1, so the documented "up to 3" for remote providers
   * never happened (Chrome status showed QueueDepth: 1).
   */
  readonly queueDepth = 3;
  readonly endpoint: string;
  private documentId: string | null = null;
  private socketPromise: Promise<WebSocket> | null = null;
  private sequence = 0;
  private openGeneration = 0;
  private pending = new Map<string, { resolve: (value: unknown) => void; reject: (reason: unknown) => void }>();

  constructor(endpoint: string) {
    this.endpoint = endpoint;
  }

  async open(source: PdfDocumentSource): Promise<PdfDocumentManifest> {
    const generation = ++this.openGeneration;
    const bytes = await sourceToBase64(source);
    if (generation !== this.openGeneration) throw new DOMException('open aborted', 'AbortError');
    const response = await this.rpc<RemoteOpenResponse>({ method: 'open', payload: { bytes } });
    if (generation !== this.openGeneration) throw new DOMException('open aborted', 'AbortError');
    this.documentId = response.documentId;
    return { ...response.manifest, documentId: response.documentId };
  }

  async renderPreview(request: PdfPreviewRenderRequest): Promise<PdfRasterResult> {
    const response = await this.rpc<RemoteImageResponse>({
      method: 'renderPreview',
      payload: {
        documentId: this.requireDocumentId(),
        pageIndex: request.pageIndex,
        ...(request.dpi !== undefined ? { dpi: request.dpi } : {})
      }
    }, request.signal);
    return remoteImageToRaster(response);
  }

  async renderTile(request: PdfTileRenderRequest): Promise<PdfRasterResult> {
    const response = await this.rpc<RemoteImageResponse>({
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

  dispose(): void {
    this.openGeneration += 1;
    this.documentId = null;
    if (this.socketPromise) {
      this.socketPromise.then((socket) => socket.close()).catch(() => {});
    }
    this.socketPromise = null;
    for (const pending of this.pending.values()) {
      pending.reject(new DOMException('provider disposed', 'AbortError'));
    }
    this.pending.clear();
  }

  private async rpc<T>(message: Omit<RpcRequest, 'id'>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw new DOMException('request aborted', 'AbortError');
    const socket = await this.connect();
    const id = String(++this.sequence);
    const request = { id, ...message } as RpcRequest;

    return new Promise<T>((resolve, reject) => {
      const abort = () => {
        this.pending.delete(id);
        reject(new DOMException('request aborted', 'AbortError'));
      };
      signal?.addEventListener('abort', abort, { once: true });
      this.pending.set(id, {
        resolve: (value) => {
          signal?.removeEventListener('abort', abort);
          resolve(value as T);
        },
        reject: (reason) => {
          signal?.removeEventListener('abort', abort);
          reject(reason);
        }
      });
      socket.send(JSON.stringify(request));
    });
  }

  private connect(): Promise<WebSocket> {
    if (this.socketPromise) return this.socketPromise;
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

  private handleMessage(event: MessageEvent) {
    const message = JSON.parse(String(event.data)) as RpcResponse;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.ok) {
      pending.resolve(message.result);
    } else {
      pending.reject(new Error(message.error));
    }
  }

  private requireDocumentId() {
    if (!this.documentId) throw new Error('remote document is not opened');
    return this.documentId;
  }
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new Error(`remote provider failed: ${response.status} ${await response.text()}`);
  }
  return response.json() as Promise<T>;
}

async function sourceToBytes(source: PdfDocumentSource): Promise<Uint8Array> {
  if (source instanceof Uint8Array) return source;
  if (source instanceof ArrayBuffer) return new Uint8Array(source);
  if (source instanceof Blob || source instanceof File) return new Uint8Array(await source.arrayBuffer());
  const response = await fetch(source.toString());
  return new Uint8Array(await response.arrayBuffer());
}

async function sourceToBase64(source: PdfDocumentSource): Promise<string> {
  const bytes = await sourceToBytes(source);
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

async function remoteImageToRaster(response: RemoteImageResponse): Promise<PdfRasterResult> {
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

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('remote raster image failed to decode'));
    image.src = src;
  });
}
