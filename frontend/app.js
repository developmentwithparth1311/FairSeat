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
