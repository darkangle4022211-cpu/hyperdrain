const CORE_API = "http://127.0.0.1:6880";
const AUTH_TOKEN = "hyperdrain_secret_token";

const statusPill = document.getElementById("status-pill");
const statusText = document.getElementById("status-text");
const speedVal = document.getElementById("speed-val");
const tasksVal = document.getElementById("tasks-val");
const tasksList = document.getElementById("tasks-list");
const urlInput = document.getElementById("url-input");
const addBtn = document.getElementById("add-btn");
const openDashboardBtn = document.getElementById("open-dashboard-btn");

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

function formatSpeed(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec === 0) return "0.0 <small>MB/s</small>";
  const mbps = (bytesPerSec / (1024 * 1024)).toFixed(1);
  return `${mbps} <small>MB/s</small>`;
}

async function refreshData() {
  try {
    const res = await fetch(`${CORE_API}/api/tasks`, {
      headers: { "X-HyperDrain-Token": AUTH_TOKEN }
    });
    if (!res.ok) throw new Error("HTTP error " + res.status);
    const data = await res.json();

    // Set online
    statusPill.className = "status-pill online";
    statusText.textContent = "Engine Connected";

    let totalSpeed = 0;

    // Only display active downloads (exclude completed / old downloads)
    const activeTasks = (data || []).filter(task => {
      const s = (task.status || '').toLowerCase();
      return s === 'downloading' || s === 'paused' || s === 'queued' || s === 'active' || s === 'extracting';
    });

    if (activeTasks.length > 0) {
      tasksList.innerHTML = "";
      activeTasks.forEach(task => {
        if (task.status === "downloading") {
          totalSpeed += task.speed || 0;
        }

        const pct = task.total_bytes > 0 
          ? Math.min(100, (task.downloaded_bytes / task.total_bytes) * 100).toFixed(1)
          : 0;

        const el = document.createElement("div");
        el.className = "task-item";
        const statusColor = task.status === 'error' ? '#ef4444' : (task.status === 'completed' ? '#05df72' : '#00f2fe');
        const speedText = task.status === 'downloading' ? formatBytes(task.speed) + '/s' : (task.status === 'completed' ? '✓ Completed' : task.status);

        const hasTotal = task.total_bytes && task.total_bytes > 0;
        const totalText = hasTotal ? formatBytes(task.total_bytes) : "Calculating size...";
        const displayPct = hasTotal ? pct : (task.downloaded_bytes > 0 ? "..." : "0");
        const pauseIcon = task.status === "paused" ? "▶" : "⏸";
        const pauseTitle = task.status === "paused" ? "Resume download" : "Pause download";

        el.innerHTML = `
          <div class="task-top">
            <span class="task-name" title="${task.name}">${task.name}</span>
            <div style="display: flex; align-items: center; gap: 6px;">
              <span class="task-speed" style="color: ${statusColor}; font-weight: 700;">${speedText}</span>
              ${task.status !== 'completed' ? `<button class="task-pause-btn" title="${pauseTitle}" style="background: rgba(0, 242, 254, 0.15); border: 1px solid rgba(0, 242, 254, 0.3); color: #00f2fe; font-size: 11px; cursor: pointer; padding: 2px 6px; border-radius: 4px; line-height: 1;">${pauseIcon}</button>` : ''}
              <button class="task-del-btn" title="Remove download" style="background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.3); color: #ef4444; font-size: 11px; cursor: pointer; padding: 2px 6px; border-radius: 4px; line-height: 1;">✕</button>
            </div>
          </div>
          <div class="task-progress-bar">
            <div class="task-progress-fill" style="width: ${hasTotal ? Math.max(Number(pct), 2) + '%' : (task.downloaded_bytes > 0 ? '20%' : '6%')}; ${task.status === 'paused' ? 'background: #eab308;' : ''}"></div>
          </div>
          <div class="task-meta">
            <span>${displayPct}% • ${formatBytes(task.downloaded_bytes)} of ${totalText}</span>
            <span>${task.active_connections || 0} conns</span>
          </div>
        `;

        const pauseBtn = el.querySelector(".task-pause-btn");
        if (pauseBtn) {
          pauseBtn.addEventListener("click", async (e) => {
            e.stopPropagation();
            try {
              const act = task.status === "paused" ? "resume" : "pause";
              await fetch(`${CORE_API}/api/tasks/${task.id}/${act}`, {
                method: "POST",
                headers: { "X-HyperDrain-Token": AUTH_TOKEN }
              });
              refreshData();
            } catch (err) {}
          });
        }

        const delBtn = el.querySelector(".task-del-btn");
        if (delBtn) {
          delBtn.addEventListener("click", async (e) => {
            e.stopPropagation();
            try {
              await fetch(`${CORE_API}/api/tasks/${task.id}/delete`, {
                method: "POST",
                headers: { "X-HyperDrain-Token": AUTH_TOKEN }
              });
              refreshData();
            } catch (err) {}
          });
        }

        tasksList.appendChild(el);
      });
    } else {
      tasksList.innerHTML = `<div class="empty-state">No active downloads</div>`;
    }

    speedVal.innerHTML = formatSpeed(totalSpeed);
    tasksVal.innerHTML = `${activeTasks.length}`;
  } catch (e) {
    statusPill.className = "status-pill offline";
    statusText.textContent = "Core Offline";
    speedVal.innerHTML = "0.0 <small>MB/s</small>";
    tasksVal.innerHTML = "0 <small>/ 0</small>";
    tasksList.innerHTML = `<div class="empty-state">Go engine offline. Launch HyperDrain core to connect.</div>`;
  }
}

