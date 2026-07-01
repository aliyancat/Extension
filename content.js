/**
 * content.js — Content Script
 *
 * Runs on every webpage the user visits.
 *
 * Roles:
 *   - Adds 📋 badges to PDF links on pages
 *   - Detects print-view pages and adds a floating "Scan" button
 *   - Relays scan requests to the background service worker
 */

console.log("[PDF Copier] Content script loaded on:", window.location.hostname);

// ─── Optional: Visual Badge on PDF Links ─────────────────────────────────────

function initPDFBadges() {
  const links = document.querySelectorAll('a[href$=".pdf"], a[href*=".pdf?"]');

  links.forEach((link) => {
    if (link.dataset.pdfCopierTagged) return;
    link.dataset.pdfCopierTagged = "true";

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

// ─── Floating Scan Button for Print-View Pages ────────────────────────────────

function isPrintViewPage() {
  const url = window.location.href;
  return /\/print\/?(\?|$)/i.test(url) ||
         /[?&]print=1/i.test(url) ||
         /\/printview/i.test(url);
}

function hasEmbeddedPDF() {
  return !!document.querySelector(
    'iframe[src*=".pdf"], embed[src*=".pdf"], object[data*=".pdf"]'
  );
}

function initScanButton() {
  // Only add the button on print-view pages or pages with embedded PDFs
  if (!isPrintViewPage() && !hasEmbeddedPDF()) return;

  // Don't add duplicate buttons
  if (document.getElementById('pdf-copier-scan-btn')) return;

  const btn = document.createElement('button');
  btn.id = 'pdf-copier-scan-btn';
  btn.textContent = '📋 Scan This Page';
  btn.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    z-index: 999999;
    padding: 12px 24px;
    background: #4CAF50;
    color: white;
    border: none;
    border-radius: 8px;
    font-size: 14px;
    font-family: sans-serif;
    cursor: pointer;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    transition: background 0.2s, transform 0.1s;
  `;
  btn.onmouseover = () => { btn.style.background = '#45a049'; };
  btn.onmouseout = () => { btn.style.background = '#4CAF50'; };
  btn.onmousedown = () => { btn.style.transform = 'scale(0.95)'; };
  btn.onmouseup = () => { btn.style.transform = 'scale(1)'; };

  btn.onclick = async () => {
    btn.disabled = true;
    btn.textContent = '📋 Scanning...';
    btn.style.background = '#888';

    try {
      const response = await chrome.runtime.sendMessage({ action: "scanCurrentPage" });
      if (response && response.success) {
        btn.textContent = '✅ Done!';
        btn.style.background = '#4CAF50';
      } else {
        btn.textContent = '❌ Error';
        btn.style.background = '#f44336';
      }
    } catch (err) {
      btn.textContent = '❌ Error';
      btn.style.background = '#f44336';
    }

    setTimeout(() => {
      btn.disabled = false;
      btn.textContent = '📋 Scan This Page';
      btn.style.background = '#4CAF50';
    }, 5000);
  };

  document.body.appendChild(btn);
}

// ─── Initialization ───────────────────────────────────────────────────────────

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    initPDFBadges();
    initScanButton();
  });
} else {
  initPDFBadges();
  initScanButton();
}

// Watch for dynamically added content (e.g. infinite scroll, SPAs)
const observer = new MutationObserver(() => {
  initPDFBadges();
  initScanButton();
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
