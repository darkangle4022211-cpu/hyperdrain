// HyperDrain Content Script - IDM-Style Floating Video Downloader & Link Interceptor
(function () {
  // For subframes (e.g. MegaPlay, ZokoAnime, MegaCloud, RapidCloud embed):
  // Sniff video elements, window.__P, or embedded sources and report them to top tab
  if (window !== window.top) {
    let lastReportedSrc = "";
    function reportFrameMedia() {
      // 1. Check for ZokoAnime / Otaku encoded payload (window.__P)
      try {
        let pBlob = window.__P;
        if (!pBlob) {
          const scripts = document.querySelectorAll("script");
          for (const s of scripts) {
            const m = (s.textContent || "").match(/window\.__P\s*=\s*["']([^"']+)["']/);
            if (m && m[1]) {
              pBlob = m[1];
              break;
            }
          }
        }
        if (pBlob) {
          const raw = atob(pBlob);
          const key = "otaku-embed-v1";
          let out = "";
          for (let i = 0; i < raw.length; i++) {
            out += String.fromCharCode(raw.charCodeAt(i) ^ key.charCodeAt(i % key.length));
          }
          const data = JSON.parse(decodeURIComponent(escape(out)));
          if (data && data.src && data.src.includes(".m3u8") && data.src !== lastReportedSrc) {
            lastReportedSrc = data.src;
            chrome.runtime.sendMessage({
              action: "report_stream_from_frame",
              url: data.src,
              referer: window.location.href
            }).catch(() => {});
          }
        }
      } catch (e) {}

      // 2. Direct HTML5 video element source
      try {
        const vids = document.querySelectorAll("video");
        vids.forEach((v) => {
          const src = v.currentSrc || v.src;
          if (src && !src.startsWith("blob:") && !src.startsWith("data:") && src !== lastReportedSrc) {
            lastReportedSrc = src;
            chrome.runtime.sendMessage({
              action: "report_stream_from_frame",
              url: src,
              referer: window.location.href
            }).catch(() => {});
          }
        });
      } catch (e) {}
    }
    document.addEventListener("DOMContentLoaded", reportFrameMedia);
    setInterval(reportFrameMedia, 1500);
    return;
  }

  const CORE_API = "http://127.0.0.1:6880";

  // 1. Inject Styles for the IDM Floating Video Panel
  const style = document.createElement("style");
  style.textContent = `
    .hd-video-panel {
      position: absolute !important;
      top: 14px !important;
      right: 20px !important;
      z-index: 2147483647 !important;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
      user-select: none !important;
      pointer-events: auto !important;
      opacity: 0.96 !important;
      display: flex !important;
      visibility: visible !important;
      transition: opacity 0.2s ease, transform 0.2s ease !important;
    }
    html.hd-hide-panels .hd-video-panel,
    body.hd-hide-panels .hd-video-panel {
      display: none !important;
      visibility: hidden !important;
      pointer-events: none !important;
      opacity: 0 !important;
    }
    .hd-video-panel:hover {
      opacity: 1 !important;
      transform: scale(1.02) !important;
    }
    .hd-panel-btn {
      display: flex !important;
      align-items: center !important;
      gap: 7px !important;
      background: rgba(8, 12, 22, 0.94) !important;
      backdrop-filter: blur(16px) !important;
      border: 1px solid rgba(0, 242, 254, 0.5) !important;
      border-radius: 8px !important;
      padding: 7px 13px !important;
      color: #fff !important;
      font-size: 12px !important;
      font-weight: 700 !important;
      cursor: pointer !important;
      box-shadow: 0 4px 18px rgba(0, 0, 0, 0.7), 0 0 14px rgba(0, 242, 254, 0.3) !important;
      transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1) !important;
    }
    .hd-panel-btn:hover {
      background: rgba(14, 22, 42, 0.98) !important;
      border-color: #00f2fe !important;
      box-shadow: 0 6px 24px rgba(0, 0, 0, 0.85), 0 0 20px rgba(0, 242, 254, 0.5) !important;
      transform: translateY(-1px) !important;
    }
    .hd-bolt {
      color: #00f2fe !important;
      font-size: 13px !important;
      filter: drop-shadow(0 0 6px #00f2fe) !important;
    }
    .hd-arrow {
      font-size: 9px !important;
      color: #94a3b8 !important;
      transition: transform 0.2s ease !important;
    }
    .hd-panel-btn.active .hd-arrow {
      transform: rotate(180deg) !important;
    }
    .hd-dropdown {
      position: absolute !important;
      top: 100% !important;
      right: 0 !important;
      margin-top: 6px !important;
      min-width: 250px !important;
      background: rgba(10, 15, 28, 0.98) !important;
      backdrop-filter: blur(24px) !important;
      border: 1px solid rgba(0, 242, 254, 0.4) !important;
      border-radius: 12px !important;
      box-shadow: 0 12px 36px rgba(0, 0, 0, 0.85), 0 0 24px rgba(0, 242, 254, 0.2) !important;
      display: none !important;
      flex-direction: column !important;
      overflow: hidden !important;
      animation: hdFadeIn 0.15s ease-out !important;
    }
    @keyframes hdFadeIn {
      from { opacity: 0; transform: translateY(-4px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .hd-dropdown.show {
      display: flex !important;
    }
    .hd-dropdown-header {
      padding: 10px 14px !important;
      font-size: 11px !important;
      font-weight: 700 !important;
      text-transform: uppercase !important;
      letter-spacing: 0.6px !important;
      color: #94a3b8 !important;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08) !important;
      display: flex !important;
      justify-content: space-between !important;
      align-items: center !important;
    }
    .hd-quality-item {
      display: flex !important;
      align-items: center !important;
      justify-content: space-between !important;
      padding: 10px 14px !important;
      color: #f1f5f9 !important;
      font-size: 12px !important;
      font-weight: 600 !important;
      cursor: pointer !important;
      transition: background 0.15s ease, color 0.15s ease !important;
    }
    .hd-quality-item:hover {
      background: rgba(0, 242, 254, 0.15) !important;
      color: #00f2fe !important;
    }
    .hd-quality-item .hd-tag {
      font-size: 10px !important;
      font-weight: 700 !important;
      padding: 2px 6px !important;
      border-radius: 4px !important;
      background: rgba(255, 255, 255, 0.08) !important;
      color: #94a3b8 !important;
    }
    .hd-quality-item:hover .hd-tag {
      background: rgba(0, 242, 254, 0.25) !important;
      color: #00f2fe !important;
    }
    .hd-loading {
      padding: 16px !important;
      text-align: center !important;
      font-size: 12px !important;
      color: #94a3b8 !important;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      gap: 8px !important;
    }
    .hd-batch-btn {
      display: inline-flex !important;
      align-items: center !important;
      justify-content: center !important;
      width: 36px !important;
      height: 36px !important;
      min-width: 36px !important;
      min-height: 36px !important;
      max-width: 36px !important;
      max-height: 36px !important;
      background: rgba(8, 12, 22, 0.94) !important;
      backdrop-filter: blur(16px) !important;
      border: 1px solid rgba(0, 242, 254, 0.65) !important;
      border-radius: 0 !important;
      padding: 0 !important;
      cursor: pointer !important;
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.7), 0 0 10px rgba(0, 242, 254, 0.3) !important;
      transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1) !important;
      margin: 4px 8px 4px 50px !important;
      margin-left: 50px !important;
      vertical-align: middle !important;
      position: relative !important;
      box-sizing: border-box !important;
    }
    .hd-batch-btn:hover {
      background: rgba(14, 22, 42, 0.98) !important;
      border-color: #ffd700 !important;
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.85), 0 0 16px rgba(255, 215, 0, 0.6) !important;
      transform: translateY(-1px) scale(1.05) !important;
    }
    .hd-batch-btn:active {
      transform: scale(0.96) !important;
    }
    .hd-batch-btn svg,
    .hd-batch-btn img {
      width: 22px !important;
      height: 22px !important;
      pointer-events: none !important;
      display: block !important;
      filter: drop-shadow(0 0 6px rgba(255, 215, 0, 0.85)) !important;
    }
    .hd-hide-ep-input {
      display: none !important;
      visibility: hidden !important;
      opacity: 0 !important;
      pointer-events: none !important;
      width: 0 !important;
      height: 0 !important;
      margin: 0 !important;
      padding: 0 !important;
    }
    .hd-batch-overlay {
      position: fixed !important;
      inset: 0 !important;
      background: rgba(4, 7, 14, 0.78) !important;
      backdrop-filter: blur(14px) !important;
      z-index: 2147483647 !important;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      animation: hdFadeIn 0.2s ease-out !important;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
    }
    .hd-batch-dialog {
      background: rgba(10, 15, 28, 0.98) !important;
      backdrop-filter: blur(28px) !important;
      border: 1px solid rgba(0, 242, 254, 0.45) !important;
      border-radius: 16px !important;
      width: 520px !important;
      max-width: 95vw !important;
      box-shadow: 0 20px 50px rgba(0, 0, 0, 0.85), 0 0 30px rgba(0, 242, 254, 0.25) !important;
      padding: 24px !important;
      color: #f1f5f9 !important;
      display: flex !important;
      flex-direction: column !important;
      gap: 16px !important;
    }
    .hd-batch-header {
      display: flex !important;
      justify-content: space-between !important;
      align-items: center !important;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08) !important;
      padding-bottom: 12px !important;
    }
    .hd-batch-header h3 {
      margin: 0 !important;
      font-size: 15px !important;
      font-weight: 800 !important;
      color: #fff !important;
      display: flex !important;
      align-items: center !important;
      gap: 8px !important;
    }
    .hd-batch-close {
      background: none !important;
      border: none !important;
      color: #94a3b8 !important;
      font-size: 20px !important;
      cursor: pointer !important;
      line-height: 1 !important;
    }
    .hd-batch-close:hover {
      color: #fff !important;
    }
    .hd-batch-group {
      display: flex !important;
      flex-direction: column !important;
      gap: 6px !important;
    }
    .hd-batch-label {
      font-size: 11px !important;
      font-weight: 700 !important;
      text-transform: uppercase !important;
      letter-spacing: 0.6px !important;
      color: #94a3b8 !important;
    }
    .hd-batch-input {
      width: 100% !important;
      background: rgba(255, 255, 255, 0.06) !important;
      border: 1px solid rgba(255, 255, 255, 0.12) !important;
      border-radius: 8px !important;
      padding: 8px 12px !important;
      color: #fff !important;
      font-size: 13px !important;
      outline: none !important;
      box-sizing: border-box !important;
    }
    .hd-batch-input:focus {
      border-color: #00f2fe !important;
      box-shadow: 0 0 10px rgba(0, 242, 254, 0.3) !important;
    }
    .hd-batch-dest {
      display: flex !important;
      align-items: center !important;
      justify-content: space-between !important;
      background: rgba(255, 255, 255, 0.04) !important;
      border: 1px solid rgba(255, 255, 255, 0.1) !important;
      border-radius: 8px !important;
      padding: 8px 12px !important;
      gap: 10px !important;
    }
    .hd-batch-dest span {
      font-size: 12px !important;
      color: #cbd5e1 !important;
      overflow: hidden !important;
      text-overflow: ellipsis !important;
      white-space: nowrap !important;
    }
    .hd-batch-browse {
      background: rgba(0, 242, 254, 0.15) !important;
      border: 1px solid rgba(0, 242, 254, 0.4) !important;
      border-radius: 6px !important;
      color: #00f2fe !important;
      padding: 4px 10px !important;
      font-size: 11px !important;
      font-weight: 700 !important;
      cursor: pointer !important;
      white-space: nowrap !important;
    }
    .hd-batch-browse:hover {
      background: rgba(0, 242, 254, 0.25) !important;
    }
    .hd-batch-pills {
      display: flex !important;
      gap: 8px !important;
    }
    .hd-batch-pill {
      flex: 1 !important;
      text-align: center !important;
      padding: 7px 10px !important;
      border-radius: 8px !important;
      background: rgba(255, 255, 255, 0.05) !important;
      border: 1px solid rgba(255, 255, 255, 0.1) !important;
      color: #94a3b8 !important;
      font-size: 11px !important;
      font-weight: 700 !important;
      cursor: pointer !important;
      transition: all 0.15s ease !important;
    }
    .hd-batch-pill.active {
      background: rgba(0, 242, 254, 0.2) !important;
      border-color: #00f2fe !important;
      color: #00f2fe !important;
      box-shadow: 0 0 10px rgba(0, 242, 254, 0.25) !important;
    }
    .hd-batch-checkbox-row {
      display: flex !important;
      align-items: center !important;
      gap: 10px !important;
      background: rgba(0, 242, 254, 0.06) !important;
      border: 1px solid rgba(0, 242, 254, 0.25) !important;
      border-radius: 8px !important;
      padding: 10px 14px !important;
      cursor: pointer !important;
    }
    .hd-batch-checkbox-row input {
      accent-color: #00f2fe !important;
      width: 16px !important;
      height: 16px !important;
      cursor: pointer !important;
    }
    .hd-batch-checkbox-row label {
      font-size: 12px !important;
      font-weight: 600 !important;
      color: #f1f5f9 !important;
      cursor: pointer !important;
    }
    .hd-batch-actions {
      display: flex !important;
      justify-content: flex-end !important;
      gap: 10px !important;
      margin-top: 6px !important;
    }
    .hd-batch-btn-cancel {
      background: rgba(255, 255, 255, 0.06) !important;
      border: 1px solid rgba(255, 255, 255, 0.12) !important;
      border-radius: 8px !important;
      padding: 8px 16px !important;
      color: #94a3b8 !important;
      font-size: 12px !important;
      font-weight: 600 !important;
      cursor: pointer !important;
    }
    .hd-batch-btn-start {
      background: linear-gradient(135deg, #00f2fe, #0099ff) !important;
      border: none !important;
      border-radius: 8px !important;
      padding: 8px 18px !important;
      color: #050a14 !important;
      font-size: 12px !important;
      font-weight: 800 !important;
      cursor: pointer !important;
      display: flex !important;
      align-items: center !important;
      gap: 6px !important;
      box-shadow: 0 4px 14px rgba(0, 242, 254, 0.35) !important;
    }
    .hd-batch-progress-bar-bg {
      width: 100% !important;
      height: 10px !important;
      background: rgba(255, 255, 255, 0.12) !important;
      border-radius: 999px !important;
      overflow: hidden !important;
      margin-top: 10px !important;
      border: 1px solid rgba(255, 255, 255, 0.08) !important;
    }
    .hd-batch-progress-bar-fill {
      height: 100% !important;
      background: linear-gradient(90deg, #00f2fe, #05df72) !important;
      width: 0%;
      min-width: 0%;
      transition: width 0.3s ease !important;
      border-radius: 999px !important;
      box-shadow: 0 0 12px rgba(0, 242, 254, 0.6) !important;
    }
  `;
  (document.head || document.documentElement).appendChild(style);

  // Toggle floating video panel visibility
  let showFloatingButton = true;
  function updateFloatingVisibility(visible) {
    showFloatingButton = visible;
    if (visible) {
      document.documentElement.classList.remove("hd-hide-panels");
      if (document.body) document.body.classList.remove("hd-hide-panels");
    } else {
      document.documentElement.classList.add("hd-hide-panels");
      if (document.body) document.body.classList.add("hd-hide-panels");
    }
  }

  if (chrome.storage && chrome.storage.local) {
    chrome.storage.local.get({ show_floating_button: true }, (items) => {
      updateFloatingVisibility(items.show_floating_button !== false);
    });
  }

  // 2. Real-time media streams detected by background sniffer
  let sniffedStreams = [];
  let currentNavUrl = window.location.href;
  function handleSpaNavigation() {
    const freshUrl = window.location.href;
    if (freshUrl !== currentNavUrl) {
      currentNavUrl = freshUrl;
      setTimeout(attachVideoPanels, 300);
    }
  }

  // Intercept history.pushState and history.replaceState for instant SPA router detection
  const _origPush = history.pushState;
  history.pushState = function () {
    _origPush.apply(this, arguments);
    setTimeout(handleSpaNavigation, 50);
  };

  const _origReplace = history.replaceState;
  history.replaceState = function () {
    _origReplace.apply(this, arguments);
    setTimeout(handleSpaNavigation, 50);
  };

  window.addEventListener("popstate", handleSpaNavigation);
  window.addEventListener("hashchange", handleSpaNavigation);
  setInterval(handleSpaNavigation, 800);

  function getAccurateMediaTitle() {
    // 1. Check for active anime episode button (HiAnime, Zoro, etc.)
    const activeEp = document.querySelector(".ep-item.active, .ss-item.active, .ssl-item.ep-item.active, a.active.ep-item");
    let epNumber = "";
    if (activeEp) {
      epNumber = activeEp.getAttribute("data-number") || activeEp.textContent.trim();
    }

    const filmNameEl = document.querySelector(".film-name, h2.film-name, .anime-title");
    const filmName = filmNameEl ? filmNameEl.textContent.trim() : "";

    if (filmName && epNumber) {
      return `${filmName} Episode ${epNumber}`;
    }

    // 2. Clean document.title
    let t = (document.title || "Video").trim();
    t = t.replace(/\s*-\s*YouTube/i, "")
         .replace(/^Watch\s+/i, "")
         .replace(/\s+English Sub\/Dub.*$/i, "")
         .replace(/\s+online Free on.*$/i, "")
         .replace(/\s+online Free.*$/i, "")
         .trim();
    return t || "Video";
  }

  function getAccurateSeriesName() {
    const filmNameEl = document.querySelector(".film-name, h2.film-name, .anime-title, .dynamic-name");
    let filmName = filmNameEl ? filmNameEl.textContent.trim() : "";
    if (filmName) return filmName;

    // Check breadcrumb
    const bcItems = document.querySelectorAll(".breadcrumb-item, .breadcrumb li, .breadcrumb a");
    if (bcItems && bcItems.length > 0) {
      for (let i = bcItems.length - 1; i >= 0; i--) {
        const txt = (bcItems[i].textContent || "").trim();
        if (txt && !txt.toLowerCase().includes("watching") && !txt.toLowerCase().includes("home") && !txt.toLowerCase().includes("tv")) {
          return txt;
        }
      }
    }

    let t = (document.title || "Series").trim();
    t = t.replace(/\s*-\s*YouTube/i, "")
         .replace(/^Watch\s+/i, "")
         .replace(/\s+English Sub\/Dub.*$/i, "")
         .replace(/\s+online Free on.*$/i, "")
         .replace(/\s+online Free.*$/i, "")
         .replace(/Episode\s+\d+.*/i, "")
         .trim();
    return t || "Series";
  }

  function getServerRows() {
    const result = {
      sub: { row: null, btn: null, active: false },
      dub: { row: null, btn: null, active: false }
    };

    function isElActive(el) {
      if (!el) return false;
      if (el.classList.contains("active") || 
          el.classList.contains("show") || 
          el.classList.contains("btn-primary") ||
          el.getAttribute("aria-expanded") === "true" ||
          el.getAttribute("aria-pressed") === "true" ||
          el.getAttribute("aria-selected") === "true") {
        return true;
      }
      try {
        const cs = window.getComputedStyle(el);
        const bg = cs.backgroundColor || "";
        // HiAnime/Anikoko pink accent: rgb(255, 186, 218), rgb(255, 177, 217), etc.
        if (bg.startsWith("rgb(255") && !bg.includes("255, 255, 255")) return true;
        const c = cs.color || "";
        if ((c === "rgb(0, 0, 0)" || c === "rgb(17, 17, 17)" || c === "rgb(24, 24, 27)") && 
            bg && !bg.includes("rgba(0, 0, 0, 0)") && !bg.includes("transparent") && !bg.includes("0, 0, 0")) {
          return true;
        }
      } catch(e) {}
      return false;
    }

    // 1. Direct class check
    const directSub = document.querySelector(".servers-sub, .ps__-block-sub, [data-type='sub']");
    const directDub = document.querySelector(".servers-dub, .ps__-block-dub, [data-type='dub']");

    if (directSub) result.sub.row = directSub;
    if (directDub) result.dub.row = directDub;

    // 2. Strict leaf label scan (e.g. "SUB:", "CC SUB:", "DUB:")
    const leafNodes = Array.from(document.querySelectorAll("span, strong, b, div, label, .ps__-title, .server-title, .server-notice"));
    for (const el of leafNodes) {
      if (el.children.length > 3) continue;
      const rawTxt = (el.textContent || "").trim();
      const txt = rawTxt.toUpperCase();
      if (txt.length > 25) continue;

      // SUB label (allows "CC SUB:", "SUB:", but strictly forbids DUB, DL, KIWI)
      if (!result.sub.row && /\bSUB\b/i.test(txt) && !/\bDUB\b/i.test(txt) && !/\bDL\b/i.test(txt) && !/KIWI/i.test(txt)) {
        let curr = el;
        let bestRow = null;
        while (curr && curr !== document.body && curr !== document.documentElement) {
          const parent = curr.parentElement;
          if (!parent) break;
          const pTxt = parent.textContent.toUpperCase();
          if (/\bDUB\s*:/i.test(pTxt)) {
            bestRow = curr;
            break;
          }
          if (parent.querySelector(".item, .server-item, .btn, a, button, [data-id]")) {
            bestRow = parent;
          }
          curr = parent;
        }
        result.sub.row = bestRow || el.parentElement;
      }

      // DUB label (allows "DUB:", "DUB", but strictly forbids SUB, DL, KIWI)
      if (!result.dub.row && /\bDUB\b/i.test(txt) && !/\bSUB\b/i.test(txt) && !/\bDL\b/i.test(txt) && !/KIWI/i.test(txt)) {
        let curr = el;
        let bestRow = null;
        while (curr && curr !== document.body && curr !== document.documentElement) {
          const parent = curr.parentElement;
          if (!parent) break;
          const pTxt = parent.textContent.toUpperCase();
          if (/\bSUB\s*:/i.test(pTxt)) {
            bestRow = curr;
            break;
          }
          if (parent.querySelector(".item, .server-item, .btn, a, button, [data-id]")) {
            bestRow = parent;
          }
          curr = parent;
        }
        result.dub.row = bestRow || el.parentElement;
      }
    }

    // 3. Resolve the primary button & active state for Sub and Dub
    for (const key of ["sub", "dub"]) {
      const entry = result[key];
      if (!entry.row) continue;

      const buttons = Array.from(entry.row.querySelectorAll(".item, .server-item, .btn, [data-id], [data-server-id], a, button")).filter((b) => {
        const href = b.getAttribute("href");
        if (href && (href === "/" || href === "/home" || href.endsWith("/home"))) return false;
        const bTxt = (b.textContent || "").trim().toUpperCase();
        if (bTxt === "SUB:" || bTxt === "DUB:" || bTxt === "DL:" || bTxt === "SUB" || bTxt === "DUB") return false;
        return true;
      });

      if (buttons.length > 0) {
        let targetBtn = buttons[0];
        const zoko = buttons.find((b) => /zoko/i.test(b.textContent));
        if (zoko) targetBtn = zoko;
        entry.btn = targetBtn;

        for (const b of buttons) {
          if (isElActive(b)) {
            entry.active = true;
            break;
          }
        }
      }
    }

    return result;
  }

  function getAvailableServices() {
    const rows = getServerRows();
    const list = [];
    if (rows.sub.row || rows.sub.btn) list.push("Sub");
    if (rows.dub.row || rows.dub.btn) list.push("Dub");
    return list.length > 0 ? list : ["Sub", "Dub"];
  }

  function detectServerAudioType() {
    const rows = getServerRows();
    if (rows.dub.active) return "Dub";
    if (rows.sub.active) return "Sub";
    return "Sub";
  }

  function switchServerOnPage(serviceType) {
    if (!serviceType) return false;
    const target = serviceType.toLowerCase().trim();
    if (target !== "sub" && target !== "dub") return false;
    const rows = getServerRows();
    const entry = rows[target];

    function triggerClick(el) {
      if (!el) return;
      const href = el.getAttribute("href");
      if (href && (href === "/" || href === "/home" || href.endsWith("/home"))) return;

      const innerClickable = el.querySelector("a, button, .btn") || el;
      const targetEl = (innerClickable && !innerClickable.getAttribute("href")?.endsWith("/home")) ? innerClickable : el;

      try { targetEl.focus(); } catch(e) {}
      try {
        const opts = { bubbles: true, cancelable: true, view: window, composed: true };
        targetEl.dispatchEvent(new PointerEvent("pointerdown", opts));
        targetEl.dispatchEvent(new MouseEvent("mousedown", opts));
        targetEl.dispatchEvent(new PointerEvent("pointerup", opts));
        targetEl.dispatchEvent(new MouseEvent("mouseup", opts));
        targetEl.dispatchEvent(new MouseEvent("click", opts));
      } catch(e) {}
      try {
        targetEl.click();
      } catch(e) {}

      if (targetEl !== el) {
        try { el.click(); } catch(e) {}
      }
    }

    if (entry && entry.btn) {
      triggerClick(entry.btn);
      return true;
    }

    return false;
  }

  function getDetectedEpisodes() {
    const elements = Array.from(document.querySelectorAll(
      ".ep-item, .ss-item, .ssl-item.ep-item, a.ep-item, .episodes-ul a, [data-number]"
    ));
    const epMap = new Map();
    elements.forEach((el) => {
      const numAttr = el.getAttribute("data-number");
      let num = 0;
      if (numAttr) {
        num = parseInt(numAttr, 10);
      } else {
        const txt = el.textContent.trim().replace(/^Episode\s+/i, "").replace(/^Ep\s+/i, "");
        num = parseInt(txt, 10);
      }
      if (!isNaN(num) && num > 0 && !epMap.has(num)) {
        epMap.set(num, {
          number: num,
          element: el,
          title: el.getAttribute("title") || `Episode ${num}`
        });
      }
    });
    const result = Array.from(epMap.values());
    result.sort((a, b) => a.number - b.number);
    return result;
  }

  function attachBatchEpisodeButton() {
    // 1. Safely hide ONLY the glitchy "Number of Ep" input itself (without hiding any parent container)
    const epSearchInputs = document.querySelectorAll(
      'input[placeholder*="Number of Ep" i], input[placeholder="Number of Ep"]'
    );
    epSearchInputs.forEach((inp) => {
      inp.classList.add("hd-hide-ep-input");
      inp.style.setProperty("display", "none", "important");
    });

    if (document.querySelector(".hd-batch-btn")) return;
    const episodes = getDetectedEpisodes();
    if (episodes.length <= 1) return;

    // 2. Locate placement position
    const epSearch = document.querySelector('input[placeholder*="Number of Ep" i], input[placeholder="Number of Ep"]');
    let targetContainer = null;
    let insertBeforeEl = null;

    if (epSearch && epSearch.parentElement) {
      targetContainer = epSearch.parentElement;
      insertBeforeEl = epSearch;
    }

    if (!targetContainer) {
      const headers = Array.from(document.querySelectorAll("h2, h3, h4, h5, div, span, .item-head, .episodes-header, .nl-item, .anisc-detail"));
      for (const h of headers) {
        const txt = (h.textContent || "").trim().toLowerCase();
        if (txt.includes("list of episodes") || txt.startsWith("episodes")) {
          targetContainer = h;
          break;
        }
      }
    }

    if (!targetContainer && episodes[0] && episodes[0].element) {
      const epParent = episodes[0].element.closest(".episodes-ul, .ss-list, #episodes-page-1, .ss-item-list") || episodes[0].element.parentElement;
      if (epParent && epParent.parentElement) {
        targetContainer = epParent.parentElement;
        insertBeforeEl = epParent;
      }
    }

    if (targetContainer && !targetContainer.querySelector(".hd-batch-btn")) {
      const btn = document.createElement("button");
      btn.className = "hd-batch-btn";
      btn.type = "button";
      btn.title = `⚡ HyperDrain — Download All (${episodes.length} Episodes)`;
      btn.setAttribute("aria-label", `Download All (${episodes.length} Episodes) in a ZIP Archive`);

      btn.innerHTML = `
        <svg width="22" height="22" viewBox="0 0 24 24" fill="url(#hd-batch-bolt-gold)" stroke="#ffe066" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" style="display: block; pointer-events: none; filter: drop-shadow(0 0 6px rgba(255, 204, 0, 0.9));">
          <defs>
            <linearGradient id="hd-batch-bolt-gold" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stop-color="#fff59d"/>
              <stop offset="45%" stop-color="#ffd700"/>
              <stop offset="100%" stop-color="#ff9100"/>
            </linearGradient>
          </defs>
          <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
        </svg>
      `;

      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        openBatchModal();
      });

      if (insertBeforeEl && insertBeforeEl.parentElement === targetContainer) {
        targetContainer.insertBefore(btn, insertBeforeEl);
      } else {
        targetContainer.appendChild(btn);
      }
    }
  }

  function waitForStreamUpdate(previousUrl, timeoutMs = 3500) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (s) => {
        if (!done) {
          done = true;
          window.removeEventListener("hd_stream_detected", onEvent);
          clearInterval(poll);
          clearTimeout(tmr);
          resolve(s);
        }
      };

      const onEvent = () => {
        if (sniffedStreams.length > 0 && sniffedStreams[0].url !== previousUrl) {
          finish(sniffedStreams[0]);
        }
      };

      window.addEventListener("hd_stream_detected", onEvent);

      const poll = setInterval(() => {
        if (sniffedStreams.length > 0 && sniffedStreams[0].url !== previousUrl) {
          finish(sniffedStreams[0]);
        }
      }, 200);

      const tmr = setTimeout(() => {
        finish(sniffedStreams.length > 0 ? sniffedStreams[0] : null);
      }, timeoutMs);
    });
  }

  function openBatchModal() {
    const existing = document.querySelector(".hd-batch-overlay");
    if (existing) existing.remove();

    const episodes = getDetectedEpisodes();
    if (episodes.length === 0) {
      alert("No episodes detected on this page.");
      return;
    }

    const seriesName = getAccurateSeriesName();
    let defaultDir = "";
    if (chrome.storage && chrome.storage.local) {
      chrome.storage.local.get(["last_target_dir"], (res) => {
        if (res && res.last_target_dir) {
          defaultDir = res.last_target_dir;
          const dirEl = document.getElementById("hd-batch-dir-txt");
          if (dirEl) dirEl.textContent = defaultDir;
        }
      });
    }

    let selectedQuality = "1080p";
    const availableServices = getAvailableServices();
    let detectedServer = detectServerAudioType();
    let selectedServer = availableServices.includes(detectedServer) ? detectedServer : availableServices[0];
    let isAborted = false;

    const servicePillsHtml = availableServices.map((srv) => {
      const isActive = srv.toLowerCase() === selectedServer.toLowerCase() ? " active" : "";
      return `<div class="hd-batch-pill${isActive}" data-server="${srv}">${srv}</div>`;
    }).join("");

    const overlay = document.createElement("div");
    overlay.className = "hd-batch-overlay";
    overlay.innerHTML = `
      <div class="hd-batch-dialog">
        <div class="hd-batch-header">
          <h3>
            <span class="hd-bolt">⚡</span>
            <span>HyperDrain Batch Downloader</span>
          </h3>
          <button class="hd-batch-close" type="button">&times;</button>
        </div>

        <div id="hd-batch-setup-view" style="display: flex; flex-direction: column; gap: 14px;">
          <div class="hd-batch-group">
            <label class="hd-batch-label">Series Title</label>
            <input type="text" id="hd-batch-title" class="hd-batch-input" value="${seriesName}" spellcheck="false" />
          </div>

          <div class="hd-batch-group">
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <label class="hd-batch-label">Episode Range (${episodes.length} Total)</label>
              <span id="hd-batch-selected-count" style="font-size: 11px; color: #00f2fe; font-weight: 700;">All ${episodes.length} Selected</span>
            </div>
            <div style="display: flex; gap: 10px; align-items: center;">
              <span style="font-size: 12px; color: #94a3b8;">From Ep:</span>
              <input type="number" id="hd-batch-from" class="hd-batch-input" style="width: 70px; text-align: center;" value="${episodes[0].number}" min="${episodes[0].number}" max="${episodes[episodes.length - 1].number}" />
              <span style="font-size: 12px; color: #94a3b8;">To Ep:</span>
              <input type="number" id="hd-batch-to" class="hd-batch-input" style="width: 70px; text-align: center;" value="${episodes[episodes.length - 1].number}" min="${episodes[0].number}" max="${episodes[episodes.length - 1].number}" />
              <button type="button" id="hd-batch-all-btn" class="hd-batch-browse" style="padding: 6px 12px;">Select All</button>
            </div>
          </div>

          <div class="hd-batch-group">
            <label class="hd-batch-label">Audio / Server</label>
            <div class="hd-batch-pills" id="hd-batch-server-pills">
              ${servicePillsHtml}
            </div>
          </div>

          <div class="hd-batch-group">
            <label class="hd-batch-label">Video Quality</label>
            <div class="hd-batch-pills" id="hd-batch-quality-pills">
              <div class="hd-batch-pill active" data-quality="1080p">1080p Full HD ★</div>
              <div class="hd-batch-pill" data-quality="720p">720p HD</div>
              <div class="hd-batch-pill" data-quality="360p">360p Small</div>
              <div class="hd-batch-pill" data-quality="ba/bestaudio">Audio (MP3)</div>
            </div>
          </div>

          <div class="hd-batch-group">
            <label class="hd-batch-label">Destination Folder</label>
            <div class="hd-batch-dest">
              <span id="hd-batch-dir-txt">${defaultDir || "Default HyperDrain Downloads"}</span>
              <button type="button" id="hd-batch-browse-btn" class="hd-batch-browse">Browse...</button>
            </div>
          </div>

          <label class="hd-batch-checkbox-row">
            <input type="checkbox" id="hd-batch-autozip" />
            <label for="hd-batch-autozip">📦 Bundle episodes into a single <strong>.zip</strong> archive when complete (optional)</label>
          </label>

          <div class="hd-batch-actions">
            <button type="button" class="hd-batch-btn-cancel" id="hd-batch-cancel-btn">Cancel</button>
            <button type="button" class="hd-batch-btn-start" id="hd-batch-start-btn">
              <span class="hd-bolt">⚡</span>
              <span>Start Batch Download</span>
            </button>
          </div>
        </div>

        <div id="hd-batch-progress-view" style="display: none; flex-direction: column; gap: 14px; text-align: center; padding: 12px 0;">
          <div style="font-size: 28px;">⚡</div>
          <div id="hd-batch-prog-title" style="font-size: 14px; font-weight: 700; color: #fff;">Resolving episode streams...</div>
          <div id="hd-batch-prog-subtitle" style="font-size: 12px; color: #94a3b8;">Episode 1 of ${episodes.length}</div>
          <div class="hd-batch-progress-bar-bg">
            <div id="hd-batch-prog-bar" class="hd-batch-progress-bar-fill"></div>
          </div>
          <div style="display: flex; justify-content: center; margin-top: 10px;">
            <button type="button" class="hd-batch-btn-cancel" id="hd-batch-abort-btn">Abort Scan</button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const closeBtn = overlay.querySelector(".hd-batch-close");
    const cancelBtn = overlay.querySelector("#hd-batch-cancel-btn");
    const abortBtn = overlay.querySelector("#hd-batch-abort-btn");
    const startBtn = overlay.querySelector("#hd-batch-start-btn");
    const fromInput = overlay.querySelector("#hd-batch-from");
    const toInput = overlay.querySelector("#hd-batch-to");
    const allBtn = overlay.querySelector("#hd-batch-all-btn");
    const countLabel = overlay.querySelector("#hd-batch-selected-count");
    const browseBtn = overlay.querySelector("#hd-batch-browse-btn");
    const dirTxt = overlay.querySelector("#hd-batch-dir-txt");
    const titleInput = overlay.querySelector("#hd-batch-title");
    const autoZipCheckbox = overlay.querySelector("#hd-batch-autozip");
    const qualityPills = overlay.querySelectorAll("#hd-batch-quality-pills .hd-batch-pill");
    const serverPills = overlay.querySelectorAll("#hd-batch-server-pills .hd-batch-pill");

    function setServer(srv, triggerPageSwitch = false) {
      selectedServer = srv;
      serverPills.forEach((p) => {
        const val = p.getAttribute("data-server");
        p.classList.toggle("active", val.toLowerCase() === srv.toLowerCase());
      });
      if (triggerPageSwitch) {
        switchServerOnPage(srv);
      }
    }

    setServer(selectedServer, false);

    serverPills.forEach((p) => {
      p.addEventListener("click", () => {
        const val = p.getAttribute("data-server");
        setServer(val, true);
      });
    });

    const setupView = overlay.querySelector("#hd-batch-setup-view");
    const progView = overlay.querySelector("#hd-batch-progress-view");
    const progBar = overlay.querySelector("#hd-batch-prog-bar");
    const progTitle = overlay.querySelector("#hd-batch-prog-title");
    const progSubtitle = overlay.querySelector("#hd-batch-prog-subtitle");

    function updateCount() {
      const f = parseInt(fromInput.value, 10) || 1;
      const t = parseInt(toInput.value, 10) || episodes[episodes.length - 1].number;
      const count = Math.max(0, t - f + 1);
      countLabel.textContent = `${count} Episode${count === 1 ? '' : 's'} Selected`;
    }

    fromInput.addEventListener("input", updateCount);
    toInput.addEventListener("input", updateCount);
    allBtn.addEventListener("click", () => {
      fromInput.value = episodes[0].number;
      toInput.value = episodes[episodes.length - 1].number;
      updateCount();
    });

    qualityPills.forEach((p) => {
      p.addEventListener("click", () => {
        qualityPills.forEach((el) => el.classList.remove("active"));
        p.classList.add("active");
        selectedQuality = p.getAttribute("data-quality");
        if (chrome.storage && chrome.storage.local) {
          chrome.storage.local.set({ last_selected_quality: selectedQuality });
        }
      });
    });

    if (chrome.storage && chrome.storage.local) {
      chrome.storage.local.get(["last_selected_quality"], (res) => {
        if (res && res.last_selected_quality) {
          selectedQuality = res.last_selected_quality;
          qualityPills.forEach((el) => {
            el.classList.toggle("active", el.getAttribute("data-quality") === selectedQuality);
          });
        }
      });
    }

    browseBtn.addEventListener("click", async () => {
      browseBtn.disabled = true;
      browseBtn.textContent = "Choosing...";
      try {
        const res = await fetch("http://127.0.0.1:6880/api/choose-folder", {
          method: "POST",
          headers: { "X-HyperDrain-Token": "hyperdrain_secret_token" }
        });
        if (res.ok) {
          const data = await res.json();
          if (!data.cancelled && data.path) {
            defaultDir = data.path;
            dirTxt.textContent = defaultDir;
            if (chrome.storage && chrome.storage.local) {
              chrome.storage.local.set({ last_target_dir: defaultDir });
            }
          }
        }
      } catch (err) {
        console.warn("Folder chooser error:", err);
      } finally {
        browseBtn.disabled = false;
        browseBtn.textContent = "Browse...";
        window.focus();
      }
    });

    const closeModal = () => {
      isAborted = true;
      overlay.remove();
    };

    closeBtn.addEventListener("click", closeModal);
    cancelBtn.addEventListener("click", closeModal);
    abortBtn.addEventListener("click", closeModal);

    startBtn.addEventListener("click", async () => {
      const fromEp = parseInt(fromInput.value, 10) || 1;
      const toEp = parseInt(toInput.value, 10) || episodes[episodes.length - 1].number;
      const selectedEps = episodes.filter((e) => e.number >= fromEp && e.number <= toEp);

      if (selectedEps.length === 0) {
        alert("Please select at least 1 valid episode.");
        return;
      }

      const finalTitle = titleInput.value.trim() || seriesName;
      const autoZip = (selectedEps.length > 1) && Boolean(autoZipCheckbox && autoZipCheckbox.checked);

      let finalAudioType = selectedServer;

      setupView.style.display = "none";
      progView.style.display = "flex";

      // Save currently active episode element to restore later
      const initialActive = document.querySelector(".ep-item.active, .ss-item.active, .ssl-item.ep-item.active, a.active.ep-item");

      const resolvedItems = [];
      let lastKnownStreamUrl = sniffedStreams.length > 0 ? sniffedStreams[0].url : "";

      for (let i = 0; i < selectedEps.length; i++) {
        if (isAborted) break;

        const ep = selectedEps[i];
        const pct = Math.max(3, Math.round(((i + 1) / selectedEps.length) * 100));
        progBar.style.setProperty("width", `${pct}%`, "important");
        progBar.style.width = `${pct}%`;
        progTitle.textContent = `Resolving Episode ${ep.number}...`;
        progSubtitle.textContent = `Episode ${i + 1} of ${selectedEps.length} (${pct}%)`;

        // Programmatically trigger episode switch
        if (ep.element) {
          ep.element.click();
        }

        // Actively enforce the user's selected audio server on the player
        if (finalAudioType) {
          await new Promise((r) => setTimeout(r, 200));
          switchServerOnPage(finalAudioType);
        }

        // Wait for player to load and sniffer to capture new .m3u8 stream
        const detected = await waitForStreamUpdate(lastKnownStreamUrl, 3200);
        let streamUrl = "";
        let streamReferer = window.location.href;
        let streamOrigin = window.location.origin;
        let streamCookie = document.cookie || "";

        if (detected && detected.url) {
          streamUrl = detected.master_url || detected.url;
          if (detected.referer) streamReferer = detected.referer;
          if (detected.origin) streamOrigin = detected.origin;
          if (detected.cookie) streamCookie = detected.cookie;
          lastKnownStreamUrl = detected.url;
        } else if (sniffedStreams.length > 0) {
          streamUrl = sniffedStreams[0].master_url || sniffedStreams[0].url;
          if (sniffedStreams[0].referer) streamReferer = sniffedStreams[0].referer;
          if (sniffedStreams[0].origin) streamOrigin = sniffedStreams[0].origin;
          if (sniffedStreams[0].cookie) streamCookie = sniffedStreams[0].cookie;
        }

        if (streamUrl) {
          resolvedItems.push({
            episode_num: ep.number.toString(),
            title: `${finalTitle} Episode ${ep.number}`,
            url: streamUrl,
            referer: streamReferer,
            origin: streamOrigin,
            cookie: streamCookie,
            user_agent: navigator.userAgent
          });
        }
      }

      if (isAborted) {
        if (initialActive) initialActive.click();
        return;
      }

      progBar.style.setProperty("width", "100%", "important");
      progBar.style.width = "100%";
      progTitle.textContent = "Dispatching to HyperDrain Engine ⚡";
      progSubtitle.textContent = `Starting ${resolvedItems.length} parallel accelerated downloads...`;

      // Restore user's player view to original episode
      if (initialActive) {
        try { initialActive.click(); } catch(e) {}
      }

      if (resolvedItems.length === 0) {
        alert("Could not resolve any video streams. Please check video playback and try again.");
        overlay.remove();
        return;
      }

      try {
        const res = await fetch("http://127.0.0.1:6880/api/download-stream-batch", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-HyperDrain-Token": "hyperdrain_secret_token"
          },
          body: JSON.stringify({
            series_title: finalTitle,
            target_dir: defaultDir,
            format_id: selectedQuality,
            audio_type: finalAudioType,
            auto_zip: autoZip,
            connections: 32,
            episodes: resolvedItems
          })
        });

        if (res.ok) {
          const data = await res.json();
          overlay.remove();
          try {
            chrome.runtime.sendMessage({
              action: "show_notification",
              title: autoZip ? "HyperDrain ⚡ ZIP Batch Download Started" : "HyperDrain ⚡ Download Started",
              message: autoZip
                ? `Downloading ${finalTitle} in an accelerated ZIP archive.`
                : `Downloading ${finalTitle} directly to HyperDrain Desktop App.`
            });
          } catch(e) {}
        } else {
          alert(`HyperDrain engine responded with error: ${res.status}`);
          overlay.remove();
        }
      } catch (err) {
        alert("Failed to connect to HyperDrain engine (127.0.0.1:6880)");
        overlay.remove();
      }
    });
  }

  try {
    chrome.runtime.sendMessage({ action: "get_detected_streams" }, (res) => {
      if (res && res.streams && res.streams.length > 0) {
        sniffedStreams = res.streams;
        attachVideoPanels();
      }
    });
  } catch (e) {}

  chrome.runtime.onMessage.addListener((request) => {
    if (request.action === "toggle_floating_button") {
      updateFloatingVisibility(request.enabled !== false);
    } else if (request.action === "page_navigated") {
      sniffedStreams = [];
      document.querySelectorAll(".hd-quality-list").forEach((ql) => {
        ql.innerHTML = '<div class="hd-loading">Detecting new episode streams...</div>';
      });
    } else if (request.action === "stream_detected" && request.stream) {
      sniffedStreams = sniffedStreams.filter((s) => s.url !== request.stream.url);
      sniffedStreams.unshift(request.stream);
      attachVideoPanels();
      document.querySelectorAll(".hd-dropdown.show").forEach((dd) => {
        const panel = dd.closest(".hd-video-panel");
        if (panel && panel._renderQuality) {
          panel._renderQuality();
        }
      });
      window.dispatchEvent(new CustomEvent("hd_stream_detected"));
    }
  });

  // 3. Video & Player Observer
  function attachVideoPanels() {
    const rawTargets = [];
    const isYouTube = window.location.hostname.includes("youtube.com");

    if (isYouTube) {
      // On YouTube, attach exclusively to the active video player container
      const ytPlayer = document.getElementById("movie_player") || document.querySelector(".html5-video-player");
      if (ytPlayer && !rawTargets.includes(ytPlayer)) {
        rawTargets.push(ytPlayer);
      }
    } else {
      // A. Direct HTML5 videos
      document.querySelectorAll("video").forEach((v) => {
        const c =
          v.closest(
            ".jwplayer, #player, .artplayer, .dplayer, .html5-video-player, ytd-player, #movie_player, .video-player, .player-container, #player-wrapper"
          ) || v.parentElement;
        if (c && !rawTargets.includes(c)) rawTargets.push(c);
      });

      // B. Embedded video player iframes (HiAnime, MegaCloud, RapidCloud, etc.)
      document
        .querySelectorAll(
          'iframe[src*="embed"], iframe[src*="cloud"], iframe[src*="stream"], iframe[src*="player"], iframe[src*="anime"], iframe#player, .player-container iframe, #player-wrapper iframe, .video-player iframe, #megacloud-player iframe'
        )
        .forEach((iframe) => {
          const c =
            iframe.closest(
              ".player-container, #player-wrapper, #player, .video-player, #megacloud-player"
            ) || iframe.parentElement;
          if (c && !rawTargets.includes(c)) rawTargets.push(c);
        });

      // C. Common anime player wrapper containers
      document
        .querySelectorAll(
          "#player-wrapper, .player-container, #megacloud-player, .jwplayer, .video-player"
        )
        .forEach((w) => {
          if (w && !rawTargets.includes(w) && (w.querySelector("iframe, video") || sniffedStreams.length > 0)) {
            rawTargets.push(w);
          }
        });
    }

    // Deduplicate: filter out nested containers so only one clean button is rendered
    const targets = [];
    rawTargets.forEach((t) => {
      if (!targets.some((existing) => existing === t || existing.contains(t) || t.contains(existing))) {
        targets.push(t);
      }
    });

    targets.forEach((container) => {
      if (!container || container.querySelector(".hd-video-panel")) return;

      container.classList.add("hd-has-panel");

      const computed = window.getComputedStyle(container);
      if (computed.position === "static") {
        container.style.position = "relative";
      }

      const panel = document.createElement("div");
      panel.className = "hd-video-panel";
      panel.innerHTML = `
        <button class="hd-panel-btn" type="button" title="Download this video with HyperDrain">
          <span class="hd-bolt">⚡</span>
          <span>Download this video</span>
          <span class="hd-arrow">▼</span>
        </button>
        <div class="hd-dropdown">
          <div class="hd-dropdown-header">
            <span>Available Streams</span>
          </div>
          <div class="hd-quality-list">
            <div class="hd-loading">Detecting streams...</div>
          </div>
        </div>
      `;

      const btn = panel.querySelector(".hd-panel-btn");
      const dropdown = panel.querySelector(".hd-dropdown");
      const qualityList = panel.querySelector(".hd-quality-list");

      function renderQualityOptions() {
        qualityList.innerHTML = "";
        let itemsAdded = 0;

        // 1. If on YouTube, immediately provide fast standard quality presets
        if (isYouTube) {
          const ytPresets = [
            { label: "1080p Full HD ★", id: "1080p", tag: "1080P" },
            { label: "720p HD", id: "720p", tag: "720P" },
            { label: "360p Small", id: "360p", tag: "360P" },
            { label: "Audio Only (MP3)", id: "ba/bestaudio", tag: "AUDIO" }
          ];

          ytPresets.forEach((preset) => {
            const item = document.createElement("div");
            item.className = "hd-quality-item";
            item.innerHTML = `
              <span>${preset.tag === "AUDIO" ? "🎵" : "🎬"} ${preset.label}</span>
              <span class="hd-tag">${preset.tag}</span>
            `;
            item.addEventListener("click", (evt) => {
              evt.stopPropagation();
              dropdown.classList.remove("show");
              btn.classList.remove("active");
              const pageTitle = (document.title || "YouTube Video").replace(" - YouTube", "").trim();
              chrome.runtime.sendMessage({
                action: "download_stream_video",
                url: window.location.href,
                format_id: preset.id,
                title: pageTitle,
                referer: window.location.href,
                origin: window.location.origin,
                cookie: document.cookie || ""
              });
            });
            qualityList.appendChild(item);
            itemsAdded++;
          });
        }

        // 2. Render real-time sniffed streams with explicit quality selections
        const validStreams = sniffedStreams.filter((stream) => {
          if (!stream || !stream.url) return false;
          const u = stream.url.toLowerCase();
          // Never treat single HLS/DASH fragment slices as whole streams
          if (
            /\.(ts|m4s|m4f|key)(\?.*)?$/i.test(u) ||
            u.includes("/seg_") ||
            u.includes("/seg-") ||
            u.includes("segment-") ||
            u.includes("segment_") ||
            u.includes("-frag") ||
            u.includes("/frag_") ||
            u.includes("/frag-") ||
            u.includes("/chunk-") ||
            u.includes("/chunk_") ||
            /\/(?:init|main|seg|chunk|frag)[^/?#]*\.mp4/i.test(u)
          ) {
            return false;
          }
          if (
            u.includes("/api/") ||
            u.includes("/ajax/") ||
            u.includes("/theme/") ||
            u.includes("/episodes/") ||
            /\.(html|htm|json|css|js|txt|php)(\?.*)?$/i.test(u)
          ) {
            return u.includes(".m3u8") || u.includes(".mpd");
          }
          return u.includes(".m3u8") || u.includes(".mpd") || /\.(mp4|mkv|webm|mov)(\?.*)?$/i.test(u);
        });

        if (validStreams.length > 0) {
          const streamPresets = [
            { label: "1080p Full HD ★", id: "1080p", tag: "1080P" },
            { label: "720p HD", id: "720p", tag: "720P" },
            { label: "360p Small", id: "360p", tag: "360P" },
            { label: "Audio Only (MP3)", id: "ba/bestaudio", tag: "AUDIO" }
          ];

          validStreams.forEach((stream, sIdx) => {
            if (validStreams.length > 1) {
              const streamHeader = document.createElement("div");
              streamHeader.className = "hd-dropdown-header";
              streamHeader.style.padding = "6px 14px";
              streamHeader.style.fontSize = "11px";
              streamHeader.style.color = "#00f2fe";
              streamHeader.style.background = "rgba(0, 242, 254, 0.06)";
              streamHeader.textContent = `Stream ${sIdx + 1}${sIdx === 0 ? " (Primary)" : " (Alternate)"}`;
              qualityList.appendChild(streamHeader);
            }

            streamPresets.forEach((preset) => {
              const item = document.createElement("div");
              item.className = "hd-quality-item";
              item.innerHTML = `
                <span>${preset.tag === "AUDIO" ? "🎵" : "🎬"} ${preset.label}</span>
                <span class="hd-tag">${preset.tag}</span>
              `;
              item.addEventListener("click", (evt) => {
                evt.stopPropagation();
                dropdown.classList.remove("show");
                btn.classList.remove("active");

                // Use master URL or original stream URL directly — do NOT alter the path!
                // Signed/HMAC URLs break if the path is modified. yt-dlp's -f selector handles resolution.
                let targetUrl = stream.master_url || stream.url;
                if (/\/(?:init|seg|chunk|frag|main)[^/?#]*\.(mp4|m4s)/i.test(targetUrl)) {
                  targetUrl = targetUrl.replace(/\/(?:init|seg|chunk|frag|main)[^/?#]*\.(mp4|m4s)/i, ".m3u8");
                }
                if (targetUrl.includes("/seg_") || /\.(ts|m4s)/i.test(targetUrl)) {
                  targetUrl = targetUrl.replace(/\/seg_[^/?#]+\.ts/i, "/index.m3u8");
                }

                const pageTitle = getAccurateMediaTitle();
                let cleanRef = stream.referer || window.location.href;
                if (cleanRef) {
                  try {
                    const u = new URL(cleanRef);
                    if (!u.pathname || u.pathname === "") {
                      u.pathname = "/";
                      cleanRef = u.href;
                    }
                  } catch(e) {}
                }
                let cleanOrig = stream.origin || window.location.origin;
                if (cleanOrig && cleanOrig.endsWith("/")) {
                  cleanOrig = cleanOrig.slice(0, -1);
                }
                chrome.runtime.sendMessage({
                  action: "download_stream_video",
                  url: targetUrl,
                  format_id: preset.id,
                  title: pageTitle,
                  referer: cleanRef,
                  origin: cleanOrig,
                  cookie: stream.cookie || document.cookie || ""
                });
              });
              qualityList.appendChild(item);
              itemsAdded++;
            });
          });
        }

        // 3. Direct HTML5 video source
        const video = container.querySelector("video") || document.querySelector("video");
        const directSrc = video ? video.currentSrc || video.src : "";
        if (directSrc && !directSrc.startsWith("blob:") && !sniffedStreams.some((s) => s.url === directSrc)) {
          const item = document.createElement("div");
          item.className = "hd-quality-item";
          item.innerHTML = `
            <span>🎬 Direct Video Stream</span>
            <span class="hd-tag">ORIGINAL</span>
          `;
          item.addEventListener("click", (evt) => {
            evt.stopPropagation();
            dropdown.classList.remove("show");
            btn.classList.remove("active");
            chrome.runtime.sendMessage({
              action: "download_url",
              url: directSrc,
              cookie: document.cookie || ""
            });
          });
          qualityList.appendChild(item);
          itemsAdded++;
        }

        const detectedEps = getDetectedEpisodes();
        if (detectedEps.length > 1) {
          const batchItem = document.createElement("div");
          batchItem.className = "hd-quality-item";
          batchItem.style.borderTop = "1px solid rgba(0, 242, 254, 0.25)";
          batchItem.style.marginTop = "4px";
          batchItem.innerHTML = `
            <span>⚡ Download All ${detectedEps.length} Episodes</span>
            <span class="hd-tag" style="background: rgba(0, 242, 254, 0.25); color: #00f2fe;">ZIP ARCHIVE</span>
          `;
          batchItem.addEventListener("click", (evt) => {
            evt.stopPropagation();
            dropdown.classList.remove("show");
            btn.classList.remove("active");
            openBatchModal();
          });
          qualityList.appendChild(batchItem);
          itemsAdded++;
        }

        if (itemsAdded === 0) {
          qualityList.innerHTML = `
            <div style="padding: 16px; text-align: center; display: flex; flex-direction: column; gap: 8px;">
              <span style="color: #00f2fe; font-size: 13px; font-weight: 700;">▶ Click Play on Video</span>
              <span style="color: #94a3b8; font-size: 11px; line-height: 1.4;">Streams appear automatically once video playback starts.</span>
            </div>
          `;
        }
      }

      panel._renderQuality = renderQualityOptions;

      btn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();

        const isOpen = dropdown.classList.contains("show");
        document.querySelectorAll(".hd-dropdown.show").forEach((d) => d.classList.remove("show"));
        document.querySelectorAll(".hd-panel-btn.active").forEach((b) => b.classList.remove("active"));

        if (isOpen) return;

        dropdown.classList.add("show");
        btn.classList.add("active");

        qualityList.innerHTML = `<div class="hd-loading">Detecting streams...</div>`;

        // Always query fresh streams from background sniffer
        try {
          const res = await new Promise((resolve) => {
            chrome.runtime.sendMessage({ action: "get_detected_streams" }, (r) => resolve(r));
          });
          if (res && res.streams && res.streams.length > 0) {
            sniffedStreams = res.streams;
          }
        } catch(e) {}

        renderQualityOptions();
      });

      window.addEventListener("hd_stream_detected", () => {
        if (dropdown.classList.contains("show")) {
          renderQualityOptions();
        }
      });

      // Close when clicking outside
      document.addEventListener("click", (e) => {
        if (!panel.contains(e.target)) {
          dropdown.classList.remove("show");
          btn.classList.remove("active");
        }
      });

      container.appendChild(panel);
    });

    // Also attach batch episode button if an episode list exists
    attachBatchEpisodeButton();
  }

  // Run on load and observe DOM changes
  attachVideoPanels();
  attachBatchEpisodeButton();
  setInterval(() => {
    attachVideoPanels();
    attachBatchEpisodeButton();
  }, 1000);

  const observer = new MutationObserver(() => {
    attachVideoPanels();
    attachBatchEpisodeButton();
  });
  observer.observe(document.body || document.documentElement, {
    childList: true,
    subtree: true
  });

  // Support SPA navigation across videos without leaking dead state
  function resetPanels() {
    document.querySelectorAll(".hd-video-panel").forEach((p) => p.remove());
    document.querySelectorAll(".hd-has-panel").forEach((el) => el.classList.remove("hd-has-panel"));
    setTimeout(attachVideoPanels, 150);
    setTimeout(attachVideoPanels, 600);
    setTimeout(attachVideoPanels, 1200);
  }

  window.addEventListener("yt-navigate-finish", resetPanels);
  window.addEventListener("yt-page-data-updated", resetPanels);
  window.addEventListener("popstate", resetPanels);

  // 4. Catch Magnet Links & Direct Clicks
  document.addEventListener(
    "click",
    function (e) {
      const anchor = e.target.closest("a");
      if (!anchor || !anchor.href) return;
      const href = anchor.href;

      if (href.startsWith("magnet:?")) {
        e.preventDefault();
        e.stopPropagation();
        chrome.runtime.sendMessage({ action: "download_url", url: href });
      }
    },
    true
  );

  // 5. Bridge notifications from WebUI dashboard to Brave top-of-screen notification
  window.addEventListener("message", function (event) {
    if (event.data && event.data.source === "hyperdrain_webui" && event.data.action === "show_notification") {
      try {
        if (chrome.runtime && chrome.runtime.sendMessage) {
          chrome.runtime.sendMessage({
            action: "show_notification",
            title: event.data.title,
            message: event.data.message
          });
        }
      } catch (err) {}
    }
  });
})();
