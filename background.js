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

// ─── Fallback: Extract & copy text via Chrome's built-in PDF viewer ───────────

/**
 * When PDF.js fails to extract text, we open the PDF in a hidden tab
 * and use document.execCommand to select + copy all text.
 * This works because Chrome's PDF viewer renders selectable text.
 */
async function handlePDFViaChromeViewer(url) {
  let tabId = null;

  try {
    showNotification("Fallback Mode", "Opening in Chrome viewer... Please wait 5 seconds.");

    // Open PDF in background tab (Chrome's internal viewer)
    const newTab = await chrome.tabs.create({
      url: url,
      active: false,
    });
    tabId = newTab.id;

    console.log("[PDF Copier] Opened PDF in background tab:", tabId);

    // Wait for page to load
    await waitForTabLoad(tabId);

    // Wait 5 seconds for Chrome's PDF viewer to fully initialize
    console.log("[PDF Copier] Waiting 5 seconds for PDF viewer...");
    await new Promise(r => setTimeout(r, 5000));

    // Try to copy multiple times with small delays
    for (let attempt = 1; attempt <= 3; attempt++) {
      console.log(`[PDF Copier] Copy attempt ${attempt}/3...`);
      
      const results = await chrome.scripting.executeScript({
        target: { tabId: tabId },
        func: selectAllAndCopyInPDFViewer,
      });

      if (results && results[0] && results[0].result && results[0].result.success) {
        showNotification(
          "✅ Copied!",
          `${results[0].result.charCount} characters copied.`
        );
        return; // Success!
      }

      if (attempt < 3) {
        // Wait a bit before retrying
        await new Promise(r => setTimeout(r, 1500));
      }
    }

    // All attempts failed - try the active tab method as last resort
    console.log("[PDF Copier] Background tab copy failed, trying active tab method...");
    await handlePDFViaActiveTab(url, tabId);
    tabId = null; // handlePDFViaActiveTab will clean up its own tab
    
  } catch (err) {
    console.error("[PDF Copier] Chrome viewer fallback error:", err);
    throw new Error("Could not extract text from Chrome's PDF viewer.");
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
 * Extract and copy text from Chrome's PDF viewer.
 * Tries multiple methods to get the text.
 */
function selectAllAndCopyInPDFViewer() {
  let extractedText = '';
  let method = '';

  // METHOD 1: Access Chrome's pdf-viewer shadow DOM directly
  try {
    const pdfViewer = document.querySelector('pdf-viewer');
    if (pdfViewer && pdfViewer.shadowRoot) {
      const shadow = pdfViewer.shadowRoot;
      
      // Try .textLayer first
      let textLayer = shadow.querySelector('.textLayer');
      if (!textLayer) {
        // Try finding any div with text in shadow DOM
        const allDivs = shadow.querySelectorAll('div');
        for (const div of allDivs) {
          if (div.textContent && div.textContent.length > 100) {
            textLayer = div;
            break;
          }
        }
      }
      
      if (textLayer) {
        extractedText = textLayer.textContent || '';
        extractedText = extractedText.trim();
        if (extractedText.length > 50) {
          method = 'shadowDOM-textLayer';
        }
      }
    }
  } catch (e) {
    console.log('Shadow DOM method failed:', e.message);
  }

  // METHOD 2: Use find() to search for text content
  if (!extractedText || extractedText.length < 50) {
    try {
      // window.find works on rendered text in some cases
      if (window.find) {
        const found = window.find('text', false, false, true);
        if (found) {
          const sel = window.getSelection();
          if (sel && sel.toString()) {
            extractedText = sel.toString();
            method = 'window.find';
          }
        }
      }
    } catch (e) {
      console.log('window.find failed:', e.message);
    }
  }

  // METHOD 3: Select all via execCommand then get selection
  if (!extractedText || extractedText.length < 50) {
    try {
      document.execCommand('selectAll', false, null);
      const sel = window.getSelection();
      if (sel) {
        extractedText = sel.toString();
        if (extractedText && extractedText.length > 50) {
          method = 'execCommand-selectAll';
        }
      }
    } catch (e) {
      console.log('execCommand failed:', e.message);
    }
  }

  // METHOD 4: Walk all nodes including nested shadow content
  if (!extractedText || extractedText.length < 50) {
    const collectText = (node) => {
      let text = '';
      if (node.nodeType === Node.TEXT_NODE) {
        text = node.textContent.trim();
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        // Skip invisible elements
        const style = window.getComputedStyle(node);
        if (style.display !== 'none' && style.visibility !== 'hidden') {
          // Try shadowRoot if it exists
          if (node.shadowRoot) {
            text += collectText(node.shadowRoot);
          } else {
            for (const child of node.childNodes) {
              text += collectText(child) + ' ';
            }
          }
        }
      }
      return text;
    };

    const allText = collectText(document.body);
    if (allText && allText.trim().length > 50) {
      extractedText = allText.trim();
      method = 'deep-tree-walker';
    }
  }

  // If we got text, try to copy it
  if (extractedText && extractedText.length > 50) {
    // Try clipboard API first
    try {
      navigator.clipboard.writeText(extractedText);
      return { success: true, charCount: extractedText.length, method: method + '-clipboardAPI' };
    } catch (e) {
      // Fall back to textarea trick
      try {
        const ta = document.createElement('textarea');
        ta.value = extractedText;
        ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        return { success: true, charCount: extractedText.length, method: method + '-textarea' };
      } catch (e2) {
        console.log('All copy methods failed');
      }
    }
  }

  return { success: false, error: 'No readable text found', method: method };
}

/**
 * Last resort: briefly activate the tab to allow clipboard access.
 */
async function handlePDFViaActiveTab(url, backgroundTabId) {
  let tempTabId = null;


  try {
    // Create a NEW active tab
    const newTab = await chrome.tabs.create({
      url: url,
      active: true, // This will switch focus temporarily
    });
    tempTabId = newTab.id;


    await waitForTabLoad(tempTabId);
    await new Promise(r => setTimeout(r, 3000)); // Wait for viewer

    // Try copy via script injection (now that tab is active)
    const results = await chrome.scripting.executeScript({
      target: { tabId: tempTabId },
      func: selectAllAndCopyInPDFViewer,
    });

    if (results && results[0] && results[0].result && results[0].result.success) {
      showNotification(
        "✅ Copied!",
        `${results[0].result.charCount} characters copied.`
      );
    } else {
      throw new Error("Could not extract text from PDF.");
    }
  } finally {
    // Cleanup
    if (tempTabId !== null) {
      try { await chrome.tabs.remove(tempTabId); } catch (e) {}
    }
    if (backgroundTabId !== null) {
      try { await chrome.tabs.remove(backgroundTabId); } catch (e) {}
    }
  }
}

// ─── Message Listener (from content scripts, if needed) ───────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Future: content scripts can trigger extraction via messages
  console.log("[PDF Copier] Message from content script:", message);
});
