# dom-snapto

把任意 DOM 元素拍成圖片並上傳——就算使用者關掉分頁或頁面跳轉，上傳仍會自動完成。

## 適用場景

- 客人按下付款前，先截圖保存當下的訂單畫面
- 使用者同意條款的瞬間，留存他看到的內容
- 表單送出前，記錄填寫狀態

## 運作原理

1. 用 `html2canvas` 把指定的 DOM 元素渲染成圖片
2. 圖片暫存在 **IndexedDB**
3. **Service Worker** 透過 Background Sync 在背景上傳
4. 不支援的瀏覽器自動降級：`sendBeacon` → `fetch`

## 快速開始

引入腳本，並在頁面載入時呼叫一次 `init()` 預先註冊 Service Worker：

```html
<script src="dom-snapto.js"></script>
<script>
  // 頁面載入時執行一次，提前把 SW 準備好
  DomSnapto.init({ swPath: '/dom-snapto-sw.js' });
</script>
```

之後在任何地方呼叫 `capture()`：

```js
document.getElementById('submit-btn').addEventListener('click', function () {
  DomSnapto.capture('#order-summary', {
    to:         'https://your-server.com/upload',
    background: true,
  });
});
```

## 參數說明

```js
DomSnapto.capture(selector, options)
```

| 參數 | 類型 | 預設值 | 說明 |
|------|------|--------|------|
| `to` | `string` | — | 圖片要 POST 過去的 URL |
| `gcs` | `object` | — | 直接上傳到 GCS，見下方說明 |
| `background` | `boolean` | `false` | `true` = 背景執行，不等結果；分頁關掉也會繼續 |
| `swPath` | `string` | — | `dom-snapto-sw.js` 的路徑，啟用背景模式時必填 |
| `format` | `'jpeg'`\|`'png'` | `'jpeg'` | 圖片格式 |
| `quality` | `number` | `0.85` | JPEG 壓縮品質，0–1 |
| `scale` | `number` | `1` | 像素倍率，`2` 等於 Retina 解析度 |
| `meta` | `object`\|`function` | — | 隨圖片一起送出的額外欄位 |
| `html2canvasUrl` | `string` | cdnjs | 自訂 html2canvas 的來源網址 |
| `onSuccess` | `function` | — | 上傳成功後呼叫，收到伺服器回應 |
| `onError` | `function` | — | 上傳失敗後呼叫 |

- `background: false`（預設）：回傳 `Promise`，可以 `await`，等上傳完再繼續
- `background: true`：不回傳值，直接在背景處理，不影響任何前端操作

## 上傳目的地

### 上傳到自己的伺服器

圖片用 `multipart/form-data` 格式送出，欄位如下：

| 欄位 | 內容 |
|------|------|
| `image` | 圖片檔案 |
| `capturedAt` | 截圖時的 ISO 8601 時間戳 |
| `pageUrl` | 截圖當下的頁面網址 |
| `meta` 裡的欄位 | 一併附上 |

### 上傳到 Google Cloud Storage（GCS）

由你的後端產生一個有時效的 Signed URL，傳給前端，插件直接 PUT 到 GCS，不需要任何代理：

```js
// 1. 從你的後端取得 Signed URL
const { signedUrl } = await fetch('/api/gcs-signed-url').then(r => r.json());

// 2. 直接上傳到 GCS
DomSnapto.capture('#receipt', {
  gcs:        { signedUrl },
  background: true,
  swPath:     '/dom-snapto-sw.js',
});
```

## 降級策略

| 環境 | 行為 |
|------|------|
| 支援 Service Worker + Background Sync | 分頁關掉或頁面跳轉後仍會完成上傳 |
| 只支援 Service Worker | 頁面跳轉後繼續；下次開啟瀏覽器時重試 |
| 支援 `sendBeacon`（圖片 < 60 KB） | 頁面跳轉後仍會送出 |
| 以上都不支援 | 在分頁開著的情況下 `fetch` 上傳 |

## Service Worker 設定

把 `dom-snapto-sw.js` 放到網站根目錄（必須與頁面同源）：

```
/dom-snapto-sw.js   ← 放這裡
/dom-snapto.js
```

在 `options.swPath` 填好路徑後，插件會自動幫你註冊，不需要額外的程式碼。

## 完整範例

### 等截圖上傳完，再繼續後續動作

```js
document.querySelector('form').addEventListener('submit', async function (e) {
  e.preventDefault();

  await DomSnapto.capture('#checkout-form', {
    to:   'https://your-server.com/upload',
    meta: { userId: currentUser.id },
  });

  // 上傳完成後才送出表單
  e.target.submit();
});
```

### 背景截圖，附加自訂資料

```js
DomSnapto.capture('#cart-summary', {
  to:         'https://your-server.com/upload',
  background: true,
  swPath:     '/dom-snapto-sw.js',
  meta: function () {
    return { orderId: window.currentOrderId };
  },
  onError: function (err) {
    console.warn('截圖失敗', err);
  },
});
```

### 截特定元素，高解析度 PNG

```js
DomSnapto.capture('.invoice-block', {
  to:     'https://your-server.com/upload',
  format: 'png',
  scale:  2,
});
```

## License

MIT
