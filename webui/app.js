// HyperDrain Desktop Dashboard Controller
const API_BASE = window.location.origin.includes("6880") ? window.location.origin : "http://127.0.0.1:6880";
const WS_URL = API_BASE.replace(/^http/, "ws") + "/ws";
const AUTH_TOKEN = "hyperdrain_secret_token";

// DOM Elements
const views = {
  active: document.getElementById("view-active"),
  completed: document.getElementById("view-completed"),
  extension: document.getElementById("view-extension"),
  analytics: document.getElementById("view-analytics"),
  discover: document.getElementById("view-discover"),
  websites: document.getElementById("view-websites"),
  settings: document.getElementById("view-settings")
};

const navItems = document.querySelectorAll(".nav-item");
const viewTitle = document.getElementById("view-title");
const badgeActive = document.getElementById("badge-active");
const badgeCompleted = document.getElementById("badge-completed");

const totalSpeedEl = document.getElementById("total-speed");
const diskSpeedEl = document.getElementById("disk-speed");
const totalConnsEl = document.getElementById("total-conns");
const activeTasksContainer = document.getElementById("active-tasks-container");
const completedTasksContainer = document.getElementById("completed-tasks-container");

// Speed chart setup
const canvas = document.getElementById("liveChart");
const ctx = canvas.getContext("2d");
let chartHistory = Array(60).fill(0);
let diskChartHistory = Array(60).fill(0);
let chartWasZero = false;

// Tab switching
window.switchTab = function(tab) {
  navItems.forEach(n => {
    n.classList.toggle("active", n.getAttribute("data-tab") === tab);
  });

  Object.keys(views).forEach(k => {
    if (views[k]) views[k].classList.toggle("active", k === tab);
  });

  const titles = {
    active: "Active Downloads",
    completed: "Completed Downloads",
    extension: "Universal Browser Extension Hub",
    analytics: "Telemetry & Network Diagnostics",
    discover: "Search & Discover Movies",
    websites: "Websites & Safe Browser",
    settings: "Engine Configuration"
  };
  viewTitle.textContent = titles[tab] || "Dashboard";

  const mainContent = document.querySelector(".main-content");
  if (mainContent) {
    const browserView = document.getElementById("websites-browser-view");
    const isBrowsing = tab === "websites" && browserView && browserView.style.display !== "none";
    mainContent.classList.toggle("websites-browsing-mode", Boolean(isBrowsing));
  }
  const activeWv = document.querySelector("#wb-webview-host webview");
  if (activeWv && typeof activeWv.setAudioMuted === "function") {
    try { activeWv.setAudioMuted(tab !== "websites"); } catch (_) {}
    if (tab !== "websites" && typeof activeWv.executeJavaScript === "function") {
      try {
        activeWv.executeJavaScript("try{document.querySelectorAll('video,audio').forEach(m=>{try{m.pause()}catch(_){}})}catch(_){}; true;").catch(() => {});
      } catch (_) {}
    }
  }

  if (tab === "active") {
    chartWasZero = false;
    drawChart();
  } else if (tab === "completed") {
    fetch(`${API_BASE}/api/tasks`, { headers: { "X-HyperDrain-Token": AUTH_TOKEN } })
      .then(r => r.json())
      .then(tasks => { if (tasks) renderTasks(tasks); })
      .catch(() => {});
  } else if (tab === "extension") {
    loadDetectedBrowsers();
  } else if (tab === "discover") {
    initDiscoverFeed();
    openDiscoverWipModal();
  } else if (tab === "websites") {
    if (typeof initWebsitesTab === "function") initWebsitesTab();
  } else if (tab === "settings") {
    loadSettings();
  }
};

navItems.forEach(item => {
  item.addEventListener("click", () => {
    const tab = item.getAttribute("data-tab");
    window.switchTab(tab);
  });
});

// Format utilities
function formatBytes(bytes) {
  if (!bytes || bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

function formatSpeed(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec === 0) return "0.00 MB/s";
  return (bytesPerSec / (1024 * 1024)).toFixed(2) + " MB/s";
}

function formatETA(remainingBytes, speed) {
  if (!speed || speed === 0 || !remainingBytes || remainingBytes <= 0) return "—";
  const seconds = Math.floor(remainingBytes / speed);
  return formatSeconds(seconds);
}

function formatSeconds(seconds) {
  if (!seconds || seconds <= 0) return "—";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remSec = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remSec}s`;
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  return `${hours}h ${remMin}m`;
}

// Canvas chart drawing
function resizeCanvas() {
  if (!canvas.parentElement) return;
  canvas.width = canvas.parentElement.clientWidth * window.devicePixelRatio;
  canvas.height = 90 * window.devicePixelRatio;
  ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
  chartWasZero = false;
  drawChart();
}
window.addEventListener("resize", resizeCanvas);
setTimeout(resizeCanvas, 100);

function drawChart() {
  // Only draw if active view is actually visible to save 100% idle GPU/CPU
  if (!views.active || !views.active.classList.contains("active")) return;

  const hasActivity = chartHistory.some(v => v > 0) || diskChartHistory.some(v => v > 0);
  if (!hasActivity) {
    if (chartWasZero) return;
    chartWasZero = true;
  } else {
    chartWasZero = false;
  }

  const w = canvas.width / window.devicePixelRatio;
  const h = 90;
  ctx.clearRect(0, 0, w, h);

  const maxVal = Math.max(...chartHistory, ...diskChartHistory, 10 * 1024 * 1024); // min 10 MB/s scale

  // Network speed line & gradient
  ctx.beginPath();
  ctx.moveTo(0, h);
  for (let i = 0; i < chartHistory.length; i++) {
    const x = (i / (chartHistory.length - 1)) * w;
    const y = h - (chartHistory[i] / maxVal) * (h - 10);
    ctx.lineTo(x, y);
  }
  ctx.lineTo(w, h);
  ctx.closePath();

  const netGrad = ctx.createLinearGradient(0, 0, 0, h);
  netGrad.addColorStop(0, "rgba(0, 242, 254, 0.22)");
  netGrad.addColorStop(1, "rgba(0, 242, 254, 0.0)");
  ctx.fillStyle = netGrad;
  ctx.fill();

  // Network line stroke (Electric Cyan)
  ctx.beginPath();
  for (let i = 0; i < chartHistory.length; i++) {
    const x = (i / (chartHistory.length - 1)) * w;
    const y = h - (chartHistory[i] / maxVal) * (h - 10);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = "#00f2fe";
  ctx.lineWidth = 1.75;
  ctx.shadowColor = "rgba(0, 242, 254, 0.35)";
  ctx.shadowBlur = 5;
  ctx.stroke();
  ctx.shadowBlur = 0;

  // Disk write speed stroke (Neon Emerald)
  ctx.beginPath();
  for (let i = 0; i < diskChartHistory.length; i++) {
    const x = (i / (diskChartHistory.length - 1)) * w;
    const y = h - (diskChartHistory[i] / maxVal) * (h - 10);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = "#05df72";
  ctx.lineWidth = 1.25;
  ctx.stroke();
}

// WebSocket & Telemetry Stream
let ws = null;
let currentTasks = [];

function connectWS() {
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    console.log("Connected to HyperDrain Telemetry WebSocket");
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      updateTelemetry(data);
    } catch (e) {
      console.error("WS parse error:", e);
    }
  };

  ws.onclose = () => {
    console.warn("WebSocket closed. Reconnecting in 2s...");
    setTimeout(connectWS, 2000);
  };

  ws.onerror = (err) => {
    console.error("WebSocket error:", err);
    ws.close();
  };
}

// Task tracking and event handlers
const previousTaskStatusMap = new Map();

function playWebAudioChime() {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = "sine";
    osc.frequency.setValueAtTime(587.33, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.15);
    gain.gain.setValueAtTime(0.2, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.35);
    osc.start();
    osc.stop(ctx.currentTime + 0.35);
  } catch (e) {
    // AudioContext may be blocked before user gesture
  }
}

function showInAppCelebrationToast(task) {
  console.log("Task event toast:", task);
}

function handleTaskCompletedEvent(task) {
  playWebAudioChime();
  if (window.electronAPI && typeof window.electronAPI.showNotification === "function") {
    window.electronAPI.showNotification("Download Complete ⚡", `${task.name || "File"} has finished downloading.`);
  } else if ("Notification" in window && Notification.permission === "granted") {
    new Notification("HyperDrain ⚡ Download Complete", {
      body: `${task.name || "File"} has finished downloading.`,
      icon: "/icon.png"
    });
  }
}

function handleTaskStoppedEvent(task) {
  // Silent handling for stopped/errored tasks
}

function updateTelemetry(data) {
  // Update header stats
  totalSpeedEl.textContent = formatSpeed(data.total_speed || 0);
  diskSpeedEl.textContent = formatSpeed(data.disk_write_speed || 0);
  totalConnsEl.textContent = data.active_connections || 0;
  if (titlebarLiveSpeed) {
    titlebarLiveSpeed.textContent = formatSpeed(data.total_speed || 0);
  }

  // Update chart histories
  chartHistory.shift();
  chartHistory.push(data.total_speed || 0);

  diskChartHistory.shift();
  diskChartHistory.push(data.disk_write_speed || 0);

  drawChart();

  // Update tasks
  if (data.tasks) {
    currentTasks = data.tasks;

    // Detect tasks that transitioned to completed/extracted or error/stopped
    data.tasks.forEach(t => {
      const prev = previousTaskStatusMap.get(t.id);
      if (prev && (prev === "downloading" || prev === "queued" || prev === "active")) {
        if (t.status === "completed" || t.status === "extracted") {
          handleTaskCompletedEvent(t);
        } else if (t.status === "error" || t.status === "stopped") {
          handleTaskStoppedEvent(t);
        }
      }
      previousTaskStatusMap.set(t.id, t.status);
    });

    renderTasks(data.tasks);
  }

  // Update analytics tab
  if (document.getElementById("stat-total-downloaded")) {
    document.getElementById("stat-total-downloaded").textContent = formatBytes(data.all_time_downloaded || 0);
    document.getElementById("stat-steals").textContent = data.work_steals_count || 0;
    document.getElementById("stat-zombies").textContent = data.zombies_recycled || 0;
  }
}

// Compute display metrics for a task
function computeTaskMetrics(task, existingCard = null) {
  const ext = (task.name || "").split(".").pop().toUpperCase();
  const isVideoExt = /\.(mp4|mkv|webm|avi|mov)$/i.test(task.name || "");
  const hasTotal = task.total_bytes && task.total_bytes > 0 && (!isVideoExt || task.total_bytes > 1024 * 1024 || task.status === "completed" || task.status === "extracted");

  // Accurately compute unique file bytes downloaded:
  let effectiveDownloaded = task.downloaded_bytes || 0;
  if (task.segments && task.segments.length > 0) {
    const segSum = task.segments.reduce((acc, s) => acc + (s.downloaded || 0), 0);
    if (segSum > 0) {
      effectiveDownloaded = segSum;
    }
  }
  if (hasTotal && effectiveDownloaded > task.total_bytes) {
    effectiveDownloaded = task.total_bytes;
  }
  if (task.status === "completed" || task.status === "extracted") {
    if (hasTotal) effectiveDownloaded = task.total_bytes;
  }

  let rawPct = hasTotal ? (effectiveDownloaded / task.total_bytes) * 100 : 0;
  const isFinished = task.status === "completed" || task.status === "extracted";
  if (!isFinished && rawPct >= 99.9) {
    rawPct = 99.0;
  }

  // Enforce strictly non-decreasing progress percentage to eliminate jarring resets
  if (task.status === "downloading" || task.status === "paused") {
    if (!window._taskMaxPctMap) window._taskMaxPctMap = new Map();
    const prevMax = window._taskMaxPctMap.get(task.id) || 0;
    if (rawPct < prevMax) {
      rawPct = prevMax;
    } else if (rawPct > prevMax) {
      window._taskMaxPctMap.set(task.id, rawPct);
    }
  }

  const pct = isFinished
    ? "100.0"
    : (hasTotal 
        ? Math.min(99.9, Math.max(0, rawPct)).toFixed(1)
        : (effectiveDownloaded > 0 ? "..." : "0"));

  const isZipBatch = Boolean(task.auto_zip || (task.batch_id && hasTotal && (task.name && task.name.toLowerCase().includes("series"))));
  const remainingBytes = hasTotal ? Math.max(0, task.total_bytes - effectiveDownloaded) : 0;
  const eta = (task.eta && task.eta > 0) ? formatSeconds(task.eta) : (hasTotal ? formatETA(remainingBytes, task.speed) : "--");
  let totalDisplay = hasTotal ? formatBytes(task.total_bytes) : "Calculating size...";
  if (isZipBatch && hasTotal) {
    totalDisplay = `~${formatBytes(task.total_bytes)} (Entire Series ZIP)`;
  }
  const downloadedDisplay = formatBytes(effectiveDownloaded);

  let progressLabel = "Starting...";
  let displayBarWidth = "0%";
  let isConnecting = false;
  if (task.status === "downloading") {
    if (task.error_message && (task.error_message.includes("Episode") || task.error_message.includes("ZIP") || task.error_message.includes("Packaging"))) {
      if (effectiveDownloaded > 0 && hasTotal) {
        progressLabel = `${task.error_message} • Overall ZIP: ${pct}%`;
        displayBarWidth = `${Math.max(Number(pct), 2)}%`;
      } else {
        progressLabel = task.error_message;
        displayBarWidth = "15%";
      }
    } else if (effectiveDownloaded > 0 && hasTotal) {
      progressLabel = `${pct}%`;
      displayBarWidth = `${Math.max(Number(pct), 2)}%`;
    } else if (effectiveDownloaded > 0) {
      progressLabel = `Downloading (${downloadedDisplay})`;
      displayBarWidth = "20%";
    } else {
      progressLabel = `Connecting & Allocating Streams...`;
      displayBarWidth = "6%";
      isConnecting = true;
    }
  } else if (task.status === "completed" || task.status === "extracted") {
    progressLabel = `100.0% Complete`;
    displayBarWidth = `100%`;
  } else if (task.status === "paused") {
    progressLabel = hasTotal ? `${pct}% (Paused)` : `Paused`;
    displayBarWidth = hasTotal ? `${Math.max(Number(pct), 2)}%` : "10%";
  } else if (task.status === "error") {
    if (task.error_message && (task.error_message.includes("disk") || task.error_message.includes("space"))) {
      progressLabel = `⚠️ ${task.error_message}`;
    } else if (task.error_message && (task.error_message.includes("expired") || task.error_message.includes("refresh"))) {
      progressLabel = `Stream link expired — Refresh episode in Brave & click ⚡ Download`;
    } else {
      progressLabel = task.error_message ? task.error_message : `Failed - Click Retry`;
    }
    displayBarWidth = "0%";
  }

  const dotBg = (task.status === 'completed' || task.status === 'extracted') ? '#10b981' : (task.status === 'paused' ? '#eab308' : (task.status === 'error' ? '#ef4444' : '#00f2fe'));
  const dotShadow = (task.status === 'completed' || task.status === 'extracted') ? '#10b981' : (task.status === 'paused' ? '#eab308' : '#00f2fe');
  const fillBg = (task.status === 'completed' || task.status === 'extracted') ? 'background: linear-gradient(90deg, #10b981, #059669);' : (task.status === 'paused' ? 'background: linear-gradient(90deg, #eab308, #ca8a04);' : '');
  const statusColor = (task.status === 'completed' || task.status === 'extracted') ? '#10b981' : (task.status === 'error' ? '#ef4444' : (task.status === 'paused' ? '#eab308' : '#fff'));

  return {
    ext,
    hasTotal,
    pct,
    eta,
    totalDisplay,
    downloadedDisplay,
    progressLabel,
    displayBarWidth,
    isConnecting,
    dotBg,
    dotShadow,
    fillBg,
    statusColor
  };
}

function getChunkBlockState(task, i, hasTotal, pct) {
  let blockClass = "chunk-block";
  let fillWidth = "0%";
  const segments = task.segments || [];
  const totalBlocks = 32;

  if (segments && segments.length > 0) {
    const seg = segments[i % segments.length];
    if (seg) {
      if (seg.status === "completed") {
        blockClass += " completed";
        fillWidth = "100%";
      } else if (seg.status === "active") {
        blockClass += " active";
        const segPct = seg.total > 0 ? (seg.downloaded / seg.total) * 100 : 50;
        fillWidth = `${segPct}%`;
      } else if (seg.status === "stealing") {
        blockClass += " stealing";
        fillWidth = "60%";
      }
    }
  } else {
    const completedBlocks = hasTotal ? Math.floor((Number(pct) / 100) * totalBlocks) : Math.min(totalBlocks, Math.floor(task.downloaded_bytes / (1024 * 1024 * 15)));
    const activeStreams = task.active_connections || 32;
    if (i < completedBlocks) {
      blockClass += " completed";
      fillWidth = "100%";
    } else if (i >= completedBlocks && i < completedBlocks + activeStreams && task.status === "downloading") {
      blockClass += " active";
      fillWidth = `${Math.min(95, 40 + ((i * 17) % 55))}%`;
    }
  }
  return { blockClass, fillWidth };
}

function getControlButtonsHtml(task) {
  let ctrlButtons = "";
  if (task.status === "downloading") {
    ctrlButtons = `<button class="btn-ctrl" onclick="pauseTask('${task.id}')">⏸ Pause</button>`;
  } else if (task.status === "paused") {
    ctrlButtons = `<button class="btn-ctrl" onclick="resumeTask('${task.id}')">▶ Resume</button>`;
  } else if (task.status === "error") {
    if (task.error_message && (task.error_message.includes("expired") || task.error_message.includes("refresh"))) {
      return `<button class="btn-ctrl danger" onclick="deleteTask('${task.id}')" title="Expired stream link — click to remove and download freshly from Brave">✕ Clear Expired</button>`;
    }
    ctrlButtons = `<button class="btn-ctrl" onclick="resumeTask('${task.id}')">🔄 Retry</button>`;
  } else {
    ctrlButtons = `<button class="btn-ctrl" onclick="resumeTask('${task.id}')">▶ Start</button>`;
  }
  return `${ctrlButtons}<button class="btn-ctrl danger" onclick="deleteTask('${task.id}')">✕ Cancel</button>`;
}

// Render Task Cards with In-Place DOM Reconciliation (Zero Blinking & Reliable Clicks)
function renderTasks(tasks) {
  const activeTasks = tasks.filter(t => t.status === "downloading" || t.status === "paused" || t.status === "queued" || t.status === "retrying" || t.status === "error");
  const completedTasks = tasks.filter(t => t.status === "completed" || t.status === "extracted");

  badgeActive.textContent = activeTasks.length;
  badgeCompleted.textContent = completedTasks.length;

  // 1. Reconcile Active Tasks
  if (activeTasks.length === 0) {
    if (!activeTasksContainer.querySelector(".empty-hero")) {
      activeTasksContainer.innerHTML = `
        <div class="empty-hero">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
            <polyline points="7 10 12 15 17 10"></polyline>
            <line x1="12" y1="15" x2="12" y2="3"></line>
          </svg>
          <h3>No Active Downloads</h3>
          <p>Drop a link from your browser extension or click 'Add Download' above.</p>
        </div>
      `;
    }
  } else {
    const emptyHero = activeTasksContainer.querySelector(".empty-hero");
    if (emptyHero) emptyHero.remove();

    activeTasks.forEach(task => {
      let card = activeTasksContainer.querySelector(`.task-card[data-task-id="${task.id}"]`);
      const m = computeTaskMetrics(task, card);

      if (!card) {
        // Construct new card
        card = document.createElement("div");
        card.className = "task-card";
        card.setAttribute("data-task-id", task.id);
        card.dataset.status = task.status;
        card.dataset.maxPct = m.pct;

        // Build 32-chunk visual grid HTML
        let chunkGridHtml = "";
        for (let i = 0; i < 32; i++) {
          const { blockClass, fillWidth } = getChunkBlockState(task, i, m.hasTotal, m.pct);
          chunkGridHtml += `<div class="${blockClass}" title="Stream #${i+1}"><div class="chunk-block-fill" style="width: ${fillWidth}"></div></div>`;
        }

        card.innerHTML = `
          <div class="task-header">
            <div class="task-title-wrap">
              <span class="file-type-badge">${m.ext}</span>
              <span class="task-name-text" title="${task.name}">${task.name}</span>
            </div>
            <div class="task-controls">
              ${getControlButtonsHtml(task)}
            </div>
          </div>

          <!-- Real Visible Download Progress Bar -->
          <div class="download-progress-wrap">
            <div class="download-progress-header">
              <span class="progress-label-wrap">
                <span class="progress-dot" style="background: ${m.dotBg};"></span>
                <span class="progress-label-text">Download Progress: ${m.progressLabel}</span>
              </span>
              <span class="progress-size-text">
                ${m.downloadedDisplay} of ${m.totalDisplay}
              </span>
            </div>
            <div class="download-progress-track">
              <div class="download-progress-fill ${m.isConnecting ? 'connecting-shimmer' : ''}" style="width: ${m.displayBarWidth}; ${m.fillBg}"></div>
            </div>
          </div>

          <div class="chunk-matrix-container">
            <div class="chunk-matrix-label">
              <span>Parallel Streams (32-Way)</span>
              <span class="workers-count-text">${task.active_connections || 0} active workers • Work-Stealing Active</span>
            </div>
            <div class="chunk-matrix-grid">
              ${chunkGridHtml}
            </div>
          </div>

          <div class="task-stats-bar">
            <div class="task-stats-left">
              <span>Progress: <b class="stat-pct-val">${m.hasTotal ? m.pct + '%' : '--'}</b></span>
              <span>Downloaded: <b class="stat-dl-val">${m.downloadedDisplay} of ${m.totalDisplay}</b></span>
              <span>Speed: <b class="stat-speed-val">${formatSpeed(task.speed)}</b></span>
              <span>ETA: <b class="stat-eta-val">${m.eta}</b></span>
            </div>
            <div class="task-stats-right">
              <span>Status: <b class="stat-status-val" style="color: ${m.statusColor};">${task.status}</b></span>
            </div>
          </div>
        `;
        activeTasksContainer.appendChild(card);
      } else {
        // In-place reconciliation: update attributes without recreating DOM elements
        const nameEl = card.querySelector(".task-name-text");
        if (nameEl && nameEl.textContent !== task.name) {
          nameEl.textContent = task.name;
          nameEl.title = task.name;
        }

        // Only update control buttons if status actually changed (prevents hover flicker and click drops)
        if (card.dataset.status !== task.status) {
          card.dataset.status = task.status;
          const controls = card.querySelector(".task-controls");
          if (controls) {
            controls.innerHTML = getControlButtonsHtml(task);
          }
        }

        // Update progress header
        const dot = card.querySelector(".progress-dot");
        if (dot) {
          dot.style.background = m.dotBg;
          dot.style.boxShadow = `0 0 10px ${m.dotShadow}`;
        }
        const lbl = card.querySelector(".progress-label-text");
        if (lbl) {
          lbl.textContent = `Download Progress: ${m.progressLabel}`;
        }
        const sizeEl = card.querySelector(".progress-size-text");
        if (sizeEl) {
          sizeEl.textContent = `${m.downloadedDisplay} of ${m.totalDisplay}`;
        }

        // Update progress fill
        const fill = card.querySelector(".download-progress-fill");
        if (fill) {
          fill.style.width = m.displayBarWidth;
          if (m.isConnecting) {
            fill.classList.add("connecting-shimmer");
          } else {
            fill.classList.remove("connecting-shimmer");
          }
          if (task.status === "paused") {
            fill.style.background = "linear-gradient(90deg, #eab308, #ca8a04)";
          } else if (task.status === "completed" || task.status === "extracted") {
            fill.style.background = "linear-gradient(90deg, #10b981, #059669)";
          } else {
            fill.style.background = "";
          }
        }

        // Update workers count
        const workersEl = card.querySelector(".workers-count-text");
        if (workersEl) {
          workersEl.textContent = `${task.active_connections || 0} active workers • Work-Stealing Active`;
        }

        // Update chunk matrix blocks in-place
        const blocks = card.querySelectorAll(".chunk-matrix-grid .chunk-block");
        if (blocks.length === 32) {
          for (let i = 0; i < 32; i++) {
            const { blockClass, fillWidth } = getChunkBlockState(task, i, m.hasTotal, m.pct);
            const block = blocks[i];
            if (block.className !== blockClass) block.className = blockClass;
            const bFill = block.querySelector(".chunk-block-fill");
            if (bFill && bFill.style.width !== fillWidth) {
              bFill.style.width = fillWidth;
            }
          }
        }

        // Update stats bar
        const pctEl = card.querySelector(".stat-pct-val");
        if (pctEl) pctEl.textContent = m.hasTotal ? m.pct + '%' : '--';

        const dlEl = card.querySelector(".stat-dl-val");
        if (dlEl) dlEl.textContent = `${m.downloadedDisplay} of ${m.totalDisplay}`;

        const spEl = card.querySelector(".stat-speed-val");
        if (spEl) spEl.textContent = formatSpeed(task.speed);

        const etaEl = card.querySelector(".stat-eta-val");
        if (etaEl) etaEl.textContent = m.eta;

        const statEl = card.querySelector(".stat-status-val");
        if (statEl) {
          statEl.textContent = task.status;
          statEl.style.color = m.statusColor;
        }

        card.dataset.maxPct = m.pct;
      }
    });

    // Remove obsolete cards
    const activeIds = new Set(activeTasks.map(t => t.id));
    const currentCards = activeTasksContainer.querySelectorAll(".task-card");
    currentCards.forEach(c => {
      const cardId = c.getAttribute("data-task-id");
      if (cardId && !activeIds.has(cardId)) {
        c.remove();
      }
    });
  }

  // 2. Reconcile Completed Tasks
  if (completedTasksContainer) {
    if (completedTasks.length === 0) {
      if (!completedTasksContainer.querySelector(".empty-completed")) {
        completedTasksContainer.innerHTML = `<p class="empty-completed" style="color: var(--text-muted); padding: 20px 0;">No completed downloads yet.</p>`;
      }
    } else {
      const emptyMsg = completedTasksContainer.querySelector(".empty-completed");
      if (emptyMsg) emptyMsg.remove();

      completedTasks.forEach(task => {
        let item = completedTasksContainer.querySelector(`.completed-task-item[data-task-id="${task.id}"]`);
        if (!item) {
          item = document.createElement("div");
          item.className = "completed-task-item";
          item.setAttribute("data-task-id", task.id);
          item.style.cssText = `
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 14px 0;
            border-bottom: 1px solid var(--border-subtle);
          `;
          const finalSize = (task.total_bytes && task.total_bytes > 0) ? task.total_bytes : (task.downloaded_bytes || 0);
          item.innerHTML = `
            <div>
              <div class="completed-name" style="font-weight: 700; color: #fff; margin-bottom: 4px;">${task.name}</div>
              <div class="completed-meta" style="font-size: 11px; color: var(--text-muted);">
                Size: ${formatBytes(finalSize)} • Finished • Verified
              </div>
            </div>
            <div style="display: flex; gap: 8px;">
              <button class="btn-secondary" onclick="openFolder('${task.id}')">📂 Open Folder</button>
              ${task.name.match(/\.(zip|rar|7z)$/i) ? `<button class="btn-primary" onclick="extractTask('${task.id}')">📦 Extract</button>` : ''}
            </div>
          `;
          completedTasksContainer.appendChild(item);
        } else {
          // Update in-place if size or name updated
          const finalSize = (task.total_bytes && task.total_bytes > 0) ? task.total_bytes : (task.downloaded_bytes || 0);
          const cName = item.querySelector(".completed-name");
          if (cName && cName.textContent !== task.name) cName.textContent = task.name;
          const cMeta = item.querySelector(".completed-meta");
          if (cMeta) cMeta.textContent = `Size: ${formatBytes(finalSize)} • Finished • Verified`;
        }
      });

      // Remove obsolete completed tasks
      const completedIds = new Set(completedTasks.map(t => t.id));
      const currentCompleted = completedTasksContainer.querySelectorAll(".completed-task-item");
      currentCompleted.forEach(item => {
        const id = item.getAttribute("data-task-id");
        if (id && !completedIds.has(id)) {
          item.remove();
        }
      });
    }
  }
}

// Actions
window.pauseTask = async (id) => {
  await fetch(`${API_BASE}/api/tasks/${id}/pause`, {
    method: "POST",
    headers: { "X-HyperDrain-Token": AUTH_TOKEN }
  });
};

window.resumeTask = async (id) => {
  await fetch(`${API_BASE}/api/tasks/${id}/resume`, {
    method: "POST",
    headers: { "X-HyperDrain-Token": AUTH_TOKEN }
  });
};

// Universal Custom Modal Dialogs (Clean dark-glass UI, eliminates GTK tofu squares completely)
let modalResolver = null;
const uModal = document.getElementById("universal-modal");
const uTitle = document.getElementById("universal-modal-title");
const uIcon = document.getElementById("universal-modal-icon");
const uMsg = document.getElementById("universal-modal-message");
const uOkBtn = document.getElementById("universal-modal-ok");
const uCancelBtn = document.getElementById("universal-modal-cancel");
const uCloseBtn = document.getElementById("universal-modal-close");

function showCustomDialog(message, { title = "HyperDrain", icon = "⚡", okText = "Confirm", cancelText = "Cancel", isConfirm = false } = {}) {
  return new Promise((resolve) => {
    modalResolver = resolve;
    if (uTitle) uTitle.textContent = title;
    if (uIcon) uIcon.textContent = icon;
    if (uMsg) uMsg.textContent = message;
    if (uOkBtn) uOkBtn.textContent = okText;
    if (uCancelBtn) {
      uCancelBtn.textContent = cancelText;
      uCancelBtn.style.display = isConfirm ? "inline-block" : "none";
    }
    if (uModal) {
      uModal.style.display = "flex";
      uModal.classList.add("show");
    }
  });
}

function closeCustomDialog(result) {
  if (uModal) {
    uModal.classList.remove("show");
    uModal.style.display = "none";
  }
  if (modalResolver) {
    const res = modalResolver;
    modalResolver = null;
    res(result);
  }
}

if (uOkBtn) uOkBtn.addEventListener("click", () => closeCustomDialog(true));
if (uCancelBtn) uCancelBtn.addEventListener("click", () => closeCustomDialog(false));
if (uCloseBtn) uCloseBtn.addEventListener("click", () => closeCustomDialog(false));

window.customAlert = (msg, title = "HyperDrain") => showCustomDialog(msg, { title, icon: "⚡", okText: "OK", isConfirm: false });
window.customConfirm = (msg, title = "Confirmation") => showCustomDialog(msg, { title, icon: "⚠️", okText: "Remove", cancelText: "Cancel", isConfirm: true });

window.deleteTask = async (id) => {
  const confirmed = await window.customConfirm("Remove this download card from the list? (Completed files on your drive will NOT be deleted)");
  if (confirmed) {
    await fetch(`${API_BASE}/api/tasks/${id}/delete`, {
      method: "POST",
      headers: { "X-HyperDrain-Token": AUTH_TOKEN }
    });
    pollTasksFallback();
  }
};

const clearCompletedBtn = document.getElementById("clear-completed-btn");
if (clearCompletedBtn) {
  clearCompletedBtn.addEventListener("click", async () => {
    const confirmed = await window.customConfirm("Clear completed downloads from history? (Your downloaded files on disk will stay safe and untouched)");
    if (confirmed) {
      await fetch(`${API_BASE}/api/tasks/clear-completed`, {
        method: "POST",
        headers: { "X-HyperDrain-Token": AUTH_TOKEN }
      });
      pollTasksFallback();
    }
  });
}

window.extractTask = async (id) => {
  await fetch(`${API_BASE}/api/tasks/${id}/extract`, {
    method: "POST",
    headers: { "X-HyperDrain-Token": AUTH_TOKEN }
  });
  window.customAlert("Archive extraction started in background.");
};

// Modal controls
const addModal = document.getElementById("add-modal");
const openAddBtn = document.getElementById("open-add-modal");
const closeAddBtn = document.getElementById("close-modal-btn");
const cancelAddBtn = document.getElementById("cancel-modal-btn");
const startDownloadBtn = document.getElementById("start-download-btn");

openAddBtn.addEventListener("click", () => {
  loadSettings();
  addModal.classList.add("show");
});
closeAddBtn.addEventListener("click", () => addModal.classList.remove("show"));
cancelAddBtn.addEventListener("click", () => addModal.classList.remove("show"));

startDownloadBtn.addEventListener("click", async () => {
  const url = document.getElementById("modal-url").value.trim();
  const name = document.getElementById("modal-filename").value.trim();
  const targetDir = document.getElementById("modal-target-dir") ? document.getElementById("modal-target-dir").value.trim() : "";
  const conns = parseInt(document.getElementById("modal-conns").value, 10);
  const cookie = document.getElementById("modal-cookie").value.trim();
  const referer = document.getElementById("modal-referer").value.trim();

  if (!url) {
    window.customAlert("Please enter a valid URL or magnet link.");
    return;
  }

  try {
    startDownloadBtn.disabled = true;
    startDownloadBtn.innerHTML = `<span>Starting...</span>`;
    const res = await fetch(`${API_BASE}/api/tasks/add`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-HyperDrain-Token": AUTH_TOKEN
      },
      body: JSON.stringify({
        url: url,
        suggested_name: name,
        target_dir: targetDir,
        connections: conns,
        auto_extract: false,
        cookie: cookie,
        referer: referer
      })
    });

    if (res.ok) {
      document.getElementById("modal-url").value = "";
      document.getElementById("modal-filename").value = "";
      addModal.classList.remove("show");
      // Immediately switch to Active tab and refresh view so user sees the download progress live
      if (typeof switchTab === "function") {
        switchTab("active");
      }
      if (typeof initialLoadTasks === "function") {
        initialLoadTasks();
      }
    } else {
      const errText = await res.text();
      window.customAlert("Cannot start download: " + (errText.trim() || ("Error " + res.status)));
    }
  } catch (err) {
    window.customAlert("Could not reach HyperDrain engine: " + err.message);
  } finally {
    startDownloadBtn.disabled = false;
    startDownloadBtn.innerHTML = `<span>Start Download</span>`;
  }
});

// Allow Enter key to trigger download immediately from URL or filename inputs
["modal-url", "modal-filename"].forEach(inputId => {
  const el = document.getElementById(inputId);
  if (el) {
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        startDownloadBtn.click();
      }
    });
  }
});

// Settings Save
function updateProxyStatusBadge(data) {
  const statusEl = document.getElementById("cfg-proxy-status");
  if (!statusEl || !data) return;
  const configured = (data.proxy_url || "").trim();
  const effective = (data.effective_proxy_url || "").trim();
  if (!configured) {
    statusEl.textContent = "Direct Connection";
    statusEl.style.color = "#94a3b8";
  } else if (effective) {
    statusEl.textContent = `Active via ${effective}`;
    statusEl.style.color = "#34d399";
  } else {
    statusEl.textContent = `${configured} offline — Direct fallback active`;
    statusEl.style.color = "#fbbf24";
  }
}

document.querySelectorAll(".proxy-preset-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const proxyInput = document.getElementById("cfg-proxy");
    if (proxyInput) proxyInput.value = btn.getAttribute("data-proxy-preset") || "";
  });
});

const saveSettingsBtn = document.getElementById("save-settings-btn");
if (saveSettingsBtn) {
  saveSettingsBtn.addEventListener("click", async () => {
    const dir = document.getElementById("cfg-dir").value.trim();
    const conns = parseInt(document.getElementById("cfg-conns").value, 10);
    const maxActive = parseInt(document.getElementById("cfg-queue-max").value, 10);
    const token = document.getElementById("cfg-token").value.trim();
    const proxyInput = document.getElementById("cfg-proxy");
    const proxyFallbackEl = document.getElementById("cfg-proxy-fallback");
    const proxyUrl = proxyInput ? proxyInput.value.trim() : "";
    const proxyFallback = proxyFallbackEl ? proxyFallbackEl.checked : true;

    const res = await fetch(`${API_BASE}/api/settings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-HyperDrain-Token": AUTH_TOKEN
      },
      body: JSON.stringify({
        download_dir: dir,
        default_connections: conns,
        max_concurrent_tasks: maxActive,
        auto_extract: false,
        auth_token: token,
        proxy_url: proxyUrl,
        proxy_fallback: proxyFallback
      })
    });
    if (!res.ok) {
      const errMsg = await res.text();
      alert(`Failed to save settings: ${errMsg || res.statusText}`);
      return;
    }
    const updated = await res.json();
    if (proxyInput && typeof updated.proxy_url === "string") {
      proxyInput.value = updated.proxy_url;
    }
    updateProxyStatusBadge(updated);
    if (window.electronAPI && typeof window.electronAPI.syncBrowserProxy === "function") {
      try { await window.electronAPI.syncBrowserProxy(); } catch (_) {}
    }
    alert("Settings saved successfully.");
  });
}

