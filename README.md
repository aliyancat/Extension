# 📋 PDF Content Copier — Chrome Extension

Right-click any PDF or document link to instantly extract and copy all its text.

---

## 📁 Folder Structure

```
pdf-copy-extension/
├── manifest.json          ← Extension config (Manifest V3)
├── background.js          ← Service worker: context menu, orchestration
├── offscreen.html         ← Invisible DOM sandbox (required by PDF.js)
├── offscreen.js           ← PDF parsing + clipboard writing logic
├── content.js             ← Optional: adds 📋 badges to PDF links on pages
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── lib/
    ├── pdf.min.js         ← PDF.js library (bundled locally)
    └── pdf.worker.min.js  ← PDF.js worker (bundled locally)
```

---

## 🚀 Installation (Load Unpacked Extension)

1. Open Chrome and go to: `chrome://extensions`
2. Enable **Developer mode** (toggle in top-right corner)
3. Click **"Load unpacked"**
4. Select the `pdf-copy-extension/` folder
5. The extension appears in your toolbar!

> ⚠️ You must keep the folder on your computer. If you move/delete it, the extension breaks.

---

## 🔧 How to Use

1. Visit any webpage that has PDF links
2. **Right-click** on a PDF link (`.pdf` URL)
3. Select **"📋 Copy PDF / Doc Content"** from the context menu
4. A notification appears: "Working…" → then "✅ Copied!"
5. Paste anywhere (Ctrl+V / Cmd+V)

---

## 🏗️ Architecture Explained

### Why these components?

```
User right-clicks link
        │
        ▼
background.js (Service Worker)
  ├── Detects if URL is a PDF (via HEAD request + URL extension)
  ├── For PDFs:
  │     ├── Creates offscreen.html (invisible DOM sandbox)
  │     ├── Sends URL to offscreen.js via chrome.runtime.sendMessage
  │     ├── offscreen.js fetches PDF bytes
  │     ├── PDF.js parses text page by page
  │     ├── Text sent back to background.js
  │     └── offscreen.js writes text to clipboard
  └── For HTML pages:
        ├── Opens background tab (active: false — you don't see it)
        ├── Waits for tab to load
        ├── Injects extractPageText() via chrome.scripting.executeScript
        ├── Receives extracted text
        └── Closes the background tab
```

### Why use an Offscreen Document instead of alternatives?

| Approach | Verdict | Reason |
|---|---|---|
| **Offscreen Document + PDF.js** | ✅ Best | PDF.js needs DOM. Offscreen docs provide it invisibly. |
| Hidden Tab + Content Script | ⚠️ Fallback | Works but flashes a tab briefly on some systems. |
| Service Worker + fetch() alone | ❌ Won't work | PDF.js can't run in service workers (no DOM). |
| Pure fetch() + manual text parse | ❌ Won't work | PDFs are binary format, need PDF.js to decode. |

---

## ⚠️ Limitations

### 1. CORS (Cross-Origin Resource Sharing)
**What it is:** Servers can block cross-origin requests from extensions.

**When it happens:** If a PDF server doesn't include `Access-Control-Allow-Origin` headers, Chrome blocks the `fetch()` call in the offscreen document.

**Symptom:** Error: `"Failed to fetch PDF: CORS policy..."`

**Solutions:**
- Most public PDFs (government sites, academic papers, company docs) work fine.
- If blocked, the extension will automatically fall back to opening a background tab.
- For persistent CORS issues, you can use a proxy like `cors-anywhere` (self-hosted).

### 2. Scanned PDFs (Image-only PDFs)
**What it is:** PDFs created by scanning physical paper contain images, not text.

**Symptom:** Each page returns `[No selectable text on this page — may be a scanned image]`

**Fix:** You'd need OCR. Tesseract.js is the standard library but adds ~30MB to your extension. Not included here for simplicity. If you need OCR, file an issue and I'll add it.

**How to tell if a PDF is scanned:** Try to select text in Chrome's built-in PDF viewer. If you can't highlight text, it's scanned.

### 3. Password-protected PDFs
**Symptom:** PDF.js throws a `PasswordException`.

**Current behavior:** The extension shows an error notification.

**Fix required:** Would need to prompt the user for a password and pass it to `pdfjsLib.getDocument({ password: "..." })`.

### 4. chrome:// and chrome-extension:// URLs
These are browser-internal pages. Extensions cannot read them. The extension detects this and shows an "Unsupported" notification instead of crashing.

### 5. Very Large PDFs
PDFs over ~50MB may be slow or cause memory issues. The extension has no hard size limit, but your system RAM is the constraint. PDF.js streams pages, so it handles large files better than loading everything at once.

---

## 🐛 Debugging Guide

### Open the Extension's Console
1. Go to `chrome://extensions`
2. Find "PDF Content Copier"
3. Click **"service worker"** link (next to "Inspect views")
4. This opens DevTools for `background.js`

### Open the Offscreen Document Console
The offscreen document doesn't appear in the extension inspector list. Use this trick:
1. In the service worker DevTools console, run:
   ```js
   chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']})
   ```
2. This lists the offscreen document's URL. You can then open it via DevTools.

### Common Errors & Fixes

| Error | Cause | Fix |
|---|---|---|
| `PDF.js is not loaded` | `lib/pdf.min.js` missing or wrong path | Re-check folder structure |
| `Failed to fetch PDF: CORS` | Server blocks cross-origin requests | See CORS section above |
| `Tab load timed out` | Page took >30 seconds to load | Reload and retry |
| `Clipboard write failed` | Offscreen doc lost focus | Usually self-corrects on retry |
| Notification never appears | `notifications` permission issue | Re-install extension |

### Enable Verbose Logging
All `console.log` calls include the prefix `[PDF Copier]` or `[Offscreen]`.

To filter: in the DevTools console, type `[PDF Copier]` in the filter box.

---

## 🔄 Updating the Extension

After editing any file:
1. Go to `chrome://extensions`
2. Click the **↻ refresh icon** on the PDF Content Copier card
3. Changes take effect immediately

---

## 📚 PDF.js Version

This extension bundles **PDF.js v3.11.174** (the latest stable legacy build).

The "legacy" build is used because it's a standard ES5 script (no ES module imports needed), which is easiest to load in extension contexts.

To update PDF.js:
```bash
npm pack pdfjs-dist@latest
tar -xzf pdfjs-dist-*.tgz
cp package/build/pdf.min.js lib/
cp package/build/pdf.worker.min.js lib/
```

---

## 🔒 Privacy

This extension:
- Does **not** send any data to external servers
- Does **not** collect analytics or telemetry
- Only fetches PDFs from URLs you explicitly right-click
- All processing happens locally in your browser

---

## 💡 Possible Enhancements

- [ ] Add Tesseract.js OCR for scanned PDFs
- [ ] Options page to toggle badge display
- [ ] Save extracted text to a local file instead of clipboard
- [ ] Show word count in notification
- [ ] Support for `.docx` files (using mammoth.js)
- [ ] Keyboard shortcut to trigger extraction
