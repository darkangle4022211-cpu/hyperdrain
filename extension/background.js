// HyperDrain Universal MV3 Background Service Worker
const CORE_API = "http://127.0.0.1:6880";
const AUTH_TOKEN = "hyperdrain_secret_token";
const DESKTOP_APP_STATUS_URL = "http://127.0.0.1:6882/status";
const DESKTOP_NOTIFY_URL = "http://127.0.0.1:6882/notify-download";

let isDesktopOnline = true;

// Resilient status check: verifies Electron app on port 6882 or core engine on port 6880
async function checkDesktopStatus() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    let online = false;

    // 1. Check Electron mini server (Port 6882)
    try {
      const res = await fetch(DESKTOP_APP_STATUS_URL, { signal: controller.signal });
      if (res && res.ok) online = true;
    } catch (_) {}

    // 2. Fallback to Core Go Engine (Port 6880)
    if (!online) {
      try {
        const res2 = await fetch(`${CORE_API}/api/settings`, { signal: controller.signal });
        if (res2 && res2.ok) online = true;
      } catch (_) {}
    }

    clearTimeout(timeout);
    isDesktopOnline = online;
    return isDesktopOnline;
  } catch (e) {
    return isDesktopOnline;
  }
}

// Background status polling every 2 seconds
setInterval(checkDesktopStatus, 2000);
checkDesktopStatus();

const MEDIA_EXTENSIONS = new Set([
  "zip", "rar", "7z", "tar", "gz", "bz2", "xz",
  "mkv", "mp4", "avi", "mov", "wmv", "flv", "webm",
  "iso", "img", "bin", "dmg"
]);

// Map to track sniffed video/audio stream requests per tab
const detectedStreamsByTab = new Map();

