// NorthGateWay Entity Intelligence - Client Application
// Supports Stitch design, dynamic ownership tree, and live PostgreSQL backend.

const FIELD_LABELS = {
  owner: "Owner",
  percentage: "Ownership Percentage",
  targetEntity: "Target Entity",
  ownerType: "Owner Type",
  controlBasis: "Control Basis",
};

let state = null;
let selectedClaimId = null;
let activeDocumentId = null;
let currentView = "ownership";

const escapeHtml = (val) => String(val ?? "").replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[c]));

const formatPct = (val) => new Intl.NumberFormat(undefined, {
  minimumFractionDigits: 1,
  maximumFractionDigits: 4,
}).format(val);

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

// Update UTC Clock in header
function startUtcClock() {
  const clockEl = document.getElementById("utc-clock");
  function tick() {
    const now = new Date();
    if (clockEl) {
      clockEl.textContent = now.toTimeString().split(" ")[0] + " UTC";
    }
  }
  tick();
  setInterval(tick, 1000);
}

// Navigation between Analytical Modules
function initNavigation() {
  const navButtons = document.querySelectorAll("#sidebar-nav .nav-btn");
  navButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const view = btn.dataset.view;
      if (!view) return;
      currentView = view;
      navButtons.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");

      document.querySelectorAll(".view-panel").forEach((panel) => {
        panel.classList.add("hidden");
      });
      const activePanel = document.getElementById(`view-${view}`);
      if (activePanel) {
        activePanel.classList.remove("hidden");
      }
    });
  });

  const gotoQueueBtn = document.getElementById("btn-goto-queue");
  if (gotoQueueBtn) {
    gotoQueueBtn.addEventListener("click", () => {
      const reviewBtn = document.querySelector('[data-view="review"]');
      if (reviewBtn) reviewBtn.click();
    });
  }
}

// Refresh state from backend
async function refreshState() {
  try {
    state = await api("/api/state");
    render();
  } catch (err) {
    console.error("Failed to load state:", err);
    alert("API Error: " + err.message);
  }
}

// Main Render Dispatcher
function render() {
  if (!state) return;

  // Header and Ribbon
  document.getElementById("header-file-id").textContent = "#KYC-94021";
  document.getElementById("threshold-display").textContent = formatPct(state.threshold);
  document.getElementById("hud-threshold").textContent = formatPct(state.threshold);
  const thresholdSelect = document.getElementById("threshold-select");
  if (thresholdSelect && thresholdSelect.value !== String(state.threshold)) {
    thresholdSelect.value = String(state.threshold);
  }

  // HUD Metrics
  document.getElementById("hud-doc-count").textContent = `${state.documents.length} File${state.documents.length === 1 ? "" : "s"}`;
  document.getElementById("hud-ubo-count").textContent = `${state.confirmed.length} Person${state.confirmed.length === 1 ? "" : "s"}`;
  document.getElementById("hud-unverified-count").textContent = `${state.summary.unverifiedFields} Fields`;
  document.getElementById("hud-flags-count").textContent = `${state.summary.flaggedClaims} Flags`;

  const flagCard = document.getElementById("hud-flag-card");
  const flagBadge = document.getElementById("hud-flags-badge");
  const flagIcon = document.getElementById("hud-flags-icon");
  if (state.summary.flaggedClaims > 0) {
    flagCard.className = "bg-error-container px-3 py-2 rounded-lg flex items-center justify-between border border-error/30 animate-pulse";
    flagBadge.textContent = "QUARANTINED";
    flagIcon.innerHTML = '<span class="material-symbols-outlined text-[18px] text-error">warning</span>';
  } else {
    flagCard.className = "bg-surface-container-low px-3 py-2 rounded-lg flex items-center justify-between border border-outline-variant/20";
    flagBadge.textContent = "CLEARED";
    flagIcon.innerHTML = '<span class="material-symbols-outlined text-[18px] text-emerald-700">check_circle</span>';
  }

  // Navigation Pills
  document.getElementById("nav-unverified-pill").textContent = state.summary.unverifiedFields;
  document.getElementById("nav-flags-pill").textContent = state.summary.flaggedClaims;
  document.getElementById("nav-audit-pill").textContent = state.audit.length;
  document.getElementById("btn-queue-count").textContent = state.summary.unverifiedFields;

  // Render individual views
  renderHierarchyTree();
  renderConfirmedUbos();
  renderDocumentViewerTabs();
  renderFieldReviewQueue();
  renderJudgmentQueue();
  renderMlroBoundary();
  renderAuditTrail();
  renderPilotBenchmarks();

  // Auto-select first claim if none selected
  if (!selectedClaimId && state.claims.length > 0) {
    selectClaim(state.claims[0].id);
  } else if (selectedClaimId) {
    selectClaim(selectedClaimId);
  }
}

