/**
 * background.js — Service Worker (Manifest V3)
 *
 * ARCHITECTURE DECISION:
 * We use the "offscreen document" approach for PDF parsing with PDF.js.
 * Why? Because:
 *   - Fetch works great for publicly accessible PDFs without CORS issues.
 *   - PDF.js needs a DOM-like environment (canvas, worker), which service
 *     workers don't have. Offscreen documents provide that sandbox.
 *   - We avoid visible tab switching entirely. The user never sees a new tab.
 *   - Content scripts handle copying for HTML pages (non-PDF links).
 *
 * FLOW:
 *   User right-clicks link → background.js detects URL type →
 *   If PDF: fetch bytes → send to offscreen doc → parse with PDF.js →
 *   receive extracted text → write to clipboard via offscreen doc →
 *   show notification.
 *   If HTML page: open hidden tab → inject content script → extract
 *   visible text → copy → close tab.
 */

// ─── Constants ───────────────────────────────────────────────────────────────

const OFFSCREEN_URL = chrome.runtime.getURL("offscreen.html");
const CONTEXT_MENU_ID = "copy-pdf-content";

// ─── Lifecycle: Install / Startup ─────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  // Create the right-click context menu item.
  // It appears when the user right-clicks on a hyperlink (<a> tag).
  chrome.contextMenus.create({
    id: CONTEXT_MENU_ID,
    title: "📋 Copy PDF / Doc Content",
    contexts: ["link"], // only show on links
  });

  console.log("[PDF Copier] Extension installed. Context menu created.");
});

// ─── Context Menu Click Handler ───────────────────────────────────────────────

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== CONTEXT_MENU_ID) return;

  const linkUrl = info.linkUrl;

  if (!linkUrl) {
    showNotification("Error", "Could not detect a URL on this link.");
    return;
  }

  console.log("[PDF Copier] Right-clicked link:", linkUrl);

  // Validate: we can't process chrome:// or browser-internal URLs
  if (linkUrl.startsWith("chrome://") || linkUrl.startsWith("chrome-extension://")) {
    showNotification("Unsupported", "Cannot access browser-internal pages.");
    return;
  }

  try {
    showNotification("Working…", "Fetching document content, please wait.");

    const isPDF = await detectIfPDF(linkUrl);

    if (isPDF) {
      console.log("[PDF Copier] Detected as PDF. Using PDF.js via offscreen.");
      await handlePDF(linkUrl);
    } else {
      console.log("[PDF Copier] Not a PDF. Extracting text from HTML page.");
      await handleHTMLPage(linkUrl);
    }
  } catch (err) {
    console.error("[PDF Copier] Error:", err);
    showNotification("Error", err.message || "Something went wrong.");
  }
});

// ─── Step 1: Detect PDF ───────────────────────────────────────────────────────

/**
 * Detects whether a URL points to a PDF.
 * Strategy: check the URL extension first (fast), then do a HEAD request
 * to check the Content-Type header (reliable).
 */
async function detectIfPDF(url) {
  // Quick check: does the URL path end in .pdf?
  const urlPath = new URL(url).pathname.toLowerCase();
  if (urlPath.endsWith(".pdf")) {
    return true;
  }

  // Slower check: HEAD request to read Content-Type
  try {
    const response = await fetch(url, { method: "HEAD" });
    const contentType = response.headers.get("content-type") || "";
    return contentType.includes("application/pdf");
  } catch (e) {
    // HEAD request failed (e.g. CORS). Fall back to URL extension heuristic.
    console.warn("[PDF Copier] HEAD request failed, using URL heuristic:", e.message);
    return urlPath.endsWith(".pdf");
  }
}

// ─── Step 2A: Handle PDF via Offscreen Document + PDF.js ─────────────────────

/**
 * PDF handling uses Chrome's Offscreen Document API (MV3).
 * The offscreen doc has access to DOM APIs (required by PDF.js) but is
 * completely invisible to the user.
 */