addBtn.addEventListener("click", async () => {
  const url = urlInput.value.trim();
  if (!url) return;

  try {
    addBtn.disabled = true;
    const res = await fetch(`${CORE_API}/api/tasks/add`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-HyperDrain-Token": AUTH_TOKEN
      },
      body: JSON.stringify({ url: url })
    });
    if (res.ok) {
      urlInput.value = "";
      refreshData();
    } else {
      alert("Failed to add download. Code: " + res.status);
    }
  } catch (err) {
    alert("Could not reach HyperDrain engine at 127.0.0.1:6880");
  } finally {
    addBtn.disabled = false;
  }
});

urlInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") addBtn.click();
});

openDashboardBtn.addEventListener("click", () => {
  const inIncog = Boolean(chrome.extension?.inIncognitoContext);
  chrome.tabs?.query({}, (tabs) => {
    const existingTab = (tabs || []).find(t => {
      if (!t.url) return false;
      const isHD = t.url.includes("127.0.0.1:6880") || t.url.includes("localhost:6880");
      return isHD && Boolean(t.incognito) === inIncog;
    });
    if (existingTab && existingTab.id) {
      chrome.tabs.update(existingTab.id, { active: true });
      if (existingTab.windowId && chrome.windows?.update) {
        chrome.windows.update(existingTab.windowId, { focused: true });
      }
      window.close();
    } else {
      chrome.tabs.create({ url: `${CORE_API}/dashboard` });
      window.close();
    }
  });
});

// Floating Video Bar ON/OFF Toggle
const toggleFloatingBtn = document.getElementById("toggle-floating-btn");
if (toggleFloatingBtn) {
  if (chrome.storage && chrome.storage.local) {
    chrome.storage.local.get({ show_floating_button: true }, (items) => {
      toggleFloatingBtn.checked = items.show_floating_button !== false;
    });
  }

  toggleFloatingBtn.addEventListener("change", () => {
    const isEnabled = toggleFloatingBtn.checked;
    if (chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({ show_floating_button: isEnabled });
    }
    // Broadcast to all active tabs immediately
    if (chrome.tabs && chrome.tabs.query) {
      chrome.tabs.query({}, (tabs) => {
        tabs.forEach((tab) => {
          if (tab.id) {
            chrome.tabs.sendMessage(tab.id, {
              action: "toggle_floating_button",
              enabled: isEnabled
            }).catch(() => {});
          }
        });
      });
    }
  });
}

const sniffedSection = document.getElementById("sniffed-section");
const sniffedList = document.getElementById("sniffed-list");

function checkDetectedStreams() {
  if (!chrome.tabs || !sniffedSection) return;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs || tabs.length === 0) return;
    const activeTab = tabs[0];
    chrome.runtime.sendMessage({ action: "get_detected_streams", tabId: activeTab.id }, (res) => {
      if (res && res.streams && res.streams.length > 0) {
        sniffedSection.style.display = "block";
        sniffedList.innerHTML = "";
        res.streams.forEach((stream) => {
          const item = document.createElement("div");
          item.className = "task-item";
          item.style.cursor = "pointer";
          item.innerHTML = `
            <div class="task-top" style="align-items: center; justify-content: space-between; gap: 8px;">
              <span class="task-name" style="font-weight: 700; color: #00f2fe; max-width: 190px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${stream.label || '🎬 Video Stream'}</span>
              <button style="padding: 4px 10px; font-size: 11px; border-radius: 6px; background: linear-gradient(135deg, #00f2fe, #4facfe); border: none; color: #000; font-weight: 700; cursor: pointer; flex-shrink: 0;">Download ⚡</button>
            </div>
          `;
          item.addEventListener("click", () => {
            chrome.runtime.sendMessage({
              action: "download_stream_video",
              url: stream.master_url || stream.url,
              format_id: "1080p",
              title: activeTab.title || "Video",
              referer: stream.referer || activeTab.url || "",
              origin: stream.origin || ""
            });
            window.close();
          });
          sniffedList.appendChild(item);
        });
      } else {
        sniffedSection.style.display = "none";
      }
    });
  });
}

// Auto-refresh every 1.5s
refreshData();
checkDetectedStreams();
setInterval(() => {
  refreshData();
  checkDetectedStreams();
}, 1500);
