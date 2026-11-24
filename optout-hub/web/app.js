const $ = (id) => document.getElementById(id);
let ME = null;

// Global "working" spinner: shown while any request is in flight, so the user
// isn't left wondering. A short delay avoids flashing it for fast requests.
let PENDING = 0;
let spinTimer = null;
function spinStart() {
  PENDING++;
  if (PENDING === 1 && !spinTimer) {
    spinTimer = setTimeout(() => { spinTimer = null; const s = $('spinner'); if (s) s.classList.add('show'); }, 150);
  }
}
function spinEnd() {
  PENDING = Math.max(0, PENDING - 1);
  if (PENDING === 0) {
    if (spinTimer) { clearTimeout(spinTimer); spinTimer = null; }
    const s = $('spinner'); if (s) s.classList.remove('show');
  }
}

// CSRF: the per-session token from /api/auth/me, echoed in X-CSRF-Token on every
// mutating same-origin request. Wrapping fetch once covers all call sites — and
// is also where the spinner counter is driven.
let CSRF = null;
const _origFetch = window.fetch.bind(window);
window.fetch = (input, init = {}) => {
  const method = (init.method || 'GET').toUpperCase();
  const url = typeof input === 'string' ? input : (input && input.url) || '';
  const sameOrigin = url.startsWith('/') || url.startsWith(location.origin);
  if (CSRF && sameOrigin && method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    const headers = new Headers(init.headers || {});
    headers.set('X-CSRF-Token', CSRF);
    init = { ...init, headers };
  }
  spinStart();
  return _origFetch(input, init).finally(spinEnd);
};
const RANK = { viewer: 1, operator: 2, approver: 3, admin: 4 };
const can = (role) => ME && RANK[ME.role] >= RANK[role];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// Turn the raw consent-state vocabulary (opted_in / opted_out / suppressed / …)
// used in the Expected and Observed alert columns into plain language a
// non-technical reader can act on.
function humanState(s) {
  return ({
    opted_in: 'Opted in — reachable',
    opted_out: 'Opted out',
    suppressed: 'Suppressed (opted out elsewhere)',
    none: 'No record on this platform',
    unwritable: "Can't be read or written",
  }[s]) ?? (s ? String(s) : '—');
}

// Turn the reconciler's internal reason strings into a full-sentence
// explanation of why the alert was raised and what it means.
function humanReason(r) {
  return ({
    'unwritable divergence':
      "This platform can't accept opt-out updates from us, so its record differs from ours. The person is kept opted out by withholding messages.",
    'system does not accept hub opt-out writes':
      "This platform doesn't accept opt-out updates from us. The person is kept opted out by withholding messages instead of changing the platform's record.",
    'platform reports opt-out the hub has not ingested; investigate — never auto-overridden':
      "The platform shows this person opted out, but we haven't recorded that yet. Someone should look into it — we never override a platform's opt-out automatically.",
  }[r]) ?? (r ? String(r) : '—');
}

let SYSTEMS = [];

document.querySelectorAll('nav button[data-tab]').forEach((b) => {
  b.addEventListener('click', () => {
    // The top nav is a navigation landmark (not a tablist); mark the active
    // destination with aria-current="page" — valid on plain buttons, unlike
    // aria-selected (which requires a tab/option role).
    document.querySelectorAll('nav button').forEach((x) => x.removeAttribute('aria-current'));
    document.querySelectorAll('main section').forEach((s) => (s.hidden = true));
    $('tab-' + b.dataset.tab).hidden = false;
    const dd = b.closest('.dropdown-content');
    if (dd) {
      // Item lives under a dropdown — mark that menu's button as current.
      dd.closest('.dropdown').querySelector('.dropbtn').setAttribute('aria-current', 'page');
      closeMenus();
    } else {
      b.setAttribute('aria-current', 'page');
    }
    refresh();
  });
});

function closeMenus() {
  document.querySelectorAll('nav .dropdown-content.open').forEach((d) => d.classList.remove('open'));
  document.querySelectorAll('nav .dropbtn').forEach((b) => b.setAttribute('aria-expanded', 'false'));
}
document.querySelectorAll('nav .dropbtn').forEach((btn) => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const content = btn.parentElement.querySelector('.dropdown-content');
    const wasOpen = content.classList.contains('open');
    closeMenus();  // only one menu open at a time
    if (!wasOpen) {
      content.classList.add('open');
      btn.setAttribute('aria-expanded', 'true');
    }
  });
});
document.addEventListener('click', () => closeMenus());

$('inj-direction').addEventListener('change', (e) => {
  $('inj-evidence').hidden = e.target.value !== 'opt_in';
});

function stateBadge(s) {
  if (!s) return '<span class="badge b-unknown">—</span>';
  const cls = s.state === 'opted_in' ? 'b-in' : s.state === 'opted_out' ? 'b-out'
            : s.state === 'suppressed' ? 'b-supp' : 'b-unknown';
  const label = s.state.replace('_', ' ');
  const dot = s.provenance === 'explicit' ? 'explicit' : 'derived';
  return `<span class="badge ${cls}" title="${esc(s.state)} (${esc(s.provenance)})">` +
         `<span class="dot ${dot}"></span>${esc(label)}</span>`;
}

let MATRIX_SYSTEMS = [];
let MATRIX_IDENTITIES = [];

async function loadMatrix() {
  const [systems, identities] = await Promise.all([
    fetch('/api/systems').then((r) => r.json()),
    fetch('/api/identities').then((r) => r.json()),
  ]);
  SYSTEMS = systems;
  MATRIX_SYSTEMS = systems;
  MATRIX_IDENTITIES = identities;
  const sel = $('inj-system');
  sel.innerHTML = systems.map((s) =>
    `<option value="${esc(s.id)}">${esc(s.name)} · ${esc(s.channel)}</option>`).join('');
  const topoSel = $('topo-system');
  const keep = topoSel.value;
  topoSel.innerHTML = systems.map((s) =>
    `<option value="${esc(s.id)}">${esc(s.name)}${s.can_discover_topology ? '' : ' · annotate-only'}</option>`).join('');
  if (keep && systems.some((s) => s.id === keep)) topoSel.value = keep;

  // Summary stat cards + header status pill (all from real data).
  const optouts = identities.filter((i) =>
    i.states.some((s) => s.state === 'opted_out' || s.state === 'suppressed')).length;
  $('stat-identities').textContent = identities.length.toLocaleString();
  $('stat-systems').textContent = systems.length;
  $('stat-optouts').textContent = optouts.toLocaleString();
  const pill = $('systems-pill');
  if (pill) { pill.hidden = false; $('systems-connected').textContent =
    `${systems.length} system${systems.length === 1 ? '' : 's'} connected`; }

  renderMatrix();
}

function renderMatrix() {
  const systems = MATRIX_SYSTEMS;
  if (!MATRIX_IDENTITIES.length) {
    $('matrix').innerHTML = '<div class="empty">No identities yet. Simulate an event to begin, or run the demo script.</div>';
    return;
  }
  const q = ($('matrix-search') ? $('matrix-search').value : '').toLowerCase().trim();
  const matched = q ? MATRIX_IDENTITIES.filter((i) => i.value_normalized.toLowerCase().includes(q)) : MATRIX_IDENTITIES;
  if (!matched.length) {
    $('matrix').innerHTML = `<div class="empty">No identities match “${esc(q)}”.</div>`;
    return;
  }
  // Home view shows only the latest 100 (list is newest-first); a search spans
  // every loaded identity, so the rest are reachable by searching.
  const CAP = 100;
  const rows = q ? matched : matched.slice(0, CAP);
  const note = (!q && matched.length > CAP)
    ? `<div class="muted" style="margin-bottom:8px">Showing the latest ${CAP} of ${matched.length.toLocaleString()} identities. Use search to find others.</div>`
    : '';
  let html = note + '<table><tr><th>Identity</th>' +
    systems.map((s) => `<th>${esc(s.name)}<br><span class="mono" style="text-transform:none">${esc(s.channel)}</span></th>`).join('') +
    '</tr>';
  for (const i of rows) {
    const by = Object.fromEntries(i.states.map((s) => [s.system_id, s]));
    html += `<tr><td class="mono">${esc(i.value_normalized)}</td>` +
      systems.map((s) => `<td>${stateBadge(by[s.id])}</td>`).join('') + '</tr>';
  }
  $('matrix').innerHTML = html + '</table>';
}

function filterMatrix() { renderMatrix(); }

// Toast helper (bottom-right).
let TOAST_TIMER = null;
function showToast(message) {
  const t = $('toast');
  if (!t) return;
  $('toast-message').textContent = message;
  t.classList.add('show');
  clearTimeout(TOAST_TIMER);
  TOAST_TIMER = setTimeout(() => t.classList.remove('show'), 3200);
}

async function injectEvent() {
  const direction = $('inj-direction').value;
  const body = {
    system_id: $('inj-system').value,
    identity_value: $('inj-value').value,
    direction,
    source_detail: $('inj-source').value || undefined,
    occurred_at: $('inj-occurred').value || undefined,
  };
  if (direction === 'opt_in') {
    body.evidence = {
      method: $('inj-method').value || 'console entry',
      consent_language: $('inj-language').value || undefined,
    };
  }
  const f = $('inj-flash');
  f.className = 'flash';
  try {
    const r = await fetch('/api/events', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error);
    f.className = 'flash ok';
    f.textContent = 'Ingested: ' + j.kind + (j.detail?.review?.request_id
      ? ` — review #${j.detail.review.request_id} queued` : '');
    refresh();
  } catch (e) {
    f.className = 'flash err';
    f.textContent = e.message;
  }
}

