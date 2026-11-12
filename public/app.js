const FIELD_LABELS = {
  owner: "Owner",
  percentage: "Percentage",
  targetEntity: "Target entity",
  ownerType: "Owner type",
  controlBasis: "Control basis",
};

let state;
let selectedClaimId;
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[char]));
const formatNumber = (value) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 }).format(value);

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `Request failed (${response.status})`);
  return result;
}

function showError(message) {
  const banner = document.querySelector("#error-banner");
  banner.textContent = message;
  banner.classList.remove("hidden");
}

function clearError() {
  document.querySelector("#error-banner").classList.add("hidden");
}

async function refresh() {
  clearError();
  try {
    state = await api("/api/state");
    render();
  } catch (error) {
    showError(error.message);
  }
}

function render() {
  document.querySelector("#metric-documents").textContent = state.summary.documents;
  document.querySelector("#metric-unverified").textContent = state.summary.unverifiedFields;
  document.querySelector("#metric-flags").textContent = state.summary.flaggedClaims;
  document.querySelector("#metric-owners").textContent = state.summary.confirmedOwners;
  document.querySelector("#metric-threshold").textContent = formatNumber(state.threshold);
  document.querySelector("#map-threshold").textContent = formatNumber(state.threshold);
  document.querySelector("#nav-flag-count").textContent = state.summary.flaggedClaims;
  document.querySelector("#doc-count").textContent = `${state.documents.length} files`;
  renderMap();
  renderDocuments();
  renderReviews();
  renderJudgment();
  renderAudit();
  renderConfirmed();
  renderPilotMetrics();
  if (!selectedClaimId && state.claims.length) selectClaim(state.claims[0].id);
}

function renderMap() {
  const target = document.querySelector("#ownership-map");
  if (!state.confirmed.length) {
    target.innerHTML = '<div class="empty-state">Confirm all claim fields and resolve judgment flags to calculate verified ownership paths.</div>';
    return;
  }
  target.innerHTML = state.confirmed.map((path) => `
    <div class="owner-row">
      <div><strong>${escapeHtml(path.person)}</strong><small>Beneficial owner of ${escapeHtml(path.target)}</small><div class="owner-path">${path.paths.map((route) => escapeHtml(route.join(" → "))).join(" · ")}</div></div>
      <span class="owner-value">${formatNumber(path.effectivePercentage)}%</span>
    </div>
  `).join("");
}

function renderDocuments() {
  const documents = [...state.documents].sort((a, b) => Number(b.current) - Number(a.current));
  document.querySelector("#document-list").innerHTML = documents.map((doc) => `
    <div class="document-row">
      <span class="file-icon">▤</span>
      <div><strong>${escapeHtml(doc.filename)}</strong><small>v${doc.version} · ${doc.pageCount} page${doc.pageCount === 1 ? "" : "s"} · SHA-256 ${escapeHtml(doc.sha256.slice(0, 12))}…</small></div>
      ${doc.current ? '<span class="document-current">CURRENT</span>' : '<span class="state-tag">SUPERSEDED</span>'}
    </div>
  `).join("") || '<div class="empty-state">No documents uploaded yet.</div>';
}

function claimState(claim) {
  const states = Object.values(claim.fields);
  if (states.includes("escalated")) return "Escalated";
  if (states.includes("rejected")) return "Rejected";
  if (states.every((value) => value === "accepted" || value === "edited")) {
    return states.includes("edited") ? "Edited · confirmed" : "Confirmed";
  }
  if (states.includes("edited")) return "Partially edited";
  return "Pre-filled";
}

function claimCard(claim, judgment = false) {
  const stateTag = claimState(claim);
  const fieldStates = Object.values(claim.fields);
  const allConfirmed = fieldStates.every((value) => value === "accepted" || value === "edited");
  const allRejected = fieldStates.every((value) => value === "rejected");
  const actionButtons = claim.flags.length > 0
    ? `<button class="small-button resolve" data-action="resolve" data-claim="${claim.id}">Resolve flag</button>`
    : allRejected
      ? `<button class="small-button" data-action="escalate" data-claim="${claim.id}">Escalate for reconsideration</button>`
    : `<button class="small-button" data-action="edit" data-claim="${claim.id}">Edit</button>
       <button class="small-button danger" data-action="reject" data-claim="${claim.id}">Reject</button>
       ${judgment ? "" : `<button class="small-button" data-action="escalate" data-claim="${claim.id}">Escalate</button>`}
       ${allConfirmed ? "" : `<button class="small-button accept" data-action="accept" data-claim="${claim.id}">Confirm fields</button>`}`;
  const actions = `<button class="small-button" data-action="source" data-claim="${claim.id}">Source</button>${actionButtons}`;
  const fieldStatus = Object.entries(claim.fields).map(([field, value]) => `
    <span>${escapeHtml(FIELD_LABELS[field])}: <b>${escapeHtml(value)}</b></span>
  `).join(" · ");
  return `<div class="review-row">
    <div>
      <div class="claim-title"><strong>${escapeHtml(claim.owner)}</strong><span class="state-tag">${escapeHtml(stateTag)}</span>${claim.flags.map((flag) => `<span class="flag-tag">${escapeHtml(flag)}</span>`).join("")}</div>
      <div class="claim-detail"><b>${formatNumber(claim.percentage)}%</b> of <b>${escapeHtml(claim.targetEntity)}</b> · ${escapeHtml(claim.ownerType)} · ${escapeHtml(claim.controlBasis)}</div>
      <div class="claim-detail">${fieldStatus}</div>
      <button class="claim-source" data-action="source" data-claim="${claim.id}">${escapeHtml(claim.documentName)} · p.${claim.page} · ${escapeHtml(claim.lineId)}</button>
    </div>
    <div class="claim-actions">${actions}</div>
  </div>`;
}

