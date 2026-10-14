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
    settings: "Engine Configuration"
  };
  viewTitle.textContent = titles[tab] || "Dashboard";

  if (tab === "active") {
    chartWasZero = false;
    drawChart();
  } else if (tab === "completed") {
    fetch(`${API_BASE}/api/tasks`, { headers: { "X-HyperDrain-Token": AUTH_TOKEN } })
      .then(r => r.json())
      .then(tasks => { if (tasks) renderTasks(tasks); })
      .catch(() => {});
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
  netGrad.addColorStop(0, "rgba(59, 130, 246, 0.2)");
  netGrad.addColorStop(1, "rgba(59, 130, 246, 0.0)");
  ctx.fillStyle = netGrad;
  ctx.fill();

  // Network line stroke
  ctx.beginPath();
  for (let i = 0; i < chartHistory.length; i++) {
    const x = (i / (chartHistory.length - 1)) * w;
    const y = h - (chartHistory[i] / maxVal) * (h - 10);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = "#3b82f6";
  ctx.lineWidth = 1.75;
  ctx.shadowColor = "rgba(59, 130, 246, 0.25)";
  ctx.shadowBlur = 4;
  ctx.stroke();
  ctx.shadowBlur = 0;

  // Disk write speed stroke
  ctx.beginPath();
  for (let i = 0; i < diskChartHistory.length; i++) {
    const x = (i / (diskChartHistory.length - 1)) * w;
    const y = h - (diskChartHistory[i] / maxVal) * (h - 10);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = "#10b981";
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
    if (task.error_message && (task.error_message.includes("expired") || task.error_message.includes("refresh"))) {
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

window.deleteTask = async (id) => {
  if (confirm("Remove this download card from the list? (Completed files on your drive will NOT be deleted)")) {
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
    if (confirm("Clear completed downloads from history? (Your downloaded files on disk will stay safe and untouched)")) {
      await fetch(`${API_BASE}/api/tasks/clear-completed`, {
        method: "POST",
        headers: { "X-HyperDrain-Token": AUTH_TOKEN }
      });
      pollTasksFallback();
    }
  });
}

window.openFolder = async (id) => {
  await fetch(`${API_BASE}/api/tasks/${id}/open`, {
    method: "POST",
    headers: { "X-HyperDrain-Token": AUTH_TOKEN }
  });
};

window.extractTask = async (id) => {
  await fetch(`${API_BASE}/api/tasks/${id}/extract`, {
    method: "POST",
    headers: { "X-HyperDrain-Token": AUTH_TOKEN }
  });
  alert("Archive extraction started in background.");
};

// Modal controls
const addModal = document.getElementById("add-modal");
const openAddBtn = document.getElementById("open-add-modal");
const closeAddBtn = document.getElementById("close-modal-btn");
const cancelAddBtn = document.getElementById("cancel-modal-btn");
const startDownloadBtn = document.getElementById("start-download-btn");

openAddBtn.addEventListener("click", () => addModal.classList.add("show"));
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
    alert("Please enter a valid URL or magnet link.");
    return;
  }

  try {
    startDownloadBtn.disabled = true;
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
    } else {
      alert("Failed to start download. Error code: " + res.status);
    }
  } catch (err) {
    alert("Could not reach HyperDrain engine: " + err.message);
  } finally {
    startDownloadBtn.disabled = false;
  }
});

// Settings Save
const saveSettingsBtn = document.getElementById("save-settings-btn");
if (saveSettingsBtn) {
  saveSettingsBtn.addEventListener("click", async () => {
    const dir = document.getElementById("cfg-dir").value.trim();
    const conns = parseInt(document.getElementById("cfg-conns").value, 10);
    const maxActive = parseInt(document.getElementById("cfg-queue-max").value, 10);
    const token = document.getElementById("cfg-token").value.trim();

    await fetch(`${API_BASE}/api/settings`, {
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
        auth_token: token
      })
    });
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
        alert("HyperDrain Browser Extension successfully exported to:\n" + res.path);
      }
    } else {
      alert("Extension files are ready in the extension/ directory.");
    }
  });
}

if (extOpenFolderBtn) {
  extOpenFolderBtn.addEventListener("click", async () => {
    if (window.electronAPI && window.electronAPI.openExtensionFolder) {
      await window.electronAPI.openExtensionFolder();
    } else {
      alert("Extension folder is located in the extension/ directory.");
    }
  });
}

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
  const latestVer = 'v' + String(res.latestVersion || '1.0.3').replace(/^v/, '');
  const currentVer = 'v' + String(res.currentVersion || '1.0.3').replace(/^v/, '');

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
          manualUpdateResult.textContent = "HyperDrain is up to date (v1.0.3). No updates available.";
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



