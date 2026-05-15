/**
 * offscreen.js — Runs inside the hidden offscreen document.
 *
 * Responsibilities:
 *   1. Listen for messages from background.js
 *   2. Parse PDFs using PDF.js (needs DOM environment)
 *   3. Write text to clipboard (needs document focus context)
 *   4. Report results back to background.js
 *
 * PDF.js Notes:
 *   - We use the "legacy" build (pdf.min.js) bundled locally.
 *   - We set the workerSrc to pdf.worker.min.js (also bundled locally).
 *   - This avoids CDN dependency and CORS issues with workers.
 *
 * LIMITATION — Scanned PDFs:
 *   PDF.js can only extract text from PDFs with embedded selectable text.
 *   If a PDF was created by scanning a physical document (image-only PDF),
 *   PDF.js will return empty strings. In that case, you'd need an OCR
 *   library like Tesseract.js, which is much heavier (~30MB).
 *   For your workflow (publicly accessible, copyable PDFs), this should
 *   not be a problem.
 */

// ─── PDF.js Setup ─────────────────────────────────────────────────────────────

// Tell PDF.js where to find the worker script.
// This must match the path inside your extension folder.
if (typeof pdfjsLib !== "undefined") {
  pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL(
    "lib/pdf.worker.min.js"
  );
  console.log("[Offscreen] PDF.js loaded, worker configured.");
} else {
  console.error("[Offscreen] PDF.js failed to load! Check lib/pdf.min.js path.");
}

// ─── Message Router ───────────────────────────────────────────────────────────

/**
 * Listen for messages from background.js.
 * All messages meant for this offscreen doc include: { target: "offscreen" }
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only handle messages targeted at this offscreen document
  if (message.target !== "offscreen") return;

  console.log("[Offscreen] Received message:", message.action);

  // Route to the appropriate handler
  if (message.action === "parsePDF") {
    handleParsePDF(message.url)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));

    return true; // Keep the message channel open for async response
  }

  if (message.action === "copyToClipboard") {
    handleCopyToClipboard(message.text)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));


    return true;
  }

  if (message.action === "downloadAndParse") {
    handleDownloadAndParse(message.url)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message }));

    return true;
  }
});

// ─── Download + Parse PDF ──────────────────────────────────────────────────────

/**
 * Download a PDF and parse it using PDF.js.
 * This is the fallback when the original fetch fails or returns no text.
 */
async function handleDownloadAndParse(url) {
  if (typeof pdfjsLib === "undefined") {
    return { success: false, error: "PDF.js is not loaded." };
  }

  console.log("[Offscreen] Downloading PDF:", url);

  let arrayBuffer;
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    arrayBuffer = await response.arrayBuffer();
    console.log("[Offscreen] PDF downloaded:", arrayBuffer.byteLength, "bytes");
  } catch (err) {
    throw new Error(`Failed to download PDF: ${err.message}`);
  }

  // Load with PDF.js using different options for stubborn PDFs
  let pdfDoc;
  try {
    const loadingTask = pdfjsLib.getDocument({
      data: arrayBuffer,
      // Try these options for better compatibility
      verbosity: 0,
      // Use a standard font handler
      cMapUrl: null, // Don't rely on external CMaps
      cMapPacked: true,
    });
    pdfDoc = await loadingTask.promise;
    console.log("[Offscreen] PDF loaded via fallback, pages:", pdfDoc.numPages);
  } catch (err) {
    throw new Error(`PDF.js could not parse file: ${err.message}`);
  }

  // Extract text from all pages
  const allText = [];
  for (let i = 1; i <= pdfDoc.numPages; i++) {
    try {
      const page = await pdfDoc.getPage(i);
      const content = await page.getTextContent();
      
      // Try to extract text in different ways
      let pageText = "";
      
      // Method 1: items-based extraction
      const items = content.items || [];
      if (items.length > 0) {
        pageText = items.map(item => item.str).join(" ");
      }
      
      // If still empty, try the raw content string
      if (!pageText || pageText.trim().length === 0) {
        if (content.text) {
          pageText = content.text;
        }
      }

      if (pageText && pageText.trim().length > 0) {
        allText.push(`--- Page ${i} ---\n${pageText}`);
      } else {
        // Even if no text, mark the page
        allText.push(`--- Page ${i} ---
[Page ${i} of ${pdfDoc.numPages}]`);
      }
    } catch (pageErr) {
      allText.push(`--- Page ${i} ---
[Could not read page ${i}]`);
    }
  }

  const fullText = allText.join("\n\n");
  
  console.log("[Offscreen] Fallback extraction complete:", pdfDoc.numPages, "pages,", fullText.length, "chars");

  return {
    success: true,
    text: fullText,
    pageCount: pdfDoc.numPages,
  };
}