function renderReviews() {
  const claims = state.claims.filter((claim) => claim.flags.length === 0 && !Object.values(claim.fields).includes("escalated"));
  document.querySelector("#review-count").textContent = `${claims.length} claims`;
  document.querySelector("#review-list").innerHTML = claims.map((claim) => claimCard(claim)).join("") || '<div class="empty-state">No standard-review claims. Upload a synthetic .txt share register to begin.</div>';
}

function renderJudgment() {
  const claims = state.claims.filter((claim) => claim.flags.length > 0 || Object.values(claim.fields).includes("escalated"));
  document.querySelector("#judgment-count").textContent = `${claims.length} items`;
  document.querySelector("#judgment-list").innerHTML = claims.map((claim) => claimCard(claim, true)).join("") || '<div class="empty-state">No flagged claims currently require judgment.</div>';
}

function renderAudit() {
  document.querySelector("#audit-count").textContent = `${state.audit.length} events`;
  document.querySelector("#audit-list").innerHTML = state.audit.map((event) => {
    const change = [event.originalValue, event.newValue].filter((value) => value !== null && value !== undefined).map((value) => typeof value === "object" ? JSON.stringify(value) : String(value));
    const description = [change.join(" → "), event.reason].filter(Boolean).join(" · ");
    return `<tr><td>${escapeHtml(new Date(event.timestamp).toLocaleString())}</td><td>${escapeHtml(event.eventType.replaceAll("_", " "))}</td><td>${escapeHtml(event.fieldName ?? "—")}</td><td>${escapeHtml(event.analystId)}</td><td>${escapeHtml(description || "—")}</td></tr>`;
  }).join("") || '<tr><td colspan="5">No audit events.</td></tr>';
}

function renderConfirmed() {
  document.querySelector("#confirmed-list").innerHTML = state.confirmed.map((path) => `
    <div class="review-row"><div><div class="claim-title"><strong>${escapeHtml(path.person)}</strong><span class="state-tag">ANALYST CONFIRMED</span></div>
    <div class="claim-detail">Beneficial owner of ${escapeHtml(path.target)}</div>    <div class="claim-detail">Verified path${path.paths.length > 1 ? "s" : ""}: ${path.paths.map((route) => escapeHtml(route.join(" → "))).join(" · ")}</div></div>
    <span class="owner-value">${formatNumber(path.effectivePercentage)}%</span></div>
  `).join("") || '<div class="empty-state">No analyst-confirmed ownership record is ready for handoff yet.</div>';
}

function renderPilotMetrics() {
  const edits = state.audit.filter((event) => event.eventType === "field_edited").length;
  const decisions = state.audit.filter((event) => event.eventType.startsWith("field_")).length;
  const files = new Map();
  for (const event of state.audit) {
    if (!event.documentId) continue;
    const bucket = files.get(event.documentId) ?? [];
    bucket.push(new Date(event.timestamp).getTime());
    files.set(event.documentId, bucket);
  }
  const durations = [...files.values()].filter((times) => times.length > 1).map((times) => (Math.max(...times) - Math.min(...times)) / 60000);
  const averageMinutes = durations.length ? `${formatNumber(durations.reduce((sum, value) => sum + value, 0) / durations.length)} min` : "—";
  document.querySelector("#pilot-metrics").innerHTML = `
    <div class="pilot-metric"><span class="metric-label">FIELD CORRECTIONS</span><strong>${edits}</strong><small>Edited field events</small></div>
    <div class="pilot-metric"><span class="metric-label">REVIEW EVENTS</span><strong>${decisions}</strong><small>Append-only field decisions</small></div>
    <div class="pilot-metric"><span class="metric-label">AVG. FILE REVIEW</span><strong>${averageMinutes}</strong><small>${durations.length} files with measurable duration</small></div>
  `;
}

