/*!
 * dom-snapto-sw.js  —  Service Worker
 * Reads queued capture jobs from IndexedDB and uploads them.
 * Runs even after the originating tab is closed or navigated away.
 *
 * Copyright (c) 2026 KCTW
 * GitHub:  https://github.com/KCTW/dom-snapto
 * License: MIT (https://github.com/KCTW/dom-snapto/blob/main/LICENSE)
 *
 * Register from your page:
 *   navigator.serviceWorker.register('/dom-snapto-sw.js')
 */

var DB_NAME  = 'dom-snapto';
var DB_STORE = 'queue';
var SYNC_TAG = 'dom-snapto-upload';

// ── IndexedDB helpers ─────────────────────────────────────────────────────

function openDB() {
  return new Promise(function (resolve, reject) {
    var req = self.indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = function (e) {
      e.target.result.createObjectStore(DB_STORE, { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = function (e) { resolve(e.target.result); };
    req.onerror   = function (e) { reject(e.target.error); };
  });
}

function getAllJobs(db) {
  return new Promise(function (resolve, reject) {
    var tx  = db.transaction(DB_STORE, 'readonly');
    var req = tx.objectStore(DB_STORE).getAll();
    req.onsuccess = function (e) { resolve(e.target.result); };
    req.onerror   = function (e) { reject(e.target.error); };
  });
}

function deleteJob(db, id) {
  return new Promise(function (resolve, reject) {
    var tx  = db.transaction(DB_STORE, 'readwrite');
    var req = tx.objectStore(DB_STORE).delete(id);
    req.onsuccess = resolve;
    req.onerror   = function (e) { reject(e.target.error); };
  });
}

// ── upload one job ────────────────────────────────────────────────────────

function uploadJob(job) {
  if (job.gcs && job.gcs.signedUrl) {
    return uploadToGCS(job);
  }
  if (job.to) {
    return uploadToUrl(job);
  }
  return Promise.reject(new Error('dom-snaptoto-sw: job has no destination'));
}

function uploadToUrl(job) {
  var imgField = job.imageField || 'image';
  var ext      = job.format === 'png' ? 'png' : 'jpg';

  var form = new FormData();
  form.append(imgField, job.blob, 'snapshot.' + ext);
  form.append('capturedAt', job.createdAt);
  form.append('pageUrl',    job.pageUrl || '');
  var meta = job.meta || {};
  Object.keys(meta).forEach(function (k) { form.append(k, meta[k]); });

  return fetch(job.to, {
    method:      'POST',
    body:        form,
    credentials: job.credentials || 'same-origin',
  }).then(function (res) {
    if (!res.ok) throw new Error('dom-snapto-sw: server returned ' + res.status);
  });
}

function uploadToGCS(job) {
  return fetch(job.gcs.signedUrl, {
    method:  'PUT',
    headers: { 'Content-Type': job.gcs.contentType || job.blob.type || 'image/jpeg' },
    body:    job.blob,
  }).then(function (res) {
    if (!res.ok) throw new Error('dom-snaptoto-sw: GCS returned ' + res.status);
  });
}

// ── flush all queued jobs ─────────────────────────────────────────────────

// 失敗 job 在 IDB 留多久後直接放棄（避免無限累積佔空間）
var MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function isExpired(job, now) {
  // signed URL（GCS / S3 presigned）有 TTL，過期後 PUT 一定 4xx，
  // 留著 retry 沒意義。capture() 寫入 record 時順手記 expiresAt，
  // SW 醒來重試前先檢查；過期就直接刪掉。
  if (job.expiresAt && now > job.expiresAt) return true;

  // 沒指定 expiresAt 的 job（例如純 opts.to 模式），用 createdAt + MAX_AGE_MS
  if (job.createdAt) {
    var createdMs = Date.parse(job.createdAt);
    if (!isNaN(createdMs) && (now - createdMs) > MAX_AGE_MS) return true;
  }
  return false;
}

function flushQueue() {
  var now = Date.now();
  return openDB().then(function (db) {
    return getAllJobs(db).then(function (jobs) {
      var chain = Promise.resolve();
      jobs.forEach(function (job) {
        chain = chain.then(function () {
          // 先做過期清理：URL 失效或 job 太老就直接刪
          if (isExpired(job, now)) {
            console.warn('[dom-snapto-sw] dropping expired job', job.id, 'createdAt=' + job.createdAt);
            return deleteJob(db, job.id);
          }
          return uploadJob(job).then(function () {
            return deleteJob(db, job.id);
          }).catch(function (err) {
            // 留在 DB 等 Background Sync retry，但下次 flush 時會被
            // 上面的 isExpired() 判斷後清掉，避免永久卡。
            console.error('[dom-snapto-sw] upload failed (will retry):', err.message);
            throw err;
          });
        });
      });
      return chain;
    });
  });
}

// ── Service Worker event handlers ─────────────────────────────────────────

// Background Sync: browser fires this when online, even after tab close
self.addEventListener('sync', function (e) {
  if (e.tag === SYNC_TAG) {
    e.waitUntil(flushQueue());
  }
});

// postMessage fallback: called when Background Sync API is unavailable
self.addEventListener('message', function (e) {
  if (e.data && e.data.type === 'DOM_SNAP_FLUSH') {
    flushQueue().catch(function () {});
  }
});

// Keep SW alive during install/activate without interrupting existing clients
self.addEventListener('install',  function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
