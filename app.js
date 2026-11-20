const REPO = "darkangle4022211-cpu/hyperdrain";
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases?per_page=30`;
const REVIEWS_API = `https://api.github.com/repos/${REPO}/issues?labels=review&state=all&per_page=20`;
const CACHE_KEY = "hyperdrain_releases_cache_v1";
const CACHE_TTL_MS = 5 * 60 * 1000;

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

function classifyAsset(name) {
  const lower = name.toLowerCase();
  if (lower.endsWith(".appimage")) return { priority: 1, label: "AppImage", kind: "Portable Linux AppImage" };
  if (lower.endsWith(".deb")) return { priority: 2, label: ".deb", kind: "Ubuntu / Debian x64" };
  if (lower.endsWith(".exe")) return { priority: 3, label: ".exe", kind: "Windows x64" };
  if (lower.endsWith(".snap")) return { priority: 4, label: ".snap", kind: "Snap Package" };
  if (lower.endsWith(".zip")) return { priority: 5, label: ".zip", kind: "Portable Archive" };
  return { priority: 99, label: name, kind: "Release Asset" };
}

function getInstallableAssets(release) {
  return (release.assets || [])
    .filter((a) => !a.name.endsWith(".json") && !a.name.endsWith(".yml"))
    .sort((a, b) => classifyAsset(a.name).priority - classifyAsset(b.name).priority);
}

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatInlineMarkdown(text) {
  let safe = escapeHtml(text);
  safe = safe.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  safe = safe.replace(/`([^`]+)`/g, "<code>$1</code>");
  return safe;
}

function parseChangelog(body) {
  if (!body) return ["Production release published on GitHub Releases."];
  const lines = body
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*•]\s*/, "").trim())
    .filter((line) => line && !line.startsWith("#") && !line.startsWith("If you're facing") && !line.startsWith("Email:"));
  return lines.length ? lines.slice(0, 6) : ["Production release published on GitHub Releases."];
}

function renderReleases(releases, sourceLabel) {
  if (!Array.isArray(releases) || !releases.length) return;
  const latest = releases[0];
  const tag = latest.tag_name || "v1.0.9";
  const dateStr = formatDate(latest.published_at);
  const assets = getInstallableAssets(latest);

  const headerPill = document.getElementById("header-version-pill");
  const heroMeta = document.getElementById("hero-release-meta");
  const countBadge = document.getElementById("release-count-badge");
  const heroActions = document.getElementById("hero-download-actions");
  const installCmd = document.getElementById("install-cmd");
  const terminalLabel = document.getElementById("terminal-label");
  const reviewEnv = document.getElementById("review-env");

  if (headerPill) headerPill.textContent = tag;
  if (heroMeta) heroMeta.textContent = dateStr ? `${tag} · Updated ${dateStr}` : tag;
  if (countBadge) countBadge.textContent = String(releases.length);
  if (reviewEnv && reviewEnv.value.startsWith("v1.0.9")) {
    reviewEnv.value = `${tag} · Ubuntu / Linux x64`;
  }

  if (heroActions && assets.length) {
    const primary = assets[0];
    const primaryInfo = classifyAsset(primary.name);
    const secondaryAssets = assets.slice(1, 2);

    let html = `
      <a class="btn-primary" id="primary-download-btn" href="${escapeHtml(primary.browser_download_url)}" download="${escapeHtml(primary.name)}">
        <span class="btn-title">Download ${escapeHtml(tag)} (${escapeHtml(primaryInfo.label)})</span>
        <span class="btn-sub">${escapeHtml(formatBytes(primary.size))} · ${escapeHtml(primaryInfo.kind)} · Direct CDN</span>
      </a>
    `;

    secondaryAssets.forEach((asset) => {
      const info = classifyAsset(asset.name);
      html += `
        <a class="btn-secondary" href="${escapeHtml(asset.browser_download_url)}" download="${escapeHtml(asset.name)}">
          ${escapeHtml(info.label)} (${escapeHtml(formatBytes(asset.size))})
        </a>
      `;
    });

    html += `<a class="btn-secondary" href="#releases">All releases (<span>${releases.length}</span>)</a>`;
    heroActions.innerHTML = html;

    if (installCmd && terminalLabel) {
      if (primary.name.toLowerCase().endsWith(".appimage")) {
        terminalLabel.textContent = "Quick run AppImage in terminal";
        installCmd.textContent = `curl -fsSL ${primary.browser_download_url} -o ~/HyperDrain.AppImage && chmod +x ~/HyperDrain.AppImage && ~/HyperDrain.AppImage`;
      } else if (primary.name.toLowerCase().endsWith(".deb")) {
        terminalLabel.textContent = "Quick install on Ubuntu / Debian";
        installCmd.textContent = `curl -fsSL ${primary.browser_download_url} -o /tmp/hyperdrain.deb && sudo apt install -y /tmp/hyperdrain.deb`;
      }
    }
  }

  const latestTagEl = document.getElementById("latest-tag");
  const latestDateEl = document.getElementById("latest-date");
  const latestGhLink = document.getElementById("latest-gh-link");
  const latestAssetsEl = document.getElementById("latest-assets");
  const latestChangelogEl = document.getElementById("latest-changelog");

  if (latestTagEl) latestTagEl.textContent = tag;
  if (latestDateEl) latestDateEl.textContent = dateStr;
  if (latestGhLink && latest.html_url) latestGhLink.href = latest.html_url;

  if (latestAssetsEl && assets.length) {
    latestAssetsEl.innerHTML = assets
      .map((a, idx) => `
        <a class="asset-chip ${idx === 0 ? "asset-chip-primary" : ""}" href="${escapeHtml(a.browser_download_url)}" download="${escapeHtml(a.name)}">
          <span>${escapeHtml(a.name)}</span>
          <span class="asset-size">${escapeHtml(formatBytes(a.size))}</span>
        </a>
      `)
      .join("");
  }

  if (latestChangelogEl) {
    const notes = parseChangelog(latest.body);
    latestChangelogEl.innerHTML = notes.map((item) => `<li>${formatInlineMarkdown(item)}</li>`).join("");
  }

  const tbody = document.getElementById("releases-table-body");
  if (tbody) {
    tbody.innerHTML = releases
      .map((rel) => {
        const relAssets = getInstallableAssets(rel);
        const assetLinks = relAssets.length
          ? relAssets
              .map((a) => `<a href="${escapeHtml(a.browser_download_url)}" download="${escapeHtml(a.name)}">${escapeHtml(a.name)}</a> <span class="muted-size">(${escapeHtml(formatBytes(a.size))})</span>`)
              .join('<span class="table-asset-sep">·</span>')
          : '<span class="muted-size">Source only</span>';
        return `
          <tr>
            <td><code>${escapeHtml(rel.tag_name)}</code></td>
            <td>${escapeHtml(formatDate(rel.published_at))}</td>
            <td>${assetLinks}</td>
            <td><a href="${escapeHtml(rel.html_url)}" target="_blank" rel="noopener noreferrer">Release page</a></td>
          </tr>
        `;
      })
      .join("");
  }

  const syncStatus = document.getElementById("releases-sync-status");
  if (syncStatus) syncStatus.textContent = `${sourceLabel} · ${releases.length} releases`;
}

async function loadReleases(forceRefresh = false) {
  const syncStatus = document.getElementById("releases-sync-status");
  if (!forceRefresh) {
    try {
      const cachedRaw = sessionStorage.getItem(CACHE_KEY);
      if (cachedRaw) {
        const cached = JSON.parse(cachedRaw);
        if (Date.now() - cached.ts < CACHE_TTL_MS && Array.isArray(cached.data)) {
          renderReleases(cached.data, "Synced from GitHub");
          return;
        }
      }
    } catch {
      // Ignore storage errors
    }
  }

  if (syncStatus) syncStatus.textContent = "Checking GitHub Releases…";
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
      renderReleases(published, "Live from GitHub");
    }
  } catch {
    if (syncStatus) syncStatus.textContent = "Showing fallback v1.0.9 (GitHub API unavailable)";
  }
}

function parseRatingFromBody(body) {
  const match = String(body || "").match(/Rating:\s*([1-5])\s*\/\s*5/i);
  const count = match ? Number(match[1]) : 5;
  return "★".repeat(count) + "☆".repeat(5 - count);
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
      listEl.innerHTML = `
        <div class="review-empty">
          <p>No reviews posted yet. Download HyperDrain, try it out, and submit the first review using the form on the left.</p>
        </div>
      `;
      return;
    }

    listEl.innerHTML = reviews
      .map((item) => {
        const user = item.user || {};
        const stars = parseRatingFromBody(item.body);
        const bodyText = cleanReviewBody(item.body) || "(No written comment provided)";
        return `
          <article class="review-card">
            <div class="review-card-top">
              <span class="review-author">
                ${user.avatar_url ? `<img src="${escapeHtml(user.avatar_url)}" alt="" width="22" height="22">` : ""}
                <span>@${escapeHtml(user.login || "user")}</span>
              </span>
              <span class="review-stars" aria-label="Star rating">${stars}</span>
            </div>
            <h4>${escapeHtml(item.title)}</h4>
            <p>${escapeHtml(bodyText)}</p>
            <div class="review-card-foot">
              <span>${escapeHtml(formatDate(item.created_at))} · ${item.comments || 0} replies</span>
              <a href="${escapeHtml(item.html_url)}" target="_blank" rel="noopener noreferrer">Comment / Reply &rarr;</a>
            </div>
          </article>
        `;
      })
      .join("");
  } catch {
    statusEl.textContent = "GitHub thread view";
    listEl.innerHTML = `
      <div class="review-empty">
        <p>Live reviews could not be fetched right now. <a href="https://github.com/${REPO}/issues?q=label%3Areview" target="_blank" rel="noopener noreferrer">View &amp; post reviews directly on GitHub &rarr;</a></p>
      </div>
    `;
  }
}

// Copy command buttons
document.querySelectorAll("[data-copy-target]").forEach((button) => {
  button.addEventListener("click", async () => {
    const targetId = button.getAttribute("data-copy-target");
    const target = targetId ? document.getElementById(targetId) : null;
    const status = document.getElementById("live-status");
    const text = target && target.textContent ? target.textContent.trim() : "";
    if (!text) return;

    try {
      await navigator.clipboard.writeText(text);
      const original = button.textContent;
      button.textContent = "Copied";
      if (status) status.textContent = "Install command copied to clipboard.";
      window.setTimeout(() => {
        button.textContent = original;
      }, 1600);
    } catch {
      if (status) status.textContent = "Copy failed. Please copy the command manually.";
    }
  });
});

// Refresh releases button
const refreshBtn = document.getElementById("refresh-releases-btn");
if (refreshBtn) {
  refreshBtn.addEventListener("click", () => {
    loadReleases(true);
  });
}

// Review form -> pre-filled GitHub Issue with label=review
const reviewForm = document.getElementById("review-form");
if (reviewForm) {
  reviewForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const rating = document.getElementById("review-rating").value;
    const env = document.getElementById("review-env").value.trim();
    const title = document.getElementById("review-title").value.trim();
    const body = document.getElementById("review-body").value.trim();

    const formattedBody = [
      `**Rating:** ${rating}/5`,
      `**Version / OS:** ${env || "Linux"}`,
      "",
      body
    ].join("\n");

    const params = new URLSearchParams({
      labels: "review",
      title: `[Review ${rating}★] ${title}`,
      body: formattedBody
    });

    window.open(`https://github.com/${REPO}/issues/new?${params.toString()}`, "_blank", "noopener,noreferrer");
  });
}

loadReleases(false);
loadReviews();
