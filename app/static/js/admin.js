/* ============================================================
   admin.js — QC System Admin UI Logic
   ============================================================ */

// ————————————————————————————————————————————————————————————
const metaRole = document.querySelector('meta[name="user-role"]');
const userRole = metaRole ? metaRole.getAttribute("content") : "viewer";
// Semua endpoint API admin/kepala_qc menggunakan prefix /admin
// qc_line punya blueprint dan JS sendiri di template qc_line/
const apiBase = "admin";

const Toast = (() => {
  let container;
  function getContainer() {
    if (!container) {
      container = document.createElement("div");
      container.className = "toast-container";
      document.body.appendChild(container);
    }
    return container;
  }

  const icons = {
    success: '<i class="ri-checkbox-circle-fill"></i>',
    danger: '<i class="ri-close-circle-fill"></i>',
    warning: '<i class="ri-alert-fill"></i>',
    info: '<i class="ri-information-fill"></i>',
  };

  function show(msg, type = "info", duration = 3500) {
    const t = document.createElement("div");
    t.className = `toast ${type}`;
    t.innerHTML = `
      <span class="toast-icon">${icons[type] || icons.info}</span>
      <span class="toast-msg">${msg}</span>
      <button class="toast-close" onclick="this.closest('.toast').remove()"><i class="ri-close-line"></i></button>`;
    getContainer().appendChild(t);
    setTimeout(() => t.remove(), duration);
  }

  return {
    show,
    success: (m) => show(m, "success"),
    error: (m) => show(m, "danger"),
    warn: (m) => show(m, "warning"),
  };
})();
// Modal Helper
const Modal = (() => {
  function open(id) {
    document.getElementById(id)?.classList.add("open");
  }
  function close(id) {
    document.getElementById(id)?.classList.remove("open");
  }

  // Close on overlay click
  document.addEventListener("click", (e) => {
    if (e.target.classList.contains("modal-overlay")) {
      e.target.classList.remove("open");
    }
  });

  // Close on Escape
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape")
      document.querySelector(".modal-overlay.open")?.classList.remove("open");
  });

  return { open, close };
})();

// API Helper
const API = {
  async request(method, url, body = null) {
    const opts = {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Requested-With": "XMLHttpRequest",
      },
    };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(url, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  },
  get: (url) => API.request("GET", url),
  post: (url, body) => API.request("POST", url, body),
  put: (url, body) => API.request("PUT", url, body),
  delete: (url) => API.request("DELETE", url),
};

// Confirm Dialog
// yesLabel : teks tombol konfirmasi  (default: 'Ya, Hapus')
// yesClass : kelas CSS tombol        (default: 'btn-danger')
function confirmDelete(
  msg = "Yakin ingin menghapus data ini?",
  yesLabel = "Ya, Hapus",
  yesClass = "btn-danger",
) {
  return new Promise((resolve) => {
    const overlay = document.getElementById("confirm-overlay");
    if (!overlay) {
      resolve(window.confirm(msg));
      return;
    }
    document.getElementById("confirm-msg").textContent = msg;
    const btnYes = document.getElementById("confirm-yes");
    const btnNo = document.getElementById("confirm-no");
    // Update label & style dynamically
    btnYes.textContent = yesLabel;
    btnYes.className = `btn ${yesClass}`;
    overlay.classList.add("open");
    const onYes = () => {
      overlay.classList.remove("open");
      resolve(true);
      cleanup();
    };
    const onNo = () => {
      overlay.classList.remove("open");
      resolve(false);
      cleanup();
    };
    function cleanup() {
      btnYes.removeEventListener("click", onYes);
      btnNo.removeEventListener("click", onNo);
    }
    btnYes.addEventListener("click", onYes);
    btnNo.addEventListener("click", onNo);
  });
}

// Dropdown Toggle
document.addEventListener("click", (e) => {
  if (!e.target.closest(".dropdown")) {
    document
      .querySelectorAll(".dropdown-menu.open")
      .forEach((m) => m.classList.remove("open"));
  }
  // close sidebar on mobile if clicking outside
  if (window.innerWidth <= 768) {
    const sidebar = document.querySelector(".sidebar");
    if (
      sidebar &&
      sidebar.classList.contains("open") &&
      !e.target.closest(".sidebar") &&
      !e.target.closest("#menu-toggle")
    ) {
      sidebar.classList.remove("open");
    }
  }
});

/* =========================================================================
   PROSES KEPUTUSAN PAGE - C4.5 Batch Decision Process
   ========================================================================= */