// 1. Render Hierarchy Tree & Branches (View 1)
function renderHierarchyTree() {
  const container = document.getElementById("tree-branches-container");
  if (!container) return;

  if (state.claims.length === 0) {
    container.innerHTML = `
      <div class="bg-surface-container-lowest p-6 rounded-xl border border-outline-variant/30 text-center text-on-surface-variant">
        No claims loaded. Upload or paste a synthetic share register to begin.
      </div>`;
    return;
  }

  container.innerHTML = state.claims.map((claim, index) => {
    const isFlagged = claim.flags.length > 0;
    const isEscalated = Object.values(claim.fields).includes("escalated");
    const isConfirmed = Object.values(claim.fields).every((s) => s === "accepted" || s === "edited");
    const isSelected = claim.id === selectedClaimId;

    // Border styling
    let cardBorder = "border-outline-variant/30";
    if (isSelected) cardBorder = "ring-2 ring-primary border-primary";
    if (isFlagged) cardBorder = "border-error/40 bg-error-container/20";

    const branchNum = String(index + 1).padStart(2, "0");
    const ownerTypeBadge = claim.ownerType === "person" 
      ? '<span class="bg-emerald-100 text-emerald-800 text-[10px] font-bold px-1.5 py-0.5 rounded flex items-center gap-1"><span class="material-symbols-outlined text-[12px]">person</span>Natural Person</span>'
      : '<span class="bg-blue-100 text-blue-800 text-[10px] font-bold px-1.5 py-0.5 rounded flex items-center gap-1"><span class="material-symbols-outlined text-[12px]">business</span>Corporate Entity</span>';

    const qualUboBadge = claim.percentage >= state.threshold && claim.ownerType === "person"
      ? `<span class="bg-primary text-on-primary text-[10px] font-bold px-2 py-0.5 rounded uppercase">Statutory UBO Qualifying (≥${state.threshold}%)</span>`
      : `<span class="bg-surface-container text-on-surface-variant text-[10px] font-bold px-2 py-0.5 rounded uppercase">${claim.percentage}% Holding</span>`;

    return `
      <div class="bg-surface-container-lowest rounded-xl shadow-sm border ${cardBorder} overflow-hidden transition-all" id="tree-branch-${claim.id}">
        <!-- Branch Header -->
        <div class="bg-surface-container-low px-3.5 py-2 flex items-center justify-between border-b border-outline-variant/20">
          <div class="flex items-center gap-2">
            <span class="font-mono text-[10px] font-bold bg-primary text-on-primary px-1.5 py-0.5 rounded">BRANCH ${branchNum}</span>
            <span class="text-xs font-bold text-on-surface">${escapeHtml(claim.targetEntity)} Ownership Claim</span>
          </div>
          <div class="flex items-center gap-1.5">
            ${isFlagged ? '<span class="bg-error text-on-error font-mono text-[10px] font-bold px-1.5 py-0.5 rounded animate-pulse">FLAGGED QUARANTINE</span>' : ''}
            <span class="bg-surface-container px-2 py-0.5 rounded font-mono text-[10px] text-on-surface font-semibold">${escapeHtml(claim.controlBasis)}</span>
          </div>
        </div>

        <!-- Branch Content -->
        <div class="p-3.5 flex flex-col gap-3">
          <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
            <!-- Node Left: Target Entity -->
            <div class="bg-surface-container-low p-2.5 rounded-lg border border-outline-variant/20 flex flex-col justify-between">
              <div>
                <span class="text-[9px] font-bold text-on-surface-variant uppercase tracking-wider">Target Entity</span>
                <h4 class="text-xs font-bold text-on-surface mt-0.5">${escapeHtml(claim.targetEntity)}</h4>
              </div>
              <div class="pt-2 flex items-center justify-between text-[11px] font-mono text-on-surface-variant border-t border-outline-variant/20 mt-2">
                <span>Direct Share Allocation</span>
                <span class="font-bold text-primary">${formatPct(claim.percentage)}%</span>
              </div>
            </div>

            <!-- Node Right: Claimed Owner -->
            <div class="bg-surface-container p-2.5 rounded-lg border border-outline-variant/20 flex flex-col justify-between">
              <div>
                <div class="flex items-center justify-between">
                  <span class="text-[9px] font-bold text-on-surface-variant uppercase tracking-wider">Claimed Holder</span>
                  ${ownerTypeBadge}
                </div>
                <h4 class="text-xs font-bold text-on-surface mt-0.5">${escapeHtml(claim.owner)}</h4>
              </div>
              <div class="pt-2 flex items-center justify-between text-[10px] text-on-surface-variant border-t border-outline-variant/20 mt-2">
                <span class="truncate">Source: ${escapeHtml(claim.documentName)}</span>
                <button class="text-primary hover:underline font-bold font-mono text-[10px] whitespace-nowrap btn-inspect-source" data-claim-id="${claim.id}">
                  Inspect Line →
                </button>
              </div>
            </div>
          </div>

          <!-- Arithmetic & Verification Formula Ribbon -->
          <div class="bg-surface-container-high p-2 rounded-lg flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 border border-outline-variant/20">
            <div class="flex items-center gap-1.5 font-mono text-xs text-on-surface flex-wrap">
              <span class="bg-surface-container-lowest px-2 py-0.5 rounded font-semibold">${formatPct(claim.percentage)}%</span>
              <span class="text-secondary font-bold">× Path Chain =</span>
              <span class="bg-primary text-on-primary px-2 py-0.5 rounded font-bold">${formatPct(claim.percentage)}% Effective</span>
            </div>
            <div>
              ${qualUboBadge}
            </div>
          </div>

          <!-- Flags warning if any -->
          ${claim.flags.length > 0 ? `
            <div class="bg-error-container p-2 rounded-md flex items-center justify-between text-xs text-on-error-container">
              <span class="flex items-center gap-1.5"><span class="material-symbols-outlined text-[16px] text-error">flag</span>${claim.flags.map(escapeHtml).join(", ")}</span>
              <button class="px-2 py-1 bg-surface-container-lowest hover:bg-surface-container text-error font-bold rounded text-[10px] btn-resolve-claim" data-claim-id="${claim.id}" data-flag="${escapeHtml(claim.flags[0])}">
                Resolve Flag
              </button>
            </div>` : ''}
        </div>
      </div>
    `;
  }).join("");

  // Attach inspection triggers
  container.querySelectorAll(".btn-inspect-source").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      selectClaim(btn.dataset.claimId);
    });
  });

  // Attach resolve triggers
  container.querySelectorAll(".btn-resolve-claim").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      resolveFlagPrompt(btn.dataset.claimId, btn.dataset.flag);
    });
  });
}