// Test Notification Button
const testNotifBtn = document.getElementById("test-notif-btn");
if (testNotifBtn) {
  testNotifBtn.addEventListener("click", async () => {
    // 1. Request browser notification permission if not yet granted
    if ("Notification" in window && Notification.permission === "default") {
      await Notification.requestPermission();
    }

    // 2. Play WebAudio chime
    playWebAudioChime();

    // 3. Trigger in-app toast
    showInAppCelebrationToast({
      id: "test",
      name: "Notification Test Successful!",
      total_bytes: 4309756789
    });

    // 4. Trigger desktop notification if in Electron, or browser notification if granted
    if (window.electronAPI && typeof window.electronAPI.showNotification === "function") {
      window.electronAPI.showNotification("HyperDrain ⚡ Notification Test", "Desktop notifications are working perfectly!");
    } else if ("Notification" in window && Notification.permission === "granted") {
      new Notification("HyperDrain ⚡ Notification Test", {
        body: "Browser and desktop notifications are working perfectly!",
        icon: "/icon.png"
      });
    }

    // 5. Trigger native Ubuntu desktop notification + Ubuntu sound from engine
    try {
      await fetch(`${API_BASE}/api/test-notification`);
    } catch (e) {
      console.warn("Engine test-notification endpoint failed:", e);
    }
  });
}

// Native folder picker triggers
const modalBrowseBtn = document.getElementById("modal-browse-btn");
if (modalBrowseBtn) {
  modalBrowseBtn.addEventListener("click", async () => {
    try {
      modalBrowseBtn.disabled = true;
      modalBrowseBtn.textContent = "Choosing...";
      if (window.electronAPI && window.electronAPI.chooseFolder) {
        const cur = document.getElementById("modal-target-dir").value;
        const res = await window.electronAPI.chooseFolder(cur);
        if (!res.cancelled && res.path) {
          document.getElementById("modal-target-dir").value = res.path;
        }
        return;
      }
      const res = await fetch(`${API_BASE}/api/choose-folder`, { method: "POST" });
      if (res.ok) {
        const data = await res.json();
        if (!data.cancelled && data.path) {
          document.getElementById("modal-target-dir").value = data.path;
        }
      }
    } finally {
      modalBrowseBtn.disabled = false;
      modalBrowseBtn.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
        </svg>
        <span>Browse...</span>`;
    }
  });
}

const cfgBrowseBtn = document.getElementById("cfg-browse-btn");
if (cfgBrowseBtn) {
  cfgBrowseBtn.addEventListener("click", async () => {
    try {
      cfgBrowseBtn.disabled = true;
      cfgBrowseBtn.textContent = "Choosing...";
      if (window.electronAPI && window.electronAPI.chooseFolder) {
        const cur = document.getElementById("cfg-dir").value;
        const res = await window.electronAPI.chooseFolder(cur);
        if (!res.cancelled && res.path) {
          document.getElementById("cfg-dir").value = res.path;
        }
        return;
      }
      const res = await fetch(`${API_BASE}/api/choose-folder`, { method: "POST" });
      if (res.ok) {
        const data = await res.json();
        if (!data.cancelled && data.path) {
          document.getElementById("cfg-dir").value = data.path;
        }
      }
    } finally {
      cfgBrowseBtn.disabled = false;
      cfgBrowseBtn.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
        </svg>
        <span>Browse...</span>`;
    }
  });
}

// Load settings dynamically from engine
async function loadSettings() {
  try {
    const res = await fetch(`${API_BASE}/api/settings`);
    if (res.ok) {
      const data = await res.json();
      if (data && data.download_dir) {
        const cfgDir = document.getElementById("cfg-dir");
        if (cfgDir) cfgDir.value = data.download_dir;
        const modalTargetDir = document.getElementById("modal-target-dir");
        if (modalTargetDir) modalTargetDir.value = data.download_dir;
      }
      if (data && data.default_connections && document.getElementById("cfg-conns")) {
        document.getElementById("cfg-conns").value = data.default_connections;
      }
      if (data && data.max_concurrent_tasks && document.getElementById("cfg-queue-max")) {
        document.getElementById("cfg-queue-max").value = data.max_concurrent_tasks;
      }
      const proxyInput = document.getElementById("cfg-proxy");
      if (proxyInput && typeof data.proxy_url === "string") {
        proxyInput.value = data.proxy_url;
      }
      const proxyFallbackEl = document.getElementById("cfg-proxy-fallback");
      if (proxyFallbackEl && typeof data.proxy_fallback === "boolean") {
        proxyFallbackEl.checked = data.proxy_fallback;
      }
      updateProxyStatusBadge(data);
    }
  } catch (e) {
    console.error("Failed to load settings:", e);
  }
}
loadSettings();

// Immediately load tasks on startup
async function initialLoadTasks() {
  try {
    const res = await fetch(`${API_BASE}/api/tasks`, {
      headers: { "X-HyperDrain-Token": AUTH_TOKEN }
    });
    if (res.ok) {
      const tasks = await res.json();
      if (tasks) renderTasks(tasks);
    }
  } catch(e) {}
}
initialLoadTasks();

// Initial connection
connectWS();

// HTTP Task Polling Fallback (only polls when WebSocket is disconnected to save CPU)
async function pollTasksFallback() {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  try {
    const res = await fetch(`${API_BASE}/api/tasks`, {
      headers: { "X-HyperDrain-Token": AUTH_TOKEN }
    });
    if (res.ok) {
      const tasks = await res.json();
      if (tasks) {
        renderTasks(tasks);
      }
    }
  } catch(e) {}
}
pollTasksFallback();
setInterval(pollTasksFallback, 2500);

// =========================================================
// ⚡ Desktop Titlebar Controls
// =========================================================
const btnMin = document.getElementById("btn-win-min");
const btnMax = document.getElementById("btn-win-max");
const btnClose = document.getElementById("btn-win-close");
const titlebarControls = document.getElementById("titlebar-controls");
const titlebarLiveSpeed = document.getElementById("titlebar-live-speed");

if (window.electronAPI) {
  if (btnMin) btnMin.addEventListener("click", () => window.electronAPI.minimizeWindow());
  if (btnMax) btnMax.addEventListener("click", () => window.electronAPI.maximizeWindow());
  if (btnClose) btnClose.addEventListener("click", () => window.electronAPI.closeWindow());
} else {
  // If running in browser outside Electron, hide native window control buttons
  if (titlebarControls) titlebarControls.style.display = "none";
}

// =========================================================
// 🧩 Universal Browser Extension Hub Controller
// =========================================================
const extExportZipBtn = document.getElementById("ext-export-zip-btn");
const extOpenFolderBtn = document.getElementById("ext-open-folder-btn");
const extCopyPathBtn = document.getElementById("ext-copy-path-btn");

const BROWSER_ICONS = {
  chrome: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#4285F4"/><circle cx="12" cy="12" r="4.2" fill="#ffffff"/><path d="M12 2a10 10 0 0 1 8.66 5l-4.33 7.5A5 5 0 0 0 12 7V2z" fill="#EA4335"/><path d="M20.66 7A10 10 0 0 1 12 22v-5a5 5 0 0 0 4.33-2.5l4.33-7.5z" fill="#FBBC05"/><path d="M12 22A10 10 0 0 1 3.34 7l4.33 2.5A5 5 0 0 0 12 17v5z" fill="#34A853"/></svg>`,
  brave: `<svg viewBox="0 0 24 24" fill="#FB542B"><path d="M12 2L4 5v6c0 5.55 3.84 10.74 8 12 4.16-1.26 8-6.45 8-12V5l-8-3zm0 3.2l5 2v4.8c0 3.87-2.67 7.48-5 8.5-2.33-1.02-5-4.63-5-8.5V7.2l5-2z"/></svg>`,
  edge: `<svg viewBox="0 0 24 24" fill="#0078D7"><path d="M21.5 12.8c-.3-4.2-3.8-7.5-8.1-7.5-3.8 0-7 2.6-7.8 6.2 1.3-.9 2.8-1.4 4.5-1.4 3.7 0 6.6 2.8 6.6 6.3 0 .4 0 .9-.1 1.3 2.8-.7 4.9-3.2 4.9-4.9zm-9.3-5c2.4 0 4.4 1.8 4.7 4.1-1.3-.7-2.8-1.1-4.4-1.1-3.6 0-6.6 2.6-7.1 6-.1-.5-.1-1-.1-1.5 0-4.1 3.1-7.5 6.9-7.5zm-5 11c1.3 1.9 3.5 3.2 6 3.2 4.1 0 7.5-3.1 7.8-7-1.4 1-3.2 1.6-5.1 1.6-4.2 0-7.7-3.1-8.1-7.1-.6 1.4-.9 3-.9 4.7 0 1.8.6 3.4 1.6 4.7z"/></svg>`,
  firefox: `<svg viewBox="0 0 24 24" fill="#FF7139"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79.09.28.2.56.34.82.91 1.76 2.83 2.97 4.95 2.97 1.5 0 2.86-.61 3.84-1.59.39-.39.7-.85.93-1.36.08-.18.15-.36.2-.55.33.68.53 1.45.53 2.26 0 2.83-2.11 5.16-4.9 5.48z"/></svg>`
};

async function loadDetectedBrowsers() {
  const container = document.getElementById("ext-browsers-grid");
  if (!container) return;

  let browsers = [];
  if (window.electronAPI && window.electronAPI.detectBrowsers) {
    try {
      browsers = await window.electronAPI.detectBrowsers();
    } catch (e) {
      console.warn("Failed to detect browsers:", e);
    }
  }

  if (!browsers || browsers.length === 0) {
    browsers = [
      { id: 'chrome', name: 'Google Chrome', extUrl: 'chrome://extensions', installed: true },
      { id: 'brave', name: 'Brave Browser', extUrl: 'brave://extensions', installed: true },
      { id: 'edge', name: 'Microsoft Edge', extUrl: 'edge://extensions', installed: false },
      { id: 'firefox', name: 'Mozilla Firefox', extUrl: 'about:debugging#/runtime/this-firefox', installed: false }
    ];
  }

  container.innerHTML = browsers.map(b => {
    const icon = BROWSER_ICONS[b.id] || `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="12" cy="12" r="10"/></svg>`;
    const statusText = b.installed ? 'Installed' : 'Not Detected';
    const statusClass = b.installed ? 'installed' : 'not-installed';
    const btnText = b.installed ? 'Connect' : 'Guide';
    const btnClass = b.installed ? 'btn-connect-browser' : 'btn-connect-browser btn-browser-guide';

    return `
      <div class="ext-browser-card" data-browser="${b.id}">
        <div class="ext-browser-top">
          <div class="ext-browser-icon">${icon}</div>
          <span class="ext-browser-status ${statusClass}">
            <span class="status-dot"></span>
            ${statusText}
          </span>
        </div>
        <div class="ext-browser-meta">
          <span class="ext-browser-name">${b.name}</span>
          <span class="ext-browser-sub">${b.installed ? 'Ready to connect' : 'Manual setup guide'}</span>
        </div>
        <button class="${btnClass}" data-id="${b.id}">
          <span>${btnText}</span>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"></polyline></svg>
        </button>
      </div>
    `;
  }).join('');

  // Attach click listeners to Connect buttons
  container.querySelectorAll(".btn-connect-browser").forEach(btn => {
    btn.addEventListener("click", async () => {
      const bId = btn.getAttribute("data-id");
      if (window.electronAPI && window.electronAPI.connectBrowser) {
        btn.disabled = true;
        const res = await window.electronAPI.connectBrowser(bId);
        btn.disabled = false;
        if (res && res.success) {
          showGlobalToast(`Extension path copied! In ${res.browser}, click 'Load unpacked' and press Ctrl+V`, "success");
        } else {
          showGlobalToast("Failed to connect browser. Try copying path manually.", "warning");
        }
      } else {
        if (navigator.clipboard) {
          navigator.clipboard.writeText("extension");
        }
        showGlobalToast("Please load unpacked extension from the extension folder", "info");
      }
    });
  });
}

if (extCopyPathBtn) {
  extCopyPathBtn.addEventListener("click", async () => {
    if (window.electronAPI && window.electronAPI.copyExtensionPath) {
      const res = await window.electronAPI.copyExtensionPath();
      if (res && res.success) {
        showGlobalToast("Extension folder path copied to clipboard!", "success");
      } else {
        showGlobalToast("Could not copy path automatically.", "warning");
      }
    } else if (navigator.clipboard) {
      await navigator.clipboard.writeText("/home/hamza/Downloads/HyperDrain-Extension");
      showGlobalToast("Extension path copied to clipboard!", "success");
    }
  });
}

