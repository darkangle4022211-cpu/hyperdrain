const CORE_API = "http://127.0.0.1:6880";
const AUTH_TOKEN = "hyperdrain_secret_token";

const params = new URLSearchParams(window.location.search);
const downloadUrl = params.get("url") || "";
const initialFilename = params.get("filename") || "";
const referer = params.get("referer") || "";
const origin = params.get("origin") || "";
const formatId = params.get("format_id") || "";
const targetDirParam = params.get("target_dir") || "";
const cookieParam = params.get("cookie") || "";
const isIncognitoParam = params.get("incognito") === "1";

const filenameInput = document.getElementById("p-filename");
const targetDirDisplay = document.getElementById("p-targetdir-display");
const browseBtn = document.getElementById("p-browse-btn");
const downloadBtn = document.getElementById("p-download-btn");
const cancelBtn = document.getElementById("p-cancel-btn");
const streamPills = document.querySelectorAll(".stream-pill");
const qualityPills = document.querySelectorAll(".quality-pill");
const qualityGroup = document.getElementById("quality-selector-group");

let selectedStreams = 32;
let selectedQuality = "1080p";
let currentTargetDir = "";

if (initialFilename) {
  filenameInput.value = decodeURIComponent(initialFilename);
}

const isStreamOrVideo = Boolean(
  formatId || 
  downloadUrl.includes(".m3u8") || 
  downloadUrl.includes(".mpd") || 
  downloadUrl.includes("youtube.com") || 
  downloadUrl.includes("youtu.be") || 
  downloadUrl.includes("googlevideo") ||
  downloadUrl.includes("/embed") ||
  downloadUrl.includes("/stream")
);

if (isStreamOrVideo) {
  if (qualityGroup) qualityGroup.style.display = "block";
  if (formatId && ["1080p", "720p", "360p", "ba/bestaudio"].includes(formatId)) {
    selectedQuality = formatId;
    qualityPills.forEach(p => {
      p.classList.toggle("active", p.getAttribute("data-quality") === selectedQuality);
    });
  } else {
    chrome.storage.local.get(["last_selected_quality"], (res) => {
      if (res && res.last_selected_quality) {
        selectedQuality = res.last_selected_quality;
      }
      qualityPills.forEach(p => {
        p.classList.toggle("active", p.getAttribute("data-quality") === selectedQuality);
      });
    });
  }
}

if (formatId) {
  const subtitle = document.getElementById("file-size-subtitle");
  if (subtitle) {
    subtitle.textContent = `Video Stream (${formatId}) • 16 Accelerated Streams`;
  }
}

// Load chosen destination directory from params, remembered storage, or query engine
function initTargetDir() {
  if (targetDirParam) {
    currentTargetDir = decodeURIComponent(targetDirParam);
    targetDirDisplay.textContent = currentTargetDir;
    return;
  }
  if (chrome.storage?.local) {
    chrome.storage.local.get(["last_target_dir"], (res) => {
      if (res && res.last_target_dir) {
        currentTargetDir = res.last_target_dir;
        targetDirDisplay.textContent = currentTargetDir;
      } else {
        fetchEngineDefaultDir();
      }
    });
  } else {
    fetchEngineDefaultDir();
  }
}

function fetchEngineDefaultDir() {
  fetch(`${CORE_API}/api/settings`, {
    headers: { "X-HyperDrain-Token": AUTH_TOKEN }
  })
    .then(r => r.json())
    .then(data => {
      if (data && data.download_dir) {
        currentTargetDir = data.download_dir;
        targetDirDisplay.textContent = currentTargetDir;
      }
    })
    .catch(() => {
      targetDirDisplay.textContent = "Click Browse to select folder";
    });
}

initTargetDir();

// Stream Pill selection
streamPills.forEach(pill => {
  pill.addEventListener("click", () => {
    streamPills.forEach(p => p.classList.remove("active"));
    pill.classList.add("active");
    selectedStreams = parseInt(pill.getAttribute("data-streams"), 10) || 32;
  });
});

// Quality Pill selection
qualityPills.forEach(pill => {
  pill.addEventListener("click", () => {
    qualityPills.forEach(p => p.classList.remove("active"));
    pill.classList.add("active");
    selectedQuality = pill.getAttribute("data-quality") || "1080p";
    if (chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({ last_selected_quality: selectedQuality });
    }
  });
});



// Native Ubuntu Folder Picker via local Go backend
browseBtn.addEventListener("click", async () => {
  try {
    browseBtn.disabled = true;
    browseBtn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="animation: spin 1s linear infinite;">
        <circle cx="12" cy="12" r="10" stroke-dasharray="32" stroke-dashoffset="12"></circle>
      </svg>
      <span>Choosing...</span>
    `;

    const res = await fetch(`${CORE_API}/api/choose-folder`, {
      method: "POST",
      headers: { "X-HyperDrain-Token": AUTH_TOKEN }
    });

    if (res.ok) {
      const data = await res.json();
      if (!data.cancelled && data.path) {
        currentTargetDir = data.path;
        targetDirDisplay.textContent = currentTargetDir;
        if (chrome.storage?.local) {
          chrome.storage.local.set({ last_target_dir: currentTargetDir });
        }
      }
    }
  } catch (err) {
    console.error("Browse folder error:", err);
    alert("Could not trigger Ubuntu folder picker. Ensure HyperDrain engine is running.");
  } finally {
    browseBtn.disabled = false;
    browseBtn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
      </svg>
      <span>Browse...</span>
    `;

    // CRITICAL FIX: Bring prompt window immediately back to front
    if (chrome.runtime?.sendMessage) {
      chrome.runtime.sendMessage({ action: "bring_to_front" });
    }
    window.focus();
    if (chrome.windows?.getCurrent) {
      chrome.windows.getCurrent((w) => {
        if (w) chrome.windows.update(w.id, { focused: true, drawAttention: true });
      });
    }
    setTimeout(() => {
      if (chrome.runtime?.sendMessage) {
        chrome.runtime.sendMessage({ action: "bring_to_front" });
      }
      window.focus();
    }, 150);
    setTimeout(() => {
      if (chrome.runtime?.sendMessage) {
        chrome.runtime.sendMessage({ action: "bring_to_front" });
      }
      window.focus();
    }, 400);
  }
});