// Top-level handler for detected media streams (called by webRequest hooks AND subframe content messages)
function handleDetected(url, tabId, reqHeaders = [], initiator = "") {
  if (tabId < 0) return;

  const lower = url.toLowerCase();

  // Ignore web pages, stylesheets, tracking scripts, and non-video API endpoints
  if (
    lower.includes("/api/") ||
    lower.includes("/ajax/") ||
    lower.includes("/theme/") ||
    lower.includes("/episodes/") ||
    lower.includes("google-analytics") ||
    lower.includes("statlytic") ||
    lower.includes("cloudflareinsights") ||
    lower.includes("beacon.min.js") ||
    /\.(html|htm|json|css|js|txt|php|svg|png|jpg|jpeg|webp)(\?.*)?$/i.test(lower)
  ) {
    // Only permit if it explicitly contains an .m3u8 or .mpd playlist
    if (!lower.includes(".m3u8") && !lower.includes(".mpd")) {
      return;
    }
  }

  // 1. If an init/segment fragment of a CMAF/fMP4 stream is detected (e.g. .../144p.av1.mp4/init-v1-a1.mp4),
  // recover the full .m3u8 playlist URL!
  let targetUrl = url;
  if (/\/(?:init|seg|chunk|frag|main)[^/?#]*\.(mp4|m4s)/i.test(targetUrl)) {
    targetUrl = targetUrl.replace(/\/(?:init|seg|chunk|frag|main)[^/?#]*\.(mp4|m4s)/i, ".m3u8");
  }

  const targetLower = targetUrl.toLowerCase();

  // Ignore single video fragment chunks (.ts, .m4s, .m4f, etc.) - they are only single 2-4 second slices of HLS/DASH streams!
  const isChunkFragment = /\.(ts|m4s|m4f|key)(\?.*)?$/i.test(targetLower) ||
                          targetLower.includes("/seg_") ||
                          targetLower.includes("/seg-") ||
                          targetLower.includes("segment-") ||
                          targetLower.includes("segment_") ||
                          targetLower.includes("-frag") ||
                          targetLower.includes("/frag_") ||
                          targetLower.includes("/frag-") ||
                          targetLower.includes("/chunk-") ||
                          targetLower.includes("/chunk_") ||
                          /\/(?:init|main|seg|chunk|frag)[^/?#]*\.mp4/i.test(targetLower);

  if (isChunkFragment) {
    return;
  }

  const isM3U8 = targetLower.includes(".m3u8") || 
                 targetLower.includes(".mpd") || 
                 targetLower.includes("master.txt") ||
                 /\/playlist\.m3u8/i.test(targetLower) ||
                 /\/master\.m3u8/i.test(targetLower) ||
                 /\/index\.m3u8/i.test(targetLower) ||
                 /\/hls\/[^\s\"']+\.m3u8/i.test(targetLower) ||
                 /[?&](?:format|type)=m3u8/i.test(targetLower);
  const isDirectVideo = !isChunkFragment && /\.(mp4|mkv|webm|mov)(\?.*)?$/i.test(targetLower);

  if (isM3U8 || isDirectVideo) {
    let referer = "";
    let origin = "";
    let cookie = "";
    if (reqHeaders && reqHeaders.length > 0) {
      for (const h of reqHeaders) {
        const name = (h.name || "").toLowerCase();
        if (name === "referer") referer = h.value;
        if (name === "origin") origin = h.value;
        if (name === "cookie") cookie = h.value;
      }
    }
    if (!referer && initiator) referer = initiator;
    if (referer) {
      try {
        const u = new URL(referer);
        if (!u.pathname || u.pathname === "") {
          u.pathname = "/";
          referer = u.href;
        }
      } catch(e) {}
    }
    if (!origin && referer) {
      try {
        const u = new URL(referer);
        origin = u.origin;
      } catch(e) {}
    }

    let streams = detectedStreamsByTab.get(tabId) || [];
    let existingIndex = streams.findIndex(s => s.url === targetUrl);
    if (existingIndex >= 0) {
      if (referer && !streams[existingIndex].referer) streams[existingIndex].referer = referer;
      if (origin && !streams[existingIndex].origin) streams[existingIndex].origin = origin;
      if (cookie && !streams[existingIndex].cookie) streams[existingIndex].cookie = cookie;
      const item = streams.splice(existingIndex, 1)[0];
      streams.unshift(item);
    } else {
      let masterUrl = "";
      if (isM3U8 && /\/(1080|720|360|480)\/index\.m3u8/.test(targetUrl)) {
        masterUrl = targetUrl.replace(/\/(1080|720|360|480)\/index\.m3u8/, "/master.m3u8");
      }
      const streamInfo = {
        url: targetUrl,
        master_url: masterUrl,
        type: isM3U8 ? "HLS" : "MP4",
        label: isM3U8 ? "🎬 Video Stream" : "🎬 Direct MP4 Video",
        referer: referer || "",
        origin: origin || "",
        cookie: cookie || ""
      };
      streams.unshift(streamInfo);
      if (streams.length > 8) streams.length = 8;
      detectedStreamsByTab.set(tabId, streams);

      // Update extension icon badge
      try {
        chrome.action.setBadgeText({ text: "⚡", tabId: tabId });
        chrome.action.setBadgeBackgroundColor({ color: "#00f2fe", tabId: tabId });
      } catch(e) {}

      // Broadcast to content scripts in that tab
      chrome.tabs.sendMessage(tabId, {
        action: "stream_detected",
        stream: streamInfo
      }).catch(() => {});
    }
  }
}

// Sniff network requests for HLS (.m3u8), MP4, WebM streams across all frames
function registerStreamSniffer() {
  if (!chrome.webRequest) return;

  const filter = { urls: ["<all_urls>"] };

  if (chrome.webRequest.onBeforeSendHeaders) {
    try {
      chrome.webRequest.onBeforeSendHeaders.addListener(
        (details) => {
          handleDetected(details.url, details.tabId, details.requestHeaders, details.initiator);
        },
        filter,
        ["requestHeaders", "extraHeaders"]
      );
    } catch(e) {
      chrome.webRequest.onBeforeSendHeaders.addListener(
        (details) => {
          handleDetected(details.url, details.tabId, details.requestHeaders, details.initiator);
        },
        filter,
        ["requestHeaders"]
      );
    }
  }

  if (chrome.webRequest.onHeadersReceived) {
    try {
      chrome.webRequest.onHeadersReceived.addListener(
        (details) => {
          let isMedia = false;
          if (details.responseHeaders) {
            for (const h of details.responseHeaders) {
              const name = (h.name || "").toLowerCase();
              const val = (h.value || "").toLowerCase();
              if (name === "content-type") {
                if (val.includes("mpegurl") || val.includes("m3u8") || val.includes("dash+xml") || val.includes("video/")) {
                  isMedia = true;
                  break;
                }
              }
            }
          }
          if (isMedia && details.tabId >= 0) {
            handleDetected(details.url, details.tabId, [], details.initiator);
          }
        },
        filter,
        ["responseHeaders"]
      );
    } catch(e) {}
  }

  if (chrome.webRequest.onBeforeRequest) {
    chrome.webRequest.onBeforeRequest.addListener(
      (details) => {
        handleDetected(details.url, details.tabId, [], details.initiator);
      },
      filter
    );
  }
}
registerStreamSniffer();

chrome.tabs.onRemoved.addListener((tabId) => {
  detectedStreamsByTab.delete(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Clear streams on full reload as well as SPA pushState/hashchange URL updates
  if (changeInfo.url || changeInfo.status === "loading") {
    detectedStreamsByTab.delete(tabId);
    try {
      chrome.action.setBadgeText({ text: "", tabId: tabId });
    } catch(e) {}
    chrome.tabs.sendMessage(tabId, {
      action: "page_navigated",
      url: changeInfo.url || (tab ? tab.url : "")
    }).catch(() => {});
  }
});

// Setup context menus on installation
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "hyperdrain-download-link",
      title: "⚡ Download with HyperDrain (32GB Accelerator)",
      contexts: ["link", "video", "audio"]
    });

    chrome.contextMenus.create({
      id: "hyperdrain-open-dashboard",
      title: "📊 Open HyperDrain Dashboard",
      contexts: ["action"]
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "hyperdrain-download-link") {
    const targetUrl = info.linkUrl || info.srcUrl;
    if (targetUrl) {
      openDownloadPrompt(targetUrl, "", tab ? tab.url : "");
    }
  } else if (info.menuItemId === "hyperdrain-open-dashboard") {
    const inIncog = Boolean(tab?.incognito || chrome.extension?.inIncognitoContext);
    chrome.tabs.query({}, (tabs) => {
      const existingTab = (tabs || []).find(t => {
        if (!t.url) return false;
        const isHD = t.url.includes("127.0.0.1:6880") || t.url.includes("localhost:6880");
        return isHD && Boolean(t.incognito) === inIncog;
      });
      if (existingTab && existingTab.id) {
        chrome.tabs.update(existingTab.id, { active: true });
        if (existingTab.windowId) chrome.windows.update(existingTab.windowId, { focused: true });
      } else {
        chrome.tabs.create({ url: `${CORE_API}/dashboard` });
      }
    });
  }
});

// Intercept browser downloads
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const url = item.finalUrl || item.url;
  const filename = item.filename || "";
  const ext = filename.split(".").pop().toLowerCase();

  // If it's a media/archive or large file, intercept it
  const isLargeMedia = MEDIA_EXTENSIONS.has(ext) || item.fileSize > 50 * 1024 * 1024;

  if (isLargeMedia && !url.startsWith("blob:") && !url.startsWith("data:")) {
    // Cancel the browser's slow single-stream download
    chrome.downloads.cancel(item.id, () => {
      chrome.downloads.erase({ id: item.id }, () => {
        // Open interactive download prompt asking for location & filename
        openDownloadPrompt(url, filename, item.referrer || "");
      });
    });
    return true;
  }
  suggest();
});

let currentPromptWinId = null;

async function openDownloadPrompt(url, filename, referer, formatId = "", origin = "", passedCookie = "", isIncognito = false) {
  let chosenDir = "";
  try {
    // 1. Immediately trigger the Ubuntu native folder picker in front of the user
    const res = await fetch(`${CORE_API}/api/choose-folder`, {
      method: "POST",
      headers: { "X-HyperDrain-Token": AUTH_TOKEN }
    });
    if (res.ok) {
      const data = await res.json();
      if (data.cancelled || !data.path) {
        // User pressed Cancel or closed the Ubuntu dialog; abort cleanly
        return;
      }
      chosenDir = data.path;
      if (chrome.storage?.local) {
        chrome.storage.local.set({ last_target_dir: chosenDir });
      }
    }
  } catch (err) {
    console.warn("Could not trigger Ubuntu native folder picker:", err);
  }

  // Fallback to validated directory from engine settings
  if (!chosenDir) {
    try {
      const setRes = await fetch(`${CORE_API}/api/settings`, {
        headers: { "X-HyperDrain-Token": AUTH_TOKEN }
      });
      if (setRes.ok) {
        const setData = await setRes.json();
        if (setData && setData.download_dir) {
          chosenDir = setData.download_dir;
          if (chrome.storage?.local) {
            chrome.storage.local.set({ last_target_dir: chosenDir });
          }
        }
      }
    } catch (e) {}
  }
  if (!chosenDir && chrome.storage?.local) {
    try {
      const stored = await chrome.storage.local.get(["last_target_dir"]);
      if (stored && stored.last_target_dir) {
        chosenDir = stored.last_target_dir;
      }
    } catch (e) {}
  }

  const isIncogContext = isIncognito || Boolean(chrome.extension?.inIncognitoContext);

  // If no cookie was passed directly, try to fetch from the correct cookie store
  if (!passedCookie) {
    try {
      const parsed = new URL(url);
      const storeId = isIncogContext ? "1" : "0";
      let cookies = await chrome.cookies.getAll({ domain: parsed.hostname, storeId: storeId });
      if (!cookies || cookies.length === 0) {
        cookies = await chrome.cookies.getAll({ domain: parsed.hostname });
      }
      passedCookie = (cookies || []).map(c => `${c.name}=${c.value}`).join("; ");
    } catch(e) {
      console.warn("Could not fetch cookies for prompt:", e);
    }
  }

  // 2. Open confirmation bar pre-filled with the selected destination folder
  let promptUrl = `prompt.html?url=${encodeURIComponent(url)}&filename=${encodeURIComponent(filename)}&referer=${encodeURIComponent(referer)}`;
  if (chosenDir) {
    promptUrl += `&target_dir=${encodeURIComponent(chosenDir)}`;
  }
  if (formatId) {
    promptUrl += `&format_id=${encodeURIComponent(formatId)}`;
  }
  if (origin) {
    promptUrl += `&origin=${encodeURIComponent(origin)}`;
  }
  if (passedCookie) {
    promptUrl += `&cookie=${encodeURIComponent(passedCookie)}`;
  }
  if (isIncogContext) {
    promptUrl += `&incognito=1`;
  }

  createNewPromptWindow(promptUrl, isIncogContext);
}

function createNewPromptWindow(promptUrl, isIncognito = false) {
  const inIncog = isIncognito || Boolean(chrome.extension?.inIncognitoContext);
  const winOpts = {
    url: promptUrl,
    type: "popup",
    width: 620,
    height: 540,
    focused: true
  };
  if (inIncog) {
    winOpts.incognito = true;
  }
  chrome.windows.create(winOpts, (win) => {
    if (chrome.runtime.lastError) {
      console.warn("Failed to create popup window:", chrome.runtime.lastError.message);
      // In incognito context, NEVER fall back to creating in normal window!
      if (inIncog) {
        chrome.tabs.create({ url: promptUrl });
        return;
      }
      delete winOpts.incognito;
      chrome.windows.create(winOpts, (win2) => {
        if (win2) currentPromptWinId = win2.id;
      });
      return;
    }
    if (win) currentPromptWinId = win.id;
  });
}

chrome.windows.onRemoved.addListener((winId) => {
  if (winId === currentPromptWinId) {
    currentPromptWinId = null;
  }
});

// Extract cookies and transmit task to local Go engine
async function sendToHyperDrain(url, referer = "", tabId = null, filename = "") {
  try {
    let cookieHeader = "";
    try {
      const parsed = new URL(url);
      const cookies = await chrome.cookies.getAll({ domain: parsed.hostname });
      cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join("; ");
    } catch (e) {
      console.warn("Could not retrieve cookies for:", url, e);
    }

    const payload = {
      url: url,
      referer: referer || "",
      cookie: cookieHeader,
      user_agent: navigator.userAgent,
      suggested_name: filename || ""
    };

    const res = await fetch(`${CORE_API}/api/tasks/add`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-HyperDrain-Token": AUTH_TOKEN
      },
      body: JSON.stringify(payload)
    });

    if (res.ok) {
      const data = await res.json();
      const taskId = data.id || data.task_id;
      if (taskId) {
        fetch(`${DESKTOP_NOTIFY_URL}?taskId=${encodeURIComponent(taskId)}`).catch(() => {});
      }
      notifyUser("Download Added ⚡", `Routed to HyperDrain: ${data.name || filename || 'Media File'}`);
    } else {
      notifyUser("HyperDrain Error", `Core responded with code: ${res.status}`);
    }
  } catch (err) {
    console.error("Failed to connect to HyperDrain engine:", err);
    notifyUser("HyperDrain Offline", "Ensure the HyperDrain Go core is running on your machine (127.0.0.1:6880).");
  }
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

