(() => {
  "use strict";

  const $ = (selector) => document.querySelector(selector);
  const state = {
    valid: false,
    result: null,
    selected: null,
    traceIndex: 0,
    scenarios: null,
    datasetName: "Synthetic sample data",
    synthetic: true,
    validationRevision: 0,
    authToken: null,
    adminToken: null,
    candidateProfile: null,
    candidateResult: null,
    preferenceIds: [],
    savedPreferenceIds: [],
    simulationPreferenceIds: [],
    scenarioPointerDrag: null,
    chatSession: null,
    externalLLM: false,
    externalConsent: false,
    externalProviderName: "external provider",
    candidateDirty: false,
    profileVersion: null,
    candidatePoll: null,
    adminPoll: null,
    adminStateVersion: null,
    opportunitiesDirty: false,
    dashboardData: null,
    currentBarView: "sector"
  };

  const keysOnly = new Set(["proposal", "competition", "accepted", "displaced", "rejected"]);
  const labels = {
    proposal: "Proposal",
    competition: "Seat competition",
    accepted: "Accepted",
    displaced: "Displaced",
    rejected: "Rejected",
    unmatched: "Unmatched",
    completion: "Complete"
  };
  let toastTimer;

  function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  }
  function fmt(value, digits = 1) { return Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : "—"; }
  function pct(value) { return `${fmt((Number(value) || 0) * 100, 1)}%`; }
  function human(value) { return String(value ?? "").replaceAll("_", " ").replace(/\b\w/g, (c) => c.toUpperCase()); }

  function showToast(message, error = false) {
    const el = $("#toast");
    if (!el) return;
    el.textContent = message;
    el.classList.toggle("error", error);
    el.classList.add("visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("visible"), 4200);
  }

  async function request(url, options = {}) {
    const response = await fetch(url, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || `Request failed (${response.status})`);
    return data;
  }
  async function candidateRequest(url, options = {}) {
    const headers = { ...(options.headers || {}), Authorization: `Bearer ${state.authToken}` };
    return request(url, { ...options, headers });
  }
  async function adminRequest(url, options = {}) {
    const headers = { ...(options.headers || {}), Authorization: `Bearer ${state.adminToken}` };
    return request(url, { ...options, headers });
  }

  function setConnection(ok, text) {
    const el = $("#connection-status");
    if (el) {
      el.textContent = text;
      el.className = `status-pill ${ok ? "status-ready" : "status-error"}`;
    }
  }

  function updateGreeting(role, name = "") {
    const greetingEl = $("#dashboard-greeting");
    const dateStatusEl = $("#dashboard-date-status");
    const avatarEl = $("#user-avatar-initials");
    const nameEl = $("#user-display-name");
    const roleEl = $("#user-role-label");
    const subtitleEl = $("#sidebar-role-subtitle");
    const headerActions = $("#header-action-group");
    const adminNav = $("#admin-sidebar-nav");
    const candNav = $("#candidate-sidebar-nav");

    const today = new Date().toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
    const hour = new Date().getHours();
    const timeOfDay = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";

    if (role === "admin") {
      if (greetingEl) greetingEl.textContent = `${timeOfDay}, Allocator`;
      if (dateStatusEl) dateStatusEl.textContent = `${today} · Allocation Overview & Analytics`;
      if (avatarEl) avatarEl.textContent = "AD";
      if (nameEl) nameEl.textContent = "Administrator";
      if (roleEl) roleEl.textContent = "Allocator";
      if (subtitleEl) subtitleEl.textContent = "Allocation Center";
      if (headerActions) headerActions.hidden = false;
      if (adminNav) adminNav.hidden = false;
      if (candNav) candNav.hidden = true;
    } else if (role === "candidate") {
      const initials = name ? name.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase() : "CA";
      if (greetingEl) greetingEl.textContent = `${timeOfDay}, ${name || "Candidate"}`;
      if (dateStatusEl) dateStatusEl.textContent = `${today} · Candidate Portal & Matching Results`;
      if (avatarEl) avatarEl.textContent = initials;
      if (nameEl) nameEl.textContent = name || "Candidate";
      if (roleEl) roleEl.textContent = "Candidate";
      if (subtitleEl) subtitleEl.textContent = "Candidate Portal";
      if (headerActions) headerActions.hidden = true;
      if (adminNav) adminNav.hidden = true;
      if (candNav) candNav.hidden = false;
    } else {
      if (greetingEl) greetingEl.textContent = "Welcome to FairSeat";
      if (dateStatusEl) dateStatusEl.textContent = `${today} · Sign in to access your workspace`;
      if (avatarEl) avatarEl.textContent = "FS";
      if (nameEl) nameEl.textContent = "Guest";
      if (roleEl) roleEl.textContent = "Visitor";
      if (headerActions) headerActions.hidden = true;
      if (adminNav) adminNav.hidden = true;
      if (candNav) candNav.hidden = true;
    }
  }

  function invalidateValidation() {
    state.validationRevision += 1;
    state.valid = false;
    $("#run-button") && ($("#run-button").disabled = true);
    $("#preview-area") && ($("#preview-area").hidden = true);
    $("#results-section") && ($("#results-section").hidden = true);
    state.result = null;
    state.selected = null;
    $("#trace-count") && ($("#trace-count").textContent = "Run an allocation to load trace");
    $("#operation-cards") && ($("#operation-cards").innerHTML = '<p class="muted small">Run an allocation to inspect operation counts.</p>');
    renderTrace();
    renderBarChart();
    renderDonutChart();
    renderKpiCards(state.dashboardData);
    const msg = $("#validation-message");
    if (msg) {
      msg.className = "validation-message";
      msg.textContent = "Data changed. Validate both CSV files before running.";
    }
  }

  function renderPreview(container, rows) {
    if (!rows.length) { container.innerHTML = '<p class="muted small">No preview rows.</p>'; return; }
    const columns = Object.keys(rows[0]);
    container.innerHTML = `<div class="table-scroll-container"><table><thead><tr>${columns.map((key) => `<th>${esc(key)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${columns.map((key) => `<td>${esc(row[key])}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  }

  function setCsv(candidates, companies, name, synthetic) {
    if ($("#candidates-csv")) $("#candidates-csv").value = candidates;
    if ($("#companies-csv")) $("#companies-csv").value = companies;
    state.datasetName = name || "Uploaded CSV data";
    state.synthetic = Boolean(synthetic);
    if ($("#synthetic-data")) $("#synthetic-data").checked = state.synthetic;
    if ($("#dataset-badge")) $("#dataset-badge").textContent = `${state.datasetName}${state.synthetic ? " · synthetic" : ""}`;
    if ($("#file-status")) $("#file-status").textContent = "CSV data loaded in this browser session.";
    invalidateValidation();
  }

  async function loadSample() {
    const sample = await request("/demo/sample");
    setCsv(sample.candidates_csv, sample.companies_csv, sample.dataset_name, true);
    if (state.adminToken) {
      await validateData();
      showToast("Synthetic sample loaded and validated.");
    } else {
      if ($("#validation-message")) $("#validation-message").textContent = "Sign in as an allocator to validate or run this sample.";
    }
  }

  async function validateData() {
    const revision = state.validationRevision;
    const candidatesCsv = $("#candidates-csv")?.value || "";
    const companiesCsv = $("#companies-csv")?.value || "";
    const message = $("#validation-message");
    if (message) {
      message.className = "validation-message";
      message.textContent = "Checking CSV files with the allocation engine…";
    }
    $("#validate-button") && ($("#validate-button").disabled = true);
    $("#run-button") && ($("#run-button").disabled = true);
    try {
      const data = await adminRequest("/demo/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidates_csv: candidatesCsv, companies_csv: companiesCsv })
      });
      if (revision !== state.validationRevision) return;
      state.valid = true;
      $("#run-button") && ($("#run-button").disabled = false);
      if (message) {
        message.className = "validation-message success";
        message.textContent = "Validation passed. The allocation engine accepted both files.";
      }
      if ($("#preview-counts")) $("#preview-counts").textContent = `${data.candidates} candidates · ${data.companies} opportunities · first ${data.preview_limit} rows shown`;
      if ($("#candidate-preview")) renderPreview($("#candidate-preview"), data.candidate_preview);
      if ($("#company-preview")) renderPreview($("#company-preview"), data.company_preview);
      $("#preview-area") && ($("#preview-area").hidden = false);
      setConnection(true, "Engine ready");
    } catch (error) {
      if (revision !== state.validationRevision) return;
      state.valid = false;
      if (message) {
        message.className = "validation-message error";
        message.textContent = error.message;
      }
      $("#preview-area") && ($("#preview-area").hidden = true);
      setConnection(false, "Check input");
    } finally {
      $("#validate-button") && ($("#validate-button").disabled = false);
    }
  }

  function renderBarChart(type = state.currentBarView) {
    state.currentBarView = type;
    const container = $("#bar-chart-container");
    if (!container) return;

    $("#seg-btn-sector")?.classList.toggle("active", type === "sector");
    $("#seg-btn-score")?.classList.toggle("active", type === "score");
    $("#seg-btn-rank")?.classList.toggle("active", type === "rank");

    if (!state.result || !state.result.candidates || !state.result.candidates.length) {
      container.innerHTML = `
        <div class="chart-empty-state">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>
          </svg>
          <strong>No allocation published yet</strong>
          <p>Run the allocation engine to generate candidate score and sector distributions.</p>
        </div>`;
      return;
    }

    let bars = [];
    if (type === "sector") {
      if ($("#bar-chart-subtitle")) $("#bar-chart-subtitle").textContent = "Placed candidates across sectors";
      const sectors = [...new Set(state.result.candidates.map(c => c.sector).filter(Boolean))].sort();
      bars = sectors.map(sec => {
        const all = state.result.candidates.filter(c => c.sector === sec);
        const matched = all.filter(c => c.allocation?.status === "matched").length;
        return { label: sec, value: matched, total: all.length };
      });
    } else if (type === "score") {
      if ($("#bar-chart-subtitle")) $("#bar-chart-subtitle").textContent = "Fit score distribution across placed candidates";
      const matched = state.result.candidates.filter(c => c.allocation?.status === "matched" && c.allocation?.score != null);
      const tiers = [
        { label: "< 70", min: 0, max: 69.99 },
        { label: "70–79", min: 70, max: 79.99 },
        { label: "80–89", min: 80, max: 89.99 },
        { label: "90–100", min: 90, max: 100 }
      ];
      bars = tiers.map(tier => {
        const count = matched.filter(c => c.allocation.score >= tier.min && c.allocation.score <= tier.max).length;
        return { label: tier.label, value: count, total: count };
      });
    } else if (type === "rank") {
      if ($("#bar-chart-subtitle")) $("#bar-chart-subtitle").textContent = "Placed candidate assignments by preference rank";
      const matched = state.result.candidates.filter(c => c.allocation?.status === "matched");
      const ranks = ["Choice #1", "Choice #2", "Choice #3", "Choice #4+"];
      bars = ranks.map((label, idx) => {
        let count = 0;
        if (idx === 0) count = matched.filter(c => c.allocation?.preference_rank === 1).length;
        else if (idx === 1) count = matched.filter(c => c.allocation?.preference_rank === 2).length;
        else if (idx === 2) count = matched.filter(c => c.allocation?.preference_rank === 3).length;
        else count = matched.filter(c => c.allocation?.preference_rank >= 4).length;
        return { label, value: count, total: count };
      });
    }

    if (!bars.length) {
      container.innerHTML = '<p class="muted small" style="text-align: center; padding: 20px;">No distribution data available</p>';
      return;
    }

    const maxVal = Math.max(1, ...bars.map(b => b.value));
    const svgWidth = 500;
    const svgHeight = 170;
    const paddingBottom = 26;
    const chartHeight = svgHeight - paddingBottom;
    const totalBarSpace = svgWidth / bars.length;
    const barWidth = Math.min(42, Math.max(20, totalBarSpace * 0.55));

    const maxBarIdx = bars.reduce((maxIdx, b, idx, arr) => b.value > arr[maxIdx].value ? idx : maxIdx, 0);

    const svgBars = bars.map((b, i) => {
      const x = i * totalBarSpace + (totalBarSpace - barWidth) / 2;
      const h = Math.max(4, (b.value / maxVal) * (chartHeight - 20));
      const y = chartHeight - h;
      const isPeak = i === maxBarIdx && b.value > 0;
      const fill = isPeak ? "#79D6E5" : "rgba(121, 214, 229, 0.46)";
      return `
        <g class="bar-group" tabindex="0" role="img" aria-label="${esc(b.label)}: ${b.value}">
          <title>${esc(b.label)}: ${b.value}${b.total && b.total !== b.value ? ` (out of ${b.total})` : ""}</title>
          <rect x="${x}" y="10" width="${barWidth}" height="${chartHeight - 10}" rx="6" fill="rgba(219, 237, 247, 0.045)" />
          <rect x="${x}" y="${y}" width="${barWidth}" height="${h}" rx="6" fill="${fill}" />
          <text x="${x + barWidth / 2}" y="${y - 5}" text-anchor="middle" font-size="11" font-weight="700" fill="#E7F0F5">${b.value}</text>
          <text x="${x + barWidth / 2}" y="${svgHeight - 6}" text-anchor="middle" font-size="10" font-weight="600" fill="#9BAEBC">${esc(b.label.slice(0, 10))}</text>
        </g>
      `;
    }).join("");

    container.innerHTML = `
      <svg viewBox="0 0 ${svgWidth} ${svgHeight}" role="img" aria-label="Candidate fit and placement distribution chart">
        <line x1="0" y1="${chartHeight}" x2="${svgWidth}" y2="${chartHeight}" stroke="rgba(219, 237, 247, 0.16)" stroke-width="1" />
        <line x1="0" y1="${chartHeight / 2}" x2="${svgWidth}" y2="${chartHeight / 2}" stroke="rgba(219, 237, 247, 0.075)" stroke-dasharray="4,4" stroke-width="1" />
        ${svgBars}
      </svg>
    `;
  }

  function renderDonutChart() {
    const container = $("#donut-chart-container");
    const legend = $("#donut-legend");
    if (!container) return;

    const s = state.result?.summary;
    if (!s || !s.total_seats) {
      container.innerHTML = `
        <div style="position: relative; width: 140px; height: 140px; margin: 0 auto;">
          <svg viewBox="0 0 100 100" width="140" height="140" role="img" aria-label="Empty seat capacity donut">
            <circle cx="50" cy="50" r="38" fill="none" stroke="rgba(219, 237, 247, 0.16)" stroke-width="13" stroke-dasharray="6,4" />
          </svg>
          <div class="donut-center-metric">
            <strong>0%</strong>
            <small>Awaiting Run</small>
          </div>
        </div>`;
      if (legend) legend.innerHTML = '<span class="muted small" style="text-align: center; width: 100%; display: block;">Run allocation to view capacity</span>';
      return;
    }

    const filled = s.seats_filled || 0;
    const openSeats = Math.max(0, s.total_seats - filled);
    const unmatched = s.unmatched || 0;
    const total = s.total_seats || 1;
    const util = s.capacity_utilization != null ? s.capacity_utilization : (filled / total);

    const radius = 38;
    const circ = 2 * Math.PI * radius;
    const filledOffset = (filled / total) * circ;
    const openOffset = (openSeats / total) * circ;

    container.innerHTML = `
      <div style="position: relative; width: 140px; height: 140px; margin: 0 auto;">
        <svg viewBox="0 0 100 100" width="140" height="140" role="img" aria-label="Seat capacity allocation donut chart">
          <circle cx="50" cy="50" r="${radius}" fill="none" stroke="rgba(219, 237, 247, 0.13)" stroke-width="13" />
          <circle cx="50" cy="50" r="${radius}" fill="none" stroke="#79D6E5" stroke-width="13"
            stroke-dasharray="${filledOffset} ${circ - filledOffset}"
            stroke-dashoffset="${circ * 0.25}"
            stroke-linecap="round" />
          <circle cx="50" cy="50" r="${radius}" fill="none" stroke="#F0C47C" stroke-width="13"
            stroke-dasharray="${openOffset} ${circ - openOffset}"
            stroke-dashoffset="${(circ * 0.25) - filledOffset}"
            stroke-linecap="round" />
        </svg>
        <div class="donut-center-metric">
          <strong>${pct(util)}</strong>
          <small>Capacity</small>
        </div>
      </div>
    `;

    if (legend) {
      legend.innerHTML = `
        <button class="legend-item" data-filter-outcome="matched" type="button" aria-label="Show placed candidates (${filled} filled)">
          <span class="legend-dot" style="background: #22B8F0;"></span>
          <span>Filled: <strong>${filled}</strong></span>
        </button>
        <button class="legend-item" type="button" aria-label="Open seats (${openSeats} open)">
          <span class="legend-dot" style="background: #F59E0B;"></span>
          <span>Open: <strong>${openSeats}</strong></span>
        </button>
        <button class="legend-item" data-filter-outcome="unmatched" type="button" aria-label="Show unmatched candidates (${unmatched} unplaced)">
          <span class="legend-dot" style="background: #EF4444;"></span>
          <span>Unplaced: <strong>${unmatched}</strong></span>
        </button>
      `;

      legend.querySelectorAll("[data-filter-outcome]").forEach(btn => {
        btn.addEventListener("click", () => {
          const outcome = btn.dataset.filterOutcome;
          const select = $("#outcome-filter");
          if (select) {
            select.value = select.value === outcome ? "" : outcome;
            renderCandidateRows();
            $("#results-section")?.scrollIntoView({ behavior: "smooth" });
          }
        });
      });
    }
  }

  function renderKpiCards(dashboard) {
    const container = $("#metric-cards");
    if (!container) return;

    const currentRun = dashboard?.current_run;
    const s = state.result?.summary || (currentRun ? dashboard?.summary : null);
    const history = dashboard?.history || [];
    const hasHistoryDiff = history.length >= 2;
    const prevS = hasHistoryDiff ? history[1]?.summary : null;

    // 1. Total Candidates
    const candCount = s?.candidates ?? dashboard?.candidate_count ?? null;
    const candDelta = (hasHistoryDiff && candCount != null && prevS?.candidates != null)
      ? (candCount - prevS.candidates) : null;

    // 2. Placed Candidates
    const placedCount = s?.assigned != null ? s.assigned : null;
    const placedDelta = (hasHistoryDiff && placedCount != null && prevS?.assigned != null)
      ? (placedCount - prevS.assigned) : null;
    const placedRate = (placedCount != null && candCount) ? pct(placedCount / candCount) : null;

    // 3. Unmatched Candidates
    const unmatchedCount = s?.unmatched != null ? s.unmatched : null;
    const unmatchedDelta = (hasHistoryDiff && unmatchedCount != null && prevS?.unmatched != null)
      ? (unmatchedCount - prevS.unmatched) : null;

    // 4. Opportunities
    const compCount = s?.companies ?? dashboard?.opportunity_count ?? null;
    const compDelta = (hasHistoryDiff && compCount != null && prevS?.companies != null)
      ? (compCount - prevS.companies) : null;

    // 5. Seats Filled
    const seatsFilledText = (s?.seats_filled != null && s?.total_seats)
      ? `${s.seats_filled} / ${s.total_seats}`
      : "—";
    const seatsDelta = (hasHistoryDiff && s?.seats_filled != null && prevS?.seats_filled != null)
      ? (s.seats_filled - prevS.seats_filled) : null;

    // 6. Utilization
    const utilVal = s?.capacity_utilization != null
      ? pct(s.capacity_utilization)
      : "—";
    const utilDelta = (hasHistoryDiff && s?.capacity_utilization != null && prevS?.capacity_utilization != null)
      ? `${((s.capacity_utilization - prevS.capacity_utilization) * 100).toFixed(1)}%` : null;

    // 7. Average Fit Score
    const matched = (state.result?.candidates || []).filter(c => c.allocation?.status === "matched" && c.allocation?.score != null);
    const avgScore = matched.length
      ? fmt(matched.reduce((acc, c) => acc + c.allocation.score, 0) / matched.length, 1)
      : "—";

    // 8. Algorithm Operations
    const ops = state.result?.operation_counts?.queue_pushes ?? state.result?.operation_counts?.proposals ?? "—";

    function renderDelta(diff, inverse = false) {
      if (diff == null || diff === 0) return "";
      const isPos = typeof diff === "number" ? diff > 0 : !String(diff).startsWith("-");
      const isGood = inverse ? !isPos : isPos;
      const sign = (typeof diff === "number" && diff > 0) ? `+${diff}` : String(diff);
      return `<span class="kpi-delta-pill ${isGood ? "positive" : "negative"}">${sign}</span>`;
    }

    const kpis = [
      {
        label: "Total Candidates",
        value: candCount != null ? candCount : "—",
        caption: state.result ? "evaluated in allocation" : "saved profiles in registry",
        delta: renderDelta(candDelta),
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>'
      },
      {
        label: "Placed Candidates",
        value: placedCount != null ? placedCount : "—",
        caption: placedRate ? `${placedRate} placement rate` : "awaiting allocation run",
        delta: renderDelta(placedDelta),
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>'
      },
      {
        label: "Unmatched",
        value: unmatchedCount != null ? unmatchedCount : "—",
        caption: state.result ? "no open acceptable seat" : "awaiting allocation run",
        delta: renderDelta(unmatchedDelta, true),
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>'
      },
      {
        label: "Opportunities",
        value: compCount != null ? compCount : "—",
        caption: state.result ? "active organizations" : "open opportunities in registry",
        delta: renderDelta(compDelta),
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="14" rx="2" ry="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>'
      },
      {
        label: "Seats Filled",
        value: seatsFilledText,
        caption: s ? `${Math.max(0, s.total_seats - s.seats_filled)} remaining open seats` : "awaiting run",
        delta: renderDelta(seatsDelta),
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 11v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3m10 0v8a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1v-7a1 1 0 0 0-1-1h-3m-6-5v14m-4-7h14"/></svg>'
      },
      {
        label: "Seat Utilization",
        value: utilVal,
        caption: s ? "of total available seats" : "capacity unallocated",
        delta: renderDelta(utilDelta),
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>'
      },
      {
        label: "Average Fit Score",
        value: avgScore,
        caption: state.result ? "mean score of placed candidates" : "uncalculated",
        delta: "",
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="7"/><polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88"/></svg>'
      },
      {
        label: "Algorithm Operations",
        value: ops,
        caption: state.result ? "deferred acceptance proposals" : "0 operations recorded",
        delta: "",
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2" ry="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/></svg>'
      }
    ];

    // The allocator dashboard polls for live data. Keep the existing card DOM
    // when the displayed values have not changed so its entrance animation and
    // focus/layout state are not restarted on every poll.
    const renderSignature = JSON.stringify(kpis.map(({ label, value, caption, delta }) => [label, value, caption, delta]));
    if (container.dataset.renderSignature === renderSignature && container.children.length === kpis.length) return;

    container.innerHTML = kpis.map((kpi, idx) => `
      <div class="kpi-card" style="--stagger: ${idx}">
        <div class="kpi-top">
          <div class="kpi-icon-chip">${kpi.icon}</div>
          ${kpi.delta}
        </div>
        <div>
          <div class="kpi-number">${esc(kpi.value)}</div>
          <div class="kpi-label">${esc(kpi.label)}</div>
          <div class="kpi-caption">${esc(kpi.caption)}</div>
        </div>
      </div>
    `).join("");
    container.dataset.renderSignature = renderSignature;
  }

  function renderResults(data) {
    state.result = data;
    state.selected = data.candidates[0]?.id ?? null;
    $("#results-section") && ($("#results-section").hidden = false);
    if ($("#policy-label")) $("#policy-label").textContent = "";
    if ($("#dataset-label")) $("#dataset-label").textContent = data.dataset_name || "Live Allocation Data";

    renderKpiCards(state.dashboardData);
    renderBarChart();
    renderDonutChart();

    const sectors = [...new Set(data.candidates.map((c) => c.sector).filter(Boolean))].sort();
    if ($("#sector-filter")) {
      $("#sector-filter").innerHTML = '<option value="">All sectors</option>' + sectors.map((sector) => `<option value="${esc(sector)}">${esc(sector)}</option>`).join("");
    }
    renderCandidateRows();
    renderCompanies();
    renderOperations();
    initializeTrace();
    $("#results-section")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function filteredCandidates() {
    const q = ($("#candidate-search")?.value || "").trim().toLowerCase();
    const sector = $("#sector-filter")?.value || "";
    const outcome = $("#outcome-filter")?.value || "";
    return (state.result?.candidates || []).filter((c) => (!q || `${c.id} ${c.name}`.toLowerCase().includes(q)) && (!sector || c.sector === sector) && (!outcome || c.allocation.status === outcome));
  }

  function renderCandidateRows() {
    const rows = filteredCandidates();
    const tbody = $("#candidate-rows");
    if (!tbody) return;
    tbody.innerHTML = rows.length ? rows.map((c) => `<tr data-candidate-id="${esc(c.id)}" class="${c.id === state.selected ? "selected" : ""}" tabindex="0"><td class="person-cell"><strong>${esc(c.name)}</strong><small>${esc(c.id)}</small></td><td>${esc(c.sector)}</td><td>${esc(c.location)}</td><td><span class="outcome ${esc(c.allocation.status)}">${human(c.allocation.status)}</span></td><td>${c.allocation.score == null ? "—" : fmt(c.allocation.score)}</td></tr>`).join("") : '<tr><td colspan="5" class="muted">No candidates match these filters.</td></tr>';
    tbody.querySelectorAll("[data-candidate-id]").forEach((row) => {
      const select = () => { state.selected = row.dataset.candidateId; renderCandidateRows(); renderCandidateDetail(); };
      row.addEventListener("click", select);
      row.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(); } });
    });
    renderCandidateDetail();
  }

  function renderCandidateDetail() {
    const c = state.result?.candidates.find((candidate) => candidate.id === state.selected);
    const box = $("#candidate-detail");
    if (!c || !box) return;
    const assignedCompany = state.result.companies.find((co) => co.id === c.allocation.company_id);
    const unmatchedMessages = {
      no_acceptable_opportunities: "No acceptable opportunities were listed for this candidate.",
      no_eligible_opportunities: "No opportunities passed the configured eligibility filters.",
      all_acceptable_opportunities_rejected: "All listed opportunities were filled by candidates with higher company priority.",
    };
    const statusText = c.allocation.status === "matched"
      ? `Placed at ${assignedCompany?.name || c.allocation.company_id}`
      : unmatchedMessages[c.allocation.reason_code] || "No assignment was made under this run's preference and capacity rules.";
    const choices = c.top_choices.length ? c.top_choices.map((choice) => `<div class="choice-card"><div class="choice-top"><strong>${esc(choice.company_name)}</strong><span class="choice-rank">Choice ${choice.preference_rank} · ${human(choice.outcome)}</span></div><div class="score-line"><span>Total ${fmt(choice.breakdown.total)}</span><span>Skills ${fmt(choice.breakdown.skills)}</span><span>CGPA ${fmt(choice.breakdown.cgpa)}</span><span>Sector ${fmt(choice.breakdown.sector)}</span><span>Location ${fmt(choice.breakdown.location)}</span></div><div class="reason">${esc(human(choice.reason_code || "No reason code"))}${choice.company_cutoff_score == null ? "" : ` · cutoff ${fmt(choice.company_cutoff_score)}`}</div>${choice.matched_skills?.length ? `<div class="skills-line" style="margin-top: 6px; font-size: 11px; color: var(--text-muted);">Matched skills: ${esc(choice.matched_skills.join(", "))}</div>` : ""}${choice.missing_skills?.length ? `<div class="skills-line" style="margin-top: 4px; font-size: 11px; color: var(--text-muted);">Skills to build: ${esc(choice.missing_skills.join(", "))}</div>` : ""}</div>`).join("") : '<p class="muted small">No ranked choices were exported.</p>';
    box.innerHTML = `<div class="detail-header"><h3>${esc(c.name)}</h3><div class="detail-subtitle">${esc(c.id)} · ${esc(c.sector)} · ${esc(c.location)}</div></div><div class="allocation-callout"><strong>${esc(statusText)}</strong><span>${esc(human(c.allocation.reason_code || c.allocation.status))}${c.allocation.preference_rank == null ? "" : ` · preference #${c.allocation.preference_rank}`}${c.allocation.score == null ? "" : ` · score ${fmt(c.allocation.score)}`}</span></div><h4 style="margin: 14px 0 8px;">Ranked options and fit</h4><div class="choice-list">${choices}</div>`;
  }

  function renderCompanies() {
    const el = $("#company-cards");
    if (!el || !state.result?.companies) return;
    el.innerHTML = state.result.companies.map((c) => {
      const open = c.seats - c.seats_filled;
      const fill = c.seats ? c.seats_filled / c.seats * 100 : 0;
      return `<div class="company-capacity ${open ? "open" : ""}" style="background: var(--nested-surface); padding: 14px; border-radius: var(--radius-inner); border: 1px solid var(--nested-border);"><strong title="${esc(c.name)}" style="display: block; font-size: 13px;">${esc(c.name)}</strong><small style="color: var(--text-muted); font-size: 11px;">${esc(c.sector)} · ${c.seats_filled}/${c.seats} filled · ${open} open</small><div class="sidebar-progress-track" style="margin: 8px 0 4px;"><span class="sidebar-progress-fill" style="display: block; width:${Math.max(0, Math.min(100, fill))}%"></span></div><small style="color: var(--text-muted); font-size: 11px;">${esc(c.location)}${c.cutoff_score == null ? "" : ` · cutoff ${fmt(c.cutoff_score)}`}</small></div>`;
    }).join("");
  }

  function renderOperations() {
    const el = $("#operation-cards");
    if (!el) return;
    const counts = state.result?.operation_counts || {};
    const entries = Object.entries(counts);
    el.innerHTML = entries.length ? entries.map(([name, value]) => `<div class="operation" style="background: var(--nested-surface); padding: 12px; border-radius: var(--radius-inner); border: 1px solid var(--nested-border); text-align: center;"><strong style="display: block; font-size: 20px; color: var(--text-primary); font-variant-numeric: tabular-nums;">${esc(value)}</strong><span style="font-size: 11px; color: var(--text-muted);">${esc(human(name))}</span></div>`).join("") : '<p class="muted small">No operation counters available for this export.</p>';
  }

  function initializeTrace() {
    const trace = state.result?.allocation_trace || [];
    state.traceIndex = 0;
    const slider = $("#trace-slider");
    if (slider) {
      slider.max = Math.max(0, trace.length - 1);
      slider.disabled = trace.length === 0;
    }
    if ($("#trace-count")) $("#trace-count").textContent = trace.length ? `${trace.length} recorded events` : "No trace events exported";
    renderTrace();
  }

  function visibleTraceIndexes() {
    const trace = state.result?.allocation_trace || [];
    return trace.map((event, index) => ({ event, index })).filter(({ event }) => !$("#trace-filter")?.checked || keysOnly.has(event.type));
  }

  function replayTrace(endIndex) {
    const trace = state.result?.allocation_trace || [], queue = (state.result?.candidates || []).map((c) => c.id), heaps = new Map();
    for (const company of state.result?.companies || []) heaps.set(company.id, []);
    for (let i = 0; i <= endIndex && i < trace.length; i++) {
      const e = trace[i], heap = e.company_id ? heaps.get(e.company_id) : null;
      if (e.type === "proposal") { const at = queue.indexOf(e.candidate_id); if (at >= 0) queue.splice(at, 1); }
      if (e.type === "accepted" && heap) {
        if (e.displaced_candidate_id) { const old = heap.indexOf(e.displaced_candidate_id); if (old >= 0) heap.splice(old, 1); }
        if (!heap.includes(e.candidate_id)) heap.push(e.candidate_id);
      }
      if (e.type === "rejected") { if (!queue.includes(e.candidate_id)) queue.push(e.candidate_id); }
      if (e.type === "displaced") { if (!queue.includes(e.candidate_id)) queue.push(e.candidate_id); }
    }
    return { queue, heaps };
  }

  function renderTrace() {
    const all = state.result?.allocation_trace || [], visible = visibleTraceIndexes(), slider = $("#trace-slider");
    if (!slider) return;
    if (!all.length) {
      if ($("#trace-position")) $("#trace-position").textContent = "No trace yet";
      if ($("#trace-event")) $("#trace-event").innerHTML = "<h3>Run the allocator to inspect its trace</h3><p>Competition and displacement events will appear here.</p>";
      if ($("#trace-queue")) $("#trace-queue").textContent = "No trace loaded";
      if ($("#trace-heaps")) $("#trace-heaps").innerHTML = "";
      slider.disabled = true;
      if ($("#trace-prev")) $("#trace-prev").disabled = true;
      if ($("#trace-next")) $("#trace-next").disabled = true;
      if ($("#jump-displacement")) $("#jump-displacement").disabled = true;
      return;
    }
    if (!visible.length) {
      if ($("#trace-position")) $("#trace-position").textContent = "No key events";
      if ($("#trace-event")) $("#trace-event").innerHTML = "<h3>No key events in the trace</h3><p>Turn off the key events filter to see every recorded step.</p>";
      slider.disabled = true;
      if ($("#trace-prev")) $("#trace-prev").disabled = true;
      if ($("#trace-next")) $("#trace-next").disabled = true;
      if ($("#jump-displacement")) $("#jump-displacement").disabled = true;
      return;
    }
    slider.disabled = false;
    state.traceIndex = Math.min(state.traceIndex, visible.length - 1);
    const item = visible[state.traceIndex], e = item.event;
    slider.max = visible.length - 1;
    slider.value = state.traceIndex;
    if ($("#trace-position")) $("#trace-position").textContent = `Step ${state.traceIndex + 1} of ${visible.length}`;
    if ($("#trace-progress")) $("#trace-progress").textContent = $("#trace-filter")?.checked ? `${all.length} total events · showing key decisions` : `Event ${e.sequence} · ${all.length} total`;
    const candidate = state.result.candidates.find((c) => c.id === e.candidate_id);
    const company = state.result.companies.find((co) => co.id === e.company_id);
    const displaced = state.result.candidates.find((c) => c.id === e.displaced_candidate_id);
    const title = e.type === "competition" ? `${candidate?.name || e.candidate_id} challenges a seat at ${company?.name || e.company_id}` : e.type === "displaced" ? `${candidate?.name || e.candidate_id} returns to the proposal queue` : e.type === "accepted" ? `${candidate?.name || e.candidate_id} holds a seat at ${company?.name || e.company_id}` : e.type === "rejected" ? `${candidate?.name || e.candidate_id} loses this seat` : e.type === "proposal" ? `${candidate?.name || e.candidate_id} proposes to ${company?.name || e.company_id}` : `${candidate?.name || e.candidate_id} · ${human(e.type)}`;
    let explanation = `${human(e.reason_code)} · score ${fmt(e.score)}`;
    if (e.type === "competition") explanation += ` · current weakest holder: ${displaced?.name || e.displaced_candidate_id || "none"}`;
    if (e.type === "accepted" && e.displaced_candidate_id) explanation += ` · replaces ${displaced?.name || e.displaced_candidate_id}`;
    if (e.type === "displaced") explanation += ` · displaced by ${displaced?.name || e.displaced_candidate_id || "a stronger proposal"}`;
    if ($("#trace-event")) {
      $("#trace-event").className = `trace-event ${e.type === "displaced" || e.type === "competition" ? "displacement" : ""}`;
      $("#trace-event").innerHTML = `<span class="event-type" style="display: inline-flex; margin-bottom: 8px; padding: 4px 10px; border-radius: var(--radius-pill); font-size: 10px; font-weight: 800; background: var(--accent-cyan-soft); color: var(--accent-cyan); text-transform: uppercase;">${esc(labels[e.type] || human(e.type))}</span><h3 style="margin: 0 0 6px;">${esc(title)}</h3><p style="margin: 0; color: var(--text-muted); font-size: 13px;">${esc(explanation)}</p>`;
    }
    const replay = replayTrace(item.index);
    if ($("#trace-queue")) {
      $("#trace-queue").className = "token-list";
      $("#trace-queue").innerHTML = replay.queue.length ? replay.queue.map((id) => { const c = state.result.candidates.find((x) => x.id === id); return `<span class="token" style="display: inline-flex; padding: 4px 8px; border-radius: 6px; background: var(--nested-surface); border: 1px solid var(--nested-border); font-size: 11px; font-weight: 600;">${esc(c?.name || id)}</span>`; }).join(" ") : '<span class="empty-note">Queue is empty</span>';
    }
    if ($("#trace-heaps")) {
      $("#trace-heaps").innerHTML = state.result.companies.map((co) => {
        const holders = replay.heaps.get(co.id) || [];
        return `<div class="heap-company" style="background: var(--nested-surface); padding: 10px; border-radius: 8px; border: 1px solid var(--nested-border);"><strong style="display: block; font-size: 11px; margin-bottom: 4px;">${esc(co.name)} <span class="muted">${holders.length}/${co.seats}</span></strong>${holders.length ? holders.map((id) => `<div class="heap-holder" style="font-size: 11px; color: var(--text-secondary);">${esc(state.result.candidates.find((c) => c.id === id)?.name || id)}</div>`).join("") : '<span class="empty-note" style="font-size: 10px;">Empty</span>'}</div>`;
      }).join("");
    }
    if ($("#trace-prev")) $("#trace-prev").disabled = state.traceIndex === 0;
    if ($("#trace-next")) $("#trace-next").disabled = state.traceIndex >= visible.length - 1;
    if ($("#jump-displacement")) $("#jump-displacement").disabled = !visible.some(({ event }, index) => index > state.traceIndex && event.type === "displaced");
  }

  function setTraceIndex(index) {
    state.traceIndex = Math.max(0, index);
    renderTrace();
  }

  async function loadScenarios() {
    const button = $("#load-scenarios");
    if (button) button.disabled = true;
    if ($("#scenario-message")) $("#scenario-message").textContent = "Generating the seeded synthetic report…";
    try {
      state.scenarios = await adminRequest("/demo/scenarios");
      renderScenarios();
    } catch (error) {
      if ($("#scenario-message")) $("#scenario-message").textContent = error.message;
      showToast(error.message, true);
    } finally {
      if (button) button.disabled = false;
    }
  }

  function renderScenarios() {
    const rows = state.scenarios?.rows || [];
    const scenarios = [...new Set(rows.map((row) => row.scenario))];
    if ($("#scenario-message")) $("#scenario-message").textContent = `Seed ${state.scenarios.seed} · ${scenarios.length} scenarios · ${rows.length} cohort summaries · synthetic data only.`;
    $("#scenario-results") && ($("#scenario-results").hidden = false);
    if ($("#scenario-bars")) {
      $("#scenario-bars").innerHTML = scenarios.map((name) => {
        const group = rows.filter((row) => row.scenario === name), a = group.find((row) => row.cohort.endsWith("A")), b = group.find((row) => row.cohort.endsWith("B"));
        const ar = a && Number(a.eligible) ? Number(a.allocated) / Number(a.eligible) : 0, br = b && Number(b.eligible) ? Number(b.allocated) / Number(b.eligible) : 0;
        return `<div class="scenario-row" style="display: grid; grid-template-columns: 180px 1fr; gap: 16px; align-items: center; padding: 10px 0; border-bottom: 1px solid var(--nested-border);"><span class="scenario-name" style="font-weight: 700;">${esc(human(name))}</span><div class="scenario-rates" style="display: grid; gap: 6px;">${[["A", ar, "var(--accent-cyan)"], ["B", br, "var(--status-amber)"]].map(([label, rate, color]) => `<div class="scenario-rate" style="display: flex; align-items: center; gap: 8px;"><span class="cohort-label" style="font-size: 11px; min-width: 60px;">Cohort ${label}</span><div class="sidebar-progress-track" style="flex: 1; margin: 0;"><span class="sidebar-progress-fill" style="background: ${color}; width:${Math.min(100, rate * 100)}%"></span></div><span class="scenario-value" style="font-size: 11px; font-weight: 700; min-width: 45px; text-align: right;">${pct(rate)}</span></div>`).join("")}</div></div>`;
      }).join("");
    }
    if ($("#scenario-rows")) {
      $("#scenario-rows").innerHTML = rows.map((r) => `<tr><td>${esc(human(r.scenario))}</td><td>${esc(r.cohort.replace("synthetic_group_", ""))}</td><td>${esc(r.eligible)}</td><td>${esc(r.allocated)}</td><td>${esc(r.unmatched)}</td><td>${fmt(r.average_score)}</td><td>${esc(r.changed_assignments)}</td><td>${esc(r.seats_filled)}</td></tr>`).join("");
    }
  }

  function activateView(name) {
    if (["workspace", "admin-candidates", "admin-opportunities", "algorithm", "fairness"].includes(name) && !state.adminToken) {
      name = name === "workspace" ? "workspace" : "candidate";
    }
    const nestedAdminView = ["admin-candidates", "admin-opportunities"].includes(name);
    document.querySelectorAll(".tab").forEach((tab) => {
      const active = tab.dataset.view === name;
      tab.classList.toggle("active", active);
      if (active) tab.setAttribute("aria-current", "page");
      else tab.removeAttribute("aria-current");
    });
    document.querySelectorAll(".view").forEach((view) => {
      const active = view.id === `${name}-view` || (view.id === "workspace-view" && nestedAdminView);
      view.classList.toggle("active", active);
      view.hidden = !active;
    });
    const adminOverview = $("#admin-overview-panel");
    if (adminOverview) adminOverview.hidden = nestedAdminView;
    const accountSettings = $("#admin-account-settings");
    if (accountSettings) accountSettings.hidden = name !== "workspace";
  }

  function showMarketingSite() {
    state.authToken = null;
    state.adminToken = null;
    state.candidateProfile = null;
    state.candidateResult = null;
    sessionStorage.removeItem("sae.candidate.token");
    sessionStorage.removeItem("sae.admin.token");
    $(".tabs") && ($(".tabs").hidden = true);
    $("#marketing-site") && ($("#marketing-site").hidden = false);
    $("#auth-screen") && ($("#auth-screen").hidden = true);
    $("#app-shell") && ($("#app-shell").hidden = true);
    $("#auth-role-choice") && ($("#auth-role-choice").hidden = false);
    $("#session-signout") && ($("#session-signout").hidden = true);
    document.querySelectorAll(".view").forEach((view) => { view.hidden = true; view.classList.remove("active"); });
    $("#admin-login-panel") && ($("#admin-login-panel").hidden = true);
    $("#allocator-workspace") && ($("#allocator-workspace").hidden = true);
    $("#candidate-login") && ($("#candidate-login").hidden = true);
    $("#candidate-dashboard") && ($("#candidate-dashboard").hidden = true);
    updateGreeting("guest");
  }

  function showSignIn() {
    $("#marketing-site") && ($("#marketing-site").hidden = true);
    $("#app-shell") && ($("#app-shell").hidden = true);
    $("#auth-screen") && ($("#auth-screen").hidden = false);
    $("#auth-role-choice") && ($("#auth-role-choice").hidden = false);
    $("#candidate-login") && ($("#candidate-login").hidden = true);
    $("#admin-login-panel") && ($("#admin-login-panel").hidden = true);
    const heading = $(".auth-panel > h2");
    const subtitle = $(".auth-panel > .auth-panel-subtitle");
    if (heading) heading.textContent = "Sign in to continue";
    if (subtitle) subtitle.textContent = "Choose the workspace that’s right for you.";
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function chooseRole(role) {
    $("#auth-role-choice") && ($("#auth-role-choice").hidden = true);
    const heading = $(".auth-panel > h2");
    const subtitle = $(".auth-panel > .auth-panel-subtitle");
    if (role === "candidate") {
      if (heading) heading.textContent = "Candidate sign in";
      if (subtitle) subtitle.textContent = "Access your profile, preferences, and allocation result.";
      $("#candidate-login") && ($("#candidate-login").hidden = false);
      $("#admin-login-panel") && ($("#admin-login-panel").hidden = true);
      $("#candidate-dashboard") && ($("#candidate-dashboard").hidden = true);
      await loadDemoProfiles();
    } else {
      if (heading) heading.textContent = "Allocator sign in";
      if (subtitle) subtitle.textContent = "Access allocation controls, cohort insights, and audit tools.";
      $("#admin-login-panel") && ($("#admin-login-panel").hidden = false);
      $("#candidate-login") && ($("#candidate-login").hidden = true);
      $("#allocator-workspace") && ($("#allocator-workspace").hidden = true);
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function setLoginMessage(message, error = false) {
    const el = $("#login-message");
    if (el) {
      el.textContent = message;
      el.className = `validation-message${error ? " error" : ""}`;
    }
  }

  function showCandidateLogin() {
    $("#candidate-login") && ($("#candidate-login").hidden = false);
    $("#candidate-dashboard") && ($("#candidate-dashboard").hidden = true);
    state.candidateProfile = null;
    state.candidateResult = null;
    state.chatSession = null;
  }

  async function signOut() {
    clearInterval(state.candidatePoll);
    state.candidatePoll = null;
    if ($("#candidate-chat-input")) $("#candidate-chat-input").value = "";
    if ($("#chat-messages")) $("#chat-messages").innerHTML = '<div class="chat-bubble assistant">Ask about your result, score, or skill gaps. The assistant can explain the recorded outcome but cannot change it.</div>';
    showCandidateLogin();
    showMarketingSite();
  }

  async function loadDemoProfiles() {
    try {
      const { profiles } = await request("/auth/demo-profiles");
      const list = $("#demo-profile-list");
      if (list) {
        list.innerHTML = profiles.map((profile) => `<button class="demo-profile-choice" type="button" data-demo-email="${esc(profile.email)}"><strong>${esc(profile.display_name)}</strong><span>${esc(profile.email)}</span></button>`).join("");
        list.querySelectorAll("[data-demo-email]").forEach((button) => button.addEventListener("click", () => {
          if ($("#login-email")) $("#login-email").value = button.dataset.demoEmail;
          if ($("#login-password")) $("#login-password").focus();
          list.querySelectorAll("[data-demo-email]").forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
        }));
      }
    } catch (error) {
      setLoginMessage(`Could not load demo profiles: ${error.message}`, true);
    }
  }

  async function openCandidatePortal() {
    try {
      const me = await candidateRequest("/auth/me");
      state.candidateProfile = me.profile;
      const result = await candidateRequest("/me/profile");
      state.candidateResult = result;
      state.chatSession = window.crypto?.randomUUID?.() || `sae-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      renderCandidatePortal();
      state.candidateDirty = false;
      state.profileVersion = result.profile_version;
      $("#candidate-login") && ($("#candidate-login").hidden = true);
      $("#candidate-dashboard") && ($("#candidate-dashboard").hidden = false);
      $("#session-signout") && ($("#session-signout").hidden = false);
      $("#marketing-site") && ($("#marketing-site").hidden = true);
      $("#auth-screen") && ($("#auth-screen").hidden = true);
      $("#app-shell") && ($("#app-shell").hidden = false);
      activateView("candidate");
      updateGreeting("candidate", state.candidateProfile?.name || result.name);

      const health = await request("/health").catch(() => null);
      state.externalLLM = Boolean(health?.external_llm_processing);
      state.externalProviderName = health?.llm_provider === "gemini" ? "Google Gemini" : health?.llm_provider === "groq" ? "Groq" : "external provider";
      state.externalConsent = false;
      if ($("#chat-external-consent")) $("#chat-external-consent").checked = false;
      if ($("#chat-consent-row")) $("#chat-consent-row").hidden = !state.externalLLM;
      if ($("#chat-consent-copy")) $("#chat-consent-copy").textContent = `I understand this question and minimized result facts will be sent to ${state.externalProviderName}.`;
      const providerNotice = health?.privacy_notice || "Assistant provider status is unavailable.";
      const knowledgeNotice = health && !health.kb_chunks ? "The knowledge index is not built yet; answers will be limited to this allocation's recorded facts." : "The knowledge index is ready for source-backed answers.";
      if ($("#chat-provider-notice")) $("#chat-provider-notice").textContent = `${providerNotice} ${knowledgeNotice}`;

      clearInterval(state.candidatePoll);
      state.candidatePoll = setInterval(async () => {
        if (!state.authToken) return;
        try {
          const latest = await candidateRequest("/me/profile");
          const versionChanged = latest.profile_version !== state.profileVersion;
          const resultChanged = latest.run_id !== state.candidateResult?.run_id || latest.allocation_state?.version !== state.candidateResult?.allocation_state?.version;
          if (versionChanged || resultChanged) {
            const edited = state.candidateDirty ? {
              cgpa: $("#profile-cgpa")?.value,
              sector: $("#profile-sector")?.value,
              location: $("#profile-location")?.value,
              skills: $("#profile-skills")?.value,
              qualifications: $("#profile-qualifications")?.value,
              preferred_locations: $("#profile-locations")?.value,
              sector_interests: $("#profile-sectors")?.value,
              preferenceIds: [...state.preferenceIds],
            } : null;
            state.candidateResult = latest;
            if (!state.candidateDirty) state.profileVersion = latest.profile_version;
            renderCandidatePortal();
            if (edited) {
              if ($("#profile-cgpa")) $("#profile-cgpa").value = edited.cgpa;
              if ($("#profile-sector")) $("#profile-sector").value = edited.sector;
              if ($("#profile-location")) $("#profile-location").value = edited.location;
              if ($("#profile-skills")) $("#profile-skills").value = edited.skills;
              if ($("#profile-qualifications")) $("#profile-qualifications").value = edited.qualifications;
              if ($("#profile-locations")) $("#profile-locations").value = edited.preferred_locations;
              if ($("#profile-sectors")) $("#profile-sectors").value = edited.sector_interests;
              state.preferenceIds = edited.preferenceIds;
              state.candidateDirty = true;
              renderPreferenceEditor(latest.all_opportunities || []);
              if (versionChanged) {
                const msg = $("#profile-save-message");
                if (msg) {
                  msg.textContent = "Your profile changed in another session. Reload the page before saving these edits.";
                  msg.classList.add("error");
                }
              }
            }
          }
        } catch (error) {
          if (/sign in|expired/i.test(error.message)) await signOut();
        }
      }, 4000);
    } catch (error) {
      if (/sign in|expired/i.test(error.message)) {
        sessionStorage.removeItem("sae.candidate.token");
        state.authToken = null;
      }
      $("#marketing-site") && ($("#marketing-site").hidden = true);
      $("#auth-screen") && ($("#auth-screen").hidden = false);
      $("#app-shell") && ($("#app-shell").hidden = true);
      $("#auth-role-choice") && ($("#auth-role-choice").hidden = true);
      showCandidateLogin();
      setLoginMessage(error.message, true);
    }
  }

  function setAdminLoginMessage(message, error = false) {
    const el = $("#admin-login-message");
    if (el) {
      el.textContent = message;
      el.className = `validation-message${error ? " error" : ""}`;
    }
  }

  async function openAllocatorWorkbench() {
    try {
      const me = await adminRequest("/auth/me");
      if (me.profile.role !== "admin") throw new Error("Allocator sign-in is required.");
      $("#marketing-site") && ($("#marketing-site").hidden = true);
      $("#auth-screen") && ($("#auth-screen").hidden = true);
      $("#app-shell") && ($("#app-shell").hidden = false);
      $(".tabs") && ($(".tabs").hidden = false);
      activateView("workspace");
      $("#session-signout") && ($("#session-signout").hidden = false);
      $("#admin-login-panel") && ($("#admin-login-panel").hidden = true);
      $("#allocator-workspace") && ($("#allocator-workspace").hidden = false);
      document.querySelectorAll("[data-admin-only]").forEach((tab) => { tab.hidden = false; });
      updateGreeting("admin");
      await loadAdminAccounts();
      await loadAdminWorkspace();
      await loadAdminCandidates();
      await loadAdminOpportunities();
      clearInterval(state.adminPoll);
      state.adminPoll = setInterval(() => loadAdminWorkspace().catch(() => {}), 4000);
    } catch (error) {
      sessionStorage.removeItem("sae.admin.token");
      state.adminToken = null;
      $("#marketing-site") && ($("#marketing-site").hidden = true);
      $("#auth-screen") && ($("#auth-screen").hidden = false);
      $("#app-shell") && ($("#app-shell").hidden = true);
      $("#auth-role-choice") && ($("#auth-role-choice").hidden = true);
      $("#admin-login-panel") && ($("#admin-login-panel").hidden = false);
      $("#allocator-workspace") && ($("#allocator-workspace").hidden = true);
      document.querySelectorAll("[data-admin-only]").forEach((tab) => { tab.hidden = true; });
      setAdminLoginMessage(error.message, true);
    }
  }

  async function loadAdminAccounts() {
    const data = await adminRequest("/admin/accounts");
    const candidates = data.accounts.filter((account) => account.role === "candidate");
    const tbody = $("#admin-account-rows");
    if (tbody) {
      tbody.innerHTML = candidates.map((account) => `<tr><td>${esc(account.email)}</td><td>${esc(account.display_name)}</td><td>${esc(account.candidate_id)}</td><td>${account.active ? "Active" : "Disabled"}</td><td><button class="button button-secondary account-status-button" data-email="${esc(account.email)}" data-active="${account.active ? "false" : "true"}" type="button">${account.active ? "Deactivate" : "Activate"}</button></td></tr>`).join("") || '<tr><td colspan="5" class="muted">No candidate accounts yet.</td></tr>';
      tbody.querySelectorAll(".account-status-button").forEach((button) => button.addEventListener("click", async () => {
        try {
          await adminRequest(`/admin/accounts/${encodeURIComponent(button.dataset.email)}/status`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ active: button.dataset.active === "true" }),
          });
          await loadAdminAccounts();
          await loadDemoProfiles();
          setAdminAccountMessage("Account status updated; prior sessions were revoked.");
        } catch (error) { setAdminAccountMessage(error.message, true); }
      }));
    }
    const selectable = candidates.filter((account) => account.active);
    if ($("#reset-account-email")) {
      $("#reset-account-email").innerHTML = selectable.map((account) => `<option value="${esc(account.email)}">${esc(account.display_name)} · ${esc(account.email)}</option>`).join("");
    }
  }

  async function loadAdminWorkspace() {
    const [dashboard, current] = await Promise.all([
      adminRequest("/admin/dashboard"),
      adminRequest("/admin/allocations/current"),
    ]);
    state.dashboardData = dashboard;
    const allocationState = dashboard.allocation_state;
    const priorVersion = state.adminStateVersion;
    state.adminStateVersion = allocationState.version;
    const currentRun = dashboard.current_run;

    if ($("#admin-allocation-status")) {
      $("#admin-allocation-status").textContent = currentRun
        ? `Published ${new Date(currentRun.created_at + "Z").toLocaleString()}`
        : ({ reset: "Reset · awaiting next run", profile_updated: "Profile changed · run again",
             opportunities_updated: "Opportunity details changed · run again" }[allocationState.status] || "Not allocated yet");
    }

    // Sidebar real counters and quota progress widget
    if ($("#sidebar-badge-candidates")) $("#sidebar-badge-candidates").textContent = dashboard.candidate_count ?? "—";
    if ($("#sidebar-badge-opportunities")) $("#sidebar-badge-opportunities").textContent = dashboard.opportunity_count ?? "—";

    const hasCurrentRun = Boolean(current?.run_id);
    const s = hasCurrentRun ? current.summary : dashboard.summary;
    if (s && s.total_seats) {
      if ($("#sidebar-quota-text")) $("#sidebar-quota-text").textContent = `${s.seats_filled || 0} / ${s.total_seats}`;
      const util = s.capacity_utilization != null ? s.capacity_utilization : (s.seats_filled / s.total_seats);
      if ($("#sidebar-quota-bar")) $("#sidebar-quota-bar").style.width = pct(util);
    } else {
      if ($("#sidebar-quota-text")) $("#sidebar-quota-text").textContent = "— / —";
      if ($("#sidebar-quota-bar")) $("#sidebar-quota-bar").style.width = "0%";
    }
    if ($("#sidebar-policy-text")) $("#sidebar-policy-text").textContent = "FairSeat Allocation Engine";

    // Render KPI Cards and Charts
    renderKpiCards(dashboard);
    if (hasCurrentRun) {
      if (state.result?.run_id !== current.run_id) renderResults(current);
      if (state.result && !state.result.run_id) state.result.run_id = current.run_id;
    } else {
      state.result = null;
      state.selected = null;
      if ($("#results-section")) $("#results-section").hidden = true;
      renderBarChart();
      renderDonutChart();
    }

    if ($("#allocation-history-rows")) {
      $("#allocation-history-rows").innerHTML = dashboard.history.length ? dashboard.history.map((run) => `<tr><td><code>${esc(run.run_id.slice(0, 8))}</code></td><td>${esc(new Date(run.created_at + "Z").toLocaleString())}</td><td>${esc(run.created_by)}</td><td>${esc(run.summary?.assigned ?? "—")}</td><td>${esc(run.summary?.unmatched ?? "—")}</td></tr>`).join("") : '<tr><td colspan="5" class="muted">No allocation runs yet.</td></tr>';
    }

    if ($("#admin-reset-allocation")) $("#admin-reset-allocation").disabled = !currentRun;

    if (priorVersion != null && priorVersion !== allocationState.version) {
      await loadAdminCandidates();
      if (!state.opportunitiesDirty) await loadAdminOpportunities();
      else {
        const msg = $("#opportunity-save-message");
        if (msg) {
          msg.textContent = "Shared records changed while you were editing. Reload before saving.";
          msg.classList.add("error");
        }
      }
    }
  }

  async function loadAdminCandidates() {
    const data = await adminRequest("/admin/candidates");
    const tbody = $("#admin-candidates-rows");
    if (!tbody) return;
    tbody.innerHTML = data.candidates.map((c) => {
      const placement = c.allocation?.company_id ? `Assigned · ${c.allocation_company || c.allocation.company_id}` : c.allocation_status === "current" ? "Unmatched" : "Not allocated";
      return `<tr><td><strong>${esc(c.name)}</strong><small>${esc(c.candidate_id)} · ${esc(c.email || "no account")}</small></td><td>${esc(c.sector)}</td><td>${esc(c.location)}</td><td>${c.preferences.length ? c.preferences.map((item) => esc(item.name)).join(" → ") : "No eligible opportunities"}</td><td>${esc(placement)}</td></tr>`;
    }).join("") || '<tr><td colspan="5" class="muted">No candidate profiles.</td></tr>';
  }

  let opportunityVersion = null;
  async function loadAdminOpportunities() {
    const data = await adminRequest("/admin/opportunities");
    opportunityVersion = data.version;
    state.adminOpportunities = data.opportunities;
    state.opportunitiesDirty = false;
    const tbody = $("#admin-opportunity-rows");
    if (tbody) {
      tbody.innerHTML = data.opportunities.map((o) => `<tr data-opportunity-id="${esc(o.id)}"><td><strong>${esc(o.name)}</strong><small>${esc(o.id)}</small></td><td><input data-field="sector" value="${esc(o.sector)}" aria-label="${esc(o.name)} sector"></td><td><input data-field="location" value="${esc(o.location)}" aria-label="${esc(o.name)} location"></td><td><input data-field="seats" type="number" min="0" value="${esc(o.seats)}" aria-label="${esc(o.name)} seats"></td><td><input data-field="required_skills" value="${esc(o.required_skills.join(", "))}" aria-label="${esc(o.name)} required skills"></td><td><input data-field="required_qualifications" value="${esc(o.required_qualifications.join(", "))}" aria-label="${esc(o.name)} required qualifications"></td></tr>`).join("");
    }
  }

  function setAdminAccountMessage(message, error = false) {
    const el = $("#admin-account-message");
    if (el) {
      el.textContent = message;
      el.className = `validation-message${error ? " error" : ""}`;
    }
  }

  async function adminSignOut() {
    clearInterval(state.adminPoll);
    state.adminPoll = null;
    document.querySelectorAll("[data-admin-only]").forEach((tab) => { tab.hidden = true; });
    showMarketingSite();
    setAdminLoginMessage("Allocator signed out.");
  }

  async function changePassword(requestFn, currentId, nextId, messageId, storageKey, role) {
    const message = $(messageId);
    if (message) message.textContent = "Updating password…";
    try {
      const data = await requestFn("/auth/password", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ current_password: $(currentId).value, new_password: $(nextId).value }),
      });
      if (role === "admin") { state.adminToken = data.access_token; sessionStorage.setItem(storageKey, state.adminToken); }
      else { state.authToken = data.access_token; sessionStorage.setItem(storageKey, state.authToken); }
      $(currentId).value = "";
      $(nextId).value = "";
      if (message) message.textContent = "Password changed. Other active tokens for this account were revoked.";
    } catch (error) {
      if (message) {
        message.textContent = error.message;
        message.classList.add("error");
      }
    }
  }

  function splitList(text) {
    return [...new Set(String(text || "").split(/[;,]/).map((item) => item.trim()).filter(Boolean))];
  }

  function showCandidateProfile(profile) {
    if ($("#candidate-name")) $("#candidate-name").textContent = profile.name;
    if ($("#candidate-subtitle")) $("#candidate-subtitle").textContent = `${state.candidateProfile?.email || ""} · ${profile.sector} · ${profile.location}`;
    if ($("#profile-name")) $("#profile-name").value = profile.name;
    if ($("#profile-cgpa")) $("#profile-cgpa").value = profile.cgpa;
    if ($("#profile-sector")) $("#profile-sector").value = profile.sector;
    if ($("#profile-location")) $("#profile-location").value = profile.location;
    if ($("#profile-skills")) $("#profile-skills").value = profile.skills.join(", ");
    if ($("#profile-qualifications")) $("#profile-qualifications").value = profile.qualifications.join(", ");
    if ($("#profile-locations")) $("#profile-locations").value = profile.preferred_locations.join(", ");
    if ($("#profile-sectors")) $("#profile-sectors").value = profile.sector_interests.join(", ");

    const profileMessage = $("#profile-save-message");
    if (profileMessage) {
      profileMessage.className = "validation-message";
      profileMessage.textContent = `Profile version ${profile.profile_version} · last saved ${profile.updated_at}`;
    }

    state.preferenceIds = (profile.preferences || []).map((item) => item.id);
    state.savedPreferenceIds = [...state.preferenceIds];
    if ($("#preferences-mode")) {
      $("#preferences-mode").textContent = profile.preferences_are_automatic
        ? "Showing the current automatic score ranking. Save your edited order to use it as your preference list."
        : "Your saved preference order will be used for the next allocation.";
    }
    renderPreferenceEditor(profile.all_opportunities || []);

    const status = $("#candidate-allocation-status");
    if (status) {
      status.innerHTML = `<p class="sidebar-group-label" style="padding: 0; margin-bottom: 4px;">ALLOCATION STATUS</p><h3 style="margin: 0 0 4px; font-size: 20px; font-weight: 800;">${profile.allocation_status === "allocated" ? "Result Available" : "Not Allocated Yet"}</h3><p style="margin: 0; color: var(--text-muted);">${esc(profile.allocation_message || "Your profile is saved and ready for the next allocation.")}</p>`;
    }
    if ($("#candidate-allocation-details")) {
      $("#candidate-allocation-details").hidden = profile.allocation_status !== "allocated";
    }
  }

  function renderPreferenceEditor(opportunities = state.candidateResult?.all_opportunities || []) {
    const byId = new Map(opportunities.map((item) => [item.id, item]));
    const list = $("#candidate-preferences");
    if (list) {
      list.innerHTML = state.preferenceIds.length ? state.preferenceIds.map((id, index) => {
        const item = byId.get(id);
        return `<li class="preference-item"><div><strong>${index + 1}. ${esc(item?.name || id)}</strong><span>${esc(item?.sector || "")} · ${esc(item?.location || "")}</span></div><div class="preference-actions"><button type="button" data-pref-action="up" data-pref-index="${index}" aria-label="Move ${esc(item?.name || id)} up" ${index === 0 ? "disabled" : ""}>↑</button><button type="button" data-pref-action="down" data-pref-index="${index}" aria-label="Move ${esc(item?.name || id)} down" ${index === state.preferenceIds.length - 1 ? "disabled" : ""}>↓</button><button type="button" data-pref-action="remove" data-pref-index="${index}" aria-label="Remove ${esc(item?.name || id)}">Remove</button></div></li>`;
      }).join("") : '<li class="muted small" style="padding: 12px;">No opportunities in your preference list yet. Add one below.</li>';
    }

    const select = $("#preference-opportunity");
    if (select) {
      const available = opportunities.filter((item) => !state.preferenceIds.includes(item.id));
      select.innerHTML = available.length ? available.map((item) => `<option value="${esc(item.id)}">${esc(item.name)} · ${esc(item.sector)}</option>`).join("") : '<option value="">All opportunities are already listed</option>';
      select.disabled = available.length === 0;
    }

    const dirty = state.preferenceIds.join("|") !== state.savedPreferenceIds.join("|");
    if ($("#save-preferences")) $("#save-preferences").disabled = !dirty;
    const saveMsg = $("#preferences-save-message");
    if (saveMsg) {
      saveMsg.className = "validation-message";
      if (dirty) saveMsg.textContent = "Unsaved preference changes.";
    }
  }

  function renderCandidatePortal() {
    const result = state.candidateResult;
    if (!result) return;
    showCandidateProfile(result);
    if (result.allocation_status !== "allocated") return;

    state.simulationPreferenceIds = [...state.preferenceIds];
    renderCandidateReplay(result);
    renderPreferenceScenario();

    const allocation = result.allocation;
    const matched = allocation.status === "matched";
    const company = result.assigned_company;
    if ($("#candidate-policy")) $("#candidate-policy").textContent = "Official match result from latest allocation";

    const outcome = matched ? `Matched${company ? ` · ${company.name}` : ""}` : "Unmatched in this run";
    const cards = [
      ["Outcome", outcome],
      ["Preference rank", allocation.preference_rank ? `#${allocation.preference_rank}` : "No placement"],
      ["Fit score", allocation.score == null ? "Not assigned" : fmt(allocation.score)],
      ["Allocation Status", matched ? "Placement Confirmed" : "Active Pool"],
    ];
    if ($("#candidate-outcome")) {
      $("#candidate-outcome").innerHTML = cards.map(([label, value]) => `<div class="candidate-outcome-card"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`).join("");
    }

    const summary = result.explanation || {};
    const choices = summary.choices || [];
    const overall = matched
      ? `You were placed${company ? ` at ${company.name}` : ""}${allocation.preference_rank ? ` at preference rank ${allocation.preference_rank}` : ""}. This is the outcome recorded for this run.`
      : "No placement was recorded for this run. The comparison below shows outcomes for your listed opportunities; this does not by itself mean you failed an official eligibility check.";

    const choiceHtml = choices.length ? choices.map((choice) => {
      const reason = choice.outcome === "lost_seat"
        ? (choice.points_short == null ? "The opportunity was filled under this run's priority rules." : `The final cutoff was ${fmt(choice.company_cutoff_score)}; your score was ${fmt(choice.score)} (${fmt(choice.points_short)} points below).`)
        : choice.outcome === "matched" ? "This was the opportunity assigned to you."
          : "This opportunity was not reached under your preference order and final assignment.";
      const parts = choice.breakdown || {};
      return `<article class="candidate-choice" style="background: var(--nested-surface); padding: 14px; border-radius: var(--radius-inner); border: 1px solid var(--nested-border); margin-bottom: 8px;"><div class="candidate-choice-head" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;"><strong>${esc(choice.company_name)}</strong><span style="font-size: 11px; color: var(--text-muted);">Choice ${esc(choice.preference_rank)} · ${esc(human(choice.outcome))}</span></div><p style="margin: 0 0 6px; font-size: 13px; color: var(--text-secondary);">${esc(reason)}</p><p style="margin: 0; font-size: 11px; color: var(--text-muted);">Fit ${fmt(choice.score)} · skills ${fmt(parts.skills)} · CGPA ${fmt(parts.cgpa)} · sector ${fmt(parts.sector)} · location ${fmt(parts.location)}</p></article>`;
    }).join("") : '<p class="muted small">No opportunity comparison was included in this allocation export.</p>';

    if ($("#candidate-result-detail")) {
      $("#candidate-result-detail").innerHTML = `<div class="allocation-callout"><strong>${esc(outcome)}</strong><span>${esc(overall)}</span></div><div class="candidate-choice-list">${choiceHtml}</div>`;
    }

    const missing = result.skill_gap?.missing_ranked || [];
    if ($("#candidate-skill-gap")) {
      $("#candidate-skill-gap").innerHTML = missing.length
        ? `<div class="skill-gap-list" style="display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px;">${missing.slice(0, 8).map((item) => `<span class="skill-gap-chip" style="padding: 4px 10px; border-radius: var(--radius-pill); background: var(--accent-cyan-soft); color: var(--accent-cyan); font-size: 12px; font-weight: 600;">${esc(item.skill)} · ${esc(item.needed_by_companies)} ${Number(item.needed_by_companies) === 1 ? "opportunity" : "opportunities"}</span>`).join("")}</div>`
        : '<p class="muted small">No ranked missing skills were found for the listed opportunities.</p>';
    }
  }

  function replayEventCopy(event, preferences) {
    const company = event.company || "this opportunity";
    const rank = preferences.findIndex((item) => item.id === event.company_id) + 1;
    const choice = rank > 0 ? ` (choice ${rank})` : "";
    switch (event.type) {
      case "proposal": return `You were considered for ${company}${choice}.`;
      case "accepted": return `${company} held a seat for you at this stage.`;
      case "competition": return `${company} compared your score with its current seat holder.`;
      case "rejected": return `${company} kept its seat under the published priority rules.`;
      case "displaced": return `A higher-priority proposal later took the seat at ${company}; you continued to your next choice.`;
      case "unmatched": return "You had no further acceptable opportunities to propose to.";
      case "completion": return "The allocation run recorded your final outcome.";
      default: return `The allocation process recorded ${human(event.type).toLowerCase()} for ${company}.`;
    }
  }


