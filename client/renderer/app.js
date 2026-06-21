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
let conversionRules = [];
let editingRuleId = null;

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
  setupConversionUI();

  await loadClips();
  await loadDevices();
  await loadTags();
  await loadPendingConflicts();
  await refreshUploadQueue();
  await loadConversionRules();
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
      if (tab.dataset.tab === "conversions") loadConversionRules();
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

  document.getElementById("btn-copy-converted").addEventListener("click", async () => {
    if (!selectedClip) return;
    await openConversionPicker(selectedClip);
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

async function loadConversionRules() {
  try {
    conversionRules = await api.apiRequest("GET", "/api/conversion-rules");
    renderConversionRules();
  } catch {}
}

function renderConversionRules() {
  const list = document.getElementById("conversion-rules-list");
  if (!conversionRules.length) {
    list.innerHTML = '<div class="empty-state"><p>No conversion rules yet.</p></div>';
    return;
  }

  const srcMap = { text: "Text", image: "Image", file: "File", any: "Any" };
  const tgtMap = { text: "Text", image: "Image", file: "File" };
  const transformMap = {
    regex_replace: "Regex Replace", image_to_base64: "Image→Base64", file_to_base64: "File→Base64", url_decode: "URL Decode"
  };

  list.innerHTML = conversionRules
    .map((r) => {
      const enabledLabel = r.enabled ? "Enabled" : "Disabled";
      const enabledColor = r.enabled ? "var(--success)" : "var(--text-muted)";
      const actions = r.builtin
        ? `<button class="btn btn-sm btn-secondary btn-toggle-rule" data-rule-id="${r.id}">${r.enabled ? "Disable" : "Enable"}</button>`
        : `<button class="btn btn-sm btn-secondary btn-edit-rule" data-rule-id="${r.id}">Edit</button>
           <button class="btn btn-sm btn-secondary btn-toggle-rule" data-rule-id="${r.id}">${r.enabled ? "Disable" : "Enable"}</button>
           <button class="btn btn-sm btn-danger btn-delete-rule" data-rule-id="${r.id}">Delete</button>`;
      return `<div class="conversion-rule-card" data-rule-id="${r.id}">
        <div class="cr-header">
          <span class="cr-name">${escapeHtml(r.name)}</span>
          ${r.builtin ? '<span class="builtin-badge">Built-in</span>' : ""}
          <span class="cr-type-badge">${srcMap[r.source_type]} → ${tgtMap[r.target_type]}</span>
          <span style="font-size:11px;color:${enabledColor};font-weight:600;">${enabledLabel}</span>
        </div>
        <div class="cr-description">${escapeHtml(r.description || "")}</div>
        <div class="cr-meta">
          <span><strong>Transform:</strong> ${transformMap[r.transform] || r.transform}</span>
          <span><strong>Priority:</strong> ${r.priority}</span>
          ${r.pattern ? `<span><strong>Pattern:</strong> <code style="background:var(--bg);padding:1px 4px;border-radius:3px;">${escapeHtml(r.pattern)}</code></span>` : ""}
        </div>
        <div class="cr-actions">${actions}</div>
      </div>`;
    })
    .join("");

  list.querySelectorAll(".btn-edit-rule").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openRuleEditor(btn.dataset.ruleId);
    });
  });

  list.querySelectorAll(".btn-delete-rule").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm("Delete this conversion rule?")) return;
      await api.apiRequest("DELETE", `/api/conversion-rules/${btn.dataset.ruleId}`);
      showNotification("Rule deleted");
      await loadConversionRules();
    });
  });

  list.querySelectorAll(".btn-toggle-rule").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const rule = conversionRules.find((r) => r.id === btn.dataset.ruleId);
      if (!rule) return;
      await api.apiRequest("PUT", `/api/conversion-rules/${rule.id}`, { enabled: !rule.enabled });
      await loadConversionRules();
    });
  });
}

function setupConversionUI() {
  document.getElementById("btn-new-conversion-rule").addEventListener("click", () => {
    openRuleEditor(null);
  });

  const transformSel = document.getElementById("cr-transform");
  if (transformSel) {
    transformSel.addEventListener("change", toggleRegexFields);
  }

  const testText = document.getElementById("cr-test-text");
  if (testText) {
    let testTimer;
    testText.addEventListener("input", () => {
      clearTimeout(testTimer);
      testTimer = setTimeout(runRegexTest, 300);
    });
  }

  const patternInput = document.getElementById("cr-pattern");
  if (patternInput) {
    let pTimer;
    patternInput.addEventListener("input", () => {
      clearTimeout(pTimer);
      pTimer = setTimeout(runRegexTest, 300);
    });
  }

  const replacementInput = document.getElementById("cr-replacement");
  if (replacementInput) {
    let rTimer;
    replacementInput.addEventListener("input", () => {
      clearTimeout(rTimer);
      rTimer = setTimeout(runRegexTest, 300);
    });
  }

  document.getElementById("btn-save-conversion-rule").addEventListener("click", async () => {
    await saveRuleEditor();
  });
}

