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
});

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
 * WHY HERE and not in background.js (service worker)?
 * Chrome's Clipboard API requires the call to happen in a "focused" document
 * context. Service workers don't have a document, so they can't call
 * navigator.clipboard.writeText(). Offscreen documents are documents,
 * so this works here.
 *
 * @param {string} text - The text to write to clipboard.
 */
async function handleCopyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    console.log("[Offscreen] Clipboard write successful, length:", text.length);
    return { success: true };
  } catch (clipErr) {
    // Fallback: use the old execCommand approach (works in more contexts)
    console.warn("[Offscreen] Clipboard API failed, trying execCommand fallback:", clipErr);

    const textArea = document.createElement("textarea");
    textArea.value = text;
    textArea.style.position = "fixed";
    textArea.style.opacity = "0";
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();

    try {
      const success = document.execCommand("copy");
      document.body.removeChild(textArea);

      if (success) {
        console.log("[Offscreen] Fallback clipboard write succeeded.");
        return { success: true };
      } else {
        throw new Error("execCommand copy returned false.");
      }
    } catch (fallbackErr) {
      document.body.removeChild(textArea);
      throw new Error(`Clipboard write failed: ${fallbackErr.message}`);
    }
  }
}