(() => {
  "use strict";

  const $ = (selector) => document.querySelector(selector);
  const state = { valid: false, result: null, selected: null, traceIndex: 0, scenarios: null, datasetName: "Synthetic sample data", synthetic: true, validationRevision: 0, authToken: null, adminToken: null, candidateProfile: null, candidateResult: null, preferenceIds: [], savedPreferenceIds: [], chatSession: null, externalLLM: false, externalConsent: false, externalProviderName: "external provider", candidateDirty: false, profileVersion: null, candidatePoll: null, adminPoll: null, adminStateVersion: null, opportunitiesDirty: false };
  const keysOnly = new Set(["proposal", "competition", "accepted", "displaced", "rejected"]);
  const labels = { proposal: "Proposal", competition: "Seat competition", accepted: "Accepted", displaced: "Displaced", rejected: "Rejected", unmatched: "Unmatched", completion: "Complete" };
  let toastTimer;

  function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  }
  function fmt(value, digits = 1) { return Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : "—"; }
  function pct(value) { return `${fmt((Number(value) || 0) * 100, 1)}%`; }
  function human(value) { return String(value ?? "").replaceAll("_", " ").replace(/\b\w/g, (c) => c.toUpperCase()); }
  function showToast(message, error = false) {
    const el = $("#toast"); el.textContent = message; el.classList.toggle("error", error); el.classList.add("visible");
    clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove("visible"), 4200);
  }
  async function request(url, options = {}) {
    const response = await fetch(url, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || `Request failed (${response.status})`);
    return data;
  }
  async function candidateRequest(url, options = {}) {
    const headers = { ...(options.headers || {}), Authorization: `Bearer ${state.authToken}` };
    return request(url, { ...options, headers });
  }
  async function adminRequest(url, options = {}) {
    const headers = { ...(options.headers || {}), Authorization: `Bearer ${state.adminToken}` };
    return request(url, { ...options, headers });
  }
  function setConnection(ok, text) {
    const el = $("#connection-status"); el.textContent = text; el.className = `status-pill ${ok ? "status-ready" : "status-error"}`;
  }
  function invalidateValidation() {
    state.validationRevision += 1;
    state.valid = false; $("#run-button").disabled = true; $("#preview-area").hidden = true;
    $("#results-section").hidden = true;
    state.result = null; state.selected = null;
    $("#trace-count").textContent = "Run an allocation to load trace";
    $("#operation-cards").innerHTML = '<p class="muted small">Run an allocation to inspect operation counts.</p>';
    renderTrace();
    $("#validation-message").className = "validation-message";
    $("#validation-message").textContent = "Data changed. Validate both CSV files before running.";
  }
  function renderPreview(container, rows) {
    if (!rows.length) { container.innerHTML = '<p class="muted small">No preview rows.</p>'; return; }
    const columns = Object.keys(rows[0]);
    container.innerHTML = `<table><thead><tr>${columns.map((key) => `<th>${esc(key)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${columns.map((key) => `<td>${esc(row[key])}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  }
  function setCsv(candidates, companies, name, synthetic) {
    $("#candidates-csv").value = candidates; $("#companies-csv").value = companies;
    state.datasetName = name || "Uploaded CSV data"; state.synthetic = Boolean(synthetic);
    $("#synthetic-data").checked = state.synthetic;
    $("#dataset-badge").textContent = `${state.datasetName}${state.synthetic ? " · synthetic" : ""}`;
    $("#file-status").textContent = "CSV data loaded in this browser session.";
    invalidateValidation();
  }
  async function loadSample() {
    const sample = await request("/demo/sample"); setCsv(sample.candidates_csv, sample.companies_csv, sample.dataset_name, true);
    if (state.adminToken) { await validateData(); showToast("Synthetic sample loaded and validated."); }
    else { $("#validation-message").textContent = "Sign in as an allocator to validate or run this sample."; }
  }
  async function validateData() {
    const revision = state.validationRevision;
    const candidatesCsv = $("#candidates-csv").value;
    const companiesCsv = $("#companies-csv").value;
    const message = $("#validation-message"); message.className = "validation-message"; message.textContent = "Checking CSV files with the allocation engine…";
    $("#validate-button").disabled = true; $("#run-button").disabled = true;
    try {
      const data = await adminRequest("/demo/validate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ candidates_csv: candidatesCsv, companies_csv: companiesCsv }) });
      if (revision !== state.validationRevision) return;
      state.valid = true; $("#run-button").disabled = false;
      message.className = "validation-message success"; message.textContent = "Validation passed. The allocation engine accepted both files.";
      $("#preview-counts").textContent = `${data.candidates} candidates · ${data.companies} opportunities · first ${data.preview_limit} rows shown`;
      renderPreview($("#candidate-preview"), data.candidate_preview); renderPreview($("#company-preview"), data.company_preview);
      $("#preview-area").hidden = false; setConnection(true, "Engine ready");
    } catch (error) {
      if (revision !== state.validationRevision) return;
      state.valid = false; message.className = "validation-message error"; message.textContent = error.message;
      $("#preview-area").hidden = true; setConnection(false, "Check input");
    } finally { $("#validate-button").disabled = false; }
  }
  function renderResults(data) {
    state.result = data; state.selected = data.candidates[0]?.id ?? null;
    $("#results-section").hidden = false;
    $("#policy-label").textContent = `Policy ${data.policy_version || "prototype"}`;
    $("#dataset-label").textContent = `${data.dataset_name || state.datasetName}${data.dataset_kind === "synthetic" ? " · synthetic" : ""}`;
    const s = data.summary;
    const metrics = [["Candidates", s.candidates, "records evaluated"], ["Assigned", s.assigned, `${pct(s.candidates ? s.assigned / s.candidates : 0)} placed`], ["Unmatched", s.unmatched, "no acceptable open seat"], ["Opportunities", s.companies, "companies in this run"], ["Seats filled", `${s.seats_filled} / ${s.total_seats}`, "capacity used"], ["Utilization", pct(s.capacity_utilization), "of available seats"]];
    $("#metric-cards").innerHTML = metrics.map(([label, value, note]) => `<div class="metric-card"><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(note)}</small></div>`).join("");
    const sectors = [...new Set(data.candidates.map((c) => c.sector).filter(Boolean))].sort();
    $("#sector-filter").innerHTML = '<option value="">All sectors</option>' + sectors.map((sector) => `<option value="${esc(sector)}">${esc(sector)}</option>`).join("");
    renderCandidateRows(); renderCompanies(); renderOperations(); initializeTrace();
    $("#results-section").scrollIntoView({ behavior: "smooth", block: "start" });
  }
  function filteredCandidates() {
    const q = $("#candidate-search").value.trim().toLowerCase(), sector = $("#sector-filter").value, outcome = $("#outcome-filter").value;
    return (state.result?.candidates || []).filter((c) => (!q || `${c.id} ${c.name}`.toLowerCase().includes(q)) && (!sector || c.sector === sector) && (!outcome || c.allocation.status === outcome));
  }
  function renderCandidateRows() {
    const rows = filteredCandidates();
    $("#candidate-rows").innerHTML = rows.length ? rows.map((c) => `<tr data-candidate-id="${esc(c.id)}" class="${c.id === state.selected ? "selected" : ""}" tabindex="0"><td class="person-cell"><strong>${esc(c.name)}</strong><small>${esc(c.id)}</small></td><td>${esc(c.sector)}</td><td>${esc(c.location)}</td><td><span class="outcome ${esc(c.allocation.status)}">${human(c.allocation.status)}</span></td><td>${c.allocation.score == null ? "—" : fmt(c.allocation.score)}</td></tr>`).join("") : '<tr><td colspan="5" class="muted">No candidates match these filters.</td></tr>';
    $("#candidate-rows").querySelectorAll("[data-candidate-id]").forEach((row) => {
      const select = () => { state.selected = row.dataset.candidateId; renderCandidateRows(); renderCandidateDetail(); };
      row.addEventListener("click", select); row.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(); } });
    });
    renderCandidateDetail();
  }
  function renderCandidateDetail() {
    const c = state.result?.candidates.find((candidate) => candidate.id === state.selected); const box = $("#candidate-detail");
    if (!c) return;
    const assignedCompany = state.result.companies.find((co) => co.id === c.allocation.company_id);
    const unmatchedMessages = {
      no_acceptable_opportunities: "No acceptable opportunities were listed for this candidate.",
      no_eligible_opportunities: "No opportunities passed the configured eligibility filters.",
      all_acceptable_opportunities_rejected: "All listed opportunities were filled by candidates with higher company priority.",
    };
    const statusText = c.allocation.status === "matched"
      ? `Placed at ${assignedCompany?.name || c.allocation.company_id}`
      : unmatchedMessages[c.allocation.reason_code] || "No assignment was made under this run's preference and capacity rules.";
    const choices = c.top_choices.length ? c.top_choices.map((choice) => `<div class="choice-card"><div class="choice-top"><strong>${esc(choice.company_name)}</strong><span class="choice-rank">Choice ${choice.preference_rank} · ${human(choice.outcome)}</span></div><div class="score-line"><span>Total ${fmt(choice.breakdown.total)}</span><span>Skills ${fmt(choice.breakdown.skills)}</span><span>CGPA ${fmt(choice.breakdown.cgpa)}</span><span>Sector ${fmt(choice.breakdown.sector)}</span><span>Location ${fmt(choice.breakdown.location)}</span></div><div class="reason">${esc(human(choice.reason_code || "No reason code"))}${choice.company_cutoff_score == null ? "" : ` · cutoff ${fmt(choice.company_cutoff_score)}`}</div>${choice.matched_skills?.length ? `<div class="skills-line">Matched skills: ${esc(choice.matched_skills.join(", "))}</div>` : ""}${choice.missing_skills?.length ? `<div class="skills-line">Skills to build: ${esc(choice.missing_skills.join(", "))}</div>` : ""}</div>`).join("") : '<p class="muted small">No ranked choices were exported.</p>';
    box.innerHTML = `<div class="detail-header"><h3>${esc(c.name)}</h3><div class="detail-subtitle">${esc(c.id)} · ${esc(c.sector)} · ${esc(c.location)}</div></div><div class="allocation-callout"><strong>${esc(statusText)}</strong><span>${esc(human(c.allocation.reason_code || c.allocation.status))}${c.allocation.preference_rank == null ? "" : ` · preference #${c.allocation.preference_rank}`}${c.allocation.score == null ? "" : ` · score ${fmt(c.allocation.score)}`}</span></div><h4>Ranked options and fit</h4><div class="choice-list">${choices}</div>`;
  }
  function renderCompanies() {
    $("#company-cards").innerHTML = state.result.companies.map((c) => { const open = c.seats - c.seats_filled; const fill = c.seats ? c.seats_filled / c.seats * 100 : 0; return `<div class="company-capacity ${open ? "open" : ""}"><strong title="${esc(c.name)}">${esc(c.name)}</strong><small>${esc(c.sector)} · ${c.seats_filled}/${c.seats} filled · ${open} open</small><div class="capacity-bar"><span style="width:${Math.max(0, Math.min(100, fill))}%"></span></div><small>${esc(c.location)}${c.cutoff_score == null ? "" : ` · cutoff ${fmt(c.cutoff_score)}`}</small></div>`; }).join("");
  }
  function renderOperations() {
    const counts = state.result.operation_counts || {}, entries = Object.entries(counts);
    $("#operation-cards").innerHTML = entries.length ? entries.map(([name, value]) => `<div class="operation"><strong>${esc(value)}</strong><span>${esc(human(name))}</span></div>`).join("") : '<p class="muted small">No operation counters available for this export.</p>';
  }
  function initializeTrace() {
    const trace = state.result.allocation_trace || []; state.traceIndex = 0;
    $("#trace-slider").max = Math.max(0, trace.length - 1); $("#trace-slider").disabled = trace.length === 0;
    $("#trace-count").textContent = trace.length ? `${trace.length} recorded events` : "No trace events exported";
    renderTrace();
  }
  function visibleTraceIndexes() {
    const trace = state.result?.allocation_trace || [];
    return trace.map((event, index) => ({ event, index })).filter(({ event }) => !$("#trace-filter").checked || keysOnly.has(event.type));
  }
  function replayTrace(endIndex) {
    const trace = state.result?.allocation_trace || [], queue = (state.result?.candidates || []).map((c) => c.id), heaps = new Map();
    for (const company of state.result?.companies || []) heaps.set(company.id, []);
    for (let i = 0; i <= endIndex && i < trace.length; i++) {
      const e = trace[i], heap = e.company_id ? heaps.get(e.company_id) : null;
      if (e.type === "proposal") { const at = queue.indexOf(e.candidate_id); if (at >= 0) queue.splice(at, 1); }
      if (e.type === "accepted" && heap) {
        if (e.displaced_candidate_id) { const old = heap.indexOf(e.displaced_candidate_id); if (old >= 0) heap.splice(old, 1); }
        if (!heap.includes(e.candidate_id)) heap.push(e.candidate_id);
      }
      if (e.type === "rejected") { if (!queue.includes(e.candidate_id)) queue.push(e.candidate_id); }
      if (e.type === "displaced") { if (!queue.includes(e.candidate_id)) queue.push(e.candidate_id); }
    }
    return { queue, heaps };
  }
  function renderTrace() {
    const all = state.result?.allocation_trace || [], visible = visibleTraceIndexes(), slider = $("#trace-slider");
    if (!all.length) { $("#trace-position").textContent = "No trace yet"; $("#trace-event").innerHTML = "<h3>Run the allocator to inspect its trace</h3><p>Competition and displacement events will appear here.</p>"; $("#trace-queue").textContent = "No trace loaded"; $("#trace-heaps").innerHTML = ""; slider.disabled = true; $("#trace-prev").disabled = $("#trace-next").disabled = $("#jump-displacement").disabled = true; return; }
    if (!visible.length) { $("#trace-position").textContent = "No key events"; $("#trace-event").innerHTML = "<h3>No key events in the trace</h3><p>Turn off the key events filter to see every recorded step.</p>"; slider.disabled = true; $("#trace-prev").disabled = $("#trace-next").disabled = $("#jump-displacement").disabled = true; return; }
    slider.disabled = false;
    state.traceIndex = Math.min(state.traceIndex, visible.length - 1); const item = visible[state.traceIndex], e = item.event;
    slider.max = visible.length - 1; slider.value = state.traceIndex; $("#trace-position").textContent = `Step ${state.traceIndex + 1} of ${visible.length}`;
    $("#trace-progress").textContent = $("#trace-filter").checked ? `${all.length} total events · showing key decisions` : `Event ${e.sequence} · ${all.length} total`;
    const candidate = state.result.candidates.find((c) => c.id === e.candidate_id), company = state.result.companies.find((c) => c.id === e.company_id);
    const displaced = state.result.candidates.find((c) => c.id === e.displaced_candidate_id);
    const title = e.type === "competition" ? `${candidate?.name || e.candidate_id} challenges a seat at ${company?.name || e.company_id}` : e.type === "displaced" ? `${candidate?.name || e.candidate_id} returns to the proposal queue` : e.type === "accepted" ? `${candidate?.name || e.candidate_id} holds a seat at ${company?.name || e.company_id}` : e.type === "rejected" ? `${candidate?.name || e.candidate_id} loses this seat` : e.type === "proposal" ? `${candidate?.name || e.candidate_id} proposes to ${company?.name || e.company_id}` : `${candidate?.name || e.candidate_id} · ${human(e.type)}`;
    let explanation = `${human(e.reason_code)} · score ${fmt(e.score)}`;
    if (e.type === "competition") explanation += ` · current weakest holder: ${displaced?.name || e.displaced_candidate_id || "none"}`;
    if (e.type === "accepted" && e.displaced_candidate_id) explanation += ` · replaces ${displaced?.name || e.displaced_candidate_id}`;
    if (e.type === "displaced") explanation += ` · displaced by ${displaced?.name || e.displaced_candidate_id || "a stronger proposal"}`;
    $("#trace-event").className = `trace-event ${e.type === "displaced" || e.type === "competition" ? "displacement" : ""}`;
    $("#trace-event").innerHTML = `<span class="event-type">${esc(labels[e.type] || human(e.type))}</span><h3>${esc(title)}</h3><p>${esc(explanation)}</p>`;
    const replay = replayTrace(item.index);
    $("#trace-queue").className = "token-list";
    $("#trace-queue").innerHTML = replay.queue.length ? replay.queue.map((id) => { const c = state.result.candidates.find((x) => x.id === id); return `<span class="token">${esc(c?.name || id)}</span>`; }).join("") : '<span class="empty-note">Queue is empty</span>';
    $("#trace-heaps").innerHTML = state.result.companies.map((co) => { const holders = replay.heaps.get(co.id) || []; return `<div class="heap-company"><strong>${esc(co.name)} <span class="muted">${holders.length}/${co.seats}</span></strong>${holders.length ? holders.map((id) => `<div class="heap-holder"><span>${esc(state.result.candidates.find((c) => c.id === id)?.name || id)}</span></div>`).join("") : '<span class="empty-note">No held seats yet</span>'}</div>`; }).join("");
    $("#trace-prev").disabled = state.traceIndex === 0; $("#trace-next").disabled = state.traceIndex >= visible.length - 1;
    $("#jump-displacement").disabled = !visible.some(({ event }, index) => index > state.traceIndex && event.type === "displaced");
  }
  function setTraceIndex(index) { state.traceIndex = Math.max(0, index); renderTrace(); }
  async function loadScenarios() {
    const button = $("#load-scenarios"); button.disabled = true; $("#scenario-message").textContent = "Generating the seeded synthetic report…";
    try { state.scenarios = await adminRequest("/demo/scenarios"); renderScenarios(); }
    catch (error) { $("#scenario-message").textContent = error.message; showToast(error.message, true); }
    finally { button.disabled = false; }
  }
  function renderScenarios() {
    const rows = state.scenarios.rows; const scenarios = [...new Set(rows.map((row) => row.scenario))];
    $("#scenario-message").textContent = `Seed ${state.scenarios.seed} · ${scenarios.length} scenarios · ${rows.length} cohort summaries · synthetic data only.`;
    $("#scenario-results").hidden = false;
    $("#scenario-bars").innerHTML = scenarios.map((name) => {
      const group = rows.filter((row) => row.scenario === name), a = group.find((row) => row.cohort.endsWith("A")), b = group.find((row) => row.cohort.endsWith("B"));
      const ar = a && Number(a.eligible) ? Number(a.allocated) / Number(a.eligible) : 0, br = b && Number(b.eligible) ? Number(b.allocated) / Number(b.eligible) : 0;
      return `<div class="scenario-row"><span class="scenario-name">${esc(human(name))}</span><div class="scenario-rates">${[["A", ar, "group-a"], ["B", br, "group-b"]].map(([label, rate, color]) => `<div class="scenario-rate"><span class="cohort-label">Cohort ${label}</span><div class="scenario-track"><span class="${color}" style="width:${Math.min(100, rate * 100)}%"></span></div><span class="scenario-value">${pct(rate)}</span></div>`).join("")}</div></div>`;
    }).join("");
    $("#scenario-rows").innerHTML = rows.map((r) => `<tr><td>${esc(human(r.scenario))}</td><td>${esc(r.cohort.replace("synthetic_group_", ""))}</td><td>${esc(r.eligible)}</td><td>${esc(r.allocated)}</td><td>${esc(r.unmatched)}</td><td>${fmt(r.average_score)}</td><td>${esc(r.changed_assignments)}</td><td>${esc(r.seats_filled)}</td></tr>`).join("");
  }
  function activateView(name) {
    if (["workspace", "admin-candidates", "admin-opportunities", "algorithm", "fairness"].includes(name) && !state.adminToken) {
      name = name === "workspace" ? "workspace" : "candidate";
    }
    const nestedAdminView = ["admin-candidates", "admin-opportunities"].includes(name);
    document.querySelectorAll(".tab").forEach((tab) => { const active = tab.dataset.view === name; tab.classList.toggle("active", active); if (active) tab.setAttribute("aria-current", "page"); else tab.removeAttribute("aria-current"); });
    document.querySelectorAll(".view").forEach((view) => {
      const active = view.id === `${name}-view` || (view.id === "workspace-view" && nestedAdminView);
      view.classList.toggle("active", active); view.hidden = !active;
    });
    const adminOverview = $("#admin-overview-panel");
    if (adminOverview) adminOverview.hidden = nestedAdminView;
    const accountSettings = $("#admin-account-settings");
    if (accountSettings) accountSettings.hidden = name !== "workspace";
  }

  function showRoleChoice() {
    state.authToken = null; state.adminToken = null; state.candidateProfile = null; state.candidateResult = null;
    sessionStorage.removeItem("sae.candidate.token"); sessionStorage.removeItem("sae.admin.token");
    $(".tabs").hidden = true; $("#role-choice").hidden = false;
    $("#session-signout").hidden = true;
    document.querySelectorAll(".view").forEach((view) => { view.hidden = true; view.classList.remove("active"); });
    $("#admin-login-panel").hidden = false; $("#allocator-workspace").hidden = true;
    $("#candidate-login").hidden = false; $("#candidate-dashboard").hidden = true;
  }

  async function chooseRole(role) {
    $("#role-choice").hidden = true;
    $(".tabs").hidden = true;
    if (role === "candidate") {
      $("#candidate-login").hidden = false; $("#candidate-dashboard").hidden = true;
      activateView("candidate"); await loadDemoProfiles();
    } else {
      $("#admin-login-panel").hidden = false; $("#allocator-workspace").hidden = true;
      activateView("workspace");
    }
  }

  function setLoginMessage(message, error = false) {
    const el = $("#login-message"); el.textContent = message; el.className = `validation-message${error ? " error" : ""}`;
  }
  function showCandidateLogin() {
    $("#candidate-login").hidden = false; $("#candidate-dashboard").hidden = true;
    state.candidateProfile = null; state.candidateResult = null; state.chatSession = null;
  }
  async function signOut() {
    clearInterval(state.candidatePoll); state.candidatePoll = null;
    $("#candidate-chat-input").value = ""; $("#chat-messages").innerHTML = '<div class="chat-bubble assistant">Ask about your result, score, or skill gaps. The assistant can explain the recorded outcome but cannot change it.</div>';
    showCandidateLogin(); showRoleChoice();
  }
  async function loadDemoProfiles() {
    try {
      const { profiles } = await request("/auth/demo-profiles");
      $("#demo-profile-list").innerHTML = profiles.map((profile) => `<button class="demo-profile-choice" type="button" data-demo-email="${esc(profile.email)}"><strong>${esc(profile.display_name)}</strong><span>${esc(profile.email)}</span></button>`).join("");
      $("#demo-profile-list").querySelectorAll("[data-demo-email]").forEach((button) => button.addEventListener("click", () => {
        $("#login-email").value = button.dataset.demoEmail; $("#login-password").focus();
        $("#demo-profile-list").querySelectorAll("[data-demo-email]").forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
      }));
    } catch (error) { setLoginMessage(`Could not load demo profiles: ${error.message}`, true); }
  }
  async function openCandidatePortal() {
    try {
      const me = await candidateRequest("/auth/me"); state.candidateProfile = me.profile;
      const result = await candidateRequest("/me/profile"); state.candidateResult = result;
      state.chatSession = window.crypto?.randomUUID?.() || `sae-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      renderCandidatePortal();
      state.candidateDirty = false; state.profileVersion = result.profile_version;
      $("#candidate-login").hidden = true; $("#candidate-dashboard").hidden = false;
      $("#session-signout").hidden = false;
      $("#role-choice").hidden = true; $(".tabs").hidden = true; activateView("candidate");
      const health = await request("/health").catch(() => null);
      state.externalLLM = Boolean(health?.external_llm_processing);
      state.externalProviderName = health?.llm_provider === "gemini" ? "Google Gemini" : health?.llm_provider === "groq" ? "Groq" : "external provider";
      state.externalConsent = false; $("#chat-external-consent").checked = false;
      $("#chat-consent-row").hidden = !state.externalLLM;
      $("#chat-consent-copy").textContent = `I understand this question and minimized result facts will be sent to ${state.externalProviderName}.`;
      const providerNotice = health?.privacy_notice || "Assistant provider status is unavailable.";
      const knowledgeNotice = health && !health.kb_chunks ? "The knowledge index is not built yet; answers will be limited to this allocation's recorded facts." : "The knowledge index is ready for source-backed answers.";
      $("#chat-provider-notice").textContent = `${providerNotice} ${knowledgeNotice}`;
      clearInterval(state.candidatePoll);
      state.candidatePoll = setInterval(async () => {
        if (!state.authToken) return;
        try {
          const latest = await candidateRequest("/me/profile");
          const versionChanged = latest.profile_version !== state.profileVersion;
          const resultChanged = latest.run_id !== state.candidateResult?.run_id || latest.allocation_state?.version !== state.candidateResult?.allocation_state?.version;
          if (versionChanged || resultChanged) {
            const edited = state.candidateDirty ? {
              cgpa: $("#profile-cgpa").value, sector: $("#profile-sector").value,
              location: $("#profile-location").value, skills: $("#profile-skills").value,
              qualifications: $("#profile-qualifications").value,
              preferred_locations: $("#profile-locations").value, sector_interests: $("#profile-sectors").value,
              preferenceIds: [...state.preferenceIds],
            } : null;
            state.candidateResult = latest;
            if (!state.candidateDirty) state.profileVersion = latest.profile_version;
            renderCandidatePortal();
            if (edited) {
              $("#profile-cgpa").value = edited.cgpa; $("#profile-sector").value = edited.sector;
              $("#profile-location").value = edited.location; $("#profile-skills").value = edited.skills;
              $("#profile-qualifications").value = edited.qualifications;
              $("#profile-locations").value = edited.preferred_locations; $("#profile-sectors").value = edited.sector_interests;
              state.preferenceIds = edited.preferenceIds; state.candidateDirty = true;
              renderPreferenceEditor(latest.all_opportunities || []);
              if (versionChanged) {
                $("#profile-save-message").textContent = "Your profile changed in another session. Reload the page before saving these edits.";
                $("#profile-save-message").classList.add("error");
              }
            }
          }
        } catch (error) { if (/sign in|expired/i.test(error.message)) await signOut(); }
      }, 4000);
    } catch (error) {
      if (/sign in|expired/i.test(error.message)) {
        sessionStorage.removeItem("sae.candidate.token"); state.authToken = null;
      }
      showCandidateLogin(); setLoginMessage(error.message, true);
    }
  }
  function setAdminLoginMessage(message, error = false) {
    const el = $("#admin-login-message"); el.textContent = message; el.className = `validation-message${error ? " error" : ""}`;
  }
  async function openAllocatorWorkbench() {
    try {
      const me = await adminRequest("/auth/me");
      if (me.profile.role !== "admin") throw new Error("Allocator sign-in is required.");
      $("#role-choice").hidden = true; $(".tabs").hidden = false; activateView("workspace");
      $("#session-signout").hidden = false;
      $("#admin-login-panel").hidden = true; $("#allocator-workspace").hidden = false;
      document.querySelectorAll("[data-admin-only]").forEach((tab) => { tab.hidden = false; });
      await loadAdminAccounts(); await loadAdminWorkspace(); await loadAdminCandidates(); await loadAdminOpportunities();
      clearInterval(state.adminPoll);
      state.adminPoll = setInterval(() => loadAdminWorkspace().catch(() => {}), 4000);
    } catch (error) {
      sessionStorage.removeItem("sae.admin.token"); state.adminToken = null;
      $("#admin-login-panel").hidden = false; $("#allocator-workspace").hidden = true;
      document.querySelectorAll("[data-admin-only]").forEach((tab) => { tab.hidden = true; });
      setAdminLoginMessage(error.message, true);
    }
  }
  async function loadAdminAccounts() {
    const data = await adminRequest("/admin/accounts");
    const candidates = data.accounts.filter((account) => account.role === "candidate");
    $("#admin-account-rows").innerHTML = candidates.map((account) => `<tr><td>${esc(account.email)}</td><td>${esc(account.display_name)}</td><td>${esc(account.candidate_id)}</td><td>${account.active ? "Active" : "Disabled"}</td><td><button class="button button-secondary account-status-button" data-email="${esc(account.email)}" data-active="${account.active ? "false" : "true"}" type="button">${account.active ? "Deactivate" : "Activate"}</button></td></tr>`).join("") || '<tr><td colspan="5" class="muted">No candidate accounts yet.</td></tr>';
    const selectable = candidates.filter((account) => account.active);
    $("#reset-account-email").innerHTML = selectable.map((account) => `<option value="${esc(account.email)}">${esc(account.display_name)} · ${esc(account.email)}</option>`).join("");
    $("#admin-account-rows").querySelectorAll(".account-status-button").forEach((button) => button.addEventListener("click", async () => {
      try {
        await adminRequest(`/admin/accounts/${encodeURIComponent(button.dataset.email)}/status`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ active: button.dataset.active === "true" }),
        });
        await loadAdminAccounts(); await loadDemoProfiles(); setAdminAccountMessage("Account status updated; prior sessions were revoked.");
      } catch (error) { setAdminAccountMessage(error.message, true); }
    }));
  }
  async function loadAdminWorkspace() {
    const [dashboard, current] = await Promise.all([
      adminRequest("/admin/dashboard"), adminRequest("/admin/allocations/current"),
    ]);
    const allocationState = dashboard.allocation_state;
    const priorVersion = state.adminStateVersion;
    state.adminStateVersion = allocationState.version;
    const currentRun = dashboard.current_run;
    $("#admin-allocation-status").textContent = currentRun
      ? `Published ${new Date(currentRun.created_at + "Z").toLocaleString()}`
      : ({ reset: "Reset · awaiting next run", profile_updated: "Profile changed · run again",
           opportunities_updated: "Opportunity details changed · run again" }[allocationState.status] || "Not allocated yet");
    const s = dashboard.summary || {};
    const metrics = [["Candidates", dashboard.candidate_count, "saved profiles"], ["Opportunities", dashboard.opportunity_count, "open to allocation"], ["Assigned", currentRun ? s.assigned : 0, currentRun ? "latest published run" : "no current run"], ["Unmatched", currentRun ? s.unmatched : 0, "latest published run"], ["Seats filled", currentRun ? `${s.seats_filled} / ${s.total_seats}` : "0", "current allocation"]];
    $("#admin-summary-cards").innerHTML = metrics.map(([label, value, note]) => `<div class="metric-card"><span>${esc(label)}</span><strong>${esc(value ?? 0)}</strong><small>${esc(note)}</small></div>`).join("");
    $("#allocation-history-rows").innerHTML = dashboard.history.length ? dashboard.history.map((run) => `<tr><td><code>${esc(run.run_id.slice(0, 8))}</code></td><td>${esc(new Date(run.created_at + "Z").toLocaleString())}</td><td>${esc(run.created_by)}</td><td>${esc(run.summary.assigned)}</td><td>${esc(run.summary.unmatched)}</td></tr>`).join("") : '<tr><td colspan="5" class="muted">No allocation runs yet.</td></tr>';
    if (current.current_run) {
      if (state.result?.run_id !== current.run_id) renderResults(current);
      if (state.result && !state.result.run_id) state.result.run_id = current.run_id;
      } else {
      state.result = null; state.selected = null; $("#results-section").hidden = true;
    }
    $("#admin-reset-allocation").disabled = !currentRun;
    if (priorVersion != null && priorVersion !== allocationState.version) {
      await loadAdminCandidates();
      if (!state.opportunitiesDirty) await loadAdminOpportunities();
      else {
        $("#opportunity-save-message").textContent = "Shared records changed while you were editing. Reload before saving.";
        $("#opportunity-save-message").classList.add("error");
      }
    }
  }
  async function loadAdminCandidates() {
    const data = await adminRequest("/admin/candidates");
    $("#admin-candidates-rows").innerHTML = data.candidates.map((c) => {
      const placement = c.allocation?.company_id ? `Assigned · ${c.allocation_company || c.allocation.company_id}` : c.allocation_status === "current" ? "Unmatched" : "Not allocated";
      return `<tr><td><strong>${esc(c.name)}</strong><small>${esc(c.candidate_id)} · ${esc(c.email || "no account")}</small></td><td>${esc(c.sector)}</td><td>${esc(c.location)}</td><td>${c.preferences.length ? c.preferences.map((item) => esc(item.name)).join(" → ") : "No eligible opportunities"}</td><td>${esc(placement)}</td></tr>`;
    }).join("") || '<tr><td colspan="5" class="muted">No candidate profiles.</td></tr>';
  }
  let opportunityVersion = null;
  async function loadAdminOpportunities() {
    const data = await adminRequest("/admin/opportunities"); opportunityVersion = data.version; state.adminOpportunities = data.opportunities; state.opportunitiesDirty = false;
    $("#admin-opportunity-rows").innerHTML = data.opportunities.map((o) => `<tr data-opportunity-id="${esc(o.id)}"><td><strong>${esc(o.name)}</strong><small>${esc(o.id)}</small></td><td><input data-field="sector" value="${esc(o.sector)}" aria-label="${esc(o.name)} sector"></td><td><input data-field="location" value="${esc(o.location)}" aria-label="${esc(o.name)} location"></td><td><input data-field="seats" type="number" min="0" value="${esc(o.seats)}" aria-label="${esc(o.name)} seats"></td><td><input data-field="required_skills" value="${esc(o.required_skills.join(", "))}" aria-label="${esc(o.name)} required skills"></td><td><input data-field="required_qualifications" value="${esc(o.required_qualifications.join(", "))}" aria-label="${esc(o.name)} required qualifications"></td></tr>`).join("");
  }
  function setAdminAccountMessage(message, error = false) {
    const el = $("#admin-account-message"); el.textContent = message; el.className = `validation-message${error ? " error" : ""}`;
  }
  async function adminSignOut() {
    clearInterval(state.adminPoll); state.adminPoll = null;
    document.querySelectorAll("[data-admin-only]").forEach((tab) => { tab.hidden = true; });
    showRoleChoice();
    setAdminLoginMessage("Allocator signed out.");
  }
  async function changePassword(requestFn, currentId, nextId, messageId, storageKey, role) {
    const message = $(messageId); message.textContent = "Updating password…";
    try {
      const data = await requestFn("/auth/password", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ current_password: $(currentId).value, new_password: $(nextId).value }),
      });
      if (role === "admin") { state.adminToken = data.access_token; sessionStorage.setItem(storageKey, state.adminToken); }
      else { state.authToken = data.access_token; sessionStorage.setItem(storageKey, state.authToken); }
      $(currentId).value = ""; $(nextId).value = ""; message.textContent = "Password changed. Other active tokens for this account were revoked.";
    } catch (error) { message.textContent = error.message; message.classList.add("error"); }
  }
  function splitList(text) { return [...new Set(String(text || "").split(/[;,]/).map((item) => item.trim()).filter(Boolean))]; }
  function showCandidateProfile(profile) {
    $("#candidate-name").textContent = profile.name;
    $("#candidate-subtitle").textContent = `${state.candidateProfile?.email || ""} · ${profile.sector} · ${profile.location}`;
    $("#profile-name").value = profile.name;
    $("#profile-cgpa").value = profile.cgpa;
    $("#profile-sector").value = profile.sector;
    $("#profile-location").value = profile.location;
    $("#profile-skills").value = profile.skills.join(", ");
    $("#profile-qualifications").value = profile.qualifications.join(", ");
    $("#profile-locations").value = profile.preferred_locations.join(", ");
    $("#profile-sectors").value = profile.sector_interests.join(", ");
    const profileMessage = $("#profile-save-message"); profileMessage.className = "validation-message";
    profileMessage.textContent = `Profile version ${profile.profile_version} · last saved ${profile.updated_at}`;
    state.preferenceIds = (profile.preferences || []).map((item) => item.id);
    state.savedPreferenceIds = [...state.preferenceIds];
    $("#preferences-mode").textContent = profile.preferences_are_automatic
      ? "Showing the current automatic score ranking. Save your edited order to use it as your preference list."
      : "Your saved preference order will be used for the next allocation.";
    renderPreferenceEditor(profile.all_opportunities || []);
    const status = $("#candidate-allocation-status");
    status.innerHTML = `<p class="eyebrow">ALLOCATION STATUS</p><h3>${profile.allocation_status === "allocated" ? "Result available" : "Not allocated yet"}</h3><p>${esc(profile.allocation_message || "Your profile is saved and ready for the next allocation.")}</p>`;
    $("#candidate-allocation-details").hidden = profile.allocation_status !== "allocated";
  }
  function renderPreferenceEditor(opportunities = state.candidateResult?.all_opportunities || []) {
    const byId = new Map(opportunities.map((item) => [item.id, item]));
    $("#candidate-preferences").innerHTML = state.preferenceIds.length ? state.preferenceIds.map((id, index) => {
      const item = byId.get(id);
      return `<li class="preference-item"><div><strong>${index + 1}. ${esc(item?.name || id)}</strong><span>${esc(item?.sector || "")} · ${esc(item?.location || "")}</span></div><div class="preference-actions"><button type="button" data-pref-action="up" data-pref-index="${index}" aria-label="Move ${esc(item?.name || id)} up" ${index === 0 ? "disabled" : ""}>↑</button><button type="button" data-pref-action="down" data-pref-index="${index}" aria-label="Move ${esc(item?.name || id)} down" ${index === state.preferenceIds.length - 1 ? "disabled" : ""}>↓</button><button type="button" data-pref-action="remove" data-pref-index="${index}" aria-label="Remove ${esc(item?.name || id)}">Remove</button></div></li>`;
    }).join("") : '<li class="muted small">No opportunities in your preference list yet. Add one below.</li>';
    const select = $("#preference-opportunity"), available = opportunities.filter((item) => !state.preferenceIds.includes(item.id));
    select.innerHTML = available.length ? available.map((item) => `<option value="${esc(item.id)}">${esc(item.name)} · ${esc(item.sector)}</option>`).join("") : '<option value="">All opportunities are already listed</option>';
    select.disabled = available.length === 0;
    const dirty = state.preferenceIds.join("|") !== state.savedPreferenceIds.join("|");
    $("#save-preferences").disabled = !dirty;
    $("#preferences-save-message").className = "validation-message";
    if (dirty) $("#preferences-save-message").textContent = "Unsaved preference changes.";
  }
  function renderCandidatePortal() {
    const result = state.candidateResult, profile = result;
    showCandidateProfile(profile);
    if (profile.allocation_status !== "allocated") return;
    const allocation = profile.allocation, matched = allocation.status === "matched", company = profile.assigned_company;
    $("#candidate-policy").textContent = `${result.policy_version} · ${result.dataset_name}${result.synthetic ? " · synthetic" : ""}`;
    const outcome = matched ? `Matched${company ? ` · ${company.name}` : ""}` : "Unmatched in this run";
    const cards = [
      ["Outcome", outcome],
      ["Preference rank", allocation.preference_rank ? `#${allocation.preference_rank}` : "No placement"],
      ["Fit score", allocation.score == null ? "Not assigned" : fmt(allocation.score)],
      ["Scoring policy", result.policy_version],
    ];
    $("#candidate-outcome").innerHTML = cards.map(([label, value]) => `<div class="candidate-outcome-card"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`).join("");
    const summary = result.explanation || {};
    const choices = summary.choices || [];
    const overall = matched
      ? `You were placed${company ? ` at ${company.name}` : ""}${allocation.preference_rank ? ` at preference rank ${allocation.preference_rank}` : ""}. This is the outcome recorded for this run.`
      : "No placement was recorded for this run. The comparison below shows outcomes for your listed opportunities; this does not by itself mean you failed an official eligibility check.";
    const choiceHtml = choices.length ? choices.map((choice) => {
      const reason = choice.outcome === "lost_seat"
        ? (choice.points_short == null ? "The opportunity was filled under this run's priority rules." : `The final cutoff was ${fmt(choice.company_cutoff_score)}; your score was ${fmt(choice.score)} (${fmt(choice.points_short)} points below).`)
        : choice.outcome === "matched" ? "This was the opportunity assigned to you."
          : "This opportunity was not reached under your preference order and final assignment.";
      const parts = choice.breakdown || {};
      return `<article class="candidate-choice"><div class="candidate-choice-head"><strong>${esc(choice.company_name)}</strong><span>Choice ${esc(choice.preference_rank)} · ${esc(human(choice.outcome))}</span></div><p>${esc(reason)}</p><p>Fit ${fmt(choice.score)} · skills ${fmt(parts.skills)} · CGPA ${fmt(parts.cgpa)} · sector ${fmt(parts.sector)} · location ${fmt(parts.location)}</p></article>`;
    }).join("") : '<p class="muted small">No opportunity comparison was included in this allocation export.</p>';
    $("#candidate-result-detail").innerHTML = `<div class="allocation-callout"><strong>${esc(outcome)}</strong><span>${esc(overall)}</span></div><div class="candidate-choice-list">${choiceHtml}</div>`;
    const missing = result.skill_gap.missing_ranked || [];
    $("#candidate-skill-gap").innerHTML = missing.length
      ? `<div class="skill-gap-list">${missing.slice(0, 8).map((item) => `<span class="skill-gap-chip">${esc(item.skill)} · ${esc(item.needed_by_companies)} ${Number(item.needed_by_companies) === 1 ? "opportunity" : "opportunities"}</span>`).join("")}</div>`
      : '<p class="muted small">No ranked missing skills were found for the listed opportunities.</p>';
  }
  function appendChatMessage(role, text, sources = [], notice = "") {
    const messages = $("#chat-messages"), bubble = document.createElement("div");
    bubble.className = `chat-bubble ${role}`; bubble.textContent = text; messages.appendChild(bubble);
    if (sources.length) {
      const sourceList = document.createElement("div"); sourceList.className = "chat-sources";
      const heading = document.createElement("strong"); heading.textContent = "Sources"; sourceList.appendChild(heading);
      sources.forEach((source) => { const item = document.createElement("span"); item.textContent = `[${source.label}] ${source.title} (${source.path})`; sourceList.appendChild(item); });
      bubble.appendChild(sourceList);
    }
    if (notice) { const note = document.createElement("p"); note.className = "chat-footnote"; note.textContent = notice; bubble.appendChild(note); }
    messages.scrollTop = messages.scrollHeight;
    return bubble;
  }
  async function sendCandidateMessage(message) {
    if (state.externalLLM && !state.externalConsent) {
      if (!$("#chat-external-consent").checked) {
        $("#chat-provider-notice").textContent = `Review the ${state.externalProviderName} notice and check the consent box before sending. No question has been sent.`;
        $("#chat-external-consent").focus(); return;
      }
      state.externalConsent = true;
    }
    const button = $("#candidate-chat-send"); button.disabled = true;
    appendChatMessage("user", message);
    const pending = appendChatMessage("assistant", "Thinking…");
    try {
      const data = await candidateRequest("/me/chat", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: state.chatSession, message }),
      });
      pending.remove(); appendChatMessage("assistant", data.answer, data.sources || [], data.privacy_notice || data.disclaimer || "");
    } catch (error) {
      pending.textContent = error.message;
      if (/sign in|expired/i.test(error.message)) await signOut();
    } finally { button.disabled = false; }
  }

  document.addEventListener("DOMContentLoaded", async () => {
    document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => activateView(tab.dataset.view)));
    $("#choose-candidate").addEventListener("click", () => chooseRole("candidate"));
    $("#choose-admin").addEventListener("click", () => chooseRole("admin"));
    $("#candidate-profile-form").addEventListener("submit", async (event) => {
      event.preventDefault(); const button = $("#save-profile"); button.disabled = true;
      $("#profile-save-message").textContent = "Saving your profile…";
      const values = {
        expected_profile_version: state.profileVersion,
        skills: splitList($("#profile-skills").value), cgpa: Number($("#profile-cgpa").value),
        sector: $("#profile-sector").value.trim(), location: $("#profile-location").value.trim(),
        qualifications: splitList($("#profile-qualifications").value),
        preferred_locations: splitList($("#profile-locations").value),
        sector_interests: splitList($("#profile-sectors").value),
      };
      try {
        state.candidateResult = await candidateRequest("/me/profile", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(values) });
        state.profileVersion = state.candidateResult.profile_version; state.candidateDirty = false;
        renderCandidatePortal(); $("#profile-save-message").textContent = "Saved. Your updated profile will be used for the next allocation.";
      } catch (error) { $("#profile-save-message").textContent = error.message; $("#profile-save-message").classList.add("error"); }
      finally { button.disabled = false; }
    });
    $("#add-preference").addEventListener("click", () => {
      const id = $("#preference-opportunity").value;
      if (id && !state.preferenceIds.includes(id)) state.preferenceIds.push(id);
      renderPreferenceEditor();
    });
    $("#candidate-preferences").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-pref-action]"); if (!button) return;
      const index = Number(button.dataset.prefIndex), action = button.dataset.prefAction;
      if (action === "remove") state.preferenceIds.splice(index, 1);
      if (action === "up" && index > 0) [state.preferenceIds[index - 1], state.preferenceIds[index]] = [state.preferenceIds[index], state.preferenceIds[index - 1]];
      if (action === "down" && index < state.preferenceIds.length - 1) [state.preferenceIds[index + 1], state.preferenceIds[index]] = [state.preferenceIds[index], state.preferenceIds[index + 1]];
      renderPreferenceEditor();
    });
    $("#save-preferences").addEventListener("click", async () => {
      const button = $("#save-preferences"); button.disabled = true;
      $("#preferences-save-message").textContent = "Saving your preference order…";
      try {
        state.candidateResult = await candidateRequest("/me/preferences", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ opportunity_ids: state.preferenceIds, expected_profile_version: state.profileVersion }) });
        state.profileVersion = state.candidateResult.profile_version; state.candidateDirty = false;
        renderCandidatePortal(); $("#preferences-save-message").textContent = "Saved. Your updated preferences will be used for the next allocation.";
      } catch (error) { $("#preferences-save-message").textContent = error.message; $("#preferences-save-message").classList.add("error"); button.disabled = false; }
    });
    $("#candidate-profile-form").addEventListener("input", () => { state.candidateDirty = true; });
    $("#candidate-preferences").addEventListener("click", () => { state.candidateDirty = true; });
    $("#add-preference").addEventListener("click", () => { state.candidateDirty = true; });
    $("#load-sample").addEventListener("click", () => loadSample().catch((error) => showToast(error.message, true)));
    $("#admin-run-allocation").addEventListener("click", async () => {
      const button = $("#admin-run-allocation"); button.disabled = true; $("#admin-action-message").textContent = "Running allocation from saved profiles and preferences…";
      try { const data = await adminRequest("/admin/allocations/run", { method: "POST" }); data.run_id = data.run_id; renderResults(data); await loadAdminWorkspace(); $("#admin-action-message").textContent = "Allocation published to candidate accounts."; showToast("Allocation completed and published."); }
      catch (error) { $("#admin-action-message").textContent = error.message; $("#admin-action-message").classList.add("error"); }
      finally { button.disabled = false; }
    });
    $("#admin-reset-allocation").addEventListener("click", async () => {
      const button = $("#admin-reset-allocation"); button.disabled = true; $("#admin-action-message").textContent = "Resetting current allocation…";
      try { await adminRequest("/admin/allocations/reset", { method: "POST" }); state.result = null; $("#results-section").hidden = true; await loadAdminWorkspace(); await loadAdminCandidates(); $("#admin-action-message").textContent = "Current allocation cleared. Candidate profiles and run history are retained."; }
      catch (error) { $("#admin-action-message").textContent = error.message; $("#admin-action-message").classList.add("error"); }
    });
    $("#admin-refresh").addEventListener("click", () => loadAdminWorkspace().catch((error) => showToast(error.message, true)));
    $("#refresh-candidates").addEventListener("click", () => loadAdminCandidates().catch((error) => showToast(error.message, true)));
    $("#refresh-opportunities").addEventListener("click", () => loadAdminOpportunities().catch((error) => showToast(error.message, true)));
    $("#save-opportunities").addEventListener("click", async () => {
      const rows = [...$("#admin-opportunity-rows").querySelectorAll("tr[data-opportunity-id]")];
      const opportunities = rows.map((row) => {
        const original = state.adminOpportunities?.find((o) => o.id === row.dataset.opportunityId);
        return { ...original, id: row.dataset.opportunityId,
          sector: row.querySelector('[data-field="sector"]').value.trim(), location: row.querySelector('[data-field="location"]').value.trim(),
          seats: Number(row.querySelector('[data-field="seats"]').value),
          required_skills: splitList(row.querySelector('[data-field="required_skills"]').value),
          required_qualifications: splitList(row.querySelector('[data-field="required_qualifications"]').value) };
      });
      try { await adminRequest("/admin/opportunities", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ opportunities, expected_version: opportunityVersion }) }); state.opportunitiesDirty = false; await loadAdminOpportunities(); await loadAdminWorkspace(); $("#opportunity-save-message").textContent = "Saved. The previous allocation was marked stale; run again to publish updated results."; }
      catch (error) { $("#opportunity-save-message").textContent = error.message; $("#opportunity-save-message").classList.add("error"); }
    });
    $("#admin-opportunity-rows").addEventListener("input", () => { state.opportunitiesDirty = true; });
    $("#validate-button").addEventListener("click", validateData);
    $("#run-button").addEventListener("click", async () => {
      if (!state.valid) return;
      const revision = state.validationRevision;
      const candidatesCsv = $("#candidates-csv").value;
      const companiesCsv = $("#companies-csv").value;
      const synthetic = state.synthetic;
      const button = $("#run-button"); button.disabled = true; button.textContent = "Running allocation…";
      try {
        const data = await adminRequest("/demo/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ candidates_csv: candidatesCsv, companies_csv: companiesCsv, dataset_name: state.datasetName, synthetic }) });
        if (revision !== state.validationRevision) {
          showToast("The input changed while this allocation was running. Validate and run the current data.", true);
          return;
        }
        renderResults(data); setConnection(true, "Engine ready"); showToast(`Allocation complete for ${data.summary.candidates} candidates.`);
      } catch (error) { if (revision === state.validationRevision) showToast(error.message, true); }
      finally { button.disabled = !state.valid; button.innerHTML = 'Run allocation <span aria-hidden="true">→</span>'; }
    });
    for (const [id, kind] of [["candidate-file", "candidate"], ["company-file", "company"]]) {
      $(`#${id}`).addEventListener("change", async (event) => {
        const file = event.target.files?.[0]; if (!file) return;
        try { const text = await file.text(); const input = $(`#${kind === "candidate" ? "candidates-csv" : "companies-csv"}`); input.value = text; state.datasetName = file.name.replace(/\.csv$/i, ""); state.synthetic = false; $("#synthetic-data").checked = false; $("#dataset-badge").textContent = `${state.datasetName} · uploaded`; $("#file-status").textContent = "Select the other CSV, then validate both files."; invalidateValidation(); }
        catch (error) { showToast(`Could not read ${file.name}: ${error.message}`, true); }
      });
    }
    $("#synthetic-data").addEventListener("change", (event) => {
      state.synthetic = event.target.checked;
      $("#dataset-badge").textContent = `${state.datasetName} · ${state.synthetic ? "synthetic" : "uploaded"}`;
      invalidateValidation();
    });
    ["#candidates-csv", "#companies-csv"].forEach((selector) => $(selector).addEventListener("input", invalidateValidation));
    ["#candidate-search", "#sector-filter", "#outcome-filter"].forEach((selector) => $(selector).addEventListener("input", renderCandidateRows));
    $("#trace-prev").addEventListener("click", () => setTraceIndex(state.traceIndex - 1));
    $("#trace-next").addEventListener("click", () => setTraceIndex(state.traceIndex + 1));
    $("#trace-slider").addEventListener("input", (event) => setTraceIndex(Number(event.target.value)));
    $("#trace-filter").addEventListener("change", () => { state.traceIndex = 0; renderTrace(); });
    $("#jump-displacement").addEventListener("click", () => { const next = visibleTraceIndexes().findIndex(({ event }, index) => index > state.traceIndex && event.type === "displaced"); if (next >= 0) setTraceIndex(next); });
    $("#load-scenarios").addEventListener("click", loadScenarios);
    $("#candidate-login-form").addEventListener("submit", async (event) => {
      event.preventDefault(); const button = $("#login-button"); button.disabled = true; setLoginMessage("Signing in…");
      try {
        const data = await request("/auth/login", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: $("#login-email").value, password: $("#login-password").value, role: "candidate" }),
        });
        sessionStorage.removeItem("sae.admin.token"); state.adminToken = null;
        state.authToken = data.access_token; sessionStorage.setItem("sae.candidate.token", state.authToken);
        $("#login-password").value = ""; await openCandidatePortal();
      } catch (error) { setLoginMessage(error.message, true); }
      finally { button.disabled = false; }
    });
    $("#candidate-logout").addEventListener("click", signOut);
    $("#session-signout").addEventListener("click", () => state.adminToken ? adminSignOut() : signOut());
    $("#candidate-chat-form").addEventListener("submit", async (event) => {
      event.preventDefault(); const input = $("#candidate-chat-input"), message = input.value.trim();
      if (!message) return; input.value = ""; await sendCandidateMessage(message);
    });
    $("#chat-external-consent").addEventListener("change", (event) => {
      if (event.target.checked) $("#chat-provider-notice").textContent = `Consent recorded for this browser session. Your next question will be sent to ${state.externalProviderName}.`;
    });
    $("#admin-login-form").addEventListener("submit", async (event) => {
      event.preventDefault(); const button = $("#admin-login-button"); button.disabled = true; setAdminLoginMessage("Signing in…");
      try {
        const data = await request("/auth/login", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: $("#admin-login-email").value, password: $("#admin-login-password").value, role: "admin" }),
        });
        sessionStorage.removeItem("sae.candidate.token"); state.authToken = null;
        state.adminToken = data.access_token; sessionStorage.setItem("sae.admin.token", state.adminToken);
        $("#admin-login-password").value = ""; await openAllocatorWorkbench();
      } catch (error) { setAdminLoginMessage(error.message, true); }
      finally { button.disabled = false; }
    });
    $("#admin-logout").addEventListener("click", adminSignOut);
    $("#admin-global-signout").addEventListener("click", adminSignOut);
    $("#refresh-accounts").addEventListener("click", () => loadAdminAccounts().then(() => setAdminAccountMessage("Account list refreshed.")).catch((error) => setAdminAccountMessage(error.message, true)));
    $("#admin-create-account-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        const data = await adminRequest("/admin/accounts", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: $("#new-account-email").value, candidate_id: $("#new-account-candidate").value, display_name: $("#new-account-name").value, password: $("#new-account-password").value }),
        });
        event.target.reset(); await loadAdminAccounts(); await loadDemoProfiles();
        setAdminAccountMessage(`Created candidate account for ${data.display_name}.`);
      } catch (error) { setAdminAccountMessage(error.message, true); }
    });
    $("#admin-reset-account-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        await adminRequest(`/admin/accounts/${encodeURIComponent($("#reset-account-email").value)}/reset-password`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ new_password: $("#reset-account-password").value }),
        });
        event.target.reset(); await loadAdminAccounts();
        setAdminAccountMessage("Password reset. Existing tokens for that candidate were revoked.");
      } catch (error) { setAdminAccountMessage(error.message, true); }
    });
    $("#admin-password-form").addEventListener("submit", async (event) => {
      event.preventDefault(); await changePassword(adminRequest, "#admin-current-password", "#admin-new-password", "#admin-account-message", "sae.admin.token", "admin");
    });
    $("#candidate-password-form").addEventListener("submit", async (event) => {
      event.preventDefault(); await changePassword(candidateRequest, "#candidate-current-password", "#candidate-new-password", "#candidate-password-message", "sae.candidate.token", "candidate");
    });
    state.authToken = sessionStorage.getItem("sae.candidate.token");
    state.adminToken = sessionStorage.getItem("sae.admin.token");
    if (state.authToken) {
      sessionStorage.removeItem("sae.admin.token"); state.adminToken = null; await openCandidatePortal();
    } else if (state.adminToken) {
      await openAllocatorWorkbench();
    } else {
      showRoleChoice();
    }
    setConnection(true, "Local service");
  });
})();