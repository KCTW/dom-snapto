/*!
 * dom-snapto.js v0.1.0
 * Capture any DOM element and upload it — even if the tab is closed mid-flight.
 *
 * Copyright (c) 2026 KCTW
 * GitHub:  https://github.com/KCTW/dom-snapto
 * License: MIT (https://github.com/KCTW/dom-snapto/blob/main/LICENSE)
 *
 * 使用方式：
 *   DomSnapto.init({                              // 頁面載入時執行一次
 *     swPath:         '/dom-snapto-sw.js',
 *     html2canvasUrl: 'https://my-cdn/html2canvas-pro.min.js',  // 可選
 *     imgProxy:       'https://my-proxy.workers.dev',           // 可選，全域預設
 *   });
 *   DomSnapto.capture('#selector', options);                    // 之後隨時呼叫
 *
 * init() Options（一次性、全 session 共用）:
 *   swPath         {string}          dom-snapto-sw.js 的路徑（要用 background 模式必填）
 *   html2canvasUrl {string}          html2canvas-pro CDN URL（預設 jsdelivr 上的 v2）。
 *                                    library 用 singleton 只載入一次，所以這個只能在 init() 設。
 *   imgProxy       {string}          imgProxy 的全域預設值，capture() 可覆蓋。
 *
 * capture() Options（每次截圖獨立）:
 *   to            {string}          POST endpoint URL
 *   gcs           {object}          { signedUrl, contentType? } — PUT directly to GCS / S3
 *   background    {boolean}         true = fire-and-forget; tab close still completes (default: false)
 *   format        {'jpeg'|'png'}    (default: 'jpeg')
 *   quality       {number}          0–1, jpeg only (default: 0.85)
 *   scale         {number}          device pixel ratio (default: 1)
 *   meta          {object|function} extra fields merged into POST body
 *   imageField    {string}          自訂圖片欄位名（multipart 上傳時，預設 'image'）
 *   credentials   {RequestCredentials} fetch credentials 模式（預設 'same-origin'）
 *   imgProxy      {string}          覆蓋 init() 的 imgProxy 設定
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

  var H2C_URL  = 'https://cdn.jsdelivr.net/npm/html2canvas-pro@2.0.2/dist/html2canvas-pro.min.js';
  var DB_NAME  = 'dom-snapto';
  var DB_STORE = 'queue';
  var SYNC_TAG = 'dom-snapto-upload';

  // ── global config (set by init()) ─────────────────────────────────────────

  var _config = {};
  var _swReady = null; // Promise, resolved after SW registration

  // ── html2canvas loader (singleton) ────────────────────────────────────────

  var _h2cReady = null;

  // html2canvas 是 singleton：整個 session 只載入一次。
  // CDN URL 從 init() 設定的 _config.html2canvasUrl 讀取，不接受 per-capture 覆蓋
  // （per-call 切 URL 對 singleton 沒意義，反而誘導使用者寫出 silent failure 的程式）。
  function ensureH2C() {
    if (_h2cReady) return _h2cReady;
    _h2cReady = new Promise(function (resolve, reject) {
      if (window.html2canvas) { resolve(); return; }
      var s = document.createElement('script');
      s.src = _config.html2canvasUrl || H2C_URL;
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

  // IDBDatabase 連線快取：第一次開啟後留著重用，避免每次 dbPut 都 open。
  // 連線意外關閉（onclose、versionchange）時自動重置，下次呼叫會重開。
  var _dbReady = null;

  function openDB() {
    if (_dbReady) return _dbReady;
    _dbReady = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function (e) {
        e.target.result.createObjectStore(DB_STORE, { keyPath: 'id', autoIncrement: true });
      };
      req.onsuccess = function (e) {
        var db = e.target.result;
        db.onclose         = function () { _dbReady = null; };
        db.onversionchange = function () { db.close(); _dbReady = null; };
        resolve(db);
      };
      req.onerror = function (e) {
        _dbReady = null; // 失敗不要鎖死，下次重試
        reject(e.target.error);
      };
    });
    return _dbReady;
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
      return ensureH2C().then(function () { return dataMap; });
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

  // 把 blob + meta 包成 multipart/form-data。
  // fetch 跟 sendBeacon 兩條路徑共用同一份格式邏輯，避免「fetch 走 multipart、
  // sendBeacon 卻送 raw blob」這種不一致導致 server 收不到圖。
  function buildUploadForm(blob, opts) {
    var meta     = typeof opts.meta === 'function' ? opts.meta() : (opts.meta || {});
    var imgField = opts.imageField || 'image';
    var ext      = opts.format === 'png' ? 'png' : 'jpg';

    var form = new FormData();
    form.append(imgField, blob, 'snapshot.' + ext);
    form.append('capturedAt', new Date().toISOString());
    form.append('pageUrl', location.href);
    Object.keys(meta).forEach(function (k) { form.append(k, meta[k]); });
    return form;
  }

  function uploadToUrl(blob, opts) {
    return fetch(opts.to, {
      method:      'POST',
      body:        buildUploadForm(blob, opts),
      credentials: opts.credentials || 'same-origin',
    }).then(function (res) {
      if (!res.ok) throw new Error('[dom-snapto] server returned ' + res.status);
      return res.text().then(function (t) {
        try { return JSON.parse(t); } catch (_) { return { ok: true, body: t }; }
      });
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
      // 沒有 SW + IDB queue 可用時，最後一招是 sendBeacon（頁面 unload 後仍會送）。
      // 但 sendBeacon 的 body 必須符合對方期望的格式：
      //   - opts.to 對自家 server → 用 FormData（與 uploadToUrl 一致），server 用 $_FILES 才接得到
      //   - opts.gcs.signedUrl 對 S3/GCS PUT → 用 raw blob（PUT body 就是檔案本身）
      // 兩者都失敗才退到 fire-and-forget fetch。
      var dest = opts.to || (opts.gcs && opts.gcs.signedUrl);
      if (!dest) return; // 沒地方送就放棄

      if (support.sendBeacon && blob.size < 60 * 1024) {
        if (opts.to) {
          navigator.sendBeacon(opts.to, buildUploadForm(blob, opts));
        } else {
          navigator.sendBeacon(opts.gcs.signedUrl, blob);
        }
      } else {
        (opts.gcs ? uploadToGCS(blob, opts) : uploadToUrl(blob, opts)).catch(function () {});
      }
      return;
    }

    var meta = typeof opts.meta === 'function' ? opts.meta() : (opts.meta || {});

    // expiresAt：signed URL 有 TTL（S3/GCS presigned 通常 60 秒）
    // SW 重試時若已過期，PUT 一定 4xx，所以寫進 record 給 SW 判斷直接放棄。
    // opts.gcs.expiresAt 是 epoch ms（ISO 字串也可），呼叫端可選提供。
    // 沒提供就讓 SW 用「7 天 fallback」邏輯處理。
    var expiresAt = null;
    if (opts.gcs && opts.gcs.expiresAt) {
      expiresAt = typeof opts.gcs.expiresAt === 'string'
        ? Date.parse(opts.gcs.expiresAt)
        : opts.gcs.expiresAt;
    }

    var record = {
      blob:        blob,
      to:          opts.to  || null,
      gcs:         opts.gcs || null,
      format:      opts.format || 'jpeg',
      imageField:  opts.imageField || null,
      credentials: opts.credentials || null,
      meta:        meta,
      pageUrl:     location.href,
      createdAt:   new Date().toISOString(),
      expiresAt:   expiresAt,
    };

    // 沒呼叫過 init({swPath:...}) 的話 _swReady 會是 null，背景模式無法走 SW
    // 路徑（分頁關掉就斷）。提示使用者，避免 silent fallback 不知道為什麼沒生效。
    if (!_swReady) {
      console.warn('[dom-snapto] background mode: SW not registered. ' +
                   'Did you forget DomSnapto.init({ swPath: "..." })? ' +
                   'Falling back to fire-and-forget fetch (won\'t survive tab close).');
    }

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
        // 背景模式 fire-and-forget：blob 已交給 SW/IDB queue 或 sendBeacon，
        // 沒有「server response」可以給 onSuccess。回 undefined 比 {} 語意清楚，
        // 跟「無 destination 直接回 blob」也不會混淆。
        queueAndSync(blob, opts);
        return;
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
      // 用 Object.assign 取代雙重 for-in，避免 var k 重複宣告與 hoisting 誤解。
      var merged = Object.assign({}, _config, opts);

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
