import { useEffect, useRef, useState } from 'react';
import {
  createPdfDocumentEngine,
  createPdfGpuViewer,
  createWebApiPdfRasterProvider,
  createWebSocketPdfRasterProvider
} from '@pdfgpu/core';

function formatPercent(value) {
  return `${Math.round(value * 100)}%`;
}

export default function App() {
  const viewerRef = useRef(null);
  const controllerRef = useRef(null);
  const initRef = useRef(Promise.resolve());
  const [providerMode, setProviderMode] = useState('in-memory');
  const [detailDpi, setDetailDpi] = useState(192);
  const [status, setStatus] = useState({
    backend: 'unsupported',
    provider: 'in-memory',
    engine: 'in-memory',
    endpoint: undefined,
    viewMode: 'single',
    spreadPlacement: 'first-right',
    spreadPairing: 'alone',
    fitMode: 'none',
    scrollMode: 'continuous',
    queueDepth: 0,
    renderQuality: 'idle',
    detailDpi: 192,
    zoom: 1,
    pageCount: 0,
    visiblePages: [],
    loading: false,
    error: null,
    activePage: 1
  });
  const [fileName, setFileName] = useState('none');

  useEffect(() => {
    let disposed = false;
    let detach = () => {};

    const initialize = async () => {
      if (!viewerRef.current) return;

      const provider =
        providerMode === 'webapi'
          ? createWebApiPdfRasterProvider('/api/pdfgpu')
          : providerMode === 'websocket'
            ? createWebSocketPdfRasterProvider(`${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws/pdfgpu`)
            : await createPdfDocumentEngine({ poolSize: 4 });
      if (disposed) {
        await provider.dispose();
        return;
      }
      const controller = await createPdfGpuViewer({
        container: viewerRef.current,
        provider,
        providerKind: providerMode,
        initialZoom: 1,
        minZoom: 0.25,
        maxZoom: 5,
        detailDpi,
        overscanPages: 2,
        pageGap: 16,
        spreadGap: 20
      });

      if (disposed) {
        // The controller owns the provider: its dispose() releases both.
        controller.dispose();
        return;
      }

      controllerRef.current = controller;
      detach = controller.subscribe((next) => {
        setStatus(next);
      });
    };

    initRef.current = initialize();
    initRef.current.catch((error) => console.error('[client] viewer init failed', error));

    return () => {
      disposed = true;
      detach();
      controllerRef.current?.dispose();
      controllerRef.current = null;
    };
  }, [providerMode]);

  useEffect(() => {
    let active = true;
    initRef.current.then(() => {
      if (active) controllerRef.current?.setDetailDpi(detailDpi);
    }).catch((error) => {
      if (active) console.error('[client] setDetailDpi failed', error);
    });
    return () => { active = false; };
  }, [detailDpi, providerMode]);

  const withController = async (handler) => {
    await initRef.current;
    const controller = controllerRef.current;
    if (!controller) {
      throw new Error('viewer controller is not ready');
    }
    return handler(controller);
  };

  const handleSample = async () => {
    await withController(async (controller) => {
      setFileName('sample.pdf');
      await controller.load('/sample.pdf');
    });
  };

  const handleUpload = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    await withController(async (controller) => {
      setFileName(file.name);
      await controller.load(file);
    });
  };

  const handleZoomIn = () => {
    withController((controller) => {
      controller.zoomIn();
    }).catch((error) => console.error('[client] zoomIn failed', error));
  };

  const handleZoomOut = () => {
    withController((controller) => {
      controller.zoomOut();
    }).catch((error) => console.error('[client] zoomOut failed', error));
  };

  const handleFitWidth = () => {
    withController((controller) => {
      controller.fitWidth();
    }).catch((error) => console.error('[client] fitWidth failed', error));
  };

  const handleFitPage = () => {
    withController((controller) => {
      controller.fitPage();
    }).catch((error) => console.error('[client] fitPage failed', error));
  };

  const handleFitHeight = () => {
    withController((controller) => {
      controller.fitHeight();
    }).catch((error) => console.error('[client] fitHeight failed', error));
  };

  const handleViewMode = (event) => {
    const mode = event.target.value;
    withController((controller) => {
      controller.setViewMode(mode);
    }).catch((error) => console.error('[client] setViewMode failed', error));
  };

  const handleSpreadPlacement = (event) => {
    const placement = event.target.value;
    withController((controller) => {
      controller.setSpreadPlacement(placement);
    }).catch((error) => console.error('[client] setSpreadPlacement failed', error));
  };

  const handleSpreadPairing = (event) => {
    const pairing = event.target.value;
    withController((controller) => {
      controller.setSpreadPairing(pairing);
    }).catch((error) => console.error('[client] setSpreadPairing failed', error));
  };

  const handleScrollMode = (event) => {
    const mode = event.target.value;
    withController((controller) => {
      controller.setScrollMode(mode);
    }).catch((error) => console.error('[client] setScrollMode failed', error));
  };

  const handleDetailDpi = (event) => {
    setDetailDpi(Number(event.target.value));
  };

  const renderPages = () => {
    if (!status.pageCount) return '0 / 0';
    const current = status.activePage || 1;
    return `${current} / ${status.pageCount}`;
  };

  return (
    <main>
      <div className="loading-chip" role="status" aria-label="viewer status">
        <span>Loading: {status.loading ? 'yes' : 'no'}</span>
        <span>Backend: {status.backend}</span>
        <span>Provider: {status.provider}</span>
        <span>Endpoint: {status.endpoint || '-'}</span>
        <span>QueueDepth: {status.queueDepth}</span>
        <span>View: {status.viewMode}</span>
        <span>FirstPage: {status.spreadPlacement}</span>
        <span>Pairing: {status.spreadPairing}</span>
        <span>Fit: {status.fitMode}</span>
        <span>Scroll: {status.scrollMode}</span>
        <span>Quality: {status.renderQuality}</span>
        <span>Zoom: {formatPercent(status.zoom)}</span>
        <span>DPI: {status.detailDpi}</span>
        <span>Pages: {renderPages()}</span>
        <span>Visible: {(status.visiblePages || []).map((idx) => idx + 1).join(', ') || '-'}</span>
        <span>Source: {fileName}</span>
      </div>
      <div role="toolbar" aria-label="viewer controls" className="viewer-toolbar">
          <label htmlFor="provider-mode">
            Provider
            <select
              id="provider-mode"
              value={providerMode}
              onChange={(event) => setProviderMode(event.target.value)}
              aria-label="raster provider"
            >
              <option value="in-memory">in-memory function</option>
              <option value="webapi">web api</option>
              <option value="websocket">websocket</option>
            </select>
          </label>
          <button type="button" onClick={handleSample}>
            sample PDF
          </button>
          <label htmlFor="pdf-upload">
            Upload PDF
            <input
              id="pdf-upload"
              type="file"
              accept="application/pdf"
              onChange={handleUpload}
            />
          </label>
          <button type="button" onClick={handleZoomIn}>
            zoom in
          </button>
          <button type="button" onClick={handleZoomOut}>
            zoom out
          </button>
          <button type="button" onClick={handleFitWidth}>
            fit width
          </button>
          <button type="button" onClick={handleFitHeight}>
            fit height
          </button>
          <button type="button" onClick={handleFitPage}>
            fit page
          </button>
          <label htmlFor="view-mode">
            View
            <select
              id="view-mode"
              value={status.viewMode}
              onChange={handleViewMode}
              aria-label="view mode"
            >
              <option value="single">single page</option>
              <option value="spread">two page spread</option>
            </select>
          </label>
          <label htmlFor="spread-placement">
            First page
            <select
              id="spread-placement"
              value={status.spreadPlacement}
              onChange={handleSpreadPlacement}
              aria-label="first page spread placement"
            >
              <option value="first-right">right side</option>
              <option value="first-left">left side</option>
            </select>
          </label>
          <label htmlFor="spread-pairing">
            Pairs
            <select
              id="spread-pairing"
              value={status.spreadPairing}
              onChange={handleSpreadPairing}
              aria-label="spread pairing"
            >
              <option value="alone">cover alone</option>
              <option value="paired">pairs from page 1</option>
            </select>
          </label>
          <label htmlFor="scroll-mode">
            Scroll
            <select
              id="scroll-mode"
              value={status.scrollMode}
              onChange={handleScrollMode}
              aria-label="scroll mode"
            >
              <option value="continuous">continuous</option>
              <option value="page">page</option>
            </select>
          </label>
          <label htmlFor="detail-dpi" className="range-control">
            DPI
            <input
              id="detail-dpi"
              type="range"
              min="144"
              max="384"
              step="48"
              value={detailDpi}
              onChange={handleDetailDpi}
              aria-label="detail image dpi"
            />
            <output htmlFor="detail-dpi">{detailDpi}</output>
          </label>
      </div>
      {status.error ? <section role="alert">Error: {status.error}</section> : null}
      <section role="region" aria-label="PDF viewer" ref={viewerRef} data-testid="pdfgpu-scroll-area" />
    </main>
  );
}