async function handlePDF(url) {
  await ensureOffscreenDocument();

  // Send a message to the offscreen document to parse the PDF
  const response = await sendMessageToOffscreen({
    action: "parsePDF",
    url: url,
  });

  if (response.success) {
    // Check if PDF.js found any actual text
    const hasText = response.text && 
      !response.text.includes("[No selectable text on this page") &&
      response.text.length > 50; // Crude check for real content

    if (hasText) {
      await writeToClipboardViaOffscreen(response.text);
      showNotification(
        "✅ Copied!",
        `Extracted ${response.pageCount} page(s), ${response.text.length} characters copied.`
      );
    } else {
      // PDF.js found no text — fallback to Chrome's built-in viewer
      console.log("[PDF Copier] PDF.js found no text. Falling back to Chrome viewer...");
      await handlePDFViaChromeViewer(url);
    }
  } else {
    // PDF.js failed entirely — fallback to Chrome viewer
    console.log("[PDF Copier] PDF.js failed. Falling back to Chrome viewer...");
    await handlePDFViaChromeViewer(url);
  }
}

// ─── Step 2B: Handle Non-PDF (HTML) Pages ────────────────────────────────────

/**
 * For HTML pages, we open a hidden tab, wait for it to load,
 * inject a script to grab the visible text, then close the tab.
 *
 * NOTE: Chrome doesn't allow truly "invisible" tabs, but we use
 * the "active: false" flag so the tab opens in the background
 * without switching focus.
 */
async function handleHTMLPage(url) {
  let tabId = null;

  try {
    // Open in background (no focus switch)
    const newTab = await chrome.tabs.create({
      url: url,
      active: false, // <-- user stays on their current tab
    });
    tabId = newTab.id;

    // Wait for the page to fully load
    await waitForTabLoad(tabId);

    // Inject a small script to extract all visible text
    const results = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: extractPageText,
    });

    const extractedText = results?.[0]?.result;

    if (!extractedText || extractedText.trim().length === 0) {
      throw new Error("No readable text found on the page.");
    }

    await writeToClipboardViaOffscreen(extractedText);
    showNotification(
      "✅ Copied!",
      `${extractedText.length} characters copied from page.`
    );
  } finally {
    // Always close the background tab, even if there was an error
    if (tabId !== null) {
      try {
        await chrome.tabs.remove(tabId);
        console.log("[PDF Copier] Closed background tab:", tabId);
      } catch (e) {
        // Tab may have already been closed
      }
    }
  }
}

/**
 * This function runs INSIDE the target tab (injected via scripting API).
 * It must be self-contained — no references to outer scope.
 */
function extractPageText() {
  // Walk all text nodes, skip hidden elements
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;

        const style = window.getComputedStyle(parent);
        if (style.display === "none" || style.visibility === "hidden") {
          return NodeFilter.FILTER_REJECT;
        }

        // Skip script/style tag content
        const tag = parent.tagName.toLowerCase();
        if (["script", "style", "noscript"].includes(tag)) {
          return NodeFilter.FILTER_REJECT;
        }

        return NodeFilter.FILTER_ACCEPT;
      },
    }
  );

  const lines = [];
  let node;
  while ((node = walker.nextNode())) {
    const text = node.textContent.trim();
    if (text.length > 0) {
      lines.push(text);
    }
  }

  return lines.join("\n");
}

// ─── Offscreen Document Management ───────────────────────────────────────────


let offscreenDocumentReady = false;
let offscreenMessageId = 0;


/**
 * Creates the offscreen document fresh (or reconnects if already exists).
 * Chrome only allows one offscreen document per extension.
 */
async function ensureOffscreenDocument() {
  // Check if it already exists
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [OFFSCREEN_URL],
  });

  if (existingContexts.length > 0) {
    console.log("[PDF Copier] Offscreen document exists, using it.");
    offscreenDocumentReady = true;
    return;
  }

  // Close any existing (in case it's broken)
  try {
    // There's no official "close" API, but we can try to work around by creating fresh
    // Chrome will replace the old one
  } catch (e) {}

  console.log("[PDF Copier] Creating fresh offscreen document...");
  
  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ["BLOBS"],
      justification: "Parse PDF files using PDF.js",
    });
    offscreenDocumentReady = true;
    console.log("[PDF Copier] Offscreen document created successfully.");
  } catch (err) {
    console.error("[PDF Copier] Failed to create offscreen document:", err);
    offscreenDocumentReady = false;
    throw err;
  }
}

/**
 * Send a message to the offscreen document and await a response.
 */