window.C45Page = (function () {
  let _openQcs = []; // all OPEN qc holds
  let _results = []; // preview results from /api/c45/batch
  let _selected = new Set(); // checked qc_hold_ids
  let _c45Info = null;

  // Severity label helper
  const SEV_LABEL = { 1: "LOW", 2: "MEDIUM", 3: "HIGH" };
  const SEV_BADGE = {
    1: "badge-success",
    2: "badge-warning",
    3: "badge-danger",
  };

  // Probability bar render
  function probBar(pct) {
    const color = pct >= 80 ? "#22c55e" : pct >= 60 ? "#f59e0b" : "#ef4444";
    return `
      <div class="prob-bar-wrap">
        <div class="prob-bar-bg">
          <div class="prob-bar-fill" style="width:${pct}%;background:${color}"></div>
        </div>
        <span class="prob-label" style="color:${color}">${pct}%</span>
      </div>`;
  }

  function decisionBadge(label, code) {
    const upper = (code || label || "").toUpperCase();
    let cls = "badge-ok";
    let icon = "ri-checkbox-circle-line";
    if (upper.includes("DISPOSAL") || upper.includes("SCRAP")) {
      cls = "badge-disposal";
      icon = "ri-close-circle-line";
    } else if (upper.includes("REWORK")) {
      cls = "badge-rework";
      icon = "ri-refresh-line";
    } else if (upper.includes("DISPOSISI")) {
      cls = "badge-disposisi";
      icon = "ri-arrow-right-circle-line";
    }
    return `<span class="badge ${cls}"><i class="${icon}"></i> ${esc(label)}</span>`;
  }

  function statusBadge(status) {
    if (status === "YES") {
      return `<span class="badge badge-status-yes"><i class="ri-check-line"></i> YES</span>`;
    } else if (status === "NO") {
      return `<span class="badge badge-status-no"><i class="ri-close-line"></i> NO</span>`;
    }
    return `<span style="color:var(--text-muted);font-size:12px;">-</span>`;
  }

  function updateToolbar() {
    const btnProcess = document.getElementById("btn-process");
    const btnConfirm = document.getElementById("btn-confirm");
    const btnDiscard = document.getElementById("btn-discard");
    const selCount = document.getElementById("selected-count");
    if (btnProcess) btnProcess.disabled = _selected.size === 0;
    if (selCount) selCount.textContent = `${_selected.size} dipilih`;
    if (btnConfirm && btnDiscard) {
      if (_results.length > 0) {
        btnConfirm.style.display = "";
        btnDiscard.style.display = "";
        btnConfirm.disabled = false;
        btnDiscard.disabled = false;
      } else {
        btnConfirm.style.display = "none";
        btnDiscard.style.display = "none";
      }
    }
  }

  // Load active model status
  async function loadModelStatus() {
    const el = document.getElementById("model-status-label");
    if (!el) return;
    try {
      const models = await API.get(`/${apiBase}/api/models`);
      const active = models.find((m) => m.is_active);
      if (active) {
        const acc =
          active.metrics && active.metrics["Accuracy"]
            ? ` (Akurasi: ${(active.metrics["Accuracy"] * 100).toFixed(1)}%)`
            : "";
        el.innerHTML = `<span style="color:var(--success)">Model C4.5 Aktif:</span> ${esc(active.name)}${acc}`;
      } else {
        el.innerHTML = `<span style="color:var(--danger)"><i class="ri-error-warning-line"></i> Tidak ada model aktif - aktifkan model C4.5 terlebih dahulu.</span>`;
      }
    } catch {
      el.innerHTML = `<span style="color:var(--danger)">Gagal memuat status model.</span>`;
    }
  }

  // Load OPEN QC Holds
  async function loadOpenQcs() {
    const tbody = document.getElementById("c45-tbody");
    if (!tbody) return;
    tbody.innerHTML =
      '<tr><td colspan="10" class="table-empty"><div class="spinner"></div></td></tr>';
    _selected.clear();
    _results = [];
    updateToolbar();
    hideProcessedCount();

    try {
      _openQcs = await API.get(`/${apiBase}/api/c45/open-qcs`);
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="10" class="table-empty">Gagal memuat data: ${esc(e.message)}</td></tr>`;
      return;
    }

    if (_openQcs.length === 0) {
      tbody.innerHTML =
        '<tr><td colspan="10" class="table-empty"><i class="ri-checkbox-circle-line" style="font-size:18px;color:var(--success)"></i> Tidak ada QC Hold berstatus OPEN saat ini.</td></tr>';
      return;
    }

    tbody.innerHTML = _openQcs
      .map((q) => {
        const sev = q.defect_severity || 1;
        const sevLabel = SEV_LABEL[sev] || `Level ${sev}`;
        const sevBadge = SEV_BADGE[sev] || "badge-neutral";
        return `
        <tr id="row-${q.id}">
          <td class="col-check">
            <input type="checkbox" class="row-cb" data-id="${q.id}" onchange="C45Page.onRowCheck(this)">
          </td>
          <td><span class="fw-bold">${esc(q.qc_code)}</span></td>
          <td style="white-space:nowrap">${fmtDate(q.inspection_date)}</td>
          <td>${esc(q.product_category || "-")}</td>
          <td style="white-space:nowrap">${q.qty_total || 0} / <span style="color:var(--danger)">${q.qty_ng || 0}</span></td>
          <td>${esc(q.defect_category || "-")}</td>
          <td><span class="badge ${sevBadge}">${sevLabel}</span></td>
          <td id="result-${q.id}"><span style="color:var(--text-muted);font-size:12px;">-</span></td>
          <td id="status-${q.id}"><span style="color:var(--text-muted);font-size:12px;">-</span></td>
          <td id="prob-${q.id}"><span style="color:var(--text-muted);font-size:12px;">-</span></td>
        </tr>`;
      })
      .join("");
  }

  function hideProcessedCount() {
    const el = document.getElementById("processed-count");
    if (el) el.style.display = "none";
    const panel = document.getElementById("preview-panel");
    if (panel) panel.style.display = "none";
  }

  function onRowCheck(cb) {
    const id = parseInt(cb.dataset.id);
    if (cb.checked) _selected.add(id);
    else _selected.delete(id);
    const cbAll = document.getElementById("cb-all");
    if (cbAll)
      cbAll.checked = _selected.size === _openQcs.length && _openQcs.length > 0;
    updateToolbar();
  }

  function onAllCheck(cbAll) {
    document.querySelectorAll(".row-cb").forEach((cb) => {
      cb.checked = cbAll.checked;
      const id = parseInt(cb.dataset.id);
      if (cbAll.checked) _selected.add(id);
      else _selected.delete(id);
    });
    updateToolbar();
  }

  function toggleSelectAll() {
    const cbAll = document.getElementById("cb-all");
    if (!cbAll) return;
    cbAll.checked = !cbAll.checked;
    onAllCheck(cbAll);
  }

  // Run batch C4.5 decision process (preview)
  async function runProcess() {
    if (_selected.size === 0) {
      Toast.warn("Pilih minimal 1 QC Hold terlebih dahulu.");
      return;
    }
    const btn = document.getElementById("btn-process");
    btn.disabled = true;
    btn.innerHTML = '<i class="ri-loader-4-line ri-spin"></i> Memproses...';

    try {
      const res = await API.post(`/${apiBase}/api/c45/batch`, {
        qc_hold_ids: [..._selected],
      });
      _results = res.results || [];

      // Update cells inline
      _results.forEach((r) => {
        const resultCell = document.getElementById(`result-${r.qc_hold_id}`);
        const statusCell = document.getElementById(`status-${r.qc_hold_id}`);
        const probCell = document.getElementById(`prob-${r.qc_hold_id}`);
        const row = document.getElementById(`row-${r.qc_hold_id}`);
        if (resultCell)
          resultCell.innerHTML = decisionBadge(r.action_label, r.action_code);
        if (statusCell) statusCell.innerHTML = statusBadge(r.decision_status);
        if (probCell) probCell.innerHTML = probBar(r.probability);
        if (row) row.classList.add("processed-row");
      });

      // Show processed count
      const countEl = document.getElementById("processed-count");
      if (countEl) {
        const yesCount = _results.filter(
          (x) => x.decision_status === "YES",
        ).length;
        const noCount = _results.filter(
          (x) => x.decision_status === "NO",
        ).length;
        countEl.innerHTML = `<strong>${_results.length}</strong> diproses (YES: <strong>${yesCount}</strong>, NO: <strong>${noCount}</strong>)`;
        countEl.style.display = "";
      }

      // Build preview panel
      buildPreviewPanel(res.model_name);
      Toast.success(
        `Proses Keputusan selesai - ${_results.length} item diproses dengan model: ${res.model_name}`,
      );
    } catch (e) {
      Toast.error("Proses keputusan gagal: " + e.message);
    } finally {
      btn.disabled = _selected.size === 0;
      btn.innerHTML = '<i class="ri-brain-line"></i> Proses Keputusan';
      updateToolbar();
    }
  }

  function buildPreviewPanel(modelName) {
    const panel = document.getElementById("preview-panel");
    const tbody = document.getElementById("preview-tbody");
    if (!panel || !tbody) return;

    tbody.innerHTML = _results
      .map((r) => {
        const notes = r.is_disposal
          ? "Perbaikan NG (Gagal / Disposal)"
          : "Perbaikan OK (Lanjut Proses Produksi)";
        const notesColor = r.is_disposal ? "#dc2626" : "#16a34a";
        const sev = r.defect_severity || 1;
        const sevLabel = SEV_LABEL[sev] || `Level ${sev}`;
        const sevBadge = SEV_BADGE[sev] || "badge-neutral";
        return `
        <tr>
          <td><strong>${esc(r.qc_code)}</strong></td>
          <td>${esc(r.product_category || "-")}</td>
          <td>${esc(r.defect_category || "-")} <span class="badge ${sevBadge}" style="font-size:10px;">${sevLabel}</span></td>
          <td>${decisionBadge(r.action_label, r.action_code)}</td>
          <td>${statusBadge(r.decision_status)}</td>
          <td style="font-size:12px;color:${notesColor};font-weight:600;">${esc(notes)}</td>
        </tr>`;
      })
      .join("");

    panel.style.display = "";
    panel.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // Confirm & Apply
  async function confirmResults() {
    if (_results.length === 0) {
      Toast.warn("Tidak ada hasil proses keputusan untuk dikonfirmasi.");
      return;
    }

    const ok = await confirmDelete(
      `Terapkan ${_results.length} hasil keputusan ke QC Hold terpilih? Status data akan disimpan secara permanen.`,
      "Ya, Konfirmasi",
      "btn-success",
    );
    if (!ok) return;

    const btn = document.getElementById("btn-confirm");
    btn.disabled = true;
    btn.innerHTML = '<i class="ri-loader-4-line ri-spin"></i> Menyimpan...';

    try {
      const payload = _results.map((r) => ({
        qc_hold_id: r.qc_hold_id,
        action_id: r.action_id,
        probability: r.probability,
      }));
      const res = await API.post(`/${apiBase}/api/c45/confirm`, {
        items: payload,
      });
      Toast.success(`${res.confirmed} QC Hold berhasil diproses!`);
      _results = [];
      _selected.clear();
      hideProcessedCount();
      updateToolbar();
      await loadOpenQcs();
    } catch (e) {
      Toast.error("Konfirmasi gagal: " + e.message);
    } finally {
      btn.disabled = false;
      btn.innerHTML =
        '<i class="ri-check-double-line"></i> Konfirmasi & Terapkan';
      updateToolbar();
    }
  }

  async function refresh() {
    _results = [];
    hideProcessedCount();
    await loadOpenQcs();
  }

  async function init() {
    await Promise.all([loadModelStatus(), loadOpenQcs()]);
  }

  function discardResults() {
    _results.forEach((r) => {
      const resultCell = document.getElementById(`result-${r.qc_hold_id}`);
      const statusCell = document.getElementById(`status-${r.qc_hold_id}`);
      const probCell = document.getElementById(`prob-${r.qc_hold_id}`);
      const row = document.getElementById(`row-${r.qc_hold_id}`);
      if (resultCell)
        resultCell.innerHTML =
          '<span style="color:var(--text-muted);font-size:12px;">-</span>';
      if (statusCell)
        statusCell.innerHTML =
          '<span style="color:var(--text-muted);font-size:12px;">-</span>';
      if (probCell)
        probCell.innerHTML =
          '<span style="color:var(--text-muted);font-size:12px;">-</span>';
      if (row) row.classList.remove("processed-row");
    });
    _results = [];
    hideProcessedCount();
    updateToolbar();
    Toast.show("Hasil proses keputusan dibatalkan.", "info");
  }

  return {
    init,
    refresh,
    onRowCheck,
    onAllCheck,
    toggleSelectAll,
    runProcess,
    confirmResults,
    discardResults,
  };
})();

/* =========================================================================
   MODEL ML PAGE
   ========================================================================= */
const ModelPage = {
  _allData: [],

  async load() {
    try {
      const data = await API.get(`/${apiBase}/api/models`);
      this._allData = data;
      const tbody = document.querySelector("#model-table tbody");
      if (!tbody) return;
      if (data.length === 0) {
        tbody.innerHTML =
          '<tr><td colspan="7" class="table-empty">Belum ada model ditraining</td></tr>';
        return;
      }
      tbody.innerHTML = data
        .map((m) => {
          const acc =
            m.metrics && m.metrics["Accuracy"]
              ? (m.metrics["Accuracy"] * 100).toFixed(1) + "%"
              : "-";
          const accColor =
            m.metrics && m.metrics["Accuracy"] >= 0.8
              ? "var(--success)"
              : m.metrics && m.metrics["Accuracy"] >= 0.6
                ? "var(--warning)"
                : "var(--danger)";
          return `
        <tr>
          <td>
            <div class="fw-bold">${esc(m.name)}</div>
            <div style="font-size:11px;color:var(--text-muted)">${esc(m.algorithm)} v${esc(m.version)}</div>
          </td>
          <td style="font-size:12px;">${esc(m.dataset_name || "-")}</td>
          <td>${fmtDate(m.trained_at)}</td>
          <td>
            <span style="font-size:16px;font-weight:700;color:${accColor}">${acc}</span>
          </td>
          <td>
            ${
              m.is_active
                ? '<span class="badge badge-success"><i class="ri-shield-check-line"></i> Aktif</span>'
                : '<span class="badge badge-neutral"><i class="ri-circle-line"></i> Tidak Aktif</span>'
            }
          </td>
          <td>
            <div class="d-flex gap-1">
              <button class="btn btn-sm btn-secondary" title="Detail Metrik & Rules" onclick='ModelPage.showMetrics(${m.id})'>
                <i class="ri-bar-chart-box-line"></i> Metrik
              </button>
              ${
                !m.is_active
                  ? `
              <button class="btn btn-sm btn-primary" title="Aktifkan Model" onclick="ModelPage.activate(${m.id})">
                <i class="ri-toggle-line"></i> Aktifkan
              </button>
              <button class="btn-icon" title="Hapus Model" style="color:var(--danger)" onclick="ModelPage.del(${m.id}, '${esc(m.name)}')">
                <i class="ri-delete-bin-line"></i>
              </button>`
                  : ""
              }
            </div>
          </td>
        </tr>`;
        })
        .join("");
    } catch (e) {
      Toast.error(e.message);
    }
  },

  openTrain() {
    document.getElementById("train-form").reset();
    Modal.open("train-modal");
  },

  async trainModel() {
    const checkboxes = document.querySelectorAll(
      'input[name="train_datasets"]:checked',
    );
    const datasetIds = Array.from(checkboxes).map((cb) => parseInt(cb.value));
    if (datasetIds.length === 0) {
      Toast.warn("Pilih minimal 1 dataset untuk training");
      return;
    }
    const name = document.getElementById("train-name").value.trim();
    if (!name) {
      Toast.warn("Nama model wajib diisi");
      return;
    }

    const body = {
      name,
      dataset_ids: datasetIds,
      max_depth: document.getElementById("train-max-depth").value || null,
      min_samples_split:
        document.getElementById("train-min-samples").value || null,
    };

    const btn = document.querySelector("#train-modal .btn-primary");
    const oldHtml = btn.innerHTML;
    btn.innerHTML =
      '<i class="ri-loader-4-line ri-spin"></i> Memproses C4.5...';
    btn.disabled = true;

    try {
      const res = await API.post(`/${apiBase}/api/models/train`, body);
      Modal.close("train-modal");
      await this.load();
      const acc = res.metrics
        ? (res.metrics["Accuracy"] * 100).toFixed(2)
        : "?";
      Toast.success(`Training selesai! Akurasi: ${acc}%`);
    } catch (e) {
      Toast.error("Training gagal: " + e.message);
    } finally {
      btn.innerHTML = oldHtml;
      btn.disabled = false;
    }
  },

  async activate(id) {
    if (
      !(await confirmDelete(
        "Aktifkan model ini? Model aktif sebelumnya akan dinonaktifkan.",
        "Ya, Aktifkan",
        "btn-primary",
      ))
    )
      return;
    try {
      const res = await API.post(`/${apiBase}/api/models/${id}/activate`, {});
      Toast.success(res.message || "Model diaktifkan");
      await this.load();
    } catch (e) {
      Toast.error(e.message);
    }
  },

  async del(id, name) {
    if (
      !(await confirmDelete(
        `Hapus model "${name}" beserta file fisiknya? Tindakan ini tidak dapat dibatalkan.`,
      ))
    )
      return;
    try {
      const res = await API.delete(`/${apiBase}/api/models/${id}`);
      Toast.success(res.message || "Model dihapus");
      await this.load();
    } catch (e) {
      Toast.error(e.message);
    }
  },

  showMetrics(id) {
    const m = this._allData.find((x) => x.id === id);
    if (!m) return;

    const grid = document.getElementById("metrics-grid");
    const colors = {
      Accuracy: "#4f46e5",
      Precision: "#0ea5e9",
      Recall: "#10b981",
      "F1-Score": "#f59e0b",
    };
    const icons = {
      Accuracy: "ri-focus-3-line",
      Precision: "ri-crosshair-2-line",
      Recall: "ri-history-line",
      "F1-Score": "ri-medal-line",
    };
    grid.innerHTML = Object.keys(m.metrics || {})
      .map((k) => {
        let val = (m.metrics[k] * 100).toFixed(1);
        let color = colors[k] || "#4f46e5";
        let icon = icons[k] || "ri-bar-chart-box-line";
        return `
        <div class="stat-card" style="padding:16px; display:flex; flex-direction:column; align-items:center; background:var(--bg-panel); border-top: 4px solid ${color}; box-shadow:0 4px 6px rgba(0,0,0,0.05); border-radius:8px;">
          <div style="color:var(--text-muted); font-size:24px; margin-bottom:8px;"><i class="${icon}"></i></div>
          <div style="font-size:28px; font-weight:800; color:${color}; margin-bottom:4px;">${val}<span style="font-size:16px">%</span></div>
          <div style="font-size:12px; font-weight:600; color:var(--text-secondary); text-transform:uppercase; letter-spacing:0.5px;">${k}</div>
        </div>
      `;
      })
      .join("");

    const rulesEl = document.getElementById("metrics-rules");
    if (rulesEl) {
      if (m.rules_text) {
        // Beautify the rules
        let formatted = m.rules_text
          .replace(
            /IF/g,
            '<span style="color:#6366f1;font-weight:bold;">IF</span>',
          )
          .replace(
            /THEN/g,
            '<span style="color:#10b981;font-weight:bold;">THEN</span>',
          )
          .replace(
            /AND/g,
            '<span style="color:#f59e0b;font-weight:bold;">AND</span>',
          )
          .replace(
            /DecisionAction=OK/g,
            'DecisionAction=<span class="badge badge-success">OK</span>',
          )
          .replace(
            /DecisionAction=Disposal/g,
            'DecisionAction=<span class="badge badge-danger">Disposal</span>',
          );

        rulesEl.innerHTML = formatted;
        rulesEl.style.lineHeight = "1.8";
        rulesEl.style.fontSize = "13px";
        rulesEl.style.background = "#1e1e2e"; // Dark mode for code block
        rulesEl.style.color = "#cdd6f4";
        rulesEl.style.padding = "16px";
        rulesEl.style.borderRadius = "8px";
        rulesEl.style.border = "1px solid #313244";
      } else {
        rulesEl.textContent = "Tidak ada rules yang tersimpan.";
      }
    }

    const titleEl = document.getElementById("metrics-modal-title");
    if (titleEl) titleEl.textContent = `Metrik: ${m.name}`;
    Modal.open("metrics-modal");
  },
};

/* =========================================================================
   TREE VISUALIZATION PAGE
   ========================================================================= */
const TreePage = {
  myChart: null,

  init() {
    API.get(`/${apiBase}/api/models`).then((data) => {
      const select = document.getElementById("tree-model-select");
      if (!select) return;
      data.forEach((m) => {
        const opt = document.createElement("option");
        opt.value = m.id;
        opt.textContent = `${m.name}${m.is_active ? " Aktif" : ""}`;
        if (m.is_active) opt.style.fontWeight = "700";
        select.appendChild(opt);
      });
      // Auto-load active model if any
      const active = data.find((m) => m.is_active);
      if (active) {
        select.value = active.id;
        this.loadTree(active.id);
      }
    });
  },

  refresh() {
    const id = document.getElementById("tree-model-select").value;
    if (id) this.loadTree(id);
  },

  loadTree(id) {
    if (!id) return;
    const container = document.getElementById("echarts-tree-container");
    const empty = document.getElementById("tree-empty");
    const rulesContainer = document.getElementById("rules-container");

    if (empty) empty.style.display = "none";
    if (rulesContainer) rulesContainer.textContent = "Memuat aturan...";

    if (!this.myChart) {
      this.myChart = echarts.init(container, null, { renderer: "canvas" });
    }
    this.myChart.showLoading({
      text: "Membangun pohon keputusan...",
      textColor: "#6366f1",
      color: "#6366f1",
    });

    API.get(`/${apiBase}/api/models/${id}/tree`)
      .then((data) => {
        this.myChart.hideLoading();

        // Prettify rules text
        if (rulesContainer) {
          rulesContainer.textContent =
            data.rules || "Tidak ada aturan tersimpan.";
        }

        // Deep-style all nodes
        const styleNode = (node, depth = 0) => {
          const isLeaf = !node.children || node.children.length === 0;
          const palette = [
            "#6366f1",
            "#0891b2",
            "#d97706",
            "#7c3aed",
            "#db2777",
          ];
          const edgeColor = palette[depth % palette.length];

          if (isLeaf) {
            node.symbol = "roundRect";
            node.symbolSize = [28, 28];
            node.itemStyle = {
              color: "#059669",
              borderColor: "#047857",
              borderWidth: 2,
              shadowColor: "rgba(5,150,105,0.3)",
              shadowBlur: 8,
            };
            node.label = {
              show: true,
              position: "right",
              verticalAlign: "middle",
              align: "left",
              fontSize: 11,
              fontWeight: "600",
              color: "#065f46",
              backgroundColor: "#d1fae5",
              borderColor: "#6ee7b7",
              borderWidth: 1.5,
              borderRadius: 6,
              padding: [5, 10],
              lineHeight: 18,
              formatter: (params) => params.name.replace(/\\n/g, "\n"),
            };
            node.lineStyle = { color: "#059669", width: 2 };
          } else {
            node.symbol = "circle";
            node.symbolSize = 22;
            node.itemStyle = {
              color: edgeColor,
              borderColor: "#fff",
              borderWidth: 2,
              shadowColor: edgeColor + "55",
              shadowBlur: 10,
            };
            node.label = {
              show: true,
              position: "top",
              distance: 8,
              fontSize: 11,
              fontWeight: "700",
              color: "#1e1b4b",
              backgroundColor: "#eef2ff",
              borderColor: edgeColor,
              borderWidth: 1.5,
              borderRadius: 6,
              padding: [4, 10],
              lineHeight: 17,
              formatter: (params) => params.name.replace(/\\n/g, "\n"),
            };
            node.lineStyle = { color: edgeColor, width: 1.5, curveness: 0.15 };
            (node.children || []).forEach((c) => styleNode(c, depth + 1));
          }
          return node;
        };

        const styledTree = styleNode(JSON.parse(JSON.stringify(data.tree)));

        const option = {
          backgroundColor: "transparent",
          tooltip: {
            trigger: "item",
            triggerOn: "mousemove",
            formatter: (params) => params.name.replace(/\\n/g, "<br>"),
            backgroundColor: "#1e1b4b",
            borderColor: "#6366f1",
            textStyle: { color: "#fff", fontSize: 12 },
            padding: [8, 12],
          },
          series: [
            {
              type: "tree",
              data: [styledTree],
              top: "5%",
              left: "8%",
              bottom: "5%",
              right: "20%",
              layout: "orthogonal",
              orient: "LR",
              roam: true,
              initialTreeDepth: 4,
              lineStyle: { curveness: 0.15, width: 1.5 },
              emphasis: { focus: "ancestor", blurScope: "coordinateSystem" },
              expandAndCollapse: true,
              animationDuration: 400,
              animationDurationUpdate: 600,
              animationEasing: "cubicInOut",
            },
          ],
        };

        this.myChart.setOption(option, true);
        window.addEventListener(
          "resize",
          () => this.myChart && this.myChart.resize(),
        );
      })
      .catch(() => {
        this.myChart && this.myChart.hideLoading();
        if (empty) empty.style.display = "flex";
        Toast.error("Gagal memuat decision tree.");
      });
  },
};

function toggleDropdown(el) {
  const menu = el.nextElementSibling;
  const isOpen = menu.classList.contains("open");
  document
    .querySelectorAll(".dropdown-menu.open")
    .forEach((m) => m.classList.remove("open"));
  if (!isOpen) menu.classList.add("open");
}

// Active nav highlight
document.addEventListener("DOMContentLoaded", () => {
  const path = window.location.pathname;
  document.querySelectorAll(".nav-item").forEach((a) => {
    if (a.href && a.href.includes(path) && path !== "/") {
      a.classList.add("active");
    }
  });
});

//Sidebar mobile toggle
window.toggleSidebar = function () {
  if (window.innerWidth <= 768) {
    document.querySelector(".sidebar")?.classList.toggle("open");
  } else {
    document.querySelector(".sidebar")?.classList.toggle("collapsed");
    document.querySelector(".main-content")?.classList.toggle("expanded");
  }
};

// Users Page
window.UsersPage = (function () {
  let allUsers = [],
    editing = null;

  async function load() {
    try {
      allUsers = await API.get(`/${apiBase}/api/users`);
      render(allUsers);
    } catch (e) {
      Toast.error("Gagal memuat data users: " + e.message);
    }
  }

  function render(users) {
    const tbody = document.querySelector("#users-table tbody");
    if (!tbody) return;
    if (!users.length) {
      tbody.innerHTML = `<tr><td colspan="7" class="table-empty"><div class="empty-state-icon"><i class="ri-user-line"></i></div>Belum ada user</td></tr>`;
      return;
    }
    tbody.innerHTML = users
      .map(
        (u) => `
      <tr>
        <td>${esc(u.nip || "-")}</td>
        <td class="fw-bold">${esc(u.username)}</td>
        <td>${esc(u.full_name || "-")}</td>
        <td style="word-break: break-all; min-width: 140px;">${esc(u.email || "-")}</td>
        <td>${u.role ? `<span class="badge badge-accent">${esc(u.role)}</span>` : '<span class="text-muted">-</span>'}</td>
        <td><span class="badge ${u.is_active ? "badge-success" : "badge-danger"}">${u.is_active ? "Aktif" : "Nonaktif"}</span></td>
        <td>
          <div class="d-flex align-center gap-1">
            <button class="btn-icon" title="Edit" onclick="UsersPage.openEdit(${u.id})"><i class="ri-pencil-line"></i></button>
            <button class="btn-icon" title="Hapus" onclick="UsersPage.deleteUser(${u.id}, '${esc(u.username)}')"><i class="ri-delete-bin-line"></i></button>
          </div>
        </td>
      </tr>`,
      )
      .join("");
  }

  function openCreate() {
    editing = null;
    document.getElementById("user-modal-title").textContent = "Tambah User";
    document.getElementById("user-form").reset();
    document.getElementById("user-id").value = "";
    document.getElementById("pw-hint").textContent = "Wajib diisi";
    Modal.open("user-modal");
  }

  async function openEdit(id) {
    const u = allUsers.find((x) => x.id === id);
    if (!u) return;
    editing = id;
    document.getElementById("user-modal-title").textContent = "Edit User";
    document.getElementById("user-id").value = u.id;
    document.getElementById("user-fullname").value = u.full_name || "";
    document.getElementById("user-nip").value = u.nip || "";
    document.getElementById("user-username").value = u.username;
    document.getElementById("user-email").value = u.email;
    document.getElementById("user-role").value = u.role_id || "";
    document.getElementById("user-active").checked = u.is_active;
    document.getElementById("user-password").value = "";
    document.getElementById("pw-hint").textContent =
      "Kosongkan jika tidak ingin mengubah password";
    Modal.open("user-modal");
  }

  async function saveUser() {
    const payload = {
      full_name: document.getElementById("user-fullname").value.trim(),
      nip: document.getElementById("user-nip").value.trim(),
      username: document.getElementById("user-username").value.trim(),
      email: document.getElementById("user-email").value.trim(),
      role_id: parseInt(document.getElementById("user-role").value) || null,
      is_active: document.getElementById("user-active").checked,
      password: document.getElementById("user-password").value,
    };
    if (!payload.username || !payload.email) {
      Toast.warn("Username dan email wajib diisi");
      return;
    }
    if (!editing && !payload.password) {
      Toast.warn("Password wajib diisi untuk user baru");
      return;
    }
    try {
      if (editing) await API.put(`/${apiBase}/api/users/${editing}`, payload);
      else await API.post(`/${apiBase}/api/users`, payload);
      Modal.close("user-modal");
      Toast.success(
        editing ? "User berhasil diperbarui" : "User berhasil dibuat",
      );
      await load();
    } catch (e) {
      Toast.error(e.message);
    }
  }

  async function deleteUser(id, username) {
    if (!(await confirmDelete(`Hapus user "${username}"?`))) return;
    try {
      await API.delete(`/${apiBase}/api/users/${id}`);
      Toast.success("User berhasil dihapus");
      await load();
    } catch (e) {
      Toast.error(e.message);
    }
  }

  function search(q) {
    const filtered = allUsers.filter((u) =>
      (u.username + u.email + (u.full_name || "") + (u.nip || ""))
        .toLowerCase()
        .includes(q.toLowerCase()),
    );
    render(filtered);
  }

  return { load, openCreate, openEdit, saveUser, deleteUser, search };
})();

// Roles Page
window.RolesPage = (function () {
  let allRoles = [],
    editing = null;

  async function load() {
    try {
      allRoles = await API.get(`/${apiBase}/api/roles`);
      render(allRoles);
    } catch (e) {
      Toast.error("Gagal memuat roles: " + e.message);
    }
  }

  function render(roles) {
    const tbody = document.querySelector("#roles-table tbody");
    if (!tbody) return;
    if (!roles.length) {
      tbody.innerHTML = `<tr><td colspan="3" class="table-empty"><div class="empty-state-icon"><i class="ri-shield-user-line"></i></div>Belum ada role</td></tr>`;
      return;
    }
    tbody.innerHTML = roles
      .map(
        (r) => `
      <tr>
        <td><span class="badge badge-accent">${esc(r.name)}</span></td>
        <td>${esc(r.description || "-")}</td>
        <td><span class="badge badge-neutral">${r.user_count} user</span></td>
        <td>
          <div class="d-flex align-center gap-1">
            <button class="btn-icon" title="Edit" onclick="RolesPage.openEdit(${r.id})"><i class="ri-pencil-line"></i></button>
            <button class="btn-icon" title="Hapus" onclick="RolesPage.deleteRole(${r.id}, '${esc(r.name)}')"><i class="ri-delete-bin-line"></i></button>
          </div>
        </td>
      </tr>`,
      )
      .join("");
  }

  function openCreate() {
    editing = null;
    document.getElementById("role-modal-title").textContent = "Tambah Role";
    document.getElementById("role-form").reset();
    Modal.open("role-modal");
  }

  function openEdit(id) {
    const r = allRoles.find((x) => x.id === id);
    if (!r) return;
    editing = id;
    document.getElementById("role-modal-title").textContent = "Edit Role";
    document.getElementById("role-name").value = r.name;
    document.getElementById("role-desc").value = r.description || "";
    Modal.open("role-modal");
  }

  async function saveRole() {
    const body = {
      name: document.getElementById("role-name").value.trim(),
      description: document.getElementById("role-desc").value.trim(),
    };
    if (!body.name) {
      Toast.warn("Nama role wajib diisi");
      return;
    }
    try {
      if (editing) await API.put(`/${apiBase}/api/roles/${editing}`, body);
      else await API.post(`/${apiBase}/api/roles`, body);
      Modal.close("role-modal");
      Toast.success(editing ? "Role diperbarui" : "Role dibuat");
      await load();
    } catch (e) {
      Toast.error(e.message);
    }
  }

  async function deleteRole(id, name) {
    if (!(await confirmDelete(`Hapus role "${name}"?`))) return;
    try {
      await API.delete(`/${apiBase}/api/roles/${id}`);
      Toast.success("Role dihapus");
      await load();
    } catch (e) {
      Toast.error(e.message);
    }
  }

  return { load, openCreate, openEdit, saveRole, deleteRole };
})();

// Defect Categories Page€
window.CatPage = (function () {
  let all = [],
    editing = null;

  async function load() {
    try {
      all = await API.get(`/${apiBase}/api/defect-categories`);
      render(all);
    } catch (e) {
      Toast.error(e.message);
    }
  }

  function render(items) {
    const tbody = document.querySelector("#qc-table tbody");
    if (!tbody) return;
    if (!items.length) {
      tbody.innerHTML = `<tr><td colspan="9" class="table-empty"><div class="empty-state-icon"><i class="ri-clipboard-line"></i></div>Belum ada data QC Hold</td></tr>`;
      return;
    }
    tbody.innerHTML = items
      .map(
        (q) => `
      <tr>
        <td><span class="fw-bold">${esc(q.qc_code)}</span></td>
        <td class="text-small">${fmtDate(q.inspection_date)}</td>
        <td>
          <div class="fw-bold">${esc(q.product_category)}</div>
        </td>
        <td>
          <span class="badge badge-success">${q.qty_ok} OK</span>
          <span class="badge badge-danger">${q.qty_ng} NG</span>
        </td>
        <td>
          ${q.defect_category ? `<span class="badge badge-neutral">${esc(q.defect_category)}</span>` : "—"}
        </td>
        <td>${q.decision_action ? `<span class="badge ${decisionColor[q.decision_action.toUpperCase()] || "badge-neutral"}">${esc(q.decision_action)}</span>` : '<span class="text-muted">—</span>'}</td>
        <td>
          ${q.status === "OPEN" ? '<span class="badge badge-warning">OPEN</span>' : '<span class="badge badge-success">CLOSE</span>'}
        </td>
        <td>${q.c45_record_id ? '<span class="source-c45"><i class="ri-robot-2-line"></i> C4.5</span>' : '<span class="source-manual"><i class="ri-user-line"></i> Manual</span>'}</td>
        <td>
          <div class="d-flex align-center gap-1">
            ${q.status === "OPEN" ? `<button class="btn-icon" title="Edit" onclick="QcHoldPage.openEdit(${q.id})"><i class="ri-pencil-line"></i></button>` : `<button class="btn-icon" title="Lihat" onclick="QcHoldPage.openView(${q.id})"><i class="ri-eye-line"></i></button>`}
            ${userRole === "qc_line" ? "" : `<button class="btn-icon" title="Hapus" onclick="QcHoldPage.del(${q.id}, '${esc(q.qc_code)}')"><i class="ri-delete-bin-line"></i></button>`}
          </div>
        </td>
      </tr>`,
      )
      .join("");
  }

  async function openView(id) {
    const q = allData.find((x) => x.id === id);
    if (!q) return;
    editing = id;
    document.getElementById("qc-modal-title").textContent =
      "Detail QC Hold (Read-Only)";
    document.getElementById("qc-action-group").style.display = "block";
    document.getElementById("qc-id").value = q.id;
    document.getElementById("qc-date").disabled = true;
    document.getElementById("qc-line").disabled = true;
    document.getElementById("qc-category").disabled = true;
    document.getElementById("qc-severity").disabled = true;
    document.getElementById("qc-qty-total").disabled = true;
    document.getElementById("qc-qty-ng").disabled = true;
    document.getElementById("qc-desc").disabled = true;
    document.getElementById("qc-action").disabled = true;
    document.getElementById("qc-hasil-perbaikan").disabled = true;
    const submitBtn = document.querySelector('#qc-form button[type="submit"]');
    if (submitBtn) submitBtn.style.display = "none";

    await populateProductCatDropdowns();
    document.getElementById("qc-date").value = (q.inspection_date || "")
      .replace(" ", "T")
      .slice(0, 16);
    document.getElementById("qc-line").value = q.product_category_id || "";
    document.getElementById("qc-category").value = q.defect_category_id || "";
    document.getElementById("qc-severity").value = q.defect_severity || "";
    document.getElementById("qc-action").value = q.decision_action_id || "";
    document.getElementById("qc-qty-total").value = q.qty_total || 0;
    document.getElementById("qc-qty-ng").value = q.qty_ng || 0;
    document.getElementById("qc-desc").value =
      q.defect_description || q.notes || "";

    document.getElementById("group-hasil-perbaikan").style.display = "block";
    document.getElementById("qc-hasil-perbaikan").value = "";

    // Disable inputs that shouldn't be edited
    Modal.open("qc-modal"); // Assuming we can use the same modal, just disabled
  }

  async function openCreate() {
    editing = null;
    document.getElementById("qc-modal-title").textContent = "Tambah QC Hold";
    document.getElementById("qc-form").reset();
    document.getElementById("qc-id").value = "";
    document.getElementById("qc-date").disabled = false;
    document.getElementById("qc-line").disabled = false;
    document.getElementById("qc-category").disabled = false;
    document.getElementById("qc-severity").disabled = false;
    document.getElementById("qc-qty-total").disabled = false;
    document.getElementById("qc-qty-ng").disabled = false;
    document.getElementById("qc-desc").disabled = false;
    document.getElementById("qc-action").disabled = false;
    document.getElementById("qc-hasil-perbaikan").disabled = false;
    const submitBtn = document.querySelector('#qc-form button[type="submit"]');
    if (submitBtn) submitBtn.style.display = "inline-flex";

    await populateProductCatDropdowns();
    const now = new Date();
    now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
    document.getElementById("qc-date").value = now.toISOString().slice(0, 16);
    if (userRole === "qc_line") {
      document.getElementById("qc-action-group").style.display = "none";
    } else {
      document.getElementById("qc-action-group").style.display = "block";
    }
    document.getElementById("group-hasil-perbaikan").style.display = "none";
    document.getElementById("qc-hasil-perbaikan").value = "";
    Modal.open("qc-modal");
  }

  async function openEdit(id) {
    const u = allUsers.find((x) => x.id === id);
    if (!u) return;
    editing = id;
    document.getElementById("user-modal-title").textContent = "Edit User";
    document.getElementById("user-id").value = u.id;
    document.getElementById("user-fullname").value = u.full_name || "";
    document.getElementById("user-nip").value = u.nip || "";
    document.getElementById("user-username").value = u.username;
    document.getElementById("user-email").value = u.email;
    document.getElementById("user-role").value = u.role_id || "";
    document.getElementById("user-active").checked = u.is_active;
    document.getElementById("user-password").value = "";
    document.getElementById("pw-hint").textContent =
      "Kosongkan jika tidak ingin mengubah password";
    Modal.open("user-modal");
  }

  async function saveUser() {
    const payload = {
      full_name: document.getElementById("user-fullname").value.trim(),
      nip: document.getElementById("user-nip").value.trim(),
      username: document.getElementById("user-username").value.trim(),
      email: document.getElementById("user-email").value.trim(),
      role_id: parseInt(document.getElementById("user-role").value) || null,
      is_active: document.getElementById("user-active").checked,
      password: document.getElementById("user-password").value,
    };
    if (!payload.username || !payload.email) {
      Toast.warn("Username dan email wajib diisi");
      return;
    }
    if (!editing && !payload.password) {
      Toast.warn("Password wajib diisi untuk user baru");
      return;
    }
    try {
      if (editing) await API.put(`/${apiBase}/api/users/${editing}`, payload);
      else await API.post(`/${apiBase}/api/users`, payload);
      Modal.close("user-modal");
      Toast.success(
        editing ? "User berhasil diperbarui" : "User berhasil dibuat",
      );
      await load();
    } catch (e) {
      Toast.error(e.message);
    }
  }

  async function deleteUser(id, username) {
    if (!(await confirmDelete(`Hapus user "${username}"?`))) return;
    try {
      await API.delete(`/${apiBase}/api/users/${id}`);
      Toast.success("User berhasil dihapus");
      await load();
    } catch (e) {
      Toast.error(e.message);
    }
  }

  function search(q) {
    const filtered = allUsers.filter((u) =>
      (u.username + u.email + (u.full_name || "") + (u.nip || ""))
        .toLowerCase()
        .includes(q.toLowerCase()),
    );
    render(filtered);
  }

  return { load, openCreate, openEdit, saveUser, deleteUser, search };
})();

// Roles Page
window.RolesPage = (function () {
  let allRoles = [],
    editing = null;

  async function load() {
    try {
      allRoles = await API.get(`/${apiBase}/api/roles`);
      render(allRoles);
    } catch (e) {
      Toast.error("Gagal memuat roles: " + e.message);
    }
  }

  function render(roles) {
    const tbody = document.querySelector("#roles-table tbody");
    if (!tbody) return;
    if (!roles.length) {
      tbody.innerHTML = `<tr><td colspan="3" class="table-empty"><div class="empty-state-icon"><i class="ri-shield-user-line"></i></div>Belum ada role</td></tr>`;
      return;
    }
    tbody.innerHTML = roles
      .map(
        (r) => `
      <tr>
        <td><span class="badge badge-accent">${esc(r.name)}</span></td>
        <td>${esc(r.description || "-")}</td>
        <td><span class="badge badge-neutral">${r.user_count} user</span></td>
        <td>
          <div class="d-flex align-center gap-1">
            <button class="btn-icon" title="Edit" onclick="RolesPage.openEdit(${r.id})"><i class="ri-pencil-line"></i></button>
            <button class="btn-icon" title="Hapus" onclick="RolesPage.deleteRole(${r.id}, '${esc(r.name)}')"><i class="ri-delete-bin-line"></i></button>
          </div>
        </td>
      </tr>`,
      )
      .join("");
  }

  function openCreate() {
    editing = null;
    document.getElementById("role-modal-title").textContent = "Tambah Role";
    document.getElementById("role-form").reset();
    Modal.open("role-modal");
  }

  function openEdit(id) {
    const r = allRoles.find((x) => x.id === id);
    if (!r) return;
    editing = id;
    document.getElementById("role-modal-title").textContent = "Edit Role";
    document.getElementById("role-name").value = r.name;
    document.getElementById("role-desc").value = r.description || "";
    Modal.open("role-modal");
  }

  async function saveRole() {
    const body = {
      name: document.getElementById("role-name").value.trim(),
      description: document.getElementById("role-desc").value.trim(),
    };
    if (!body.name) {
      Toast.warn("Nama role wajib diisi");
      return;
    }
    try {
      if (editing) await API.put(`/${apiBase}/api/roles/${editing}`, body);
      else await API.post(`/${apiBase}/api/roles`, body);
      Modal.close("role-modal");
      Toast.success(editing ? "Role diperbarui" : "Role dibuat");
      await load();
    } catch (e) {
      Toast.error(e.message);
    }
  }

  async function deleteRole(id, name) {
    if (!(await confirmDelete(`Hapus role "${name}"?`))) return;
    try {
      await API.delete(`/${apiBase}/api/roles/${id}`);
      Toast.success("Role dihapus");
      await load();
    } catch (e) {
      Toast.error(e.message);
    }
  }

  return { load, openCreate, openEdit, saveRole, deleteRole };
})();

// Defect Categories Page
window.CatPage = (function () {
  let all = [],
    editing = null;

  async function load() {
    try {
      all = await API.get(`/${apiBase}/api/defect-categories`);
      render(all);
    } catch (e) {
      Toast.error(e.message);
    }
  }

  function render(items) {
    const tbody = document.querySelector("#qc-table tbody");
    if (!tbody) return;
    if (!items.length) {
      tbody.innerHTML = `<tr><td colspan="9" class="table-empty"><div class="empty-state-icon"><i class="ri-clipboard-line"></i></div>Belum ada data QC Hold</td></tr>`;
      return;
    }
    tbody.innerHTML = items
      .map(
        (q) => `
      <tr>
        <td><span class="fw-bold">${esc(q.qc_code)}</span></td>
        <td class="text-small">${fmtDate(q.inspection_date)}</td>
        <td>
          <div class="fw-bold">${esc(q.product_category)}</div>
        </td>
        <td>
          <span class="badge badge-success">${q.qty_ok} OK</span>
          <span class="badge badge-danger">${q.qty_ng} NG</span>
        </td>
        <td>
          ${q.defect_category ? `<span class="badge badge-neutral">${esc(q.defect_category)}</span>` : "-"}
        </td>
        <td>${q.decision_action ? `<span class="badge ${decisionColor[q.decision_action_code] || "badge-neutral"}">${esc(q.decision_action)}</span>` : '<span class="text-muted">-</span>'}</td>
        <td>
          ${q.status === "OPEN" ? '<span class="badge badge-warning">OPEN</span>' : '<span class="badge badge-success">CLOSE</span>'}
        </td>
        <td>${q.c45_record_id ? '<span class="source-c45"><i class="ri-robot-2-line"></i> C4.5</span>' : '<span class="source-manual"><i class="ri-user-line"></i> Manual</span>'}</td>
        <td>
          <div class="d-flex align-center gap-1">
            ${q.status === "OPEN" ? `<button class="btn-icon" title="Edit" onclick="QcHoldPage.openEdit(${q.id})"><i class="ri-pencil-line"></i></button>` : `<button class="btn-icon" title="Lihat" onclick="QcHoldPage.openView(${q.id})"><i class="ri-eye-line"></i></button>`}
            ${userRole === "qc_line" ? "" : `<button class="btn-icon" title="Hapus" onclick="QcHoldPage.del(${q.id}, '${esc(q.qc_code)}')"><i class="ri-delete-bin-line"></i></button>`}
          </div>
        </td>
      </tr>`,
      )
      .join("");
  }

  async function openView(id) {
    const q = allData.find((x) => x.id === id);
    if (!q) return;
    editing = id;
    document.getElementById("qc-modal-title").textContent =
      "Detail QC Hold (Read-Only)";
    document.getElementById("qc-action-group").style.display = "block";
    document.getElementById("qc-id").value = q.id;
    document.getElementById("qc-date").disabled = true;
    document.getElementById("qc-line").disabled = true;
    document.getElementById("qc-category").disabled = true;
    document.getElementById("qc-severity").disabled = true;
    document.getElementById("qc-qty-total").disabled = true;
    document.getElementById("qc-qty-ng").disabled = true;
    document.getElementById("qc-desc").disabled = true;
    document.getElementById("qc-action").disabled = true;
    document.getElementById("qc-hasil-perbaikan").disabled = true;
    const submitBtn = document.querySelector('#qc-form button[type="submit"]');
    if (submitBtn) submitBtn.style.display = "none";

    await populateProductCatDropdowns();
    document.getElementById("qc-date").value = (q.inspection_date || "")
      .replace(" ", "T")
      .slice(0, 16);
    document.getElementById("qc-line").value = q.product_category_id || "";
    document.getElementById("qc-category").value = q.defect_category_id || "";
    document.getElementById("qc-severity").value = q.defect_severity || "";
    document.getElementById("qc-action").value = q.decision_action_id || "";
    document.getElementById("qc-qty-total").value = q.qty_total || 0;
    document.getElementById("qc-qty-ng").value = q.qty_ng || 0;
    document.getElementById("qc-desc").value =
      q.defect_description || q.notes || "";

    document.getElementById("group-hasil-perbaikan").style.display = "none";
    Modal.open("qc-modal");
  }

  async function openCreate() {
    editing = null;
    document.getElementById("qc-modal-title").textContent = "Tambah QC Hold";
    if (userRole === "qc_line") {
      document.getElementById("qc-action-group").style.display = "none";
    } else {
      document.getElementById("qc-action-group").style.display = "block";
    }
    document.getElementById("qc-form").reset();
    document.getElementById("qc-id").value = "";
    document.getElementById("qc-date").disabled = false;
    document.getElementById("qc-line").disabled = false;
    document.getElementById("qc-category").disabled = false;
    document.getElementById("qc-severity").disabled = false;
    document.getElementById("qc-qty-total").disabled = false;
    document.getElementById("qc-qty-ng").disabled = false;
    document.getElementById("qc-desc").disabled = false;
    document.getElementById("qc-action").disabled = false;
    document.getElementById("qc-hasil-perbaikan").disabled = false;
    const submitBtn = document.querySelector('#qc-form button[type="submit"]');
    if (submitBtn) submitBtn.style.display = "inline-flex";

    await populateProductCatDropdowns();
    const now = new Date();
    now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
    document.getElementById("qc-date").value = now.toISOString().slice(0, 16);
    document.getElementById("group-hasil-perbaikan").style.display = "none";
    document.getElementById("qc-hasil-perbaikan").value = "";
    Modal.open("qc-modal");
  }

  async function openEdit(id) {
    const u = allUsers.find((x) => x.id === id);
    if (!u) return;
    editing = id;
    document.getElementById("user-modal-title").textContent = "Edit User";
    document.getElementById("user-id").value = u.id;
    document.getElementById("user-fullname").value = u.full_name || "";
    document.getElementById("user-nip").value = u.nip || "";
    document.getElementById("user-username").value = u.username;
    document.getElementById("user-email").value = u.email;
    document.getElementById("user-role").value = u.role_id || "";
    document.getElementById("user-active").checked = u.is_active;
    document.getElementById("user-password").value = "";
    document.getElementById("pw-hint").textContent =
      "Kosongkan jika tidak ingin mengubah password";
    Modal.open("user-modal");
  }

  async function saveUser() {
    const payload = {
      full_name: document.getElementById("user-fullname").value.trim(),
      nip: document.getElementById("user-nip").value.trim(),
      username: document.getElementById("user-username").value.trim(),
      email: document.getElementById("user-email").value.trim(),
      role_id: parseInt(document.getElementById("user-role").value) || null,
      is_active: document.getElementById("user-active").checked,
      password: document.getElementById("user-password").value,
    };
    if (!payload.username || !payload.email) {
      Toast.warn("Username dan email wajib diisi");
      return;
    }
    if (!editing && !payload.password) {
      Toast.warn("Password wajib diisi untuk user baru");
      return;
    }
    try {
      if (editing) await API.put(`/${apiBase}/api/users/${editing}`, payload);
      else await API.post(`/${apiBase}/api/users`, payload);
      Modal.close("user-modal");
      Toast.success(
        editing ? "User berhasil diperbarui" : "User berhasil dibuat",
      );
      await load();
    } catch (e) {
      Toast.error(e.message);
    }
  }

  async function deleteUser(id, username) {
    if (!(await confirmDelete(`Hapus user "${username}"?`))) return;
    try {
      await API.delete(`/${apiBase}/api/users/${id}`);
      Toast.success("User berhasil dihapus");
      await load();
    } catch (e) {
      Toast.error(e.message);
    }
  }

  function search(q) {
    const filtered = allUsers.filter((u) =>
      (u.username + u.email + (u.full_name || "") + (u.nip || ""))
        .toLowerCase()
        .includes(q.toLowerCase()),
    );
    render(filtered);
  }

  return { load, openCreate, openEdit, saveUser, deleteUser, search };
})();

// Roles Page
window.RolesPage = (function () {
  let allRoles = [],
    editing = null;

  async function load() {
    try {
      allRoles = await API.get(`/${apiBase}/api/roles`);
      render(allRoles);
    } catch (e) {
      Toast.error("Gagal memuat roles: " + e.message);
    }
  }

  function render(roles) {
    const tbody = document.querySelector("#roles-table tbody");
    if (!tbody) return;
    if (!roles.length) {
      tbody.innerHTML = `<tr><td colspan="3" class="table-empty"><div class="empty-state-icon"><i class="ri-shield-user-line"></i></div>Belum ada role</td></tr>`;
      return;
    }
    tbody.innerHTML = roles
      .map(
        (r) => `
      <tr>
        <td><span class="badge badge-accent">${esc(r.name)}</span></td>
        <td>${esc(r.description || "-")}</td>
        <td><span class="badge badge-neutral">${r.user_count} user</span></td>
        <td>
          <div class="d-flex align-center gap-1">
            <button class="btn-icon" title="Edit" onclick="RolesPage.openEdit(${r.id})"><i class="ri-pencil-line"></i></button>
            <button class="btn-icon" title="Hapus" onclick="RolesPage.deleteRole(${r.id}, '${esc(r.name)}')"><i class="ri-delete-bin-line"></i></button>
          </div>
        </td>
      </tr>`,
      )
      .join("");
  }

  function openCreate() {
    editing = null;
    document.getElementById("role-modal-title").textContent = "Tambah Role";
    document.getElementById("role-form").reset();
    Modal.open("role-modal");
  }

  function openEdit(id) {
    const r = allRoles.find((x) => x.id === id);
    if (!r) return;
    editing = id;
    document.getElementById("role-modal-title").textContent = "Edit Role";
    document.getElementById("role-name").value = r.name;
    document.getElementById("role-desc").value = r.description || "";
    Modal.open("role-modal");
  }

  async function saveRole() {
    const body = {
      name: document.getElementById("role-name").value.trim(),
      description: document.getElementById("role-desc").value.trim(),
    };
    if (!body.name) {
      Toast.warn("Nama role wajib diisi");
      return;
    }
    try {
      if (editing) await API.put(`/${apiBase}/api/roles/${editing}`, body);
      else await API.post(`/${apiBase}/api/roles`, body);
      Modal.close("role-modal");
      Toast.success(editing ? "Role diperbarui" : "Role dibuat");
      await load();
    } catch (e) {
      Toast.error(e.message);
    }
  }

  async function deleteRole(id, name) {
    if (!(await confirmDelete(`Hapus role "${name}"?`))) return;
    try {
      await API.delete(`/${apiBase}/api/roles/${id}`);
      Toast.success("Role dihapus");
      await load();
    } catch (e) {
      Toast.error(e.message);
    }
  }

  return { load, openCreate, openEdit, saveRole, deleteRole };
})();

// Defect Categories Page
window.CatPage = (function () {
  let all = [],
    editing = null;

  async function load() {
    try {
      all = await API.get(`/${apiBase}/api/defect-categories`);
      render(all);
    } catch (e) {
      Toast.error(e.message);
    }
  }

  function render(items) {
    const tbody = document.querySelector("#qc-table tbody");
    if (!tbody) return;
    if (!items.length) {
      tbody.innerHTML = `<tr><td colspan="9" class="table-empty"><div class="empty-state-icon"><i class="ri-clipboard-line"></i></div>Belum ada data QC Hold</td></tr>`;
      return;
    }
    tbody.innerHTML = items
      .map(
        (q) => `
      <tr>
        <td><span class="fw-bold">${esc(q.qc_code)}</span></td>
        <td class="text-small">${fmtDate(q.inspection_date)}</td>
        <td>
          <div class="fw-bold">${esc(q.product_category)}</div>
        </td>
        <td>
          <span class="badge badge-success">${q.qty_ok} OK</span>
          <span class="badge badge-danger">${q.qty_ng} NG</span>
        </td>
        <td>
          ${q.defect_category ? `<span class="badge badge-neutral">${esc(q.defect_category)}</span>` : "-"}
        </td>
        <td>${q.decision_action ? `<span class="badge ${decisionColor[q.decision_action_code] || "badge-neutral"}">${esc(q.decision_action)}</span>` : '<span class="text-muted">-</span>'}</td>
        <td>
          ${q.status === "OPEN" ? '<span class="badge badge-warning">OPEN</span>' : '<span class="badge badge-success">CLOSE</span>'}
        </td>
        <td>${q.c45_record_id ? '<span class="source-c45"><i class="ri-robot-2-line"></i> C4.5</span>' : '<span class="source-manual"><i class="ri-user-line"></i> Manual</span>'}</td>
        <td>
          <div class="d-flex align-center gap-1">
            ${q.status === "OPEN" ? `<button class="btn-icon" title="Edit" onclick="QcHoldPage.openEdit(${q.id})"><i class="ri-pencil-line"></i></button>` : `<button class="btn-icon" title="Lihat" onclick="QcHoldPage.openView(${q.id})"><i class="ri-eye-line"></i></button>`}
            ${userRole === "qc_line" ? "" : `<button class="btn-icon" title="Hapus" onclick="QcHoldPage.del(${q.id}, '${esc(q.qc_code)}')"><i class="ri-delete-bin-line"></i></button>`}
          </div>
        </td>
      </tr>`,
      )
      .join("");
  }

  async function openView(id) {
    const r = allData.find((x) => x.id === id);
    if (!r) return;
    const body = document.getElementById("qc-view-body");
    body.innerHTML = `
      <style>
        .qc-detail-modal .info-label { font-size: 12px; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
        .qc-detail-modal .info-value { font-size: 14px; color: var(--text-primary); font-weight: 500; }
        .qc-detail-modal .info-value i { color: var(--primary); margin-right: 4px; }
        .qc-detail-modal .detail-header { padding: 24px; background: linear-gradient(135deg, var(--primary) 0%, #1e5dd6 100%); color: white; border-radius: 8px 8px 0 0; }
        .qc-detail-modal .detail-content { padding: 24px; }
      </style>
      <div class="qc-detail-modal">
        <div class="detail-header">
          <div style="display: flex; justify-content: space-between; align-items: flex-start;">
            <div>
              <div style="font-size: 12px; opacity: 0.8; margin-bottom: 4px;">NO QC HOLD</div>
              <div style="font-size: 24px; font-weight: 700; letter-spacing: 1px;">${esc(r.qc_code)}</div>
            </div>
            <span class="badge" style="background: ${r.status === "OPEN" ? "rgba(255,193,7,0.2)" : "rgba(76,175,80,0.2)"}; color: ${r.status === "OPEN" ? "#ffd54f" : "#81c784"}; border: 1px solid currentColor; font-size: 14px; padding: 6px 12px;">${r.status}</span>
          </div>
        </div>
        
        <div class="detail-content">
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 24px;">
            <div>
              <div class="info-label">Tanggal Inspeksi</div>
              <div class="info-value"><i class="ri-calendar-line"></i> ${fmtDate(r.inspection_date)}</div>
            </div>
            <div>
              <div class="info-label">Kategori Produk</div>
              <div class="info-value"><i class="ri-price-tag-3-line"></i> ${esc(r.product_category || "-")}</div>
            </div>
            <div>
              <div class="info-label">Jenis Masalah</div>
              <div class="info-value"><i class="ri-error-warning-line"></i> ${esc(r.defect_category || "-")}</div>
            </div>
            <div>
              <div class="info-label">Tingkat Keparahan (Severity)</div>
              <div class="info-value">${
                r.defect_severity == 1
                  ? '<span class="badge badge-success">LOW</span>'
                  : r.defect_severity == 2
                    ? '<span class="badge badge-warning">MEDIUM</span>'
                    : '<span class="badge badge-danger">HIGH</span>'
              }</div>
            </div>
            <div style="grid-column: span 2;">
              <div class="info-label">Kuantitas (QTY)</div>
              <div style="display: flex; gap: 16px; margin-top: 4px;">
                <div style="background: var(--bg-soft); padding: 12px 16px; border-radius: 8px; border: 1px solid var(--border); flex: 1; display: flex; align-items: center; justify-content: space-between;">
                  <span style="font-size: 13px; color: var(--text-secondary);">Total Planning</span>
                  <span style="font-size: 20px; font-weight: 700; color: var(--text-primary);">${r.qty_total}</span>
                </div>
                <div style="background: var(--danger-soft); padding: 12px 16px; border-radius: 8px; border: 1px solid rgba(239,68,68,0.2); flex: 1; display: flex; align-items: center; justify-content: space-between;">
                  <span style="font-size: 13px; color: var(--danger);">Defect (NG)</span>
                  <span style="font-size: 20px; font-weight: 700; color: var(--danger);">${r.qty_ng}</span>
                </div>
              </div>
            </div>
          </div>

          <div style="background: var(--bg-soft); border-radius: 8px; padding: 16px; border: 1px solid var(--border); margin-bottom: 24px;">
            <div style="margin-bottom: 16px;">
              <div class="info-label">Tindakan Koreksi / Keputusan</div>
              <div class="info-value" style="font-size: 15px; font-weight: 600; color: var(--primary);"><i class="ri-shield-check-fill"></i> ${esc(r.decision_action || "Belum ada keputusan")}</div>
            </div>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px;">
              <div>
                <div class="info-label">Keterangan / Deskripsi</div>
                <div class="info-value" style="white-space: pre-wrap; font-size: 13px;">${esc(r.defect_description || "-")}</div>
              </div>
              <div>
                <div class="info-label">Catatan Tambahan</div>
                <div class="info-value" style="white-space: pre-wrap; font-size: 13px;">${esc(r.notes || "-")}</div>
              </div>
            </div>
          </div>

          <div style="border-top: 1px dashed var(--border); padding-top: 16px; background: rgba(0,0,0,0.02); margin: 0 -24px -24px -24px; padding: 16px 24px; border-radius: 0 0 8px 8px;">
            <div style="display: flex; gap: 24px; font-size: 12px; color: var(--text-secondary); flex-wrap: wrap;">
              <div style="display: flex; align-items: center; gap: 6px;">
                <i class="ri-user-add-line"></i>
                <span><strong>Dibuat:</strong> ${esc(r.created_by_name || "-")}</span>
              </div>
              <div style="display: flex; align-items: center; gap: 6px;">
                <i class="ri-edit-2-line"></i>
                <span><strong>Diedit:</strong> ${esc(r.updated_by_name || "-")}</span>
              </div>
              ${
                r.action_taken_by_name
                  ? `
              <div style="display: flex; align-items: center; gap: 6px; color: var(--primary);">
                <i class="ri-shield-user-line"></i>
                <span><strong>Diputuskan:</strong> ${esc(r.action_taken_by_name)}</span>
              </div>`
                  : ""
              }
            </div>
          </div>
        </div>
      </div>
    `;
    Modal.open("qc-view-modal");
  }

  async function openCreate() {
    editing = null;
    document.getElementById("qc-modal-title").textContent = "Tambah QC Hold";
    if (userRole === "qc_line") {
      document.getElementById("qc-action-group").style.display = "none";
    } else {
      document.getElementById("qc-action-group").style.display = "block";
    }
    document.getElementById("qc-form").reset();
    document.getElementById("qc-id").value = "";
    document.getElementById("qc-date").disabled = false;
    document.getElementById("qc-line").disabled = false;
    document.getElementById("qc-category").disabled = false;
    document.getElementById("qc-severity").disabled = false;
    document.getElementById("qc-qty-total").disabled = false;
    document.getElementById("qc-qty-ng").disabled = false;
    document.getElementById("qc-desc").disabled = false;
    document.getElementById("qc-action").disabled = false;
    document.getElementById("qc-hasil-perbaikan").disabled = false;
    const submitBtn = document.querySelector('#qc-form button[type="submit"]');
    if (submitBtn) submitBtn.style.display = "inline-flex";

    await populateProductCatDropdowns();
    const now = new Date();
    now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
    document.getElementById("qc-date").value = now.toISOString().slice(0, 16);
    document.getElementById("group-hasil-perbaikan").style.display = "none";
    document.getElementById("qc-hasil-perbaikan").value = "";
    document.getElementById("qc-metadata").style.display = "none";
    Modal.open("qc-modal");
  }

  async function openEdit(id) {
    const q = allData.find((x) => x.id === id);
    if (!q) return;
    editing = id;
    document.getElementById("qc-modal-title").textContent = "Edit QC Hold";
    if (userRole === "qc_line") {
      document.getElementById("qc-action-group").style.display = "none";
    } else {
      document.getElementById("qc-action-group").style.display = "block";
    }
    document.getElementById("qc-id").value = q.id;
    document.getElementById("qc-date").disabled = false;
    document.getElementById("qc-line").disabled = false;
    document.getElementById("qc-category").disabled = false;
    document.getElementById("qc-severity").disabled = false;
    document.getElementById("qc-qty-total").disabled = false;
    document.getElementById("qc-qty-ng").disabled = false;
    document.getElementById("qc-desc").disabled = false;
    document.getElementById("qc-action").disabled = false;
    document.getElementById("qc-hasil-perbaikan").disabled = false;
    const submitBtn = document.querySelector('#qc-form button[type="submit"]');
    if (submitBtn) submitBtn.style.display = "inline-flex";

    await populateProductCatDropdowns();
    document.getElementById("qc-date").value = (q.inspection_date || "")
      .replace(" ", "T")
      .slice(0, 16);
    document.getElementById("qc-line").value = q.product_category_id || "";
    document.getElementById("qc-category").value = q.defect_category_id || "";
    document.getElementById("qc-severity").value = q.defect_severity || "";
    document.getElementById("qc-action").value = q.decision_action_id || "";
    document.getElementById("qc-qty-total").value = q.qty_total || 0;
    document.getElementById("qc-qty-ng").value = q.qty_ng || 0;
    document.getElementById("qc-desc").value =
      q.defect_description || q.notes || "";

    document.getElementById("group-hasil-perbaikan").style.display = "block";
    document.getElementById("qc-hasil-perbaikan").value = "";

    document.getElementById("qc-metadata").style.display = "block";
    document.getElementById("meta-created-by").textContent =
      q.created_by_name || "-";
    document.getElementById("meta-updated-by").textContent =
      q.updated_by_name || "-";
    if (q.action_taken_by_name) {
      document.getElementById("meta-action-group").style.display = "block";
      document.getElementById("meta-action-by").textContent =
        q.action_taken_by_name;
    } else {
      document.getElementById("meta-action-group").style.display = "none";
    }

    Modal.open("qc-modal");
  }

  let isSaving = false;

  async function save() {
    if (isSaving) return;
    const body = {
      inspection_date: document.getElementById("qc-date").value,
      product_category_id: document.getElementById("qc-line").value,
      defect_category_id:
        parseInt(document.getElementById("qc-category").value) || null,
      defect_severity:
        parseInt(document.getElementById("qc-severity").value) || null,
      defect_description: document.getElementById("qc-desc").value.trim(),
      qty_total: parseInt(document.getElementById("qc-qty-total").value) || 0,
      qty_ng: parseInt(document.getElementById("qc-qty-ng").value) || 0,
      decision_action_id:
        parseInt(document.getElementById("qc-action").value) || null,
      notes: document.getElementById("qc-desc").value.trim(),
      hasil_perbaikan:
        document.getElementById("qc-hasil-perbaikan").value || null,
    };
    if (!body.product_category_id || !body.inspection_date) {
      Toast.warn("Kategori produk dan tanggal inspeksi wajib diisi");
      return;
    }
    if (body.qty_ng > body.qty_total) {
      Toast.warn(
        "QTY Defect (NG) tidak boleh lebih besar dari QTY Planning (Total).",
      );
      return;
    }

    isSaving = true;
    try {
      if (editing) await API.put(`/${apiBase}/api/qc-hold/${editing}`, body);
      else await API.post(`/${apiBase}/api/qc-hold`, body);
      Modal.close("qc-modal");
      Toast.success(
        editing ? "QC Hold diperbarui" : "QC Hold berhasil ditambahkan",
      );
      await load();
    } catch (e) {
      Toast.error(e.message);
    } finally {
      isSaving = false;
    }
  }

  async function del(id, code) {
    if (!(await confirmDelete(`Hapus QC Hold ${code}?`))) return;
    try {
      await API.delete(`/${apiBase}/api/qc-hold/${id}`);
      Toast.success("Berhasil dihapus");
      await load();
    } catch (e) {
      Toast.error(e.message);
    }
  }

  function applyFilters() {
    let filtered = allData;
    if (activeTab === "OPEN")
      filtered = filtered.filter((x) => x.status === "OPEN");
    else if (activeTab === "CLOSE")
      filtered = filtered.filter((x) => x.status === "CLOSE");
    render(filtered);
  }

  function setTab(tab) {
    activeTab = tab;
    document.querySelectorAll(".tab-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.tab === tab);
    });
    applyFilters();
  }

  function search(q) {
    const term = q.toLowerCase();
    const filtered = allData.filter(
      (x) =>
        (x.qc_code || "").toLowerCase().includes(term) ||
        (x.product_category || "").toLowerCase().includes(term),
    );
    render(filtered);
  }

  return { load, openCreate, openEdit, openView, save, del, setTab, search };
})();

//Users Page
window.UsersPage = (function () {
  let allUsers = [],
    editing = null;

  async function load() {
    try {
      allUsers = await API.get(`/${apiBase}/api/users`);
      render(allUsers);
    } catch (e) {
      Toast.error("Gagal memuat users: " + e.message);
    }
  }

  function render(users) {
    const tbody = document.querySelector("#users-table tbody");
    if (!tbody) return;
    if (!users.length) {
      tbody.innerHTML = `<tr><td colspan="7" class="table-empty"><div class="empty-state-icon"><i class="ri-user-line"></i></div>Belum ada user</td></tr>`;
      return;
    }
    tbody.innerHTML = users
      .map(
        (u) => `
      <tr>
        <td>${esc(u.nip || "-")}</td>
        <td class="fw-bold">${esc(u.username)}</td>
        <td>${esc(u.full_name || "-")}</td>
        <td style="word-break: break-all; min-width: 140px;">${esc(u.email || "-")}</td>
        <td><span class="badge badge-accent">${esc(u.role_name || u.role || "-")}</span></td>
        <td>${u.is_active ? '<span class="badge badge-success">Aktif</span>' : '<span class="badge badge-danger">Nonaktif</span>'}</td>
        <td>
          <div class="d-flex align-center gap-1">
            <button class="btn-icon" title="Edit" onclick="UsersPage.openEdit(${u.id})"><i class="ri-pencil-line"></i></button>
            <button class="btn-icon" title="Hapus" onclick="UsersPage.deleteUser(${u.id}, '${esc(u.username)}')"><i class="ri-delete-bin-line"></i></button>
          </div>
        </td>
      </tr>`,
      )
      .join("");
  }

  function openCreate() {
    editing = null;
    document.getElementById("user-modal-title").textContent = "Tambah User";
    document.getElementById("user-form").reset();
    document.getElementById("user-id").value = "";
    document.getElementById("pw-hint").textContent =
      "Wajib diisi untuk user baru";
    Modal.open("user-modal");
  }

  async function openEdit(id) {
    const u = allUsers.find((x) => x.id === id);
    if (!u) return;
    editing = id;
    document.getElementById("user-modal-title").textContent = "Edit User";
    document.getElementById("user-id").value = u.id;
    document.getElementById("user-fullname").value = u.full_name || "";
    document.getElementById("user-nip").value = u.nip || "";
    document.getElementById("user-username").value = u.username;
    document.getElementById("user-email").value = u.email;
    document.getElementById("user-role").value = u.role_id || "";
    document.getElementById("user-active").checked = u.is_active;
    document.getElementById("user-password").value = "";
    document.getElementById("pw-hint").textContent =
      "Kosongkan jika tidak ingin mengubah password";
    Modal.open("user-modal");
  }

  async function saveUser() {
    const payload = {
      full_name: document.getElementById("user-fullname").value.trim(),
      nip: document.getElementById("user-nip").value.trim(),
      username: document.getElementById("user-username").value.trim(),
      email: document.getElementById("user-email").value.trim(),
      role_id: parseInt(document.getElementById("user-role").value) || null,
      is_active: document.getElementById("user-active").checked,
      password: document.getElementById("user-password").value,
    };
    if (!payload.username || !payload.email) {
      Toast.warn("Username dan email wajib diisi");
      return;
    }
    if (!editing && !payload.password) {
      Toast.warn("Password wajib diisi untuk user baru");
      return;
    }
    try {
      if (editing) await API.put(`/${apiBase}/api/users/${editing}`, payload);
      else await API.post(`/${apiBase}/api/users`, payload);
      Modal.close("user-modal");
      Toast.success(
        editing ? "User berhasil diperbarui" : "User berhasil dibuat",
      );
      await load();
    } catch (e) {
      Toast.error(e.message);
    }
  }

  async function deleteUser(id, username) {
    if (!(await confirmDelete(`Hapus user "${username}"?`))) return;
    try {
      await API.delete(`/${apiBase}/api/users/${id}`);
      Toast.success("User berhasil dihapus");
      await load();
    } catch (e) {
      Toast.error(e.message);
    }
  }

  function search(q) {
    const filtered = allUsers.filter((u) =>
      (u.username + u.email + (u.full_name || "") + (u.nip || ""))
        .toLowerCase()
        .includes(q.toLowerCase()),
    );
    render(filtered);
  }

  return { load, openCreate, openEdit, saveUser, deleteUser, search };
})();

// Roles Page
window.RolesPage = (function () {
  let allRoles = [],
    editing = null;

  async function load() {
    try {
      allRoles = await API.get(`/${apiBase}/api/roles`);
      render(allRoles);
    } catch (e) {
      Toast.error("Gagal memuat roles: " + e.message);
    }
  }

  function render(roles) {
    const tbody = document.querySelector("#roles-table tbody");
    if (!tbody) return;
    if (!roles.length) {
      tbody.innerHTML = `<tr><td colspan="3" class="table-empty"><div class="empty-state-icon"><i class="ri-shield-user-line"></i></div>Belum ada role</td></tr>`;
      return;
    }
    tbody.innerHTML = roles
      .map(
        (r) => `
      <tr>
        <td><span class="badge badge-accent">${esc(r.name)}</span></td>
        <td>${esc(r.description || "-")}</td>
        <td><span class="badge badge-neutral">${r.user_count} user</span></td>
        <td>
          <div class="d-flex align-center gap-1">
            <button class="btn-icon" title="Edit" onclick="RolesPage.openEdit(${r.id})"><i class="ri-pencil-line"></i></button>
            <button class="btn-icon" title="Hapus" onclick="RolesPage.deleteRole(${r.id}, '${esc(r.name)}')"><i class="ri-delete-bin-line"></i></button>
          </div>
        </td>
      </tr>`,
      )
      .join("");
  }

  function openCreate() {
    editing = null;
    document.getElementById("role-modal-title").textContent = "Tambah Role";
    document.getElementById("role-form").reset();
    Modal.open("role-modal");
  }

  function openEdit(id) {
    const r = allRoles.find((x) => x.id === id);
    if (!r) return;
    editing = id;
    document.getElementById("role-modal-title").textContent = "Edit Role";
    document.getElementById("role-name").value = r.name;
    document.getElementById("role-desc").value = r.description || "";
    Modal.open("role-modal");
  }

  async function saveRole() {
    const body = {
      name: document.getElementById("role-name").value.trim(),
      description: document.getElementById("role-desc").value.trim(),
    };
    if (!body.name) {
      Toast.warn("Nama role wajib diisi");
      return;
    }
    try {
      if (editing) await API.put(`/${apiBase}/api/roles/${editing}`, body);
      else await API.post(`/${apiBase}/api/roles`, body);
      Modal.close("role-modal");
      Toast.success(editing ? "Role diperbarui" : "Role dibuat");
      await load();
    } catch (e) {
      Toast.error(e.message);
    }
  }

  async function deleteRole(id, name) {
    if (!(await confirmDelete(`Hapus role "${name}"?`))) return;
    try {
      await API.delete(`/${apiBase}/api/roles/${id}`);
      Toast.success("Role dihapus");
      await load();
    } catch (e) {
      Toast.error(e.message);
    }
  }

  return { load, openCreate, openEdit, saveRole, deleteRole };
})();

// Defect Categories Page
window.CatPage = (function () {
  let all = [],
    editing = null;

  async function load() {
    try {
      all = await API.get(`/${apiBase}/api/defect-categories`);
      render(all);
    } catch (e) {
      Toast.error(e.message);
    }
  }

  function render(items) {
    const tbody = document.querySelector("#cat-table tbody");
    if (!tbody) return;
    if (!items.length) {
      tbody.innerHTML = `<tr><td colspan="3" class="table-empty"><div class="empty-state-icon"><i class="ri-folder-line"></i></div>Belum ada kategori defect</td></tr>`;
      return;
    }
    tbody.innerHTML = items
      .map(
        (c) => `
      <tr>
        <td class="fw-bold">${esc(c.name)}</td>
        <td>${esc(c.description || "-")}</td>

        <td>
          <div class="d-flex align-center gap-1">
            <button class="btn-icon" onclick="CatPage.openEdit(${c.id})"><i class="ri-pencil-line"></i></button>
            <button class="btn-icon" onclick="CatPage.delete(${c.id}, '${esc(c.name)}')"><i class="ri-delete-bin-line"></i></button>
          </div>
        </td>
      </tr>`,
      )
      .join("");
  }

  function openCreate() {
    editing = null;
    document.getElementById("cat-modal-title").textContent =
      "Tambah Kategori Defect";
    document.getElementById("cat-form").reset();
    Modal.open("cat-modal");
  }

  function openEdit(id) {
    const c = all.find((x) => x.id === id);
    if (!c) return;
    editing = id;
    document.getElementById("cat-modal-title").textContent =
      "Edit Kategori Defect";
    document.getElementById("cat-name").value = c.name;
    document.getElementById("cat-desc").value = c.description || "";
    Modal.open("cat-modal");
  }

  async function save() {
    const body = {
      name: document.getElementById("cat-name").value.trim(),
      description: document.getElementById("cat-desc").value.trim(),
    };
    if (!body.name) {
      Toast.warn("Nama kategori wajib diisi");
      return;
    }
    try {
      if (editing)
        await API.put(`/${apiBase}/api/defect-categories/${editing}`, body);
      else await API.post(`/${apiBase}/api/defect-categories`, body);
      Modal.close("cat-modal");
      Toast.success(editing ? "Kategori diperbarui" : "Kategori dibuat");
      await load();
    } catch (e) {
      Toast.error(e.message);
    }
  }

  async function del(id, name) {
    if (!(await confirmDelete(`Hapus kategori "${name}"?`))) return;
    try {
      await API.delete(`/${apiBase}/api/defect-categories/${id}`);
      Toast.success("Kategori dihapus");
      await load();
    } catch (e) {
      Toast.error(e.message);
    }
  }

  return { load, openCreate, openEdit, save, del, delete: del };
})();

// Defect Types Page
window.TypePage = (function () {
  let all = [],
    categories = [],
    editing = null;

  async function load() {
    try {
      [all, categories] = await Promise.all([
        API.get(`/${apiBase}/api/defect-types`),
        API.get(`/${apiBase}/api/defect-categories`),
      ]);
      const sel = document.getElementById("filter-cat");
      if (sel) {
        sel.innerHTML =
          '<option value="">Semua Kategori</option>' +
          categories
            .map((c) => `<option value="${c.id}">${esc(c.name)}</option>`)
            .join("");
      }
      const msel = document.getElementById("type-cat");
      if (msel) {
        msel.innerHTML =
          '<option value="">-- Pilih Kategori --</option>' +
          categories
            .map((c) => `<option value="${c.id}">${esc(c.name)}</option>`)
            .join("");
      }
      render(all);
    } catch (e) {
      Toast.error(e.message);
    }
  }

  function render(items) {
    const tbody = document.querySelector("#type-table tbody");
    if (!tbody) return;
    if (!items.length) {
      tbody.innerHTML = `<tr><td colspan="3" class="table-empty"><div class="empty-state-icon"><i class="ri-search-eye-line"></i></div>Belum ada tipe defect</td></tr>`;
      return;
    }
    tbody.innerHTML = items
      .map(
        (t) => `
      <tr>
        <td class="fw-bold">${esc(t.name)}</td>
        <td><span class="badge badge-info">${esc(t.category_name || "-")}</span></td>
        <td>${esc(t.description || "-")}</td>
        <td>
          <div class="d-flex align-center gap-1">
            <button class="btn-icon" onclick="TypePage.openEdit(${t.id})"><i class="ri-pencil-line"></i></button>
            <button class="btn-icon" onclick="TypePage.delete(${t.id}, '${esc(t.name)}')"><i class="ri-delete-bin-line"></i></button>
          </div>
        </td>
      </tr>`,
      )
      .join("");
  }

  function filterByCat(catId) {
    const filtered = catId ? all.filter((t) => t.category_id == catId) : all;
    render(filtered);
  }

  function openCreate() {
    editing = null;
    document.getElementById("type-modal-title").textContent =
      "Tambah Tipe Defect";
    document.getElementById("type-form").reset();
    Modal.open("type-modal");
  }

  function openEdit(id) {
    const t = all.find((x) => x.id === id);
    if (!t) return;
    editing = id;
    document.getElementById("type-modal-title").textContent =
      "Edit Tipe Defect";
    document.getElementById("type-cat").value = t.category_id;
    document.getElementById("type-name").value = t.name;
    document.getElementById("type-desc").value = t.description || "";
    Modal.open("type-modal");
  }

  async function save() {
    const body = {
      category_id: parseInt(document.getElementById("type-cat").value),
      name: document.getElementById("type-name").value.trim(),
      description: document.getElementById("type-desc").value.trim(),
    };
    if (!body.category_id || !body.name) {
      Toast.warn("Kategori dan nama wajib diisi");
      return;
    }
    try {
      if (editing)
        await API.put(`/${apiBase}/api/defect-types/${editing}`, body);
      else await API.post(`/${apiBase}/api/defect-types`, body);
      Modal.close("type-modal");
      Toast.success(editing ? "Tipe diperbarui" : "Tipe dibuat");
      await load();
    } catch (e) {
      Toast.error(e.message);
    }
  }

  async function del(id, name) {
    if (!(await confirmDelete(`Hapus tipe defect "${name}"?`))) return;
    try {
      await API.delete(`/${apiBase}/api/defect-types/${id}`);
      Toast.success("Tipe dihapus");
      await load();
    } catch (e) {
      Toast.error(e.message);
    }
  }

  return { load, openCreate, openEdit, save, del, delete: del, filterByCat };
})();

// ── Decision Actions Page (Locked: REWORK, DISPOSISI, DISPOSAL) ─────────
window.ActionPage = (function () {
  let all = [];
  const colorMap = {
    REWORK: "badge-info",
    DISPOSISI: "badge-warning",
    DISPOSAL: "badge-danger",
  };

  async function load() {
    try {
      all = await API.get(`/` + apiBase + `/api/decision-actions`);
      render(all);
    } catch (e) {
      Toast.error(e.message);
    }
  }

  function render(items) {
    const tbody = document.querySelector("#action-table tbody");
    if (!tbody) return;
    if (!items.length) {
      tbody.innerHTML = `<tr><td colspan="5" class="table-empty"><div class="empty-state-icon"><i class="ri-focus-3-line"></i></div>Belum ada decision action</td></tr>`;
      return;
    }
    tbody.innerHTML = items
      .map((a) => {
        const isNo = (a.code || "").toUpperCase() === "DISPOSAL";
        const statusBadge = isNo
          ? '<span class="badge" style="background:#fee2e2;color:#b91c1c;border:1px solid #fca5a5;font-weight:700;">NO</span>'
          : '<span class="badge" style="background:#dcfce7;color:#15803d;border:1px solid #86efac;font-weight:700;">YES</span>';
        return `
      <tr>
        <td><span class="badge ${colorMap[a.code] || "badge-neutral"}">${esc(a.code)}</span></td>
        <td class="fw-bold">${esc(a.label)}</td>
        <td>${statusBadge}</td>
        <td>${esc(a.description || "—")}</td>
      </tr>`;
      })
      .join("");
  }

  function lockedNotice() {
    Toast.warn(
      "Decision Action dikunci (hanya REWORK, DISPOSISI, DISPOSAL). Tidak dapat ditambah, diubah, atau dihapus.",
    );
  }

  return {
    load,
    openCreate: lockedNotice,
    openEdit: lockedNotice,
    save: lockedNotice,
    del: lockedNotice,
    delete: lockedNotice,
  };
})();

// QC Hold Page
window.QcHoldPage = (function () {
  let allData = [];
  let editing = null;
  let activeTab = "OPEN";
  let defectTypes = [];

  async function load() {
    defectTypes = window._defectTypes || [];
    try {
      allData = await API.get(`/${apiBase}/api/qc-hold`);
      applyFilters();
    } catch (e) {
      Toast.error("Gagal memuat data QC Hold: " + e.message);
    }
  }

  const decisionColor = {
    REPAIR: "badge-info",
    REWORK: "badge-warning",
    DOWNGRADE: "badge-orange",
    DISPOSAL: "badge-danger",
  };
  function render(items) {
    const tbody = document.querySelector("#qc-table tbody");
    if (!tbody) return;
    if (!items.length) {
      tbody.innerHTML = `<tr><td colspan="9" class="table-empty"><div class="empty-state-icon"><i class="ri-clipboard-line"></i></div>Belum ada data QC Hold</td></tr>`;
      return;
    }
    tbody.innerHTML = items
      .map(
        (q) => `
      <tr>
        <td><span class="fw-bold">${esc(q.qc_code)}</span></td>
        <td class="text-small">${fmtDate(q.inspection_date)}</td>
        <td>
          <div class="fw-bold">${esc(q.product_category)}</div>
        </td>
        <td>
          <span class="badge badge-success">${q.qty_ok} OK</span>
          <span class="badge badge-danger">${q.qty_ng} NG</span>
        </td>
        <td>
          ${q.defect_category ? `<span class="badge badge-neutral">${esc(q.defect_category)}</span>` : "-"}
        </td>
            <button class="btn-icon" title="Hapus" onclick="QcHoldPage.del(${q.id}, '${esc(q.qc_code)}')"><i class="ri-delete-bin-line"></i></button>
          </div>
        </td>
      </tr>`,
      )
      .join("");
  }

  async function openCreate() {
    editing = null;
    document.getElementById("qc-modal-title").textContent = "Tambah QC Hold";
    document.getElementById("qc-form").reset();
    document.getElementById("qc-id").value = "";
    document.getElementById("qc-date").disabled = false;
    document.getElementById("qc-line").disabled = false;
    document.getElementById("qc-category").disabled = false;
    document.getElementById("qc-severity").disabled = false;
    document.getElementById("qc-qty-total").disabled = false;
    document.getElementById("qc-qty-ng").disabled = false;
    document.getElementById("qc-desc").disabled = false;
    await populateProductCatDropdowns();
    const now = new Date();
    now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
    document.getElementById("qc-date").value = now.toISOString().slice(0, 16);
    document.getElementById("group-hasil-perbaikan").style.display = "none";
    document.getElementById("qc-hasil-perbaikan").value = "";
    Modal.open("qc-modal");
  }

  async function openEdit(id) {
    const q = allData.find((x) => x.id === id);
    if (!q) return;
    editing = id;
    document.getElementById("qc-modal-title").textContent = "Edit QC Hold";
    if (userRole === "qc_line") {
      document.getElementById("qc-action-group").style.display = "none";
    } else {
      document.getElementById("qc-action-group").style.display = "block";
    }
    document.getElementById("qc-id").value = q.id;
    document.getElementById("qc-date").disabled = false;
    document.getElementById("qc-line").disabled = false;
    document.getElementById("qc-category").disabled = false;
    document.getElementById("qc-severity").disabled = false;
    document.getElementById("qc-qty-total").disabled = false;
    document.getElementById("qc-qty-ng").disabled = false;
    document.getElementById("qc-desc").disabled = false;
    await populateProductCatDropdowns();
    document.getElementById("qc-date").value = (q.inspection_date || "")
      .replace(" ", "T")
      .slice(0, 16);
    document.getElementById("qc-line").value = q.product_category_id || "";
    document.getElementById("qc-category").value = q.defect_category_id || "";
    document.getElementById("qc-severity").value = q.defect_severity || "";
    document.getElementById("qc-action").value = q.decision_action_id || "";
    document.getElementById("qc-qty-total").value = q.qty_total || 0;
    document.getElementById("qc-qty-ng").value = q.qty_ng || 0;
    document.getElementById("qc-desc").value =
      q.defect_description || q.notes || "";

    // Only show hasil_perbaikan if it's already decided to repair/rework and is OPEN
    // or just show it anytime we edit an OPEN case. The user requested:
    // "Untuk qchold status nya yang masih open, nanti ada button edit, diform edit itu nanti ada pilihan lagi, produk sudah diperbaiki"
    document.getElementById("group-hasil-perbaikan").style.display = "block";
    document.getElementById("qc-hasil-perbaikan").value = "";

    Modal.open("qc-modal");
  }

  let isSaving = false;

  async function save() {
    if (isSaving) return;
    const body = {
      inspection_date: document.getElementById("qc-date").value,
      product_category_id: document.getElementById("qc-line").value,
      defect_category_id:
        parseInt(document.getElementById("qc-category").value) || null,
      defect_severity:
        parseInt(document.getElementById("qc-severity").value) || null,
      defect_description: document.getElementById("qc-desc").value.trim(),
      qty_total: parseInt(document.getElementById("qc-qty-total").value) || 0,
      qty_ng: parseInt(document.getElementById("qc-qty-ng").value) || 0,
      decision_action_id:
        parseInt(document.getElementById("qc-action").value) || null,
      notes: document.getElementById("qc-desc").value.trim(),
      hasil_perbaikan:
        document.getElementById("qc-hasil-perbaikan").value || null,
    };
    if (!body.product_category_id || !body.inspection_date) {
      Toast.warn("Kategori produk dan tanggal inspeksi wajib diisi");
      return;
    }
    if (body.qty_ng > body.qty_total) {
      Toast.warn(
        "QTY Defect (NG) tidak boleh lebih besar dari QTY Planning (Total).",
      );
      return;
    }

    isSaving = true;
    try {
      if (editing) await API.put(`/${apiBase}/api/qc-hold/${editing}`, body);
      else await API.post(`/${apiBase}/api/qc-hold`, body);
      Modal.close("qc-modal");
      Toast.success(
        editing ? "QC Hold diperbarui" : "QC Hold berhasil ditambahkan",
      );
      await load();
    } catch (e) {
      Toast.error(e.message);
    } finally {
      isSaving = false;
    }
  }

  async function del(id, code) {
    if (!(await confirmDelete(`Hapus data QC Hold "${code}"?`))) return;
    try {
      await API.delete(`/${apiBase}/api/qc-hold/${id}`);
      Toast.success("QC Hold dihapus");
      await load();
    } catch (e) {
      Toast.error(e.message);
    }
  }

  function setTab(tab) {
    activeTab = tab;

    const tOpen = document.getElementById("tab-open");
    if (tOpen) {
      tOpen.className = "tab-btn" + (tab === "OPEN" ? " active" : "");
      tOpen.style.borderBottom =
        tab === "OPEN" ? "2px solid var(--accent)" : "2px solid transparent";
      tOpen.style.color =
        tab === "OPEN" ? "var(--text-primary)" : "var(--text-secondary)";
    }

    const tClose = document.getElementById("tab-close");
    if (tClose) {
      tClose.className = "tab-btn" + (tab === "CLOSE" ? " active" : "");
      tClose.style.borderBottom =
        tab === "CLOSE" ? "2px solid var(--accent)" : "2px solid transparent";
      tClose.style.color =
        tab === "CLOSE" ? "var(--text-primary)" : "var(--text-secondary)";
    }

    applyFilters();
  }

  function applyFilters() {
    let filtered = allData.filter((d) => (d.status || "CLOSE") === activeTab);

    const dateEl = document.getElementById("filter-date");
    if (dateEl && dateEl.value) {
      const selectedDate = dateEl.value;
      filtered = filtered.filter((d) =>
        (d.inspection_date || "").startsWith(selectedDate),
      );
    }

    const catEl = document.getElementById("filter-category");
    if (catEl && catEl.value) {
      filtered = filtered.filter((d) => d.defect_category_id == catEl.value);
    }

    render(filtered);
  }

  return { load, openCreate, openEdit, save, del, applyFilters, setTab };
})();

// Dataset Page
window.DatasetPage = (function () {
  let allDatasets = [],
    currentType = "TRAIN",
    currentDatasetId = null,
    currentEvalDatasetId = null,
    currentEvalDatasetName = "",
    availableCache = [],
    lastEvalResult = null,
    overfitChartInstance = null;

  const SEV_MAP = {
    1: { label: "LOW", cls: "badge-success" },
    2: { label: "MEDIUM", cls: "badge-warning" },
    3: { label: "HIGH", cls: "badge-danger" },
  };

  function sourceBadge(r) {
    if (r.source === "QC_HOLD" || r.qc_hold_id) {
      return '<span class="badge badge-neutral" style="font-size:10px;" title="Disalin dari data QC Hold">QC Hold</span>';
    } else if (r.source === "SPLIT") {
      return '<span class="badge badge-neutral" style="font-size:10px;" title="Hasil split dataset">Split</span>';
    } else {
      return '<span class="badge badge-neutral" style="font-size:10px;" title="Diunggah dari file">Upload</span>';
    }
  }

  function init(type) {
    currentType = type;
    load();
  }

  async function load() {
    try {
      allDatasets = await API.get(
        `/${apiBase}/api/datasets?type=${currentType}`,
      );
      render(allDatasets);
    } catch (e) {
      Toast.error("Gagal memuat datasets: " + e.message);
    }
  }

  function render(items) {
    const tbody = document.querySelector("#dataset-table tbody");
    if (!tbody) return;
    const icon =
      currentType === "TRAIN" ? "ri-database-2-line" : "ri-test-tube-line";
    const colSpan = currentType === "TEST" ? 6 : 5;

    if (!items.length) {
      tbody.innerHTML = `<tr><td colspan="${colSpan}" class="table-empty"><div class="empty-state-icon"><i class="${icon}"></i></div>Belum ada dataset ${currentType === "TEST" ? "testing. Gunakan tombol Auto-Generate Test Set atau Buat Dataset Testing." : "training."}</td></tr>`;
      return;
    }

    tbody.innerHTML = items
      .map((d) => {
        let purityCol = "";
        if (currentType === "TEST") {
          const total = d.labeled_count || d.record_count || 0;
          const unseen = d.unseen_count !== undefined ? d.unseen_count : total;
          const overlap = d.overlap_count || 0;
          if (total === 0) {
            purityCol = `<td><span class="badge badge-neutral">Kosong (0 sampel)</span></td>`;
          } else if (overlap === 0) {
            purityCol = `<td><span class="badge badge-success" title="Tidak ada tumpang tindih dengan Dataset Training model aktif"><i class="ri-shield-check-line"></i> 100% Unseen (${unseen} sampel)</span></td>`;
          } else {
            const pct = Math.round((unseen / total) * 100);
            purityCol = `<td>
              <span class="badge badge-warning" title="${overlap} sampel juga terdapat pada Dataset Training model aktif">
                <i class="ri-alert-line"></i> ${pct}% Unseen (${overlap} Overlap)
              </span>
            </td>`;
          }
        }

        return `
      <tr>
        <td class="fw-bold">${esc(d.name)}</td>
        <td>${esc(d.description || "-")}</td>
        <td>
          <span class="badge badge-accent">${d.record_count} record</span>
          ${d.labeled_count !== undefined && d.labeled_count !== d.record_count ? `<span class="text-small text-muted">(${d.labeled_count} berlabel)</span>` : ""}
        </td>
        ${purityCol}
        <td class="text-muted text-small">${fmtDate(d.created_at)}</td>
        <td>
          <div class="d-flex align-center gap-1">
            ${
              currentType === "TEST"
                ? `<button class="btn btn-sm btn-primary" onclick="DatasetPage.evaluateModel(${d.id}, '${esc(d.name)}')"><i class="ri-scales-3-line"></i> Evaluasi & Uji Model</button>`
                : ""
            }
            <button class="btn btn-sm btn-secondary" onclick="DatasetPage.viewRecords(${d.id}, '${esc(d.name)}')"><i class="ri-list-check-2"></i> Records</button>
            <button class="btn-icon" title="Hapus" style="color:var(--danger)" onclick="DatasetPage.del(${d.id}, '${esc(d.name)}')"><i class="ri-delete-bin-line"></i></button>
          </div>
        </td>
      </tr>`;
      })
      .join("");
  }

  function openCreate() {
    document.getElementById("dataset-modal-title").textContent =
      currentType === "TRAIN"
        ? "Buat Dataset Training"
        : "Buat Dataset Testing";
    document.getElementById("dataset-form").reset();
    Modal.open("dataset-modal");
  }

  async function save() {
    const body = {
      name: document.getElementById("ds-name").value.trim(),
      type: currentType,
      description: document.getElementById("ds-desc").value.trim(),
    };
    if (!body.name) {
      Toast.warn("Nama dataset wajib diisi");
      return;
    }
    try {
      await API.post(`/${apiBase}/api/datasets`, body);
      Modal.close("dataset-modal");
      Toast.success("Dataset berhasil dibuat");
      await load();
    } catch (e) {
      Toast.error(e.message);
    }
  }

  function openGenerateTest() {
    const form = document.getElementById("generate-test-form");
    if (form) form.reset();
    onGenerateModeChange();
    Modal.open("generate-test-modal");
  }

  function onGenerateModeChange() {
    const mode = document.getElementById("gen-ds-mode")?.value || "unseen";
    const splitBox = document.getElementById("gen-split-options");
    const helpEl = document.getElementById("gen-mode-help");
    if (mode === "split") {
      if (splitBox) splitBox.style.display = "block";
      if (helpEl)
        helpEl.textContent =
          "Membagi sebagian data secara proporsional per kelas keputusan (Stratified) dari Dataset Training acuan.";
    } else {
      if (splitBox) splitBox.style.display = "none";
      if (helpEl)
        helpEl.textContent =
          "Mengambil data QC Hold berlabel keputusan yang belum pernah masuk ke Dataset Training acuan (0% overlap).";
    }
  }

  async function submitGenerateTest() {
    const name = document.getElementById("gen-ds-name")?.value.trim();
    if (!name) {
      Toast.warn("Nama Dataset Testing baru wajib diisi");
      return;
    }
    const mode = document.getElementById("gen-ds-mode")?.value || "unseen";
    const sourceTrainId =
      document.getElementById("gen-source-train")?.value || null;
    const splitRatio = parseFloat(
      document.getElementById("gen-split-ratio")?.value || "0.25",
    );
    const removeFromTrain =
      document.getElementById("gen-remove-train")?.checked ?? true;
    const description = document.getElementById("gen-ds-desc")?.value.trim();

    const btn = document.getElementById("btn-submit-generate");
    const oldHtml = btn ? btn.innerHTML : "";
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<i class="ri-loader-4-line ri-spin"></i> Memproses...';
    }

    try {
      const res = await API.post(`/${apiBase}/api/datasets/generate-test`, {
        name,
        mode,
        source_train_id: sourceTrainId || null,
        split_ratio: splitRatio,
        remove_from_train: removeFromTrain,
        description,
      });
      Modal.close("generate-test-modal");
      Toast.success(res.message || "Dataset Testing berhasil dibuat");
      await load();
      if (res.dataset && res.dataset.id) {
        await evaluateModel(res.dataset.id, res.dataset.name);
      }
    } catch (e) {
      Toast.error(e.message);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = oldHtml;
      }
    }
  }

  async function del(id, name) {
    if (
      !(await confirmDelete(`Hapus dataset "${name}" beserta semua recordnya?`))
    )
      return;
    try {
      await API.delete(`/${apiBase}/api/datasets/${id}`);
      Toast.success("Dataset dihapus");
      if (currentEvalDatasetId === id) {
        const panel = document.getElementById("evaluation-result-panel");
        if (panel) panel.style.display = "none";
      }
      await load();
    } catch (e) {
      Toast.error(e.message);
    }
  }

  async function viewRecords(id, name) {
    currentDatasetId = id;
    const titleEl = document.getElementById("records-modal-title");
    if (titleEl) titleEl.textContent = `Records: ${name}`;
    try {
      const records = await API.get(`/${apiBase}/api/datasets/${id}/records`);
      const tbody = document.querySelector("#records-table tbody");
      const thCount = document.querySelectorAll(
        "#records-table thead th",
      ).length;
      const summaryEl = document.getElementById("records-modal-summary");

      if (summaryEl) {
        const unseenCount = records.filter((r) => !r.in_active_train).length;
        summaryEl.innerHTML = `Total: <strong>${records.length}</strong> record ${currentType === "TEST" ? `| Unseen: <strong>${unseenCount}</strong>` : ""}`;
      }

      if (!records.length) {
        tbody.innerHTML = `<tr><td colspan="${thCount || 5}" class="table-empty">Belum ada record dalam dataset ini. Klik "Tambah Record Manual" atau "Upload Excel/CSV".</td></tr>`;
      } else if (thCount >= 7) {
        tbody.innerHTML = records
          .map((r) => {
            const sev = SEV_MAP[r.defect_severity || 1] || SEV_MAP[1];
            const unseenBadge = r.in_active_train
              ? `<span class="badge badge-warning" title="Record ini juga ada di Dataset Training model aktif">Overlap Train</span>`
              : `<span class="badge badge-success">Unseen</span>`;
            return `
          <tr>
            <td class="fw-bold">${esc(r.record_code || r.qc_code)} ${sourceBadge(r)}</td>
            <td>${esc(r.product_category || "-")}</td>
            <td>${esc(r.defect_category || "-")}</td>
            <td><span class="badge ${sev.cls}">${sev.label}</span></td>
            <td>${r.decision_action ? `<span class="badge badge-accent">${esc(r.decision_action)}</span>` : '<span class="text-muted">-</span>'}</td>
            <td>${unseenBadge}</td>
            <td><button class="btn-icon" title="Keluarkan dari dataset" onclick="DatasetPage.removeRecord(${r.dataset_record_id})"><i class="ri-delete-bin-line"></i></button></td>
          </tr>`;
          })
          .join("");
      } else {
        tbody.innerHTML = records
          .map(
            (r) => `
          <tr>
            <td class="fw-bold">${esc(r.record_code || r.qc_code)} ${sourceBadge(r)}</td>
            <td>${esc(r.product_category || "-")}</td>
            <td>${esc(r.defect_category || "")}</td>
            <td>${r.decision_action ? `<span class="badge badge-accent">${esc(r.decision_action)}</span>` : ""}</td>
            <td><button class="btn-icon" onclick="DatasetPage.removeRecord(${r.dataset_record_id})"><i class="ri-delete-bin-line"></i></button></td>
          </tr>`,
          )
          .join("");
      }
      Modal.open("records-modal");
    } catch (e) {
      Toast.error(e.message);
    }
  }

  async function openAddRecords() {
    try {
      availableCache = await API.get(
        `/${apiBase}/api/qc-hold-available?dataset_id=${currentDatasetId}`,
      );
      const filterCb = document.getElementById("filter-unseen-only");
      if (filterCb && currentType === "TEST") {
        filterCb.checked = true;
      }
      renderAvailableRecords();
      Modal.open("add-records-modal");
    } catch (e) {
      Toast.error(e.message);
    }
  }

  function renderAvailableRecords() {
    const tbody = document.querySelector("#available-table tbody");
    if (!tbody) return;
    const thCount = document.querySelectorAll(
      "#available-table thead th",
    ).length;
    const filterUnseen =
      document.getElementById("filter-unseen-only")?.checked || false;

    const list = filterUnseen
      ? availableCache.filter((r) => !r.in_active_train)
      : availableCache;

    if (!list.length) {
      tbody.innerHTML = `<tr><td colspan="${thCount || 5}" class="table-empty">${filterUnseen ? "Tidak ada data Unseen yang tersisa. Matikan filter 'Hanya tampilkan Unseen Data' untuk melihat semua data." : "Semua data QC Hold berlabel sudah ada dalam dataset ini."}</td></tr>`;
    } else if (thCount >= 7) {
      tbody.innerHTML = list
        .map((r) => {
          const sev = SEV_MAP[r.defect_severity || 1] || SEV_MAP[1];
          const statusBadge = r.in_active_train
            ? `<span class="badge badge-warning">Ada di Train</span>`
            : `<span class="badge badge-success">Unseen</span>`;
          return `
        <tr>
          <td><input type="checkbox" value="${r.id}" class="record-check"></td>
          <td class="fw-bold">${esc(r.qc_code)}</td>
          <td>${esc(r.product_category || r.part_no || "-")}</td>
          <td>${esc(r.defect_category || "-")}</td>
          <td><span class="badge ${sev.cls}">${sev.label}</span></td>
          <td>${r.decision_action ? `<span class="badge badge-accent">${esc(r.decision_action)}</span>` : "-"}</td>
          <td>${statusBadge}</td>
        </tr>`;
        })
        .join("");
    } else {
      tbody.innerHTML = list
        .map(
          (r) => `
        <tr>
          <td><input type="checkbox" value="${r.id}" class="record-check"></td>
          <td class="fw-bold">${esc(r.qc_code)}</td>
          <td>${esc(r.product_category || r.part_no || "-")}</td>
          <td>${esc(r.defect_category || "-")}</td>
          <td>${r.decision_action ? `<span class="badge badge-accent">${esc(r.decision_action)}</span>` : "-"}</td>
        </tr>`,
        )
        .join("");
    }

    const selectAll = document.getElementById("select-all-records");
    if (selectAll) {
      selectAll.checked = false;
      selectAll.onchange = () => {
        document
          .querySelectorAll(".record-check")
          .forEach((cb) => (cb.checked = selectAll.checked));
      };
    }
  }

  async function addSelectedRecords() {
    const ids = [...document.querySelectorAll(".record-check:checked")].map(
      (cb) => parseInt(cb.value),
    );
    if (!ids.length) {
      Toast.warn("Pilih minimal satu record");
      return;
    }
    try {
      await API.post(
        `/${apiBase}/api/datasets/${currentDatasetId}/add-records`,
        { qc_hold_ids: ids },
      );
      Modal.close("add-records-modal");
      Toast.success(`${ids.length} record ditambahkan ke dataset`);
      await load();
      const ds = allDatasets.find((d) => d.id === currentDatasetId);
      if (ds) viewRecords(currentDatasetId, ds.name);
    } catch (e) {
      Toast.error(e.message);
    }
  }

  async function removeRecord(recordId) {
    if (!(await confirmDelete("Hapus record ini dari dataset?"))) return;
    try {
      await API.post(
        `/${apiBase}/api/datasets/${currentDatasetId}/remove-records`,
        { record_ids: [recordId] },
      );
      Toast.success("Record dihapus dari dataset");
      await load();
      const ds = allDatasets.find((d) => d.id === currentDatasetId);
      if (ds) viewRecords(currentDatasetId, ds.name);
    } catch (e) {
      Toast.error(e.message);
    }
  }

  function openUpload() {
    if (!currentDatasetId) return;
    const fileInput = document.getElementById("upload-file");
    if (fileInput) fileInput.value = "";
    Modal.open("upload-modal");
  }

  function uploadFile() {
    if (!currentDatasetId) return;
    const fileInput = document.getElementById("upload-file");
    if (!fileInput || fileInput.files.length === 0) {
      Toast.warn("Pilih file terlebih dahulu");
      return;
    }
    const file = fileInput.files[0];
    const formData = new FormData();
    formData.append("file", file);

    const btn = document.querySelector("#upload-modal .btn-primary");
    const oldHtml = btn.innerHTML;
    btn.innerHTML = '<i class="ri-loader-4-line ri-spin"></i> Uploading...';
    btn.disabled = true;

    fetch(`/${apiBase}/api/datasets/${currentDatasetId}/upload`, {
      method: "POST",
      body: formData,
    })
      .then((res) => res.json())
      .then(async (data) => {
        if (data.error) throw new Error(data.error);
        Toast.success(data.message || "File berhasil diunggah");
        Modal.close("upload-modal");
        await load();
        const ds = allDatasets.find((d) => d.id === currentDatasetId);
        if (ds) viewRecords(currentDatasetId, ds.name);
      })
      .catch((err) => Toast.error(err.message))
      .finally(() => {
        btn.innerHTML = oldHtml;
        btn.disabled = false;
      });
  }

  async function reEvaluateCurrent() {
    if (!currentEvalDatasetId) {
      Toast.warn("Pilih Dataset Testing terlebih dahulu.");
      return;
    }
    await evaluateModel(currentEvalDatasetId, currentEvalDatasetName);
  }

  async function evaluateModel(id, name) {
    currentEvalDatasetId = id;
    currentEvalDatasetName = name;
    const modelSelect = document.getElementById("eval-model-select");
    const selectedModelId = modelSelect ? modelSelect.value : null;

    try {
      Toast.show(
        `Menguji kualitas model & generalisasi pada "${name}"...`,
        "info",
        2000,
      );
      const res = await API.post(`/${apiBase}/api/models/evaluate`, {
        dataset_id: id,
        model_id: selectedModelId ? parseInt(selectedModelId) : null,
      });

      lastEvalResult = res;
      renderEvaluationReport(res);
      Toast.success(
        `Evaluasi selesai! Akurasi Test: ${(res.accuracy * 100).toFixed(1)}% (${res.overfitting?.label || "OK"})`,
      );
    } catch (e) {
      Toast.error("Evaluasi gagal: " + e.message);
    }
  }

  function renderEvaluationReport(res) {
    const panel = document.getElementById("evaluation-result-panel");
    if (!panel) return;

    // 1. Subtitle Header
    const subEl = document.getElementById("eval-header-subtitle");
    if (subEl && res.model && res.dataset) {
      subEl.innerHTML = `
        Model: <strong>${esc(res.model.name)}</strong> ${res.model.is_active ? '<span class="badge badge-success" style="font-size:10px;">AKTIF</span>' : ""}
        &nbsp;|&nbsp; Dataset Training Asal: <strong>${esc(res.model.train_dataset_name)}</strong> (${res.model.train_support || 0} sampel)
        &nbsp;|&nbsp; Dataset Testing: <strong>${esc(res.dataset.name)}</strong> (${res.total_tested} sampel diuji)
      `;
    }

    // 2. Overfitting & Generalization Diagnostic Banner
    const bannerEl = document.getElementById("eval-diagnostic-banner");
    if (bannerEl && res.overfitting) {
      const ov = res.overfitting;
      const colorMap = {
        success: {
          bg: "rgba(63,185,80,0.1)",
          border: "rgba(63,185,80,0.35)",
          color: "var(--success)",
          icon: "ri-shield-check-fill",
        },
        warning: {
          bg: "rgba(210,153,34,0.1)",
          border: "rgba(210,153,34,0.35)",
          color: "var(--warning)",
          icon: "ri-error-warning-fill",
        },
        danger: {
          bg: "rgba(248,81,73,0.1)",
          border: "rgba(248,81,73,0.35)",
          color: "var(--danger)",
          icon: "ri-alarm-warning-fill",
        },
      };
      const st = colorMap[ov.badge] || colorMap.success;
      const recsHtml = (ov.recommendations || [])
        .map((r) => `<li style="margin-bottom:4px;">${esc(r)}</li>`)
        .join("");

      bannerEl.style.background = st.bg;
      bannerEl.innerHTML = `
        <div style="display:flex; gap:14px; align-items:flex-start;">
          <div style="font-size:28px; color:${st.color}; line-height:1;"><i class="${st.icon}"></i></div>
          <div style="flex:1;">
            <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:6px;">
              <span style="font-size:15px; font-weight:800; color:${st.color};">${esc(ov.label)}</span>
              <span class="badge badge-${ov.badge}">Gap Akurasi: ${(ov.acc_gap * 100 >= 0 ? "+" : "") + (ov.acc_gap * 100).toFixed(1)}%</span>
              <span class="badge badge-neutral">Skor Generalisasi: ${res.generalization?.generalization_score ?? 0}/100</span>
            </div>
            <div style="font-size:13px; color:var(--text-primary); margin-bottom:8px; line-height:1.5;">
              ${esc(ov.summary)}
            </div>
            ${
              recsHtml
                ? `<div style="font-size:12px; color:var(--text-secondary);">
                    <strong style="color:var(--text-primary);"><i class="ri-lightbulb-flash-line"></i> Rekomendasi Teknis:</strong>
                    <ul style="margin:4px 0 0 18px; padding:0;">${recsHtml}</ul>
                  </div>`
                : ""
            }
          </div>
        </div>
      `;
    }

    // 3. 6 KPI Cards
    const kpiGrid = document.getElementById("eval-kpi-grid");
    if (kpiGrid) {
      const testAcc = (res.accuracy * 100).toFixed(1);
      const testF1 = (res.f1_score * 100).toFixed(1);
      const testPrec = (res.precision * 100).toFixed(1);
      const testRec = (res.recall * 100).toFixed(1);
      const gapAcc = ((res.overfitting?.acc_gap || 0) * 100).toFixed(1);
      const gapColor =
        Math.abs(res.overfitting?.acc_gap || 0) <= 0.08
          ? "var(--success)"
          : Math.abs(res.overfitting?.acc_gap || 0) <= 0.15
            ? "var(--warning)"
            : "var(--danger)";
      const gen = res.generalization || {};
      const unseenAcc = ((gen.unseen_accuracy ?? res.accuracy) * 100).toFixed(
        1,
      );

      kpiGrid.innerHTML = `
        <div class="stat-card" style="--stat-color:var(--accent);--stat-soft:var(--accent-soft);">
          <div class="stat-icon"><i class="ri-focus-2-line"></i></div>
          <div>
            <div class="stat-value">${testAcc}%</div>
            <div class="stat-label">Akurasi Testing</div>
            <div class="text-small text-muted">${res.correct_count}/${res.total_tested} tepat</div>
          </div>
        </div>
        <div class="stat-card" style="--stat-color:var(--success);--stat-soft:var(--success-soft);">
          <div class="stat-icon"><i class="ri-medal-line"></i></div>
          <div>
            <div class="stat-value">${testF1}%</div>
            <div class="stat-label">F1-Score (Weighted)</div>
            <div class="text-small text-muted">Macro F1: ${((res.test_metrics?.f1_macro || 0) * 100).toFixed(1)}%</div>
          </div>
        </div>
        <div class="stat-card" style="--stat-color:var(--info);--stat-soft:var(--info-soft);">
          <div class="stat-icon"><i class="ri-crosshair-2-line"></i></div>
          <div>
            <div class="stat-value">${testPrec}% / ${testRec}%</div>
            <div class="stat-label">Precision / Recall</div>
            <div class="text-small text-muted">Kualitas Klasifikasi</div>
          </div>
        </div>
        <div class="stat-card" style="--stat-color:${gapColor};--stat-soft:rgba(255,255,255,0.05);">
          <div class="stat-icon"><i class="ri-scales-line"></i></div>
          <div>
            <div class="stat-value" style="color:${gapColor}">${gapAcc > 0 ? "+" : ""}${gapAcc}%</div>
            <div class="stat-label">Generalization Gap</div>
            <div class="text-small text-muted">Train ${(res.train_metrics.accuracy * 100).toFixed(1)}% vs Test ${testAcc}%</div>
          </div>
        </div>
        <div class="stat-card" style="--stat-color:var(--purple);--stat-soft:var(--purple-soft);">
          <div class="stat-icon"><i class="ri-shield-flash-line"></i></div>
          <div>
            <div class="stat-value">${unseenAcc}%</div>
            <div class="stat-label">Akurasi Murni Unseen</div>
            <div class="text-small text-muted">${gen.unseen_count || 0} unseen (${gen.unseen_ratio || 0}%)</div>
          </div>
        </div>
        <div class="stat-card" style="--stat-color:var(--orange);--stat-soft:var(--orange-soft);">
          <div class="stat-icon"><i class="ri-speed-up-line"></i></div>
          <div>
            <div class="stat-value">${gen.avg_confidence || 100}%</div>
            <div class="stat-label">Rata-rata Confidence</div>
            <div class="text-small text-muted">Skor Generalisasi: ${gen.generalization_score || 0}%</div>
          </div>
        </div>
      `;
    }

    // 4. Overfitting Chart (Train vs Test) & Gap Table
    renderOverfitChartAndTable(res);

    // 5. Confusion Matrix & Tree Complexity
    renderConfusionMatrixAndTree(res);

    // 6. Per-Class Metrics Table
    renderPerClassTable(res.class_report || []);

    // 7. Record-by-Record Prediction Details Table
    filterPredictions("ALL");

    panel.style.display = "block";
    panel.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function renderOverfitChartAndTable(res) {
    const tr = res.train_metrics || {};
    const te = res.test_metrics || {};
    const ov = res.overfitting || {};

    const labels = ["Accuracy", "Precision", "Recall", "F1-Score"];
    const trainVals = [
      ((tr.accuracy || 0) * 100).toFixed(1),
      ((tr.precision || 0) * 100).toFixed(1),
      ((tr.recall || 0) * 100).toFixed(1),
      ((tr.f1_score || 0) * 100).toFixed(1),
    ];
    const testVals = [
      ((te.accuracy || 0) * 100).toFixed(1),
      ((te.precision || 0) * 100).toFixed(1),
      ((te.recall || 0) * 100).toFixed(1),
      ((te.f1_score || 0) * 100).toFixed(1),
    ];

    const canvas = document.getElementById("eval-overfit-chart");
    if (canvas && typeof Chart !== "undefined") {
      if (overfitChartInstance) overfitChartInstance.destroy();
      overfitChartInstance = new Chart(canvas, {
        type: "bar",
        data: {
          labels,
          datasets: [
            {
              label: "Training (%)",
              data: trainVals,
              backgroundColor: "#2f81f7",
              borderRadius: 6,
            },
            {
              label: "Testing (%)",
              data: testVals,
              backgroundColor: "#3fb950",
              borderRadius: 6,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: {
              position: "top",
              labels: { color: "#e6edf3", font: { size: 12 } },
            },
            datalabels: {
              color: "#fff",
              font: { weight: "bold", size: 10 },
              formatter: (v) => v + "%",
              anchor: "end",
              align: "start",
              offset: -18,
            },
          },
          scales: {
            x: {
              grid: { color: "rgba(255,255,255,0.04)" },
              ticks: { color: "#8b949e" },
            },
            y: {
              min: 0,
              max: 105,
              grid: { color: "rgba(255,255,255,0.04)" },
              ticks: { color: "#8b949e", callback: (v) => v + "%" },
            },
          },
        },
      });
    }

    const gapTbody = document.querySelector("#eval-gap-table tbody");
    if (gapTbody) {
      const rows = [
        { name: "Accuracy", tr: tr.accuracy, te: te.accuracy, gap: ov.acc_gap },
        {
          name: "Precision",
          tr: tr.precision,
          te: te.precision,
          gap: ov.prec_gap,
        },
        { name: "Recall", tr: tr.recall, te: te.recall, gap: ov.rec_gap },
        { name: "F1-Score", tr: tr.f1_score, te: te.f1_score, gap: ov.f1_gap },
      ];
      gapTbody.innerHTML = rows
        .map((r) => {
          const gPct = (r.gap || 0) * 100;
          let badge = `<span class="badge badge-success">Stabil / Good Fit</span>`;
          if (gPct > 15) {
            badge = `<span class="badge badge-danger">Overfitting Tinggi</span>`;
          } else if (gPct > 8) {
            badge = `<span class="badge badge-warning">Overfitting Ringan</span>`;
          } else if ((r.tr || 0) < 0.65 && (r.te || 0) < 0.65) {
            badge = `<span class="badge badge-warning">Underfitting</span>`;
          }
          return `
            <tr>
              <td class="fw-bold">${r.name}</td>
              <td>${((r.tr || 0) * 100).toFixed(2)}%</td>
              <td class="fw-bold">${((r.te || 0) * 100).toFixed(2)}%</td>
              <td style="color:${gPct > 8 ? "var(--danger)" : "var(--success)"}; font-weight:600;">
                ${gPct >= 0 ? "+" : ""}${gPct.toFixed(2)}%
              </td>
              <td>${badge}</td>
            </tr>
          `;
        })
        .join("");
    }
  }

  function renderConfusionMatrixAndTree(res) {
    const cmWrap = document.getElementById("eval-confusion-matrix-wrap");
    if (cmWrap && res.confusion_matrix) {
      const labels = res.confusion_matrix.labels || [];
      const matrix = res.confusion_matrix.matrix || [];

      let ths = labels
        .map(
          (l) =>
            `<th style="text-align:center; background:var(--bg-elevated); font-size:11px;">Pred:<br><strong>${esc(l)}</strong></th>`,
        )
        .join("");

      let trs = matrix
        .map((row, rIdx) => {
          const rowSum = row.reduce((a, b) => a + b, 0);
          const cells = row
            .map((val, cIdx) => {
              const isDiag = rIdx === cIdx;
              const pct =
                rowSum > 0 ? ((val / rowSum) * 100).toFixed(0) + "%" : "0%";
              const bg =
                val === 0
                  ? "transparent"
                  : isDiag
                    ? "rgba(63,185,80,0.22)"
                    : "rgba(248,81,73,0.20)";
              const border = isDiag
                ? "1px solid rgba(63,185,80,0.45)"
                : val > 0
                  ? "1px solid rgba(248,81,73,0.4)"
                  : "1px solid var(--border)";
              const color = isDiag
                ? "#3fb950"
                : val > 0
                  ? "#f85149"
                  : "var(--text-muted)";

              return `<td style="text-align:center; background:${bg}; border:${border}; padding:10px;">
                <div style="font-size:15px; font-weight:800; color:${color};">${val}</div>
                <div style="font-size:10px; color:var(--text-secondary);">${pct}</div>
              </td>`;
            })
            .join("");

          return `<tr>
            <td style="background:var(--bg-elevated); font-size:11px; font-weight:700; white-space:nowrap;">
              Aktual: ${esc(labels[rIdx])} <span class="text-muted">(${rowSum})</span>
            </td>
            ${cells}
          </tr>`;
        })
        .join("");

      cmWrap.innerHTML = `
        <div style="font-size:12px; font-weight:600; color:var(--text-secondary); margin-bottom:8px;">
          Matriks Kebingungan (Diagonal Hijau = Prediksi Benar, Merah = Meleset)
        </div>
        <table style="border-collapse:collapse; width:100%;">
          <thead>
            <tr>
              <th style="background:var(--bg-elevated); font-size:11px;">Aktual \\ Prediksi</th>
              ${ths}
            </tr>
          </thead>
          <tbody>${trs}</tbody>
        </table>
      `;
    }

    const treeWrap = document.getElementById("eval-tree-complexity-wrap");
    if (treeWrap && res.tree_info) {
      const ti = res.tree_info;
      const imps = (ti.feature_importances || [])
        .map(
          (f) => `
          <div style="margin-bottom:8px;">
            <div style="display:flex; justify-content:space-between; font-size:12px; margin-bottom:3px;">
              <span>${esc(f.label)}</span>
              <span class="fw-bold" style="color:var(--accent);">${f.importance}%</span>
            </div>
            <div style="height:6px; background:var(--bg-elevated); border-radius:4px; overflow:hidden;">
              <div style="height:100%; width:${f.importance}%; background:var(--accent);"></div>
            </div>
          </div>
        `,
        )
        .join("");

      treeWrap.innerHTML = `
        <div style="border-top:1px solid var(--border); padding-top:14px;">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; flex-wrap:wrap; gap:8px;">
            <span style="font-size:12px; font-weight:700; color:var(--text-primary);">
              <i class="ri-node-tree"></i> Kompleksitas Pohon &amp; Bobot Fitur (Information Gain)
            </span>
            <div class="d-flex gap-1">
              <span class="badge badge-neutral">Kedalaman (Depth): ${ti.max_depth_actual ?? "-"}</span>
              <span class="badge badge-neutral">Jumlah Daun (Leaves): ${ti.n_leaves ?? "-"}</span>
              <span class="badge badge-neutral">Total Node: ${ti.n_nodes ?? "-"}</span>
            </div>
          </div>
          ${imps}
        </div>
      `;
    }
  }

  function renderPerClassTable(classReport) {
    const tbody = document.querySelector("#eval-class-table tbody");
    if (!tbody) return;
    if (!classReport.length) {
      tbody.innerHTML = `<tr><td colspan="7" class="table-empty">Tidak ada data kelas</td></tr>`;
      return;
    }
    tbody.innerHTML = classReport
      .map((c) => {
        const f1Pct = (c.f1_score * 100).toFixed(1);
        const f1Badge =
          c.f1_score >= 0.8
            ? "badge-success"
            : c.f1_score >= 0.6
              ? "badge-warning"
              : "badge-danger";
        return `
        <tr>
          <td><span class="badge badge-accent">${esc(c.label)}</span></td>
          <td class="fw-bold">${c.support} sampel</td>
          <td>${c.predicted_count} sampel</td>
          <td style="color:var(--success); font-weight:700;">${c.correct_count} tepat</td>
          <td>${(c.precision * 100).toFixed(1)}%</td>
          <td>${(c.recall * 100).toFixed(1)}%</td>
          <td><span class="badge ${f1Badge}">${f1Pct}%</span></td>
        </tr>
      `;
      })
      .join("");
  }

  function filterPredictions(mode) {
    if (!lastEvalResult) return;
    const details = lastEvalResult.prediction_details || [];
    const tbody = document.querySelector("#eval-details-table tbody");
    if (!tbody) return;

    // Update filter buttons active state
    document.querySelectorAll("#eval-detail-filters button").forEach((btn) => {
      if (btn.dataset.filter === mode) {
        btn.className = "btn btn-sm btn-primary";
      } else {
        btn.className = "btn btn-sm btn-secondary";
      }
    });

    let filtered = details;
    if (mode === "WRONG") {
      filtered = details.filter((d) => !d.is_correct);
    } else if (mode === "CORRECT") {
      filtered = details.filter((d) => d.is_correct);
    } else if (mode === "UNSEEN") {
      filtered = details.filter((d) => !d.in_train);
    }

    if (!filtered.length) {
      tbody.innerHTML = `<tr><td colspan="9" class="table-empty">Tidak ada record untuk filter ini.</td></tr>`;
      return;
    }

    tbody.innerHTML = filtered
      .map((d) => {
        const sev = SEV_MAP[d.defect_severity || 1] || SEV_MAP[1];
        const sampleBadge = d.in_train
          ? `<span class="badge badge-warning" title="Sampel ini juga ada di Dataset Training">Overlap Train</span>`
          : `<span class="badge badge-info" title="Sampel murni baru (Unseen)">Unseen</span>`;
        const matchBadge = d.is_correct
          ? `<span class="badge badge-success"><i class="ri-check-line"></i> BENAR</span>`
          : `<span class="badge badge-danger"><i class="ri-close-line"></i> SALAH</span>`;

        return `
        <tr style="${!d.is_correct ? "background:rgba(248,81,73,0.06);" : ""}">
          <td class="fw-bold text-small">${esc(d.qc_code)}</td>
          <td>${esc(d.product_category)}</td>
          <td>${esc(d.defect_category)}</td>
          <td><span class="badge ${sev.cls}">${esc(d.defect_severity_label)}</span></td>
          <td>${sampleBadge}</td>
          <td><span class="badge badge-neutral">${esc(d.actual_action)}</span></td>
          <td><span class="badge ${d.is_correct ? "badge-success" : "badge-danger"}">${esc(d.predicted_action)}</span></td>
          <td class="fw-bold">${d.confidence}%</td>
          <td>${matchBadge}</td>
        </tr>
      `;
      })
      .join("");
  }

  return {
    init,
    load,
    openCreate,
    save,
    openGenerateTest,
    onGenerateModeChange,
    submitGenerateTest,
    del,
    viewRecords,
    openAddRecords,
    renderAvailableRecords,
    addSelectedRecords,
    removeRecord,
    openUpload,
    uploadFile,
    evaluateModel,
    reEvaluateCurrent,
    filterPredictions,
  };
})();

// Dashboard Charts
window.DashboardCharts = (function () {
  const chartInstances = {};
  const chartColors = [
    "#2f81f7",
    "#3fb950",
    "#d29922",
    "#f85149",
    "#a371f7",
    "#f0883e",
    "#58a6ff",
    "#79c0ff",
  ];

  async function init() {
    if (typeof Chart === "undefined") return;
    try {
      const data = await API.get(`/${apiBase}/api/stats`);
      renderBarChart(data.decision_distribution || []);
      renderLineChart(data.monthly_ng || []);
      renderPieChart(
        "chart-defect-category",
        data.defect_distribution || [],
        "Distribusi Kategori Defect",
      );
      renderOkNgChart(data.ok_ng_ratio || {});
    } catch (e) {
      console.error("Chart load error:", e);
    }
  }

  function renderBarChart(dist) {
    const canvas = document.getElementById("chart-decision");
    if (!canvas) return;
    if (chartInstances["decision"]) chartInstances["decision"].destroy();
    chartInstances["decision"] = new Chart(canvas, {
      type: "bar",
      data: {
        labels: dist.map((d) => d.label),
        datasets: [
          {
            label: "Jumlah",
            data: dist.map((d) => d.count),
            backgroundColor: ["#58a6ff", "#d29922", "#f0883e", "#f85149"],
            borderRadius: 6,
            borderSkipped: false,
          },
        ],
      },
      options: chartOpts("Distribusi Keputusan Penanganan"),
    });
  }

  function renderLineChart(monthly) {
    const canvas = document.getElementById("chart-monthly");
    if (!canvas) return;
    if (chartInstances["monthly"]) chartInstances["monthly"].destroy();
    chartInstances["monthly"] = new Chart(canvas, {
      type: "line",
      data: {
        labels: monthly.map((m) => m.month),
        datasets: [
          {
            label: "Jumlah NG",
            data: monthly.map((m) => m.count),
            borderColor: "#f85149",
            backgroundColor: "rgba(248,81,73,0.1)",
            fill: true,
            tension: 0.4,
            pointRadius: 4,
            pointBackgroundColor: "#f85149",
          },
        ],
      },
      options: chartOpts("Tren Produk NG Per Bulan"),
    });
  }

  function renderPieChart(canvasId, dist, title) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    if (chartInstances[canvasId]) chartInstances[canvasId].destroy();
    chartInstances[canvasId] = new Chart(canvas, {
      type: "doughnut",
      data: {
        labels: dist.map((d) => d.label || d.name),
        datasets: [
          {
            data: dist.map((d) => d.count),
            backgroundColor: chartColors.slice(0, dist.length),
            borderWidth: 0,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: "bottom",
            labels: { color: "#8b949e", padding: 12, font: { size: 11 } },
          },
          datalabels: {
            color: "#fff",
            font: { weight: "bold", size: 12 },
            formatter: (value, ctx) => {
              let sum = 0;
              let dataArr = ctx.chart.data.datasets[0].data;
              dataArr.map((data) => {
                sum += data;
              });
              let percentage = ((value * 100) / sum).toFixed(1) + "%";
              return percentage;
            },
            display: function (context) {
              return context.dataset.data[context.dataIndex] > 0;
            },
          },
        },
      },
    });
  }

  function renderOkNgChart(ratio) {
    const canvas = document.getElementById("chart-ok-ng");
    if (!canvas) return;
    if (chartInstances["okng"]) chartInstances["okng"].destroy();
    chartInstances["okng"] = new Chart(canvas, {
      type: "doughnut",
      data: {
        labels: ["OK", "NG"],
        datasets: [
          {
            data: [ratio.total_ok || 0, ratio.total_ng || 0],
            backgroundColor: ["#3fb950", "#f85149"],
            borderWidth: 0,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: "bottom",
            labels: { color: "#8b949e", padding: 12, font: { size: 11 } },
          },
          datalabels: {
            color: "#fff",
            font: { weight: "bold", size: 12 },
            formatter: (value, ctx) => {
              let sum = 0;
              let dataArr = ctx.chart.data.datasets[0].data;
              dataArr.map((data) => {
                sum += data;
              });
              let percentage = ((value * 100) / sum).toFixed(1) + "%";
              return percentage;
            },
            display: function (context) {
              return context.dataset.data[context.dataIndex] > 0;
            },
          },
        },
      },
    });
  }

  function chartOpts(title) {
    return {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        datalabels: {
          color: "#fff",
          font: { weight: "bold", size: 10 },
          formatter: Math.round,
          anchor: "end",
          align: "start",
          offset: -20,
          display: function (context) {
            return context.dataset.data[context.dataIndex] > 0;
          },
        },
        legend: { display: false },
        title: { display: false },
      },
      scales: {
        x: {
          grid: { color: "rgba(255,255,255,0.04)" },
          ticks: { color: "#8b949e", font: { size: 11 } },
        },
        y: {
          grid: { color: "rgba(255,255,255,0.04)" },
          ticks: { color: "#8b949e", font: { size: 11 } },
          beginAtZero: true,
        },
      },
    };
  }

  return { init };
})();

// Reports Page”
window.ReportsPage = (function () {
  let reportCharts = {};

  async function load() {
    const month = document.getElementById("report-month")?.value;
    if (!month) return;
    try {
      const data = await API.get(
        `/${apiBase}/api/reports/monthly?month=${month}`,
      );
      renderStats(data);
      renderCharts(data);
      renderTable(data.records || []);
    } catch (e) {
      Toast.error("Gagal memuat laporan: " + e.message);
    }
  }

  function renderStats(data) {
    const el = document.getElementById("report-stats");
    if (!el) return;
    el.innerHTML = `
      <div class="stat-card" style="--stat-color:var(--accent);--stat-soft:var(--accent-soft);">
        <div class="stat-icon"><i class="ri-clipboard-line"></i></div>
        <div><div class="stat-value">${data.total_qc_hold || 0}</div><div class="stat-label">Total QC Hold</div></div>
      </div>
      <div class="stat-card" style="--stat-color:var(--danger);--stat-soft:var(--danger-soft);">
        <div class="stat-icon"><i class="ri-close-circle-line"></i></div>
        <div><div class="stat-value">${data.total_ng || 0}</div><div class="stat-label">Total NG</div></div>
      </div>
      <div class="stat-card" style="--stat-color:var(--success);--stat-soft:var(--success-soft);">
        <div class="stat-icon"><i class="ri-checkbox-circle-line"></i></div>
        <div><div class="stat-value">${data.total_ok || 0}</div><div class="stat-label">Total OK</div></div>
      </div>`;
  }

  function renderCharts(data) {
    if (typeof Chart === "undefined") return;

    // Decision distribution bar chart
    const c1 = document.getElementById("report-chart-decision");
    if (c1) {
      if (reportCharts["decision"]) reportCharts["decision"].destroy();
      const dist = data.decision_distribution || [];
      reportCharts["decision"] = new Chart(c1, {
        type: "bar",
        data: {
          labels: dist.map((d) => d.action),
          datasets: [
            {
              label: "Jumlah",
              data: dist.map((d) => d.count),
              backgroundColor: ["#58a6ff", "#d29922", "#f0883e", "#f85149"],
              borderRadius: 6,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: {
              grid: { color: "rgba(255,255,255,0.04)" },
              ticks: { color: "#8b949e" },
            },
            y: {
              grid: { color: "rgba(255,255,255,0.04)" },
              ticks: { color: "#8b949e" },
              beginAtZero: true,
            },
          },
        },
      });
    }

    // Daily trend line chart
    const c2 = document.getElementById("report-chart-daily");
    if (c2) {
      if (reportCharts["daily"]) reportCharts["daily"].destroy();
      const daily = data.daily_trend || [];
      reportCharts["daily"] = new Chart(c2, {
        type: "line",
        data: {
          labels: daily.map((d) => d.date.slice(8)),
          datasets: [
            {
              label: "QC Hold",
              data: daily.map((d) => d.count),
              borderColor: "#2f81f7",
              backgroundColor: "rgba(47,129,247,0.1)",
              fill: true,
              tension: 0.4,
              pointRadius: 3,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: {
              grid: { color: "rgba(255,255,255,0.04)" },
              ticks: { color: "#8b949e" },
            },
            y: {
              grid: { color: "rgba(255,255,255,0.04)" },
              ticks: { color: "#8b949e" },
              beginAtZero: true,
            },
          },
        },
      });
    }
  }

  function exportExcel() {
    const month = document.getElementById("report-month").value;
    if (!month) return Toast.warn("Pilih periode bulan");
    window.location.href = `/${apiBase}/api/reports/export-excel?month=${month}`;
  }

  function renderTable(records) {
    const tbody = document.getElementById("report-tbody");
    if (!tbody) return;

    if (!records || records.length === 0) {
      tbody.innerHTML =
        '<tr><td colspan="7" class="table-empty">Tidak ada data untuk periode ini</td></tr>';
      return;
    }

    tbody.innerHTML = records
      .map((r) => {
        const stBadge =
          r.decision_status === "YES"
            ? '<span class="badge" style="background:#dcfce7;color:#15803d;border:1px solid #86efac;font-weight:700;">YES</span>'
            : r.decision_status === "NO"
              ? '<span class="badge" style="background:#fee2e2;color:#b91c1c;border:1px solid #fca5a5;font-weight:700;">NO</span>'
              : '<span style="color:var(--text-muted)">-</span>';
        return `
      <tr>
        <td><span class="fw-bold">${esc(r.qc_code)}</span></td>
        <td style="white-space:nowrap">${fmtDate(r.inspection_date)}</td>
        <td>${esc(r.product_category)}</td>
        <td style="white-space:nowrap">${r.qty_total} / <span style="color:var(--danger)">${r.qty_ng}</span></td>
        <td>${esc(r.defect_category)}</td>
        <td>${esc(r.decision)}</td>
        <td>${stBadge}</td>
      </tr>
    `;
      })
      .join("");
  }

  function exportPdf() {
    const month = document.getElementById("report-month").value;
    if (!month) return Toast.warn("Pilih periode bulan");
    window.location.href = `/${apiBase}/api/reports/export-pdf?month=${month}`;
  }

  return { load, exportExcel, exportPdf };
})();

// Profile Page
window.ProfilePage = (function () {
  async function saveProfile() {
    const body = {
      full_name: document.getElementById("prof-name").value.trim(),
      email: document.getElementById("prof-email").value.trim(),
    };
    if (!body.email) {
      Toast.warn("Email wajib diisi");
      return;
    }
    try {
      await API.put(`/${apiBase}/api/profile`, body);
      Toast.success("Profil berhasil diperbarui");
      setTimeout(() => {
        window.history.back();
      }, 1000);
    } catch (e) {
      Toast.error(e.message);
    }
  }

  async function changePassword() {
    const current = document.getElementById("pw-current").value;
    const newPw = document.getElementById("pw-new").value;
    const confirm = document.getElementById("pw-confirm").value;

    if (!current || !newPw) {
      Toast.warn("Semua field password wajib diisi");
      return;
    }
    if (newPw !== confirm) {
      Toast.warn("Password baru dan konfirmasi tidak cocok");
      return;
    }
    if (newPw.length < 6) {
      Toast.warn("Password minimal 6 karakter");
      return;
    }
    try {
      await API.put(`/${apiBase}/api/profile/password`, {
        current_password: current,
        new_password: newPw,
      });
      Toast.success("Password berhasil diubah");
      document.getElementById("password-form").reset();
    } catch (e) {
      Toast.error(e.message);
    }
  }
  return { saveProfile, changePassword };
})();

// Toggle Password
document.addEventListener("DOMContentLoaded", function () {
  const toggles = document.querySelectorAll(".toggle-password");
  toggles.forEach(function (toggle) {
    toggle.addEventListener("click", function () {
      const inputId = this.getAttribute("data-target");
      const input = document.getElementById(inputId);
      if (!input) return;
      const icon = this.querySelector("i");
      if (input.type === "password") {
        input.type = "text";
        icon.classList.remove("ri-eye-line");
        icon.classList.add("ri-eye-off-line");
      } else {
        input.type = "password";
        icon.classList.remove("ri-eye-off-line");
        icon.classList.add("ri-eye-line");
      }
    });
  });
});

// Utility
function esc(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtDate(str) {
  if (!str) return "-";
  try {
    return new Date(str).toLocaleDateString("id-ID", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  } catch {
    return str;
  }
}

// Global helper
window.populateProductCatDropdowns = async function () {
  try {
    const categories = await API.get(`/${apiBase}/api/product-categories`);
    const options =
      '<option value="">Pilih Kategori Produk...</option>' +
      categories
        .map((c) => `<option value="${c.id}">${esc(c.name)}</option>`)
        .join("");

    const qcLine = document.getElementById("qc-line");
    if (qcLine) qcLine.innerHTML = options;

    const c45Line = document.getElementById("c45-line");
    if (c45Line) c45Line.innerHTML = options;
  } catch (e) {
    console.error("Failed to load product categories", e);
  }
};

//Product Category Management
window.ProductCatPage = (function () {
  let allData = [];
  let editing = null;

  async function load() {
    try {
      allData = await API.get(`/${apiBase}/api/product-categories`);
      render();
    } catch (e) {
      Toast.error(e.message);
    }
  }

  function render() {
    const tbody = document.querySelector("#product-cat-table tbody");
    if (!tbody) return;
    if (allData.length === 0) {
      tbody.innerHTML =
        '<tr><td colspan="3" class="table-empty">Belum ada kategori produk.</td></tr>';
      return;
    }
    tbody.innerHTML = allData
      .map(
        (c) => `
      <tr>
        <td><strong>${esc(c.name)}</strong></td>
        <td><span class="truncate" style="max-width:300px">${esc(c.description) || "-"}</span></td>
        <td>
          <div class="d-flex align-center gap-1">
            <button class="btn-icon" title="Edit" onclick="ProductCatPage.openEdit(${c.id})"><i class="ri-pencil-line"></i></button>
            <button class="btn-icon" title="Hapus" onclick="ProductCatPage.del(${c.id}, '${esc(c.name)}')"><i class="ri-delete-bin-line"></i></button>
          </div>
        </td>
      </tr>
    `,
      )
      .join("");
  }

  function openCreate() {
    editing = null;
    document.getElementById("product-cat-modal-title").textContent =
      "Tambah Kategori Produk";
    document.getElementById("product-cat-form").reset();
    document.getElementById("product-cat-id").value = "";
    Modal.open("product-cat-modal");
  }

  function openEdit(id) {
    const c = allData.find((x) => x.id === id);
    if (!c) return;
    editing = id;
    document.getElementById("product-cat-modal-title").textContent =
      "Edit Kategori Produk";
    document.getElementById("product-cat-id").value = c.id;
    document.getElementById("product-cat-name").value = c.name;
    document.getElementById("product-cat-desc").value = c.description || "";
    Modal.open("product-cat-modal");
  }

  async function save() {
    const body = {
      name: document.getElementById("product-cat-name").value.trim(),
      description: document.getElementById("product-cat-desc").value.trim(),
    };
    if (!body.name) {
      Toast.warn("Nama Kategori Produk wajib diisi");
      return;
    }

    try {
      if (editing) {
        await API.put(`/${apiBase}/api/product-categories/${editing}`, body);
        Toast.success("Kategori produk diperbarui");
      } else {
        await API.post(`/${apiBase}/api/product-categories`, body);
        Toast.success("Kategori produk ditambahkan");
      }
      Modal.close("product-cat-modal");
      await load();
    } catch (e) {
      Toast.error(e.message);
    }
  }

  async function del(id, name) {
    if (!(await confirmDelete(`Hapus kategori produk "${name}"?`))) return;
    try {
      await API.delete(`/${apiBase}/api/product-categories/${id}`);
      Toast.success("Kategori produk dihapus");
      await load();
    } catch (e) {
      Toast.error(e.message);
    }
  }

  return { load, openCreate, openEdit, save, del };
})();

if (typeof ChartDataLabels !== "undefined") {
  Chart.register(ChartDataLabels);
}

// --- OVERRIDE QC HOLD PAGE (Appended to fix duplication issues) ---
window.QcHoldPage = (function () {
  let allData = [];
  let editing = null;
  let activeTab = "OPEN";
  let defectTypes = [];
  const decisionColor = {
    REPAIR: "badge-info",
    REWORK: "badge-warning",
    DOWNGRADE: "badge-orange",
    DISPOSAL: "badge-danger",
  };

  async function load() {
    defectTypes = window._defectTypes || [];
    try {
      allData = await API.get(`/${apiBase}/api/qc-hold`);
      applyFilters();
    } catch (e) {
      Toast.error("Gagal memuat data: " + e.message);
    }
  }

  function render(items) {
    const tbody = document.querySelector("#qc-table tbody");
    if (!tbody) return;
    if (!items.length) {
      tbody.innerHTML = `<tr><td colspan="9" class="table-empty"><div class="empty-state-icon"><i class="ri-clipboard-line"></i></div>Belum ada data QC Hold</td></tr>`;
      return;
    }

    tbody.innerHTML = items
      .map(
        (q) => `
      <tr>
        <td><span class="fw-bold">${esc(q.qc_code)}</span></td>
        <td class="text-small">${fmtDate(q.inspection_date)}</td>
        <td>
          <div class="fw-bold">${esc(q.product_category)}</div>
        </td>
        <td>
          <span class="badge badge-success">${q.qty_ok} OK</span>
          <span class="badge badge-danger">${q.qty_ng} NG</span>
        </td>
        <td>
          ${q.defect_category ? `<span class="badge badge-neutral">${esc(q.defect_category)}</span>` : "—"}
        </td>
        <td>${q.decision_action ? `<span class="badge ${decisionColor[q.decision_action.toUpperCase()] || "badge-neutral"}">${esc(q.decision_action)}</span>` : '<span class="text-muted">—</span>'}</td>
        <td>
          ${q.status === "OPEN" ? '<span class="badge badge-warning">OPEN</span>' : '<span class="badge badge-success">CLOSE</span>'}
        </td>
        <td>${q.c45_record_id ? '<span class="source-c45"><i class="ri-robot-2-line"></i> C4.5</span>' : '<span class="source-manual"><i class="ri-user-line"></i> Manual</span>'}</td>
        <td>
          <div class="d-flex align-center gap-1">
            ${q.status === "OPEN" ? `<button class="btn-icon" title="Edit" onclick="QcHoldPage.openEdit(${q.id})"><i class="ri-pencil-line"></i></button>` : `<button class="btn-icon" title="Lihat" onclick="QcHoldPage.openView(${q.id})"><i class="ri-eye-line"></i></button>`}
            ${userRole === "qc_line" ? "" : `<button class="btn-icon" title="Hapus" onclick="QcHoldPage.del(${q.id}, '${esc(q.qc_code)}')"><i class="ri-delete-bin-line"></i></button>`}
          </div>
        </td>
      </tr>`,
      )
      .join("");
  }

  async function openView(id) {
    const q = allData.find((x) => x.id === id);
    if (!q) return;
    editing = id;
    document.getElementById("qc-modal-title").textContent =
      "Detail QC Hold (Read-Only)";
    document.getElementById("qc-action-group").style.display = "block";
    document.getElementById("qc-id").value = q.id;
    document.getElementById("qc-date").disabled = true;
    document.getElementById("qc-line").disabled = true;
    document.getElementById("qc-category").disabled = true;
    document.getElementById("qc-severity").disabled = true;
    document.getElementById("qc-qty-total").disabled = true;
    document.getElementById("qc-qty-ng").disabled = true;
    document.getElementById("qc-desc").disabled = true;
    document.getElementById("qc-action").disabled = true;
    document.getElementById("qc-hasil-perbaikan").disabled = true;
    const submitBtn = document.querySelector('#qc-form button[type="submit"]');
    if (submitBtn) submitBtn.style.display = "none";

    await populateProductCatDropdowns();
    document.getElementById("qc-date").value = (q.inspection_date || "")
      .replace(" ", "T")
      .slice(0, 16);
    document.getElementById("qc-line").value = q.product_category_id || "";
    document.getElementById("qc-category").value = q.defect_category_id || "";
    document.getElementById("qc-severity").value = q.defect_severity || "";
    document.getElementById("qc-action").value = q.decision_action_id || "";
    document.getElementById("qc-qty-total").value = q.qty_total || 0;
    document.getElementById("qc-qty-ng").value = q.qty_ng || 0;
    document.getElementById("qc-desc").value =
      q.defect_description || q.notes || "";

    document.getElementById("group-hasil-perbaikan").style.display = "none";

    Modal.open("qc-modal");
  }

  async function openCreate() {
    editing = null;
    document.getElementById("qc-modal-title").textContent = "Tambah QC Hold";
    document.getElementById("qc-form").reset();
    document.getElementById("qc-id").value = "";
    document.getElementById("qc-date").disabled = false;
    document.getElementById("qc-line").disabled = false;
    document.getElementById("qc-category").disabled = false;
    document.getElementById("qc-severity").disabled = false;
    document.getElementById("qc-qty-total").disabled = false;
    document.getElementById("qc-qty-ng").disabled = false;
    document.getElementById("qc-desc").disabled = false;
    document.getElementById("qc-action").disabled = false;
    document.getElementById("qc-hasil-perbaikan").disabled = false;
    const submitBtn = document.querySelector('#qc-form button[type="submit"]');
    if (submitBtn) submitBtn.style.display = "inline-flex";

    await populateProductCatDropdowns();
    const now = new Date();
    now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
    document.getElementById("qc-date").value = now.toISOString().slice(0, 16);
    if (userRole === "qc_line") {
      document.getElementById("qc-action-group").style.display = "none";
    } else {
      document.getElementById("qc-action-group").style.display = "block";
    }
    document.getElementById("group-hasil-perbaikan").style.display = "none";
    document.getElementById("qc-hasil-perbaikan").value = "";
    Modal.open("qc-modal");
  }

  async function openEdit(id) {
    const q = allData.find((x) => x.id === id);
    if (!q) return;
    editing = id;
    document.getElementById("qc-modal-title").textContent = "Edit QC Hold";
    if (userRole === "qc_line") {
      document.getElementById("qc-action-group").style.display = "none";
    } else {
      document.getElementById("qc-action-group").style.display = "block";
    }
    document.getElementById("qc-id").value = q.id;
    document.getElementById("qc-date").disabled = false;
    document.getElementById("qc-line").disabled = false;
    document.getElementById("qc-category").disabled = false;
    document.getElementById("qc-severity").disabled = false;
    document.getElementById("qc-qty-total").disabled = false;
    document.getElementById("qc-qty-ng").disabled = false;
    document.getElementById("qc-desc").disabled = false;
    document.getElementById("qc-action").disabled = false;
    document.getElementById("qc-hasil-perbaikan").disabled = false;
    const submitBtn = document.querySelector('#qc-form button[type="submit"]');
    if (submitBtn) submitBtn.style.display = "inline-flex";

    await populateProductCatDropdowns();
    document.getElementById("qc-date").value = (q.inspection_date || "")
      .replace(" ", "T")
      .slice(0, 16);
    document.getElementById("qc-line").value = q.product_category_id || "";
    document.getElementById("qc-category").value = q.defect_category_id || "";
    document.getElementById("qc-severity").value = q.defect_severity || "";
    document.getElementById("qc-action").value = q.decision_action_id || "";
    document.getElementById("qc-qty-total").value = q.qty_total || 0;
    document.getElementById("qc-qty-ng").value = q.qty_ng || 0;
    document.getElementById("qc-desc").value =
      q.defect_description || q.notes || "";

    document.getElementById("group-hasil-perbaikan").style.display = "block";
    document.getElementById("qc-hasil-perbaikan").value = "";

    Modal.open("qc-modal");
  }

  let isSaving = false;

  async function save() {
    if (isSaving) return;
    const body = {
      inspection_date: document.getElementById("qc-date").value,
      product_category_id: document.getElementById("qc-line").value,
      defect_category_id:
        parseInt(document.getElementById("qc-category").value) || null,
      defect_severity:
        parseInt(document.getElementById("qc-severity").value) || null,
      defect_description: document.getElementById("qc-desc").value.trim(),
      qty_total: parseInt(document.getElementById("qc-qty-total").value) || 0,
      qty_ng: parseInt(document.getElementById("qc-qty-ng").value) || 0,
      decision_action_id:
        parseInt(document.getElementById("qc-action").value) || null,
      notes: document.getElementById("qc-desc").value.trim(),
      hasil_perbaikan:
        document.getElementById("qc-hasil-perbaikan").value || null,
    };
    if (!body.product_category_id || !body.inspection_date) {
      Toast.warn("Kategori produk dan tanggal inspeksi wajib diisi");
      return;
    }
    if (body.qty_ng > body.qty_total) {
      Toast.warn(
        "QTY Defect (NG) tidak boleh lebih besar dari QTY Planning (Total).",
      );
      return;
    }

    isSaving = true;
    try {
      if (editing) await API.put(`/${apiBase}/api/qc-hold/${editing}`, body);
      else await API.post(`/${apiBase}/api/qc-hold`, body);
      Modal.close("qc-modal");
      Toast.success(
        editing ? "QC Hold diperbarui" : "QC Hold berhasil ditambahkan",
      );
      await load();
    } catch (e) {
      Toast.error(e.message);
    } finally {
      isSaving = false;
    }
  }

  async function del(id, code) {
    if (!(await confirmDelete(`Hapus data QC Hold "${code}"?`))) return;
    try {
      await API.delete(`/${apiBase}/api/qc-hold/${id}`);
      Toast.success("QC Hold dihapus");
      await load();
    } catch (e) {
      Toast.error(e.message);
    }
  }

  function setTab(tab) {
    activeTab = tab;

    const tOpen = document.getElementById("tab-open");
    if (tOpen) {
      tOpen.className = "tab-btn" + (tab === "OPEN" ? " active" : "");
      tOpen.style.borderBottom =
        tab === "OPEN" ? "2px solid var(--accent)" : "2px solid transparent";
      tOpen.style.color =
        tab === "OPEN" ? "var(--text-primary)" : "var(--text-secondary)";
    }

    const tClose = document.getElementById("tab-close");
    if (tClose) {
      tClose.className = "tab-btn" + (tab === "CLOSE" ? " active" : "");
      tClose.style.borderBottom =
        tab === "CLOSE" ? "2px solid var(--accent)" : "2px solid transparent";
      tClose.style.color =
        tab === "CLOSE" ? "var(--text-primary)" : "var(--text-secondary)";
    }

    applyFilters();
  }

  function applyFilters() {
    let filtered = allData.filter((d) => (d.status || "CLOSE") === activeTab);

    const dateEl = document.getElementById("filter-date");
    if (dateEl && dateEl.value) {
      const selectedDate = dateEl.value;
      filtered = filtered.filter((d) =>
        (d.inspection_date || "").startsWith(selectedDate),
      );
    }

    const catEl = document.getElementById("filter-category");
    if (catEl && catEl.value) {
      filtered = filtered.filter((d) => d.defect_category_id == catEl.value);
    }

    render(filtered);
  }

  return {
    load,
    openCreate,
    openEdit,
    openView,
    save,
    del,
    delete: del,
    applyFilters,
    setTab,
  };
})();

// --- OVERRIDE QC HOLD PAGE (Appended to fix duplication issues) ---
window.QcHoldPage = (function () {
  let allData = [];
  let editing = null;
  let activeTab = "OPEN";
  let defectTypes = [];
  const decisionColor = {
    REPAIR: "badge-info",
    REWORK: "badge-warning",
    DOWNGRADE: "badge-orange",
    DISPOSAL: "badge-danger",
  };

  async function load() {
    defectTypes = window._defectTypes || [];
    try {
      allData = await API.get(`/${apiBase}/api/qc-hold`);
      applyFilters();
    } catch (e) {
      Toast.error("Gagal memuat data: " + e.message);
    }
  }

  function render(items) {
    const tbody = document.querySelector("#qc-table tbody");
    if (!tbody) return;
    if (!items.length) {
      tbody.innerHTML = `<tr><td colspan="12" class="table-empty"><div class="empty-state-icon"><i class="ri-clipboard-line"></i></div>Belum ada data QC Hold</td></tr>`;
      return;
    }

    tbody.innerHTML = items
      .map((q) => {
        const decStatusBadge =
          q.decision_status === "YES"
            ? '<span class="badge" style="background:#dcfce7;color:#15803d;border:1px solid #86efac;font-weight:700;">YES</span>'
            : q.decision_status === "NO"
              ? '<span class="badge" style="background:#fee2e2;color:#b91c1c;border:1px solid #fca5a5;font-weight:700;">NO</span>'
              : '<span class="text-muted">—</span>';
        return `
      <tr>
        <td><span class="fw-bold">${esc(q.qc_code)}</span></td>
        <td class="text-small">${fmtDate(q.inspection_date)}</td>
        <td><span class="fw-bold">${esc(q.part_no || "-")}</span></td>
        <td>
          <div class="fw-bold">${esc(q.product_category)}</div>
        </td>
        <td>
          <span class="badge badge-success">${q.qty_ok} OK</span>
          <span class="badge badge-danger">${q.qty_ng} NG</span>
        </td>
        <td>
          ${q.defect_category ? `<span class="badge badge-neutral">${esc(q.defect_category)}</span>` : "—"}
        </td>
        <td>${q.decision_action ? `<span class="badge ${decisionColor[q.decision_action.toUpperCase()] || "badge-neutral"}">${esc(q.decision_action)}</span>` : '<span class="text-muted">—</span>'}</td>
        <td>${decStatusBadge}</td>
        <td>
          ${q.status === "OPEN" ? '<span class="badge badge-warning">OPEN</span>' : '<span class="badge badge-success">CLOSE</span>'}
        </td>
        <td>
          <div style="font-size: 0.85em; line-height: 1.4; min-width: 120px;">
            <div title="Pembuat"><i class="ri-user-add-line text-muted"></i> ${esc(q.created_by_name || "-")}</div>
            <div title="Terakhir Edit"><i class="ri-edit-2-line text-muted"></i> ${esc(q.updated_by_name || "-")}</div>
            <div title="Penentu Keputusan"><i class="ri-scales-3-line text-muted"></i> ${esc(q.action_taken_by_name || "-")}</div>
          </div>
        </td>
        <td>${q.c45_record_id ? '<span class="source-c45"><i class="ri-robot-2-line"></i> C4.5</span>' : '<span class="source-manual"><i class="ri-user-line"></i> Manual</span>'}</td>
        <td>
          <div class="d-flex align-center gap-1">
            ${q.status === "OPEN" ? `<button class="btn-icon" title="Edit" onclick="QcHoldPage.openEdit(${q.id})"><i class="ri-pencil-line"></i></button>` : `<button class="btn-icon" title="Lihat" onclick="QcHoldPage.openView(${q.id})"><i class="ri-eye-line"></i></button>`}
            ${userRole === "qc_line" ? "" : `<button class="btn-icon" title="Hapus" onclick="QcHoldPage.del(${q.id}, '${esc(q.qc_code)}')"><i class="ri-delete-bin-line"></i></button>`}
          </div>
        </td>
      </tr>`;
      })
      .join("");
  }

  async function openView(id) {
    const q = allData.find((x) => x.id === id);
    if (!q) return;
    editing = id;
    document.getElementById("qc-modal-title").textContent =
      "Detail QC Hold (Read-Only)";
    document.getElementById("qc-action-group").style.display = "block";
    document.getElementById("qc-id").value = q.id;
    document.getElementById("qc-date").disabled = true;
    document.getElementById("qc-part-no").disabled = true;
    document.getElementById("qc-line").disabled = true;
    document.getElementById("qc-category").disabled = true;
    document.getElementById("qc-severity").disabled = true;
    document.getElementById("qc-qty-total").disabled = true;
    document.getElementById("qc-qty-ng").disabled = true;
    document.getElementById("qc-desc").disabled = true;
    document.getElementById("qc-action").disabled = true;
    document.getElementById("qc-hasil-perbaikan").disabled = true;
    const submitBtn = document.querySelector('#qc-form button[type="submit"]');
    if (submitBtn) submitBtn.style.display = "none";

    await populateProductCatDropdowns();
    document.getElementById("qc-date").value = (q.inspection_date || "")
      .replace(" ", "T")
      .slice(0, 16);
    document.getElementById("qc-part-no").value = q.part_no || "";
    document.getElementById("qc-line").value = q.product_category_id || "";
    document.getElementById("qc-category").value = q.defect_category_id || "";
    document.getElementById("qc-severity").value = q.defect_severity || "";
    document.getElementById("qc-action").value = q.decision_action_id || "";
    document.getElementById("qc-qty-total").value = q.qty_total || 0;
    document.getElementById("qc-qty-ng").value = q.qty_ng || 0;
    document.getElementById("qc-desc").value =
      q.defect_description || q.notes || "";

    document.getElementById("group-hasil-perbaikan").style.display = "none";

    Modal.open("qc-modal");
  }

  async function openCreate() {
    editing = null;
    document.getElementById("qc-modal-title").textContent = "Tambah QC Hold";
    document.getElementById("qc-form").reset();
    document.getElementById("qc-id").value = "";
    document.getElementById("qc-date").disabled = false;
    document.getElementById("qc-part-no").disabled = false;
    document.getElementById("qc-line").disabled = false;
    document.getElementById("qc-category").disabled = false;
    document.getElementById("qc-severity").disabled = false;
    document.getElementById("qc-qty-total").disabled = false;
    document.getElementById("qc-qty-ng").disabled = false;
    document.getElementById("qc-desc").disabled = false;
    document.getElementById("qc-action").disabled = false;
    document.getElementById("qc-hasil-perbaikan").disabled = false;
    const submitBtn = document.querySelector('#qc-form button[type="submit"]');
    if (submitBtn) submitBtn.style.display = "inline-flex";

    await populateProductCatDropdowns();
    const now = new Date();
    now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
    document.getElementById("qc-date").value = now.toISOString().slice(0, 16);
    if (userRole === "qc_line") {
      document.getElementById("qc-action-group").style.display = "none";
    } else {
      document.getElementById("qc-action-group").style.display = "block";
    }
    document.getElementById("group-hasil-perbaikan").style.display = "none";
    document.getElementById("qc-hasil-perbaikan").value = "";
    Modal.open("qc-modal");
  }

  async function openEdit(id) {
    const q = allData.find((x) => x.id === id);
    if (!q) return;
    editing = id;
    document.getElementById("qc-modal-title").textContent = "Edit QC Hold";
    if (userRole === "qc_line") {
      document.getElementById("qc-action-group").style.display = "none";
    } else {
      document.getElementById("qc-action-group").style.display = "block";
    }
    document.getElementById("qc-id").value = q.id;
    document.getElementById("qc-date").disabled = false;
    document.getElementById("qc-part-no").disabled = false;
    document.getElementById("qc-line").disabled = false;
    document.getElementById("qc-category").disabled = false;
    document.getElementById("qc-severity").disabled = false;
    document.getElementById("qc-qty-total").disabled = false;
    document.getElementById("qc-qty-ng").disabled = false;
    document.getElementById("qc-desc").disabled = false;
    document.getElementById("qc-action").disabled = false;
    document.getElementById("qc-hasil-perbaikan").disabled = false;
    const submitBtn = document.querySelector('#qc-form button[type="submit"]');
    if (submitBtn) submitBtn.style.display = "inline-flex";

    await populateProductCatDropdowns();
    document.getElementById("qc-date").value = (q.inspection_date || "")
      .replace(" ", "T")
      .slice(0, 16);
    document.getElementById("qc-part-no").value = q.part_no || "";
    document.getElementById("qc-line").value = q.product_category_id || "";
    document.getElementById("qc-category").value = q.defect_category_id || "";
    document.getElementById("qc-severity").value = q.defect_severity || "";
    document.getElementById("qc-action").value = q.decision_action_id || "";
    document.getElementById("qc-qty-total").value = q.qty_total || 0;
    document.getElementById("qc-qty-ng").value = q.qty_ng || 0;
    document.getElementById("qc-desc").value =
      q.defect_description || q.notes || "";

    document.getElementById("group-hasil-perbaikan").style.display = "block";
    document.getElementById("qc-hasil-perbaikan").value = "";

    Modal.open("qc-modal");
  }

  let isSaving = false;

  async function save() {
    if (isSaving) return;
    const body = {
      inspection_date: document.getElementById("qc-date").value,
      part_no: document.getElementById("qc-part-no").value.trim(),
      product_category_id: document.getElementById("qc-line").value,
      defect_category_id:
        parseInt(document.getElementById("qc-category").value) || null,
      defect_severity:
        parseInt(document.getElementById("qc-severity").value) || null,
      defect_description: document.getElementById("qc-desc").value.trim(),
      qty_total: parseInt(document.getElementById("qc-qty-total").value) || 0,
      qty_ng: parseInt(document.getElementById("qc-qty-ng").value) || 0,
      decision_action_id:
        parseInt(document.getElementById("qc-action").value) || null,
      notes: document.getElementById("qc-desc").value.trim(),
      hasil_perbaikan:
        document.getElementById("qc-hasil-perbaikan").value || null,
    };
    if (!body.product_category_id || !body.inspection_date) {
      Toast.warn("Kategori produk dan tanggal inspeksi wajib diisi");
      return;
    }
    if (body.qty_ng > body.qty_total) {
      Toast.warn(
        "QTY Defect (NG) tidak boleh lebih besar dari QTY Planning (Total).",
      );
      return;
    }

    isSaving = true;
    try {
      if (editing) await API.put(`/${apiBase}/api/qc-hold/${editing}`, body);
      else await API.post(`/${apiBase}/api/qc-hold`, body);
      Modal.close("qc-modal");
      Toast.success(
        editing ? "QC Hold diperbarui" : "QC Hold berhasil ditambahkan",
      );
      await load();
    } catch (e) {
      Toast.error(e.message);
    } finally {
      isSaving = false;
    }
  }

  async function del(id, code) {
    if (!(await confirmDelete(`Hapus data QC Hold "${code}"?`))) return;
    try {
      await API.delete(`/${apiBase}/api/qc-hold/${id}`);
      Toast.success("QC Hold dihapus");
      await load();
    } catch (e) {
      Toast.error(e.message);
    }
  }

  function setTab(tab) {
    activeTab = tab;

    const tOpen = document.getElementById("tab-open");
    if (tOpen) {
      tOpen.className = "tab-btn" + (tab === "OPEN" ? " active" : "");
      tOpen.style.borderBottom =
        tab === "OPEN" ? "2px solid var(--accent)" : "2px solid transparent";
      tOpen.style.color =
        tab === "OPEN" ? "var(--text-primary)" : "var(--text-secondary)";
    }

    const tClose = document.getElementById("tab-close");
    if (tClose) {
      tClose.className = "tab-btn" + (tab === "CLOSE" ? " active" : "");
      tClose.style.borderBottom =
        tab === "CLOSE" ? "2px solid var(--accent)" : "2px solid transparent";
      tClose.style.color =
        tab === "CLOSE" ? "var(--text-primary)" : "var(--text-secondary)";
    }

    applyFilters();
  }

  function applyFilters() {
    let filtered = allData.filter((d) => (d.status || "CLOSE") === activeTab);

    const dateEl = document.getElementById("filter-date");
    if (dateEl && dateEl.value) {
      const selectedDate = dateEl.value;
      filtered = filtered.filter((d) =>
        (d.inspection_date || "").startsWith(selectedDate),
      );
    }

    const catEl = document.getElementById("filter-category");
    if (catEl && catEl.value) {
      filtered = filtered.filter((d) => d.defect_category_id == catEl.value);
    }

    render(filtered);
  }

  async function importExcel(event) {
    const file = event.target.files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append("file", file);

    try {
      Toast.show("Mengimpor data...");
      const res = await fetch(`/${apiBase}/api/qc-hold/import`, {
        method: "POST",
        body: formData,
      });
      const data = await res.json();

      if (!res.ok) throw new Error(data.error || "Gagal mengimpor file");

      Toast.success(`Berhasil mengimpor ${data.imported_count} data QC Hold`);
      event.target.value = ""; // Reset input
      load();
    } catch (e) {
      Toast.error(e.message);
      event.target.value = "";
    }
  }

  return {
    load,
    openCreate,
    openEdit,
    openView,
    save,
    del,
    delete: del,
    applyFilters,
    setTab,
    importExcel,
  };
})();