// Cancel button
cancelBtn.addEventListener("click", () => {
  window.close();
});

function openOrFocusDashboard(inIncog, callback) {
  if (chrome.tabs?.query) {
    chrome.tabs.query({}, (tabs) => {
      const existingTab = (tabs || []).find(t => {
        if (!t.url) return false;
        const isHD = t.url.includes("127.0.0.1:6880") || t.url.includes("localhost:6880");
        return isHD && Boolean(t.incognito) === inIncog;
      });

      if (existingTab && existingTab.id) {
        chrome.tabs.update(existingTab.id, { active: true }, () => {
          if (existingTab.windowId && chrome.windows?.update) {
            chrome.windows.update(existingTab.windowId, { focused: true }, () => {
              if (callback) callback();
            });
          } else {
            if (callback) callback();
          }
        });
      } else {
        if (chrome.windows?.getAll) {
          chrome.windows.getAll({ windowTypes: ["normal"] }, (wins) => {
            const targetWin = (wins || []).find(w => Boolean(w.incognito) === inIncog) || wins?.[0];
            if (targetWin) {
              chrome.tabs.create({ windowId: targetWin.id, url: `${CORE_API}/` }, () => {
                if (callback) callback();
              });
            } else {
              chrome.tabs.create({ url: `${CORE_API}/` }, () => {
                if (callback) callback();
              });
            }
          });
        } else {
          chrome.tabs.create({ url: `${CORE_API}/` }, () => {
            if (callback) callback();
          });
        }
      }
    });
  } else {
    chrome.tabs?.create({ url: `${CORE_API}/` }, () => {
      if (callback) callback();
    });
  }
}

// Start Download button
downloadBtn.addEventListener("click", async () => {
  if (!downloadUrl) {
    alert("Invalid download URL");
    return;
  }

  const chosenName = filenameInput.value.trim();

  downloadBtn.disabled = true;
  downloadBtn.innerHTML = `<span>Starting...</span>`;

  try {
    // Use cookie from URL params (already fetched from correct store by background.js)
    let cookieHeader = cookieParam;
    if (!cookieHeader) {
      try {
        const parsed = new URL(downloadUrl);
        const storeId = isIncognitoParam ? "1" : "0";
        const cookies = await chrome.cookies.getAll({ domain: parsed.hostname, storeId: storeId });
        cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join("; ");
      } catch (e) {
        console.warn("Could not read cookies:", e);
      }
    }

    let endpoint = `${CORE_API}/api/tasks/add`;
    let payload = {
      url: downloadUrl,
      suggested_name: chosenName,
      target_dir: currentTargetDir,
      referer: referer,
      cookie: cookieHeader,
      user_agent: navigator.userAgent,
      connections: selectedStreams,
      auto_extract: false
    };

    let cleanReferer = referer || "";
    if (cleanReferer) {
      try {
        const u = new URL(cleanReferer);
        if (!u.pathname || u.pathname === "") {
          u.pathname = "/";
          cleanReferer = u.href;
        }
      } catch(e) {}
    }
    let cleanOrigin = origin || "";
    if (cleanOrigin && cleanOrigin.endsWith("/")) {
      cleanOrigin = cleanOrigin.slice(0, -1);
    }

    if (formatId || isStreamOrVideo) {
      endpoint = `${CORE_API}/api/download-stream`;
      // Do NOT munge the URL path — signed/HMAC URLs break if the path is altered.
      // yt-dlp's -f format selector handles resolution selection.
      payload = {
        url: downloadUrl,
        format_id: selectedQuality || formatId || "1080p",
        title: chosenName,
        target_dir: currentTargetDir,
        referer: cleanReferer,
        origin: cleanOrigin,
        cookie: cookieHeader,
        user_agent: navigator.userAgent,
        connections: selectedStreams
      };
    }

    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-HyperDrain-Token": AUTH_TOKEN
      },
      body: JSON.stringify(payload)
    });

    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      const taskId = data.task_id || data.id;
      if (taskId) {
        // Trigger IDM-style mini window in Electron desktop app
        fetch(`http://127.0.0.1:6882/notify-download?taskId=${encodeURIComponent(taskId)}`).catch(() => {});
      }
      if (chrome.runtime?.sendMessage) {
        chrome.runtime.sendMessage({
          action: "show_notification",
          title: "HyperDrain ⚡ Download Started",
          message: `Routed to HyperDrain: ${chosenName || "Media File"}`
        });
      }
      window.close();
    } else {
      alert("HyperDrain engine error: " + res.status);
      downloadBtn.disabled = false;
      downloadBtn.innerHTML = `<span>Start Download ⚡</span>`;
    }
  } catch (err) {
    alert("Could not reach HyperDrain engine at 127.0.0.1:6880");
    downloadBtn.disabled = false;
    downloadBtn.innerHTML = `<span>Start Download ⚡</span>`;
  }
});