// 2. Render Confirmed UBOs Summary
function renderConfirmedUbos() {
  const container = document.getElementById("confirmed-owners-container");
  if (!container) return;

  if (state.confirmed.length === 0) {
    container.innerHTML = `
      <div class="col-span-2 text-xs text-on-surface-variant p-3 bg-surface-container-low rounded-lg border border-outline-variant/20 text-center">
        No beneficial owners confirmed above the ${state.threshold}% threshold yet. Review and confirm claims to resolve effective ownership paths.
      </div>`;
    return;
  }

  container.innerHTML = state.confirmed.map((item) => `
    <div class="bg-surface-container-low p-2.5 rounded-lg border border-emerald-300 flex items-center justify-between">
      <div class="flex items-center gap-2">
        <div class="w-8 h-8 rounded-full bg-emerald-100 text-emerald-800 flex items-center justify-center font-bold text-xs">
          ${escapeHtml(item.person.slice(0, 2).toUpperCase())}
        </div>
        <div class="flex flex-col">
          <span class="text-xs font-bold text-on-surface">${escapeHtml(item.person)}</span>
          <span class="text-[10px] text-on-surface-variant truncate">Target: ${escapeHtml(item.target)}</span>
        </div>
      </div>
      <div class="text-right">
        <span class="font-mono text-sm font-bold text-emerald-700">${formatPct(item.effectivePercentage)}%</span>
        <span class="block text-[9px] uppercase font-bold text-on-surface-variant">UBO Confirmed</span>
      </div>
    </div>
  `).join("");
}

