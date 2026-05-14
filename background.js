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

let offscreenDocumentCreated = false;

/**
 * Creates the offscreen document if it doesn't already exist.
 * Chrome only allows one offscreen document per extension.
 */
async function ensureOffscreenDocument() {
  // Check if it already exists
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [OFFSCREEN_URL],
  });

  if (existingContexts.length > 0) {
    console.log("[PDF Copier] Offscreen document already exists.");
    return;
  }

  console.log("[PDF Copier] Creating offscreen document...");
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["BLOBS"], // PDF.js needs Blob/URL.createObjectURL
    justification: "Parse PDF files using PDF.js in a DOM environment",
  });

  offscreenDocumentCreated = true;
  console.log("[PDF Copier] Offscreen document created.");
}

/**
 * Send a message to the offscreen document and await a response.
 */
function sendMessageToOffscreen(message) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Offscreen document timed out (30s)."));
    }, 30000);

    chrome.runtime.sendMessage({ target: "offscreen", ...message }, (response) => {
      clearTimeout(timeout);
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
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

// ─── Fallback: Extract text via Chrome's built-in PDF viewer ─────────────────

/**
 * When PDF.js fails to extract text (due to encoding issues),
 * we open the PDF in a hidden tab and extract using Chrome's viewer.
 * Chrome's built-in viewer can render text that PDF.js can't decode.
 */
async function handlePDFViaChromeViewer(url) {
  let tabId = null;

  try {
    showNotification("Fallback Mode", "Trying Chrome's built-in PDF viewer...");


    // Open PDF in background tab (using Chrome's internal PDF viewer)
    const newTab = await chrome.tabs.create({
      url: url,
      active: false,
    });
    tabId = newTab.id;

    console.log("[PDF Copier] Opened PDF in background tab:", tabId);

    // Wait for Chrome's PDF viewer to load
    await waitForTabLoad(tabId);

    // Small delay to let Chrome's viewer fully initialize
    await new Promise(r => setTimeout(r, 2000));

    // Inject script to extract text from Chrome's PDF viewer
    const results = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: extractTextFromChromePDFViewer,
    });

    const extractedText = results?.[0]?.result;


    if (!extractedText || extractedText.trim().length < 20) {
      throw new Error("No readable text found in Chrome's PDF viewer.");
    }

    await writeToClipboardViaOffscreen(extractedText);
    showNotification(
      "✅ Copied via Chrome Viewer!",
      `${extractedText.length} characters extracted.`
    );
  } finally {
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
 * This function runs INSIDE Chrome's PDF viewer tab.
 * Chrome's PDF viewer uses a <pdf-viewer> element with layered text.
 */
function extractTextFromChromePDFViewer() {
  // Chrome's internal PDF viewer has a <pdf-viewer> element
  // with a shadow DOM containing the text layer
  const pdfViewer = document.querySelector('pdf-viewer');
  
  if (pdfViewer) {
    // Try to get text from the internal text layer
    const textLayer = pdfViewer.shadowRoot?.querySelector('.textLayer');
    if (textLayer) {
      const text = textLayer.textContent?.trim();
      if (text && text.length > 0) {
        return text;
      }
    }
    
    // Alternative: try to get text from annotation layer
    const annotationLayer = pdfViewer.shadowRoot?.querySelector('.annotationLayer');
    if (annotationLayer) {
      const annotations = annotationLayer.querySelectorAll('span');
      const texts = Array.from(annotations).map(s => s.textContent?.trim()).filter(t => t);
      if (texts.length > 0) {
        return texts.join('\n');
      }
    }
  }

  // Fallback: try selecting text the old-fashioned way
  const sel = window.getSelection();
  const ranges = [];
  
  // Try to select all selectable text on page
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        const tag = parent.tagName?.toLowerCase() || '';
        if (['script', 'style', 'noscript'].includes(tag)) {
          return NodeFilter.FILTER_REJECT;
        }
        const style = window.getComputedStyle(parent);
        if (style.display === 'none' || style.visibility === 'hidden') {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    }
  );

  const lines = [];
  let node;
  while ((node = walker.nextNode())) {
    const text = node.textContent?.trim();
    if (text && text.length > 0) {
      lines.push(text);
    }
  }

  return lines.join('\n');
}

// ─── Message Listener (from content scripts, if needed) ───────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Future: content scripts can trigger extraction via messages
  console.log("[PDF Copier] Message from content script:", message);
});