const activeTaskIds = new Set();
const notifiedTasks = new Set();

function handleTaskStatusChange(task) {
  if (!task || !task.id) return;
  // Task state tracking only — notifications are handled by the Go engine
  // via notify-send which is reliable (unlike MV3 service worker in-memory state).
  const isDownloading = task.status === "downloading" || task.status === "queued" || task.status === "active";
  if (isDownloading) {
    activeTaskIds.add(task.id);
  } else if (task.status === "completed" || task.status === "extracted" || task.status === "error" || task.status === "stopped") {
    activeTaskIds.delete(task.id);
  }
}

async function checkCoreTasks() {
  try {
    const res = await fetch(`${CORE_API}/api/tasks`, {
      headers: { "X-HyperDrain-Token": AUTH_TOKEN }
    });
    if (!res.ok) return;
    const tasks = await res.json();
    if (!Array.isArray(tasks)) return;

    for (const task of tasks) {
      handleTaskStatusChange(task);
    }
  } catch (e) {
    // Core offline or busy
  }
}

// Background task poll interval
setInterval(checkCoreTasks, 1000);
checkCoreTasks();

// Real-time WebSocket connection to Go engine for instantaneous zero-latency alerts
let extWs = null;
function connectCoreWs() {
  try {
    extWs = new WebSocket("ws://127.0.0.1:6880/ws");
    extWs.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data && Array.isArray(data.tasks)) {
          for (const task of data.tasks) {
            handleTaskStatusChange(task);
          }
        }
      } catch (err) {}
    };
    extWs.onclose = () => {
      setTimeout(connectCoreWs, 3000);
    };
    extWs.onerror = () => {
      try { extWs.close(); } catch(e) {}
    };
  } catch (err) {
    setTimeout(connectCoreWs, 3000);
  }
}
connectCoreWs();