async function runRegexTest() {
  const pattern = document.getElementById("cr-pattern").value;
  const sample = document.getElementById("cr-test-text").value;
  const replacement = document.getElementById("cr-replacement").value;
  const resultDiv = document.getElementById("cr-test-result");
  if (!pattern || !sample) {
    resultDiv.textContent = "";
    return;
  }
  const test = await api.testRegex(pattern, sample);
  if (!test.ok) {
    resultDiv.style.color = "var(--danger)";
    resultDiv.textContent = `Regex error: ${test.error}`;
    return;
  }
  try {
    const regex = new RegExp(pattern, "gm");
    const replaced = sample.replace(regex, replacement);
    resultDiv.style.color = "var(--text-secondary)";
    resultDiv.textContent = `Match count: ${test.matches.length}\n\nResult:\n${replaced}`;
  } catch (e) {
    resultDiv.style.color = "var(--danger)";
    resultDiv.textContent = e.message;
  }
}

function toggleRegexFields() {
  const transform = document.getElementById("cr-transform").value;
  const fields = document.getElementById("cr-regex-fields");
  if (transform === "regex_replace") {
    fields.style.display = "block";
  } else {
    fields.style.display = "none";
  }
}

function openRuleEditor(ruleId) {
  editingRuleId = ruleId;
  const rule = ruleId ? conversionRules.find((r) => r.id === ruleId) : null;
  document.getElementById("conversion-rule-title").textContent = rule ? "Edit Conversion Rule" : "New Conversion Rule";
  document.getElementById("cr-name").value = rule ? rule.name : "";
  document.getElementById("cr-description").value = rule ? rule.description || "" : "";
  document.getElementById("cr-source-type").value = rule ? rule.source_type : "text";
  document.getElementById("cr-target-type").value = rule ? rule.target_type : "text";
  document.getElementById("cr-transform").value = rule ? rule.transform : "regex_replace";
  document.getElementById("cr-pattern").value = rule ? rule.pattern || "" : "";
  document.getElementById("cr-replacement").value = rule ? rule.replacement || "" : "";
  document.getElementById("cr-priority").value = rule ? rule.priority : 100;
  document.getElementById("cr-enabled").checked = rule ? rule.enabled : true;
  document.getElementById("cr-test-text").value = "";
  document.getElementById("cr-test-result").textContent = "";
  toggleRegexFields();
  document.getElementById("conversion-rule-modal").style.display = "flex";
}

async function saveRuleEditor() {
  const name = document.getElementById("cr-name").value.trim();
  if (!name) {
    showNotification("Name is required");
    return;
  }

  const payload = {
    name,
    description: document.getElementById("cr-description").value.trim(),
    source_type: document.getElementById("cr-source-type").value,
    target_type: document.getElementById("cr-target-type").value,
    transform: document.getElementById("cr-transform").value,
    pattern: document.getElementById("cr-pattern").value || null,
    replacement: document.getElementById("cr-replacement").value || null,
    priority: parseInt(document.getElementById("cr-priority").value) || 100,
    enabled: document.getElementById("cr-enabled").checked,
  };

  if (editingRuleId) {
    await api.apiRequest("PUT", `/api/conversion-rules/${editingRuleId}`, payload);
    showNotification("Rule updated");
  } else {
    await api.apiRequest("POST", "/api/conversion-rules", payload);
    showNotification("Rule created");
  }

  editingRuleId = null;
  document.getElementById("conversion-rule-modal").style.display = "none";
  await loadConversionRules();
}

async function openConversionPicker(clip) {
  if (!conversionRules.length) await loadConversionRules();
  const enabledRules = conversionRules.filter(
    (r) => r.enabled && (r.source_type === clip.type || r.source_type === "any")
  );

  const body = document.getElementById("conversion-pick-body");
  if (!enabledRules.length) {
    body.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:20px;">No matching conversion rules for this clip type.<br>Configure them in the <strong>Conversions</strong> tab.</p>';
    document.getElementById("conversion-pick-modal").style.display = "flex";
    return;
  }

  const html = [];
  for (const rule of enabledRules) {
    const converted = await api.convertClipLocal(clip, rule);
    if (!converted) continue;
    let preview = "";
    if (converted.type === "text") {
      const content = converted.content || "";
      preview = content.length > 800 ? content.slice(0, 800) + "\n... (truncated)" : content;
    } else {
      preview = "[" + converted.type.toUpperCase() + " content]";
    }
    html.push(`
      <div class="conversion-option-card" data-rule-id="${rule.id}">
        <div class="conversion-option-header">
          <span class="conversion-option-name">${escapeHtml(rule.name)}</span>
          <span class="cr-type-badge">${clip.type} → ${converted.type}</span>
        </div>
        <div class="conversion-option-preview">${escapeHtml(preview)}</div>
      </div>
    `);
  }

  if (!html.length) {
    body.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:20px;">No conversion available for this clip.</p>';
  } else {
    body.innerHTML = html.join("");
    body.querySelectorAll(".conversion-option-card").forEach((card) => {
      card.addEventListener("click", async () => {
        const rule = conversionRules.find((r) => r.id === card.dataset.ruleId);
        const result = await api.copyToClipboardWithConversion(clip, rule);
        if (result.ok) {
          showNotification(`Pasted as: ${rule.name}`);
        } else {
          showNotification("Conversion failed: " + (result.error || "unknown"));
        }
        document.getElementById("conversion-pick-modal").style.display = "none";
        document.getElementById("clip-detail-modal").style.display = "none";
      });
    });
  }

  document.getElementById("conversion-pick-modal").style.display = "flex";
}

init();
