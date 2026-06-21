const api = window.clipSync;

let currentClips = [];
let currentDevice = null;
let allDevices = [];
let selectedClip = null;
let searchTimeout = null;

async function init() {
  currentDevice = await api.getDeviceInfo();

  const config = await api.getConfig();
  document.getElementById("setting-http-url").value = config.httpUrl;
  document.getElementById("setting-ws-url").value = config.serverUrl;

  setupTabs();
  setupSearch();
  setupModals();
  setupSettings();
  setupRealtime();

  await loadClips();
  await loadDevices();
  await loadTags();
}

function setupTabs() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
      tab.classList.add("active");
      document.getElementById("tab-" + tab.dataset.tab).classList.add("active");

      if (tab.dataset.tab === "devices") loadDevices();
      if (tab.dataset.tab === "tags") loadTags();
    });
  });
}

function setupSearch() {
  const input = document.getElementById("search-input");
  const typeFilter = document.getElementById("filter-type");

  input.addEventListener("input", () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => loadClips(), 300);
  });

  typeFilter.addEventListener("change", () => loadClips());
}

function setupModals() {
  document.querySelectorAll(".modal-close").forEach((btn) => {
    btn.addEventListener("click", () => {
      btn.closest(".modal").style.display = "none";
    });
  });

  document.querySelectorAll(".modal").forEach((modal) => {
    modal.addEventListener("click", (e) => {
      if (e.target === modal) modal.style.display = "none";
    });
  });

  document.getElementById("btn-copy-clip").addEventListener("click", async () => {
    if (!selectedClip) return;
    await api.copyToClipboard(selectedClip);
    showNotification("Copied to clipboard!");
    document.getElementById("clip-detail-modal").style.display = "none";
  });

  document.getElementById("btn-push-clip").addEventListener("click", async () => {
    if (!selectedClip) return;
    const devices = await api.apiRequest("GET", "/api/devices");
    const list = document.getElementById("push-device-list");
    list.innerHTML = "";

    const otherDevices = devices.filter((d) => d.id !== currentDevice.id);
    if (!otherDevices.length) {
      list.innerHTML = '<p style="color:var(--text-muted);text-align:center;">No other devices online</p>';
    } else {
      otherDevices.forEach((d) => {
        const item = document.createElement("div");
        item.className = "push-device-item";
        const icon = d.platform === "darwin" ? "🍎" : d.platform === "linux" ? "🐧" : "🪟";
        item.innerHTML = `<span style="font-size:20px;">${icon}</span><span>${d.name}</span>`;
        item.addEventListener("click", async () => {
          await api.pushToDevice(d.id, selectedClip);
          showNotification(`Pushed to ${d.name}!`);
          document.getElementById("push-modal").style.display = "none";
        });
        list.appendChild(item);
      });
    }

    document.getElementById("push-modal").style.display = "flex";
  });

  document.getElementById("btn-delete-clip").addEventListener("click", async () => {
    if (!selectedClip) return;
    await api.apiRequest("DELETE", `/api/clips/${selectedClip.id}`);
    showNotification("Clip deleted");
    document.getElementById("clip-detail-modal").style.display = "none";
    await loadClips();
  });
}

function setupSettings() {
  document.getElementById("btn-settings").addEventListener("click", () => {
    document.getElementById("settings-modal").style.display = "flex";
  });

  document.getElementById("btn-save-settings").addEventListener("click", async () => {
    const httpUrl = document.getElementById("setting-http-url").value.trim();
    const wsUrl = document.getElementById("setting-ws-url").value.trim();
    await api.saveConfig({ httpUrl, serverUrl: wsUrl });
    showNotification("Settings saved, reconnecting...");
    document.getElementById("settings-modal").style.display = "none";
  });
}

function setupRealtime() {
  api.onClipboardChanged((clip) => {
    currentClips.unshift(clip);
    renderClips();
  });

  api.onClipCreatedRemote((clip) => {
    currentClips.unshift(clip);
    renderClips();
  });

  api.onClipReceived((clip) => {
    showNotification(`Received clip from another device!`);
    loadClips();
  });

  api.onWsStatus((status) => {
    const indicator = document.getElementById("ws-indicator");
    indicator.className = "status-dot " + status;
    indicator.title = status.charAt(0).toUpperCase() + status.slice(1);
  });
}