async function loadReviews() {
  const reviews = await fetch('/api/approvals?status=pending').then((r) => r.json());
  const c = $('pending-count');
  c.hidden = reviews.length === 0;
  c.textContent = reviews.length;
  if ($('stat-reviews')) $('stat-reviews').textContent = reviews.length;
  if (!reviews.length) {
    $('reviews').innerHTML = '<div class="empty">No pending reviews. Opt-ins are flowing without propagation questions.</div>';
    return;
  }
  $('reviews').innerHTML = reviews.map((rv) => {
    const events = (rv.originating_events ?? []).map((e) =>
      `<div class="evrow"><span class="mono">${esc(e.system_id)}</span> · ${esc(e.source_detail ?? '')}` +
      ` · ${new Date(e.occurred_at).toLocaleString()}` +
      (e.consent_language ? `<br><em>"${esc(e.consent_language)}"</em>` : '') + '</div>').join('');
    const targets = (rv.targets ?? []).map((t) => {
      const sys = SYSTEMS.find((s) => s.id === t.system_id) ?? { name: t.system_id, channel: '' };
      const isExplicitOut = t.snapshot_state === 'opted_out' && t.snapshot_provenance === 'explicit';
      return `<div class="tgt">
        <input type="checkbox" data-req="${rv.id}" value="${esc(t.system_id)}" ${t.preselected ? 'checked' : ''}>
        <strong>${esc(sys.name)}</strong> <span class="mono">${esc(sys.channel)}</span>
        ${stateBadge({ state: t.snapshot_state, provenance: t.snapshot_provenance })}
        ${isExplicitOut ? '<span style="font-size:12.5px;color:var(--out)">will be skipped — the person opted out here directly</span>' : ''}
      </div>`;
    }).join('');
    return `<div class="review">
      <h3><span class="mono">${esc(rv.value_normalized)}</span> · ${esc(rv.channel)} opt-in · review #${rv.id} (v${rv.version})</h3>
      <div class="meta">Created ${new Date(rv.created_at).toLocaleString()} · expires ${new Date(rv.expires_at).toLocaleString()}</div>
      <div class="origin"><strong>What the person did:</strong>${events}</div>
      <strong style="font-size:13px">Propagate this opt-in to:</strong>
      ${targets}
      <label for="att-${rv.id}">Attestation</label>
      <textarea id="att-${rv.id}" rows="2">I have reviewed the consent evidence and confirm it covers the selected systems and channels.</textarea>
      <br>
      <button class="primary" data-act="decide-review" data-id="${rv.id}" data-version="${rv.version}" data-decision="approved">Approve selected</button>
      <button class="quiet" data-act="decide-review" data-id="${rv.id}" data-version="${rv.version}" data-decision="denied">Keep local only</button>
      <div class="flash" role="status" id="rev-flash-${rv.id}"></div>
    </div>`;
  }).join('');
}

async function decideReview(id, version, outcome) {
  const selected = [...document.querySelectorAll(`input[data-req="${id}"]:checked`)].map((x) => x.value);
  const f = $('rev-flash-' + id);
  f.className = 'flash';
  try {
    const r = await fetch(`/api/approvals/${id}/decide`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        version, outcome,
        selectedTargets: outcome === 'approved' ? selected : [],
        attestationText: $('att-' + id).value,
      }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error);
    f.className = 'flash ok';
    f.textContent = outcome === 'approved'
      ? 'Approved. ' + (j.targets ?? []).map((t) => `${t.system}: ${t.outcome}`).join(' · ')
      : 'Kept local — no propagation.';
    setTimeout(refresh, 900);
  } catch (e) {
    f.className = 'flash err';
    f.textContent = e.message + (String(e.message).includes('stale') ? ' — reloading with current context.' : '');
    if (String(e.message).includes('stale')) setTimeout(refresh, 1200);
  }
}

async function loadAlerts() {
  const alerts = await fetch('/api/alerts').then((r) => r.json());
  $('alerts').innerHTML = alerts.length
    ? '<table><tr><th>When</th><th>Identity</th><th>System</th><th>Expected</th><th>Observed</th><th>Reason</th></tr>' +
      alerts.map((a) => `<tr><td>${new Date(a.created_at).toLocaleString()}</td>
        <td class="mono">${esc(a.value_normalized)}</td><td class="mono">${esc(a.system_id)}</td>
        <td>${esc(humanState(a.expected))}</td><td>${esc(humanState(a.observed))}</td><td class="muted">${esc(humanReason(a.reason))}</td></tr>`).join('') + '</table>'
    : '<div class="empty">No unresolved alerts.</div>';
}

async function loadAudit() {
  const rows = await fetch('/api/audit').then((r) => r.json());
  $('audit').innerHTML = rows.length
    ? '<table><tr><th>When</th><th>Actor</th><th>Action</th><th>Detail</th></tr>' +
      rows.map((a) => `<tr><td>${new Date(a.at).toLocaleString()}</td><td>${esc(a.actor_label ?? '—')}</td>
        <td class="mono">${esc(a.action)}</td><td class="mono wrap-any" style="font-size:12px">${esc(JSON.stringify(a.detail))}</td></tr>`).join('') + '</table>'
    : '<div class="empty">Nothing yet.</div>';
}

async function loadStatus() {
  if (!can('operator')) return;
  const s = await fetch('/api/status').then((r) => (r.ok ? r.json() : null));
  if (!s) return;
  const lag = s.syncLag;
  $('sys-breaches').textContent = lag ? lag.breaches : 0;
  $('sys-breaches').style.color = lag && lag.breaches ? 'var(--out)' : '';
  $('sys-unconfirmed').textContent = s.liability.unconfirmedWrites;
  $('sys-alerts').textContent = s.liability.unresolvedAlerts;
  $('sys-reviews').textContent = s.liability.pendingReviews;

  $('sys-synclag').innerHTML = lag
    ? '<table><tr><th>Severity</th><th>Identity</th><th>Target system</th><th>Lag</th></tr>' +
      lag.examples.map((e) => `<tr><td>${esc(e.severity)}</td><td class="mono">${esc(e.identity)}</td>
        <td class="mono">${esc(e.target_system)}</td><td>${e.lag_hours}h</td></tr>`).join('') + '</table>' +
      `<p class="muted">${lag.breaches} breach(es), ${lag.warns} warning(s); worst ~${lag.worstLagHours}h.</p>`
    : '<div class="empty">All opt-outs converged within the threshold.</div>';

  const sc = s.scheduler;
  const job = (label, val, unit, route, last) => `<tr><td>${label}</td>
    <td>${val > 0 ? val + ' ' + unit : '<span class="muted">disabled</span>'}</td>
    <td class="mono" style="font-size:12px">${route}</td>
    <td>${last ? new Date(last).toLocaleString() : '<span class="muted">—</span>'}</td></tr>`;
  $('sys-scheduler').innerHTML = '<table><tr><th>Job</th><th>Interval</th><th>On-demand route</th><th>Last scheduled run</th></tr>' +
    job('Reconciliation', sc.reconcileIntervalMinutes, 'min', 'POST /api/reconcile', s.lastRuns.reconcile) +
    job('Audit prune', sc.pruneIntervalHours, 'hr', 'POST /api/consent-checks/prune', null) +
    job('Inbound poll', sc.pollIntervalMinutes, 'min', 'POST /api/poll', null) +
    job('Sync-lag scan', sc.alertScanMinutes, 'min', 'POST /api/alerts/scan', s.lastRuns.alertScan) +
    '</table>';

  const rd = s.readiness;
  if (rd && $('sys-readiness')) {
    const mark = { pass: '✓', warn: '⚠', manual: '○' };
    const summary = rd.overall === 'ready'
      ? '<span class="rd-pass">✓ Production ready</span> — all automated checks pass.'
      : `<span class="rd-warn">⚠ ${rd.warnCount} item(s) need attention.</span>`;
    $('sys-readiness').innerHTML =
      `<p style="margin-top:0">${summary} <span class="muted">Manual items are listed for you to verify.</span></p>` +
      '<table><tr><th><span class="sr-only">Status</span></th><th>Check</th><th>Detail</th></tr>' +
      rd.checks.map((c) => `<tr><td class="rd-${esc(c.status)}">${mark[c.status] || ''}</td>
        <td>${esc(c.label)}</td><td class="muted">${esc(c.detail)}</td></tr>`).join('') +
      '</table>';
  }

  loadInboundStatus();
}

const DELIVERY_LABEL = { webhook: 'Webhook', poll: 'Poll', none: '—' };

async function loadInboundStatus() {
  if (!can('operator')) return;
  const rows = await fetch('/api/inbound-status').then((r) => (r.ok ? r.json() : []));
  if (!rows.length) {
    $('sys-inbound').innerHTML = '<div class="empty">No active services.</div>';
    return;
  }
  const when = (v) => (v ? new Date(v).toLocaleString() : '<span class="muted">never</span>');
  $('sys-inbound').innerHTML =
    '<table><tr><th>Service</th><th>Type</th><th>Inbound method</th><th>Last inbound</th><th>Last poll</th><th>30-day inbound</th><th><span class="sr-only">Actions</span></th></tr>' +
    rows.map((r) => `<tr>
      <td>${esc(r.name)}</td>
      <td class="mono">${esc(r.adapter_type)}</td>
      <td>${DELIVERY_LABEL[r.delivery] ?? esc(r.delivery)}</td>
      <td>${when(r.lastInboundAt)}</td>
      <td>${r.delivery === 'poll' ? when(r.lastPolledAt) : '<span class="muted">n/a</span>'}</td>
      <td>${r.inbound30d}</td>
      <td>${r.delivery === 'poll' ? `<button class="quiet" data-act="poll-system" data-system-id="${esc(r.id)}">Poll now</button>` : ''}</td>
    </tr>`).join('') + '</table>';
}

async function pollSystemNow(id) {
  const j = await fetch('/api/poll/' + encodeURIComponent(id), { method: 'POST' }).then((r) => r.json());
  if (j.error) { showToast('Poll failed: ' + j.error); return; }
  showToast(`Polled ${j.system} — fetched ${j.fetched}, ingested ${j.ingested}${j.errors ? ', ' + j.errors + ' error(s)' : ''}.`);
  loadInboundStatus();
}

async function pollAllNow() {
  const btn = $('sys-pollall-btn'); const note = $('sys-pollall-note');
  btn.disabled = true; note.textContent = 'Polling…';
  try {
    const summaries = await fetch('/api/poll', { method: 'POST' }).then((r) => r.json());
    const ingested = summaries.reduce((n, s) => n + s.ingested, 0);
    note.textContent = summaries.length
      ? `Polled ${summaries.length} service(s); ingested ${ingested}.`
      : 'No poll-delivery services.';
    showToast(`Poll complete — ${ingested} event(s) ingested across ${summaries.length} service(s).`);
    loadInboundStatus();
  } finally {
    btn.disabled = false;
  }
}

async function runAlertScan() {
  const btn = $('sys-scan-btn'); const note = $('sys-scan-note');
  btn.disabled = true; note.textContent = 'Scanning…';
  try {
    const j = await fetch('/api/alerts/scan', { method: 'POST' }).then((r) => r.json());
    const a = j.alert;
    note.textContent = a ? `${a.breaches} breach(es), ${a.warns} warning(s).` : 'All clear.';
    showToast(a ? `Sync-lag alert raised — ${a.breaches} breach(es), ${a.warns} warning(s).` : 'Sync-lag scan: all clear.');
    loadStatus();
  } finally {
    btn.disabled = false;
  }
}

async function runReconcile() {
  const f = $('matrix-flash');
  const j = await fetch('/api/reconcile', { method: 'POST' }).then((r) => r.json());
  f.className = 'flash ok';
  f.textContent = `Checked ${j.checked} pairs · corrected ${j.corrected.length} · alerts ${j.alerts.length}`;
  showToast(`Reconciliation complete — ${j.corrected.length} corrected, ${j.alerts.length} alert${j.alerts.length === 1 ? '' : 's'}.`);
  refresh();
}

