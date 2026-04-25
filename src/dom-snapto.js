/*!
 * dom-snapto.js
 * Capture any DOM element and upload it — even if the tab is closed mid-flight.
 *
 * DomSnapto.capture('#selector', options) → Promise | void
 *
 * Options:
 *   to            {string}          POST endpoint URL
 *   gcs           {object}          { signedUrl, contentType? } — PUT directly to GCS
 *   background    {boolean}         true = fire-and-forget; tab close still completes (default: false)
 *   swPath        {string}          path to dom-snapto-sw.js (required when background:true)
 *   format        {'jpeg'|'png'}    (default: 'jpeg')
 *   quality       {number}          0–1, jpeg only (default: 0.85)
 *   scale         {number}          device pixel ratio (default: 1)
 *   meta          {object|function} extra fields merged into POST body
 *   html2canvasUrl {string}         override CDN URL for html2canvas
 *   onSuccess     {function}        (result) => void
 *   onError       {function}        (err) => void
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.DomSnapto = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var H2C_URL  = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
  var DB_NAME  = 'dom-snapto';
  var DB_STORE = 'queue';
  var SYNC_TAG = 'dom-snapto-upload';

  // ── html2canvas loader (singleton) ────────────────────────────────────────

  var _h2cReady = null;

  function ensureH2C(cdnUrl) {
    if (_h2cReady) return _h2cReady;
    _h2cReady = new Promise(function (resolve, reject) {
      if (window.html2canvas) { resolve(); return; }
      var s = document.createElement('script');
      s.src = cdnUrl || H2C_URL;
      s.onload = resolve;
      s.onerror = function () { reject(new Error('[dom-snapto] failed to load html2canvas')); };
      document.head.appendChild(s);
    });
    return _h2cReady;
  }

  // ── IndexedDB helpers ─────────────────────────────────────────────────────

  function openDB() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function (e) {
        e.target.result.createObjectStore(DB_STORE, { keyPath: 'id', autoIncrement: true });
      };
      req.onsuccess = function (e) { resolve(e.target.result); };
      req.onerror   = function (e) { reject(e.target.error); };
    });
  }

  function dbPut(record) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx  = db.transaction(DB_STORE, 'readwrite');
        var req = tx.objectStore(DB_STORE).add(record);
        req.onsuccess = function (e) { resolve(e.target.result); }; // returns id
        req.onerror   = function (e) { reject(e.target.error); };
      });
    });
  }

  // ── element → Blob ────────────────────────────────────────────────────────

  function elementToBlob(el, opts) {
    return ensureH2C(opts.html2canvasUrl).then(function () {
      return html2canvas(el, {
        useCORS:    true,
        allowTaint: true,
        logging:    false,
        scale:      opts.scale || 1,
        scrollX:    0,
        scrollY:    0,
      });
    }).then(function (canvas) {
      var mime    = opts.format === 'png' ? 'image/png' : 'image/jpeg';
      var quality = opts.quality != null ? opts.quality : 0.85;
      return new Promise(function (resolve, reject) {
        canvas.toBlob(
          function (blob) { blob ? resolve(blob) : reject(new Error('[dom-snapto] toBlob returned null')); },
          mime, quality
        );
      });
    });
  }

  // ── upload (foreground path) ──────────────────────────────────────────────

  function uploadToUrl(blob, opts) {
    var meta = typeof opts.meta === 'function' ? opts.meta() : (opts.meta || {});
    var form = new FormData();
    form.append('image', blob, 'snapshot.' + (opts.format === 'png' ? 'png' : 'jpg'));
    form.append('capturedAt', new Date().toISOString());
    form.append('pageUrl', location.href);
    Object.keys(meta).forEach(function (k) { form.append(k, meta[k]); });

    return fetch(opts.to, { method: 'POST', body: form }).then(function (res) {
      if (!res.ok) throw new Error('[dom-snapto] server returned ' + res.status);
      return res.json().catch(function () { return {}; });
    });
  }

  function uploadToGCS(blob, opts) {
    return fetch(opts.gcs.signedUrl, {
      method:  'PUT',
      headers: { 'Content-Type': opts.gcs.contentType || blob.type },
      body:    blob,
    }).then(function (res) {
      if (!res.ok) throw new Error('[dom-snapto] GCS returned ' + res.status);
      return { gcsUrl: opts.gcs.signedUrl.split('?')[0] };
    });
  }

  // ── support detection ─────────────────────────────────────────────────────

  var support = {
    serviceWorker:   'serviceWorker' in navigator,
    backgroundSync:  false, // resolved lazily after SW registration
    indexedDB:       'indexedDB' in self,
    sendBeacon:      'sendBeacon' in navigator,
    fetch:           'fetch' in self,
  };

  // ── background path: degradation chain ───────────────────────────────────
  //
  //  1. Service Worker + Background Sync  (survives tab close & navigation)
  //  2. Service Worker + postMessage      (survives navigation, not close)
  //  3. sendBeacon                        (survives navigation, size-limited)
  //  4. fetch (fire-and-forget)           (tab must stay open)

  function queueAndSync(blob, opts) {
    if (!support.serviceWorker || !support.indexedDB) {
      // Tier 3 — sendBeacon for small blobs, otherwise best-effort fetch
      if (support.sendBeacon && blob.size < 60 * 1024) {
        navigator.sendBeacon(opts.to || opts.gcs.signedUrl, blob);
      } else {
        var upload = opts.gcs ? uploadToGCS(blob, opts) : uploadToUrl(blob, opts);
        upload.catch(function () {});
      }
      return;
    }

    var meta = typeof opts.meta === 'function' ? opts.meta() : (opts.meta || {});

    // Store the job in IndexedDB so the SW can retrieve it after tab close
    var record = {
      blob:      blob,
      to:        opts.to   || null,
      gcs:       opts.gcs  || null,
      format:    opts.format || 'jpeg',
      meta:      meta,
      pageUrl:   location.href,
      createdAt: new Date().toISOString(),
    };

    dbPut(record).then(function () {
      return navigator.serviceWorker.ready;
    }).then(function (reg) {
      if ('sync' in reg) {
        return reg.sync.register(SYNC_TAG);
      }
      // Background Sync not supported — ask SW to upload now via postMessage
      reg.active && reg.active.postMessage({ type: 'DOM_SNAP_FLUSH' });
    }).catch(function (err) {
      console.warn('[dom-snapto] background queue failed:', err);
      // Last resort: try uploading directly
      var upload = opts.gcs ? uploadToGCS(blob, opts) : uploadToUrl(blob, opts);
      upload.catch(function () {});
    });
  }

  function ensureSW(swPath) {
    if (!swPath || !('serviceWorker' in navigator)) return Promise.resolve();
    return navigator.serviceWorker.register(swPath).then(function () {
      return navigator.serviceWorker.ready;
    }).catch(function (err) {
      console.warn('[dom-snapto] SW registration failed:', err);
    });
  }

  // ── core ──────────────────────────────────────────────────────────────────

  function run(selector, opts) {
    var el = typeof selector === 'string'
      ? document.querySelector(selector)
      : selector;

    if (!el) return Promise.reject(new Error('[dom-snapto] element not found: ' + selector));
    if (!opts.to && !opts.gcs) return Promise.reject(new Error('[dom-snapto] options.to or options.gcs is required'));

    return elementToBlob(el, opts).then(function (blob) {
      if (opts.background) {
        queueAndSync(blob, opts);
        return {};
      }
      return opts.gcs ? uploadToGCS(blob, opts) : uploadToUrl(blob, opts);
    });
  }

  // ── public API ────────────────────────────────────────────────────────────

  return {
    /**
     * Capture a DOM element and upload it.
     *
     * @param  {string|Element} selector  CSS selector or DOM element
     * @param  {object}         opts      See header for all options
     * @returns {Promise|undefined}       Resolves with server response, or
     *                                   undefined when background:true.
     */
    capture: function (selector, opts) {
      opts = opts || {};

      // Register SW early so it's ready by the time we need it
      if (opts.background && opts.swPath) ensureSW(opts.swPath);

      var promise = run(selector, opts)
        .then(function (result) {
          if (opts.onSuccess) opts.onSuccess(result);
          return result;
        })
        .catch(function (err) {
          console.error(err.message);
          if (opts.onError) opts.onError(err);
          throw err;
        });

      if (opts.background) {
        promise.catch(function () {});
        return;
      }

      return promise;
    },
  };
}));
