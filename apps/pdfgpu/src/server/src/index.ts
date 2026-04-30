import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { accessSync, constants as fsConstants } from 'node:fs';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { access, readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import type { Socket } from 'node:net';

const PORT = Number.parseInt(process.env.PORT || '51000', 10);
const CANDIDATE_CLIENT_DIST_CANDIDATES = [
  resolve(__dirname, '..', 'client', 'dist'),
  resolve(__dirname, '..', 'client'),
  resolve(__dirname, '..', '..', '..', 'src', 'client', 'dist')
];
const CLIENT_DIST = resolveClientDist();
const SAMPLE_PDF = buildSamplePdf(12);
const REMOTE_DOCUMENTS = new Map<string, { bytes: Uint8Array; createdAt: number }>();
const DEMO_MANIFEST = buildDemoManifest(12);

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);

  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, service: 'pdfgpu' }));
    return;
  }

  if (url.pathname === '/api/pdfgpu/documents' && req.method === 'POST') {
    try {
      const body = await readJsonBody<{ bytes?: string }>(req);
      const bytes = Buffer.from(body.bytes || '', 'base64');
      const documentId = randomUUID();
      REMOTE_DOCUMENTS.set(documentId, { bytes, createdAt: Date.now() });
      writeJson(res, 200, {
        documentId,
        manifest: {
          ...DEMO_MANIFEST,
          documentId,
          sourceDpi: 192
        }
      });
    } catch (error) {
      writeJson(res, 400, { error: error instanceof Error ? error.message : 'invalid request' });
    }
    return;
  }

  const remoteMatch = url.pathname.match(/^\/api\/pdfgpu\/documents\/([^/]+)\/(preview|tile)$/);
  if (remoteMatch && req.method === 'GET') {
    const documentId = decodeURIComponent(remoteMatch[1]);
    if (!REMOTE_DOCUMENTS.has(documentId)) {
      writeJson(res, 404, { error: 'document not found' });
      return;
    }
    writeJson(res, 200, buildRasterResponse(remoteMatch[2] as 'preview' | 'tile', url.searchParams));
    return;
  }

  if (url.pathname === '/sample.pdf') {
    res.writeHead(200, {
      'content-type': 'application/pdf',
      'cache-control': 'max-age=300',
      'content-length': SAMPLE_PDF.length
    });
    res.end(SAMPLE_PDF);
    return;
  }

  if (url.pathname.startsWith('/assets/') || url.pathname === '/index.html') {
    const assetPath = resolvePathFromClient(url.pathname);
    if (!assetPath) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('invalid path');
      return;
    }

    if (await fileExists(assetPath)) {
      const bytes = await readFile(assetPath);
      const ext = assetPath.split('.').pop()?.toLowerCase();
      res.writeHead(200, {
        'content-type': getContentType(ext),
        'content-length': bytes.length,
        'cache-control': 'no-store'
      });
      res.end(bytes);
      return;
    }
  }

  const indexPath = resolve(CLIENT_DIST, 'index.html');
  try {
    const html = await readFile(indexPath);
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store'
    });
    res.end(html);
  } catch (_error) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }
});

server.on('upgrade', (req, socket) => {
  if (req.url !== '/ws/pdfgpu') {
    socket.destroy();
    return;
  }
  acceptWebSocket(req.headers['sec-websocket-key'], socket as Socket);
});

server.listen(PORT, () => {
  console.log(`pdfgpu server listening on ${PORT}`);
});

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch (_error) {
    return false;
  }
}

function resolvePathFromClient(pathname: string) {
  const clean = pathname.split('?')[0].replace(/^\/+/, '');
  if (clean.includes('..')) {
    return null;
  }
  if (!clean) {
    return resolve(CLIENT_DIST, 'index.html');
  }
  return join(CLIENT_DIST, clean);
}

function resolveClientDist() {
  for (const candidate of CANDIDATE_CLIENT_DIST_CANDIDATES) {
    if (existsSync(candidate) && existsSync(resolve(candidate, 'index.html'))) {
      return candidate;
    }
  }

  return CANDIDATE_CLIENT_DIST_CANDIDATES[0];
}

function existsSync(path: string): boolean {
  try {
    accessSync(path, fsConstants.R_OK);
    return true;
  } catch (_error) {
    return false;
  }
}