async function pruneConsentChecks() {
  const f = $('consent-prune-flash'); f.className = 'flash';
  try {
    const j = await postJson('POST', '/api/consent-checks/prune', {});
    f.className = 'flash ok';
    f.textContent = `Pruned ${j.suppress_pruned} suppress (kept ${j.suppress_days}d) `
      + `and ${j.other_pruned} allow/error (kept ${j.other_days}d) rows.`;
    loadAudit();
  } catch (e) { f.className = 'flash err'; f.textContent = e.message; }
}

async function pruneAuditLog() {
  const f = $('audit-prune-flash'); f.className = 'flash';
  try {
    const j = await postJson('POST', '/api/audit-log/prune', {});
    f.className = 'flash ok';
    f.textContent = `Pruned ${j.pruned} operational row(s) older than ${j.retain_days}d `
      + `(kept compliance actions: ${j.retained_actions.join(', ')}).`;
    loadAudit();
  } catch (e) { f.className = 'flash err'; f.textContent = e.message; }
}

async function login() {
  const f = $('li-flash');
  f.className = 'flash';
  const r = await fetch('/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: $('li-username').value, password: $('li-password').value }),
  });
  const j = await r.json();
  if (!r.ok) { f.className = 'flash err'; f.textContent = j.error; return; }
  $('li-password').value = '';
  init();
}

async function logout() {
  await fetch('/api/auth/logout', { method: 'POST' });
  ME = null;
  init();
}

function applyRoleGates() {
  $('user-chip').textContent = ME ? `${ME.display_name} · ${ME.role}` : '';
  const av = $('user-avatar');
  if (av) {
    av.hidden = !ME;
    av.textContent = ME ? (ME.display_name || ME.username || '?').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase() : '';
    av.title = ME ? `${ME.display_name} · ${ME.role}` : '';
  }
  $('logout-btn').hidden = !ME;

  // Menu/tab visibility mirrors the backend's requireRole — a role only SEES the
  // items it can actually use. This is UX only; the server still enforces every
  // route, so hiding here never grants access and the API stays the real gate.
  const navTab = (tab) => document.querySelector(`nav > button[data-tab="${tab}"]`);
  if (navTab('approvals')) navTab('approvals').hidden = !can('approver');       // decide = approver+
  const injectItem = document.querySelector('#ops-dropdown button[data-tab="inject"]');
  if (injectItem) injectItem.hidden = !can('operator');                         // Simulate event = operator+
  $('ops-system-item').hidden = !can('operator');                              // System = operator+
  $('admin-menu').hidden = !can('admin');                                      // Services/Users/Settings/Appearance = admin
  $('consent-prune-card').hidden = !can('admin');
  $('audit-prune-card').hidden = !can('admin');
}

async function loadUsers() {
  if (!can('admin')) return;
  const users = await fetch('/api/users').then((r) => r.json());
  $('users-table').innerHTML = '<table><tr><th>User</th><th>Role</th><th>Status</th><th>Credentials</th><th>Actions</th></tr>' +
    users.map((u) => `<tr>
      <td><strong>${esc(u.display_name)}</strong><br><span class="mono">${esc(u.username)}</span></td>
      <td><select aria-label="Role for ${esc(u.username)}" data-change="patch-user-role" data-id="${u.id}" ${u.id===ME.id?'disabled':''}>
        ${['viewer','operator','approver','admin'].map((r)=>`<option ${r===u.role?'selected':''}>${r}</option>`).join('')}
      </select></td>
      <td>${esc(u.status)}</td>
      <td style="font-size:12.5px">${u.has_local_credential ? 'local password' : ''}${(u.sso_links??[]).map((l)=>'<br>SSO: '+esc(l.provider)).join('')}</td>
      <td>
        <button class="quiet" style="margin-top:0;padding:4px 10px" ${u.id===ME.id?'disabled':''}
          data-act="patch-user-status" data-id="${u.id}" data-status="${u.status==='active'?'disabled':'active'}">${u.status==='active'?'Disable':'Enable'}</button>
        <button class="quiet" style="margin-top:0;padding:4px 10px"
          data-act="reset-pw" data-id="${u.id}" data-username="${esc(u.username)}">Reset password</button>
      </td></tr>`).join('') + '</table>';
}

async function patchUser(id, body) {
  const r = await fetch('/api/users/' + id, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!r.ok) alert((await r.json()).error);
  loadUsers();
}

async function resetPw(id, password) {
  const r = await fetch(`/api/users/${id}/password`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }),
  });
  if (!r.ok) alert((await r.json()).error);
}

async function createUserUi() {
  const f = $('nu-flash');
  f.className = 'flash';
  const body = {
    username: $('nu-username').value, display_name: $('nu-display').value,
    role: $('nu-role').value, password: $('nu-password').value || undefined,
  };
  const r = await fetch('/api/users', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) { f.className = 'flash err'; f.textContent = j.error; return; }
  f.className = 'flash ok'; f.textContent = 'User created.';
  $('nu-username').value = $('nu-display').value = $('nu-password').value = '';
  loadUsers();
}

// ---- Reports ----------------------------------------------------------------

const sysName = (id) => { const s = SYSTEMS.find((x) => x.id === id); return s ? s.name : id; };
const sevBadge = (s) => `<span class="sev sev-${esc(s)}">${esc(s)}</span>`;
function dur(sec) {
  sec = Math.max(0, Math.round(Number(sec)));
  if (sec < 90) return sec + 's';
  const m = Math.round(sec / 60); if (m < 90) return m + 'm';
  const h = Math.round(m / 60); if (h < 48) return h + 'h';
  return Math.round(h / 24) + 'd';
}

document.querySelectorAll('#tab-reports .subnav button').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('#tab-reports .subnav button')
      .forEach((x) => x.setAttribute('aria-selected', 'false'));
    b.setAttribute('aria-selected', 'true');
    ['lookup', 'audit', 'lag', 'liability', 'activity', 'topology']
      .forEach((k) => { $('rpt-' + k).hidden = k !== b.dataset.rpt; });
    if (b.dataset.rpt === 'audit') loadAuditFacets();
    if (b.dataset.rpt === 'liability') runLiability();
    if (b.dataset.rpt === 'topology') runTopologyReport();
  });
});

async function runLookup() {
  const q = $('lk-q').value.trim();
  const f = $('lk-flash'); f.className = 'flash'; $('lk-result').innerHTML = '';
  if (!q) { f.className = 'flash err'; f.textContent = 'Enter a phone or email.'; return; }
  const r = await fetch('/api/reports/identity?q=' + encodeURIComponent(q));
  const j = await r.json();
  if (!r.ok) { f.className = 'flash err'; f.textContent = j.error; return; }
  renderPacket(j);
}

function renderPacket(p) {
  const id = p.identity.id;
  const states = p.states.length ? '<table><tr><th>System</th><th>State</th><th>Updated</th></tr>' +
    p.states.map((s) => `<tr><td>${esc(sysName(s.system_id))}</td>
      <td>${stateBadge({ state: s.state, provenance: s.provenance })}</td>
      <td class="muted">${s.updated_at ? new Date(s.updated_at).toLocaleString() : ''}</td></tr>`).join('') +
    '</table>' : '<div class="empty">No system records.</div>';

  const events = p.events.length ? '<table><tr><th>Occurred</th><th>System</th><th>Event</th><th>Provenance</th><th>Source / evidence</th><th>Actor</th></tr>' +
    p.events.map((e) => `<tr>
      <td>${new Date(e.occurred_at).toLocaleString()}</td>
      <td class="mono">${esc(e.system_id)}</td>
      <td>${esc(String(e.direction).replace('_', ' '))}</td>
      <td>${esc(e.provenance)}</td>
      <td>${esc(e.source_detail ?? '')}${e.evidence_method ? ' · ' + esc(e.evidence_method) : ''}${e.consent_language ? `<br><em class="muted">"${esc(e.consent_language)}"</em>` : ''}</td>
      <td>${esc(e.actor_username ?? e.actor ?? 'System')}</td></tr>`).join('') +
    '</table>' : '<div class="empty">No events.</div>';

  const approvals = (p.approvals ?? []).length ? '<h3 class="rpt">Propagation reviews</h3><table><tr><th>#</th><th>Channel</th><th>Status</th><th>Decided by</th><th>Attestation</th></tr>' +
    p.approvals.map((a) => `<tr><td>${a.id}</td><td>${esc(a.channel)}</td><td>${esc(a.status)}</td>
      <td>${esc(a.decided_by_username ?? a.decided_by ?? '')}</td>
      <td class="muted">${esc(a.attestation_text ?? '')}</td></tr>`).join('') + '</table>' : '';

  const alerts = (p.alerts ?? []).length ? '<h3 class="rpt">Reconciliation alerts</h3><table><tr><th>When</th><th>System</th><th>Expected</th><th>Observed</th><th>Reason</th><th>Resolved</th></tr>' +
    p.alerts.map((a) => `<tr><td>${new Date(a.created_at).toLocaleString()}</td><td class="mono">${esc(a.system_id)}</td>
      <td>${esc(humanState(a.expected))}</td><td>${esc(humanState(a.observed))}</td><td class="muted">${esc(humanReason(a.reason))}</td>
      <td>${a.resolved_at ? new Date(a.resolved_at).toLocaleString() : '—'}</td></tr>`).join('') + '</table>' : '';

  const dl = `<div style="margin:10px 0">
    <a class="button quiet" style="display:inline-block;text-decoration:none;margin-right:8px"
       href="/api/reports/identity/${id}/packet?format=json">Download JSON</a>
    <a class="button quiet" style="display:inline-block;text-decoration:none"
       href="/api/reports/identity/${id}/packet?format=csv">Download CSV (history)</a></div>`;

  $('lk-result').innerHTML = `
    <div class="reach"><strong class="mono">${esc(p.identity.value_normalized)}</strong>
      · ${esc(p.identity.kind)} · created ${new Date(p.identity.created_at).toLocaleDateString()}<br>
      ${esc(p.reachability.summary)}</div>
    ${dl}
    <h3 class="rpt">Current state by system</h3>${states}
    <h3 class="rpt">Full event history (${p.events.length})</h3>${events}
    ${approvals}${alerts}`;
}

async function loadAuditFacets() {
  const f = await fetch('/api/reports/audit/facets').then((r) => r.json());
  $('au-actor').innerHTML = '<option value="">any</option>' + f.actors.map((a) => `<option>${esc(a)}</option>`).join('');
  $('au-action').innerHTML = '<option value="">any</option>' + f.actions.map((a) => `<option>${esc(a)}</option>`).join('');
}

