# dom-snapto

Capture any DOM element as an image and upload it — even if the tab is closed or the page navigates away.

## Use cases

- Snapshot a checkout summary before the user submits payment
- Archive what a user saw at the moment they agreed to terms
- Capture form state before it's submitted

## How it works

1. `html2canvas` renders the target element to a canvas
2. The image is stored in **IndexedDB**
3. A **Service Worker** uploads it via Background Sync — surviving tab close and page navigation
4. Falls back gracefully when APIs are unavailable (sendBeacon → fetch)

## Quick start

```html
<script src="dom-snapto.js"></script>
<script>
  document.getElementById('submit-btn').addEventListener('click', function () {
    DomSnapto.capture('#order-summary', {
      to:         'https://your-server.com/upload',
      background: true,
      swPath:     '/dom-snapto-sw.js',
    });
  });
</script>
```

## API

### `DomSnapto.capture(selector, options)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `to` | `string` | — | POST endpoint URL |
| `gcs` | `object` | — | `{ signedUrl, contentType? }` — upload directly to GCS |
| `background` | `boolean` | `false` | Fire-and-forget; survives tab close when `swPath` is set |
| `swPath` | `string` | — | Path to `dom-snapto-sw.js`, required for background mode |
| `format` | `'jpeg'\|'png'` | `'jpeg'` | Image format |
| `quality` | `number` | `0.85` | JPEG quality (0–1) |
| `scale` | `number` | `1` | Pixel ratio |
| `meta` | `object\|function` | — | Extra fields merged into the POST body |
| `html2canvasUrl` | `string` | cdnjs | Override the html2canvas CDN URL |
| `onSuccess` | `function` | — | Called with the server response |
| `onError` | `function` | — | Called with the error |

Returns a `Promise` when `background: false`, or `undefined` when `background: true`.

## Upload destinations

### POST to your server

The image is sent as `multipart/form-data` with these fields:

| Field | Value |
|-------|-------|
| `image` | The captured image file |
| `capturedAt` | ISO 8601 timestamp |
| `pageUrl` | `window.location.href` at capture time |
| any `meta` fields | Merged from the `meta` option |

### Google Cloud Storage (GCS)

Generate a signed URL on your backend and pass it in:

```js
// 1. Your backend generates a signed URL and sends it to the page
const { signedUrl } = await fetch('/api/gcs-signed-url').then(r => r.json());

// 2. dom-snapto PUTs the image directly to GCS — no proxy needed
DomSnapto.capture('#receipt', {
  gcs: { signedUrl },
  background: true,
  swPath: '/dom-snapto-sw.js',
});
```

## Fallback chain

| Environment | Behaviour |
|-------------|-----------|
| Service Worker + Background Sync | Survives tab close and navigation |
| Service Worker only | Survives navigation, retries on next visit |
| `sendBeacon` (< 60 KB) | Survives navigation |
| `fetch` | Best-effort while tab is open |

## Service Worker setup

Copy `dom-snapto-sw.js` to your web root (must be served from the same origin):

```
/dom-snapto-sw.js   ← serve from here
/dom-snapto.js
```

The SW is registered automatically when `swPath` is provided in options.

## Examples

### Capture on form submit (foreground)

```js
document.querySelector('form').addEventListener('submit', async function (e) {
  await DomSnapto.capture('#checkout-form', {
    to:   'https://your-server.com/upload',
    meta: { userId: currentUser.id },
  });
  // upload finished before form submits
});
```

### Capture in background with metadata

```js
DomSnapto.capture('#cart-summary', {
  to:         'https://your-server.com/upload',
  background: true,
  swPath:     '/dom-snapto-sw.js',
  meta: function () {
    return { orderId: window.currentOrderId };
  },
  onError: function (err) {
    console.warn('snapshot failed', err);
  },
});
```

### Capture a specific element as PNG

```js
DomSnapto.capture('.invoice-block', {
  to:      'https://your-server.com/upload',
  format:  'png',
  scale:   2,      // retina
});
```

## License

MIT