function getContentType(ext?: string) {
  if (!ext) return 'text/plain';
  if (ext === 'html') return 'text/html; charset=utf-8';
  if (ext === 'js') return 'text/javascript; charset=utf-8';
  if (ext === 'css') return 'text/css; charset=utf-8';
  if (ext === 'png') return 'image/png';
  if (ext === 'svg') return 'image/svg+xml';
  if (ext === 'json') return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
}

function writeJson(res: ServerResponse, status: number, body: unknown) {
  const bytes = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': bytes.length
  });
  res.end(bytes);
}

function buildDemoManifest(pageCount: number) {
  return {
    pageCount,
    pages: Array.from({ length: pageCount }, (_item, index) => ({
      index,
      widthPts: 612,
      heightPts: 792,
      rotation: 0
    }))
  };
}

function buildRasterResponse(kind: 'preview' | 'tile', params: URLSearchParams) {
  const pageIndex = Number.parseInt(params.get('pageIndex') || '0', 10);
  const dpi = kind === 'preview' ? 96 : Number.parseInt(params.get('dpi') || '192', 10);
  const width = kind === 'preview' ? 816 : Math.max(1, Number.parseInt(params.get('tileWidth') || '512', 10));
  const height = kind === 'preview' ? 1056 : Math.max(1, Number.parseInt(params.get('tileHeight') || '512', 10));
  const tileX = Number.parseInt(params.get('tileX') || '0', 10);
  const tileY = Number.parseInt(params.get('tileY') || '0', 10);
  const svg = buildRasterSvg({ kind, pageIndex, width, height, dpi, tileX, tileY });
  const rasterKind = kind === 'tile' ? 'detail' : 'preview';

  return {
    image: Buffer.from(svg).toString('base64'),
    contentType: 'image/svg+xml',
    width,
    height,
    dpi,
    pageIndex,
    kind: rasterKind,
    tileX: rasterKind === 'detail' ? tileX : undefined,
    tileY: rasterKind === 'detail' ? tileY : undefined,
    tileWidth: rasterKind === 'detail' ? width : undefined,
    tileHeight: rasterKind === 'detail' ? height : undefined
  };
}

function buildRasterSvg(input: { kind: 'preview' | 'tile'; pageIndex: number; width: number; height: number; dpi: number; tileX: number; tileY: number }) {
  const label = input.kind === 'preview' ? 'remote preview' : `remote tile ${input.tileX},${input.tileY}`;
  const innerWidth = Math.max(1, input.width - 16);
  const innerHeight = Math.max(1, input.height - 16);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${input.width}" height="${input.height}" viewBox="0 0 ${input.width} ${input.height}">`,
    '<rect width="100%" height="100%" fill="#ffffff"/>',
    `<rect x="8" y="8" width="${innerWidth}" height="${innerHeight}" fill="#f4f7fb" stroke="#3857a6" stroke-width="4"/>`,
    `<text x="32" y="64" font-family="Inter, Arial, sans-serif" font-size="32" fill="#15245c">PDFGPU page ${input.pageIndex + 1}</text>`,
    `<text x="32" y="112" font-family="Inter, Arial, sans-serif" font-size="22" fill="#365084">${label}</text>`,
    `<text x="32" y="150" font-family="Inter, Arial, sans-serif" font-size="18" fill="#5c6c91">dpi ${input.dpi}</text>`,
    '</svg>'
  ].join('');
}

function acceptWebSocket(rawKey: string | string[] | undefined, socket: Socket) {
  const key = Array.isArray(rawKey) ? rawKey[0] : rawKey;
  if (!key) {
    socket.destroy();
    return;
  }
  const accept = createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '',
    ''
  ].join('\r\n'));

  let buffered: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    let decoded: { text: string; rest: Buffer } | null;
    while ((decoded = decodeWebSocketText(buffered))) {
      buffered = decoded.rest;
      handleWebSocketMessage(socket, decoded.text);
    }
  });
}

