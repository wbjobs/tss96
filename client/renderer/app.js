const api = window.clipSync;

let currentClips = [];
let currentDevice = null;
let allDevices = [];
let selectedClip = null;
let searchTimeout = null;
const uploads = new Map();
const pendingConflicts = [];
let currentConflict = null;
let selectedConflictClipId = null;

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
  setupUploadsPanel();
  setupConflictUI();

  await loadClips();
  await loadDevices();
  await loadTags();
  await loadPendingConflicts();
  await refreshUploadQueue();
}

function setupUploadsPanel() {
  const btnToggle = document.getElementById("btn-uploads-toggle");
  const btnClose = document.getElementById("btn-close-uploads");
  const panel = document.getElementById("uploads-panel");

  btnToggle.addEventListener("click", () => {
    const isHidden = panel.style.display === "none";
    panel.style.display = isHidden ? "block" : "none";
    if (isHidden) refreshUploadQueue();
  });

  btnClose.addEventListener("click", () => {
    panel.style.display = "none";
  });
}

function setupConflictUI() {
  document.getElementById("btn-conflicts").addEventListener("click", async () => {
    await loadPendingConflicts();
    if (pendingConflicts.length) {
      openConflictModal(pendingConflicts[0]);
    }
  });

  document.getElementById("btn-keep-both").addEventListener("click", async () => {
    if (!currentConflict) return;
    await api.apiRequest("POST", `/api/conflicts/${currentConflict.id}/resolve`, { keepBoth: true });
    closeConflictModal();
    showNotification("Both clips kept");
    await loadClips();
    refreshConflictBadge();
  });

  document.getElementById("btn-resolve-latest").addEventListener("click", async () => {
    if (!currentConflict) return;
    const clips = currentConflict.clips || [];
    if (!clips.length) return;
    clips.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    const latest = clips[0];
    await resolveConflictWithChoice(latest.id);
  });
}

function openConflictModal(conflict) {
  currentConflict = conflict;
  selectedConflictClipId = null;
  const container = document.getElementById("conflict-clips-container");

  container.innerHTML = (conflict.clips || [])
    .map((clip) => {
      const icons = { text: "📝", image: "🖼", file: "📎" };
      const icon = icons[clip.type] || "📋";
      let preview = "";
      if (clip.type === "text") {
        preview = escapeHtml(clip.content || "");
      } else if (clip.type === "image") {
        const src = clip.file_path ? getConfig().httpUrl + clip.file_path : "";
        preview = src ? `<img src="${src}" />` : "Image";
      } else {
        preview = escapeHtml(clip.content || clip.file_path || "File");
      }
      const isMine = clip.device_id === currentDevice.id;
      return `<div class="conflict-clip-card" data-clip-id="${clip.id}">
        <div class="conflict-clip-meta">
          <span>${icon} ${clip.type.toUpperCase()}</span>
          <span>·</span>
          <span>${isMine ? "Your Device" : "Other Device"}</span>
          <span>·</span>
          <span>${formatTime(clip.created_at)}</span>
        </div>
        <div class="conflict-clip-preview">${preview}</div>
      </div>`;
    })
    .join("");

  container.querySelectorAll(".conflict-clip-card").forEach((card) => {
    card.addEventListener("click", () => {
      container.querySelectorAll(".conflict-clip-card").forEach((c) => c.classList.remove("selected"));
      card.classList.add("selected");
      selectedConflictClipId = card.dataset.clipId;
    });
    card.addEventListener("dblclick", async () => {
      selectedConflictClipId = card.dataset.clipId;
      await resolveConflictWithChoice(selectedConflictClipId);
    });
  });

  document.getElementById("conflict-modal").style.display = "flex";
}

function closeConflictModal() {
  document.getElementById("conflict-modal").style.display = "none";
  const idx = pendingConflicts.findIndex((c) => c.id === currentConflict.id);
  if (idx >= 0) pendingConflicts.splice(idx, 1);
  currentConflict = null;
  refreshConflictBadge();
}

async function resolveConflictWithChoice(chosenClipId) {
  if (!currentConflict) return;
  await api.apiRequest("POST", `/api/conflicts/${currentConflict.id}/resolve`, {
    chosenClipId,
  });
  closeConflictModal();
  showNotification("Conflict resolved");
  await loadClips();
}

async function loadPendingConflicts() {
  try {
    const conflicts = await api.apiRequest("GET", "/api/conflicts?resolved=false");
    pendingConflicts.length = 0;
    pendingConflicts.push(...conflicts);
    refreshConflictBadge();
  } catch {}
}

function refreshConflictBadge() {
  const count = pendingConflicts.length;
  const btn = document.getElementById("btn-conflicts");
  const badge = document.getElementById("conflict-badge");
  if (count > 0) {
    btn.style.display = "inline-flex";
    badge.style.display = "inline-block";
    badge.textContent = count;
  } else {
    btn.style.display = "none";
    badge.style.display = "none";
  }
}

async function refreshUploadQueue() {
  try {
    const items = await api.getUploadQueue();
    uploads.clear();
    items.forEach((u) => uploads.set(u.taskId, u));
    renderUploads();
  } catch {}
}