async function runAudit() {
  const p = new URLSearchParams();
  for (const [k, el] of [['actor', 'au-actor'], ['action', 'au-action'], ['from', 'au-from'], ['to', 'au-to']]) {
    if ($(el).value) p.set(k, $(el).value);
  }
  const rows = await fetch('/api/reports/audit?' + p).then((r) => r.json());
  $('au-result').innerHTML = rows.length
    ? '<table><tr><th>When</th><th>Actor</th><th>Action</th><th>Detail</th></tr>' +
      rows.map((a) => `<tr><td>${new Date(a.at).toLocaleString()}</td>
        <td>${esc(a.actor_label ?? '—')}</td><td class="mono">${esc(a.action)}</td>
        <td class="mono wrap-any" style="font-size:12px">${esc(JSON.stringify(a.detail))}</td></tr>`).join('') + '</table>'
    : '<div class="empty">No matching actions.</div>';
}

async function runLag() {
  const p = new URLSearchParams();
  if ($('lag-from').value) p.set('from', $('lag-from').value);
  if ($('lag-to').value) p.set('to', $('lag-to').value);
  const rows = await fetch('/api/reports/sync-lag?' + p).then((r) => r.json());
  $('lag-result').innerHTML = rows.length
    ? '<table><tr><th>Identity</th><th>Opt-out at</th><th>Origin</th><th>Target</th><th>Lag</th><th>Business days</th><th>Converged</th><th><span class="sr-only">Actions</span></th></tr>' +
      rows.map((r) => `<tr><td class="mono">${esc(r.value_normalized)}</td>
        <td>${new Date(r.optout_occurred_at).toLocaleString()}</td>
        <td class="mono">${esc(r.origin_system)}</td><td class="mono">${esc(r.target_system)}</td>
        <td>${dur(r.lag_seconds)}</td><td>${r.business_days}</td>
        <td>${r.converged ? 'yes' : '<span style="color:var(--out)">no</span>'}</td>
        <td>${sevBadge(r.severity)}</td></tr>`).join('') + '</table>'
    : '<div class="empty">No opt-out propagations in range.</div>';
}

async function runLiability() {
  const j = await fetch('/api/reports/liability').then((r) => r.json());
  const alerts = j.unresolved_alerts.length ? '<table><tr><th>Identity</th><th>System</th><th>Expected</th><th>Observed</th><th>Reason</th></tr>' +
    j.unresolved_alerts.map((a) => `<tr><td class="mono">${esc(a.value_normalized)}</td><td class="mono">${esc(a.system_id)}</td>
      <td>${esc(humanState(a.expected))}</td><td>${esc(humanState(a.observed))}</td><td class="muted">${esc(humanReason(a.reason))}</td></tr>`).join('') + '</table>'
    : '<div class="empty">None.</div>';
  const writes = j.unconfirmed_writes.length ? '<table><tr><th>Identity</th><th>System</th><th>Direction</th><th>Issued</th><th>Outstanding</th></tr>' +
    j.unconfirmed_writes.map((w) => `<tr><td class="mono">${esc(w.value_normalized)}</td><td class="mono">${esc(w.system_id)}</td>
      <td>${esc(String(w.direction).replace('_', ' '))}</td><td>${new Date(w.issued_at).toLocaleString()}</td>
      <td>${dur(w.outstanding_seconds)}</td></tr>`).join('') + '</table>'
    : '<div class="empty">None — all hub writes confirmed.</div>';
  const reviews = j.aging_reviews.length ? '<table><tr><th>#</th><th>Identity</th><th>Channel</th><th>Expires</th><th>Time left</th></tr>' +
    j.aging_reviews.map((r) => `<tr><td>${r.id}</td><td class="mono">${esc(r.value_normalized)}</td><td>${esc(r.channel)}</td>
      <td>${new Date(r.expires_at).toLocaleString()}</td>
      <td>${Number(r.seconds_to_expiry) < 0 ? '<span style="color:var(--out)">overdue</span>' : dur(r.seconds_to_expiry)}</td></tr>`).join('') + '</table>'
    : '<div class="empty">No pending reviews.</div>';
  $('liab-result').innerHTML =
    `<h3 class="rpt">Unresolved reconciliation alerts (unwritable divergence)</h3>${alerts}
     <h3 class="rpt">Hub opt-out writes not yet confirmed converged</h3>${writes}
     <h3 class="rpt">Pending propagation reviews</h3>${reviews}`;
}

async function runActivity() {
  const p = new URLSearchParams();
  if ($('act-from').value) p.set('from', $('act-from').value);
  if ($('act-to').value) p.set('to', $('act-to').value);
  const rows = await fetch('/api/reports/activity?' + p).then((r) => r.json());
  $('act-result').innerHTML = rows.length
    ? '<table><tr><th>System</th><th>Channel</th><th>Direction</th><th>Provenance</th><th>Count</th></tr>' +
      rows.map((r) => `<tr><td>${esc(sysName(r.system_id))}</td><td>${esc(r.channel)}</td>
        <td>${esc(String(r.direction).replace('_', ' '))}</td><td>${esc(r.provenance)}</td>
        <td><strong>${r.count}</strong></td></tr>`).join('') + '</table>'
    : '<div class="empty">No events in range.</div>';
}

// ---- Topology (ADR-0002) ----------------------------------------------------

const srcBadge = (s) => `<span class="badge ${s === 'manual' ? 'b-supp' : 'b-in'}"
  title="provenance">${esc(s === 'manual' ? 'manual' : 'discovered')}</span>`;

// The annotate/clear controls refresh whichever topology view is showing — the
// Topology tab or the service-config discovery step. Each view sets this on entry.
let activeTopoRender = loadTopology;

// Build the topology view HTML for a system, shared by the Topology tab and the
// service-config discovery step. `op` enables the annotate/clear controls.
function topologyHtml(v, system, op) {
  const annByCode = Object.fromEntries(v.annotations.map((a) => [a.code_ref, a]));
  const active = v.nodes.filter((n) => !n.decommissioned_at);
  const pools = active.filter((n) => n.kind === 'pool' || n.kind === 'group');
  const codes = active.filter((n) => n.kind === 'code');

  const codeRow = (c) => {
    const ann = annByCode[c.external_ref];
    const conflict = v.conflicts.find((x) => x.code_ref === c.external_ref);
    return `<tr ${conflict ? 'style="background:#fff6f0"' : ''}>
      <td class="mono">${esc(c.external_ref)}</td>
      <td>${esc(c.label ?? '')}</td>
      <td>${ann ? `${esc(ann.label)} ${srcBadge('manual')}` : '<span class="muted">—</span>'}</td>
      <td>${conflict ? `<span style="color:var(--out)" title="discovered: ${esc(conflict.discovered_label)} · manual: ${esc(conflict.manual_label)}">discovery≠annotation (both kept)</span>` : ''}</td>
      ${op ? `<td><button class="quiet" style="margin:0;padding:3px 9px" data-act="annotate-topo" data-system="${esc(system)}" data-ref="${esc(c.external_ref)}">Annotate</button>
        ${ann ? `<button class="quiet" style="margin:0;padding:3px 9px" data-act="unannotate-topo" data-system="${esc(system)}" data-ref="${esc(c.external_ref)}">Clear</button>` : ''}</td>` : '<td></td>'}
    </tr>`;
  };

  let html = `<div class="muted" style="margin-bottom:10px">
    ${v.can_discover_topology ? `Discovery: <strong>on</strong> (granularity: ${esc(v.topology_granularity)})`
      : 'Discovery: <strong>off</strong> — this service can\'t report groupings; use manual annotation.'}</div>`;

  for (const p of pools) {
    const kids = codes.filter((c) => c.parent_ref === p.external_ref);
    html += `<h3 class="rpt">${esc(p.label ?? p.external_ref)} ${srcBadge(p.source === 'manual' ? 'manual' : 'discovered')}
      <span class="mono muted" style="font-size:12px">${esc(p.external_ref)}</span></h3>`;
    html += kids.length
      ? '<table><tr><th>Code</th><th>Label</th><th>Manual annotation</th><th>Conflict</th><th><span class="sr-only">Actions</span></th></tr>'
        + kids.map(codeRow).join('') + '</table>'
      : '<div class="empty">No codes.</div>';
  }

  const ungrouped = codes.filter((c) => !c.parent_ref || !pools.some((p) => p.external_ref === c.parent_ref));
  // Codes that exist only as a manual annotation target (no discovered node).
  const annOnly = v.annotations
    .filter((a) => !codes.some((c) => c.external_ref === a.code_ref))
    .map((a) => ({ external_ref: a.code_ref, label: null, parent_ref: null }));
  const loose = [...ungrouped, ...annOnly];
  if (loose.length) {
    html += '<h3 class="rpt">Ungrouped codes <span class="muted" style="font-size:12px">(source: none)</span></h3>'
      + '<table><tr><th>Code</th><th>Label</th><th>Manual annotation</th><th>Conflict</th><th><span class="sr-only">Actions</span></th></tr>'
      + loose.map(codeRow).join('') + '</table>';
  }

  const decommissioned = v.nodes.filter((n) => n.decommissioned_at);
  if (decommissioned.length) {
    html += `<h3 class="rpt">Decommissioned (kept for historical attribution)</h3>`
      + '<table><tr><th>Kind</th><th>Ref</th><th>Last seen</th></tr>'
      + decommissioned.map((n) => `<tr><td>${esc(n.kind)}</td><td class="mono">${esc(n.external_ref)}</td>
          <td class="muted">${new Date(n.last_seen_at).toLocaleString()}</td></tr>`).join('') + '</table>';
  }

  if (!pools.length && !loose.length) html = '<div class="empty">No topology yet. Sync from the service, or annotate codes manually.</div>';
  return html;
}

async function loadTopology() {
  activeTopoRender = loadTopology;
  const system = $('topo-system').value;
  if (!system) { $('topo-result').innerHTML = ''; return; }
  const r = await fetch('/api/topology?system=' + encodeURIComponent(system));
  const v = await r.json();
  if (!r.ok) { $('topo-result').innerHTML = `<div class="empty">${esc(v.error)}</div>`; return; }
  $('topo-result').innerHTML = topologyHtml(v, system, can('operator'));
}

async function syncTopology() {
  const f = $('topo-flash'); f.className = 'flash';
  const r = await fetch('/api/topology/sync', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ system: $('topo-system').value }),
  });
  const j = await r.json();
  if (!r.ok) { f.className = 'flash err'; f.textContent = j.error; return; }
  const res = j.results[0];
  f.className = 'flash ok';
  f.textContent = res.skipped
    ? `Sync skipped: ${res.skipped}`
    : `Discovered ${res.discovered} · added ${res.added} · updated ${res.updated} · reactivated ${res.reactivated} · decommissioned ${res.decommissioned}`;
  loadTopology();
}

async function annotateTopo(system, codeRef) {
  const label = prompt(`Manual grouping label for ${codeRef}:`);
  if (!label) return;
  const r = await fetch('/api/topology/annotate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ system, code_ref: codeRef, label }),
  });
  if (!r.ok) alert((await r.json()).error); else activeTopoRender();
}

async function unannotateTopo(system, codeRef) {
  const r = await fetch('/api/topology/annotate', {
    method: 'DELETE', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ system, code_ref: codeRef }),
  });
  if (!r.ok) alert((await r.json()).error); else activeTopoRender();
}

