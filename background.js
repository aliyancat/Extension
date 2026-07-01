// ─── Context Menu IDs ──────────────────────────────────────────────────────────
const CONTEXT_MENU_LINK = "copy-pdf-content";
const CONTEXT_MENU_PAGE = "copy-pdf-content-page";

// ─── Extraction Function (injected into page via chrome.scripting) ───────────
// This function is serialized and executed in the page's MAIN world.
// It must be self-contained — no references to external variables.
const EXTRACTION_FUNC = async () => {
  // Show progress indicator on the page
  const progress = document.createElement('div');
  progress.id = 'pdf-copier-progress';
  progress.style.cssText = 'position:fixed;top:10px;right:10px;background:#4CAF50;color:white;padding:15px 25px;border-radius:8px;z-index:999999;font-size:14px;font-family:sans-serif;box-shadow:0 4px 12px rgba(0,0,0,0.3);';
  progress.textContent = '📋 Scanning... Loading libraries...';
  document.body.appendChild(progress);

  try {
    // Load PDF.js
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
      s.onload = resolve;
      s.onerror = () => reject(new Error('Failed to load PDF.js'));
      document.head.appendChild(s);
    });
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

    // Load Tesseract.js
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/4.1.1/tesseract.min.js';
      s.onload = resolve;
      s.onerror = () => reject(new Error('Failed to load Tesseract.js'));
      document.head.appendChild(s);
    });

    progress.textContent = '📋 Scanning... Fetching content...';

    // Fetch the current page content
    const response = await fetch(window.location.href, { credentials: 'include' });
    const contentType = response.headers.get('content-type') || '';
    const buf = await response.arrayBuffer();

    // Check if it's a PDF (by content-type or magic bytes %PDF-)
    const header = new Uint8Array(buf.slice(0, 5));
    const isPDF = contentType.includes('application/pdf') ||
                  String.fromCharCode(...header) === '%PDF-';

    let fullText = '';

    // ─── Helper: OCR a PDF page to text ────────────────────────────────────────
    async function ocrPdfPage(page) {
      const viewport = page.getViewport({ scale: 3 });
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;

      // Grayscale conversion for better OCR accuracy
      const ctx = canvas.getContext('2d');
      const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = imgData.data;
      for (let j = 0; j < data.length; j += 4) {
        const gray = data[j] * 0.299 + data[j + 1] * 0.587 + data[j + 2] * 0.114;
        data[j] = data[j + 1] = data[j + 2] = gray;
      }
      ctx.putImageData(imgData, 0, 0);

      const { data: { text } } = await Tesseract.recognize(canvas, 'eng', {}, {
        tessedit_pageseg_mode: 6,
      });
      return text;
    }

    if (isPDF) {
      // ─── Direct PDF Processing ────────────────────────────────────────────────
      progress.textContent = '📋 Scanning... Processing PDF...';
      const pdf = await pdfjsLib.getDocument(buf).promise;

      for (let i = 1; i <= pdf.numPages; i++) {
        progress.textContent = `📋 Scanning... Page ${i} of ${pdf.numPages}...`;
        const page = await pdf.getPage(i);
        fullText += await ocrPdfPage(page) + '\n';
      }
    } else {
      // ─── HTML Page — check for embedded PDFs first ───────────────────────────
      const embeddedPdf = document.querySelector(
        'iframe[src*=".pdf"], embed[src*=".pdf"], object[data*=".pdf"]'
      );

      if (embeddedPdf) {
        progress.textContent = '📋 Scanning... Found embedded PDF...';
        const pdfUrl = embeddedPdf.src || embeddedPdf.getAttribute('data');
        const pdfResponse = await fetch(pdfUrl, { credentials: 'include' });
        const pdfBuf = await pdfResponse.arrayBuffer();
        const pdf = await pdfjsLib.getDocument(pdfBuf).promise;

        for (let i = 1; i <= pdf.numPages; i++) {
          progress.textContent = `📋 Scanning... Page ${i} of ${pdf.numPages}...`;
          const page = await pdf.getPage(i);
          fullText += await ocrPdfPage(page) + '\n';
        }
      } else {
        // ─── Collect all images and canvases on the page ─────────────────────────
        const allImageElements = Array.from(document.querySelectorAll('img'));
        const allCanvasElements = Array.from(document.querySelectorAll('canvas'));

        // ─── Extract text from the DOM ─────────────────────────────────────────
        progress.textContent = '📋 Scanning... Extracting text...';

        const walker = document.createTreeWalker(
          document.body,
          NodeFilter.SHOW_TEXT,
          {
            acceptNode: function (node) {
              const parent = node.parentElement;
              if (!parent) return NodeFilter.FILTER_REJECT;
              const tag = parent.tagName.toLowerCase();
              if (['script', 'style', 'noscript', 'iframe', 'object', 'embed'].includes(tag)) {
                return NodeFilter.FILTER_REJECT;
              }
              const text = node.textContent.trim();
              if (text.length === 0) return NodeFilter.FILTER_REJECT;
              return NodeFilter.FILTER_ACCEPT;
            },
          }
        );

        while (walker.nextNode()) {
          fullText += walker.currentNode.textContent.trim() + '\n';
        }

        // ─── Also extract text from same-origin iframes ──────────────────────────
        const iframes = document.querySelectorAll('iframe');
        for (let f = 0; f < iframes.length; f++) {
          try {
            const iframeDoc = iframes[f].contentDocument || iframes[f].contentWindow.document;
            if (!iframeDoc) continue;
            const iframeWalker = document.createTreeWalker(
              iframeDoc.body,
              NodeFilter.SHOW_TEXT,
              {
                acceptNode: function (node) {
                  const parent = node.parentElement;
                  if (!parent) return NodeFilter.FILTER_REJECT;
                  const tag = parent.tagName.toLowerCase();
                  if (['script', 'style', 'noscript', 'iframe', 'object', 'embed'].includes(tag)) {
                    return NodeFilter.FILTER_REJECT;
                  }
                  const text = node.textContent.trim();
                  if (text.length === 0) return NodeFilter.FILTER_REJECT;
                  return NodeFilter.FILTER_ACCEPT;
                },
              }
            );
            while (iframeWalker.nextNode()) {
              fullText += iframeWalker.currentNode.textContent.trim() + '\n';
            }
            // Also collect images from iframes
            const iframeImages = iframeDoc.querySelectorAll('img');
            for (let i = 0; i < iframeImages.length; i++) {
              allImageElements.push(iframeImages[i]);
            }
            const iframeCanvases = iframeDoc.querySelectorAll('canvas');
            for (let i = 0; i < iframeCanvases.length; i++) {
              allCanvasElements.push(iframeCanvases[i]);
            }
          } catch (e) {
            console.log('[PDF Copier] Cannot access iframe (cross-origin):', e.message);
          }
        }

        // ─── Helper: fetch image as blob to avoid cross-origin canvas tainting ───
        async function ocrImageElement(imgEl, index, total) {
          progress.textContent = `📋 Scanning... Image ${index + 1} of ${total}...`;
          try {
            const src = imgEl.src || imgEl.getAttribute('data-src') || '';
            if (!src || src.startsWith('data:')) {
              // For data URLs, draw directly
              const canvas = document.createElement('canvas');
              canvas.width = imgEl.naturalWidth || imgEl.width || 1000;
              canvas.height = imgEl.naturalHeight || imgEl.height || 1000;
              const ctx = canvas.getContext('2d');
              ctx.drawImage(imgEl, 0, 0, canvas.width, canvas.height);
              return await ocrCanvas(canvas);
            }

            // Fetch the image as a blob to bypass cross-origin restrictions
            const imgResponse = await fetch(src, { credentials: 'include' });
            const blob = await imgResponse.blob();
            const blobUrl = URL.createObjectURL(blob);

            const img = new Image();
            img.crossOrigin = 'anonymous';

            await new Promise((resolve, reject) => {
              img.onload = resolve;
              img.onerror = () => reject(new Error('Image load failed: ' + src));
              img.src = blobUrl;
            });

            const canvas = document.createElement('canvas');
            canvas.width = img.naturalWidth || img.width || 1000;
            canvas.height = img.naturalHeight || img.height || 1000;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0);

            URL.revokeObjectURL(blobUrl);
            return await ocrCanvas(canvas);
          } catch (e) {
            console.error('[PDF Copier] OCR failed for image:', e.message);
            return '';
          }
        }

        // ─── Helper: OCR a canvas element ─────────────────────────────────────────
        async function ocrCanvas(canvas) {
          const ctx = canvas.getContext('2d');
          const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const data = imgData.data;
          for (let j = 0; j < data.length; j += 4) {
            const gray = data[j] * 0.299 + data[j + 1] * 0.587 + data[j + 2] * 0.114;
            data[j] = data[j + 1] = data[j + 2] = gray;
          }
          ctx.putImageData(imgData, 0, 0);

          const { data: { text } } = await Tesseract.recognize(canvas, 'eng', {}, {
            tessedit_pageseg_mode: 6,
          });
          return text;
        }

        // ─── OCR all images on the page ──────────────────────────────────────────
        if (allImageElements.length > 0) {
          progress.textContent = `📋 Scanning... Found ${allImageElements.length} images...`;
          for (let i = 0; i < allImageElements.length; i++) {
            const ocrText = await ocrImageElement(allImageElements[i], i, allImageElements.length);
            if (ocrText.trim()) {
              fullText += ocrText + '\n';
            }
          }
        }

        // ─── OCR all canvas elements on the page ─────────────────────────────────
        if (allCanvasElements.length > 0) {
          progress.textContent = `📋 Scanning... Found ${allCanvasElements.length} canvases...`;
          for (let i = 0; i < allCanvasElements.length; i++) {
            progress.textContent = `📋 Scanning... Canvas ${i + 1} of ${allCanvasElements.length}...`;
            try {
              const ocrText = await ocrCanvas(allCanvasElements[i]);
              if (ocrText.trim()) {
                fullText += ocrText + '\n';
              }
            } catch (e) {
              console.error('[PDF Copier] OCR failed for canvas:', e.message);
            }
          }
        }
      }
    }

    await navigator.clipboard.writeText(fullText);
    progress.textContent = `✅ Copied ${fullText.length} characters!`;
    progress.style.background = '#4CAF50';
    setTimeout(() => progress.remove(), 3000);
    return fullText.length;
  } catch (err) {
    progress.textContent = '❌ Error: ' + err.message;
    progress.style.background = '#f44336';
    setTimeout(() => progress.remove(), 5000);
    throw err;
  }
};