function sendMessageToOffscreen(message) {
  return new Promise((resolve, reject) => {
    let retries = 0;
    const maxRetries = 2;
    
    function trySend() {
      const timeout = setTimeout(() => {
        if (retries < maxRetries) {
          retries++;
          console.log(`[PDF Copier] Offscreen send timeout, retry ${retries}/${maxRetries}...`);
          trySend();
        } else {
          reject(new Error("Offscreen document timed out after retries."));
        }
      }, 25000);

      const msgId = ++offscreenMessageId;
      
      chrome.runtime.sendMessage({ target: "offscreen", msgId, ...message }, (response) => {
        clearTimeout(timeout);
        if (chrome.runtime.lastError) {
          console.warn(`[PDF Copier] Offscreen error (attempt ${retries+1}):`, chrome.runtime.lastError.message);
          if (retries < maxRetries) {
            retries++;
            setTimeout(trySend, 1000); // Wait 1s before retry
          } else {
            reject(new Error(chrome.runtime.lastError.message));
          }
        } else {
          resolve(response);
        }
      });
    }
    
    trySend();
  });
}

/**
 * Ask the offscreen document to write text to the clipboard.
 * (Service workers cannot access navigator.clipboard directly.)
 */
async function writeToClipboardViaOffscreen(text) {
  await ensureOffscreenDocument();

  const response = await sendMessageToOffscreen({
    action: "copyToClipboard",
    text: text,
  });

  if (!response.success) {
    throw new Error("Clipboard write failed: " + response.error);
  }
}

// ─── Tab Utilities ────────────────────────────────────────────────────────────

/**
 * Returns a Promise that resolves when the given tab finishes loading.
 * Times out after 30 seconds to avoid hanging forever.
 */
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
        resolve();
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

// ─── Fallback: Open PDF in tab + Inject OCR script ─────────────────────────────

/**
 * Opens PDF in a visible tab and runs the OCR script directly in the tab.
 * This is the same approach that works in the console!
 */
async function handlePDFViaChromeViewer(url) {
  let tabId = null;


  try {
    showNotification("Extracting Text...", "Please wait a few seconds.");


    console.log("[PDF Copier] Opening PDF in visible tab for extraction...");

    // Open PDF in a visible tab
    const newTab = await chrome.tabs.create({
      url: url,
      active: true,
    });
    tabId = newTab.id;


    // Wait for page to load
    await waitForTabLoad(tabId);

    // Wait for Chrome's PDF viewer to initialize (longer wait for visible tab)
    await new Promise(r => setTimeout(r, 4000));


    // Inject the script that works!
    const results = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: extractPDFTextViaConsole,
    });

    const extractedText = results?.[0]?.result;


    if (extractedText && extractedText.trim().length > 50) {
      await writeToClipboardViaOffscreen(extractedText);
      showNotification(
        "✅ Copied!",
        `${extractedText.trim().length} characters extracted. Tab will stay open.`
      );
    } else {
      throw new Error("No text extracted from PDF.");
    }
  } catch (err) {
    console.error("[PDF Copier] Tab extraction error:", err);
    throw new Error("Could not extract text: " + err.message);
  }
  // Tab stays open so you can see what happened
}

/**
 * This function runs IN the PDF tab's console - same code that works!
 */
async function extractPDFTextViaConsole() {
  return new Promise(async (resolve, reject) => {
    try {
      // Load Tesseract from CDN inside the tab (same as user's working code!)
      const script = document.createElement('script');
      script.src = 'https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/4.1.1/tesseract.min.js';
      document.head.appendChild(script);

      // Wait for Tesseract to load
      await new Promise((res, rej) => {
        script.onload = res;
        script.onerror = () => rej(new Error('Tesseract failed to load'));
      });

      // Get PDF bytes
      const buf = await fetch(window.location.href, { credentials: 'include' }).then(r => r.arrayBuffer());
      const pdf = await pdfjsLib.getDocument({ data: buf }).promise;

      let fullText = '';
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const viewport = page.getViewport({ scale: 2 });
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
        const { data: { text } } = await Tesseract.recognize(canvas, 'eng');
        fullText += text + '\n';
        console.log(`Page ${i} done`);
      }

      // Copy to clipboard
      await navigator.clipboard.writeText(fullText);
      console.log('Copied to clipboard!');

      resolve(fullText);
    } catch (err) {
      reject(err);
    }
  });
}

// ─── Message Listener (from content scripts, if needed) ───────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Future: content scripts can trigger extraction via messages
  console.log("[PDF Copier] Message from content script:", message);
});
