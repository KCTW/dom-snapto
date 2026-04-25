# dom-snapto

> 在使用者眼前那一刻，把畫面拍下來。即使分頁關掉、頁面跳轉，上傳依然會完成。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.1.0-green.svg)](package.json)

**🔗 [線上 Demo](https://kctw.github.io/dom-snapto/test.html)** — 直接點按鈕看截圖效果（含跨域商品圖）

## 為什麼需要這個

| 一般做法 | 問題 |
|---------|------|
| 後端用 Puppeteer 重抓頁面 | 踩到 Cloudflare 機器人偵測，常常抓不到 |
| `html2canvas` + `fetch` | 使用者按完按鈕馬上跳轉，上傳常常斷掉 |
| 用 html2canvas 截圖 | 跨域 CDN（Rakuten、Amazon）圖片在 canvas 裡變空白 |

**dom-snapto 把這三個問題一起解決。**

## 核心特色

- **真的會送達**：用 Service Worker + Background Sync 排隊到 IndexedDB，使用者關掉分頁、頁面跳轉、瀏覽器當機，下次開啟仍會重試直到送出
- **跨域圖片不空白**：自動偵測哪些圖需要 proxy，搭配一個 Cloudflare Worker 免費完整處理
- **零 server-side 截圖**：完全在使用者瀏覽器跑，不會觸發 CDN 的機器人偵測
- **老瀏覽器不掛**：偵測 SW 不支援時，自動降級到 `sendBeacon` 或 `fetch`

## 適用場景

- 客人按下「付款」前，留存當下訂單畫面以便日後糾紛舉證
- 使用者同意條款的瞬間，記錄他實際看到的內容
- 表單送出前，記下填寫狀態作為證據

## 30 秒上手

```html
<script src="dom-snapto.js"></script>
<script>
  // 頁面載入時呼叫一次，提前把 Service Worker 準備好
  DomSnapto.init({ swPath: '/dom-snapto-sw.js' });
</script>
```

```js
// 使用者按下付款前截圖，背景上傳不擋畫面
payButton.addEventListener('click', function () {
  DomSnapto.capture('#order-summary', {
    to:         'https://your-server.com/upload',
    background: true,
  });
});
```

就這樣。即使 `payButton` 點擊後馬上跳轉到金流頁，截圖仍會在背景送達伺服器。

## 跨域圖片：Cloudflare Worker 加速器

如果你截的頁面有跨域圖片（例如 Rakuten CDN、Amazon 商品圖），這些圖在 canvas 裡會變空白——這是瀏覽器的 CORS 限制，跟 dom-snapto 無關。

解法是在中間加一層 image proxy 補上 CORS headers。我們提供一個現成的 Cloudflare Worker：

```js
DomSnapto.capture('#order', {
  to:       'https://your-server.com/upload',
  imgProxy: 'https://your-worker.workers.dev',
});
```

加上 `imgProxy` 之後 dom-snapto 會：

1. 對每張圖先嘗試直接 CORS 載入
2. 失敗的圖才走 proxy（節省 Worker 用量）
3. 預載完成才開始截圖，避免空白

Cloudflare Worker 免費方案每天 10 萬次請求，快取 30 天，幾乎用不完。完整範例見 [examples/cloudflare-worker.js](examples/cloudflare-worker.js)。

## 完整 API

### `DomSnapto.init(options)`

| 參數 | 類型 | 說明 |
|------|------|------|
| `swPath` | `string` | Service Worker 檔案路徑（啟用 background 模式時必填） |
| `imgProxy` | `string` | 全域 image proxy URL，會被 `capture()` 預設使用 |

### `DomSnapto.capture(selector, options)`

| 參數 | 類型 | 預設值 | 說明 |
|------|------|--------|------|
| `to` | `string` | — | 圖片 POST 過去的 URL |
| `gcs` | `object` | — | GCS Signed URL 設定（見下方） |
| `background` | `boolean` | `false` | `true` = 背景執行；分頁關掉也會繼續 |
| `imgProxy` | `string` | — | 跨域圖片 proxy 根 URL |
| `format` | `'jpeg'`\|`'png'` | `'jpeg'` | 圖片格式 |
| `quality` | `number` | `0.85` | JPEG 品質 0–1 |
| `scale` | `number` | `1` | 像素倍率，`2` 等於 Retina |
| `meta` | `object`\|`function` | — | 隨圖片送出的額外欄位 |
| `onSuccess` | `function` | — | 上傳成功 callback |
| `onError` | `function` | — | 上傳失敗 callback |

`background: false` 會回傳 `Promise`，可 `await`；`true` 不回傳值，純背景處理。

## 上傳目的地

### 自家伺服器

`multipart/form-data` 格式，欄位：

| 欄位 | 內容 |
|------|------|
| `image` | 圖片檔案 |
| `capturedAt` | ISO 8601 時間戳 |
| `pageUrl` | 截圖當下的網址 |
| `meta` 內容 | 一併附上 |

### Google Cloud Storage

由你的後端產生 Signed URL，前端直接 PUT 到 GCS，不需要中間 server：

```js
const { signedUrl } = await fetch('/api/gcs-signed-url').then(r => r.json());

DomSnapto.capture('#receipt', {
  gcs:        { signedUrl },
  background: true,
});
```

## 降級策略

| 環境 | 行為 |
|------|------|
| Service Worker + Background Sync | 分頁關掉、頁面跳轉後仍完成上傳 |
| 只支援 Service Worker | 頁面跳轉後繼續；下次開瀏覽器重試 |
| 支援 `sendBeacon`（< 60 KB） | 頁面跳轉後仍會送出 |
| 以上都不支援 | 分頁開著的話 `fetch` 上傳 |

## 完整範例

### 等截圖完成才送出表單

```js
form.addEventListener('submit', async function (e) {
  e.preventDefault();
  await DomSnapto.capture('#checkout-form', {
    to:   'https://your-server.com/upload',
    meta: { userId: currentUser.id },
  });
  e.target.submit();
});
```

### 背景截圖 + 動態欄位

```js
DomSnapto.capture('#cart-summary', {
  to:         'https://your-server.com/upload',
  background: true,
  meta: function () { return { orderId: window.currentOrderId }; },
  onError: function (err) { console.warn('截圖失敗', err); },
});
```

### 高解析度 PNG

```js
DomSnapto.capture('.invoice-block', {
  to:     'https://your-server.com/upload',
  format: 'png',
  scale:  2,
});
```

## License

[MIT](LICENSE) © 2026 KCTW
