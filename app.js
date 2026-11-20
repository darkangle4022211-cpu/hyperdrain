const REPO = "darkangle4022211-cpu/hyperdrain";
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases?per_page=30`;
const REVIEWS_API = `https://api.github.com/repos/${REPO}/issues?labels=review&state=all&per_page=20`;
const CACHE_KEY = "hyperdrain_releases_cache_v2";
const CACHE_TTL_MS = 5 * 60 * 1000;

const SCREEN_CAPTIONS = [
  "Active Downloads console with 60-second throughput and disk telemetry.",
  "Universal Browser Extension Hub connecting Chrome, Brave, Edge, and Firefox.",
  "Search and Discover catalog with category, genre, year, and rating filters.",
  "Built-in Websites browser view with stream detection and custom shortcuts."
];

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return "";
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function classifyAsset(name) {
  const lower = name.toLowerCase();
  if (lower.endsWith(".appimage")) return { priority: 1, label: "AppImage" };
  if (lower.endsWith(".deb")) return { priority: 2, label: ".deb" };
  if (lower.endsWith(".exe")) return { priority: 3, label: ".exe" };
  if (lower.endsWith(".snap")) return { priority: 4, label: ".snap" };
  if (lower.endsWith(".zip")) return { priority: 5, label: ".zip" };
  return { priority: 99, label: name };
}

function getInstallableAssets(release) {
  return (release.assets || [])
    .filter((a) => !a.name.endsWith(".json") && !a.name.endsWith(".yml"))
    .sort((a, b) => classifyAsset(a.name).priority - classifyAsset(b.name).priority);
}

function parseChangelog(body) {
  if (!body) return ["Production release published on GitHub Releases."];
  const lines = body
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*•]\s*/, "").replace(/\*\*/g, "").trim())
    .filter((line) => line && !line.startsWith("#") && !line.startsWith("If you're facing") && !line.startsWith("Email:"))
    .map((line) => {
      const colonIdx = line.indexOf(":");
      return colonIdx > 8 && colonIdx < 60 ? line.slice(0, colonIdx) : line.slice(0, 88);
    });
  return lines.length ? lines.slice(0, 4) : ["Production release published on GitHub Releases."];
}

let allReleasesCache = [];
let showAllReleases = false;

function renderReleaseTableRows() {
  const tbody = document.getElementById("releases-table-body");
  const toggleBtn = document.getElementById("toggle-all-releases-btn");
  if (!tbody || !allReleasesCache.length) return;

  const visible = showAllReleases ? allReleasesCache : allReleasesCache.slice(0, 5);
  tbody.innerHTML = visible
    .map((rel) => {
      const relAssets = getInstallableAssets(rel);
      const packagesHtml = relAssets.length
        ? relAssets
            .map((a) => `<a href="${escapeHtml(a.browser_download_url)}" download="${escapeHtml(a.name)}">${escapeHtml(a.name)}</a> <span class="measured muted">(${escapeHtml(formatBytes(a.size))})</span>`)
            .join(", ")
        : `<span class="muted">Source archive</span>`;
      return `
        <tr>
          <td class="measured">${escapeHtml(rel.tag_name)}</td>
          <td class="measured">${escapeHtml(formatDate(rel.published_at))}</td>
          <td>${packagesHtml}</td>
          <td><a href="${escapeHtml(rel.html_url)}" target="_blank" rel="noopener noreferrer">Release</a></td>
        </tr>
      `;
    })
    .join("");

  if (toggleBtn) {
    if (allReleasesCache.length <= 5) {
      toggleBtn.hidden = true;
    } else {
      toggleBtn.hidden = false;
      toggleBtn.textContent = showAllReleases
        ? "Show fewer releases"
        : `Show all ${allReleasesCache.length} releases`;
    }
  }
}