if (extExportZipBtn) {
  extExportZipBtn.addEventListener("click", async () => {
    if (window.electronAPI && window.electronAPI.exportExtensionZip) {
      extExportZipBtn.disabled = true;
      extExportZipBtn.textContent = "Exporting ZIP...";
      const res = await window.electronAPI.exportExtensionZip();
      extExportZipBtn.disabled = false;
      extExportZipBtn.innerHTML = `
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
        <span>Export Extension (.zip)</span>`;
      if (res && res.success) {
        showGlobalToast("Extension ZIP successfully exported to: " + res.path, "success");
      } else if (res && !res.cancelled) {
        const a = document.createElement("a");
        a.href = "/api/extension.zip";
        a.download = "HyperDrain-Browser-Extension.zip";
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
    } else {
      const a = document.createElement("a");
      a.href = "/api/extension.zip";
      a.download = "HyperDrain-Browser-Extension.zip";
      document.body.appendChild(a);
      a.click();
      a.remove();
      showGlobalToast("Downloading HyperDrain Extension ZIP...", "info");
    }
  });
}

if (extOpenFolderBtn) {
  extOpenFolderBtn.addEventListener("click", async () => {
    if (window.electronAPI && window.electronAPI.openExtensionFolder) {
      const opened = await window.electronAPI.openExtensionFolder();
      if (!opened) {
        const a = document.createElement("a");
        a.href = "/api/extension.zip";
        a.download = "HyperDrain-Browser-Extension.zip";
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
    } else {
      const a = document.createElement("a");
      a.href = "/api/extension.zip";
      a.download = "HyperDrain-Browser-Extension.zip";
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
  });
}

// Initial browser detection on startup
loadDetectedBrowsers();

// =========================================================
// 🚀 Online Auto-Update Engine Controller
// =========================================================
const updaterState = {
  availableUpdate: null,
  isDownloading: false,
  isReadyToInstall: false,
  downloadedInstallerPath: ''
};

const btnUpdateAvailable = document.getElementById("btn-update-available");
const btnUpdateText = document.getElementById("btn-update-text");
const updateModal = document.getElementById("updateModal");
const btnCloseUpdateModal = document.getElementById("btnCloseUpdateModal");
const btnUpdateDismiss = document.getElementById("btnUpdateDismiss");
const btnUpdateExecute = document.getElementById("btnUpdateExecute");
const btnUpdateExecuteText = document.getElementById("btnUpdateExecuteText");
const updateBadgeCurrent = document.getElementById("updateBadgeCurrent");
const updateBadgeLatest = document.getElementById("updateBadgeLatest");
const updateModalVersionSub = document.getElementById("updateModalVersionSub");
const updateChangelogContent = document.getElementById("updateChangelogContent");
const updateProgressBlock = document.getElementById("updateProgressBlock");
const updateBgBanner = document.getElementById("updateBgBanner");
const updateProgressBarFill = document.getElementById("updateProgressBarFill");
const updateProgressPercent = document.getElementById("updateProgressPercent");
const updateProgressLabel = document.getElementById("updateProgressLabel");
const btnManualCheckUpdate = document.getElementById("btn-manual-check-update");
const manualUpdateResult = document.getElementById("manual-update-result");

function openUpdateModal() {
  if (updateModal) {
    updateModal.style.display = "flex";
  }
}

function closeUpdateModal() {
  if (updateModal) {
    updateModal.style.display = "none";
  }
}

function handleUpdateAvailable(res, autoOpen = false) {
  if (!res || !res.updateAvailable) {
    if (btnUpdateAvailable) btnUpdateAvailable.style.display = "none";
    return;
  }

  updaterState.availableUpdate = res;
  const latestVer = 'v' + String(res.latestVersion || '1.0.9').replace(/^v/, '');
  const currentVer = 'v' + String(res.currentVersion || '1.0.9').replace(/^v/, '');

  if (btnUpdateAvailable) {
    btnUpdateAvailable.style.display = "inline-flex";
    btnUpdateAvailable.title = `New update ${latestVer} available! Click to inspect.`;
  }
  if (btnUpdateText) {
    btnUpdateText.textContent = `Update ${latestVer} Available`;
  }
  if (updateBadgeCurrent) {
    updateBadgeCurrent.textContent = currentVer;
  }
  if (updateBadgeLatest) {
    updateBadgeLatest.textContent = latestVer;
  }
  if (updateModalVersionSub) {
    updateModalVersionSub.textContent = `HyperDrain ${latestVer} is ready for installation`;
  }
  if (updateChangelogContent) {
    updateChangelogContent.textContent = res.releaseNotes || 'Performance optimizations, accelerated multi-stream downloading, and stability improvements.';
  }

  if (autoOpen) {
    openUpdateModal();
  }
}

async function triggerCheckForUpdates(manual = false) {
  if (manual && manualUpdateResult) {
    manualUpdateResult.style.display = "block";
    manualUpdateResult.className = "update-result-msg update-result-info";
    manualUpdateResult.textContent = "Checking for online updates...";
  }

  if (!window.electronAPI || !window.electronAPI.checkForUpdates) {
    if (manual && manualUpdateResult) {
      manualUpdateResult.className = "update-result-msg update-result-info";
      manualUpdateResult.textContent = "Online updater is active in native desktop mode.";
    }
    return;
  }

  try {
    const res = await window.electronAPI.checkForUpdates();
    if (res && res.updateAvailable) {
      handleUpdateAvailable(res, manual);
      if (manual && manualUpdateResult) {
        manualUpdateResult.className = "update-result-msg update-result-success";
        manualUpdateResult.textContent = `New update ${res.latestVersion} is available!`;
      }
    } else {
      if (manual) {
        updaterState.availableUpdate = null;
        if (btnUpdateAvailable && !updaterState.isReadyToInstall) {
          btnUpdateAvailable.style.display = "none";
        }
        if (manualUpdateResult) {
          manualUpdateResult.className = "update-result-msg update-result-success";
          const currentV = (res && res.currentVersion) ? `v${res.currentVersion}` : 'v1.0.9';
          manualUpdateResult.textContent = `HyperDrain is up to date (${currentV}). No updates available.`;
        }
      } else if (!updaterState.availableUpdate && btnUpdateAvailable && !updaterState.isReadyToInstall) {
        btnUpdateAvailable.style.display = "none";
      }
    }
  } catch (err) {
    if (manual && manualUpdateResult) {
      manualUpdateResult.className = "update-result-msg update-result-warn";
      manualUpdateResult.textContent = "Could not check for online updates: " + (err.message || "Network error");
    }
  }
}

window.handleUpdateAvailable = handleUpdateAvailable;
window.triggerCheckForUpdates = triggerCheckForUpdates;
window.openUpdateModal = openUpdateModal;
window.closeUpdateModal = closeUpdateModal;
window.renderTasks = renderTasks;

if (btnUpdateAvailable) {
  btnUpdateAvailable.addEventListener("click", () => {
    openUpdateModal();
  });
}

if (btnCloseUpdateModal) {
  btnCloseUpdateModal.addEventListener("click", () => {
    closeUpdateModal();
  });
}

if (btnUpdateDismiss) {
  btnUpdateDismiss.addEventListener("click", () => {
    closeUpdateModal();
  });
}

if (btnManualCheckUpdate) {
  btnManualCheckUpdate.addEventListener("click", () => {
    triggerCheckForUpdates(true);
  });
}

if (btnUpdateExecute) {
  btnUpdateExecute.addEventListener("click", async () => {
    // If ready to install, execute restart & install
    if (updaterState.isReadyToInstall && updaterState.downloadedInstallerPath) {
      if (btnUpdateExecuteText) btnUpdateExecuteText.textContent = "Installing...";
      btnUpdateExecute.disabled = true;
      try {
        await window.electronAPI.installUpdate(updaterState.downloadedInstallerPath);
      } catch (e) {
        alert("Failed to trigger update script: " + e.message);
        btnUpdateExecute.disabled = false;
        if (btnUpdateExecuteText) btnUpdateExecuteText.textContent = "Restart & Update";
      }
      return;
    }

    if (!updaterState.availableUpdate || !updaterState.availableUpdate.downloadUrl) {
      alert("No update download package available for this platform.");
      return;
    }

    if (updaterState.isDownloading) return;
    updaterState.isDownloading = true;

    btnUpdateExecute.disabled = true;
    if (btnUpdateExecuteText) btnUpdateExecuteText.textContent = "Downloading...";
    if (updateProgressBlock) updateProgressBlock.style.display = "block";
    if (updateBgBanner) updateBgBanner.style.display = "flex";

    try {
      const res = await window.electronAPI.downloadUpdate(updaterState.availableUpdate.downloadUrl);
      updaterState.isDownloading = false;
      if (res && res.success) {
        updaterState.isReadyToInstall = true;
        updaterState.downloadedInstallerPath = res.path;
        btnUpdateExecute.disabled = false;
        if (btnUpdateExecuteText) btnUpdateExecuteText.textContent = "Restart & Update";
        if (updateProgressBarFill) updateProgressBarFill.style.width = "100%";
        if (updateProgressPercent) updateProgressPercent.textContent = "100%";
        if (updateProgressLabel) updateProgressLabel.textContent = "Download complete! Ready to install.";
      } else {
        btnUpdateExecute.disabled = false;
        if (btnUpdateExecuteText) btnUpdateExecuteText.textContent = "Retry Update";
        if (updateProgressLabel) updateProgressLabel.textContent = "Download failed: " + (res.error || "Unknown error");
      }
    } catch (err) {
      updaterState.isDownloading = false;
      btnUpdateExecute.disabled = false;
      if (btnUpdateExecuteText) btnUpdateExecuteText.textContent = "Retry Update";
      if (updateProgressLabel) updateProgressLabel.textContent = "Update failed: " + err.message;
    }
  });
}

// Progress listener from Electron
if (window.electronAPI && window.electronAPI.onUpdateDownloadProgress) {
  window.electronAPI.onUpdateDownloadProgress((prog) => {
    if (!prog) return;
    if (updateProgressBarFill) updateProgressBarFill.style.width = `${prog.percent}%`;
    if (updateProgressPercent) updateProgressPercent.textContent = `${prog.percent}%`;
    const mb = (prog.transferred / (1024 * 1024)).toFixed(1);
    const totalMb = (prog.total / (1024 * 1024)).toFixed(1);
    const speedMb = prog.speed ? ` • ${(prog.speed / (1024 * 1024)).toFixed(2)} MB/s` : '';
    if (updateProgressLabel) {
      updateProgressLabel.textContent = `Downloading (${mb} / ${totalMb} MB${speedMb})...`;
    }
    if (btnUpdateText) {
      btnUpdateText.textContent = `Updating (${prog.percent}%)`;
    }
  });
}

// Handle update available detected in background
if (window.electronAPI && window.electronAPI.onUpdateAvailableDetected) {
  window.electronAPI.onUpdateAvailableDetected((info) => {
    if (info && info.updateAvailable) {
      handleUpdateAvailable(info, false);
    }
  });
}

// Check for updates in background after 3s, then every 2 hours
setTimeout(() => triggerCheckForUpdates(false), 3000);
setInterval(() => triggerCheckForUpdates(false), 2 * 60 * 60 * 1000);

// =========================================================
// 📂 Global Task Action Helpers
// =========================================================
window.openFolder = async function(taskId) {
  try {
    const res = await fetch(`${API_BASE}/api/tasks`);
    if (res.ok) {
      const tasks = await res.json();
      const task = tasks.find(t => t.id === taskId);
      if (task) {
        if (window.electronAPI && window.electronAPI.showItemInFolder) {
          window.electronAPI.showItemInFolder(task.target_file || task.name);
          return;
        }
      }
    }
    await fetch(`${API_BASE}/api/tasks/${taskId}/open`, { method: "POST" });
  } catch (e) {
    console.error("Open folder failed:", e);
  }
};

window.extractTask = async function(taskId) {
  try {
    await fetch(`${API_BASE}/api/tasks/${taskId}/extract`, { method: "POST" });
  } catch (e) {
    console.error("Extract failed:", e);
  }
};

window.renderTasks = renderTasks;
window.computeTaskMetrics = computeTaskMetrics;

// =========================================================
// Search & Discover (TMDB Movie Catalog)
// =========================================================
const TMDB_API_BASE = "https://api.themoviedb.org/3";
const TMDB_IMG_W342 = "https://image.tmdb.org/t/p/w342";
const TMDB_IMG_W780 = "https://image.tmdb.org/t/p/w780";
const TMDB_READ_TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiIyMWJkYWE2MDhjMmE3ODZhMWVmNDUxNjk0OGI5OTRiZiIsIm5iZiI6MTc5NDQyMDQ5NC44OTUsInN1YiI6IjZhZjRhZjBlY2U3OWMwNDBjMGM1ODU0MiIsInNjb3BlcyI6WyJhcGlfcmVhZCJdLCJ2ZXJzaW9uIjoxfQ.mXtls09jIiuhxQoeOHGIGyQZIp-KH_MPYQP2ashaH0o";

const DISCOVER_DEFAULT_MOVIE_GENRES = [
  { id: 28, name: "Action" }, { id: 12, name: "Adventure" }, { id: 16, name: "Animation" },
  { id: 35, name: "Comedy" }, { id: 80, name: "Crime" }, { id: 99, name: "Documentary" },
  { id: 18, name: "Drama" }, { id: 10751, name: "Family" }, { id: 14, name: "Fantasy" },
  { id: 36, name: "History" }, { id: 27, name: "Horror" }, { id: 10402, name: "Music" },
  { id: 9648, name: "Mystery" }, { id: 10749, name: "Romance" }, { id: 878, name: "Science Fiction" },
  { id: 10770, name: "TV Movie" }, { id: 53, name: "Thriller" }, { id: 10752, name: "War" },
  { id: 37, name: "Western" }
];

const DISCOVER_DEFAULT_TV_GENRES = [
  { id: 10759, name: "Action & Adventure" }, { id: 16, name: "Animation" }, { id: 35, name: "Comedy" },
  { id: 80, name: "Crime" }, { id: 99, name: "Documentary" }, { id: 18, name: "Drama" },
  { id: 10751, name: "Family" }, { id: 10762, name: "Kids" }, { id: 9648, name: "Mystery" },
  { id: 10763, name: "News" }, { id: 10764, name: "Reality" }, { id: 10765, name: "Sci-Fi & Fantasy" },
  { id: 10766, name: "Soap" }, { id: 10767, name: "Talk" }, { id: 10768, name: "War & Politics" },
  { id: 37, name: "Western" }
];

const DISCOVER_MEDIA_CONFIG = {
  movies: {
    label: "Movies",
    singular: "movie",
    tmdbType: "movie",
    placeholder: "Search movies by title (e.g. Inception, Night of the Living Dead)...",
    sectionLabels: { latest: "Latest Movies", popular: "Most Viewed", top: "Top Rated" }
  },
  series: {
    label: "Web Series",
    singular: "web series",
    tmdbType: "tv",
    placeholder: "Search web series & TV shows (e.g. Breaking Bad, Dark, Stranger Things)...",
    sectionLabels: { latest: "Latest Series", popular: "Most Viewed", top: "Top Rated" }
  },
  anime: {
    label: "Anime",
    singular: "anime",
    tmdbType: "tv",
    placeholder: "Search anime series & films (e.g. Attack on Titan, Spirited Away)...",
    sectionLabels: { latest: "Latest Anime", popular: "Most Viewed", top: "Top Anime Films" }
  },
  animation: {
    label: "Animation",
    singular: "animated title",
    tmdbType: "movie",
    placeholder: "Search animated movies & series (e.g. Spider-Verse, Arcane)...",
    sectionLabels: { latest: "Latest Animated", popular: "Most Viewed", top: "Top Animated Series" }
  }
};

const DISCOVER_DEFAULT_LANGUAGES = [
  { iso_639_1: "en", english_name: "English" },
  { iso_639_1: "ja", english_name: "Japanese" },
  { iso_639_1: "hi", english_name: "Hindi" },
  { iso_639_1: "ur", english_name: "Urdu" },
  { iso_639_1: "ko", english_name: "Korean" },
  { iso_639_1: "zh", english_name: "Chinese" },
  { iso_639_1: "es", english_name: "Spanish" },
  { iso_639_1: "fr", english_name: "French" },
  { iso_639_1: "de", english_name: "German" },
  { iso_639_1: "ar", english_name: "Arabic" },
  { iso_639_1: "it", english_name: "Italian" },
  { iso_639_1: "pt", english_name: "Portuguese" },
  { iso_639_1: "ru", english_name: "Russian" },
  { iso_639_1: "tr", english_name: "Turkish" },
  { iso_639_1: "ta", english_name: "Tamil" },
  { iso_639_1: "te", english_name: "Telugu" },
  { iso_639_1: "id", english_name: "Indonesian" },
  { iso_639_1: "th", english_name: "Thai" },
  { iso_639_1: "vi", english_name: "Vietnamese" },
  { iso_639_1: "fa", english_name: "Persian" },
  { iso_639_1: "pl", english_name: "Polish" },
  { iso_639_1: "nl", english_name: "Dutch" },
  { iso_639_1: "tl", english_name: "Tagalog" }
];

const discoverState = {
  activeMedia: "movies",
  loadedByMedia: {},
  loadingMedia: null,
  activeFilter: "all",
  expanded: { latest: false, popular: false, top: false },
  sectionsByMedia: {
    movies: { latest: [], popular: [], top: [] },
    series: { latest: [], popular: [], top: [] },
    anime: { latest: [], popular: [], top: [] },
    animation: { latest: [], popular: [], top: [] }
  },
  genres: {
    movie: [...DISCOVER_DEFAULT_MOVIE_GENRES],
    tv: [...DISCOVER_DEFAULT_TV_GENRES]
  },
  genresLoaded: false,
  languages: [...DISCOVER_DEFAULT_LANGUAGES],
  languagesLoaded: false,
  filters: {
    genre: "",
    year: "",
    rating: "",
    sort: "popularity.desc"
  },
  activePage: "browse",
  activeDetailKey: null,
  movieCache: new Map(),
  seasonCache: new Map(),
  activeSeasonNum: 1,
  seasonLookupToken: 0,
  queryToken: 0
};

const discoverAcState = {
  timer: null,
  controller: null,
  activeIndex: -1,
  items: []
};

function escapeDiscoverHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function openDiscoverExternalUrl(url) {
  if (!url) return;
  if (window.electronAPI && window.electronAPI.openExternal) {
    window.electronAPI.openExternal(url);
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

async function tmdbFetch(path, options = {}) {
  const res = await fetch(`${TMDB_API_BASE}${path}`, {
    signal: options.signal,
    headers: {
      "Authorization": `Bearer ${TMDB_READ_TOKEN}`,
      "Accept": "application/json"
    }
  });
  if (!res.ok) {
    throw new Error(`TMDB HTTP ${res.status}`);
  }
  return res.json();
}

function formatDiscoverSkeletons(count = 10) {
  return Array.from({ length: count }, () => '<div class="movie-skeleton"></div>').join("");
}

function normalizeDiscoverItem(raw, forcedMediaType = "movie") {
  if (!raw || typeof raw !== "object") return null;
  const mediaType = raw._mediaType || raw.media_type || forcedMediaType;
  const normalizedType = mediaType === "tv" ? "tv" : "movie";
  const cacheKey = `${normalizedType}:${Number(raw.id)}`;
  const item = {
    ...raw,
    _mediaType: normalizedType,
    _cacheKey: cacheKey
  };
  discoverState.movieCache.set(cacheKey, item);
  return item;
}

function getItemTitle(item) {
  return item.title || item.name || item.original_title || item.original_name || "Untitled";
}

function getItemDate(item) {
  return item.release_date || item.first_air_date || "";
}

function buildMovieCardHtml(item, rankIndex = null) {
  const mediaType = item._mediaType === "tv" ? "tv" : "movie";
  const title = escapeDiscoverHtml(getItemTitle(item));
  const rawDate = getItemDate(item);
  const year = rawDate ? escapeDiscoverHtml(rawDate.slice(0, 4)) : "TBA";
  const ratingNum = typeof item.vote_average === "number" ? item.vote_average : 0;
  const ratingText = ratingNum > 0 ? ratingNum.toFixed(1) : "NR";
  const typePrefix = (discoverState.activeMedia === "anime" || discoverState.activeMedia === "animation")
    ? (mediaType === "tv" ? "Series" : "Movie")
    : (item.vote_count ? `${item.vote_count >= 1000 ? (item.vote_count / 1000).toFixed(1) + "k" : item.vote_count} votes` : "TMDB");
  const origLangTag = item.original_language ? String(item.original_language).toUpperCase() : "";
  const posterUrl = item.poster_path ? `${TMDB_IMG_W342}${item.poster_path}` : "";

  const posterHtml = posterUrl
    ? `<img class="movie-poster-img" src="${escapeDiscoverHtml(posterUrl)}" alt="${title}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';" />
       <div class="movie-poster-fallback" style="display:none;">
         <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"></rect><line x1="7" y1="2" x2="7" y2="22"></line><line x1="17" y1="2" x2="17" y2="22"></line><line x1="2" y1="12" x2="22" y2="12"></line></svg>
         <span>${title}</span>
       </div>`
    : `<div class="movie-poster-fallback">
         <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"></rect><line x1="7" y1="2" x2="7" y2="22"></line><line x1="17" y1="2" x2="17" y2="22"></line><line x1="2" y1="12" x2="22" y2="12"></line></svg>
         <span>${title}</span>
       </div>`;

  const rankBadge = rankIndex !== null ? `<span class="movie-rank-badge">#${rankIndex + 1}</span>` : "";

  return `
    <button type="button" class="movie-card" data-movie-id="${Number(item.id)}" data-media-type="${mediaType}" aria-label="${title}">
      <div class="movie-poster-wrap">
        ${posterHtml}
        <div class="movie-poster-scrim"></div>
        <div class="movie-poster-badges">
          ${rankBadge}
          <span class="movie-rating-badge"><span class="movie-star">&#9733;</span> ${ratingText}</span>
        </div>
        <div class="movie-poster-caption">
          <div class="movie-card-title">${title}</div>
          <div class="movie-card-meta">
            <span>${year}${origLangTag ? ` &bull; ${escapeDiscoverHtml(origLangTag)}` : ""}</span>
            <span class="movie-card-votes">${escapeDiscoverHtml(typePrefix)}</span>
          </div>
          <span class="movie-hover-cta">View Details &rarr;</span>
        </div>
      </div>
    </button>
  `;
}

function renderDiscoverGrid(containerId, items, limit = null, showRank = false) {
  const el = document.getElementById(containerId);
  if (!el) return;
  if (!Array.isArray(items) || items.length === 0) {
    el.innerHTML = `<div class="discover-empty-state">No titles found matching these criteria right now.</div>`;
    return;
  }
  const sliced = limit ? items.slice(0, limit) : items;
  el.innerHTML = sliced.map((m, idx) => buildMovieCardHtml(m, showRank ? idx : null)).join("");
}

function populateDiscoverGenreSelect() {
  const select = document.getElementById("discover-filter-genre");
  if (!select) return;

  const cfg = DISCOVER_MEDIA_CONFIG[discoverState.activeMedia] || DISCOVER_MEDIA_CONFIG.movies;
  const genreList = cfg.tmdbType === "tv" ? discoverState.genres.tv : discoverState.genres.movie;
  const currentVal = discoverState.filters.genre;

  const options = ['<option value="">All Genres</option>'];
  for (const g of genreList) {
    // In Anime / Animation, Animation (16) is already implied as the base category.
    if ((discoverState.activeMedia === "anime" || discoverState.activeMedia === "animation") && Number(g.id) === 16) {
      continue;
    }
    options.push(`<option value="${Number(g.id)}">${escapeDiscoverHtml(g.name)}</option>`);
  }
  select.innerHTML = options.join("");
  if (currentVal && select.querySelector(`option[value="${currentVal}"]`)) {
    select.value = currentVal;
  } else {
    discoverState.filters.genre = "";
    select.value = "";
  }
}

async function ensureDiscoverGenresLoaded() {
  if (discoverState.genresLoaded) return;
  try {
    const [movieRes, tvRes] = await Promise.allSettled([
      tmdbFetch("/genre/movie/list?language=en-US"),
      tmdbFetch("/genre/tv/list?language=en-US")
    ]);
    if (movieRes.status === "fulfilled" && Array.isArray(movieRes.value?.genres) && movieRes.value.genres.length) {
      discoverState.genres.movie = movieRes.value.genres;
    }
    if (tvRes.status === "fulfilled" && Array.isArray(tvRes.value?.genres) && tvRes.value.genres.length) {
      discoverState.genres.tv = tvRes.value.genres;
    }
    discoverState.genresLoaded = true;
    populateDiscoverGenreSelect();
  } catch (err) {
    console.warn("Using built-in TMDB genre fallback list:", err);
  }
}

function updateDiscoverMediaUI() {
  const media = discoverState.activeMedia;
  const cfg = DISCOVER_MEDIA_CONFIG[media] || DISCOVER_MEDIA_CONFIG.movies;

  document.querySelectorAll("#discover-media-tabs .discover-media-tab").forEach(tab => {
    const isActive = tab.getAttribute("data-media") === media;
    tab.classList.toggle("active", isActive);
    tab.setAttribute("aria-selected", isActive ? "true" : "false");
  });

  const input = document.getElementById("discover-search-input");
  if (input) input.placeholder = cfg.placeholder;

  const pillMap = {
    latest: document.getElementById("discover-pill-latest"),
    popular: document.getElementById("discover-pill-popular"),
    top: document.getElementById("discover-pill-top")
  };
  const headingMap = {
    latest: document.getElementById("discover-heading-latest"),
    popular: document.getElementById("discover-heading-popular"),
    top: document.getElementById("discover-heading-top")
  };
  for (const k of ["latest", "popular", "top"]) {
    if (pillMap[k]) pillMap[k].textContent = cfg.sectionLabels[k];
    if (headingMap[k]) headingMap[k].textContent = cfg.sectionLabels[k];
  }

  populateDiscoverGenreSelect();
}

function getDiscoverLanguageLabel(code) {
  const norm = String(code || "").trim().toLowerCase();
  if (!norm) return "";
  if (norm === "unspecified") return "Default Audio";
  const match = (discoverState.languages || DISCOVER_DEFAULT_LANGUAGES).find(l => l.iso_639_1 === norm);
  if (match) return match.english_name;
  try {
    if (typeof Intl !== "undefined" && Intl.DisplayNames) {
      const dn = new Intl.DisplayNames(["en"], { type: "language" });
      const resolved = dn.of(norm);
      if (resolved && resolved.toLowerCase() !== norm) return resolved;
    }
  } catch {}
  return norm.toUpperCase();
}

async function ensureDiscoverLanguagesLoaded() {
  if (discoverState.languagesLoaded) return;
  try {
    const raw = await tmdbFetch("/configuration/languages");
    if (Array.isArray(raw) && raw.length > 0) {
      const priorityCodes = new Map(DISCOVER_DEFAULT_LANGUAGES.map((l, idx) => [l.iso_639_1, idx]));
      const seen = new Set();
      const merged = [];
      for (const item of raw) {
        const code = String(item && item.iso_639_1 || "").trim().toLowerCase();
        const name = String(item && item.english_name || "").trim();
        if (!code || !name || name === "No Language" || seen.has(code)) continue;
        seen.add(code);
        merged.push({ iso_639_1: code, english_name: name });
      }
      merged.sort((a, b) => {
        const pa = priorityCodes.has(a.iso_639_1) ? priorityCodes.get(a.iso_639_1) : 9999;
        const pb = priorityCodes.has(b.iso_639_1) ? priorityCodes.get(b.iso_639_1) : 9999;
        if (pa !== pb) return pa - pb;
        return a.english_name.localeCompare(b.english_name);
      });
      if (merged.length > 0) {
        discoverState.languages = merged;
        discoverState.languagesLoaded = true;
      }
    }
  } catch (err) {
    console.warn("Using built-in TMDB language fallback list:", err);
  }
}

function hasActiveDiscoverFilters() {
  const f = discoverState.filters;
  return Boolean(f.genre || f.year || f.rating || (f.sort && f.sort !== "popularity.desc"));
}

function syncDiscoverResetButton() {
  const resetBtn = document.getElementById("discover-filter-reset");
  if (resetBtn) {
    resetBtn.style.display = hasActiveDiscoverFilters() ? "inline-flex" : "none";
  }
}

function resetDiscoverProFilters(triggerQuery = true) {
  discoverState.filters = { genre: "", year: "", rating: "", sort: "popularity.desc" };
  const elMap = {
    "discover-filter-genre": "",
    "discover-filter-year": "",
    "discover-filter-rating": "",
    "discover-filter-sort": "popularity.desc"
  };
  for (const [id, val] of Object.entries(elMap)) {
    const el = document.getElementById(id);
    if (el) el.value = val;
  }
  syncDiscoverResetButton();
  if (triggerQuery) {
    const input = document.getElementById("discover-search-input");
    executeDiscoverQuery(input ? input.value : "");
  }
}

function renderAllDiscoverSections() {
  const sections = discoverState.sectionsByMedia[discoverState.activeMedia] || { latest: [], popular: [], top: [] };
  const configs = [
    { key: "latest", gridId: "discover-grid-latest", rank: false },
    { key: "popular", gridId: "discover-grid-popular", rank: true },
    { key: "top", gridId: "discover-grid-top", rank: true }
  ];
  for (const cfg of configs) {
    const list = sections[cfg.key] || [];
    const expanded = !!discoverState.expanded[cfg.key];
    renderDiscoverGrid(cfg.gridId, list, expanded ? 20 : 10, cfg.rank);

    const btn = document.querySelector(`.discover-toggle-btn[data-expand="${cfg.key}"]`);
    if (btn) {
      btn.style.display = list.length > 10 ? "inline-flex" : "none";
      btn.textContent = expanded ? "Show less" : `Show all ${Math.min(list.length, 20)}`;
    }
  }
}

function applyDiscoverSectionFilter(filterKey) {
  discoverState.activeFilter = filterKey;
  document.querySelectorAll("#discover-filter-row .discover-pill").forEach(pill => {
    pill.classList.toggle("active", pill.getAttribute("data-section") === filterKey);
  });

  const searchPanel = document.getElementById("discover-search-panel");
  const feed = document.getElementById("discover-feed");
  const input = document.getElementById("discover-search-input");
  if ((input && input.value.trim()) || hasActiveDiscoverFilters()) {
    if (input) input.value = "";
    const clearBtn = document.getElementById("discover-clear-btn");
    if (clearBtn) clearBtn.style.display = "none";
    resetDiscoverProFilters(false);
  }
  if (searchPanel && feed) {
    searchPanel.style.display = "none";
    feed.style.display = "flex";
  }

  document.querySelectorAll("#discover-feed .discover-section").forEach(sec => {
    const secKey = sec.getAttribute("data-discover-section");
    sec.style.display = (filterKey === "all" || filterKey === secKey) ? "flex" : "none";
  });
}

function getSectionEndpointsForMedia(media) {
  switch (media) {
    case "series":
      return [
        { key: "latest", path: "/tv/on_the_air?language=en-US&page=1", type: "tv" },
        { key: "popular", path: "/tv/popular?language=en-US&page=1", type: "tv" },
        { key: "top", path: "/tv/top_rated?language=en-US&page=1", type: "tv" }
      ];
    case "anime":
      return [
        { key: "latest", path: "/discover/tv?with_genres=16&with_original_language=ja|ko|zh&sort_by=first_air_date.desc&vote_count.gte=25&language=en-US&page=1", type: "tv" },
        { key: "popular", path: "/discover/tv?with_genres=16&with_original_language=ja|ko|zh&sort_by=popularity.desc&language=en-US&page=1", type: "tv" },
        { key: "top", path: "/discover/movie?with_genres=16&with_original_language=ja|ko|zh&sort_by=vote_average.desc&vote_count.gte=150&language=en-US&page=1", type: "movie" }
      ];
    case "animation":
      return [
        { key: "latest", path: "/discover/movie?with_genres=16&sort_by=primary_release_date.desc&vote_count.gte=25&language=en-US&page=1", type: "movie" },
        { key: "popular", path: "/discover/movie?with_genres=16&sort_by=popularity.desc&language=en-US&page=1", type: "movie" },
        { key: "top", path: "/discover/tv?with_genres=16&sort_by=vote_average.desc&vote_count.gte=150&language=en-US&page=1", type: "tv" }
      ];
    case "movies":
    default:
      return [
        { key: "latest", path: "/movie/now_playing?language=en-US&page=1", type: "movie" },
        { key: "popular", path: "/movie/popular?language=en-US&page=1", type: "movie" },
        { key: "top", path: "/movie/top_rated?language=en-US&page=1", type: "movie" }
      ];
  }
}

async function initDiscoverFeed(forceRefresh = false) {
  const media = discoverState.activeMedia;
  updateDiscoverMediaUI();
  ensureDiscoverGenresLoaded();
  ensureDiscoverLanguagesLoaded();

  if (!forceRefresh && discoverState.loadedByMedia[media]) {
    renderAllDiscoverSections();
    return;
  }
  if (discoverState.loadingMedia === media && !forceRefresh) return;

  discoverState.loadingMedia = media;
  const grids = ["discover-grid-latest", "discover-grid-popular", "discover-grid-top"];
  grids.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = formatDiscoverSkeletons(10);
  });

  const endpoints = getSectionEndpointsForMedia(media);
  try {
    const settled = await Promise.allSettled(endpoints.map(ep => tmdbFetch(ep.path)));
    if (discoverState.activeMedia !== media) return;

    const bucket = { latest: [], popular: [], top: [] };
    endpoints.forEach((ep, idx) => {
      const res = settled[idx];
      if (res.status === "fulfilled" && res.value && Array.isArray(res.value.results)) {
        bucket[ep.key] = res.value.results
          .map(item => normalizeDiscoverItem(item, ep.type))
          .filter(Boolean);
      }
    });

    discoverState.sectionsByMedia[media] = bucket;
    discoverState.loadedByMedia[media] = true;
    renderAllDiscoverSections();
  } catch (err) {
    grids.forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.innerHTML = `<div class="discover-empty-state">Unable to reach TMDB right now (${escapeDiscoverHtml(err.message)}). Click Refresh to retry.</div>`;
      }
    });
  } finally {
    if (discoverState.loadingMedia === media) {
      discoverState.loadingMedia = null;
    }
  }
}