function renderUploads() {
  const list = document.getElementById("uploads-list");
  const items = Array.from(uploads.values()).sort((a, b) => {
    const order = { queued: 0, uploading: 1, completed: 2, failed: 3, aborted: 4 };
    return (order[a.status] || 0) - (order[b.status] || 0);
  });

  const badge = document.getElementById("upload-badge");
  const activeCount = items.filter((u) => u.status === "uploading" || u.status === "queued").length;
  if (activeCount > 0) {
    badge.style.display = "inline-block";
    badge.textContent = activeCount;
  } else {
    badge.style.display = "none";
  }

  if (!items.length) {
    list.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted);font-size:12px;">No uploads in queue</div>';
    return;
  }

  list.innerHTML = items
    .map((u) => {
      const isDone = u.status === "completed" || u.status === "aborted" || u.status === "failed";
      return `<div class="upload-item" data-task-id="${u.taskId}">
        <div class="upload-item-header">
          <span class="upload-filename">📎 ${escapeHtml(u.filename)}</span>
          <span class="upload-status ${u.status}">${u.status}</span>
        </div>
        <div class="upload-progress-row">
          <div class="progress-bar">
            <div class="progress-bar-fill" style="width:${u.progress || 0}%"></div>
          </div>
          <span class="upload-progress-text">${u.progress || 0}%</span>
        </div>
        ${!isDone ? `<div class="upload-actions"><button class="btn btn-sm btn-danger btn-abort-upload" data-task-id="${u.taskId}">Cancel</button></div>` : ""}
        ${u.error ? `<div style="color:var(--danger);font-size:11px;margin-top:4px;">${escapeHtml(u.error)}</div>` : ""}
      </div>`;
    })
    .join("");

  list.querySelectorAll(".btn-abort-upload").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await api.abortUpload(btn.dataset.taskId);
      uploads.delete(btn.dataset.taskId);
      renderUploads();
    });
  });
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
        item.innerHTML = `<span style="font-size:20px;">${icon}</span><span>${escapeHtml(d.name)}</span>`;
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
    const idx = currentClips.findIndex((c) => c.id === clip.id);
    if (idx >= 0) currentClips.splice(idx, 1);
    currentClips.unshift(clip);
    renderClips();
  });

  api.onClipCreatedRemote((clip) => {
    const idx = currentClips.findIndex((c) => c.id === clip.id);
    if (idx >= 0) currentClips.splice(idx, 1);
    currentClips.unshift(clip);
    renderClips();
  });

  api.onClipReceived((clip) => {
    showNotification("Received clip from another device!");
    loadClips();
  });

  api.onWsStatus((status) => {
    const indicator = document.getElementById("ws-indicator");
    indicator.className = "status-dot " + status;
    indicator.title = status.charAt(0).toUpperCase() + status.slice(1);
  });

  api.onUploadProgress((upload) => {
    uploads.set(upload.taskId, upload);
    renderUploads();

    if (upload.status === "completed") {
      setTimeout(() => {
        loadClips();
      }, 300);
    }
  });

  api.onRemoteUploadProgress((data) => {
    renderClips();
  });

  api.onConflictDetected((data) => {
    if (data.conflict && data.clips) {
      pendingConflicts.push({
        ...data.conflict,
        clips: data.clips,
      });
      refreshConflictBadge();
      if (!currentConflict) {
        openConflictModal({ ...data.conflict, clips: data.clips });
      }
      showNotification("⚠ Clipboard conflict detected!");
    }
  });

  api.onClipboardChangedConflict((clip) => {
    showNotification("⚠ Conflict with another device");
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
  const isUploading = clip.uploading;
  let preview = "";

  if (clip.type === "text") {
    preview = escapeHtml(clip.content || "");
  } else if (clip.type === "image") {
    if (clip.file_path) {
      preview = `<img src="${getConfig().httpUrl}${clip.file_path}" style="max-height:36px;border-radius:4px;" />`;
    } else {
      preview = `<span style="color:var(--text-muted);">Image ${isUploading ? "(uploading...)" : ""}</span>`;
    }
  } else {
    preview = escapeHtml(clip.content || clip.file_path || "File");
  }

  const time = formatTime(clip.created_at);
  const typeLabel = clip.type.charAt(0).toUpperCase() + clip.type.slice(1);

  let tagsHtml = "";
  if (clip._tags && clip._tags.length) {
    tagsHtml = `<div class="clip-tags">${clip._tags
      .map((t) => `<span class="tag-badge">${escapeHtml(t.name)}</span>`)
      .join("")}</div>`;
  }

  return `
    <div class="clip-item ${isUploading ? "uploading" : ""}" data-clip-id="${clip.id}">
      <div class="clip-icon">${icon}</div>
      <div class="clip-body">
        <div class="clip-preview">${preview}</div>
        <div class="clip-meta">
          <span>${typeLabel}</span>
          <span>${time}</span>
          ${isUploading ? '<span style="color:var(--accent);">⏳ Uploading...</span>' : ""}
          ${clip.hasConflict ? '<span style="color:var(--warning);">⚠ Conflict</span>' : ""}
        </div>
        ${tagsHtml}
      </div>
      <div class="clip-actions">
        <button class="btn btn-sm btn-secondary btn-quick-copy" data-clip-id="${clip.id}" title="Copy" ${isUploading ? "disabled style=\"opacity:0.5;cursor:not-allowed;\"" : ""}>📋</button>
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
    const src = clip.file_path ? `${getConfig().httpUrl}${clip.file_path}` : clip.localPath || "";
    body.innerHTML = src ? `<img class="clip-detail-image" src="${src}" />${tagsHtml}` : `<div style="color:var(--text-muted);text-align:center;padding:30px;">Image not yet available</div>${tagsHtml}`;
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
      const statusClass = d.online || isCurrent ? "online" : "offline";
      const statusLabel = d.online || isCurrent ? "Online" : "Offline";
      return `<div class="device-card">
        <span class="device-icon">${icon}</span>
        <div class="device-info">
          <div class="device-name">${escapeHtml(d.name)}${isCurrent ? " (This Device)" : ""}</div>
          <div class="device-meta">${d.platform} · Last seen: ${lastSeen}</div>
        </div>
        <span class="device-status ${statusClass}">${statusLabel}</span>
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