async function runTopologyReport() {
  const p = new URLSearchParams();
  if ($('topr-from').value) p.set('from', $('topr-from').value);
  if ($('topr-to').value) p.set('to', $('topr-to').value);
  const rows = await fetch('/api/reports/topology?' + p).then((r) => r.json());
  $('topr-result').innerHTML = rows.length
    ? '<table><tr><th>System</th><th>Receiving code</th><th>Code label</th><th>Discovered pool</th><th>Manual group</th><th>Events</th></tr>'
      + rows.map((r) => `<tr><td>${esc(sysName(r.system_id))}</td><td class="mono">${esc(r.receiving_code)}</td>
        <td>${esc(r.code_label ?? '')}</td><td>${esc(r.discovered_pool ?? '—')}</td>
        <td>${esc(r.manual_group ?? '—')}</td><td><strong>${r.events}</strong></td></tr>`).join('') + '</table>'
    : '<div class="empty">No attributed events in range (events need a receiving code).</div>';
}

// ---- Services (admin: register, connect, discover) --------------------------

let ADAPTER_TYPES = [];
let SVC_EDITING = null;   // system id when configuring, null when registering new

// ---- Message categories (shared: Services dropdown + Settings matrix) -------
let CAT_MATRIX = { categories: [], cells: [] };
function catProtected(key) { return !!(CAT_MATRIX.categories.find((c) => c.key === key) || {}).protected; }
function fillCategorySelect(sel) {
  const el = $('svc-category');
  if (!el) return;
  const cur = sel ?? el.value;
  const opts = (CAT_MATRIX.categories || []).filter((c) => !c.archived);
  // Keep the current value selectable even if it's archived (editing a service
  // that's already on an archived category shouldn't force a change).
  if (cur && !opts.some((c) => c.key === cur)) {
    const arch = (CAT_MATRIX.categories || []).find((c) => c.key === cur);
    if (arch) opts.push(arch);
  }
  el.innerHTML = opts.map((c) =>
    `<option value="${esc(c.key)}">${esc(c.label)}${c.protected ? ' 🔒' : ''}${c.archived ? ' (archived)' : ''}</option>`).join('');
  if (cur) el.value = cur;
}
async function ensureCategories() {
  if (!CAT_MATRIX.categories.length) {
    CAT_MATRIX = await fetch('/api/categories').then((r) => (r.ok ? r.json() : { categories: [], cells: [] }));
  }
  fillCategorySelect();
}

// Adapter types whose inbound webhook the hub can auto-provision (see the
// adapter's provisionInboundWebhook). The button shows only for a saved system
// of one of these types.
const PROVISION_TYPES = new Set(['twilio']);
function updateProvisionBtn() {
  $('svc-provision-btn').hidden = !(SVC_EDITING && PROVISION_TYPES.has($('svc-type').value));
}

async function loadServices() {
  if (!can('admin') || $('tab-services').hidden) return;
  if (!ADAPTER_TYPES.length) {
    ADAPTER_TYPES = await fetch('/api/adapter-types').then((r) => r.json());
    fillTypeSelect();
  }
  await ensureCategories();
  const showArchived = $('svc-show-archived')?.checked;
  const systems = await fetch('/api/systems' + (showArchived ? '?includeArchived=1' : '')).then((r) => r.json());
  if (!systems.length) {
    $('services-table').innerHTML = `<div class="empty">${showArchived ? 'No services yet.' : 'No active services. Add one to start reconciling a platform, or tick “Show archived”.'}</div>`;
    return;
  }
  const statusBadge = (s) => {
    const cls = s === 'connected' ? 'sev-ok' : s === 'error' ? 'sev-breach' : 'sev-warn';
    return `<span class="sev ${cls}">${esc(s)}</span>`;
  };
  const caps = (s) => [
    s.can_write_optout ? 'write opt-out' : null,
    s.can_write_optin ? 'write opt-in' : null,
    s.can_discover_topology ? 'discovers topology' : null,
  ].filter(Boolean).join(' · ') || 'send-only (suppress at send time)';
  const typeLabel = (t) => (specFor(t) || {}).label || t;
  const rowActions = (s) => {
    const cfg = `<button class="quiet" style="margin:0;padding:4px 10px" data-act="edit-service" data-id="${esc(s.id)}">Configure</button>`;
    const arch = s.archived_at
      ? `<button class="quiet" style="margin:0 0 0 6px;padding:4px 10px" data-act="archive-service" data-id="${esc(s.id)}" data-archive="false">Unarchive</button>`
      : `<button class="quiet" style="margin:0 0 0 6px;padding:4px 10px" data-act="archive-service" data-id="${esc(s.id)}" data-archive="true">Archive</button>`;
    const del = `<button class="quiet" style="margin:0 0 0 6px;padding:4px 10px;color:var(--out)" data-act="delete-service" data-id="${esc(s.id)}" data-name="${esc(s.name)}">Delete</button>`;
    return cfg + arch + del;
  };
  $('services-table').innerHTML = '<table><tr><th>Service</th><th>Type</th><th>Channel</th><th>Category</th><th>Capabilities</th><th>Connection</th><th><span class="sr-only">Actions</span></th></tr>'
    + systems.map((s) => `<tr${s.archived_at ? ' style="opacity:.55"' : ''}>
        <td><strong>${esc(s.name)}</strong>${s.archived_at ? ' <span class="sev sev-warn">archived</span>' : ''}<br><span class="mono">${esc(s.id)}</span></td>
        <td>${esc(typeLabel(s.adapter_type))}</td>
        <td>${esc(s.channel)}</td>
        <td>${esc(s.category || 'marketing')}${catProtected(s.category) ? ' 🔒' : ''}</td>
        <td class="muted">${esc(caps(s))}</td>
        <td>${statusBadge(s.connection_status)}${s.last_test_at ? `<br><span class="muted" style="font-size:12px">${new Date(s.last_test_at).toLocaleString()}</span>` : ''}</td>
        <td style="white-space:nowrap">${rowActions(s)}</td>
      </tr>`).join('') + '</table>';
}

function fillTypeSelect() {
  $('svc-type').innerHTML = ADAPTER_TYPES.map((t) => `<option value="${esc(t.type)}">${esc(t.label)}</option>`).join('');
}
function specFor(type) { return ADAPTER_TYPES.find((t) => t.type === type); }