function renderReleases(releases, statusLabel) {
  if (!Array.isArray(releases) || !releases.length) return;
  allReleasesCache = releases;
  const latest = releases[0];
  const tag = latest.tag_name || "v1.0.9";
  const dateStr = formatDate(latest.published_at);
  const assets = getInstallableAssets(latest);

  const headerPill = document.getElementById("header-version-pill");
  const allReleasesBtn = document.getElementById("hero-all-releases-btn");
  const heroBtn = document.getElementById("primary-download-btn");
  const closeBtn = document.getElementById("close-download-btn");
  const heroAssetMeta = document.getElementById("hero-asset-meta");
  const latestTagDisplay = document.getElementById("latest-tag-display");
  const latestDateDisplay = document.getElementById("latest-date-display");
  const latestAssetsEl = document.getElementById("latest-assets");
  const latestChangelogEl = document.getElementById("latest-changelog");
  const installCmd = document.getElementById("install-cmd");
  const terminalLabel = document.getElementById("terminal-label");
  const reviewEnv = document.getElementById("review-env");

  if (headerPill) headerPill.textContent = tag;
  if (allReleasesBtn) allReleasesBtn.textContent = `All releases (${releases.length})`;
  if (latestTagDisplay) latestTagDisplay.textContent = tag;
  if (latestDateDisplay) latestDateDisplay.textContent = dateStr;
  if (reviewEnv && /^v\d+\.\d+\.\d+ on Ubuntu x64$/.test(reviewEnv.value)) {
    reviewEnv.value = `${tag} on Ubuntu x64`;
  }

  if (assets.length) {
    const primary = assets[0];
    const primaryInfo = classifyAsset(primary.name);
    const sizeText = formatBytes(primary.size);

    [heroBtn, closeBtn].forEach((btn) => {
      if (!btn) return;
      btn.href = primary.browser_download_url;
      btn.setAttribute("download", primary.name);
      btn.innerHTML = `Download <span class="measured">${escapeHtml(tag)} (${escapeHtml(primaryInfo.label)})</span>`;
    });

    if (heroAssetMeta) {
      heroAssetMeta.textContent = sizeText ? `${primary.name} (${sizeText})` : primary.name;
    }

    if (latestAssetsEl) {
      latestAssetsEl.innerHTML = assets
        .map((a) => `
          <a class="chip chip--cool" href="${escapeHtml(a.browser_download_url)}" download="${escapeHtml(a.name)}">
            ${escapeHtml(a.name)} <span class="measured">(${escapeHtml(formatBytes(a.size))})</span>
          </a>
        `)
        .join("");
    }

    if (installCmd && terminalLabel) {
      if (primary.name.toLowerCase().endsWith(".appimage")) {
        terminalLabel.textContent = "Run latest AppImage";
        installCmd.textContent = `curl -fsSL ${primary.browser_download_url} -o ~/HyperDrain.AppImage && chmod +x ~/HyperDrain.AppImage && ~/HyperDrain.AppImage`;
      } else if (primary.name.toLowerCase().endsWith(".deb")) {
        terminalLabel.textContent = "Install latest package";
        installCmd.textContent = `curl -fsSL ${primary.browser_download_url} -o /tmp/hyperdrain.deb && sudo apt install -y /tmp/hyperdrain.deb`;
      }
    }
  }

  if (latestChangelogEl) {
    const items = parseChangelog(latest.body);
    latestChangelogEl.innerHTML = items.map((line) => `<li>${escapeHtml(line)}</li>`).join("");
  }

  renderReleaseTableRows();

  const syncEl = document.getElementById("releases-sync-status");
  if (syncEl) syncEl.textContent = `${tag} ${statusLabel} (${releases.length})`;
}

async function loadReleases(force = false) {
  const syncEl = document.getElementById("releases-sync-status");
  if (!force) {
    try {
      const raw = sessionStorage.getItem(CACHE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Date.now() - parsed.ts < CACHE_TTL_MS && Array.isArray(parsed.data)) {
          renderReleases(parsed.data, "synced");
          return;
        }
      }
    } catch {
      // Ignore storage errors
    }
  }

  if (syncEl) syncEl.textContent = "Checking GitHub";
  try {
    const res = await fetch(RELEASES_API, { headers: { Accept: "application/vnd.github+json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const published = Array.isArray(data) ? data.filter((r) => !r.draft) : [];
    if (published.length) {
      try {
        sessionStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), data: published }));
      } catch {
        // Ignore storage quota
      }
      renderReleases(published, "live");
    }
  } catch {
    if (syncEl) syncEl.textContent = "v1.0.9 cached";
  }
}

// 4-Screen Pinned Walkthrough + Tab Switcher
const stepItems = Array.from(document.querySelectorAll(".moment-item"));
const stepButtons = Array.from(document.querySelectorAll(".moment-step"));
const stageImages = Array.from(document.querySelectorAll(".stage-img"));
const stageCaption = document.getElementById("stage-caption");
let activeScreen = 0;

function selectScreen(index) {
  if (index === activeScreen || index < 0 || index >= stepButtons.length) return;
  activeScreen = index;
  stepItems.forEach((item, i) => item.classList.toggle("is-active", i === index));
  stepButtons.forEach((btn, i) => {
    btn.setAttribute("aria-selected", i === index ? "true" : "false");
  });
  stageImages.forEach((img, i) => {
    img.classList.toggle("is-visible", i === index);
  });
  if (stageCaption && SCREEN_CAPTIONS[index]) {
    stageCaption.textContent = SCREEN_CAPTIONS[index];
  }
}

stepItems.forEach((item, index) => {
  item.addEventListener("click", () => selectScreen(index));
});