async function loadClips() {
  const query = document.getElementById("search-input").value.trim();
  const type = document.getElementById("filter-type").value;

  try {
    let clips;
    if (query) {
      clips = await api.apiRequest(
        "GET",
        `/api/clips/search?q=${encodeURIComponent(query)}${type ? "&type=" + type : ""}`
      );
    } else {
      clips = await api.apiRequest(
        "GET",
        `/api/clips?limit=200${type ? "&type=" + type : ""}`
      );
    }
    currentClips = clips;
    renderClips();
  } catch {
    currentClips = [];
    renderClips();
  }
}

function renderClips() {
  const list = document.getElementById("clips-list");
  const empty = document.getElementById("clips-empty");

  if (!currentClips.length) {
    list.innerHTML = "";
    empty.style.display = "block";
    return;
  }

  empty.style.display = "none";
  list.innerHTML = currentClips.map((clip) => renderClipItem(clip)).join("");

  list.querySelectorAll(".clip-item").forEach((el) => {
    el.addEventListener("click", () => openClipDetail(el.dataset.clipId));
  });

  list.querySelectorAll(".btn-quick-copy").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const clip = currentClips.find((c) => c.id === btn.dataset.clipId);
      if (clip) {
        await api.copyToClipboard(clip);
        showNotification("Copied!");
      }
    });
  });

  list.querySelectorAll(".btn-tag-clip").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      selectedClip = currentClips.find((c) => c.id === btn.dataset.clipId);
      openTagModal();
    });
  });
}

function renderClipItem(clip) {
  const icons = { text: "📝", image: "🖼", file: "📎" };
  const icon = icons[clip.type] || "📋";
  const preview =
    clip.type === "text"
      ? escapeHtml(clip.content || "")
      : clip.type === "image"
      ? `<img src="${getConfig().httpUrl}${clip.file_path}" style="max-height:36px;border-radius:4px;" />`
      : escapeHtml(clip.content || clip.file_path || "File");

  const time = formatTime(clip.created_at);
  const typeLabel = clip.type.charAt(0).toUpperCase() + clip.type.slice(1);

  let tagsHtml = "";
  if (clip._tags && clip._tags.length) {
    tagsHtml = `<div class="clip-tags">${clip._tags
      .map((t) => `<span class="tag-badge">${escapeHtml(t.name)}</span>`)
      .join("")}</div>`;
  }

  return `
    <div class="clip-item" data-clip-id="${clip.id}">
      <div class="clip-icon">${icon}</div>
      <div class="clip-body">
        <div class="clip-preview">${preview}</div>
        <div class="clip-meta">
          <span>${typeLabel}</span>
          <span>${time}</span>
        </div>
        ${tagsHtml}
      </div>
      <div class="clip-actions">
        <button class="btn btn-sm btn-secondary btn-quick-copy" data-clip-id="${clip.id}" title="Copy">📋</button>
        <button class="btn btn-sm btn-secondary btn-tag-clip" data-clip-id="${clip.id}" title="Tag">🏷</button>
      </div>
    </div>
  `;
}

async function openClipDetail(clipId) {
  selectedClip = currentClips.find((c) => c.id === clipId);
  if (!selectedClip) return;

  const body = document.getElementById("clip-detail-body");
  const clip = selectedClip;

  let tagsHtml = "";
  try {
    const tags = await api.apiRequest("GET", `/api/clips/${clip.id}/tags`);
    if (tags.length) {
      tagsHtml = `<div class="clip-tags" style="margin-top:10px;">${tags
        .map((t) => `<span class="tag-badge">${escapeHtml(t.name)}</span>`)
        .join("")}</div>`;
    }
  } catch {}

  if (clip.type === "text") {
    body.innerHTML = `<div class="clip-detail-content">${escapeHtml(clip.content || "")}</div>${tagsHtml}`;
  } else if (clip.type === "image") {
    const src = `${getConfig().httpUrl}${clip.file_path}`;
    body.innerHTML = `<img class="clip-detail-image" src="${src}" />${tagsHtml}`;
  } else {
    body.innerHTML = `<div class="clip-detail-content">${escapeHtml(clip.content || clip.file_path || "")}</div>${tagsHtml}`;
  }

  document.getElementById("clip-detail-modal").style.display = "flex";
}

