/**
 * content.js — Content Script
 *
 * Runs on every webpage the user visits.
 *
 * Current role: Minimal. Most work is done in background.js + offscreen.js.
 *
 * Future use cases for this script:
 *   - Hover detection to pre-fetch PDF metadata
 *   - Visual highlight of PDF links on page
 *   - Inline status indicator next to links
 *   - Keyboard shortcut support
 *
 * NOTE: Content scripts run in an isolated world — they can read the DOM
 * but cannot directly access the extension's background service worker data.
 * Communication happens via chrome.runtime.sendMessage().
 */

console.log("[PDF Copier] Content script loaded on:", window.location.hostname);

// ─── Optional: Visual Badge on PDF Links ─────────────────────────────────────

/**
 * Adds a subtle "PDF" badge next to links that appear to point to PDFs.
 * This is optional — comment out initPDFBadges() if you don't want it.
 */
function initPDFBadges() {
  // Find all links ending in .pdf
  const links = document.querySelectorAll('a[href$=".pdf"], a[href*=".pdf?"]');

  links.forEach((link) => {
    if (link.dataset.pdfCopierTagged) return; // don't double-tag
    link.dataset.pdfCopierTagged = "true";

    // Create a small badge element
    const badge = document.createElement("span");
    badge.textContent = " 📋";
    badge.title = "Right-click → Copy PDF Content";
    badge.style.cssText = `
      font-size: 0.75em;
      opacity: 0.6;
      cursor: default;
      user-select: none;
      vertical-align: middle;
    `;

    link.after(badge);
  });
}

// Run badge tagging after DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initPDFBadges);
} else {
  initPDFBadges();
}

// Also run if new links are added dynamically (e.g. infinite scroll, SPAs)
const observer = new MutationObserver(() => {
  initPDFBadges();
});

observer.observe(document.body, {
  childList: true,
  subtree: true,
});

// ─── Message Listener ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "ping") {
    sendResponse({ alive: true });
  }
});
