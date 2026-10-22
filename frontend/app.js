(() => {
  "use strict";

  const $ = (selector) => document.querySelector(selector);
  const state = { valid: false, result: null, selected: null, traceIndex: 0, scenarios: null, datasetName: "Synthetic sample data", synthetic: true };
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
  function setConnection(ok, text) {
    const el = $("#connection-status"); el.textContent = text; el.className = `status-pill ${ok ? "status-ready" : "status-error"}`;
  }
  function invalidateValidation() {
    state.valid = false; $("#run-button").disabled = true; $("#preview-area").hidden = true;
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
    await validateData(); showToast("Synthetic sample loaded and validated.");
  }
  async function validateData() {
    const message = $("#validation-message"); message.className = "validation-message"; message.textContent = "Checking CSV files with the allocation engine…";
    $("#validate-button").disabled = true; $("#run-button").disabled = true;
    try {
      const data = await request("/demo/validate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ candidates_csv: $("#candidates-csv").value, companies_csv: $("#companies-csv").value }) });
      state.valid = true; $("#run-button").disabled = false;
      message.className = "validation-message success"; message.textContent = "Validation passed. The allocation engine accepted both files.";
      $("#preview-counts").textContent = `${data.candidates} candidates · ${data.companies} opportunities · first ${data.preview_limit} rows shown`;
      renderPreview($("#candidate-preview"), data.candidate_preview); renderPreview($("#company-preview"), data.company_preview);
      $("#preview-area").hidden = false; setConnection(true, "Engine ready");
    } catch (error) {
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
    const statusText = c.allocation.status === "matched" ? `Placed at ${assignedCompany?.name || c.allocation.company_id}` : "No acceptable seat remained for this candidate.";
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
    if (!all.length) { $("#trace-position").textContent = "No trace yet"; $("#trace-event").innerHTML = "<h3>Run the allocator to inspect its trace</h3><p>Competition and displacement events will appear here.</p>"; $("#trace-queue").textContent = "No trace loaded"; $("#trace-heaps").innerHTML = ""; $("#trace-prev").disabled = $("#trace-next").disabled = $("#jump-displacement").disabled = true; return; }
    if (!visible.length) { $("#trace-event").innerHTML = "<h3>No key events in the trace</h3><p>Turn off the key events filter to see every recorded step.</p>"; return; }
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
    try { state.scenarios = await request("/demo/scenarios"); renderScenarios(); }
    catch (error) { $("#scenario-message").textContent = error.message; showToast(error.message, true); }
    finally { button.disabled = false; }
  }
  function renderScenarios() {
    const rows = state.scenarios.rows; const scenarios = [...new Set(rows.map((row) => row.scenario))];
    $("#scenario-message").textContent = `Seed ${state.scenarios.seed} · ${scenarios.length} scenarios · ${rows.length} cohort summaries · synthetic data only.`;
    $("#scenario-results").hidden = false;
    $("#scenario-bars").innerHTML = '<div class="legend"><span>Cohort A</span><span>Cohort B</span></div>' + scenarios.map((name) => {
      const group = rows.filter((row) => row.scenario === name), a = group.find((row) => row.cohort.endsWith("A")), b = group.find((row) => row.cohort.endsWith("B"));
      const ar = a && Number(a.eligible) ? Number(a.allocated) / Number(a.eligible) : 0, br = b && Number(b.eligible) ? Number(b.allocated) / Number(b.eligible) : 0;
      return `<div class="scenario-row"><span class="scenario-name" title="${esc(name)}">${esc(human(name))}</span><div class="scenario-track" title="A ${pct(ar)} · B ${pct(br)}"><span class="group-a" style="width:${Math.min(100, ar * 100)}%"></span><span class="group-b" style="width:${Math.min(100, br * 100)}%"></span></div><span class="scenario-value">A ${pct(ar)} · B ${pct(br)}</span></div>`;
    }).join("");
    $("#scenario-rows").innerHTML = rows.map((r) => `<tr><td>${esc(human(r.scenario))}</td><td>${esc(r.cohort.replace("synthetic_group_", ""))}</td><td>${esc(r.eligible)}</td><td>${esc(r.allocated)}</td><td>${esc(r.unmatched)}</td><td>${fmt(r.average_score)}</td><td>${esc(r.changed_assignments)}</td><td>${esc(r.seats_filled)}</td></tr>`).join("");
  }
  function activateView(name) {
    document.querySelectorAll(".tab").forEach((tab) => { const active = tab.dataset.view === name; tab.classList.toggle("active", active); if (active) tab.setAttribute("aria-current", "page"); else tab.removeAttribute("aria-current"); });
    document.querySelectorAll(".view").forEach((view) => { const active = view.id === `${name}-view`; view.classList.toggle("active", active); view.hidden = !active; });
  }

  document.addEventListener("DOMContentLoaded", async () => {
    document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => activateView(tab.dataset.view)));
    $("#load-sample").addEventListener("click", () => loadSample().catch((error) => showToast(error.message, true)));
    $("#validate-button").addEventListener("click", validateData);
    $("#run-button").addEventListener("click", async () => {
      if (!state.valid) return;
      const button = $("#run-button"); button.disabled = true; button.textContent = "Running allocation…";
      try {
        const data = await request("/demo/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ candidates_csv: $("#candidates-csv").value, companies_csv: $("#companies-csv").value, dataset_name: state.datasetName, synthetic: state.synthetic }) });
        renderResults(data); setConnection(true, "Engine ready"); showToast(`Allocation complete for ${data.summary.candidates} candidates.`);
      } catch (error) { showToast(error.message, true); }
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
    });
    ["#candidates-csv", "#companies-csv"].forEach((selector) => $(selector).addEventListener("input", invalidateValidation));
    ["#candidate-search", "#sector-filter", "#outcome-filter"].forEach((selector) => $(selector).addEventListener("input", renderCandidateRows));
    $("#trace-prev").addEventListener("click", () => setTraceIndex(state.traceIndex - 1));
    $("#trace-next").addEventListener("click", () => setTraceIndex(state.traceIndex + 1));
    $("#trace-slider").addEventListener("input", (event) => setTraceIndex(Number(event.target.value)));
    $("#trace-filter").addEventListener("change", () => { state.traceIndex = 0; renderTrace(); });
    $("#jump-displacement").addEventListener("click", () => { const next = visibleTraceIndexes().findIndex(({ event }, index) => index > state.traceIndex && event.type === "displaced"); if (next >= 0) setTraceIndex(next); });
    $("#load-scenarios").addEventListener("click", loadScenarios);
    setConnection(true, "Local service");
    try { await loadSample(); } catch (error) { setConnection(false, "Service unavailable"); $("#validation-message").textContent = `Could not load sample data: ${error.message}`; }
  });
})();