async function openTagModal() {
  if (!selectedClip) return;
  const body = document.getElementById("tag-modal-body");

  try {
    const allTags = await api.apiRequest("GET", "/api/tags");
    const clipTags = await api.apiRequest("GET", `/api/clips/${selectedClip.id}/tags`);
    const clipTagIds = new Set(clipTags.map((t) => t.id));

    body.innerHTML = allTags.length
      ? allTags
          .map((t) => {
            const isActive = clipTagIds.has(t.id);
            return `<div class="tag-manage-item">
              <span>${escapeHtml(t.name)}</span>
              <button class="btn btn-sm ${isActive ? "btn-danger" : "btn-primary"} btn-toggle-tag"
                data-tag-name="${escapeHtml(t.name)}" data-active="${isActive}">
                ${isActive ? "Remove" : "Add"}
              </button>
            </div>`;
          })
          .join("")
      : '<p style="color:var(--text-muted);text-align:center;">No tags yet. Create some in the Tags tab.</p>';

    body.querySelectorAll(".btn-toggle-tag").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const tagName = btn.dataset.tagName;
        const isActive = btn.dataset.active === "true";
        if (isActive) {
          await api.apiRequest("DELETE", `/api/clips/${selectedClip.id}/tags/${encodeURIComponent(tagName)}`);
        } else {
          await api.apiRequest("POST", `/api/clips/${selectedClip.id}/tags`, { tagName });
        }
        openTagModal();
      });
    });
  } catch {
    body.innerHTML = '<p style="color:var(--danger);">Failed to load tags</p>';
  }

  document.getElementById("tag-modal").style.display = "flex";
}

async function loadDevices() {
  try {
    allDevices = await api.apiRequest("GET", "/api/devices");
    renderDevices();
  } catch {}
}

function renderDevices() {
  const list = document.getElementById("devices-list");
  if (!allDevices.length) {
    list.innerHTML = '<div class="empty-state"><p>No devices registered yet.</p></div>';
    return;
  }

  list.innerHTML = allDevices
    .map((d) => {
      const isCurrent = d.id === currentDevice.id;
      const icon = d.platform === "darwin" ? "🍎" : d.platform === "linux" ? "🐧" : "🪟";
      const lastSeen = formatTime(d.last_seen);
      return `<div class="device-card">
        <span class="device-icon">${icon}</span>
        <div class="device-info">
          <div class="device-name">${escapeHtml(d.name)}${isCurrent ? " (This Device)" : ""}</div>
          <div class="device-meta">${d.platform} · Last seen: ${lastSeen}</div>
        </div>
        <span class="device-status ${isCurrent ? "online" : "offline"}">${isCurrent ? "Online" : "Offline"}</span>
      </div>`;
    })
    .join("");
}

async function loadTags() {
  try {
    const tags = await api.apiRequest("GET", "/api/tags");
    renderTags(tags);
  } catch {}
}

function renderTags(tags) {
  const list = document.getElementById("tags-list");
  if (!tags || !tags.length) {
    list.innerHTML = '<div class="empty-state"><p>No tags yet.</p></div>';
    return;
  }

  list.innerHTML = tags
    .map((t) => `<div class="tag-item" data-tag-name="${escapeHtml(t.name)}">
      <span class="tag-item-name">${escapeHtml(t.name)}</span>
      <span class="tag-item-count">${t.clip_count} clips</span>
    </div>`)
    .join("");

  list.querySelectorAll(".tag-item").forEach((item) => {
    item.addEventListener("click", async () => {
      const tagName = item.dataset.tagName;
      const clips = await api.apiRequest(
        "GET",
        `/api/tags/${encodeURIComponent(tagName)}/clips`
      );
      currentClips = clips;
      renderClips();
      document.querySelector('.tab[data-tab="history"]').click();
    });
  });
}

document.getElementById("btn-create-tag").addEventListener("click", async () => {
  const input = document.getElementById("new-tag-input");
  const name = input.value.trim();
  if (!name) return;

  await api.apiRequest("POST", "/api/tags", { name });
  input.value = "";
  await loadTags();
});

function getConfig() {
  return {
    httpUrl: document.getElementById("setting-http-url").value,
    serverUrl: document.getElementById("setting-ws-url").value,
  };
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function formatTime(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso + "Z");
    const now = new Date();
    const diff = (now - d) / 1000;

    if (diff < 60) return "Just now";
    if (diff < 3600) return Math.floor(diff / 60) + "m ago";
    if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
    return d.toLocaleDateString();
  } catch {
    return iso;
  }
}

function showNotification(msg) {
  const existing = document.querySelector(".notification");
  if (existing) existing.remove();

  const el = document.createElement("div");
  el.className = "notification";
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

init();