// ─── PDF Parsing ──────────────────────────────────────────────────────────────

/**
 * Fetches a PDF from a URL and extracts all text using PDF.js.
 *
 * @param {string} url - The URL of the PDF to fetch.
 * @returns {Promise<{success, text, pageCount, error}>}
 */
async function handleParsePDF(url) {
  if (typeof pdfjsLib === "undefined") {
    return { success: false, error: "PDF.js is not loaded. Check your setup." };
  }

  console.log("[Offscreen] Fetching PDF from:", url);

  let arrayBuffer;

  try {
    // Fetch the raw PDF bytes
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    arrayBuffer = await response.arrayBuffer();
    console.log("[Offscreen] PDF fetched, size:", arrayBuffer.byteLength, "bytes");
  } catch (fetchError) {
    // CORS Error Explanation:
    // If the PDF server doesn't send CORS headers (Access-Control-Allow-Origin),
    // Chrome will block the fetch. This is a browser security restriction.
    // Workaround options:
    //   1. Use a CORS proxy (not ideal for private/sensitive docs)
    //   2. Open in a tab and use content scripts (already handled in background.js)
    //   3. Ask the server owner to enable CORS (if you control the server)
    throw new Error(
      `Failed to fetch PDF: ${fetchError.message}. ` +
        "This may be a CORS issue — the server may not allow cross-origin requests."
    );
  }

  // Load the PDF document using PDF.js
  let pdfDoc;
  try {
    const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
    pdfDoc = await loadingTask.promise;
    console.log("[Offscreen] PDF loaded, pages:", pdfDoc.numPages);
  } catch (pdfError) {
    throw new Error(`PDF.js could not parse the file: ${pdfError.message}`);
  }

  // Extract text from every page
  const allText = [];

  for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
    try {
      const page = await pdfDoc.getPage(pageNum);
      const textContent = await page.getTextContent();

      // textContent.items is an array of text chunks
      // Each item has a `str` property (the actual text) and `hasEOL` (line break hint)
      const pageText = textContent.items
        .map((item) => {
          // item.hasEOL is true when PDF.js detected a line ending here
          return item.str + (item.hasEOL ? "\n" : " ");
        })
        .join("")
        .trim();

      if (pageText.length > 0) {
        allText.push(`--- Page ${pageNum} ---\n${pageText}`);
      } else {
        // This page has no extractable text (possibly a scanned image)
        allText.push(`--- Page ${pageNum} ---\n[No selectable text on this page — may be a scanned image]`);
      }
    } catch (pageError) {
      console.warn(`[Offscreen] Error on page ${pageNum}:`, pageError);
      allText.push(`--- Page ${pageNum} ---\n[Error reading this page: ${pageError.message}]`);
    }
  }

  const fullText = allText.join("\n\n");

  console.log(
    "[Offscreen] Extraction complete.",
    pdfDoc.numPages,
    "pages,",
    fullText.length,
    "chars"
  );

  return {
    success: true,
    text: fullText,
    pageCount: pdfDoc.numPages,
  };
}

// ─── Clipboard Writing ────────────────────────────────────────────────────────

/**
 * Writes text to the system clipboard.
 *
 * @param {string} text - The text to write to clipboard.
 */
async function handleCopyToClipboard(text) {
  // Try the modern Clipboard API first
  try {
    await navigator.clipboard.writeText(text);
    console.log("[Offscreen] Clipboard API succeeded, length:", text.length);
    return { success: true };
  } catch (clipErr) {
    console.warn("[Offscreen] Clipboard API failed:", clipErr.message);
  }

  // Fallback 1: Create a temporary input/textarea element
  try {
    const el = document.createElement('textarea');
    el.value = text;
    el.style.cssText = 'position:fixed;left:-9999px;top:-9999px;';
    document.body.appendChild(el);
    el.focus();
    el.select();
    const success = document.execCommand('copy');
    document.body.removeChild(el);
    if (success) {
      console.log("[Offscreen] execCommand copy succeeded!");
      return { success: true };
    }
  } catch (e1) {
    console.warn("[Offscreen] Fallback 1 failed:", e1.message);
  }

  // Fallback 2: Try with an input element
  try {
    const input = document.createElement('input');
    input.value = text;
    input.style.cssText = 'position:fixed;left:-9999px;top:-9999px;';
    document.body.appendChild(input);
    input.select();
    const success = document.execCommand('copy');
    document.body.removeChild(input);
    if (success) {
      console.log("[Offscreen] execCommand (input) copy succeeded!");
      return { success: true };
    }
  } catch (e2) {
    console.warn("[Offscreen] Fallback 2 failed:", e2.message);
  }

  throw new Error("All clipboard methods failed. Try copying manually with Ctrl+A → Ctrl+C.");
}