async function selectClaim(id) {
  selectedClaimId = id;
  const claim = state.claims.find((entry) => entry.id === id);
  if (!claim) return;
  try {
    const result = await api(`/api/documents/${encodeURIComponent(claim.documentId)}/lines`);
    const source = state.documents.find((document) => document.id === claim.documentId);
    document.querySelector("#source-filename").textContent = source?.filename ?? claim.documentName;
    document.querySelector("#source-page").textContent = `PAGE ${claim.page} · LINE ${escapeHtml(claim.lineId.split("-").at(-1))}`;
    document.querySelector("#source-lines").innerHTML = result.lines
      .filter((line) => line.page === claim.page)
      .map((line) => `<div class="source-line ${line.id === claim.lineId ? "highlight" : ""}" id="line-${escapeHtml(line.id)}"><span class="line-number">${line.lineNumber}</span><span>${escapeHtml(line.text) || "&nbsp;"}</span></div>`)
      .join("");
    document.querySelector(`#line-${CSS.escape(claim.lineId)}`)?.scrollIntoView({ block: "center" });
  } catch (error) {
    showError(error.message);
  }
}

async function reviewClaim(claimId, action) {
  const claim = state.claims.find((entry) => entry.id === claimId);
  if (!claim) return;
  let values;
  let reason = "";
  if (action === "edit") {
    const form = document.querySelector("#edit-form");
    form.elements.claimId.value = claim.id;
    form.elements.owner.value = claim.owner;
    form.elements.percentage.value = claim.percentage;
    form.elements.ownerType.value = claim.ownerType;
    form.elements.targetEntity.value = claim.targetEntity;
    form.elements.controlBasis.value = claim.controlBasis;
    document.querySelector("#edit-dialog").showModal();
    return;
  }
  if (action === "reject" || action === "escalate") {
    reason = window.prompt(`Reason to ${action} this claim:`, "");
    if (reason === null) return;
    if (!reason.trim()) return showError("A reason is required.");
  }
  try {
    await api(`/api/claims/${claimId}/review`, {
      method: "POST",
      body: JSON.stringify({ action, values, reason, analystId: "AC-8821" }),
    });
    await refresh();
  } catch (error) {
    showError(error.message);
  }
}

async function saveEdit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const values = {
    owner: data.get("owner"),
    percentage: Number(data.get("percentage")),
    ownerType: data.get("ownerType"),
    targetEntity: data.get("targetEntity"),
    controlBasis: data.get("controlBasis"),
  };
  const claimId = data.get("claimId");
  try {
    await api(`/api/claims/${claimId}/review`, {
      method: "POST",
      body: JSON.stringify({ action: "edit", values, reason: data.get("reason"), analystId: "AC-8821" }),
    });
    document.querySelector("#edit-dialog").close();
    await refresh();
  } catch (error) {
    showError(error.message);
  }
}

async function resolveFlag(claimId) {
  const claim = state.claims.find((entry) => entry.id === claimId);
  const flag = claim?.flags[0];
  if (!flag) return;
  const reason = window.prompt(`Resolution for “${flag}”:`, "");
  if (reason === null) return;
  if (!reason.trim()) return showError("A reason is required to resolve a flag.");
  try {
    await api(`/api/claims/${claimId}/resolve-flag`, {
      method: "POST",
      body: JSON.stringify({ flag, reason, analystId: "AC-8821" }),
    });
    await refresh();
  } catch (error) {
    showError(error.message);
  }
}

document.querySelectorAll(".nav-link").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".nav-link").forEach((item) => item.classList.toggle("active", item === button));
    document.querySelectorAll(".view-panel").forEach((panel) => panel.classList.add("hidden"));
    document.querySelector(`#view-${button.dataset.view}`).classList.remove("hidden");
    const labels = {
      review: ["Ownership map & review", "Verify source-backed claims before ownership is confirmed."],
      judgment: ["Judgment queue", "Resolve flagged claims before they can enter the confirmed record."],
      audit: ["Audit trail", "Every analyst decision is recorded as an append-only event."],
      confirmed: ["Confirmed ownership record", "Read-only handoff of analyst-confirmed ownership."],
      pilot: ["Pilot metrics", "Quality and review measures calculated from the audit history."],
    };
    document.querySelector("#page-title").textContent = labels[button.dataset.view][0];
    document.querySelector("#page-subtitle").textContent = labels[button.dataset.view][1];
  });
});

document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const { action, claim: claimId } = button.dataset;
  if (action === "source") void selectClaim(claimId);
  if (["accept", "edit", "reject", "escalate"].includes(action)) void reviewClaim(claimId, action);
  if (action === "resolve") void resolveFlag(claimId);
});

document.querySelector("#edit-form").addEventListener("submit", saveEdit);
document.querySelector("#edit-form #save-edit").addEventListener("click", (event) => {
  event.preventDefault();
  document.querySelector("#edit-form").requestSubmit();
});
document.querySelector("#upload-input").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    if (!file.name.toLowerCase().endsWith(".txt")) throw new Error("This synthetic prototype accepts .txt share registers only.");
    const content = await file.text();
    await api("/api/documents", { method: "POST", body: JSON.stringify({ filename: file.name, content }) });
    event.target.value = "";
    await refresh();
  } catch (error) {
    showError(error.message);
  }
});

void refresh();
