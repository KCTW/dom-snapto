/**
 * dom-snaptoto-sw.js  —  Service Worker
 * Reads queued capture jobs from IndexedDB and uploads them.
 * Runs even after the originating tab is closed or navigated away.
 *
 * Register from your page:
 *   navigator.serviceWorker.register('/dom-snaptoto-sw.js')
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
  var form = new FormData();
  form.append('image', job.blob, 'snapshot.' + (job.format === 'png' ? 'png' : 'jpg'));
  form.append('capturedAt', job.createdAt);
  form.append('pageUrl',    job.pageUrl || '');
  var meta = job.meta || {};
  Object.keys(meta).forEach(function (k) { form.append(k, meta[k]); });

  return fetch(job.to, { method: 'POST', body: form }).then(function (res) {
    if (!res.ok) throw new Error('dom-snaptoto-sw: server returned ' + res.status);
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

function flushQueue() {
  return openDB().then(function (db) {
    return getAllJobs(db).then(function (jobs) {
      var chain = Promise.resolve();
      jobs.forEach(function (job) {
        chain = chain.then(function () {
          return uploadJob(job).then(function () {
            return deleteJob(db, job.id);
          }).catch(function (err) {
            // Leave failed job in DB so Background Sync retries it
            console.error('[dom-snaptoto-sw] upload failed (will retry):', err.message);
            throw err; // re-throw so Background Sync knows to retry
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