function itemMatchesYearFilter(rawDate, yearFilter) {
  if (!yearFilter) return true;
  if (!rawDate || rawDate.length < 4) return false;
  const y = Number(rawDate.slice(0, 4));
  if (Number.isNaN(y)) return false;
  if (yearFilter.includes("-")) {
    const [minY, maxY] = yearFilter.split("-").map(Number);
    return y >= minY && y <= maxY;
  }
  return y === Number(yearFilter);
}

function itemMatchesDiscoverFilters(item, filters, activeMedia) {
  const gids = Array.isArray(item.genre_ids) ? item.genre_ids : [];
  const asianAnimeLangs = new Set(["ja", "ko", "zh"]);
  if (activeMedia === "anime") {
    if (!gids.includes(16) || !asianAnimeLangs.has(item.original_language)) return false;
  } else if (activeMedia === "animation") {
    if (!gids.includes(16)) return false;
  }

  if (filters.genre && !gids.includes(Number(filters.genre))) return false;
  if (filters.year && !itemMatchesYearFilter(getItemDate(item), filters.year)) return false;
  if (filters.rating && (Number(item.vote_average) || 0) < Number(filters.rating)) return false;
  return true;
}

function sortDiscoverItems(items, sortKey) {
  const arr = [...items];
  switch (sortKey) {
    case "vote_average.desc":
      return arr.sort((a, b) => (b.vote_average || 0) - (a.vote_average || 0));
    case "release_date.desc":
      return arr.sort((a, b) => getItemDate(b).localeCompare(getItemDate(a)));
    case "vote_count.desc":
      return arr.sort((a, b) => (b.vote_count || 0) - (a.vote_count || 0));
    case "popularity.desc":
    default:
      return arr.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
  }
}

function buildDiscoverEndpointPath(media, tmdbType, filters, page = 1) {
  const params = new URLSearchParams({
    language: "en-US",
    include_adult: "false",
    page: String(page)
  });

  let sortParam = filters.sort || "popularity.desc";
  if (sortParam === "release_date.desc" && tmdbType === "tv") {
    sortParam = "first_air_date.desc";
  } else if (sortParam === "release_date.desc" && tmdbType === "movie") {
    sortParam = "primary_release_date.desc";
  }
  params.set("sort_by", sortParam);
  if (sortParam === "vote_average.desc") {
    params.set("vote_count.gte", "50");
  }

  const genres = [];
  if (media === "anime" || media === "animation") {
    genres.push("16");
  }
  if (filters.genre) {
    genres.push(String(filters.genre));
  }
  if (genres.length) {
    params.set("with_genres", genres.join(","));
  }

  if (media === "anime") {
    params.set("with_original_language", "ja|ko|zh");
  }

  if (filters.rating) {
    params.set("vote_average.gte", String(filters.rating));
    params.set("vote_count.gte", "20");
  }

  if (filters.year) {
    const dateKey = tmdbType === "tv" ? "first_air_date" : "primary_release_date";
    if (filters.year.includes("-")) {
      const [y1, y2] = filters.year.split("-");
      params.set(`${dateKey}.gte`, `${y1}-01-01`);
      params.set(`${dateKey}.lte`, `${y2}-12-31`);
    } else {
      params.set(tmdbType === "tv" ? "first_air_date_year" : "primary_release_year", filters.year);
    }
  }

  return `/discover/${tmdbType}?${params.toString()}`;
}

async function fetchSearchItemsForActiveMedia(query, filters, activeMedia, signal = undefined) {
  const encoded = encodeURIComponent(query);
  const needsExtraPages = Boolean(filters.genre || filters.year || filters.rating || activeMedia === "anime" || activeMedia === "animation");
  const fetchOpts = signal ? { signal } : {};

  if (activeMedia === "movies") {
    const pages = needsExtraPages ? [1, 2] : [1];
    const responses = await Promise.all(pages.map(p => tmdbFetch(`/search/movie?query=${encoded}&include_adult=false&language=en-US&page=${p}`, fetchOpts)));
    const all = responses.flatMap(r => Array.isArray(r.results) ? r.results : []).map(it => normalizeDiscoverItem(it, "movie"));
    return sortDiscoverItems(all.filter(it => itemMatchesDiscoverFilters(it, filters, activeMedia)), filters.sort);
  }

  if (activeMedia === "series") {
    const pages = needsExtraPages ? [1, 2] : [1];
    const responses = await Promise.all(pages.map(p => tmdbFetch(`/search/tv?query=${encoded}&include_adult=false&language=en-US&page=${p}`, fetchOpts)));
    const all = responses.flatMap(r => Array.isArray(r.results) ? r.results : []).map(it => normalizeDiscoverItem(it, "tv"));
    return sortDiscoverItems(all.filter(it => itemMatchesDiscoverFilters(it, filters, activeMedia)), filters.sort);
  }

  // Anime & Animation query both TV & Movie search endpoints filtered by Animation genre.
  const [tvRes, mvRes] = await Promise.all([
    tmdbFetch(`/search/tv?query=${encoded}&include_adult=false&language=en-US&page=1`, fetchOpts),
    tmdbFetch(`/search/movie?query=${encoded}&include_adult=false&language=en-US&page=1`, fetchOpts)
  ]);
  const merged = [
    ...(Array.isArray(tvRes.results) ? tvRes.results : []).map(it => normalizeDiscoverItem(it, "tv")),
    ...(Array.isArray(mvRes.results) ? mvRes.results : []).map(it => normalizeDiscoverItem(it, "movie"))
  ].filter(Boolean);
  return sortDiscoverItems(merged.filter(it => itemMatchesDiscoverFilters(it, filters, activeMedia)), filters.sort);
}

function buildActiveFilterSummary() {
  const cfg = DISCOVER_MEDIA_CONFIG[discoverState.activeMedia] || DISCOVER_MEDIA_CONFIG.movies;
  const f = discoverState.filters;
  const parts = [];
  if (f.genre) {
    const gList = cfg.tmdbType === "tv" ? discoverState.genres.tv : discoverState.genres.movie;
    const match = gList.find(g => String(g.id) === String(f.genre));
    if (match) parts.push(match.name);
  }
  if (f.year) parts.push(f.year.includes("-") ? `${f.year.slice(0, 4)}s` : f.year);
  if (f.rating) parts.push(`${f.rating}.0+ ★`);
  return parts;
}

async function executeDiscoverQuery(rawQuery = "") {
  const query = (rawQuery || "").trim();
  const activeFilters = hasActiveDiscoverFilters();
  const searchPanel = document.getElementById("discover-search-panel");
  const searchGrid = document.getElementById("discover-search-grid");
  const searchTitle = document.getElementById("discover-search-title");
  const searchCount = document.getElementById("discover-search-count");
  const feed = document.getElementById("discover-feed");

  syncDiscoverResetButton();

  if (!query && !activeFilters) {
    if (searchPanel) searchPanel.style.display = "none";
    if (feed) feed.style.display = "flex";
    initDiscoverFeed(false);
    return;
  }

  const token = ++discoverState.queryToken;
  const media = discoverState.activeMedia;
  const cfg = DISCOVER_MEDIA_CONFIG[media] || DISCOVER_MEDIA_CONFIG.movies;
  const filterLabels = buildActiveFilterSummary();
  const suffix = filterLabels.length ? ` (${filterLabels.join(" · ")})` : "";

  if (feed) feed.style.display = "none";
  if (searchPanel) searchPanel.style.display = "flex";
  if (searchTitle) {
    searchTitle.textContent = query
      ? `${cfg.label} results for "${query}"${suffix}`
      : `Browse ${cfg.label}${suffix}`;
  }
  if (searchCount) searchCount.textContent = "...";
  if (searchGrid) searchGrid.innerHTML = formatDiscoverSkeletons(10);

  try {
    let results = [];
    if (query) {
      results = await fetchSearchItemsForActiveMedia(query, discoverState.filters, media);
    } else if (media === "anime" || media === "animation") {
      const [tvData, mvData] = await Promise.all([
        tmdbFetch(buildDiscoverEndpointPath(media, "tv", discoverState.filters, 1)),
        tmdbFetch(buildDiscoverEndpointPath(media, "movie", discoverState.filters, 1))
      ]);
      const combined = [
        ...(Array.isArray(tvData.results) ? tvData.results : []).map(it => normalizeDiscoverItem(it, "tv")),
        ...(Array.isArray(mvData.results) ? mvData.results : []).map(it => normalizeDiscoverItem(it, "movie"))
      ].filter(Boolean);
      results = sortDiscoverItems(combined, discoverState.filters.sort);
    } else {
      const data = await tmdbFetch(buildDiscoverEndpointPath(media, cfg.tmdbType, discoverState.filters, 1));
      results = (Array.isArray(data.results) ? data.results : []).map(it => normalizeDiscoverItem(it, cfg.tmdbType)).filter(Boolean);
    }

    if (discoverState.queryToken !== token) return;

    if (searchCount) searchCount.textContent = String(results.length);
    if (results.length === 0 && searchGrid) {
      searchGrid.innerHTML = `<div class="discover-empty-state">No ${escapeDiscoverHtml(cfg.label.toLowerCase())} matched your search or selected filters. Try adjusting filters or spelling.</div>`;
    } else {
      renderDiscoverGrid("discover-search-grid", results, null, false);
    }
  } catch (err) {
    if (discoverState.queryToken !== token) return;
    if (searchCount) searchCount.textContent = "Error";
    if (searchGrid) {
      searchGrid.innerHTML = `<div class="discover-empty-state">Search failed (${escapeDiscoverHtml(err.message)}). Please try again.</div>`;
    }
  }
}

function runDiscoverSearch(rawQuery) {
  showDiscoverSubpage("browse");
  return executeDiscoverQuery(rawQuery);
}

function switchDiscoverMediaTab(mediaKey) {
  if (!DISCOVER_MEDIA_CONFIG[mediaKey]) return;
  showDiscoverSubpage("browse");
  if (discoverState.activeMedia === mediaKey) return;
  discoverState.activeMedia = mediaKey;
  discoverState.activeFilter = "all";
  discoverState.expanded = { latest: false, popular: false, top: false };
  document.querySelectorAll("#discover-filter-row .discover-pill").forEach(pill => {
    pill.classList.toggle("active", pill.getAttribute("data-section") === "all");
  });
  document.querySelectorAll("#discover-feed .discover-section").forEach(sec => {
    sec.style.display = "flex";
  });

  // Reset genre on media switch since TMDB movie and TV genre IDs differ.
  discoverState.filters.genre = "";
  updateDiscoverMediaUI();
  closeDiscoverAutocomplete();

  const input = document.getElementById("discover-search-input");
  const query = input ? input.value.trim() : "";
  if (query || hasActiveDiscoverFilters()) {
    executeDiscoverQuery(query);
  } else {
    const searchPanel = document.getElementById("discover-search-panel");
    const feed = document.getElementById("discover-feed");
    if (searchPanel) searchPanel.style.display = "none";
    if (feed) feed.style.display = "flex";
    initDiscoverFeed(false);
  }
}

function scrollDiscoverToTop() {
  const viewDiscover = document.getElementById("view-discover");
  if (viewDiscover && typeof viewDiscover.scrollTo === "function") {
    viewDiscover.scrollTo({ top: 0, behavior: "instant" });
  }
  const mainContent = document.querySelector(".main-content");
  if (mainContent && typeof mainContent.scrollTo === "function") {
    mainContent.scrollTo({ top: 0, behavior: "instant" });
  }
  window.scrollTo({ top: 0, behavior: "instant" });
}

function showDiscoverSubpage(page = "browse") {
  const target = page === "detail" || page === "season" ? page : "browse";
  discoverState.activePage = target;
  const browseEl = document.getElementById("discover-browse-page");
  const detailEl = document.getElementById("discover-detail-page");
  const seasonEl = document.getElementById("discover-season-page");

  if (browseEl) browseEl.style.display = target === "browse" ? "block" : "none";
  if (detailEl) detailEl.style.display = target === "detail" ? "flex" : "none";
  if (seasonEl) seasonEl.style.display = target === "season" ? "flex" : "none";

  if (target === "browse") {
    discoverState.seasonLookupToken++;
  }
  scrollDiscoverToTop();
}

const discoverSourcePromptState = {
  suggestedName: "",
  isSeasonZip: false
};

function openDiscoverWipModal() {
  const modal = document.getElementById("discover-wip-modal");
  if (modal) modal.style.display = "flex";
}

function closeDiscoverWipModal() {
  const modal = document.getElementById("discover-wip-modal");
  if (modal) modal.style.display = "none";
}

function closeDiscoverSourcePrompt() {
  const modal = document.getElementById("discover-source-modal");
  if (modal) modal.style.display = "none";
  const input = document.getElementById("discover-source-url-input");
  if (input) input.value = "";
}

function openDiscoverSourcePrompt(opts = {}) {
  const modal = document.getElementById("discover-source-modal");
  const titleEl = document.getElementById("discover-source-title");
  const descEl = document.getElementById("discover-source-desc");
  const urlWrap = document.getElementById("discover-source-url-wrap");
  const urlInput = document.getElementById("discover-source-url-input");
  const startBtn = document.getElementById("discover-source-start-btn");
  if (!modal) return;

  const isSeasonZip = Boolean(opts.isSeasonZip);
  const displayTitle = opts.displayTitle || "Download";
  const qualityLabel = opts.quality ? ` (${opts.quality})` : "";
  discoverSourcePromptState.suggestedName = opts.suggestedName || "";
  discoverSourcePromptState.isSeasonZip = isSeasonZip;

  if (titleEl) {
    titleEl.textContent = isSeasonZip ? `${displayTitle} — Season ZIP` : `${displayTitle}${qualityLabel}`;
  }
  if (descEl) {
    if (isSeasonZip) {
      descEl.textContent = "TMDB provides series metadata only and Archive.org has been removed. Whole-season .zip downloads require a connected media host or storage bucket (such as Google Cloud Storage). You can download individual episodes below by pasting a direct episode stream or video URL.";
    } else {
      descEl.textContent = `TMDB provides catalog metadata only and Archive.org has been removed. If you have a direct video or stream URL (MP4, MKV, M3U8, or cloud storage link) for "${displayTitle}${qualityLabel}", paste it below to start downloading in HyperDrain.`;
    }
  }
  if (urlWrap) urlWrap.style.display = isSeasonZip ? "none" : "flex";
  if (startBtn) {
    startBtn.style.display = isSeasonZip ? "none" : "inline-flex";
    startBtn.disabled = false;
    startBtn.textContent = "Start Download";
  }
  if (urlInput) {
    urlInput.value = "";
  }
  modal.style.display = "flex";
  if (!isSeasonZip && urlInput) {
    setTimeout(() => urlInput.focus(), 40);
  }
}

async function submitDiscoverSourcePrompt() {
  if (discoverSourcePromptState.isSeasonZip) {
    closeDiscoverSourcePrompt();
    return;
  }
  const urlInput = document.getElementById("discover-source-url-input");
  const startBtn = document.getElementById("discover-source-start-btn");
  const rawUrl = urlInput ? urlInput.value.trim() : "";
  if (!/^https?:\/\//i.test(rawUrl)) {
    window.customAlert("Please enter a valid http:// or https:// direct media URL.");
    if (urlInput) urlInput.focus();
    return;
  }

  const lower = rawUrl.toLowerCase();
  const isStream = lower.includes(".m3u8") || lower.includes(".mpd");
  const endpoint = isStream ? `${API_BASE}/api/download-stream` : `${API_BASE}/api/tasks/add`;
  const payload = isStream
    ? {
        url: rawUrl,
        title: discoverSourcePromptState.suggestedName || "",
        connections: 32
      }
    : {
        url: rawUrl,
        suggested_name: discoverSourcePromptState.suggestedName || "",
        connections: 32,
        auto_extract: false
      };

  const prevText = startBtn ? startBtn.textContent : "Start Download";
  try {
    if (startBtn) {
      startBtn.disabled = true;
      startBtn.textContent = "Starting...";
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
      closeDiscoverSourcePrompt();
      if (typeof switchTab === "function") switchTab("active");
      if (typeof initialLoadTasks === "function") initialLoadTasks();
    } else {
      const errText = await res.text();
      window.customAlert("Cannot start download: " + (errText.trim() || ("Error " + res.status)));
    }
  } catch (err) {
    window.customAlert("Could not reach HyperDrain engine: " + err.message);
  } finally {
    if (startBtn) {
      startBtn.disabled = false;
      startBtn.textContent = prevText;
    }
  }
}

function highlightAutocompleteMatch(text, query) {
  const source = String(text ?? "");
  const needle = String(query ?? "").trim();
  if (!needle) return escapeDiscoverHtml(source);
  const lowerSrc = source.toLowerCase();
  const lowerNeedle = needle.toLowerCase();
  const idx = lowerSrc.indexOf(lowerNeedle);
  if (idx === -1) return escapeDiscoverHtml(source);
  return (
    escapeDiscoverHtml(source.slice(0, idx)) +
    `<span class="discover-ac-match">${escapeDiscoverHtml(source.slice(idx, idx + needle.length))}</span>` +
    escapeDiscoverHtml(source.slice(idx + needle.length))
  );
}

function closeDiscoverAutocomplete() {
  if (discoverAcState.timer) {
    clearTimeout(discoverAcState.timer);
    discoverAcState.timer = null;
  }
  if (discoverAcState.controller) {
    discoverAcState.controller.abort();
    discoverAcState.controller = null;
  }
  discoverAcState.activeIndex = -1;
  discoverAcState.items = [];
  const box = document.getElementById("discover-autocomplete");
  if (box) {
    box.style.display = "none";
    box.innerHTML = "";
  }
}