// ─── Context Menu Setup ──────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: CONTEXT_MENU_LINK,
    title: "📋 Copy PDF / Doc Content",
    contexts: ["link"],
  });

  chrome.contextMenus.create({
    id: CONTEXT_MENU_PAGE,
    title: "📋 Scan This Page for Text",
    contexts: ["page"],
  });
});

// ─── Context Menu Handler ─────────────────────────────────────────────────────
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  let url;
  let useCurrentTab = false;

  if (info.menuItemId === CONTEXT_MENU_LINK) {
    url = info.linkUrl;
  } else if (info.menuItemId === CONTEXT_MENU_PAGE) {
    url = info.pageUrl || tab.url;
    useCurrentTab = true;
  } else {
    return;
  }

  if (!url) return;

  if (url.startsWith("chrome://") || url.startsWith("chrome-extension://")) {
    showNotification("Unsupported", "Cannot extract from browser-internal pages.");
    return;
  }

  try {
    showNotification("Working…", "Extracting content...");
    if (useCurrentTab) {
      await handleCurrentTab(tab.id);
    } else {
      await handlePDF(url);
    }
  } catch (err) {
    console.error("[PDF Copier] Error:", err);
    showNotification("Error", err.message || "Something went wrong.");
  }
});

// ─── Toolbar Button Handler ───────────────────────────────────────────────────
chrome.action.onClicked.addListener(async (tab) => {
  const url = tab.url;
  if (!url || url.startsWith("chrome://") || url.startsWith("chrome-extension://")) {
    showNotification("Unsupported", "Cannot extract from browser-internal pages.");
    return;
  }

  try {
    showNotification("Working…", "Extracting content...");
    await handleCurrentTab(tab.id);
  } catch (err) {
    console.error("[PDF Copier] Error:", err);
    showNotification("Error", err.message || "Something went wrong.");
  }
});