// 3. Document Citation Viewer Tabs & Lines
function renderDocumentViewerTabs() {
  const tabsContainer = document.getElementById("document-tabs");
  if (!tabsContainer) return;

  document.getElementById("doc-tab-count").textContent = `${state.documents.length} AUDITED FILE${state.documents.length === 1 ? "" : "S"}`;

  if (state.documents.length === 0) {
    tabsContainer.innerHTML = '<span class="text-xs text-on-surface-variant px-2">No documents</span>';
    return;
  }

  if (!activeDocumentId && state.documents.length > 0) {
    activeDocumentId = state.documents[0].id;
  }

  tabsContainer.innerHTML = state.documents.map((doc) => {
    const isActive = doc.id === activeDocumentId;
    const tabClass = isActive ? "doc-tab-btn active" : "doc-tab-btn";
    return `
      <button class="${tabClass} px-2.5 py-1 text-[11px] font-bold rounded-md whitespace-nowrap transition-all" data-doc-id="${doc.id}">
        ${escapeHtml(doc.filename)}
      </button>`;
  }).join("");

  tabsContainer.querySelectorAll(".doc-tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      activeDocumentId = btn.dataset.docId;
      renderDocumentViewerTabs();
      loadActiveDocumentLines();
    });
  });

  loadActiveDocumentLines();
}