function setDiscoverAutocompleteActive(nextIndex) {
  const box = document.getElementById("discover-autocomplete");
  if (!box) return;
  const rows = box.querySelectorAll(".discover-ac-item");
  if (!rows.length) {
    discoverAcState.activeIndex = -1;
    return;
  }
  const bounded = nextIndex < 0 ? rows.length - 1 : nextIndex >= rows.length ? 0 : nextIndex;
  discoverAcState.activeIndex = bounded;
  rows.forEach((row, idx) => row.classList.toggle("active", idx === bounded));
  const activeRow = rows[bounded];
  if (activeRow) {
    activeRow.scrollIntoView({ block: "nearest" });
    const titlePreview = activeRow.getAttribute("data-ac-title");
    const input = document.getElementById("discover-search-input");
    if (input && titlePreview) {
      input.value = titlePreview;
      const clearBtn = document.getElementById("discover-clear-btn");
      if (clearBtn) clearBtn.style.display = "flex";
    }
  }
}

function renderDiscoverAutocomplete(query, items) {
  const box = document.getElementById("discover-autocomplete");
  const input = document.getElementById("discover-search-input");
  if (!box || !input) return;

  const trimmed = (query || "").trim();
  if (!trimmed) {
    closeDiscoverAutocomplete();
    return;
  }

  const cfg = DISCOVER_MEDIA_CONFIG[discoverState.activeMedia] || DISCOVER_MEDIA_CONFIG.movies;
  const topItems = Array.isArray(items) ? items.slice(0, 6) : [];
  discoverAcState.activeIndex = -1;
  discoverAcState.items = [
    ...topItems.map(m => ({ type: "item", item: m })),
    { type: "search", query: trimmed }
  ];

  const itemRowsHtml = topItems.map((m, idx) => {
    const mediaType = m._mediaType === "tv" ? "tv" : "movie";
    const title = getItemTitle(m);
    const rawDate = getItemDate(m);
    const year = rawDate ? rawDate.slice(0, 4) : "TBA";
    const kindTag = mediaType === "tv" ? "Series" : "Movie";
    const rating = typeof m.vote_average === "number" && m.vote_average > 0 ? ` • ★ ${m.vote_average.toFixed(1)}` : "";
    const thumb = m.poster_path
      ? `<img class="discover-ac-thumb" src="${escapeDiscoverHtml(TMDB_IMG_W342 + m.poster_path)}" alt="" loading="lazy" />`
      : `<div class="discover-ac-thumb-fallback"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="2" y="2" width="20" height="20" rx="2"></rect><line x1="7" y1="2" x2="7" y2="22"></line><line x1="17" y1="2" x2="17" y2="22"></line></svg></div>`;

    return `
      <button type="button" class="discover-ac-item" role="option" data-ac-idx="${idx}" data-ac-movie-id="${Number(m.id)}" data-ac-media-type="${mediaType}" data-ac-title="${escapeDiscoverHtml(title)}">
        ${thumb}
        <div class="discover-ac-main">
          <div class="discover-ac-title">${highlightAutocompleteMatch(title, trimmed)}</div>
          <div class="discover-ac-sub">${escapeDiscoverHtml(`${year} • ${kindTag}${rating}`)}</div>
        </div>
      </button>
    `;
  }).join("");

  const searchIdx = topItems.length;
  const searchRowHtml = `
    <button type="button" class="discover-ac-item discover-ac-search-row" role="option" data-ac-idx="${searchIdx}" data-ac-search="1" data-ac-title="${escapeDiscoverHtml(trimmed)}">
      <div class="discover-ac-search-icon">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
      </div>
      <div class="discover-ac-main">
        <div class="discover-ac-title">Search ${escapeDiscoverHtml(cfg.label.toLowerCase())} for "${escapeDiscoverHtml(trimmed)}"</div>
        <div class="discover-ac-sub">Press Enter for full grid results</div>
      </div>
    </button>
  `;

  box.innerHTML = itemRowsHtml + searchRowHtml;
  box.style.display = "block";

  box.querySelectorAll(".discover-ac-item").forEach(btn => {
    btn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const movieId = Number(btn.getAttribute("data-ac-movie-id"));
      const mediaType = btn.getAttribute("data-ac-media-type") || "movie";
      const selectedTitle = btn.getAttribute("data-ac-title") || "";
      if (btn.getAttribute("data-ac-search") === "1") {
        closeDiscoverAutocomplete();
        executeDiscoverQuery(input.value);
        return;
      }
      if (movieId) {
        input.value = selectedTitle;
        const clearBtn = document.getElementById("discover-clear-btn");
        if (clearBtn) clearBtn.style.display = input.value.trim() ? "flex" : "none";
        closeDiscoverAutocomplete();
        openDiscoverMovieModal(movieId, mediaType);
      }
    });
  });
}

function scheduleDiscoverAutocomplete(rawQuery) {
  const query = (rawQuery || "").trim();
  if (discoverAcState.timer) {
    clearTimeout(discoverAcState.timer);
    discoverAcState.timer = null;
  }
  if (!query) {
    closeDiscoverAutocomplete();
    return;
  }

  discoverAcState.timer = setTimeout(async () => {
    if (discoverAcState.controller) {
      discoverAcState.controller.abort();
    }
    const controller = new AbortController();
    discoverAcState.controller = controller;
    try {
      const results = await fetchSearchItemsForActiveMedia(query, discoverState.filters, discoverState.activeMedia, controller.signal);
      if (discoverAcState.controller !== controller) return;
      const input = document.getElementById("discover-search-input");
      if (input && input.value.trim() === query) {
        renderDiscoverAutocomplete(query, results);
      }
    } catch (err) {
      if (err && err.name === "AbortError") return;
      closeDiscoverAutocomplete();
    }
  }, 180);
}

function formatSeasonEpisodeCode(seasonNum, episodeNum) {
  const s = String(Math.max(0, Number(seasonNum) || 0)).padStart(2, "0");
  const e = String(Math.max(1, Number(episodeNum) || 1)).padStart(2, "0");
  return `S${s}E${e}`;
}

function pickBestEpisodeGroup(detailedTv) {
  const candidates = detailedTv && detailedTv.episode_groups && Array.isArray(detailedTv.episode_groups.results)
    ? detailedTv.episode_groups.results
    : [];
  if (candidates.length === 0) return null;

  const rawSeasons = Array.isArray(detailedTv && detailedTv.seasons) ? detailedTv.seasons : [];
  const rawRegularCount = rawSeasons.filter(s => Number(s.season_number) > 0 && (Number(s.episode_count) || 0) > 0).length;
  const maxEpInRawSeason = rawSeasons.reduce((acc, s) => Math.max(acc, Number(s.episode_count) || 0), 0);
  if (rawRegularCount > 1 && maxEpInRawSeason < 60) return null;

  const typeScore = { 6: 100, 1: 80, 4: 65, 7: 50, 3: 35, 5: 20, 2: -80 };
  let best = null;
  let bestScore = 0;

  for (const grp of candidates) {
    const groupCount = Number(grp && grp.group_count) || 0;
    const epCount = Number(grp && grp.episode_count) || 0;
    if (!grp || !grp.id || groupCount <= 1 || epCount <= 0) continue;
    if (groupCount <= rawRegularCount && maxEpInRawSeason < 60) continue;

    let score = typeScore[Number(grp.type)] ?? 10;
    const name = String(grp.name || "").trim();

    if (/^(seasons?|season split|aired order.*season|tvdb order|wikipedia seasons|original parts|cours)$/i.test(name)) {
      score += 90;
    } else if (/\b(seasons?|parts?|cours?)\b/i.test(name)) {
      score += 40;
    }
    if (/\b(italian|español|spanish|french|german|portuguese|russian|arabic|korean|chinese|bilibili|crunchyroll)\b/i.test(name) || /[\u4e00-\u9fff]/.test(name)) {
      score -= 140;
    }
    if (/\barcs?\b/i.test(name) && Number(grp.type) !== 6) {
      score -= 30;
    }
    if (groupCount >= 2 && groupCount <= 40) {
      score += 10;
    } else if (groupCount > 100) {
      score -= 25;
    }

    if (score > bestScore) {
      bestScore = score;
      best = grp;
    }
  }
  return best;
}

async function resolveVirtualSeasonsFromEpisodeGroup(detailedTv, tvId) {
  if (!detailedTv || typeof detailedTv !== "object") return detailedTv;
  const bestGroup = pickBestEpisodeGroup(detailedTv);
  if (!bestGroup) return detailedTv;

  try {
    const groupDetail = await tmdbFetch(`/tv/episode_group/${encodeURIComponent(bestGroup.id)}?language=en-US`);
    const groups = Array.isArray(groupDetail && groupDetail.groups) ? groupDetail.groups : [];
    if (groups.length === 0) return detailedTv;

    const orderedGroups = [...groups].sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
    const usedNums = new Set();
    let nextSeq = 1;
    const mappedSeasons = [];
    const perSeasonCacheEntries = [];

    for (const grp of orderedGroups) {
      const epsRaw = Array.isArray(grp && grp.episodes) ? grp.episodes : [];
      if (epsRaw.length === 0) continue;

      const gName = String(grp.name || "").trim();
      const isSpecial = /^specials?$/i.test(gName) || /^ovas?$/i.test(gName) || (Number(grp.order) === 0 && /special/i.test(gName));
      let seasonNum = 0;

      if (!isSpecial) {
        const numMatch = gName.match(/\b(?:season|part|cour|series)\s*(\d+)\b/i);
        const parsedNum = numMatch ? Number(numMatch[1]) : 0;
        if (parsedNum > 0 && !usedNums.has(parsedNum)) {
          seasonNum = parsedNum;
        } else {
          while (usedNums.has(nextSeq)) nextSeq++;
          seasonNum = nextSeq++;
        }
        usedNums.add(seasonNum);
      } else {
        if (usedNums.has(0)) continue;
        usedNums.add(0);
      }

      const orderedEps = [...epsRaw].sort((a, b) => {
        const oa = Number(a.order ?? 0);
        const ob = Number(b.order ?? 0);
        if (oa !== ob) return oa - ob;
        return (Number(a.episode_number) || 0) - (Number(b.episode_number) || 0);
      });

      const normalizedEps = orderedEps.map((ep, idx) => ({
        ...ep,
        season_number: seasonNum,
        episode_number: idx + 1,
        absolute_episode_number: Number(ep.episode_number) || (idx + 1)
      }));

      const label = seasonNum === 0 ? "Specials" : (gName || `Season ${seasonNum}`);
      mappedSeasons.push({
        id: grp.id,
        season_number: seasonNum,
        name: label,
        episode_count: normalizedEps.length,
        air_date: normalizedEps[0] ? normalizedEps[0].air_date : ""
      });
      perSeasonCacheEntries.push([
        `${Number(tvId)}:S${seasonNum}`,
        {
          id: grp.id,
          season_number: seasonNum,
          name: label,
          episodes: normalizedEps,
          _fromEpisodeGroup: true
        }
      ]);
    }

    const rawRegularCount = (Array.isArray(detailedTv.seasons) ? detailedTv.seasons : [])
      .filter(s => Number(s.season_number) > 0 && (Number(s.episode_count) || 0) > 0).length;
    const resolvedRegularCount = mappedSeasons.filter(s => s.season_number > 0 && s.episode_count > 0).length;

    if (resolvedRegularCount <= rawRegularCount) {
      return detailedTv;
    }

    const prefix = `${Number(tvId)}:S`;
    for (const existingKey of Array.from(discoverState.seasonCache.keys())) {
      if (existingKey.startsWith(prefix)) {
        discoverState.seasonCache.delete(existingKey);
      }
    }
    for (const [k, val] of perSeasonCacheEntries) {
      discoverState.seasonCache.set(k, val);
    }

    return {
      ...detailedTv,
      _resolvedSeasons: mappedSeasons
    };
  } catch (err) {
    console.warn("Episode group season resolution failed, falling back to TMDB seasons:", err);
    return detailedTv;
  }
}

function getSortedSeriesSeasons(movie) {
  const raw = Array.isArray(movie && movie._resolvedSeasons) && movie._resolvedSeasons.length > 0
    ? movie._resolvedSeasons
    : (Array.isArray(movie && movie.seasons) ? movie.seasons : []);
  if (raw.length === 0) return [];
  const hasRealCount = raw.some(s => (Number(s.episode_count) || 0) > 0);
  const filtered = hasRealCount ? raw.filter(s => (Number(s.episode_count) || 0) > 0) : raw;
  return [...filtered].sort((a, b) => {
    const sa = Number(a.season_number);
    const sb = Number(b.season_number);
    if (sa === 0 && sb !== 0) return 1;
    if (sb === 0 && sa !== 0) return -1;
    return sa - sb;
  });
}

async function fetchDiscoverSeasonData(tvId, seasonNumber) {
  const key = `${Number(tvId)}:S${Number(seasonNumber)}`;
  if (discoverState.seasonCache.has(key)) {
    return discoverState.seasonCache.get(key);
  }
  const data = await tmdbFetch(`/tv/${Number(tvId)}/season/${Number(seasonNumber)}?language=en-US`);
  discoverState.seasonCache.set(key, data);
  return data;
}

function buildDiscoverModalLanguagesHtml(movie) {
  const seen = new Set();
  const names = [];
  const pushLang = (code, fallbackName = "") => {
    const norm = String(code || "").trim().toLowerCase();
    if (!norm || seen.has(norm)) return;
    seen.add(norm);
    const label = fallbackName && fallbackName !== "No Language" ? fallbackName : getDiscoverLanguageLabel(norm);
    if (label) names.push(label);
  };

  pushLang(movie.original_language);
  if (Array.isArray(movie.spoken_languages)) {
    for (const sp of movie.spoken_languages) {
      pushLang(sp && sp.iso_639_1, sp && (sp.english_name || sp.name));
    }
  }
  const translations = movie.translations && Array.isArray(movie.translations.translations)
    ? movie.translations.translations
    : [];
  for (const tr of translations) {
    pushLang(tr && tr.iso_639_1, tr && (tr.english_name || tr.name));
  }
  if (names.length === 0) return "";
  const shown = names.slice(0, 6);
  const more = names.length > 6 ? ` +${names.length - 6} more` : "";
  return `
    <div class="discover-modal-langs-line" title="${escapeDiscoverHtml(names.join(", "))}">
      <span class="discover-modal-lang-label">Languages:</span>
      <span>${escapeDiscoverHtml(shown.join(", ") + more)}</span>
    </div>
  `;
}

const TMDB_IMG_W185 = "https://image.tmdb.org/t/p/w185";
const TMDB_IMG_W300 = "https://image.tmdb.org/t/p/w300";

const DISCOVER_MOVIE_QUALITIES = [
  { id: "480p", badge: "480p", title: "480p SD", detail: "MP4 (H.264) \u2022 Standard Definition", is4k: false },
  { id: "720p", badge: "720p", title: "720p HD", detail: "MP4 / MKV (H.264) \u2022 High Definition", is4k: false },
  { id: "1080p", badge: "1080p", title: "1080p Full HD", detail: "MP4 / MKV (x264 / x265) \u2022 Full HD", is4k: false },
  { id: "2160p", badge: "4K", title: "2160p Ultra HD", detail: "MKV (HEVC / HDR) \u2022 4K UHD", is4k: true }
];

function sanitizeDiscoverFilename(value) {
  return String(value || "media")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, ".")
    .replace(/\.{2,}/g, ".")
    .replace(/^\.+|\.+$/g, "") || "media";
}

function formatDiscoverFullDate(rawDate, tbaText = "Date TBA") {
  if (!rawDate) return tbaText;
  const parsed = new Date(`${rawDate}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return String(rawDate);
  return parsed.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function getDiscoverTrailerUrl(movie) {
  const videos = movie && movie.videos && Array.isArray(movie.videos.results) ? movie.videos.results : [];
  const trailer = videos.find(v => v.site === "YouTube" && v.type === "Trailer")
    || videos.find(v => v.site === "YouTube");
  return trailer && trailer.key ? `https://www.youtube.com/watch?v=${encodeURIComponent(trailer.key)}` : "";
}

function computeDiscoverSeasonRating(seriesItem, seasonData, seasonEntry, episodes) {
  const candidates = [
    seasonData && typeof seasonData.vote_average === "number" ? seasonData.vote_average : 0,
    seasonEntry && typeof seasonEntry.vote_average === "number" ? seasonEntry.vote_average : 0
  ];
  let best = candidates.find(v => v > 0) || 0;
  if (!best && Array.isArray(episodes) && episodes.length > 0) {
    const rated = episodes.map(ep => Number(ep && ep.vote_average) || 0).filter(v => v > 0);
    if (rated.length > 0) {
      best = rated.reduce((sum, v) => sum + v, 0) / rated.length;
    }
  }
  if (!best && seriesItem && typeof seriesItem.vote_average === "number" && seriesItem.vote_average > 0) {
    best = seriesItem.vote_average;
  }
  return best;
}

function buildDiscoverCastSectionHtml(movie) {
  const cast = movie && movie.credits && Array.isArray(movie.credits.cast)
    ? movie.credits.cast.slice(0, 12)
    : [];
  if (cast.length === 0) return "";

  const cardsHtml = cast.map(person => {
    const name = escapeDiscoverHtml(person.name || "Unknown");
    const role = escapeDiscoverHtml(person.character || "Cast");
    const initials = String(person.name || "?").trim().split(/\s+/).slice(0, 2).map(p => p[0] || "").join("").toUpperCase() || "?";
    const avatarHtml = person.profile_path
      ? `<img src="${escapeDiscoverHtml(TMDB_IMG_W185 + person.profile_path)}" alt="${name}" loading="lazy" />`
      : `<span>${escapeDiscoverHtml(initials)}</span>`;
    return `
      <div class="discover-cast-card">
        <div class="discover-cast-avatar">${avatarHtml}</div>
        <div class="discover-cast-meta">
          <div class="discover-cast-name" title="${name}">${name}</div>
          <div class="discover-cast-role" title="${role}">${role}</div>
        </div>
      </div>
    `;
  }).join("");

  return `
    <div class="discover-page-section">
      <div class="discover-page-section-head">
        <h3 class="discover-page-section-title">Top Cast</h3>
      </div>
      <div class="discover-cast-strip">${cardsHtml}</div>
    </div>
  `;
}

function buildDiscoverMovieDownloadSectionHtml(movie) {
  const rawTitle = getItemTitle(movie);
  const rawDate = getItemDate(movie);
  const year = rawDate ? rawDate.slice(0, 4) : "";
  const baseSlug = sanitizeDiscoverFilename(year ? `${rawTitle}.${year}` : rawTitle);

  const rowsHtml = DISCOVER_MOVIE_QUALITIES.map(q => `
    <div class="discover-quality-row">
      <div class="discover-quality-left">
        <span class="discover-quality-badge${q.is4k ? " is-4k" : ""}">${escapeDiscoverHtml(q.badge)}</span>
        <div>
          <div class="discover-quality-meta-title">${escapeDiscoverHtml(rawTitle)} &mdash; ${escapeDiscoverHtml(q.title)}</div>
          <div class="discover-quality-meta-sub">${escapeDiscoverHtml(q.detail)}</div>
        </div>
      </div>
      <button
        type="button"
        class="discover-quality-dl-btn discover-movie-quality-dl-btn"
        data-quality="${escapeDiscoverHtml(q.id)}"
        data-suggested-name="${escapeDiscoverHtml(`${baseSlug}.${q.id}.mp4`)}"
      >
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
          <polyline points="7 10 12 15 17 10"></polyline>
          <line x1="12" y1="15" x2="12" y2="3"></line>
        </svg>
        <span>Download ${escapeDiscoverHtml(q.badge)}</span>
      </button>
    </div>
  `).join("");

  return `
    <div class="discover-page-section" id="discover-movie-downloads">
      <div class="discover-page-section-head">
        <h3 class="discover-page-section-title">Downloads</h3>
        <span class="discover-section-sub">480p to 2160p 4K</span>
      </div>
      <div class="discover-quality-list">${rowsHtml}</div>
    </div>
  `;
}

function buildDiscoverSeasonsGridSectionHtml(seriesItem) {
  const sortedSeasons = getSortedSeriesSeasons(seriesItem);
  const regularSeasons = sortedSeasons.filter(s => Number(s.season_number) > 0);
  const totalSeasonsCount = regularSeasons.length || Number(seriesItem.number_of_seasons) || sortedSeasons.length || 0;
  const totalEpisodesCount = Number(seriesItem.number_of_episodes)
    || sortedSeasons.reduce((acc, s) => acc + (Number(s.episode_count) || 0), 0);

  const summaryParts = [];
  if (totalSeasonsCount > 0) summaryParts.push(`${totalSeasonsCount} Season${totalSeasonsCount === 1 ? "" : "s"}`);
  if (totalEpisodesCount > 0) summaryParts.push(`${totalEpisodesCount} Episode${totalEpisodesCount === 1 ? "" : "s"}`);
  const summaryText = summaryParts.join(" • ") || "Seasons";

  if (sortedSeasons.length === 0) {
    return `
      <div class="discover-page-section" id="discover-seasons-section">
        <div class="discover-page-section-head">
          <h3 class="discover-page-section-title">Seasons &amp; Episodes</h3>
          <span class="discover-section-sub">${escapeDiscoverHtml(summaryText)}</span>
        </div>
        <div class="discover-archive-empty">No season breakdown is listed on TMDB for this title yet.</div>
      </div>
    `;
  }

  const cardsHtml = sortedSeasons.map(s => {
    const sNum = Number(s.season_number);
    const sName = escapeDiscoverHtml(s.name || (sNum === 0 ? "Specials" : `Season ${sNum}`));
    const epCount = Number(s.episode_count) || 0;
    const epLabel = epCount > 0 ? `${epCount} Episode${epCount === 1 ? "" : "s"}` : "Episodes TBA";
    const sYear = s.air_date ? String(s.air_date).slice(0, 4) : "";
    const sRating = typeof s.vote_average === "number" && s.vote_average > 0 ? `★ ${s.vote_average.toFixed(1)}` : "";
    const posterPath = s.poster_path || seriesItem.poster_path || "";
    const posterImg = posterPath
      ? `<img src="${escapeDiscoverHtml(TMDB_IMG_W342 + posterPath)}" alt="${sName}" loading="lazy" />`
      : `<div class="discover-page-poster-fallback"><span>S${String(Math.max(0, sNum)).padStart(2, "0")}</span></div>`;
    const sOverview = escapeDiscoverHtml(s.overview || (seriesItem.overview ? seriesItem.overview : "Click to view all episodes and download options for this season."));

    return `
      <div class="discover-season-card" role="button" tabindex="0" data-season-number="${sNum}" aria-label="${sName}">
        <div class="discover-season-card-poster">
          ${posterImg}
          <div class="discover-season-scrim"></div>
          ${sRating ? `<span class="discover-season-rating-tag">${escapeDiscoverHtml(sRating)}</span>` : ""}
          <div class="discover-season-caption">
            <div class="discover-season-card-title">${sName}</div>
            <div class="discover-season-card-meta">
              <span>${escapeDiscoverHtml(epLabel)}</span>
              ${sYear ? `<span>&bull; ${escapeDiscoverHtml(sYear)}</span>` : ""}
            </div>
            <div class="discover-season-card-overview">${sOverview}</div>
            <div class="discover-season-card-footer">
              <span class="discover-season-open-hint">View Episodes &rarr;</span>
              <button type="button" class="discover-season-mini-zip-btn" data-season-zip="${sNum}" title="Download season as .zip">.zip</button>
            </div>
          </div>
        </div>
      </div>
    `;
  }).join("");

  return `
    <div class="discover-page-section" id="discover-seasons-section">
      <div class="discover-page-section-head">
        <h3 class="discover-page-section-title">Seasons &amp; Episodes</h3>
        <span class="discover-section-sub">${escapeDiscoverHtml(summaryText)}</span>
      </div>
      <div class="discover-seasons-grid">${cardsHtml}</div>
    </div>
  `;
}

function renderDiscoverDetailPage(movie) {
  const container = document.getElementById("discover-detail-page");
  if (!container || !movie) return;

  const numericId = Number(movie.id);
  const mediaType = movie._mediaType === "tv" ? "tv" : (movie.first_air_date && !movie.release_date ? "tv" : "movie");
  const cacheKey = movie._cacheKey || `${mediaType}:${numericId}`;
  discoverState.activeDetailKey = cacheKey;

  const rawTitle = getItemTitle(movie);
  const title = escapeDiscoverHtml(rawTitle);
  const origTitle = (movie.original_title || movie.original_name || "").trim();
  const showOrigTitle = origTitle && origTitle.toLowerCase() !== rawTitle.trim().toLowerCase();
  const tagline = movie.tagline ? `<div class="discover-page-subtitle">&ldquo;${escapeDiscoverHtml(movie.tagline)}&rdquo;</div>` : "";

  const backdropUrl = movie.backdrop_path ? `${TMDB_IMG_W780}${movie.backdrop_path}` : "";
  const posterUrl = movie.poster_path ? `${TMDB_IMG_W342}${movie.poster_path}` : "";
  const releaseLabel = formatDiscoverFullDate(getItemDate(movie), mediaType === "tv" ? "First air date TBA" : "Release date TBA");

  const sortedSeasons = mediaType === "tv" ? getSortedSeriesSeasons(movie) : [];
  const regularSeasonsCount = sortedSeasons.filter(s => Number(s.season_number) > 0).length || Number(movie.number_of_seasons) || sortedSeasons.length || 0;
  const totalEpisodesCount = Number(movie.number_of_episodes)
    || sortedSeasons.reduce((acc, s) => acc + (Number(s.episode_count) || 0), 0);

  let runtimeLabel = "";
  if (mediaType === "tv") {
    const epMins = Array.isArray(movie.episode_run_time) && movie.episode_run_time.length > 0 ? Number(movie.episode_run_time[0]) || 0 : 0;
    if (epMins > 0) runtimeLabel = `${epMins} min / episode`;
  } else {
    const mins = Number(movie.runtime) || 0;
    if (mins > 0) runtimeLabel = mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins} min`;
  }

  const ratingNum = typeof movie.vote_average === "number" ? movie.vote_average : 0;
  const votesLabel = movie.vote_count ? ` (${Number(movie.vote_count).toLocaleString()} votes)` : "";
  const ratingText = ratingNum > 0
    ? `<span class="discover-meta-rating"><span class="movie-star">&#9733;</span> ${ratingNum.toFixed(1)}/10${escapeDiscoverHtml(votesLabel)}</span>`
    : `<span>Unrated</span>`;

  const inlineFacts = [ratingText];
  if (releaseLabel) inlineFacts.push(`<span>${mediaType === "tv" ? "First aired " : ""}${escapeDiscoverHtml(releaseLabel)}</span>`);
  if (runtimeLabel) inlineFacts.push(`<span>${escapeDiscoverHtml(runtimeLabel)}</span>`);
  if (mediaType === "tv" && regularSeasonsCount > 0) {
    inlineFacts.push(`<span>${regularSeasonsCount} Season${regularSeasonsCount === 1 ? "" : "s"}${totalEpisodesCount > 0 ? ` \u2022 ${totalEpisodesCount} Eps` : ""}</span>`);
  }
  if (movie.status) inlineFacts.push(`<span>${escapeDiscoverHtml(movie.status)}</span>`);

  const genres = Array.isArray(movie.genres) ? movie.genres.slice(0, 6) : [];
  const genresHtml = genres.length
    ? `<div class="discover-modal-genres">${genres.map(g => `<span class="discover-genre-chip">${escapeDiscoverHtml(g.name)}</span>`).join("")}</div>`
    : "";

  const trailerUrl = getDiscoverTrailerUrl(movie);
  const tmdbPageUrl = `https://www.themoviedb.org/${mediaType}/${numericId}`;

  const posterBlock = posterUrl
    ? `<img src="${escapeDiscoverHtml(posterUrl)}" alt="${title}" />`
    : `<div class="discover-page-poster-fallback"><span>${title}</span></div>`;

  const bottomActionBtnHtml = mediaType === "tv"
    ? `<button type="button" class="discover-page-btn is-primary" id="discover-detail-jump-btn">Browse Seasons</button>`
    : `<button type="button" class="discover-page-btn is-primary" id="discover-detail-jump-btn">Download Options</button>`;

  const overview = escapeDiscoverHtml(movie.overview || "No storyline available yet.");

  container.innerHTML = `
    <div class="discover-page-topbar">
      <div class="discover-breadcrumb">
        <button type="button" class="discover-back-pill" id="discover-detail-back-btn">&larr; Back to Discover</button>
      </div>
    </div>

    <div class="discover-page-hero">
      <div class="discover-page-hero-bg" style="background-image: ${backdropUrl ? `url(&quot;${escapeDiscoverHtml(backdropUrl)}&quot;)` : "none"};"></div>
      <div class="discover-page-hero-scrim"></div>
      <div class="discover-page-hero-content">
        <div class="discover-page-poster">${posterBlock}</div>
        <div class="discover-page-info">
          <h2 class="discover-page-title">${title}</h2>
          ${showOrigTitle ? `<div class="discover-page-subtitle">${escapeDiscoverHtml(origTitle)}</div>` : ""}
          ${tagline}
          <div class="discover-page-inline-meta">
            ${inlineFacts.join('<span class="discover-meta-sep">&bull;</span>')}
          </div>
          ${genresHtml}
          ${buildDiscoverModalLanguagesHtml(movie)}
          <div class="discover-page-actions">
            ${bottomActionBtnHtml}
            ${trailerUrl ? `<button type="button" class="discover-page-btn" id="discover-detail-trailer-btn" data-url="${escapeDiscoverHtml(trailerUrl)}">Trailer</button>` : ""}
            <button type="button" class="discover-page-btn" id="discover-detail-tmdb-btn" data-url="${escapeDiscoverHtml(tmdbPageUrl)}">TMDB</button>
          </div>
        </div>
      </div>
    </div>

    <div class="discover-page-section">
      <div class="discover-page-section-head">
        <h3 class="discover-page-section-title">Storyline</h3>
      </div>
      <p class="discover-page-overview">${overview}</p>
    </div>

    ${buildDiscoverCastSectionHtml(movie)}
    ${mediaType === "tv" ? buildDiscoverSeasonsGridSectionHtml(movie) : buildDiscoverMovieDownloadSectionHtml(movie)}
  `;

  const backBtn = document.getElementById("discover-detail-back-btn");
  if (backBtn) {
    backBtn.addEventListener("click", () => showDiscoverSubpage("browse"));
  }

  const jumpBtn = document.getElementById("discover-detail-jump-btn");
  if (jumpBtn) {
    jumpBtn.addEventListener("click", () => {
      const targetEl = document.getElementById(mediaType === "tv" ? "discover-seasons-section" : "discover-movie-downloads");
      if (targetEl) targetEl.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  const trailerBtn = document.getElementById("discover-detail-trailer-btn");
  if (trailerBtn) {
    trailerBtn.addEventListener("click", () => openDiscoverExternalUrl(trailerBtn.getAttribute("data-url")));
  }

  const tmdbBtn = document.getElementById("discover-detail-tmdb-btn");
  if (tmdbBtn) {
    tmdbBtn.addEventListener("click", () => openDiscoverExternalUrl(tmdbBtn.getAttribute("data-url")));
  }

  container.querySelectorAll(".discover-movie-quality-dl-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const quality = btn.getAttribute("data-quality") || "";
      const suggestedName = btn.getAttribute("data-suggested-name") || "";
      openDiscoverSourcePrompt({
        isSeasonZip: false,
        displayTitle: rawTitle,
        quality,
        suggestedName
      });
    });
  });

  container.querySelectorAll(".discover-season-card").forEach(card => {
    const sNum = Number(card.getAttribute("data-season-number"));
    const openSeason = () => openDiscoverSeasonPage(movie, sNum);
    card.addEventListener("click", openSeason);
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openSeason();
      }
    });
  });

  container.querySelectorAll(".discover-season-mini-zip-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const sNum = Number(btn.getAttribute("data-season-zip"));
      const seasonLabel = sNum === 0 ? "Specials" : `Season ${sNum}`;
      openDiscoverSourcePrompt({
        isSeasonZip: true,
        displayTitle: `${rawTitle} — ${seasonLabel}`
      });
    });
  });
}