async function newService() {
  if (!ADAPTER_TYPES.length) { ADAPTER_TYPES = await fetch('/api/adapter-types').then((r) => r.json()); fillTypeSelect(); }
  await ensureCategories();
  SVC_EDITING = null;
  $('svc-editor').hidden = false;
  $('svc-editor-title').textContent = 'Register a service';
  $('svc-id').disabled = false;
  $('svc-type').disabled = false;
  $('svc-save-btn').textContent = 'Register service';
  $('svc-test-btn').hidden = true;
  updateProvisionBtn();
  $('svc-step-discover').disabled = true;
  $('svc-name').value = ''; $('svc-id').value = '';
  $('svc-flash').className = 'flash'; $('svc-test-result').innerHTML = '';
  $('svc-apikeys-block').hidden = true;   // keys attach to a saved system only
  setStep('connect');
  $('svc-type').value = ADAPTER_TYPES[0] ? ADAPTER_TYPES[0].type : 'mock';
  onTypeChange();
  $('svc-editor').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function onTypeChange() {
  const spec = specFor($('svc-type').value);
  if (!spec) return;
  $('svc-type-blurb').textContent = spec.blurb + (spec.live ? '  ·  live client' : '  ·  simulated (mock) until a real client ships');
  $('svc-channel').value = spec.channel;
  $('svc-channel').disabled = spec.channel_locked;
  $('svc-delivery').value = spec.defaults.event_delivery;
  $('svc-cap-optout').checked = spec.defaults.can_write_optout;
  $('svc-cap-optin').checked = spec.defaults.can_write_optin;
  $('svc-cap-discover').checked = spec.defaults.can_discover_topology;
  $('svc-granularity').value = spec.defaults.topology_granularity;
  $('svc-caps-note').textContent = spec.notes || '';
  syncGranularityEnabled();
  renderCredFields(spec, []);
}

function syncGranularityEnabled() {
  const on = $('svc-cap-discover').checked;
  $('svc-granularity').disabled = !on;
  if (!on) $('svc-granularity').value = 'none';
}

// `meta` is the credential-metadata list from the API (which keys are set).
function renderCredFields(spec, meta) {
  if (!spec.credentials.length) {
    $('svc-creds').innerHTML = '<p class="muted" style="margin:6px 0 0">No credentials for this type.</p>';
    return;
  }
  const byKey = Object.fromEntries((meta || []).map((m) => [m.cred_key, m]));
  $('svc-creds').innerHTML = spec.credentials.map((c) => {
    const set = byKey[c.key];
    return `<label for="cred-${esc(c.key)}">${esc(c.label)}${c.required ? '' : ' <span class="muted" style="font-weight:400">(optional)</span>'}</label>
      <input type="${c.secret ? 'password' : 'text'}" id="cred-${esc(c.key)}" autocomplete="off"
        placeholder="${set ? 'set — leave blank to keep' : esc(c.placeholder || '')}">
      ${set ? `<div class="cred-set">set ••${esc(set.last4 || '')} · updated ${new Date(set.updated_at).toLocaleDateString()}${set.expires_at ? ` · expires ${new Date(set.expires_at).toLocaleDateString()}` : ''}
        <button class="quiet" style="margin:2px 0 0;padding:2px 8px" data-act="clear-cred" data-key="${esc(c.key)}">Clear</button></div>` : ''}
      ${c.help ? `<p class="muted" style="margin:2px 0 0;font-size:12px">${esc(c.help)}</p>` : ''}`;
  }).join('');
}

function collectFields() {
  return {
    name: $('svc-name').value,
    channel: $('svc-channel').value,
    category: $('svc-category').value,
    event_delivery: $('svc-delivery').value,
    can_write_optout: $('svc-cap-optout').checked,
    can_write_optin: $('svc-cap-optin').checked,
    can_discover_topology: $('svc-cap-discover').checked,
    topology_granularity: $('svc-granularity').value,
  };
}

async function saveService() {
  const f = $('svc-flash'); f.className = 'flash';
  const spec = specFor($('svc-type').value);
  const body = collectFields();
  try {
    let sys;
    if (SVC_EDITING) {
      sys = await postJson('PATCH', '/api/systems/' + encodeURIComponent(SVC_EDITING), body);
    } else {
      body.id = $('svc-id').value.trim();
      body.adapter_type = $('svc-type').value;
      sys = await postJson('POST', '/api/systems', body);
      SVC_EDITING = sys.id;
      $('svc-id').disabled = true;
      $('svc-type').disabled = true;
      $('svc-editor-title').textContent = 'Configure ' + sys.name;
      showApiKeysPanel();
    }
    await saveCreds(spec);
    $('svc-save-btn').textContent = 'Save changes';
    $('svc-test-btn').hidden = false;
    updateProvisionBtn();
    f.className = 'flash ok';
    f.textContent = 'Saved. Test the connection, then move to discovery.';
    await refreshCredMeta(spec);
    loadServices();
  } catch (e) {
    f.className = 'flash err'; f.textContent = e.message;
  }
}

async function saveCreds(spec) {
  if (!SVC_EDITING) return;
  const credentials = [];
  for (const c of spec.credentials) {
    const v = $('cred-' + c.key).value;
    if (v) credentials.push({ key: c.key, value: v });
  }
  if (credentials.length) {
    await postJson('PUT', `/api/systems/${encodeURIComponent(SVC_EDITING)}/credentials`, { credentials });
  }
}

async function refreshCredMeta(spec) {
  if (!SVC_EDITING) return;
  const list = await fetch(`/api/systems/${encodeURIComponent(SVC_EDITING)}/credentials`).then((r) => r.json());
  renderCredFields(spec, list);
}

async function clearCred(key) {
  if (!SVC_EDITING) return;
  await fetch(`/api/systems/${encodeURIComponent(SVC_EDITING)}/credentials/${encodeURIComponent(key)}`, { method: 'DELETE' });
  refreshCredMeta(specFor($('svc-type').value));
}

async function testService() {
  if (!SVC_EDITING) return;
  const out = $('svc-test-result');
  out.innerHTML = '<span class="muted">Testing…</span>';
  try {
    const res = await postJson('POST', `/api/systems/${encodeURIComponent(SVC_EDITING)}/test`, {});
    out.innerHTML = `<strong>${res.ok ? '<span style="color:var(--in)">Connection OK</span>' : '<span style="color:var(--out)">Connection failed</span>'}</strong>`
      + '<table style="margin-top:8px"><tr><th>Check</th><th>Result</th><th>Detail</th></tr>'
      + res.checks.map((c) => `<tr><td>${esc(c.name)}${c.required ? '' : ' <span class="muted" style="font-size:11px">(info)</span>'}</td>
          <td>${c.ok ? '<span style="color:var(--in)">pass</span>' : '<span style="color:var(--out)">fail</span>'}</td>
          <td class="muted">${esc(c.detail)}</td></tr>`).join('') + '</table>';
    $('svc-step-discover').disabled = !res.ok;
    loadServices();
  } catch (e) {
    out.innerHTML = `<div class="flash err" style="display:block">${esc(e.message)}</div>`;
  }
}

async function provisionWebhook() {
  if (!SVC_EDITING) return;
  const out = $('svc-test-result');
  out.innerHTML = '<span class="muted">Provisioning inbound webhook…</span>';
  try {
    const res = await postJson('POST', `/api/systems/${encodeURIComponent(SVC_EDITING)}/provision-webhook`, {});
    out.innerHTML = res.ok
      ? `<div class="flash ok" style="display:block">Inbound webhook set. ${esc(res.detail)}<br><span class="mono" style="font-size:12px">${esc(res.url)}</span></div>`
      : `<div class="flash err" style="display:block">Could not provision: ${esc(res.detail)}</div>`;
  } catch (e) {
    out.innerHTML = `<div class="flash err" style="display:block">${esc(e.message)}</div>`;
  }
}

function editService(id) {
  fetch('/api/systems').then((r) => r.json()).then((systems) => {
    const s = systems.find((x) => x.id === id);
    if (!s) return;
    const spec = specFor(s.adapter_type);
    SVC_EDITING = id;
    $('svc-editor').hidden = false;
    $('svc-editor-title').textContent = 'Configure ' + s.name;
    $('svc-type').value = s.adapter_type;
    $('svc-type').disabled = true;
    $('svc-id').value = s.id; $('svc-id').disabled = true;
    $('svc-name').value = s.name;
    $('svc-channel').value = s.channel;
    $('svc-channel').disabled = spec ? spec.channel_locked : false;
    fillCategorySelect(s.category || 'marketing');
    $('svc-delivery').value = s.event_delivery;
    $('svc-cap-optout').checked = s.can_write_optout;
    $('svc-cap-optin').checked = s.can_write_optin;
    $('svc-cap-discover').checked = s.can_discover_topology;
    $('svc-granularity').value = s.topology_granularity;
    $('svc-type-blurb').textContent = spec ? (spec.blurb + (spec.live ? '  ·  live client' : '  ·  simulated (mock) until a real client ships')) : '';
    $('svc-caps-note').textContent = spec ? (spec.notes || '') : '';
    syncGranularityEnabled();
    $('svc-save-btn').textContent = 'Save changes';
    $('svc-test-btn').hidden = false;
    updateProvisionBtn();
    $('svc-step-discover').disabled = s.connection_status !== 'connected';
    $('svc-flash').className = 'flash'; $('svc-test-result').innerHTML = '';
    setStep('connect');
    if (spec) refreshCredMeta(spec);
    showApiKeysPanel();
    $('svc-editor').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

function closeEditor() {
  $('svc-editor').hidden = true;
  $('svc-apikeys-block').hidden = true;
  SVC_EDITING = null;
  $('svc-type').disabled = false;
}

async function archiveService(id, archive) {
  const verb = archive ? 'archive' : 'unarchive';
  if (archive && !confirm(`Archive "${id}"? It keeps its consent history but stops being used for sends, discovery, and reconciliation. You can unarchive later.`)) return;
  try {
    await postJson('POST', `/api/systems/${encodeURIComponent(id)}/${verb}`, {});
    if (SVC_EDITING === id) closeEditor();
    loadServices();
  } catch (e) { alert(e.message); loadServices(); }   // refresh so a stale/deleted row clears
}

async function deleteService(id, name) {
  if (!confirm(`Permanently delete "${name || id}"? This is only allowed if the service has no consent history. Credentials and topology are removed and cannot be recovered.`)) return;
  try {
    const r = await fetch('/api/systems/' + encodeURIComponent(id), { method: 'DELETE' });
    const j = await r.json().catch(() => ({}));
    if (r.status === 409) {
      alert(`Can't delete "${name || id}": it has consent history that must be preserved. Archive it instead.`);
      return;
    }
    if (!r.ok) throw new Error(j.error || ('delete failed: ' + r.status));
    if (SVC_EDITING === id) closeEditor();
    loadServices();
  } catch (e) { alert(e.message); loadServices(); }   // refresh so a stale/deleted row clears
}

// ---- Consent-check API keys (per service; ADR-0004) -------------------------

function showApiKeysPanel() {
  $('svc-apikeys-block').hidden = false;
  $('svc-apikey-flash').className = 'flash';
  loadApiKeys();
}

async function loadApiKeys() {
  if (!SVC_EDITING) return;
  const keys = await fetch(`/api/systems/${encodeURIComponent(SVC_EDITING)}/api-keys`).then((r) => r.json());
  const el = $('svc-apikeys-list');
  if (!keys.length) { el.innerHTML = '<p class="muted" style="margin:6px 0 0">No keys yet.</p>'; return; }
  el.innerHTML = '<table><tr><th>Label</th><th>Prefix</th><th>Rate limit</th><th>Created</th><th>Last used</th><th>Status</th><th><span class="sr-only">Actions</span></th></tr>'
    + keys.map((k) => {
        const revoked = !!k.revoked_at;
        const status = revoked ? '<span class="sev sev-breach">revoked</span>' : '<span class="sev sev-ok">active</span>';
        const action = revoked ? '' : `<button class="quiet" style="margin:0;padding:4px 10px;color:var(--out)" data-act="revoke-key" data-id="${k.id}">Revoke</button>`;
        const rate = k.rate_limit_per_sec == null ? '<span class="muted">default</span>'
          : k.rate_limit_per_sec === 0 ? '<span class="muted">unlimited</span>'
          : `${k.rate_limit_per_sec}/s`;
        return `<tr${revoked ? ' style="opacity:.55"' : ''}>
          <td>${esc(k.label)}</td>
          <td class="mono">${esc(k.key_prefix)}…</td>
          <td>${rate}</td>
          <td class="muted">${new Date(k.created_at).toLocaleDateString()}</td>
          <td class="muted">${k.last_used_at ? new Date(k.last_used_at).toLocaleString() : '—'}</td>
          <td>${status}</td>
          <td style="white-space:nowrap">${action}</td></tr>`;
      }).join('') + '</table>';
}

async function issueApiKey() {
  if (!SVC_EDITING) return;
  const f = $('svc-apikey-flash'); f.className = 'flash';
  try {
    const rateVal = $('svc-apikey-rate').value.trim();
    const body = { label: $('svc-apikey-label').value.trim() };
    if (rateVal !== '') body.rate_limit_per_sec = Number(rateVal);
    const r = await postJson('POST', `/api/systems/${encodeURIComponent(SVC_EDITING)}/api-keys`, body);
    $('svc-apikey-label').value = '';
    $('svc-apikey-rate').value = '';
    f.className = 'flash ok';
    f.innerHTML = `Copy this key now — it will not be shown again:<br>`
      + `<span class="mono" style="user-select:all;word-break:break-all">${esc(r.key)}</span>`;
    loadApiKeys();
  } catch (e) { f.className = 'flash err'; f.textContent = e.message; }
}

async function revokeServiceKey(id) {
  if (!SVC_EDITING) return;
  if (!confirm('Revoke this key? Any sender using it starts getting 401 immediately.')) return;
  try {
    await fetch(`/api/systems/${encodeURIComponent(SVC_EDITING)}/api-keys/${id}`, { method: 'DELETE' });
    loadApiKeys();
  } catch (e) { alert(e.message); }
}

function setStep(step) {
  document.querySelectorAll('#svc-editor .subnav button').forEach((b) =>
    b.setAttribute('aria-selected', String(b.dataset.step === step)));
  $('svc-step-connect').hidden = step !== 'connect';
  $('svc-step-discover-pane').hidden = step !== 'discover';
  if (step === 'discover') renderServiceTopology();
}

document.querySelectorAll('#svc-editor .subnav button').forEach((b) => {
  b.addEventListener('click', () => { if (!b.disabled) setStep(b.dataset.step); });
});

async function discoverService() {
  if (!SVC_EDITING) return;
  const f = $('svc-discover-flash'); f.className = 'flash';
  try {
    const j = await postJson('POST', '/api/topology/sync', { system: SVC_EDITING });
    const res = j.results[0];
    f.className = 'flash ok';
    f.textContent = res.skipped
      ? `Discovery skipped: ${res.skipped}. This service can't report groupings — annotate codes by hand below.`
      : `Discovered ${res.discovered} · added ${res.added} · updated ${res.updated} · reactivated ${res.reactivated} · decommissioned ${res.decommissioned}`;
    renderServiceTopology();
  } catch (e) { f.className = 'flash err'; f.textContent = e.message; }
}

async function renderServiceTopology() {
  if (!SVC_EDITING) return;
  activeTopoRender = renderServiceTopology;
  const r = await fetch('/api/topology?system=' + encodeURIComponent(SVC_EDITING));
  const v = await r.json();
  if (!r.ok) { $('svc-topo-result').innerHTML = `<div class="empty">${esc(v.error)}</div>`; return; }
  $('svc-topo-result').innerHTML = topologyHtml(v, SVC_EDITING, can('operator'));
}

async function postJson(method, url, body) {
  const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ('request failed: ' + r.status));
  return j;
}

// ---- Branding ---------------------------------------------------------------
function flash(id, msg, err) {
  const f = $(id);
  if (!f) return;
  f.textContent = msg;
  f.className = 'flash ' + (err ? 'err' : 'ok');
}

let PENDING_LOGO = undefined;     // undefined = unchanged; null = cleared; string = new data URL
let PENDING_FAVICON = undefined;

// Appearance color knobs → CSS variables, with the built-in defaults used to
// seed the pickers and to fall back on reset. Form input id is 'br-' + field.
// Defaults follow the College of Southern Idaho Visual Identity Guide:
// Default gold #FDC82F accent, near-black header/text, cool-gray-derived neutrals.
const BRAND_COLORS = [
  ['accent_color', '--action', '#FDC82F'],
  ['bg_color', '--paper', '#eef1f4'],
  ['header_color', '--header-bg', '#14181d'],
  ['text_color', '--ink', '#14181d'],
  ['card_color', '--card', '#ffffff'],
  ['optin_color', '--in', '#1e6e50'],
  ['optout_color', '--out', '#a8402f'],
  ['suppressed_color', '--supp', '#566173'],
];
const DEFAULT_ORG = 'College of Southern Idaho';
const DEFAULT_TITLE = 'Universal Consent Console';

function seedImagePreview(id, data) {
  const p = $(id); if (!p) return;
  if (data) { p.src = data; p.hidden = false; } else { p.removeAttribute('src'); p.hidden = true; }
}

// Pick black or white text for a given background so it stays readable — used
// so a primary button (background = the branding accent) never renders dark
// text on a dark accent. WCAG relative luminance, threshold tuned so the default gold
// keeps dark text while any dark accent flips to white.
function readableInk(hex) {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(String(hex).trim());
  if (!m) return '#1a1a1a';
  const n = parseInt(m[1], 16);
  const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const L = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return L > 0.45 ? '#1a1a1a' : '#ffffff';
}

function applyBranding(b) {
  b = b || {};
  const root = document.documentElement.style;
  // Org name → header + login screen.
  const org = b.org_name || DEFAULT_ORG;
  $('brand-title').textContent = org;
  if ($('login-title')) $('login-title').textContent = org;
  // Logo → header + login screen. When a custom logo is set, show it and hide
  // the default monogram tile; otherwise fall back to the monogram in the header.
  for (const id of ['brand-logo', 'login-logo']) {
    const el = $(id); if (!el) continue;
    if (b.logo_data) { el.src = b.logo_data; el.hidden = false; } else { el.removeAttribute('src'); el.hidden = true; }
  }
  for (const markId of ['brand-mark', 'login-mark']) {
    const mark = $(markId);
    if (mark) mark.hidden = !!b.logo_data;
  }
  // Palette.
  for (const [field, cssVar] of BRAND_COLORS) {
    if (b[field]) root.setProperty(cssVar, b[field]); else root.removeProperty(cssVar);
  }
  // Text color for primary buttons must contrast the accent, whatever it is:
  // the gold default takes dark text, but an admin-picked dark accent needs
  // white text (otherwise the button is dark-on-dark and unreadable).
  const accent = b.accent_color || '#FDC82F';
  root.setProperty('--action-ink', readableInk(accent));
  // Browser tab.
  document.title = b.browser_title || DEFAULT_TITLE;
  $('favicon').setAttribute('href', b.favicon_data || 'data:,');
}

async function loadBranding() {
  try {
    const b = await fetch('/api/branding').then((r) => r.ok ? r.json() : null);
    if (!b) return;
    applyBranding(b);
    // Seed the admin form (only present for admins; harmless otherwise).
    if ($('br-orgname')) {
      $('br-orgname').value = b.org_name || '';
      $('br-browser-title').value = b.browser_title || '';
      for (const [field, , def] of BRAND_COLORS) $('br-' + field).value = b[field] || def;
      PENDING_LOGO = undefined; PENDING_FAVICON = undefined;
      seedImagePreview('br-logo-preview', b.logo_data);
      seedImagePreview('br-favicon-preview', b.favicon_data);
    }
  } catch { /* leave defaults */ }
}

function pickImage(ev, maxKB, previewId, assign) {
  const f = ev.target.files && ev.target.files[0];
  if (!f) return;
  if (f.size > maxKB * 1024) { flash('br-flash', `Image is larger than ${maxKB} KB — pick a smaller file.`, true); ev.target.value = ''; return; }
  const reader = new FileReader();
  reader.onload = () => { const v = String(reader.result); assign(v); seedImagePreview(previewId, v); };
  reader.readAsDataURL(f);
}
function onLogoPick(ev) { pickImage(ev, 512, 'br-logo-preview', (v) => { PENDING_LOGO = v; }); }
function onFaviconPick(ev) { pickImage(ev, 140, 'br-favicon-preview', (v) => { PENDING_FAVICON = v; }); }
function clearLogo() { PENDING_LOGO = null; seedImagePreview('br-logo-preview', null); $('br-logo-file').value = ''; }
function clearFavicon() { PENDING_FAVICON = null; seedImagePreview('br-favicon-preview', null); $('br-favicon-file').value = ''; }

// undefined pending → keep stored (re-send the shown preview); null → clear.
function imageField(body, key, pending, previewId) {
  if (pending !== undefined) { body[key] = pending ?? ''; return; }
  const cur = $(previewId);
  if (cur && cur.src && !cur.hidden) body[key] = cur.src;
}

async function saveBranding() {
  const body = {
    org_name: $('br-orgname').value.trim(),
    browser_title: $('br-browser-title').value.trim(),
  };
  for (const [field] of BRAND_COLORS) body[field] = $('br-' + field).value;
  imageField(body, 'logo_data', PENDING_LOGO, 'br-logo-preview');
  imageField(body, 'favicon_data', PENDING_FAVICON, 'br-favicon-preview');
  try {
    const b = await postJson('PUT', '/api/branding', body);
    applyBranding(b);
    PENDING_LOGO = undefined; PENDING_FAVICON = undefined;
    flash('br-flash', 'Appearance saved.');
  } catch (e) { flash('br-flash', e.message || 'Could not save appearance.', true); }
}

async function resetBranding() {
  try {
    const b = await postJson('PUT', '/api/branding', {});
    applyBranding(b);
    $('br-orgname').value = ''; $('br-browser-title').value = '';
    for (const [field, , def] of BRAND_COLORS) $('br-' + field).value = def;
    clearLogo(); clearFavicon();
    PENDING_LOGO = undefined; PENDING_FAVICON = undefined;
    flash('br-flash', 'Reset to defaults.');
  } catch (e) { flash('br-flash', e.message || 'Could not reset.', true); }
}

// ---- Settings (runtime config, admin) --------------------------------------
let CONFIG = []; // last-loaded [{key,group,label,help,kind,options,min,value}]

async function loadSettings() {
  if (!can('admin')) return;
  CONFIG = await fetch('/api/config').then((r) => (r.ok ? r.json() : []));
  renderSettings();
  loadCategories();
}

// ---- Consent categories & cascade matrix (admin, on the Settings tab) -------
async function loadCategories() {
  if (!can('admin')) return;
  CAT_MATRIX = await fetch('/api/categories').then((r) => (r.ok ? r.json() : { categories: [], cells: [] }));
  renderCategories();
  fillCategorySelect();   // keep the Services dropdown consistent
}

function cellOf(source, target) {
  return CAT_MATRIX.cells.find((c) => c.source === source && c.target === target) || {};
}

function renderCategories() {
  const body = $('categories-body');
  if (!body) return;
  const all = CAT_MATRIX.categories || [];
  const active = all.filter((c) => !c.archived);
  const archived = all.filter((c) => c.archived);
  const delBtn = (c) => `<button class="quiet" style="margin:0 0 0 4px;padding:2px 8px;color:var(--out)"
    data-act="delete-category" data-key="${esc(c.key)}"
    ${c.inUse ? `disabled title="in use by ${c.inUse} service(s) — archive instead"` : ''}>Delete</button>`;

  let html = '';
  if (!active.length) {
    html += '<p class="muted">No active categories. Add one below.</p>';
  } else {
    const head = '<th style="text-align:left">source ⧵ target</th>'
      + active.map((t) => `<th>${esc(t.label)}${t.protected ? ' 🔒' : ''}</th>`).join('')
      + '<th>Manage</th>';
    const rows = active.map((s) => {
      const tds = active.map((t) => {
        const c = cellOf(s.key, t.key);
        const lbl = c.locked
          ? `${esc(t.label)} is protected — never suppressed`
          : `Cascade a ${esc(s.label)} opt-out to ${esc(t.label)}`;
        return `<td style="text-align:center"><input type="checkbox" aria-label="${lbl}"
          data-change="toggle-cascade" data-source="${esc(s.key)}" data-target="${esc(t.key)}"
          ${c.enabled ? 'checked' : ''} ${c.locked ? 'disabled title="protected — never suppressed"' : ''}
          style="width:auto;margin:0"></td>`;
      }).join('');
      const manage = `<td style="white-space:nowrap">
        <button class="quiet" style="margin:0;padding:2px 8px" data-act="archive-category" data-key="${esc(s.key)}">Archive</button>
        ${delBtn(s)}</td>`;
      return `<tr><th style="text-align:left">${esc(s.label)}${s.protected ? ' 🔒' : ''}</th>${tds}${manage}</tr>`;
    }).join('');
    html += `<table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
  }

  if (archived.length) {
    html += '<h3 class="rpt">Archived categories</h3>'
      + archived.map((c) => `<div style="margin:6px 0">
          <strong>${esc(c.label)}</strong> <span class="mono">${esc(c.key)}</span>
          <span class="muted">· ${c.inUse ? c.inUse + ' service(s) still assigned' : 'unused'}</span>
          <button class="quiet" style="margin:0 0 0 8px;padding:2px 8px" data-act="unarchive-category" data-key="${esc(c.key)}">Unarchive</button>
          ${delBtn(c)}</div>`).join('');
  }
  body.innerHTML = html;
}

async function toggleCascade(el) {
  const f = $('categories-flash'); f.className = 'flash';
  try {
    CAT_MATRIX = await postJson('POST', '/api/categories/cascade',
      { source: el.dataset.source, target: el.dataset.target, on: el.checked });
    renderCategories();
    f.className = 'flash ok'; f.textContent = 'Cascade updated.';
  } catch (e) { f.className = 'flash err'; f.textContent = e.message; loadCategories(); }
}

async function addCategory() {
  const f = $('categories-flash'); f.className = 'flash';
  const key = $('cat-key').value.trim();
  const label = $('cat-label').value.trim();
  try {
    CAT_MATRIX = await postJson('POST', '/api/categories',
      { key, label, protected: $('cat-protected').checked, sort_order: 100 });
    $('cat-key').value = ''; $('cat-label').value = ''; $('cat-protected').checked = false;
    renderCategories(); fillCategorySelect();
    f.className = 'flash ok'; f.textContent = `Category "${key}" saved.`;
  } catch (e) { f.className = 'flash err'; f.textContent = e.message; }
}

// Archive / unarchive return the refreshed matrix; delete returns {deleted} so we reload.
async function categoryLifecycle(url, key, verb) {
  const f = $('categories-flash'); f.className = 'flash';
  try {
    CAT_MATRIX = await postJson('POST', url, {});
    renderCategories(); fillCategorySelect();
    f.className = 'flash ok'; f.textContent = `Category "${key}" ${verb}.`;
  } catch (e) { f.className = 'flash err'; f.textContent = e.message; loadCategories(); }
}
const archiveCategoryUi = (key) => categoryLifecycle(`/api/categories/${encodeURIComponent(key)}/archive`, key, 'archived');
const unarchiveCategoryUi = (key) => categoryLifecycle(`/api/categories/${encodeURIComponent(key)}/unarchive`, key, 'unarchived');
async function deleteCategoryUi(key) {
  if (!confirm(`Delete category "${key}"? This removes it and its cascade rows.`)) return;
  const f = $('categories-flash'); f.className = 'flash';
  try {
    await postJson('DELETE', `/api/categories/${encodeURIComponent(key)}`, {});
    await loadCategories();
    f.className = 'flash ok'; f.textContent = `Category "${key}" deleted.`;
  } catch (e) { f.className = 'flash err'; f.textContent = e.message; }
}

function renderSettings() {
  const body = $('settings-body');
  if (!body) return;
  const groups = {};
  for (const s of CONFIG) (groups[s.group] = groups[s.group] || []).push(s);
  body.innerHTML = Object.entries(groups)
    .map(([g, items]) => `<h3 class="rpt">${esc(g)}</h3>` + items.map(settingRow).join(''))
    .join('');
}

function settingRow(s) {
  const id = 'cfg-' + s.key;
  let control;
  if (s.kind === 'boolean') {
    control = `<input type="checkbox" id="${id}" ${s.value ? 'checked' : ''} style="width:auto;margin:0">`;
  } else if (s.kind === 'select') {
    control = `<select id="${id}">${(s.options || []).map((o) => `<option ${o === s.value ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
  } else if (s.kind === 'number') {
    control = `<input type="number" id="${id}" value="${esc(s.value)}"${s.min != null ? ` min="${s.min}"` : ''} style="max-width:200px">`;
  } else {
    control = `<input type="text" id="${id}" value="${esc(s.value)}" style="max-width:200px">`;
  }
  return `<div style="margin:10px 0">
    <label for="${id}" style="font-weight:600">${esc(s.label)}</label>
    ${control}
    ${s.help ? `<div class="muted" style="margin-top:2px">${esc(s.help)}</div>` : ''}
  </div>`;
}

function readSetting(s) {
  const el = $('cfg-' + s.key);
  if (!el) return s.value;
  if (s.kind === 'boolean') return el.checked;
  if (s.kind === 'number') return Number(el.value);
  return el.value;
}

async function saveSettings() {
  const f = $('settings-flash'); f.className = 'flash';
  const updates = {};
  for (const s of CONFIG) {
    const cur = readSetting(s);
    if (JSON.stringify(cur) !== JSON.stringify(s.value)) updates[s.key] = cur;
  }
  if (!Object.keys(updates).length) { f.className = 'flash ok'; f.textContent = 'No changes.'; return; }
  try {
    const r = await postJson('PUT', '/api/config', updates);
    f.className = 'flash ok';
    f.textContent = `Saved ${r.changed.length} setting${r.changed.length === 1 ? '' : 's'}${r.reloadScheduler ? ' (scheduler reloaded)' : ''}.`;
    showToast('Settings saved');
    loadSettings();
  } catch (e) { f.className = 'flash err'; f.textContent = e.message; }
}

function refresh() {
  if (!ME) return;
  loadMatrix().then(loadTopology);
  loadReviews();
  loadAlerts();
  loadAudit();
  loadUsers();
  loadServices();
  loadBranding();
  loadSettings();
  loadStatus();
}

// Run-mode indicators, driven by ME.mode from /api/auth/me. Two signals:
//   enableOutboundWrites — the switch that decides whether the hub affects real
//     vendors (primary); production — whether NODE_ENV is 'production' (secondary).
// The amber BANNER is exception-only: it shows *only* when something is not
// production-live, so production stays clean. A small header PILL is always
// present as a positive confirmation (green "Production" / amber "Test mode") —
// so "correctly live" is affirmed, not merely inferred from an empty page.
// textContent only (no innerHTML) so it stays CSP-safe.
function renderModeBanner(mode) {
  const testMode = !!(mode && mode.enableOutboundWrites === false);
  const nonProd = !!(mode && mode.production === false);

  const el = $('mode-banner');
  if (el) {
    const parts = [];
    if (testMode) parts.push('TEST MODE — outbound writes are OFF: the hub is receiving and recording opt-outs/opt-ins but is NOT pushing them to any sending service.');
    if (nonProd) parts.push('Non-production environment (NODE_ENV is not "production").');
    if (parts.length) { el.textContent = '⚠ ' + parts.join('  ·  '); el.hidden = false; }
    else { el.hidden = true; el.textContent = ''; }
  }

  const pill = $('mode-pill');
  if (pill) {
    if (!mode) { pill.hidden = true; return; }
    const prod = !testMode && !nonProd;
    pill.classList.toggle('mode-prod', prod);
    pill.classList.toggle('mode-test', !prod);
    $('mode-pill-text').textContent = prod ? 'Production' : 'Test mode';
    pill.title = prod
      ? 'Run mode: production — outbound writes enabled, NODE_ENV=production'
      : 'Run mode: test / non-production — see the banner';
    pill.hidden = false;
  }
}

async function init() {
  const r = await fetch('/api/auth/me');
  if (r.ok) {
    ME = await r.json();
    CSRF = ME.csrf_token;
    $('login-overlay').hidden = true;
    renderModeBanner(ME.mode);
    applyRoleGates();
    loadBranding();
    refresh();
  } else {
    ME = null;
    CSRF = null;
    $('login-overlay').hidden = false;
    renderModeBanner(null);
    applyRoleGates();
    loadBranding();   // brand the login screen too (GET /api/branding is public)
    const prov = await fetch('/api/auth/providers').then((x) => x.json());
    $('sso-buttons').innerHTML = (prov.sso ?? []).map((s) =>
      `<button class="quiet" style="width:100%" data-act="sso" data-id="${esc(s.id)}">${esc(s.name)}</button>`).join('');
  }
}

// ---- Event delegation (CSP: no inline handlers, so script-src stays 'self') --
// Elements opt in with data-act / data-change / data-input / data-enter and
// carry any arguments as data-* attributes; these delegated listeners dispatch
// them, which also works for dynamically-rendered content without re-binding.
const CLICK_ACTIONS = {
  logout, reconcile: runReconcile, inject: injectEvent, 'sync-topology': syncTopology,
  'prune-checks': pruneConsentChecks, 'prune-audit': pruneAuditLog, lookup: runLookup, audit: runAudit, lag: runLag,
  activity: runActivity, 'topology-report': runTopologyReport, 'alert-scan': runAlertScan,
  'poll-all': pollAllNow, 'new-service': newService, 'save-service': saveService,
  'test-service': testService, 'close-editor': closeEditor, 'discover-service': discoverService,
  'provision-webhook': provisionWebhook,
  'issue-apikey': issueApiKey, 'create-user': createUserUi, 'save-settings': saveSettings,
  'clear-logo': clearLogo, 'clear-favicon': clearFavicon, 'save-branding': saveBranding,
  'reset-branding': resetBranding, login,
  'poll-system': (el) => pollSystemNow(el.dataset.systemId),
  'decide-review': (el) => decideReview(Number(el.dataset.id), Number(el.dataset.version), el.dataset.decision),
  'patch-user-status': (el) => patchUser(Number(el.dataset.id), { status: el.dataset.status }),
  'reset-pw': (el) => { const p = prompt(`New password (min 10 chars) for ${el.dataset.username}:`); if (p) resetPw(Number(el.dataset.id), p); },
  'annotate-topo': (el) => annotateTopo(el.dataset.system, el.dataset.ref),
  'unannotate-topo': (el) => unannotateTopo(el.dataset.system, el.dataset.ref),
  'edit-service': (el) => editService(el.dataset.id),
  'archive-service': (el) => archiveService(el.dataset.id, el.dataset.archive === 'true'),
  'delete-service': (el) => deleteService(el.dataset.id, el.dataset.name),
  'clear-cred': (el) => clearCred(el.dataset.key),
  'revoke-key': (el) => revokeServiceKey(Number(el.dataset.id)),
  'add-category': addCategory,
  'archive-category': (el) => archiveCategoryUi(el.dataset.key),
  'unarchive-category': (el) => unarchiveCategoryUi(el.dataset.key),
  'delete-category': (el) => deleteCategoryUi(el.dataset.key),
  sso: (el) => { location.href = `/auth/sso/${el.dataset.id}/start`; },
};
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const fn = CLICK_ACTIONS[el.dataset.act];
  if (fn) fn(el, e);
});

const CHANGE_ACTIONS = {
  'load-topology': loadTopology, 'load-services': loadServices, 'on-type-change': onTypeChange,
  'sync-granularity': syncGranularityEnabled,
  'on-logo-pick': (el, e) => onLogoPick(e), 'on-favicon-pick': (el, e) => onFaviconPick(e),
  'patch-user-role': (el) => patchUser(Number(el.dataset.id), { role: el.value }),
  'toggle-cascade': (el) => toggleCascade(el),
};
document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-change]');
  if (!el) return;
  const fn = CHANGE_ACTIONS[el.dataset.change];
  if (fn) fn(el, e);
});

document.addEventListener('input', (e) => {
  const el = e.target.closest('[data-input]');
  if (el && el.dataset.input === 'filter-matrix') filterMatrix();
});

const ENTER_ACTIONS = { lookup: runLookup, 'issue-apikey': issueApiKey, login };
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const el = e.target.closest('[data-enter]');
  if (!el) return;
  const fn = ENTER_ACTIONS[el.dataset.enter];
  if (fn) fn();
});

init();
setInterval(() => { if (ME) loadReviews(); }, 15000);