// ─── Message Listener (from content script) ───────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "scanCurrentPage") {
    const tabId = sender.tab.id;
    handleCurrentTab(tabId)
      .then(() => sendResponse({ success: true }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true; // keep channel open for async response
  }
});

// ─── Extraction Functions ────────────────────────────────────────────────────

async function handlePDF(url) {
  const tab = await chrome.tabs.create({ url: url, active: true });
  await waitForTabLoad(tab.id);

  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: "MAIN",
    func: EXTRACTION_FUNC,
  });

  await chrome.tabs.remove(tab.id);
  const charCount = results?.[0]?.result;
  showNotification("✅ Copied!", `${charCount} characters copied to clipboard!`);
}

async function handleCurrentTab(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId: tabId },
    world: "MAIN",
    func: EXTRACTION_FUNC,
  });

  const charCount = results?.[0]?.result;
  showNotification("✅ Copied!", `${charCount} characters copied to clipboard!`);
}

// ─── Tab Utilities ────────────────────────────────────────────────────────────

function waitForTabLoad(tabId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("Tab load timed out after 30 seconds."));
    }, 30000);

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve() ;
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
  });
}

// ─── Notifications ────────────────────────────────────────────────────────────

function showNotification(title, message) {
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icons/icon48.png",
    title: `PDF Copier: ${title}`,
    message: message,
  });
}