function handleWebSocketMessage(socket: Socket, text: string) {
  try {
    const request = JSON.parse(text) as { id: string; method: string; payload: Record<string, unknown> };
    if (request.method === 'open') {
      const documentId = randomUUID();
      REMOTE_DOCUMENTS.set(documentId, {
        bytes: Buffer.from(String(request.payload.bytes || ''), 'base64'),
        createdAt: Date.now()
      });
      sendWebSocketJson(socket, { id: request.id, ok: true, result: { documentId, manifest: { ...DEMO_MANIFEST, documentId, sourceDpi: 192 } } });
      return;
    }
    if (request.method === 'renderPreview') {
      const params = new URLSearchParams({ pageIndex: String(request.payload.pageIndex ?? 0) });
      sendWebSocketJson(socket, { id: request.id, ok: true, result: buildRasterResponse('preview', params) });
      return;
    }
    if (request.method === 'renderTile') {
      const params = new URLSearchParams();
      for (const key of ['pageIndex', 'dpi', 'tileX', 'tileY', 'tileWidth', 'tileHeight']) {
        params.set(key, String(request.payload[key] ?? 0));
      }
      sendWebSocketJson(socket, { id: request.id, ok: true, result: buildRasterResponse('tile', params) });
      return;
    }
    sendWebSocketJson(socket, { id: request.id, ok: false, error: 'unknown method' });
  } catch (error) {
    sendWebSocketJson(socket, { id: '0', ok: false, error: error instanceof Error ? error.message : 'websocket request failed' });
  }
}

function decodeWebSocketText(buffer: Buffer<ArrayBufferLike>): { text: string; rest: Buffer<ArrayBufferLike> } | null {
  if (buffer.length < 2) return null;
  const first = buffer[0];
  const second = buffer[1];
  const opcode = first & 0x0f;
  if (opcode === 8) return null;
  let offset = 2;
  let length = second & 0x7f;
  if (length === 126) {
    if (buffer.length < offset + 2) return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null;
    length = Number(buffer.readBigUInt64BE(offset));
    offset += 8;
  }
  const masked = (second & 0x80) !== 0;
  const maskLength = masked ? 4 : 0;
  if (buffer.length < offset + maskLength + length) return null;
  const mask = masked ? buffer.subarray(offset, offset + 4) : null;
  offset += maskLength;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (mask) {
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] ^= mask[index % 4];
    }
  }
  return { text: payload.toString('utf8'), rest: buffer.subarray(offset + length) };
}

function sendWebSocketJson(socket: Socket, body: unknown) {
  const payload = Buffer.from(JSON.stringify(body));
  let header: Buffer;
  if (payload.length < 126) {
    header = Buffer.from([0x81, payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  socket.write(Buffer.concat([header, payload]));
}

function buildSamplePdf(pageCount: number): Buffer {
  const objects: string[] = [];
  const addObject = (id: number, body: string) => {
    objects[id] = `${id} 0 obj\n${body}\nendobj\n`;
  };

  const media = '612 792';
  const fontId = 3;
  const pagesId = 2;
  const catalogId = 1;

  addObject(fontId, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  let nextId = 4;
  const pageRefs: string[] = [];
  for (let i = 0; i < pageCount; i += 1) {
    const pageId = nextId++;
    const contentId = nextId++;
    const text = `BT /F1 24 Tf 90 740 Td (PDFGPU sample page ${i + 1}) Tj ET`;
    addObject(
      contentId,
      `<< /Length ${text.length} >>\nstream\n${text}\nendstream`
    );
    addObject(
      pageId,
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${media}] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`
    );
    pageRefs.push(`${pageId} 0 R`);
  }

  addObject(pagesId, `<< /Type /Pages /Kids [${pageRefs.join(' ')}] /Count ${pageCount} >>`);
  addObject(
    catalogId,
    `<< /Type /Catalog /Pages ${pagesId} 0 R >>`
  );

  const maxId = Math.max(...Object.keys(objects).map((key) => Number(key)));
  const header = '%PDF-1.4\n%âãÏÓ\n';
  const objectEntries: string[] = [];
  const offsets: number[] = new Array(maxId + 1).fill(0);
  let cursor = header.length;
  for (let id = 1; id <= maxId; id += 1) {
    const body = objects[id];
    if (!body) {
      throw new Error(`missing object ${id}`);
    }
    offsets[id] = cursor;
    objectEntries.push(body);
    cursor += body.length;
  }

  const xrefStart = cursor;
  const xrefLines: string[] = [];
  xrefLines.push('xref');
  xrefLines.push(`0 ${maxId + 1}`);
  xrefLines.push('0000000000 65535 f ');
  for (let id = 1; id <= maxId; id += 1) {
    xrefLines.push(`${offsets[id].toString().padStart(10, '0')} 00000 n `);
  }
  const xref = `${xrefLines.join('\n')}\n`;
  const trailer = `trailer\n<< /Size ${maxId + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  const pdf = Buffer.from(header + objectEntries.join('') + xref + trailer, 'binary');
  return pdf;
}