const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
if (!prefersReduced && "IntersectionObserver" in window) {
  const observer = new IntersectionObserver(
    (entries) => {
      if (window.innerWidth <= 960) return;
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          const idx = Number(entry.target.getAttribute("data-screen-index"));
          if (!Number.isNaN(idx)) selectScreen(idx);
        }
      });
    },
    { rootMargin: "-35% 0px -45% 0px", threshold: 0.1 }
  );
  stepButtons.forEach((btn) => observer.observe(btn));
}

// Reviews
function parseRating(body) {
  const m = String(body || "").match(/Rating:\s*([1-5])\s*\/\s*5/i);
  const val = m ? Number(m[1]) : 5;
  return `${val} / 5`;
}

function cleanReviewBody(body) {
  return String(body || "")
    .replace(/^\*\*Rating:\*\*.*$/gim, "")
    .replace(/^\*\*Version \/ OS:\*\*.*$/gim, "")
    .replace(/^Rating:.*$/gim, "")
    .replace(/^Version \/ OS:.*$/gim, "")
    .trim();
}

async function loadReviews() {
  const listEl = document.getElementById("reviews-list");
  const statusEl = document.getElementById("reviews-status");
  if (!listEl || !statusEl) return;

  try {
    const res = await fetch(REVIEWS_API, { headers: { Accept: "application/vnd.github+json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const issues = await res.json();
    const reviews = Array.isArray(issues) ? issues.filter((i) => !i.pull_request) : [];
    statusEl.textContent = `${reviews.length} published`;

    if (!reviews.length) {
      listEl.innerHTML = `<div class="review-empty"><p>No reviews posted yet. Try HyperDrain on your machine and leave the first review on the left.</p></div>`;
      return;
    }

    listEl.innerHTML = reviews
      .map((item) => {
        const user = item.user || {};
        const bodyText = cleanReviewBody(item.body) || "No comment text provided.";
        return `
          <article class="review-item">
            <div class="review-meta">
              <span class="review-author">
                ${user.avatar_url ? `<img src="${escapeHtml(user.avatar_url)}" alt="" width="22" height="22">` : ""}
                <span>@${escapeHtml(user.login || "user")}</span>
              </span>
              <span class="measured review-rating">${escapeHtml(parseRating(item.body))}</span>
            </div>
            <h4>${escapeHtml(item.title)}</h4>
            <p>${escapeHtml(bodyText)}</p>
            <div class="review-foot">
              <span class="measured">${escapeHtml(formatDate(item.created_at))}</span>
              <a href="${escapeHtml(item.html_url)}" target="_blank" rel="noopener noreferrer">Reply (${item.comments || 0})</a>
            </div>
          </article>
        `;
      })
      .join("");
  } catch {
    statusEl.textContent = "GitHub threads";
    listEl.innerHTML = `<div class="review-empty"><p>View and post reviews directly on <a href="https://github.com/${REPO}/issues?q=label%3Areview" target="_blank" rel="noopener noreferrer">GitHub Issues</a>.</p></div>`;
  }
}

document.querySelectorAll("[data-copy-target]").forEach((button) => {
  button.addEventListener("click", async () => {
    const id = button.getAttribute("data-copy-target");
    const target = id ? document.getElementById(id) : null;
    const status = document.getElementById("live-status");
    const text = target && target.textContent ? target.textContent.trim() : "";
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      const prev = button.textContent;
      button.textContent = "Copied";
      if (status) status.textContent = "Install command copied.";
      window.setTimeout(() => { button.textContent = prev; }, 1600);
    } catch {
      if (status) status.textContent = "Copy failed.";
    }
  });
});

const refreshBtn = document.getElementById("refresh-releases-btn");
if (refreshBtn) refreshBtn.addEventListener("click", () => loadReleases(true));

const toggleReleasesBtn = document.getElementById("toggle-all-releases-btn");
if (toggleReleasesBtn) {
  toggleReleasesBtn.addEventListener("click", () => {
    showAllReleases = !showAllReleases;
    renderReleaseTableRows();
  });
}

const reviewForm = document.getElementById("review-form");
if (reviewForm) {
  reviewForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const rating = document.getElementById("review-rating").value;
    const env = document.getElementById("review-env").value.trim();
    const title = document.getElementById("review-title").value.trim();
    const body = document.getElementById("review-body").value.trim();

    const formatted = [
      `**Rating:** ${rating}/5`,
      `**Version / OS:** ${env || "Linux"}`,
      "",
      body
    ].join("\n");

    const params = new URLSearchParams({
      labels: "review",
      title: `[${rating}/5] ${title}`,
      body: formatted
    });

    window.open(`https://github.com/${REPO}/issues/new?${params.toString()}`, "_blank", "noopener,noreferrer");
  });
}

loadReleases(false);
loadReviews();