function buildDiscoverEpisodesRowsHtml(seriesItem, seasonNumber, episodes, filterQuery = "") {
  if (!Array.isArray(episodes) || episodes.length === 0) {
    return `<div class="discover-archive-empty">No episode details available on TMDB for this season yet.</div>`;
  }
  const needle = String(filterQuery || "").trim().toLowerCase();
  const filtered = needle
    ? episodes.filter(ep => {
        const epNum = Number(ep.episode_number) || 0;
        const code = formatSeasonEpisodeCode(seasonNumber, epNum).toLowerCase();
        const name = String(ep.name || "").toLowerCase();
        const overview = String(ep.overview || "").toLowerCase();
        return code.includes(needle) || String(epNum) === needle || name.includes(needle) || overview.includes(needle);
      })
    : episodes;

  if (filtered.length === 0) {
    return `<div class="discover-archive-empty">No episodes matched &ldquo;${escapeDiscoverHtml(filterQuery)}&rdquo;.</div>`;
  }

  const seriesTitle = getItemTitle(seriesItem);
  return filtered.map(ep => {
    const epNum = Number(ep.episode_number) || 0;
    const code = formatSeasonEpisodeCode(seasonNumber, epNum);
    const epTitleRaw = ep.name || `Episode ${epNum}`;
    const epTitle = escapeDiscoverHtml(epTitleRaw);
    const epDate = ep.air_date ? formatDiscoverFullDate(ep.air_date, "") : "";
    const epMins = Number(ep.runtime) || 0;
    const epRating = typeof ep.vote_average === "number" && ep.vote_average > 0 ? `★ ${ep.vote_average.toFixed(1)}` : "";
    const epOverview = escapeDiscoverHtml(ep.overview || "No episode description available on TMDB.");
    const stillHtml = ep.still_path
      ? `<img src="${escapeDiscoverHtml(TMDB_IMG_W300 + ep.still_path)}" alt="${code}" loading="lazy" />`
      : `<span>${escapeDiscoverHtml(code)}</span>`;
    const suggestedName = `${sanitizeDiscoverFilename(seriesTitle)}.${code}.${sanitizeDiscoverFilename(epTitleRaw)}.mp4`;

    return `
      <div class="discover-episode-full-row">
        <div class="discover-episode-still">${stillHtml}</div>
        <div class="discover-episode-full-info">
          <div class="discover-episode-full-head">
            <span class="discover-episode-code-pill">${escapeDiscoverHtml(code)}</span>
            <span class="discover-episode-full-title">${epTitle}</span>
          </div>
          <div class="discover-episode-full-meta">
            ${epDate ? `<span>Aired: ${escapeDiscoverHtml(epDate)}</span>` : ""}
            ${epMins > 0 ? `<span>${epMins} min</span>` : ""}
            ${epRating ? `<span>${escapeDiscoverHtml(epRating)}</span>` : ""}
          </div>
          <div class="discover-episode-full-overview">${epOverview}</div>
        </div>
        <button
          type="button"
          class="discover-quality-dl-btn discover-episode-full-dl-btn"
          data-ep-title="${escapeDiscoverHtml(`${seriesTitle} — ${code}: ${epTitleRaw}`)}"
          data-suggested-name="${escapeDiscoverHtml(suggestedName)}"
        >
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
            <polyline points="7 10 12 15 17 10"></polyline>
            <line x1="12" y1="15" x2="12" y2="3"></line>
          </svg>
          <span>Download</span>
        </button>
      </div>
    `;
  }).join("");
}

function renderDiscoverSeasonPage(seriesItem, seasonNumber, seasonData = null, opts = {}) {
  const container = document.getElementById("discover-season-page");
  if (!container || !seriesItem) return;

  const sNum = Number(seasonNumber);
  const rawSeriesTitle = getItemTitle(seriesItem);
  const seriesTitle = escapeDiscoverHtml(rawSeriesTitle);
  const sortedSeasons = getSortedSeriesSeasons(seriesItem);
  const regularSeasons = sortedSeasons.filter(s => Number(s.season_number) > 0);
  const totalSeriesSeasons = regularSeasons.length || Number(seriesItem.number_of_seasons) || sortedSeasons.length || 1;
  const seasonEntry = sortedSeasons.find(s => Number(s.season_number) === sNum) || null;

  const episodes = seasonData && Array.isArray(seasonData.episodes) ? seasonData.episodes : [];
  const epCount = episodes.length || (seasonEntry ? Number(seasonEntry.episode_count) || 0 : 0);
  const rawSeasonName = (seasonData && seasonData.name) || (seasonEntry && seasonEntry.name) || (sNum === 0 ? "Specials" : `Season ${sNum}`);
  const seasonName = escapeDiscoverHtml(rawSeasonName);
  const seasonOverviewRaw = (seasonData && seasonData.overview)
    || (seasonEntry && seasonEntry.overview)
    || seriesItem.overview
    || "No synopsis available on TMDB for this season yet.";
  const seasonOverview = escapeDiscoverHtml(seasonOverviewRaw);

  const airDateRaw = (seasonData && seasonData.air_date)
    || (seasonEntry && seasonEntry.air_date)
    || (episodes[0] && episodes[0].air_date)
    || getItemDate(seriesItem);
  const airDateLabel = formatDiscoverFullDate(airDateRaw, "Air date TBA");

  const ratingVal = computeDiscoverSeasonRating(seriesItem, seasonData, seasonEntry, episodes);
  const ratingPill = ratingVal > 0
    ? `<span class="discover-stat-pill is-rating">&#9733; ${ratingVal.toFixed(1)} / 10</span>`
    : `<span class="discover-stat-pill">Unrated</span>`;

  const backdropUrl = seriesItem.backdrop_path ? `${TMDB_IMG_W780}${seriesItem.backdrop_path}` : "";
  const posterPath = (seasonData && seasonData.poster_path) || (seasonEntry && seasonEntry.poster_path) || seriesItem.poster_path || "";
  const posterUrl = posterPath ? `${TMDB_IMG_W342}${posterPath}` : "";
  const posterBlock = posterUrl
    ? `<img src="${escapeDiscoverHtml(posterUrl)}" alt="${seasonName}" />`
    : `<div class="discover-page-poster-fallback"><span>${seasonName}</span></div>`;

  const genres = Array.isArray(seriesItem.genres) ? seriesItem.genres.slice(0, 5) : [];
  const genresHtml = genres.length
    ? `<div class="discover-modal-genres">${genres.map(g => `<span class="discover-genre-chip">${escapeDiscoverHtml(g.name)}</span>`).join("")}</div>`
    : "";

  const seasonTabsHtml = sortedSeasons.length > 1
    ? `<div class="discover-season-pills">${sortedSeasons.map(s => {
        const sn = Number(s.season_number);
        const tabName = escapeDiscoverHtml(s.name || (sn === 0 ? "Specials" : `Season ${sn}`));
        const activeCls = sn === sNum ? " active" : "";
        return `<button type="button" class="discover-season-pill${activeCls}" data-switch-season="${sn}">${tabName}${Number(s.episode_count) > 0 ? ` (${Number(s.episode_count)})` : ""}</button>`;
      }).join("")}</div>`
    : "";

  const seasonPositionLabel = sNum === 0
    ? `Specials • Series has ${totalSeriesSeasons} Season${totalSeriesSeasons === 1 ? "" : "s"}`
    : `Season ${sNum} of ${totalSeriesSeasons}`;

  const zipLabel = sNum === 0 ? "Download Specials (.zip)" : `Download Whole Season ${sNum} (.zip)`;
  const episodesBodyHtml = opts.loading
    ? `<div class="discover-archive-empty">Loading Season ${sNum} episodes from TMDB...</div>`
    : (opts.error
      ? `<div class="discover-archive-empty">Could not load episodes (${escapeDiscoverHtml(opts.error)}).</div>`
      : buildDiscoverEpisodesRowsHtml(seriesItem, sNum, episodes, ""));

  const seasonRatingMeta = ratingVal > 0
    ? `<span class="discover-meta-rating"><span class="movie-star">&#9733;</span> ${ratingVal.toFixed(1)}/10</span>`
    : `<span>Unrated</span>`;
  const seasonInlineFacts = [
    seasonRatingMeta,
    `<span>${epCount} Episode${epCount === 1 ? "" : "s"}</span>`,
    `<span>First aired ${escapeDiscoverHtml(airDateLabel)}</span>`,
    `<span>${escapeDiscoverHtml(seasonPositionLabel)}</span>`
  ].join('<span class="discover-meta-sep">&bull;</span>');

  container.innerHTML = `
    <div class="discover-page-topbar">
      <div class="discover-breadcrumb">
        <button type="button" class="discover-back-pill" id="discover-season-back-series-btn">&larr; Back to ${seriesTitle}</button>
        <button type="button" class="discover-back-pill is-secondary" id="discover-season-back-browse-btn">Discover</button>
      </div>
    </div>

    <div class="discover-page-hero">
      <div class="discover-page-hero-bg" style="background-image: ${backdropUrl ? `url(&quot;${escapeDiscoverHtml(backdropUrl)}&quot;)` : "none"};"></div>
      <div class="discover-page-hero-scrim"></div>
      <div class="discover-page-hero-content">
        <div class="discover-page-poster">${posterBlock}</div>
        <div class="discover-page-info">
          <div class="discover-page-subtitle">${seriesTitle} &bull; ${totalSeriesSeasons} Season${totalSeriesSeasons === 1 ? "" : "s"} Total</div>
          <h2 class="discover-page-title">${seasonName}</h2>
          <div class="discover-page-inline-meta">${seasonInlineFacts}</div>
          ${genresHtml}
          <p class="discover-page-overview">${seasonOverview}</p>
          <div class="discover-page-actions">
            <button type="button" class="discover-page-btn is-primary" id="discover-season-page-zip-btn">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.1">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                <polyline points="7 10 12 15 17 10"></polyline>
                <line x1="12" y1="15" x2="12" y2="3"></line>
              </svg>
              <span>${escapeDiscoverHtml(zipLabel)}</span>
            </button>
          </div>
        </div>
      </div>
    </div>

    ${seasonTabsHtml ? `
      <div class="discover-page-section">
        <div class="discover-page-section-head">
          <h3 class="discover-page-section-title">Seasons (${sortedSeasons.length})</h3>
        </div>
        ${seasonTabsHtml}
      </div>
    ` : ""}

    <div class="discover-page-section">
      <div class="discover-page-section-head">
        <h3 class="discover-page-section-title">Episodes (${epCount})</h3>
        ${episodes.length > 6 ? `<input type="search" id="discover-episode-filter-input" class="discover-filter-select" style="min-width: 240px;" placeholder="Filter episodes by number or title..." />` : ""}
      </div>
      <div class="discover-episodes-list" id="discover-season-episodes-list">
        ${episodesBodyHtml}
      </div>
    </div>
  `;

  const bindEpisodeDownloadButtons = () => {
    container.querySelectorAll(".discover-episode-full-dl-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        openDiscoverSourcePrompt({
          isSeasonZip: false,
          displayTitle: btn.getAttribute("data-ep-title") || rawSeasonName,
          suggestedName: btn.getAttribute("data-suggested-name") || ""
        });
      });
    });
  };
  bindEpisodeDownloadButtons();

  const backSeriesBtn = document.getElementById("discover-season-back-series-btn");
  if (backSeriesBtn) {
    backSeriesBtn.addEventListener("click", () => {
      renderDiscoverDetailPage(seriesItem);
      showDiscoverSubpage("detail");
    });
  }

  const backBrowseBtn = document.getElementById("discover-season-back-browse-btn");
  if (backBrowseBtn) {
    backBrowseBtn.addEventListener("click", () => showDiscoverSubpage("browse"));
  }

  const zipBtn = document.getElementById("discover-season-page-zip-btn");
  if (zipBtn) {
    zipBtn.addEventListener("click", () => {
      openDiscoverSourcePrompt({
        isSeasonZip: true,
        displayTitle: `${rawSeriesTitle} — ${rawSeasonName}`
      });
    });
  }

  container.querySelectorAll("[data-switch-season]").forEach(btn => {
    btn.addEventListener("click", () => {
      const targetS = Number(btn.getAttribute("data-switch-season"));
      if (targetS !== sNum) {
        openDiscoverSeasonPage(seriesItem, targetS);
      }
    });
  });

  const filterInput = document.getElementById("discover-episode-filter-input");
  const listEl = document.getElementById("discover-season-episodes-list");
  if (filterInput && listEl) {
    filterInput.addEventListener("input", () => {
      listEl.innerHTML = buildDiscoverEpisodesRowsHtml(seriesItem, sNum, episodes, filterInput.value);
      bindEpisodeDownloadButtons();
    });
  }
}

async function openDiscoverSeasonPage(seriesItem, seasonNumber) {
  if (!seriesItem) return;
  const numericId = Number(seriesItem.id);
  const sNum = Number(seasonNumber);
  const cacheKey = seriesItem._cacheKey || `tv:${numericId}`;
  discoverState.activeDetailKey = cacheKey;
  discoverState.activeSeasonNum = sNum;

  const token = ++discoverState.seasonLookupToken;
  showDiscoverSubpage("season");

  const seasonCacheKey = `${numericId}:S${sNum}`;
  if (discoverState.seasonCache.has(seasonCacheKey)) {
    renderDiscoverSeasonPage(seriesItem, sNum, discoverState.seasonCache.get(seasonCacheKey));
    return;
  }

  renderDiscoverSeasonPage(seriesItem, sNum, null, { loading: true });
  try {
    const seasonData = await fetchDiscoverSeasonData(numericId, sNum);
    if (discoverState.seasonLookupToken !== token || discoverState.activePage !== "season" || discoverState.activeDetailKey !== cacheKey) {
      return;
    }
    renderDiscoverSeasonPage(seriesItem, sNum, seasonData);
  } catch (err) {
    if (discoverState.seasonLookupToken !== token || discoverState.activePage !== "season" || discoverState.activeDetailKey !== cacheKey) {
      return;
    }
    renderDiscoverSeasonPage(seriesItem, sNum, null, { error: err.message });
  }
}

async function openDiscoverDetailPage(movieId, mediaTypeHint = null) {
  const numericId = Number(movieId);
  const mediaType = mediaTypeHint === "tv" || mediaTypeHint === "movie"
    ? mediaTypeHint
    : (discoverState.activeMedia === "series" ? "tv" : "movie");
  const cacheKey = `${mediaType}:${numericId}`;
  discoverState.activeDetailKey = cacheKey;
  discoverState.activeSeasonNum = 1;
  discoverState.seasonLookupToken++;

  showDiscoverSubpage("detail");

  const cached = discoverState.movieCache.get(cacheKey);
  if (cached) {
    renderDiscoverDetailPage(cached);
  } else {
    const detailContainer = document.getElementById("discover-detail-page");
    if (detailContainer) {
      detailContainer.innerHTML = `
        <div class="discover-page-topbar">
          <button type="button" class="discover-back-pill" id="discover-loading-back-btn">&larr; Back to Discover</button>
        </div>
        <div class="discover-page-section">
          <div class="discover-archive-empty">Loading title metadata from TMDB...</div>
        </div>
      `;
      const loadingBack = document.getElementById("discover-loading-back-btn");
      if (loadingBack) loadingBack.addEventListener("click", () => showDiscoverSubpage("browse"));
    }
  }

  try {
    const appendParam = mediaType === "tv" ? "videos,translations,credits,episode_groups" : "videos,translations,credits";
    let detailed = await tmdbFetch(`/${mediaType}/${numericId}?append_to_response=${appendParam}&language=en-US`);
    if (mediaType === "tv") {
      detailed = await resolveVirtualSeasonsFromEpisodeGroup(detailed, numericId);
    }
    const normalized = normalizeDiscoverItem(detailed, mediaType) || { ...detailed, _mediaType: mediaType, _cacheKey: cacheKey };
    if (detailed && detailed._resolvedSeasons) {
      normalized._resolvedSeasons = detailed._resolvedSeasons;
    }
    discoverState.movieCache.set(cacheKey, normalized);
    if (discoverState.activePage === "detail" && discoverState.activeDetailKey === cacheKey) {
      renderDiscoverDetailPage(normalized);
    }
  } catch (err) {
    console.warn("Failed to load extended TMDB details:", err);
  }
}

