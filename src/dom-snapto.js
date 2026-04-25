/*!
 * dom-snapto.js v0.1.0
 * Capture any DOM element and upload it — even if the tab is closed mid-flight.
 *
 * 使用方式：
 *   DomSnapto.init({ swPath: '/dom-snapto-sw.js' });   // 頁面載入時執行一次
 *   DomSnapto.capture('#selector', options);            // 之後隨時呼叫
 *
 * capture() Options:
 *   to            {string}          POST endpoint URL
 *   gcs           {object}          { signedUrl, contentType? } — PUT directly to GCS
 *   background    {boolean}         true = fire-and-forget; tab close still completes (default: false)
 *   format        {'jpeg'|'png'}    (default: 'jpeg')
 *   quality       {number}          0–1, jpeg only (default: 0.85)
 *   scale         {number}          device pixel ratio (default: 1)
 *   meta          {object|function} extra fields merged into POST body
 *   imgProxy      {string}          圖片 proxy 的根 URL（如 Cloudflare Worker），截圖前自動替換所有 img.src，解決跨域圖片空白問題
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

  // ── global config (set by init()) ─────────────────────────────────────────

  var _config = {};
  var _swReady = null; // Promise, resolved after SW registration

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

  // ── Service Worker registration (singleton) ───────────────────────────────

  function ensureSW(swPath) {
    if (_swReady) return _swReady;
    if (!swPath || !('serviceWorker' in navigator)) {
      _swReady = Promise.resolve(null);
      return _swReady;
    }
    _swReady = navigator.serviceWorker.register(swPath)
      .then(function () { return navigator.serviceWorker.ready; })
      .catch(function (err) {
        console.warn('[dom-snapto] SW registration failed:', err);
        return null;
      });
    return _swReady;
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
        req.onsuccess = function (e) { resolve(e.target.result); };
        req.onerror   = function (e) { reject(e.target.error); };
      });
    });
  }

  // ── element → Blob ────────────────────────────────────────────────────────

  // 把 Blob 轉成 data URI（base64）
  function blobToDataURI(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onloadend = function () { resolve(reader.result); };
      reader.onerror   = function () { reject(reader.error); };
      reader.readAsDataURL(blob);
    });
  }

  // 偵測：直接 CORS 能載就不動；不能就走 proxy 抓成 data URI 備用
  // 回傳 Map<原始 src, data URI>
  function detectAndPrepare(el, proxyBase) {
    var imgs = Array.from(el.querySelectorAll('img')).filter(function (img) {
      return img.src && img.src.indexOf(proxyBase) === -1;
    });

    var dataMap = new Map();

    return Promise.all(imgs.map(function (img) {
      return new Promise(function (resolve) {
        var direct = new Image();
        direct.crossOrigin = 'anonymous';
        direct.onload  = function () { resolve(); }; // 直接 OK，免處理
        direct.onerror = function () {
          // 直接失敗 → fetch proxy → 轉 data URI
          fetch(proxyBase + '?url=' + encodeURIComponent(img.src), { mode: 'cors' })
            .then(function (r) { return r.ok ? r.blob() : null; })
            .then(function (blob) { return blob ? blobToDataURI(blob) : null; })
            .then(function (dataURI) {
              if (dataURI) dataMap.set(img.src, dataURI);
              resolve();
            })
            .catch(function () { resolve(); }); // 失敗放棄
        };
        direct.src = img.src;
      });
    })).then(function () { return dataMap; });
  }

  function elementToBlob(el, opts) {
    var proxyBase = opts.imgProxy ? opts.imgProxy.replace(/\/?$/, '') : null;

    var preload = proxyBase
      ? detectAndPrepare(el, proxyBase)
      : Promise.resolve(new Map());

    return preload.then(function (dataMap) {
      return ensureH2C(opts.html2canvasUrl).then(function () { return dataMap; });
    }).then(function (dataMap) {
      var h2cOpts = {
        useCORS:    true,
        allowTaint: false,
        logging:    false,
        scale:      opts.scale || 1,
        scrollX:    0,
        scrollY:    0,
      };

      // onclone 把 src 換成 data URI（同步、零載入時間，html2canvas 不會踩 race）
      if (dataMap.size > 0) {
        h2cOpts.onclone = function (doc) {
          doc.querySelectorAll('img').forEach(function (img) {
            var dataURI = dataMap.get(img.src);
            if (dataURI) img.src = dataURI;
          });
        };
      }

      return html2canvas(el, h2cOpts);
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

  // ── upload helpers ────────────────────────────────────────────────────────

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
    serviceWorker: 'serviceWorker' in navigator,
    indexedDB:     'indexedDB' in self,
    sendBeacon:    'sendBeacon' in navigator,
  };

  // ── background path ───────────────────────────────────────────────────────
  //
  //  1. SW + Background Sync  → 分頁關掉、頁面跳轉後仍完成
  //  2. SW + postMessage      → 頁面跳轉後繼續，不支援關掉後繼續
  //  3. sendBeacon            → 頁面跳轉後繼續，有大小限制
  //  4. fetch (fire-and-forget)

  function queueAndSync(blob, opts) {
    if (!support.serviceWorker || !support.indexedDB) {
      if (support.sendBeacon && blob.size < 60 * 1024) {
        navigator.sendBeacon(opts.to || opts.gcs.signedUrl, blob);
      } else {
        (opts.gcs ? uploadToGCS(blob, opts) : uploadToUrl(blob, opts)).catch(function () {});
      }
      return;
    }

    var meta = typeof opts.meta === 'function' ? opts.meta() : (opts.meta || {});
    var record = {
      blob:      blob,
      to:        opts.to  || null,
      gcs:       opts.gcs || null,
      format:    opts.format || 'jpeg',
      meta:      meta,
      pageUrl:   location.href,
      createdAt: new Date().toISOString(),
    };

    dbPut(record).then(function () {
      return _swReady;
    }).then(function (reg) {
      if (!reg) throw new Error('no SW');
      if ('sync' in reg) return reg.sync.register(SYNC_TAG);
      reg.active && reg.active.postMessage({ type: 'DOM_SNAP_FLUSH' });
    }).catch(function (err) {
      console.warn('[dom-snapto] background queue failed, falling back:', err);
      (opts.gcs ? uploadToGCS(blob, opts) : uploadToUrl(blob, opts)).catch(function () {});
    });
  }

  // ── core ──────────────────────────────────────────────────────────────────

  function run(selector, opts) {
    var el = typeof selector === 'string'
      ? document.querySelector(selector)
      : selector;

    if (!el) return Promise.reject(new Error('[dom-snapto] element not found: ' + selector));

    return elementToBlob(el, opts).then(function (blob) {
      // 沒指定上傳目的地 → 直接回傳 blob（本地測試 / 自行處理）
      if (!opts.to && !opts.gcs) return blob;

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
     * 頁面載入時呼叫一次，提前註冊 Service Worker。
     * @param {object} options
     * @param {string} options.swPath  dom-snapto-sw.js 的路徑
     */
    init: function (options) {
      _config = options || {};
      if (_config.swPath) ensureSW(_config.swPath);
    },

    /**
     * 截圖並上傳。
     * @param  {string|Element} selector  CSS selector 或 DOM 元素
     * @param  {object}         opts      見檔案頂部的 Options 說明
     * @returns {Promise|undefined}
     */
    capture: function (selector, opts) {
      opts = opts || {};

      // 合併 init() 帶入的全域設定
      var merged = {};
      for (var k in _config) merged[k] = _config[k];
      for (var k in opts)    merged[k] = opts[k];

      var promise = run(selector, merged)
        .then(function (result) {
          if (merged.onSuccess) merged.onSuccess(result);
          return result;
        })
        .catch(function (err) {
          console.error(err.message);
          if (merged.onError) merged.onError(err);
          throw err;
        });

      if (merged.background) {
        promise.catch(function () {});
        return;
      }

      return promise;
    },
  };
}));