async function loadActiveDocumentLines() {
  if (!activeDocumentId) return;
  const doc = state.documents.find((d) => d.id === activeDocumentId);
  if (!doc) return;

  document.getElementById("viewer-doc-title").textContent = doc.filename;
  document.getElementById("viewer-doc-hash").textContent = `SHA256: ${doc.sha256.slice(0, 16)}... · v${doc.version}`;

  try {
    const res = await api(`/api/documents/${encodeURIComponent(activeDocumentId)}/lines`);
    const linesContainer = document.getElementById("viewer-lines-container");
    document.getElementById("viewer-line-count").textContent = `${res.lines.length} lines indexed`;

    const selectedClaim = state.claims.find((c) => c.id === selectedClaimId);
    const highlightedLineId = selectedClaim?.documentId === activeDocumentId ? selectedClaim.lineId : null;

    if (res.lines.length === 0) {
      linesContainer.innerHTML = '<div class="text-center text-on-surface-variant py-8">Empty document.</div>';
      return;
    }

    linesContainer.innerHTML = res.lines.map((line) => {
      const isHighlighted = line.id === highlightedLineId;
      const highlightClass = isHighlighted ? "source-line highlighted" : "source-line";
      return `
        <div class="${highlightClass} flex items-start gap-2" id="line-${escapeHtml(line.id)}">
          <span class="text-[10px] text-on-surface-variant/70 select-none w-5 text-right font-mono flex-shrink-0">${line.lineNumber}</span>
          <span class="flex-1 font-mono text-[11px] break-all">${escapeHtml(line.text) || "&nbsp;"}</span>
        </div>`;
    }).join("");

    if (highlightedLineId) {
      document.getElementById("active-line-indicator").textContent = highlightedLineId;
      document.getElementById(`line-${CSS.escape(highlightedLineId)}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
    } else {
      document.getElementById("active-line-indicator").textContent = "None selected";
    }
  } catch (err) {
    console.error("Failed to load document lines:", err);
  }
}

// Select a claim and sync viewers
function selectClaim(id) {
  selectedClaimId = id;
  const claim = state.claims.find((c) => c.id === id);
  if (!claim) return;

  activeDocumentId = claim.documentId;
  document.getElementById("selected-claim-badge").textContent = `${claim.owner} (${formatPct(claim.percentage)}%)`;

  const acceptBtn = document.getElementById("quick-accept-btn");
  const editBtn = document.getElementById("quick-edit-btn");
  const flagBtn = document.getElementById("quick-flag-btn");

  if (acceptBtn && editBtn && flagBtn) {
    acceptBtn.disabled = false;
    editBtn.disabled = false;
    flagBtn.disabled = false;
  }

  // Update highlight in tree
  document.querySelectorAll("[id^='tree-branch-']").forEach((card) => {
    card.classList.remove("ring-2", "ring-primary", "border-primary");
  });
  const currentCard = document.getElementById(`tree-branch-${id}`);
  if (currentCard) {
    currentCard.classList.add("ring-2", "ring-primary", "border-primary");
  }

  renderDocumentViewerTabs();
}

// 4. Render Field Review Queue (View 2)
function renderFieldReviewQueue() {
  const container = document.getElementById("review-cards-list");
  if (!container) return;

  const pendingClaims = state.claims.filter((c) => c.flags.length === 0);
  document.getElementById("review-pending-badge").textContent = `${pendingClaims.length} Claims`;

  if (pendingClaims.length === 0) {
    container.innerHTML = `
      <div class="text-center text-xs text-on-surface-variant py-8 bg-surface-container-low rounded-lg">
        All claims confirmed or in judgment queue.
      </div>`;
    return;
  }

  container.innerHTML = pendingClaims.map((claim) => {
    const fieldsList = Object.entries(claim.fields).map(([fieldName, fieldStatus]) => {
      let badgeStyle = "badge-pre-filled";
      if (fieldStatus === "accepted") badgeStyle = "badge-accepted";
      if (fieldStatus === "edited") badgeStyle = "badge-edited";
      if (fieldStatus === "rejected") badgeStyle = "badge-rejected";
      if (fieldStatus === "escalated") badgeStyle = "badge-escalated";

      return `
        <div class="flex items-center justify-between p-2 rounded bg-surface-container-lowest border border-outline-variant/20 text-xs">
          <div class="flex flex-col">
            <span class="text-[10px] font-bold text-on-surface-variant uppercase">${escapeHtml(FIELD_LABELS[fieldName] ?? fieldName)}</span>
            <span class="font-mono text-xs font-semibold text-on-surface">${escapeHtml(claim[fieldName])}</span>
          </div>
          <div class="flex items-center gap-1.5">
            <span class="px-2 py-0.5 rounded text-[10px] font-mono font-bold uppercase ${badgeStyle}">${escapeHtml(fieldStatus)}</span>
            <button class="px-2 py-1 rounded bg-surface-container hover:bg-surface-container-high text-on-surface text-[10px] font-bold border border-outline-variant/30 btn-field-edit" data-claim-id="${claim.id}" data-field="${fieldName}">
              Edit
            </button>
          </div>
        </div>`;
    }).join("");

    return `
      <div class="bg-surface-container-low rounded-xl p-3.5 border border-outline-variant/30 flex flex-col gap-2.5">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <span class="material-symbols-outlined text-primary text-[18px]">verified_user</span>
            <h4 class="text-xs font-bold text-on-surface">${escapeHtml(claim.owner)} holds ${formatPct(claim.percentage)}% of ${escapeHtml(claim.targetEntity)}</h4>
          </div>
          <div class="flex items-center gap-1">
            <button class="px-2.5 py-1 bg-primary hover:bg-neutral-800 text-on-primary text-xs font-bold rounded shadow-sm btn-confirm-all" data-claim-id="${claim.id}">
              Confirm All Fields
            </button>
          </div>
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
          ${fieldsList}
        </div>
      </div>
    `;
  }).join("");

  // Attach buttons
  container.querySelectorAll(".btn-confirm-all").forEach((btn) => {
    btn.addEventListener("click", () => reviewClaim(btn.dataset.claimId, "accept"));
  });

  container.querySelectorAll(".btn-field-edit").forEach((btn) => {
    btn.addEventListener("click", () => {
      openEditModal(btn.dataset.claimId, btn.dataset.field);
    });
  });
}

// 5. Render Judgment Queue (View 3)
function renderJudgmentQueue() {
  const container = document.getElementById("judgment-cards-list");
  if (!container) return;

  const flagged = state.claims.filter((c) => c.flags.length > 0 || Object.values(c.fields).includes("escalated"));
  document.getElementById("judgment-queue-badge").textContent = `${flagged.length} Flagged`;

  if (flagged.length === 0) {
    container.innerHTML = `
      <div class="text-center text-xs text-on-surface-variant py-8 bg-surface-container-low rounded-lg">
        <span class="material-symbols-outlined text-[24px] text-emerald-700 block mb-1">check_circle</span>
        Zero quarantined items. No active compliance flags.
      </div>`;
    return;
  }

  container.innerHTML = flagged.map((claim) => `
    <div class="bg-error-container/30 border border-error/40 rounded-xl p-3.5 flex flex-col gap-2.5">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-2">
          <span class="material-symbols-outlined text-error text-[18px]">warning</span>
          <h4 class="text-xs font-bold text-on-surface">${escapeHtml(claim.owner)} (${formatPct(claim.percentage)}% in ${escapeHtml(claim.targetEntity)})</h4>
        </div>
        <span class="bg-error text-on-error text-[10px] font-bold px-2 py-0.5 rounded font-mono">STOPPED</span>
      </div>
      <div class="bg-surface-container-lowest p-2.5 rounded-lg border border-error/30 text-xs">
        <strong class="text-error block mb-1">Reason for Quarantining:</strong>
        <p class="text-on-surface-variant text-[11px] leading-relaxed">${claim.flags.map(escapeHtml).join(", ") || "Field escalation requires human intervention"}</p>
      </div>
      <div class="flex items-center justify-end gap-2 pt-1">
        <button class="px-3 py-1.5 bg-primary text-on-primary text-xs font-bold rounded shadow-sm btn-judgment-resolve" data-claim-id="${claim.id}" data-flag="${escapeHtml(claim.flags[0] ?? 'escalated')}">
          Record Reasoned Resolution
        </button>
      </div>
    </div>
  `).join("");

  container.querySelectorAll(".btn-judgment-resolve").forEach((btn) => {
    btn.addEventListener("click", () => {
      resolveFlagPrompt(btn.dataset.claimId, btn.dataset.flag);
    });
  });
}

// 6. Render MLRO Boundary (View 4)
function renderMlroBoundary() {
  const payloadEl = document.getElementById("mlro-json-payload");
  if (!payloadEl) return;

  const payload = {
    caseId: "KYC-94021",
    targetEntity: "Apex Maritime Holdings Ltd",
    jurisdiction: "GBR",
    ownershipThreshold: state.threshold,
    confirmedBeneficialOwners: state.confirmed,
    statutoryBoundaryNotice: "AI Assistant is a preparation tool only. Risk Rating must be set independently by the statutory MLRO in the case system.",
    immutableAuditEvents: state.audit.length,
    timestamp: new Date().toISOString()
  };

  payloadEl.textContent = JSON.stringify(payload, null, 2);
}

// 7. Render Audit Trail (View 5)
function renderAuditTrail() {
  const tableBody = document.getElementById("audit-table-body");
  if (!tableBody) return;

  document.getElementById("audit-total-badge").textContent = `${state.audit.length} Events`;

  if (state.audit.length === 0) {
    tableBody.innerHTML = '<tr><td colspan="5" class="py-4 text-center text-on-surface-variant">No audit events recorded yet.</td></tr>';
    return;
  }

  tableBody.innerHTML = state.audit.map((evt) => {
    const formattedDate = new Date(evt.timestamp).toISOString().replace("T", " ").replace("Z", "");
    const change = [evt.originalValue, evt.newValue]
      .filter((v) => v !== null && v !== undefined)
      .map((v) => (typeof v === "object" ? JSON.stringify(v) : String(v)));
    const desc = [change.join(" → "), evt.reason].filter(Boolean).join(" · ");

    return `
      <tr class="hover:bg-surface-container-low transition-colors">
        <td class="py-2 px-3 text-on-surface-variant whitespace-nowrap">${formattedDate}</td>
        <td class="py-2 px-3 font-bold text-primary">${escapeHtml(evt.eventType.replaceAll("_", " "))}</td>
        <td class="py-2 px-3 text-on-surface">${escapeHtml(evt.fieldName ?? "—")}</td>
        <td class="py-2 px-3 text-secondary font-bold">${escapeHtml(evt.analystId)}</td>
        <td class="py-2 px-3 text-on-surface leading-tight max-w-md truncate" title="${escapeHtml(desc)}">${escapeHtml(desc || "—")}</td>
      </tr>`;
  }).join("");
}

// 8. Render Pilot Benchmarks (View 6)
function renderPilotBenchmarks() {
  document.getElementById("pilot-total-events").textContent = state.audit.length;
  const edits = state.audit.filter((e) => e.eventType === "field_edited").length;
  document.getElementById("pilot-corrections-count").textContent = edits;
}

// API Decisions
async function reviewClaim(claimId, action, values = {}, reason = "") {
  try {
    await api(`/api/claims/${claimId}/review`, {
      method: "POST",
      body: JSON.stringify({ action, values, reason, analystId: "AC-8821" }),
    });
    await refreshState();
  } catch (err) {
    alert("Error performing review: " + err.message);
  }
}

async function resolveFlagPrompt(claimId, flag) {
  const reason = prompt(`Enter mandatory resolution rationale for flag [${flag}]:`, "Verified by primary registry certificate extract");
  if (!reason || !reason.trim()) return;

  try {
    await api(`/api/claims/${claimId}/resolve-flag`, {
      method: "POST",
      body: JSON.stringify({ flag, reason: reason.trim(), analystId: "AC-8821" }),
    });
    await refreshState();
  } catch (err) {
    alert("Error resolving flag: " + err.message);
  }
}

// Modal Helpers
function openEditModal(claimId, fieldName) {
  const claim = state.claims.find((c) => c.id === claimId);
  if (!claim) return;

  const modal = document.getElementById("edit-modal");
  document.getElementById("edit-claim-id").value = claim.id;
  document.getElementById("edit-field-name").value = fieldName;
  document.getElementById("edit-field-label").textContent = FIELD_LABELS[fieldName] ?? fieldName;
  document.getElementById("edit-original-value").textContent = String(claim[fieldName]);
  document.getElementById("edit-new-value-input").value = String(claim[fieldName]);
  document.getElementById("edit-reason-input").value = "";

  modal.showModal();
}

function initModals() {
  // Edit Modal
  const editModal = document.getElementById("edit-modal");
  document.getElementById("btn-close-edit-modal")?.addEventListener("click", () => editModal.close());
  document.getElementById("btn-cancel-edit")?.addEventListener("click", () => editModal.close());

  document.getElementById("edit-claim-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const claimId = document.getElementById("edit-claim-id").value;
    const fieldName = document.getElementById("edit-field-name").value;
    let newVal = document.getElementById("edit-new-value-input").value;
    const reason = document.getElementById("edit-reason-input").value;

    if (fieldName === "percentage") {
      newVal = Number(newVal);
    }

    const values = { [fieldName]: newVal };
    editModal.close();
    await reviewClaim(claimId, "edit", values, reason);
  });

  // Paste Modal
  const pasteModal = document.getElementById("paste-modal");
  document.getElementById("btn-open-paste-modal")?.addEventListener("click", () => pasteModal.showModal());
  document.getElementById("btn-close-paste-modal")?.addEventListener("click", () => pasteModal.close());
  document.getElementById("btn-cancel-paste")?.addEventListener("click", () => pasteModal.close());

  document.getElementById("paste-register-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const filename = document.getElementById("paste-filename").value;
    const content = document.getElementById("paste-content").value;
    pasteModal.close();

    try {
      await api("/api/documents", {
        method: "POST",
        body: JSON.stringify({ filename, content }),
      });
      await refreshState();
    } catch (err) {
      alert("Error ingesting document: " + err.message);
    }
  });

  // File Upload
  const fileInput = document.getElementById("file-upload-input");
  fileInput?.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    const content = await file.text();

    try {
      await api("/api/documents", {
        method: "POST",
        body: JSON.stringify({ filename: file.name, content }),
      });
      fileInput.value = "";
      await refreshState();
    } catch (err) {
      alert("Error uploading document: " + err.message);
    }
  });

  // Recalculate Button
  const recalcBtn = document.getElementById("btn-recalc");
  recalcBtn?.addEventListener("click", async () => {
    const icon = recalcBtn.querySelector(".material-symbols-outlined");
    icon.classList.add("animate-spin");
    recalcBtn.disabled = true;
    await refreshState();
    setTimeout(() => {
      icon.classList.remove("animate-spin");
      recalcBtn.disabled = false;
    }, 400);
  });

  // Threshold Select
  const threshSelect = document.getElementById("threshold-select");
  threshSelect?.addEventListener("change", () => {
    state.threshold = Number(threshSelect.value);
    render();
  });

  // Release to Case System
  document.getElementById("btn-release-registry")?.addEventListener("click", () => {
    alert("Record successfully attested by Analyst AC-8821 and dispatched to the Case Management System for MLRO risk review.");
  });

  // Quick Action Buttons on Selected Claim
  document.getElementById("quick-accept-btn")?.addEventListener("click", () => {
    if (selectedClaimId) reviewClaim(selectedClaimId, "accept");
  });
  document.getElementById("quick-edit-btn")?.addEventListener("click", () => {
    if (selectedClaimId) openEditModal(selectedClaimId, "owner");
  });
  document.getElementById("quick-flag-btn")?.addEventListener("click", () => {
    if (selectedClaimId) {
      const reason = prompt("Enter reason to escalate this claim to compliance committee:", "Controlling share percentage disputed by offshore filing");
      if (reason && reason.trim()) reviewClaim(selectedClaimId, "escalate", {}, reason.trim());
    }
  });
}

// Initial bootstrap
window.addEventListener("DOMContentLoaded", () => {
  startUtcClock();
  initNavigation();
  initModals();
  refreshState();
});