const openDiscoverMovieModal = openDiscoverDetailPage;
(function setupDiscoverListeners() {
  const form = document.getElementById("discover-search-form");
  const input = document.getElementById("discover-search-input");
  const clearBtn = document.getElementById("discover-clear-btn");
  const backBtn = document.getElementById("discover-back-btn");
  const refreshBtn = document.getElementById("discover-refresh-btn");
  const resetFiltersBtn = document.getElementById("discover-filter-reset");
  const viewDiscover = document.getElementById("view-discover");
  const sourceModal = document.getElementById("discover-source-modal");
  const sourceCloseBtn = document.getElementById("discover-source-close");
  const sourceCancelBtn = document.getElementById("discover-source-cancel-btn");
  const sourceStartBtn = document.getElementById("discover-source-start-btn");
  const sourceUrlInput = document.getElementById("discover-source-url-input");

  if (input && clearBtn) {
    input.addEventListener("input", () => {
      const val = input.value.trim();
      clearBtn.style.display = val ? "flex" : "none";
      if (!val) {
        closeDiscoverAutocomplete();
        runDiscoverSearch("");
      } else {
        scheduleDiscoverAutocomplete(input.value);
      }
    });
    input.addEventListener("keydown", (e) => {
      const box = document.getElementById("discover-autocomplete");
      const isOpen = box && box.style.display !== "none";
      if (!isOpen) return;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setDiscoverAutocompleteActive(discoverAcState.activeIndex + 1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setDiscoverAutocompleteActive(discoverAcState.activeIndex - 1);
      } else if (e.key === "Escape") {
        e.preventDefault();
        closeDiscoverAutocomplete();
      } else if (e.key === "Enter" && discoverAcState.activeIndex >= 0) {
        const picked = discoverAcState.items[discoverAcState.activeIndex];
        if (picked) {
          e.preventDefault();
          closeDiscoverAutocomplete();
          if (picked.type === "item" && picked.item) {
            openDiscoverMovieModal(picked.item.id, picked.item._mediaType);
          } else {
            runDiscoverSearch(input.value);
          }
        }
      }
    });
    input.addEventListener("focus", () => {
      if (input.value.trim()) {
        scheduleDiscoverAutocomplete(input.value);
      }
    });
    clearBtn.addEventListener("click", () => {
      input.value = "";
      clearBtn.style.display = "none";
      closeDiscoverAutocomplete();
      runDiscoverSearch("");
      input.focus();
    });
  }

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".discover-input-wrap")) {
      closeDiscoverAutocomplete();
    }
  });

  if (form && input) {
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      closeDiscoverAutocomplete();
      runDiscoverSearch(input.value);
    });
  }

  if (backBtn && input && clearBtn) {
    backBtn.addEventListener("click", () => {
      input.value = "";
      clearBtn.style.display = "none";
      closeDiscoverAutocomplete();
      resetDiscoverProFilters(false);
      showDiscoverSubpage("browse");
      executeDiscoverQuery("");
    });
  }

  if (refreshBtn) {
    refreshBtn.addEventListener("click", () => {
      closeDiscoverAutocomplete();
      showDiscoverSubpage("browse");
      if ((input && input.value.trim()) || hasActiveDiscoverFilters()) {
        executeDiscoverQuery(input ? input.value : "");
      } else {
        initDiscoverFeed(true);
      }
    });
  }

  document.querySelectorAll("#discover-media-tabs .discover-media-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      const mediaKey = tab.getAttribute("data-media");
      if (mediaKey) switchDiscoverMediaTab(mediaKey);
    });
  });

  const filterSelectMap = [
    ["discover-filter-genre", "genre"],
    ["discover-filter-year", "year"],
    ["discover-filter-rating", "rating"],
    ["discover-filter-sort", "sort"]
  ];
  filterSelectMap.forEach(([elId, filterKey]) => {
    const el = document.getElementById(elId);
    if (!el) return;
    el.addEventListener("change", () => {
      discoverState.filters[filterKey] = el.value;
      syncDiscoverResetButton();
      executeDiscoverQuery(input ? input.value : "");
    });
  });

  if (resetFiltersBtn) {
    resetFiltersBtn.addEventListener("click", () => {
      resetDiscoverProFilters(true);
    });
  }

  document.querySelectorAll("#discover-filter-row .discover-pill").forEach(pill => {
    pill.addEventListener("click", () => {
      applyDiscoverSectionFilter(pill.getAttribute("data-section") || "all");
    });
  });

  if (viewDiscover) {
    viewDiscover.addEventListener("click", (e) => {
      const toggleBtn = e.target.closest(".discover-toggle-btn");
      if (toggleBtn) {
        const key = toggleBtn.getAttribute("data-expand");
        if (key && key in discoverState.expanded) {
          discoverState.expanded[key] = !discoverState.expanded[key];
          renderAllDiscoverSections();
        }
        return;
      }

      const card = e.target.closest(".movie-card");
      if (card) {
        const id = Number(card.getAttribute("data-movie-id"));
        const mediaType = card.getAttribute("data-media-type") || (discoverState.activeMedia === "series" ? "tv" : "movie");
        if (id) openDiscoverMovieModal(id, mediaType);
      }
    });
  }

  const wipModal = document.getElementById("discover-wip-modal");
  const wipCloseBtn = document.getElementById("discover-wip-close");
  const wipDismissBtn = document.getElementById("discover-wip-dismiss-btn");

  if (wipCloseBtn) {
    wipCloseBtn.addEventListener("click", closeDiscoverWipModal);
  }
  if (wipDismissBtn) {
    wipDismissBtn.addEventListener("click", closeDiscoverWipModal);
  }
  if (wipModal) {
    wipModal.addEventListener("click", (e) => {
      if (e.target === wipModal) closeDiscoverWipModal();
    });
  }

  if (sourceCloseBtn) {
    sourceCloseBtn.addEventListener("click", closeDiscoverSourcePrompt);
  }
  if (sourceCancelBtn) {
    sourceCancelBtn.addEventListener("click", closeDiscoverSourcePrompt);
  }
  if (sourceStartBtn) {
    sourceStartBtn.addEventListener("click", submitDiscoverSourcePrompt);
  }
  if (sourceUrlInput) {
    sourceUrlInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submitDiscoverSourcePrompt();
      }
    });
  }
  if (sourceModal) {
    sourceModal.addEventListener("click", (e) => {
      if (e.target === sourceModal) closeDiscoverSourcePrompt();
    });
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      const box = document.getElementById("discover-autocomplete");
      if (box && box.style.display !== "none") {
        closeDiscoverAutocomplete();
        return;
      }
      if (sourceModal && sourceModal.style.display !== "none") {
        closeDiscoverSourcePrompt();
        return;
      }
      if (wipModal && wipModal.style.display !== "none") {
        closeDiscoverWipModal();
      }
    }
  });

  updateDiscoverMediaUI();
})();