function notifyUser(title, message) {
  try {
    if (chrome.notifications && chrome.notifications.create) {
      chrome.notifications.create({
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/icon128.png"),
        title: title,
        message: message,
        priority: 2,
        requireInteraction: true
      }, (notifId) => {
        if (chrome.runtime.lastError) {
          console.warn("Notification error:", chrome.runtime.lastError.message);
        }
      });
    }
  } catch (err) {
    console.warn("notifyUser failed:", err);
  }
}

if (chrome.notifications && chrome.notifications.onClicked) {
  chrome.notifications.onClicked.addListener((notifId) => {
    chrome.tabs.query({}, (tabs) => {
      const existing = (tabs || []).find(t => t.url && (t.url.includes("127.0.0.1:6880") || t.url.includes("localhost:6880")));
      if (existing && existing.id) {
        chrome.tabs.update(existing.id, { active: true });
        if (existing.windowId) chrome.windows.update(existing.windowId, { focused: true });
      } else {
        chrome.tabs.create({ url: `${CORE_API}/dashboard` });
      }
    });
  });
}

// Listen to content script messages (e.g. magnet links, video panels)
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const senderIsIncognito = sender.tab ? !!sender.tab.incognito : false;
  if (request.action === "show_notification") {
    notifyUser(request.title || "HyperDrain", request.message || "");
    sendResponse({ status: "ok" });
  } else if (request.action === "open_dashboard") {
    const inIncog = sender.tab ? !!sender.tab.incognito : false;
    chrome.tabs.query({}, (tabs) => {
      const existingTab = (tabs || []).find(t => {
        if (!t.url) return false;
        const isHD = t.url.includes("127.0.0.1:6880") || t.url.includes("localhost:6880");
        return isHD && Boolean(t.incognito) === inIncog;
      });
      if (existingTab && existingTab.id) {
        chrome.tabs.update(existingTab.id, { active: true }, () => {
          if (existingTab.windowId && chrome.windows?.update) {
            chrome.windows.update(existingTab.windowId, { focused: true });
          }
        });
        sendResponse({ status: "ok" });
      } else {
        const createProps = { url: `${CORE_API}/`, active: true };
        if (sender.tab && sender.tab.windowId) {
          createProps.windowId = sender.tab.windowId;
        }
        chrome.tabs.create(createProps, (newTab) => {
          if (newTab && newTab.windowId && chrome.windows?.update) {
            chrome.windows.update(newTab.windowId, { focused: true });
          }
          sendResponse({ status: "ok" });
        });
      }
    });
    return true;
  } else if (request.action === "download_url") {
    openDownloadPrompt(request.url, "", sender.tab ? sender.tab.url : "", "", "", request.cookie || "", senderIsIncognito);
    sendResponse({ status: "ok" });
  } else if (request.action === "download_stream_video") {
    openDownloadPrompt(
      request.url,
      request.title,
      request.referer || (sender.tab ? sender.tab.url : ""),
      request.format_id,
      request.origin || "",
      request.cookie || "",
      senderIsIncognito
    );
    sendResponse({ status: "ok" });
  } else if (request.action === "bring_to_front") {
    if (currentPromptWinId) {
      chrome.windows.update(currentPromptWinId, { focused: true, drawAttention: true }, (w) => {
        if (chrome.runtime.lastError) {
          console.warn("Could not bring prompt window to front:", chrome.runtime.lastError);
        }
      });
    }
    sendResponse({ status: "ok" });
  } else if (request.action === "check_status") {
    fetch(`${CORE_API}/api/stats`, {
      headers: { "X-HyperDrain-Token": AUTH_TOKEN }
    })
      .then(res => res.json())
      .then(stats => sendResponse({ online: true, stats }))
      .catch(() => sendResponse({ online: false }));
    return true; // Keep message channel open for async response
  } else if (request.action === "check_engine_status") {
    // Check internal status endpoint (Port 6882) to confirm Electron desktop app is alive
    checkDesktopStatus().then((online) => {
      sendResponse({ online: online });
    });
    return true; // Keep channel open for async response
  } else if (request.action === "report_stream_from_frame") {
    if (sender.tab && sender.tab.id >= 0 && request.url) {
      handleDetected(request.url, sender.tab.id, [], request.referer || "");
    }
    sendResponse({ status: "ok" });
  } else if (request.action === "clear_tab_streams") {
    const tabId = sender.tab ? sender.tab.id : request.tabId;
    if (tabId && tabId >= 0) {
      detectedStreamsByTab.delete(tabId);
      try {
        chrome.action.setBadgeText({ text: "", tabId: tabId });
      } catch(e) {}
    }
    sendResponse({ status: "ok" });
  } else if (request.action === "get_detected_streams") {
    const tabId = sender.tab ? sender.tab.id : request.tabId;
    const streams = (tabId && detectedStreamsByTab.get(tabId)) || [];
    sendResponse({ streams });
    return true;
  }
});