// ============================================================================
// Websites Directory & Protected Built-In Browser (Zero-Overhead Until Opened)
// ============================================================================
(function setupWebsitesBrowser() {
  const STORAGE_KEY = "hyperdrain_websites_v1";
  const DEFAULT_WEBSITES = [
    {
      id: "site-archive",
      name: "Internet Archive (Movies)",
      url: "https://archive.org/details/movies",
      liveUrl: "https://archive.org/details/movies",
      category: "official",
      description: "Public-domain films, classic cinema, and open digital video archives with direct downloads."
    },
    {
      id: "site-plex",
      name: "Plex Free Movies & TV",
      url: "https://watch.plex.tv/",
      liveUrl: "https://watch.plex.tv/",
      category: "official",
      description: "Official ad-supported catalog of free on-demand movies, series, and live channels."
    },
    {
      id: "site-tubi",
      name: "Tubi TV",
      url: "https://tubitv.com/",
      liveUrl: "https://tubitv.com/",
      category: "official",
      description: "Free legal streaming movies and TV series catalog."
    },
    {
      id: "site-pluto",
      name: "Pluto TV",
      url: "https://pluto.tv/",
      liveUrl: "https://pluto.tv/",
      category: "official",
      description: "Official free live TV and on-demand movie portal."
    },
    {
      id: "site-wikimedia",
      name: "Wikimedia Commons Video",
      url: "https://commons.wikimedia.org/wiki/Category:Videos",
      liveUrl: "https://commons.wikimedia.org/wiki/Category:Videos",
      category: "official",
      description: "Creative Commons and public-domain downloadable media files."
    },
    {
      id: "site-nasa",
      name: "NASA Image & Video Library",
      url: "https://images.nasa.gov/",
      liveUrl: "https://images.nasa.gov/",
      category: "official",
      description: "Official high-resolution space documentaries, raw clips, and direct MP4 downloads."
    }
  ];

  const state = {
    websites: [],
    filter: "all",
    search: "",
    editingId: null,
    activeSiteId: null,
    entryWatch: null,
    shieldEnabled: true,
    blockedTotal: 0,
    pendingPopupUrl: "",
    sniffedMediaUrl: "",
    ecoMode: true,
    initialized: false,
    webviewMounted: false
  };

  function normalizeHttpUrl(raw) {
    let v = String(raw || "").trim();
    if (!v) return "";
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(v)) {
      v = "https://" + v;
    }
    try {
      const u = new URL(v);
      if (u.protocol !== "http:" && u.protocol !== "https:") return "";
      return u.toString();
    } catch (_) {
      return "";
    }
  }

  function loadWebsites() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          let cleaned = false;
          state.websites = parsed.map(item => {
            if (item && item.liveUrl && isIgnoredRedirectUrl(item.liveUrl)) {
              cleaned = true;
              const copy = { ...item, liveUrl: item.url };
              delete copy.lastRedirectedFrom;
              return copy;
            }
            return item;
          });
          if (cleaned) saveWebsites();
          return;
        }
      }
    } catch (_) {}
    state.websites = DEFAULT_WEBSITES.map(item => ({ ...item }));
    saveWebsites();
  }

  function saveWebsites() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.websites));
    } catch (_) {}
  }

  function updateRendererStatusUI(isLive) {
    state.webviewMounted = isLive;
    const navBadge = document.getElementById("badge-websites-status");
    const pill = document.getElementById("websites-renderer-pill");
    const pillText = document.getElementById("websites-renderer-text");

    if (navBadge) {
      navBadge.textContent = isLive ? "Live" : "Idle";
      navBadge.classList.toggle("muted", !isLive);
    }
    if (pill) {
      pill.classList.toggle("live", isLive);
      pill.classList.toggle("idle", !isLive);
    }
    if (pillText) {
      pillText.textContent = isLive ? "Renderer Active" : "Idle · 0 extra RAM";
    }
  }

  function updateShieldUI(stats) {
    if (!stats) return;
    state.shieldEnabled = Boolean(stats.enabled);
    state.blockedTotal = (stats.blockedAds || 0) + (stats.blockedPopups || 0);
    const btn = document.getElementById("wb-shield-btn");
    const label = document.getElementById("wb-shield-label");
    const count = document.getElementById("wb-shield-count");
    if (btn) btn.classList.toggle("active", state.shieldEnabled);
    if (label) label.textContent = state.shieldEnabled ? "Shield ON" : "Shield OFF";
    if (count) count.textContent = `${state.blockedTotal} blocked`;
  }

  function updateEcoUI(ecoEnabled) {
    state.ecoMode = Boolean(ecoEnabled);
    const btn = document.getElementById("wb-eco-btn");
    if (btn) {
      btn.classList.toggle("active", state.ecoMode);
      btn.textContent = state.ecoMode ? "Eco: No Video" : "Video Playback ON";
    }
  }

  function isIgnoredRedirectUrl(rawUrl) {
    if (!rawUrl || !/^https?:\/\//i.test(rawUrl)) return true;
    const lower = rawUrl.toLowerCase();
    return (
      lower.includes("challenges.cloudflare") ||
      lower.includes("/cdn-cgi/") ||
      lower.includes("accounts.google.") ||
      lower.includes("es344.com") ||
      lower.includes("1xlite") ||
      lower.includes("1xbet") ||
      lower.includes("tag=d_") ||
      lower.includes("registration") ||
      lower.includes("popunder")
    );
  }

  function getDomainBrandStem(rawUrlOrHost) {
    if (!rawUrlOrHost) return "";
    let host = String(rawUrlOrHost).trim().toLowerCase();
    try {
      if (host.includes("://")) host = new URL(host).hostname.toLowerCase();
    } catch (_) {}
    host = host.replace(/^(?:www\d*|m|mobile|new|ww\d+|get)\./i, "");
    const parts = host.split(".").filter(Boolean);
    if (parts.length === 0) return "";
    const stem = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
    return stem.replace(/[^a-z0-9]/g, "");
  }

  function isFileHosterUrl(rawUrl) {
    if (!rawUrl) return false;
    const lower = String(rawUrl).toLowerCase();
    return /\b(driveseed|driveleech|hubcloud|gdflix|filepress|gofile|pixeldrain|mediafire|mega\.nz|rapidgator|1fichier|buzzheavier|vikingfile|mixdrop|streamtape|doodstream)\b/.test(lower);
  }

  function findMatchingSiteForUrl(targetUrl, allowBrandMatch = true) {
    if (!targetUrl) return { site: null, matchType: "none" };
    let targetParsed;
    try {
      targetParsed = new URL(targetUrl);
    } catch (_) {
      return { site: null, matchType: "none" };
    }
    const targetHost = targetParsed.hostname.toLowerCase().replace(/^www\./i, "");
    const exact = state.websites.find((s) => {
      try {
        const sHost = new URL(s.liveUrl || s.url).hostname.toLowerCase().replace(/^www\./i, "");
        return sHost === targetHost;
      } catch (_) {
        return false;
      }
    });
    if (exact) return { site: exact, matchType: "exact" };

    if (!allowBrandMatch || isIgnoredRedirectUrl(targetUrl) || isFileHosterUrl(targetUrl)) {
      return { site: null, matchType: "none" };
    }

    const targetStem = getDomainBrandStem(targetHost);
    if (targetStem && targetStem.length >= 4) {
      if (state.activeSiteId) {
        const activeSite = state.websites.find((s) => s.id === state.activeSiteId);
        if (activeSite) {
          const activeStem = getDomainBrandStem(activeSite.liveUrl || activeSite.url);
          const nameStem = String(activeSite.name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
          if (activeStem === targetStem || (nameStem && (targetStem.includes(nameStem) || nameStem.includes(targetStem)))) {
            return { site: activeSite, matchType: "brand" };
          }
        }
      }
      const brandMatch = state.websites.find((s) => {
        const sStem = getDomainBrandStem(s.liveUrl || s.url);
        const origStem = getDomainBrandStem(s.url);
        const nameStem = String(s.name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
        return sStem === targetStem || origStem === targetStem || (nameStem && nameStem.length >= 4 && targetStem === nameStem);
      });
      if (brandMatch) return { site: brandMatch, matchType: "brand" };
    }

    return { site: null, matchType: "none" };
  }

  function updatePinDomainButton(wv) {
    const pinBtn = document.getElementById("wb-pin-domain-btn");
    if (!pinBtn) return;
    if (!state.activeSiteId || !wv) {
      pinBtn.style.display = "none";
      return;
    }
    const activeSite = state.websites.find((s) => s.id === state.activeSiteId);
    if (!activeSite) {
      pinBtn.style.display = "none";
      return;
    }
    try {
      const curUrl = wv.getURL();
      if (!curUrl || !/^https?:\/\//i.test(curUrl) || isIgnoredRedirectUrl(curUrl) || isFileHosterUrl(curUrl)) {
        pinBtn.style.display = "none";
        return;
      }
      const curOrigin = new URL(curUrl).origin;
      const savedOrigin = new URL(activeSite.liveUrl || activeSite.url).origin;
      if (curOrigin && savedOrigin && curOrigin !== savedOrigin) {
        pinBtn.textContent = `Save ${new URL(curUrl).hostname.replace(/^www\./i, "")}`;
        pinBtn.style.display = "inline-flex";
      } else {
        pinBtn.style.display = "none";
      }
    } catch (_) {
      pinBtn.style.display = "none";
    }
  }

  function rememberSiteRedirect(siteId, targetUrl, expectedOriginHint, forceDifferentDomain = false) {
    if (isIgnoredRedirectUrl(targetUrl)) return false;
    if (!forceDifferentDomain && isFileHosterUrl(targetUrl)) return false;
    let nextParsed;
    try {
      nextParsed = new URL(targetUrl);
    } catch (_) {
      return false;
    }

    let site = null;
    if (siteId) {
      site = state.websites.find(s => s.id === siteId) || null;
    }
    if (!site && expectedOriginHint) {
      site = state.websites.find(s => {
        try {
          return new URL(s.liveUrl || s.url).origin === expectedOriginHint;
        } catch (_) {
          return false;
        }
      }) || null;
    }
    if (!site) return false;

    const currentEffective = site.liveUrl || site.url;
    let currentOrigin = "";
    let basePath = "/";
    try {
      const curParsed = new URL(currentEffective);
      currentOrigin = curParsed.origin;
      basePath = new URL(site.url).pathname || "/";
    } catch (_) {}

    if (!currentOrigin || nextParsed.origin === currentOrigin) return false;

    const updatedUrl = (nextParsed.pathname && nextParsed.pathname !== "/")
      ? nextParsed.toString()
      : (nextParsed.origin + (basePath === "/" ? "/" : basePath));

    site.lastRedirectedFrom = currentOrigin;
    site.liveUrl = updatedUrl;
    site.redirectCount = (site.redirectCount || 0) + 1;
    site.redirectUpdatedAt = Date.now();
    saveWebsites();

    const pill = document.getElementById("wb-redirect-pill");
    if (pill) {
      pill.textContent = `Saved: ${nextParsed.hostname}`;
      pill.style.display = "inline-flex";
    }
    if (typeof showGlobalToast === "function") {
      showGlobalToast(`Updated ${site.name} live domain to ${nextParsed.hostname}`, "success");
    }
    updatePinDomainButton(getMountedWebview());
    renderWebsitesGrid();
    return true;
  }

  function renderWebsitesGrid() {
    const grid = document.getElementById("websites-grid");
    if (!grid) return;

    const q = state.search.trim().toLowerCase();
    const filtered = state.websites.filter(site => {
      if (state.filter === "official" && site.category !== "official") return false;
      if (state.filter === "custom" && site.category === "official") return false;
      if (state.filter === "redirected" && (!site.liveUrl || site.liveUrl === site.url)) return false;
      if (q) {
        const hay = `${site.name} ${site.url} ${site.liveUrl || ""} ${site.description || ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    const cardsHtml = filtered.map(site => {
      const effectiveUrl = site.liveUrl || site.url;
      let displayHost = effectiveUrl;
      let siteOrigin = "";
      try {
        const u = new URL(effectiveUrl);
        displayHost = u.hostname.replace(/^www\./i, "");
        siteOrigin = u.origin;
      } catch (_) {}
      const initial = escapeDiscoverHtml((site.name || displayHost || "W").trim().charAt(0).toUpperCase());
      const wasRedirected = Boolean(site.liveUrl && site.liveUrl !== site.url);
      const primaryIcon = site.iconUrl || (displayHost ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(displayHost)}&sz=128` : "");
      const fallbackIco = siteOrigin ? `${siteOrigin}/favicon.ico` : "";

      return `
        <div class="site-app-tile" data-site-open="${escapeDiscoverHtml(site.id)}" title="${escapeDiscoverHtml(effectiveUrl)}">
          <div class="site-app-icon-box">
            ${wasRedirected ? `<span class="site-app-redirect-dot" title="Updated from ${escapeDiscoverHtml(site.lastRedirectedFrom || site.url)}"></span>` : ""}
            <button type="button" class="site-app-menu-btn" data-action="menu" data-site-id="${escapeDiscoverHtml(site.id)}" aria-label="Site options">⋯</button>
            <div class="site-app-popover">
              <button type="button" class="site-app-popover-item" data-action="open" data-site-id="${escapeDiscoverHtml(site.id)}">Open</button>
              <button type="button" class="site-app-popover-item" data-action="edit" data-site-id="${escapeDiscoverHtml(site.id)}">Edit</button>
              ${wasRedirected ? `<button type="button" class="site-app-popover-item" data-action="reset" data-site-id="${escapeDiscoverHtml(site.id)}">Reset URL</button>` : ""}
              <button type="button" class="site-app-popover-item danger" data-action="delete" data-site-id="${escapeDiscoverHtml(site.id)}">Remove</button>
            </div>
            ${primaryIcon ? `
              <img class="site-app-favicon" src="${escapeDiscoverHtml(primaryIcon)}" data-fallback-ico="${escapeDiscoverHtml(fallbackIco)}" alt="" loading="lazy" onerror="if(this.dataset.fallbackIco && !this.dataset.triedFallback){this.dataset.triedFallback='1';this.src=this.dataset.fallbackIco;}else{this.style.display='none';this.nextElementSibling.style.display='flex';}" />
              <span class="site-app-fallback">${initial}</span>
            ` : `
              <span class="site-app-fallback" style="display:flex;">${initial}</span>
            `}
          </div>
          <div class="site-app-label">
            <span class="site-app-name">${escapeDiscoverHtml(site.name)}</span>
            <span class="site-app-host">${escapeDiscoverHtml(displayHost)}</span>
          </div>
        </div>
      `;
    }).join("");

    const addTileHtml = `
      <div class="site-app-tile site-app-add-tile" data-action="add-new" title="Add website">
        <div class="site-app-icon-box">+</div>
        <div class="site-app-label">
          <span class="site-app-name">Add Site</span>
          <span class="site-app-host">Custom URL</span>
        </div>
      </div>
    `;

    if (filtered.length === 0 && q) {
      grid.innerHTML = `<div class="discover-empty-state" style="grid-column: 1 / -1;">No sites matched "${escapeDiscoverHtml(state.search.trim())}".</div>${addTileHtml}`;
      return;
    }

    grid.innerHTML = cardsHtml + addTileHtml;
  }

  function updateBrowserNavControls(wv) {
    const backBtn = document.getElementById("wb-back-btn");
    const fwdBtn = document.getElementById("wb-forward-btn");
    const urlInput = document.getElementById("wb-url-input");
    const lockIcon = document.getElementById("wb-lock-icon");
    if (!wv) return;
    try {
      if (backBtn) backBtn.disabled = !wv.canGoBack();
      if (fwdBtn) fwdBtn.disabled = !wv.canGoForward();
      const cur = wv.getURL();
      if (urlInput && cur && cur !== "about:blank") {
        urlInput.value = cur;
        if (lockIcon) lockIcon.textContent = cur.startsWith("https://") ? "🔒" : "⚠️";
      }
    } catch (_) {}
  }

  function getMountedWebview() {
    return document.getElementById("wb-webview");
  }

  async function openUrlInSafeBrowser(rawUrl, siteObj = null) {
    const url = normalizeHttpUrl(rawUrl);
    if (!url) {
      if (typeof showGlobalToast === "function") {
        showGlobalToast("Please enter a valid http:// or https:// website URL.", "warning");
      }
      return;
    }

    // Fallback when viewed outside Electron (e.g. external web browser preview)
    if (!window.electronAPI || !window.electronAPI.isElectron) {
      window.open(url, "_blank", "noopener,noreferrer");
      if (typeof showGlobalToast === "function") {
        showGlobalToast("Popup-blocked embedded browsing is available inside the HyperDrain Desktop app.", "info");
      }
      return;
    }

    try {
      const stats = await window.electronAPI.ensureBrowserShield();
      updateShieldUI(stats);
      if (typeof window.electronAPI.getBrowserEco === "function") {
        const ecoRes = await window.electronAPI.getBrowserEco();
        if (ecoRes) updateEcoUI(ecoRes.ecoMode);
      }
    } catch (_) {}

    const dirView = document.getElementById("websites-directory-view");
    const browserView = document.getElementById("websites-browser-view");
    const mainContent = document.querySelector(".main-content");
    const websitesSection = document.getElementById("view-websites");
    const host = document.getElementById("wb-webview-host");
    const urlInput = document.getElementById("wb-url-input");
    const redirectPill = document.getElementById("wb-redirect-pill");
    const pinDomainBtn = document.getElementById("wb-pin-domain-btn");
    const popupBar = document.getElementById("wb-popup-bar");
    const sniffedBar = document.getElementById("wb-sniffed-bar");
    const loadingBar = document.getElementById("wb-loading-bar");

    if (dirView) dirView.style.display = "none";
    if (browserView) browserView.style.display = "flex";
    if (mainContent) mainContent.classList.add("websites-browsing-mode");
    if (websitesSection) websitesSection.classList.add("websites-browsing-mode");
    if (redirectPill) redirectPill.style.display = "none";
    if (pinDomainBtn) pinDomainBtn.style.display = "none";
    if (popupBar) popupBar.style.display = "none";
    if (sniffedBar) sniffedBar.style.display = "none";
    if (urlInput) urlInput.value = url;

    state.activeSiteId = siteObj ? siteObj.id : null;
    try {
      state.entryWatch = {
        siteId: siteObj ? siteObj.id : null,
        expectedOrigin: new URL(url).origin,
        startedAt: Date.now(),
        settled: false
      };
    } catch (_) {
      state.entryWatch = null;
    }

    let wv = getMountedWebview();
    const errorOverlay = document.getElementById("wb-error-overlay");
    const errorDesc = document.getElementById("wb-error-desc");
    if (errorOverlay) errorOverlay.style.display = "none";
    state.lastAttemptUrl = url;

    let preloadUrl = "";
    try {
      if (typeof window.electronAPI.getWebviewPreloadPath === "function") {
        preloadUrl = await window.electronAPI.getWebviewPreloadPath();
      }
    } catch (_) {}

    if (!wv && host) {
      host.innerHTML = "";
      wv = document.createElement("webview");
      wv.id = "wb-webview";
      wv.setAttribute("partition", "persist:hyperdrain-browser");
      wv.setAttribute("allowpopups", "");
      if (preloadUrl) {
        wv.setAttribute("preload", preloadUrl);
      }

      wv.addEventListener("dom-ready", () => {
        if (!state.shieldEnabled) return;
        wv.executeJavaScript(`
          if (!window.__hdPopGuard) {
            window.__hdPopGuard = true;
            let lastIntention = { ts: 0, href: '', interactive: false };
            const isOverlayEl = (el) => {
              if (!el || !el.getBoundingClientRect) return false;
              const r = el.getBoundingClientRect();
              const cs = getComputedStyle(el);
              if (cs.opacity === '0' || cs.visibility === 'hidden') return true;
              if (r.width > window.innerWidth * 0.8 && r.height > window.innerHeight * 0.8) return true;
              return false;
            };
            const recordIntent = (e) => {
              if (!e.isTrusted) return;
              const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
              if (a && isOverlayEl(a)) {
                e.preventDefault();
                e.stopImmediatePropagation();
                a.style.pointerEvents = 'none';
                return;
              }
              if (a && a.href && /^https?:\\/\\//i.test(a.href)) {
                if (a.getAttribute('target') === '_blank') {
                  a.removeAttribute('target');
                }
                lastIntention = { ts: Date.now(), href: a.href, interactive: true };
                return;
              }
              const btn = e.target && e.target.closest ? e.target.closest('button, [role="button"], input, select') : null;
              lastIntention = { ts: Date.now(), href: '', interactive: Boolean(btn) };
            };
            document.addEventListener('pointerdown', recordIntent, true);
            document.addEventListener('mousedown', recordIntent, true);
            document.addEventListener('click', recordIntent, true);
            // If an ad script cancelled a real external download link click (e.g. clicks 1-4 hijacks), navigate on click 1
            document.addEventListener('click', (e) => {
              if (!e.isTrusted || !e.defaultPrevented) return;
              const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
              if (!a || !a.href || !/^https?:\\/\\//i.test(a.href) || isOverlayEl(a)) return;
              const rawHref = (a.getAttribute('href') || '').trim();
              if (!rawHref || rawHref.startsWith('#') || rawHref.toLowerCase().startsWith('javascript:')) return;
              try {
                const targetUrl = new URL(a.href, location.href);
                if (targetUrl.origin !== location.origin) {
                  window.location.href = targetUrl.href;
                }
              } catch (_) {}
            }, false);
            const origAnchorClick = HTMLAnchorElement.prototype.click;
            HTMLAnchorElement.prototype.click = function() {
              try {
                if (this.href && /^https?:\\/\\//i.test(this.href)) {
                  const targetOrigin = new URL(this.href, location.href).origin;
                  if (targetOrigin !== location.origin) {
                    const dt = Date.now() - lastIntention.ts;
                    if (dt > 500 || lastIntention.href !== this.href) {
                      return;
                    }
                  }
                }
              } catch (_) {}
              return origAnchorClick.apply(this, arguments);
            };
            const origOpen = window.open.bind(window);
            window.open = function(u, t, f) {
              const dt = Date.now() - lastIntention.ts;
              if (dt > 500 || !lastIntention.interactive) return null;
              if (lastIntention.href && u && typeof u === 'string' && !u.startsWith('blob:')) {
                try {
                  if (new URL(u, location.href).href !== new URL(lastIntention.href).href) return null;
                } catch (_) {
                  return null;
                }
                location.href = u;
                return null;
              }
              if (f && String(f).trim().length > 0) return null;
              try {
                if (u && typeof u === 'string' && /^https?:\\/\\//i.test(u)) {
                  const uOrigin = new URL(u, location.href).origin;
                  if (uOrigin !== location.origin) return null;
                }
              } catch (_) {}
              return origOpen(u, t, f);
            };
          }
          true;
        `).catch(() => {});
      });

      wv.addEventListener("did-start-navigation", (e) => {
        if (e && e.isMainFrame && !e.isInPlace) {
          if (popupBar) popupBar.style.display = "none";
          if (sniffedBar) sniffedBar.style.display = "none";
          state.pendingPopupUrl = "";
          state.sniffedMediaUrl = "";
        }
      });

      wv.addEventListener("did-start-loading", () => {
        if (loadingBar) loadingBar.style.display = "block";
        if (errorOverlay) errorOverlay.style.display = "none";
      });

      wv.addEventListener("did-stop-loading", () => {
        if (loadingBar) loadingBar.style.display = "none";
        updateBrowserNavControls(wv);
      });

      wv.addEventListener("page-favicon-updated", (e) => {
        if (e && Array.isArray(e.favicons) && e.favicons.length > 0 && state.activeSiteId) {
          const site = state.websites.find(s => s.id === state.activeSiteId);
          if (site && site.iconUrl !== e.favicons[0]) {
            site.iconUrl = e.favicons[0];
            saveWebsites();
          }
        }
      });

      const handlePotentialRedirect = (navUrl) => {
        updateBrowserNavControls(wv);
        if (!navUrl) return;
        const withinEntryWindow = Boolean(
          state.entryWatch &&
          !state.entryWatch.settled &&
          Date.now() - state.entryWatch.startedAt < 25000
        );
        const brandMatch = state.activeSiteId ? findMatchingSiteForUrl(navUrl, true) : { site: null, matchType: "none" };
        const sameBrandActive = Boolean(
          brandMatch.site &&
          brandMatch.site.id === state.activeSiteId &&
          brandMatch.matchType === "brand"
        );

        if (withinEntryWindow || sameBrandActive) {
          const updated = rememberSiteRedirect(
            state.activeSiteId || (state.entryWatch && state.entryWatch.siteId),
            navUrl,
            state.entryWatch ? state.entryWatch.expectedOrigin : ""
          );
          if (updated && state.entryWatch) {
            try {
              state.entryWatch.expectedOrigin = new URL(navUrl).origin;
            } catch (_) {}
          }
        }
        updatePinDomainButton(wv);
      };

      wv.addEventListener("did-redirect-navigation", (e) => {
        if (e && e.isMainFrame !== false && e.url) {
          handlePotentialRedirect(e.url);
        }
      });

      wv.addEventListener("did-navigate", (e) => {
        updateBrowserNavControls(wv);
        if (e && e.url) {
          handlePotentialRedirect(e.url);
        }
      });

      wv.addEventListener("did-navigate-in-page", () => {
        updateBrowserNavControls(wv);
        updatePinDomainButton(wv);
      });

      wv.addEventListener("did-finish-load", () => {
        if (loadingBar) loadingBar.style.display = "none";
        updateBrowserNavControls(wv);
        try {
          const curUrl = wv.getURL();
          if (curUrl) handlePotentialRedirect(curUrl);
        } catch (_) {}
        updatePinDomainButton(wv);
      });

      wv.addEventListener("did-fail-load", (e) => {
        if (loadingBar) loadingBar.style.display = "none";
        if (e && e.errorCode === -3) return; // ERR_ABORTED on redirect/cancel is normal
        if (e && e.isMainFrame) {
          const overlay = document.getElementById("wb-error-overlay");
          const desc = document.getElementById("wb-error-desc");
          if (desc) {
            desc.textContent = `Failed to load ${e.validatedURL || state.lastAttemptUrl || "this site"} (${e.errorDescription || "Network error"}). If your ISP blocks direct access, enable Proxy / DPI Bypass in Settings or try Open in System Browser.`;
          }
          if (overlay) overlay.style.display = "flex";
        }
      });

      wv.src = url;
      host.appendChild(wv);
      updateRendererStatusUI(true);
    } else if (wv) {
      if (errorOverlay) errorOverlay.style.display = "none";
      wv.loadURL(url);
      updateRendererStatusUI(true);
    }
  }

  function unloadSafeBrowser() {
    const host = document.getElementById("wb-webview-host");
    const dirView = document.getElementById("websites-directory-view");
    const browserView = document.getElementById("websites-browser-view");
    const mainContent = document.querySelector(".main-content");
    const websitesSection = document.getElementById("view-websites");
    const loadingBar = document.getElementById("wb-loading-bar");
    const popupBar = document.getElementById("wb-popup-bar");
    const sniffedBar = document.getElementById("wb-sniffed-bar");
    const errorOverlay = document.getElementById("wb-error-overlay");

    if (host) host.innerHTML = "";
    if (loadingBar) loadingBar.style.display = "none";
    if (popupBar) popupBar.style.display = "none";
    if (sniffedBar) sniffedBar.style.display = "none";
    if (errorOverlay) errorOverlay.style.display = "none";
    if (browserView) browserView.style.display = "none";
    if (mainContent) mainContent.classList.remove("websites-browsing-mode");
    if (websitesSection) websitesSection.classList.remove("websites-browsing-mode");
    if (dirView) dirView.style.display = "flex";

    state.activeSiteId = null;
    state.entryWatch = null;
    updateRendererStatusUI(false);
    renderWebsitesGrid();
  }

  async function queueCapturedDownload({ url, filename, format_id, cookie, referer, origin, userAgent }) {
    if (!url) return;
    const lower = url.toLowerCase();
    const isStream = lower.includes(".m3u8") || lower.includes(".mpd");
    const endpoint = isStream ? `${API_BASE}/api/download-stream` : `${API_BASE}/api/tasks/add`;
    const payload = isStream
      ? {
          url,
          format_id: format_id || "",
          title: filename || "Captured Stream",
          referer: referer || "",
          origin: origin || "",
          cookie: cookie || "",
          user_agent: userAgent || "",
          connections: 32
        }
      : {
          url,
          suggested_name: filename || "",
          connections: 32,
          auto_extract: false,
          cookie: cookie || "",
          referer: referer || ""
        };

    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-HyperDrain-Token": AUTH_TOKEN
        },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        if (typeof initialLoadTasks === "function") initialLoadTasks();
        if (typeof showGlobalToast === "function") {
          showGlobalToast(`Downloading in HyperDrain: ${filename || url}`, "success");
        }
      } else {
        const errText = await res.text();
        if (typeof showGlobalToast === "function") {
          showGlobalToast(`Could not queue download: ${errText.trim() || res.status}`, "warning");
        }
      }
    } catch (err) {
      if (typeof showGlobalToast === "function") {
        showGlobalToast(`HyperDrain engine error: ${err.message}`, "warning");
      }
    }
  }

  async function syncAllWebsiteRedirects() {
    if (!window.electronAPI || typeof window.electronAPI.resolveSiteRedirect !== "function") {
      if (typeof showGlobalToast === "function") {
        showGlobalToast("Live redirect sync requires HyperDrain Desktop.", "info");
      }
      return;
    }
    const syncBtn = document.getElementById("websites-sync-btn");
    const prevHtml = syncBtn ? syncBtn.innerHTML : "";
    if (syncBtn) {
      syncBtn.disabled = true;
      syncBtn.textContent = "Checking...";
    }

    let updatedCount = 0;
    let failedCount = 0;

    for (const site of state.websites) {
      const target = site.liveUrl || site.url;
      try {
        const res = await window.electronAPI.resolveSiteRedirect(target);
        if (res && res.ok && res.changed && res.finalUrl) {
          let prevOrigin = "";
          try { prevOrigin = new URL(target).origin; } catch (_) {}
          if (rememberSiteRedirect(site.id, res.finalUrl, prevOrigin)) {
            updatedCount += 1;
          }
        } else if (!res || !res.ok) {
          failedCount += 1;
        }
      } catch (_) {
        failedCount += 1;
      }
    }

    if (syncBtn) {
      syncBtn.disabled = false;
      syncBtn.innerHTML = prevHtml;
    }

    if (typeof showGlobalToast === "function") {
      if (updatedCount > 0) {
        showGlobalToast(`Synced ${state.websites.length} sites: ${updatedCount} live domain(s) updated.`, "success");
      } else if (failedCount > 0) {
        showGlobalToast(`Checked ${state.websites.length} sites (${failedCount} unreachable or blocked).`, "info");
      } else {
        showGlobalToast("All saved website domains are already up to date.", "success");
      }
    }
  }

  function openWebsiteFormModal(siteId = null) {
    const modal = document.getElementById("website-form-modal");
    const titleEl = document.getElementById("website-form-title");
    const nameEl = document.getElementById("website-form-name");
    const urlEl = document.getElementById("website-form-url");
    const catEl = document.getElementById("website-form-category");
    const descEl = document.getElementById("website-form-desc");
    if (!modal) return;

    state.editingId = siteId;
    const existing = siteId ? state.websites.find(s => s.id === siteId) : null;
    if (titleEl) titleEl.textContent = existing ? "Edit Website" : "Add Website";
    if (nameEl) nameEl.value = existing ? existing.name : "";
    if (urlEl) urlEl.value = existing ? (existing.liveUrl || existing.url) : "";
    if (catEl) catEl.value = existing ? (existing.category || "custom") : "custom";
    if (descEl) descEl.value = existing ? (existing.description || "") : "";

    modal.style.display = "flex";
    modal.classList.add("show");
    if (nameEl) setTimeout(() => nameEl.focus(), 40);
  }

  function closeWebsiteFormModal() {
    const modal = document.getElementById("website-form-modal");
    if (!modal) return;
    modal.classList.remove("show");
    modal.style.display = "none";
    state.editingId = null;
  }

  function saveWebsiteForm() {
    const nameEl = document.getElementById("website-form-name");
    const urlEl = document.getElementById("website-form-url");
    const catEl = document.getElementById("website-form-category");
    const descEl = document.getElementById("website-form-desc");

    const name = nameEl ? nameEl.value.trim() : "";
    const url = normalizeHttpUrl(urlEl ? urlEl.value : "");
    const category = catEl ? catEl.value : "custom";
    const description = descEl ? descEl.value.trim() : "";

    if (!url) {
      if (typeof window.customAlert === "function") {
        window.customAlert("Please enter a valid http:// or https:// website URL.");
      }
      return;
    }

    let finalName = name;
    if (!finalName) {
      try {
        finalName = new URL(url).hostname.replace(/^www\./i, "");
      } catch (_) {
        finalName = "Custom Website";
      }
    }

    if (state.editingId) {
      const idx = state.websites.findIndex(s => s.id === state.editingId);
      if (idx !== -1) {
        state.websites[idx] = {
          ...state.websites[idx],
          name: finalName,
          url,
          liveUrl: url,
          category,
          description,
          lastRedirectedFrom: undefined
        };
      }
    } else {
      state.websites.unshift({
        id: "site-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
        name: finalName,
        url,
        liveUrl: url,
        category,
        description
      });
    }

    saveWebsites();
    closeWebsiteFormModal();
    renderWebsitesGrid();
  }

  function bindEventsOnce() {
    if (state.initialized) return;
    state.initialized = true;

    loadWebsites();
    renderWebsitesGrid();
    updateRendererStatusUI(false);

    const grid = document.getElementById("websites-grid");
    if (grid) {
      grid.addEventListener("click", (e) => {
        const actionBtn = e.target.closest("[data-action]");
        if (actionBtn) {
          e.stopPropagation();
          const action = actionBtn.getAttribute("data-action");
          if (action === "add-new") {
            openWebsiteFormModal(null);
            return;
          }

          const siteId = actionBtn.getAttribute("data-site-id");
          const tile = actionBtn.closest(".site-app-tile");

          if (action === "menu" && tile) {
            const wasOpen = tile.classList.contains("menu-open");
            grid.querySelectorAll(".site-app-tile.menu-open").forEach(t => t.classList.remove("menu-open"));
            if (!wasOpen) tile.classList.add("menu-open");
            return;
          }

          grid.querySelectorAll(".site-app-tile.menu-open").forEach(t => t.classList.remove("menu-open"));
          const site = state.websites.find(s => s.id === siteId);
          if (!site) return;

          if (action === "open") {
            openUrlInSafeBrowser(site.liveUrl || site.url, site);
          } else if (action === "edit") {
            openWebsiteFormModal(site.id);
          } else if (action === "reset") {
            site.liveUrl = site.url;
            delete site.lastRedirectedFrom;
            saveWebsites();
            renderWebsitesGrid();
            if (typeof showGlobalToast === "function") {
              showGlobalToast(`Restored original URL for ${site.name}`, "info");
            }
          } else if (action === "delete") {
            state.websites = state.websites.filter(s => s.id !== siteId);
            saveWebsites();
            renderWebsitesGrid();
          }
          return;
        }

        grid.querySelectorAll(".site-app-tile.menu-open").forEach(t => t.classList.remove("menu-open"));
        const card = e.target.closest("[data-site-open]");
        if (card) {
          const siteId = card.getAttribute("data-site-open");
          const site = state.websites.find(s => s.id === siteId);
          if (site) openUrlInSafeBrowser(site.liveUrl || site.url, site);
        }
      });
    }

    document.addEventListener("click", (e) => {
      if (!e.target.closest(".site-app-tile")) {
        document.querySelectorAll(".site-app-tile.menu-open").forEach(t => t.classList.remove("menu-open"));
      }
    });

    const errRetryBtn = document.getElementById("wb-error-retry-btn");
    const errExtBtn = document.getElementById("wb-error-external-btn");
    const errBackBtn = document.getElementById("wb-error-back-btn");
    if (errRetryBtn) {
      errRetryBtn.addEventListener("click", () => {
        const wv = getMountedWebview();
        const overlay = document.getElementById("wb-error-overlay");
        if (overlay) overlay.style.display = "none";
        if (wv && state.lastAttemptUrl) wv.loadURL(state.lastAttemptUrl);
        else if (wv) wv.reload();
      });
    }
    if (errExtBtn) {
      errExtBtn.addEventListener("click", () => {
        const target = state.lastAttemptUrl || "";
        if (target && /^https?:\/\//i.test(target)) {
          if (window.electronAPI && typeof window.electronAPI.openExternal === "function") {
            window.electronAPI.openExternal(target);
          } else {
            window.open(target, "_blank", "noopener");
          }
        }
      });
    }
    if (errBackBtn) {
      errBackBtn.addEventListener("click", unloadSafeBrowser);
    }

    document.querySelectorAll(".websites-filter-tab").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".websites-filter-tab").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        state.filter = btn.getAttribute("data-site-filter") || "all";
        renderWebsitesGrid();
      });
    });

    const searchInput = document.getElementById("websites-search-input");
    if (searchInput) {
      searchInput.addEventListener("input", () => {
        state.search = searchInput.value;
        renderWebsitesGrid();
      });
    }

    const quickInput = document.getElementById("websites-quick-url-input");
    const quickGo = document.getElementById("websites-quick-go-btn");
    if (quickGo && quickInput) {
      quickGo.addEventListener("click", () => openUrlInSafeBrowser(quickInput.value, null));
      quickInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          openUrlInSafeBrowser(quickInput.value, null);
        }
      });
    }

    const addBtn = document.getElementById("websites-add-btn");
    const syncBtn = document.getElementById("websites-sync-btn");
    if (addBtn) addBtn.addEventListener("click", () => openWebsiteFormModal(null));
    if (syncBtn) syncBtn.addEventListener("click", syncAllWebsiteRedirects);

    // Modal listeners
    const formClose = document.getElementById("website-form-close");
    const formCancel = document.getElementById("website-form-cancel");
    const formSave = document.getElementById("website-form-save");
    const formModal = document.getElementById("website-form-modal");
    if (formClose) formClose.addEventListener("click", closeWebsiteFormModal);
    if (formCancel) formCancel.addEventListener("click", closeWebsiteFormModal);
    if (formSave) formSave.addEventListener("click", saveWebsiteForm);
    if (formModal) {
      formModal.addEventListener("click", (e) => {
        if (e.target === formModal) closeWebsiteFormModal();
      });
    }

    // Browser toolbar controls
    const closeBrowserBtn = document.getElementById("wb-close-browser-btn");
    const backBtn = document.getElementById("wb-back-btn");
    const fwdBtn = document.getElementById("wb-forward-btn");
    const reloadBtn = document.getElementById("wb-reload-btn");
    const urlInput = document.getElementById("wb-url-input");
    const goBtn = document.getElementById("wb-go-btn");
    const batchBtn = document.getElementById("wb-batch-btn");
    const ecoBtn = document.getElementById("wb-eco-btn");
    const shieldBtn = document.getElementById("wb-shield-btn");
    const extBtn = document.getElementById("wb-external-btn");

    if (batchBtn) {
      batchBtn.addEventListener("click", async () => {
        const wv = getMountedWebview();
        if (!wv) return;
        try {
          const clicked = await wv.executeJavaScript(
            "(() => { const b = document.querySelector('.hd-batch-btn'); if (b) { b.click(); return true; } return false; })();"
          );
          if (!clicked && typeof showGlobalToast === "function") {
            showGlobalToast("Open a series / anime watch page with episodes to use Batch & ZIP download.", "info");
          }
        } catch (_) {}
      });
    }

    if (closeBrowserBtn) closeBrowserBtn.addEventListener("click", unloadSafeBrowser);
    if (backBtn) backBtn.addEventListener("click", () => {
      const wv = getMountedWebview();
      if (wv && wv.canGoBack()) wv.goBack();
    });
    if (fwdBtn) fwdBtn.addEventListener("click", () => {
      const wv = getMountedWebview();
      if (wv && wv.canGoForward()) wv.goForward();
    });
    if (reloadBtn) reloadBtn.addEventListener("click", () => {
      const wv = getMountedWebview();
      if (wv) wv.reload();
    });
    if (goBtn && urlInput) {
      const navigateFromBar = () => {
        const target = normalizeHttpUrl(urlInput.value);
        if (!target) return;
        const match = findMatchingSiteForUrl(target, true);
        let siteToOpen = match.site;
        if (siteToOpen && match.matchType === "brand") {
          rememberSiteRedirect(siteToOpen.id, target);
        } else if (!siteToOpen && state.activeSiteId) {
          siteToOpen = state.websites.find(s => s.id === state.activeSiteId) || null;
        }
        openUrlInSafeBrowser(target, siteToOpen);
      };
      goBtn.addEventListener("click", navigateFromBar);
      urlInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          navigateFromBar();
        }
      });
    }
    const pinDomainBtn = document.getElementById("wb-pin-domain-btn");
    if (pinDomainBtn) {
      pinDomainBtn.addEventListener("click", () => {
        const wv = getMountedWebview();
        if (!wv || !state.activeSiteId) return;
        try {
          const curUrl = wv.getURL();
          if (curUrl) {
            rememberSiteRedirect(state.activeSiteId, curUrl, "", true);
          }
        } catch (_) {}
      });
    }
    if (ecoBtn) {
      ecoBtn.addEventListener("click", async () => {
        if (!window.electronAPI || typeof window.electronAPI.setBrowserEco !== "function") return;
        const res = await window.electronAPI.setBrowserEco(!state.ecoMode);
        if (!res) return;
        updateEcoUI(res.ecoMode);
        const wv = getMountedWebview();
        if (wv && typeof wv.executeJavaScript === "function") {
          try {
            await wv.executeJavaScript("window.__hdApplyEcoMode && window.__hdApplyEcoMode(" + Boolean(res.ecoMode) + "); true;");
          } catch (_) {}
        }
        if (typeof showGlobalToast === "function") {
          showGlobalToast(
            res.ecoMode
              ? "Eco Mode ON: saves CPU/GPU while capturing stream & batch download links."
              : "Eco Mode OFF: full video playback enabled (reload player if needed).",
            "info"
          );
        }
      });
    }
    if (shieldBtn) {
      shieldBtn.addEventListener("click", async () => {
        if (!window.electronAPI || typeof window.electronAPI.setBrowserShield !== "function") return;
        const stats = await window.electronAPI.setBrowserShield(!state.shieldEnabled);
        updateShieldUI(stats);
        if (typeof showGlobalToast === "function") {
          showGlobalToast(
            stats.enabled ? "Popup & Ad-Redirect Shield enabled." : "Shield paused (popups still contained in tab).",
            "info"
          );
        }
      });
    }
    if (extBtn) {
      extBtn.addEventListener("click", () => {
        const wv = getMountedWebview();
        const curUrl = wv ? wv.getURL() : (urlInput ? urlInput.value : "");
        if (curUrl && /^https?:\/\//i.test(curUrl)) {
          if (window.electronAPI && typeof window.electronAPI.openExternal === "function") {
            window.electronAPI.openExternal(curUrl);
          } else {
            window.open(curUrl, "_blank", "noopener");
          }
        }
      });
    }

    // Popup blocked prompt actions
    const popupOpenBtn = document.getElementById("wb-popup-open-btn");
    const popupDismissBtn = document.getElementById("wb-popup-dismiss-btn");
    const popupBar = document.getElementById("wb-popup-bar");
    if (popupOpenBtn) {
      popupOpenBtn.addEventListener("click", () => {
        if (popupBar) popupBar.style.display = "none";
        if (state.pendingPopupUrl) {
          const wv = getMountedWebview();
          if (wv) wv.loadURL(state.pendingPopupUrl);
          state.pendingPopupUrl = "";
        }
      });
    }
    if (popupDismissBtn) {
      popupDismissBtn.addEventListener("click", () => {
        if (popupBar) popupBar.style.display = "none";
        state.pendingPopupUrl = "";
      });
    }

    // Sniffed stream actions
    const sniffedDlBtn = document.getElementById("wb-sniffed-download-btn");
    const sniffedCloseBtn = document.getElementById("wb-sniffed-close-btn");
    const sniffedBar = document.getElementById("wb-sniffed-bar");
    if (sniffedDlBtn) {
      sniffedDlBtn.addEventListener("click", () => {
        if (!state.sniffedMediaUrl) return;
        const wv = getMountedWebview();
        queueCapturedDownload({
          url: state.sniffedMediaUrl,
          filename: "",
          cookie: "",
          referer: wv ? wv.getURL() : ""
        });
      });
    }
    if (sniffedCloseBtn) {
      sniffedCloseBtn.addEventListener("click", () => {
        if (sniffedBar) sniffedBar.style.display = "none";
        state.sniffedMediaUrl = "";
      });
    }

    // Main-process browser shield & download capture IPC events
    if (window.electronAPI) {
      if (typeof window.electronAPI.onBrowserShieldStats === "function") {
        window.electronAPI.onBrowserShieldStats(updateShieldUI);
      }
      if (typeof window.electronAPI.onBrowserDownloadCaptured === "function") {
        window.electronAPI.onBrowserDownloadCaptured((data) => {
          if (data && data.url) queueCapturedDownload(data);
        });
      }
      if (typeof window.electronAPI.onBrowserPopupBlocked === "function") {
        window.electronAPI.onBrowserPopupBlocked((data) => {
          if (!data || !data.url || !state.webviewMounted) return;
          state.pendingPopupUrl = data.url;
          const bar = document.getElementById("wb-popup-bar");
          const txt = document.getElementById("wb-popup-text");
          let host = data.url;
          try { host = new URL(data.url).hostname; } catch (_) {}
          if (txt) txt.textContent = `Blocked popup tab to ${host}`;
          if (bar) bar.style.display = "flex";
        });
      }
      if (typeof window.electronAPI.onBrowserMediaSniffed === "function") {
        window.electronAPI.onBrowserMediaSniffed((data) => {
          if (!data || !data.url || !state.webviewMounted) return;
          state.sniffedMediaUrl = data.url;
          const bar = document.getElementById("wb-sniffed-bar");
          const urlEl = document.getElementById("wb-sniffed-url");
          if (urlEl) urlEl.textContent = data.url;
          if (bar) bar.style.display = "flex";
        });
      }
    }
  }

  window.initWebsitesTab = function() {
    bindEventsOnce();
    renderWebsitesGrid();
  };
})();
