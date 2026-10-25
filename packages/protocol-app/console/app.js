(() => {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const state = { context: null, session: null, csrf: null, capabilities: [], preview: null, submitting: false,
    evidence: null, evidenceCoverage: null, currentData: null, lists: {}, pageSizes: {providers:25,policies:25,coverages:25},
    lastFocus: null, seatConsumed: false, privateGeneration: 0, uncertain: false, lastAction: null, preActionOperationIds: new Set(),
    readVersions: {summary:0,providers:0,policies:0,coverages:0},
    loadingPanels: {summary:false,providers:false,policies:false,coverages:false}, reconciliationLoading:false, reconciliationLoaded:false };
  const STATUS = ['None', 'Active', 'Claim pending', 'Refunded', 'Rejected', 'Expired'];
  const OUTCOME = ['Rejected', 'Provider fault', 'Pool only'];
  const safeErrors = {
    PROTOCOL_SESSION_REQUIRED: 'Your local session has ended. Ask the host to rearm a session.',
    PROTOCOL_CSRF_REQUIRED: 'The session approval token is no longer valid. Reconnect through the host.',
    PROTOCOL_FORBIDDEN: 'This session is not authorized for that operation.',
    PROTOCOL_NOT_FOUND: 'That record is unavailable to this session.',
    PROTOCOL_LIMIT: 'A configured local limit was reached. Review the current state before continuing.',
    PROTOCOL_STATE_UNAVAILABLE: 'The protocol read is unavailable. Retry the read when the local node is ready.',
    PROTOCOL_RPC_UNAVAILABLE: 'The local chain could not be reached. Current values have been cleared.',
    PROTOCOL_REORG: 'The observed block is no longer canonical. Reload the affected panel.',
    PROTOCOL_CURSOR_INVALID: 'This page cursor expired or changed. Load the first page again.',
    PROTOCOL_PREVIEW_REQUIRED: 'The preview is no longer available. Prepare and review a new preview.',
    PROTOCOL_PREVIEW_EXPIRED: 'The preview expired. Prepare and review a new preview.',
    PROTOCOL_PREVIEW_STALE: 'The observed state changed. Prepare and review a new preview.',
    PROTOCOL_APPROVAL_REQUIRED: 'An explicit confirmation is required.',
    PROTOCOL_UNRESOLVED: 'An earlier operation is unresolved. Reconcile its original transaction before another action.',
    PROTOCOL_JOURNAL_MISSING: 'The local operation journal is missing. Stop and ask the trusted host to inspect the runtime.',
    PROTOCOL_JOURNAL_CHANGED: 'The local operation journal changed. Stop and ask the trusted host to inspect the runtime.',
    PROTOCOL_JOURNAL_INVALID: 'The local operation journal is invalid. Stop and ask the trusted host to inspect the runtime.',
    PROTOCOL_STORAGE_INVALID: 'Local protocol storage is unavailable or invalid.',
    PROTOCOL_CONTEXT_MISMATCH: 'The configured local protocol context does not match the connected chain.',
    PROTOCOL_SIMULATION_FAILED: 'The operation could not be simulated. No approval was prepared.',
    PROTOCOL_SIGNER_REQUIRED: 'This local seat is read-only because its role account is unavailable.',
    PROTOCOL_NONCE_BUSY: 'The role account has a pending operation. Reconcile before continuing.',
    PROTOCOL_LOCKED: 'The local protocol runtime is already in use.',
    PROTOCOL_EXPIRED: 'The requested item has expired.',
    PROTOCOL_ARGUMENT_INVALID: 'Some form values are invalid. Check the fields and try again.',
    PROTOCOL_AMOUNT_INVALID: 'Enter a valid positive integer amount in atomic units.',
    PROTOCOL_ADDRESS_INVALID: 'Enter a valid EVM address.',
    PROTOCOL_ID_INVALID: 'Enter a valid 32-byte ID.',
    PROTOCOL_ROLE_INVALID: 'The host supplied an unsupported role.',
    PROTOCOL_OPERATION_FAILED: 'The operation failed. Reconcile before attempting another action.'
  };
  const REVIEW_LABELS = {
    kind: 'Operation', providerId: 'Provider ID', policyId: 'Policy ID', owner: 'Owner address', payout: 'Payout address',
    policyHash: 'Policy hash', premiumBps: 'Premium (basis points)', stakeBps: 'Stake (basis points)',
    withholdingBps: 'Withholding (basis points)', duration: 'Duration (seconds)', poolOnlyAllowed: 'Pool-only allowed',
    paused: 'Paused', amount: 'Amount (atomic units)', spender: 'Spender', actor: 'Actor', freeStakeAfter: 'Free stake after action (atomic units)',
    poolAssetsBefore: 'Pool assets before action (atomic units)', coverageId: 'Coverage ID', outcome: 'Outcome',
    refundAmount: 'Refund (atomic units)', reasonHash: 'Reason hash'
  };

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
  }
  function button(text, className, action, aria) {
    const b = el('button', `button ${className || 'button-secondary'}`, text);
    b.type = 'button';
    if (action) b.addEventListener('click', action);
    if (aria) b.setAttribute('aria-label', aria);
    return b;
  }
  function fixedError(code) { return safeErrors[code] || safeErrors.PROTOCOL_OPERATION_FAILED; }
  async function request(path, options = {}) {
    const headers = new Headers(options.headers || {});
    if (options.body !== undefined) headers.set('content-type', 'application/json');
    if (options.method === 'POST' && state.csrf) headers.set('x-assurepay-csrf', state.csrf);
    let response;
    try {
      response = await fetch(path, { method: options.method || 'GET', headers, body: options.body, credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
    } catch { throw Object.assign(new Error('PROTOCOL_RPC_UNAVAILABLE'), { code: 'PROTOCOL_RPC_UNAVAILABLE' }); }
    if (!response.ok) {
      let code = 'PROTOCOL_OPERATION_FAILED';
      try { const body = await response.json(); if (typeof body?.error === 'string' && body.error.startsWith('PROTOCOL_')) code = body.error; } catch { /* fixed fallback */ }
      throw Object.assign(new Error(code), { code });
    }
    return response;
  }
  async function json(path, options) { const r = await request(path, options); return r.json(); }
  function announce(message, kind = '') {
    const notice = $('#notice'); notice.hidden = !message; notice.textContent = message || ''; notice.className = `notice${kind ? ` notice-${kind}` : ''}`;
    $('#live-region').textContent = message || '';
  }
  function clearPrivate() {
    state.privateGeneration++;
    state.evidence = null; state.evidenceCoverage = null;
    state.pendingReason = null;
    const pane = $('#private-evidence'); if (pane) pane.replaceChildren(el('p','eyebrow','PRIVATE · ADJUDICATOR ONLY'),el('h2','','Evidence review'),el('p','muted','Evidence and decision text cleared from this browser view.'),el('p','empty-state','Select Review evidence on a Claim pending coverage.'));
    const reason = $('#reason-input'); if (reason) reason.value = '';
    const dialog = $('#review-dialog'); if (dialog.open) dialog.close();
    state.preview = null;
  }
  function syncActionControls() {
    const pauseAvailable=Boolean(state.currentData?.summarySnapshot?.summary);
    const readsPending=Object.values(state.loadingPanels).some(Boolean);
    const locked=!state.session||state.uncertain||state.submitting||readsPending;
    document.querySelectorAll('.action-form').forEach(form=>{
      const kind=form.dataset.operation;
      form.querySelectorAll('input,select,textarea').forEach(control=>{
        control.disabled=locked||(kind==='setPaused'&&control.name==='paused'&&!pauseAvailable);
      });
      form.querySelectorAll('button[type=submit]').forEach(control=>{
        control.disabled=locked||(kind==='setPaused'&&!pauseAvailable);
      });
    });
  }
  function invalidateSession(message) {
    clearPrivate(); state.session = null; state.csrf = null; state.capabilities = []; state.currentData = null; state.lists = {}; state.reconcileRows=null;state.lastAction=null;state.uncertain=false;state.reconciliationLoaded=false;state.reconciliationLoading=false;for(const key of Object.keys(state.loadingPanels))state.loadingPanels[key]=false;
    $('#workspace').hidden = true; $('#logout-button').hidden = true; $('#session-summary').textContent = 'Not connected';
    $('#enrollment').hidden = false; $('#rearm-copy').hidden = false;
    $('#connect-button').disabled = true;
    announce(message || 'The session ended. Ask the trusted host to rearm a local seat.', 'warning');
  }
  function onRequestError(error) {
    const code = error?.code || error?.message;
    if (code === 'PROTOCOL_SESSION_REQUIRED' || code === 'PROTOCOL_CSRF_REQUIRED') {
      invalidateSession(fixedError(code)); return;
    }
    announce(fixedError(code), 'error');
  }
  function labelRole(role) { return ({ provider: 'Provider', admin: 'Admin', operator: 'Operator', adjudicator: 'Adjudicator' })[role] || 'Protocol'; }
  function field(parent, labelText, name, options = {}) {
    const wrap = el('label', 'field'); wrap.append(el('span', 'field-label', labelText));
    let input;
    if (options.type === 'checkbox') {
      const line = el('span', 'checkbox-line'); input = document.createElement('input'); input.type = 'checkbox';
      line.append(input, el('span', '', options.help || 'Enabled')); wrap.append(line);
    } else if (options.type === 'textarea') {
      input = document.createElement('textarea'); input.rows = options.rows || 3;
    } else if (options.type === 'select') {
      input = document.createElement('select');
      for (const [value, text] of options.items) { const option = document.createElement('option'); option.value = value; option.textContent = text; input.append(option); }
    } else {
      input = document.createElement('input'); input.type = options.type || 'text';
    }
    const form = parent.closest('form'); const prefix = form?.dataset.operation || `field-${parent.children.length}`;
    input.name = name; input.id = `field-${prefix}-${name}`;
    if (options.required !== false) input.required = true;
    if (options.placeholder) input.placeholder = options.placeholder;
    if (options.pattern) input.pattern = options.pattern;
    if (options.inputmode) input.inputMode = options.inputmode;
    if (options.value !== undefined) input.value = options.value;
    if (options.min !== undefined) input.min = options.min;
    if (options.max !== undefined) input.max = options.max;
    if (options.maxlength !== undefined) input.maxLength = options.maxlength;
    if (options.disabled) input.disabled = true;
    if (options.readonly) { input.readOnly = true; input.setAttribute('aria-readonly', 'true'); }
    if (options.help && options.type !== 'checkbox') wrap.append(input, el('small', 'field-help', options.help));
    else if (options.type !== 'checkbox') wrap.append(input);
    parent.append(wrap);
    return input;
  }
  function card(title, eyebrow, description) {
    const section = el('section', 'card'); section.dataset.section = title.toLowerCase().replace(/[^a-z0-9]+/g, '-');section.id=section.dataset.section;
    const head = el('div', 'card-heading'); const copy = el('div');
    if (eyebrow) copy.append(el('p', 'eyebrow', eyebrow)); copy.append(el('h2', '', title));
    if (description) copy.append(el('p', 'muted', description));
    head.append(copy); section.append(head); return section;
  }
  function anchorText(anchor) { return anchor ? `Observed at block ${anchor.number} · ${anchor.hash}` : 'Anchor unavailable'; }
  function addAnchor(parent, anchor) { parent.append(el('p', 'panel-anchor', anchorText(anchor))); }
  function exactAtomic(value, positive = false) {
    return typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/.test(value) && (!positive || BigInt(value) > 0n);
  }
  function validId(value) { return /^0x[0-9a-fA-F]{64}$/.test(value); }
  function validAddress(value) { return /^0x[0-9a-fA-F]{40}$/.test(value); }
  function inputValues(form) { return Object.fromEntries(new FormData(form).entries()); }
  function opFromForm(kind, form) {
    const v = inputValues(form);
    const fail = (message, control) => { announce(message, 'error'); if (control) control.focus(); throw new Error('FORM_INVALID'); };
    const needId = (key, label) => { const value = String(v[key] || '').trim().toLowerCase(); if (!validId(value)) fail(`${label} must be a 32-byte hex ID.`, form.elements.namedItem(key)); return value; };
    const needAddress = (key, label) => { const value = String(v[key] || '').trim().toLowerCase(); if (!validAddress(value)) fail(`${label} must be a valid EVM address.`, form.elements.namedItem(key)); return value; };
    const needAmount = (key) => { const value = String(v[key] || '').trim(); if (!exactAtomic(value, true)) fail('Enter a positive whole-number amount in atomic units.', form.elements.namedItem(key)); return value; };
    if (kind === 'registerProvider') return { kind, providerId: needId('providerId', 'Provider ID'), owner: needAddress('owner', 'Owner'), payout: needAddress('payout', 'Payout') };
    if (kind === 'registerPolicy') {
      const bps = (key, max) => { const value = String(v[key] || ''); if (!/^(?:0|[1-9][0-9]{0,4})$/.test(value) || Number(value) > max) fail(`Enter a whole number from 0 to ${max}.`, form.elements.namedItem(key)); return Number(value); };
      const duration = String(v.duration || '').trim(); if (!exactAtomic(duration, true)) fail('Enter a positive whole number of seconds.', form.elements.namedItem('duration'));
      return { kind, policyId: needId('policyId', 'Policy ID'), providerId: needId('providerId', 'Provider ID'), premiumBps: bps('premiumBps', 9999),
        stakeBps: bps('stakeBps', 10000), withholdingBps: bps('withholdingBps', 9999), duration, poolOnlyAllowed: v.poolOnlyAllowed === 'on' };
    }
    if (kind === 'setPaused') return { kind, paused: v.paused === 'on' };
    if (kind === 'approveCore' || kind === 'fundPool') return { kind, amount: needAmount('amount') };
    if (kind === 'depositStake' || kind === 'withdrawStake') return { kind, providerId: needId('providerId', 'Provider ID'), amount: needAmount('amount') };
    if (kind === 'finalizeClaim') {
      const coverageId = needId('coverageId', 'Coverage ID'); const outcome = Number(v.outcome);
      if (![0, 1, 2].includes(outcome)) fail('Choose a supported claim outcome.', form.elements.namedItem('outcome'));
      const refundAmount = outcome === 0 && !String(v.refundAmount || '').trim() ? '0' : String(v.refundAmount || '').trim();
      if (!exactAtomic(refundAmount, outcome !== 0)) fail(outcome === 0 ? 'Rejection must use a zero refund.' : 'Enter a positive whole-number refund in atomic units.', form.elements.namedItem('refundAmount'));
      const reason = String(v.reason || ''); if (!reason.trim()) fail('Enter the decision reason.', form.elements.namedItem('reason'));
      if (new TextEncoder().encode(reason).byteLength > 8192) fail('Decision reason must be at most 8192 UTF-8 bytes.', form.elements.namedItem('reason'));
      return { kind, coverageId, outcome, refundAmount, reason };
    }
    throw new Error('PROTOCOL_ARGUMENT_INVALID');
  }
  function actionForm(kind, title, description) {
    const section = card(title, 'FIXED ACTION', description);
    const form = el('form', 'action-form'); form.dataset.operation = kind;
    if (kind === 'registerProvider') {
      field(form, 'Provider ID', 'providerId', { placeholder: '0x… 32-byte ID', maxlength: 66 });
      field(form, 'Owner address', 'owner', { placeholder: '0x…', maxlength: 42 }); field(form, 'Payout address', 'payout', { placeholder: '0x…', maxlength: 42 });
    } else if (kind === 'registerPolicy') {
      field(form, 'Policy ID', 'policyId', { placeholder: '0x… 32-byte ID', maxlength: 66 });
      field(form, 'Registered provider ID', 'providerId', { value: state.context.providerId, placeholder: '0x…', maxlength: 66 });
      field(form, 'Premium (basis points)', 'premiumBps', { inputmode: 'numeric', pattern: '[0-9]+', maxlength: 5 });
      field(form, 'Stake (basis points)', 'stakeBps', { inputmode: 'numeric', pattern: '[0-9]+', maxlength: 5 });
      field(form, 'Withholding (basis points)', 'withholdingBps', { inputmode: 'numeric', pattern: '[0-9]+', maxlength: 5 });
      field(form, 'Duration (seconds)', 'duration', { inputmode: 'numeric', pattern: '[0-9]+', maxlength: 78 });
      field(form, 'Pool-only allowed', 'poolOnlyAllowed', { type: 'checkbox', required: false, help: 'Allow a pool-only coverage outcome for this policy.' });
    } else if (kind === 'setPaused') {
      const hasPauseRead=Boolean(state.currentData?.summarySnapshot?.summary);
      const paused=state.currentData?.summarySnapshot?.summary?.paused===true;
      const pauseField=field(form, 'Paused after action', 'paused', { type: 'checkbox', required: false, disabled: !hasPauseRead, help: 'Checked means paused; unchecked means unpaused.' });
      pauseField.checked=paused;
    } else if (kind === 'approveCore' || kind === 'fundPool') {
      field(form, 'Exact amount (atomic units)', 'amount', { inputmode: 'numeric', pattern: '(?:0|[1-9][0-9]*)', maxlength: 78, help: 'No decimal conversion. The exact integer is sent for preview.' });
    } else if (kind === 'depositStake' || kind === 'withdrawStake') {
      field(form, 'Configured provider ID', 'providerId', { value: state.context.providerId, readonly: true, maxlength: 66 });
      field(form, 'Exact amount (atomic units)', 'amount', { inputmode: 'numeric', pattern: '(?:0|[1-9][0-9]*)', maxlength: 78 });
    }
    const submit=button('Review action', 'button-primary', null);submit.type='submit';form.append(submit);
    form.addEventListener('submit', (event) => { event.preventDefault(); if (state.submitting) return; try { void prepareAction(opFromForm(kind, form)); } catch (error) { if (error.message !== 'FORM_INVALID') onRequestError(error); } });
    section.append(form); return section;
  }
  function rowTable(headers, rows) {
    const wrap = el('div', 'table-wrap'); const table = document.createElement('table');
    const thead = document.createElement('thead'), tr = document.createElement('tr');
    for (const head of headers) { const th = el('th', '', head); th.scope = 'col'; tr.append(th); }
    thead.append(tr); table.append(thead); const tbody = document.createElement('tbody');
    for (const values of rows) { const row = document.createElement('tr'); for (const value of values) { const td = document.createElement('td'); if (value instanceof Node) td.append(value); else td.textContent = value === null || value === undefined ? '—' : String(value); row.append(td); } tbody.append(row); }
    table.append(tbody); wrap.append(table); return wrap;
  }
  function idText(value) { const node = el('span', 'mono wrap-id', value); node.title = value; return node; }
  function statusPill(status) { const known = Number.isInteger(status) && STATUS[status]; return el('span', `status status-${status}`, known || 'Unknown status'); }
  function panel(title, eyebrow, rows, headers, anchor, emptyText, kind) {
    const section = card(title, eyebrow); addAnchor(section, anchor);
    if(kind){const tools=el('div','list-tools');const label=el('label','page-size-label','Rows per page');const select=document.createElement('select');select.setAttribute('aria-label',`${title} rows per page`);select.dataset.pageSize=kind;
      for(const size of [1,10,25,50]){const option=document.createElement('option');option.value=String(size);option.textContent=String(size);option.selected=state.pageSizes[kind]===size;select.append(option);}
      select.addEventListener('change',()=>{state.pageSizes[kind]=Number(select.value);void reloadPanel(kind);});label.append(select);tools.append(label);section.append(tools);}
    if (!rows.length) section.append(el('p', 'empty-state', emptyText || 'No records in this anchored view.'));
    else section.append(rowTable(headers, rows));
    return section;
  }
  function renderSummary(snapshot) {
    const section = card('Protocol state', 'ANCHORED READ', 'Observed local protocol values. Amounts are exact atomic units.');
    addAnchor(section, snapshot.anchor);
    const s = snapshot.summary; const grid = el('dl', 'metric-grid');
    const values = [['Pause state', s.paused ? 'Paused' : 'Running'], ['Token balance', `${s.tokenBalanceAtomic} atomic units`], ['Pool assets', `${s.poolAssets} atomic units`],
      ['Pool reserved', `${s.poolReserved} atomic units`], ['Provider stake', `${s.providerStake} atomic units`], ['Locked stake', `${s.lockedStake} atomic units`],
      ['Coverage count', s.coverageCount], ['Active coverages', s.activeCoverageCount]];
    for (const [name, value] of values) { const item = el('div', 'metric'); item.append(el('dt', '', name), el('dd', '', value)); grid.append(item); }
    section.append(grid); const solvency = el('div', 'solvency-row');
    const checks = [['Balance covers assets + stake', s.solvency.balanceCoversAssetsAndStake], ['Stake covers locks', s.solvency.stakeCoversLocks], ['Pool covers reservations', s.solvency.poolCoversReservations]];
    for (const [name, ok] of checks) { const line = el('p', `checkline ${ok ? 'check-ok' : 'check-fail'}`); line.append(el('span', 'check-mark', ok ? '✓' : '!'), document.createTextNode(`${name}: ${ok ? 'true' : 'false'}`)); solvency.append(line); }
    section.append(solvency); return section;
  }
  function renderProviders(rows, anchor) {
    const data = rows.map(p => [idText(p.providerId), idText(p.owner), idText(p.payout), `${p.freeStake} atomic`, `${p.lockedStake} atomic`,
      `${p.payoutBalanceAtomic} atomic`, `${p.cumulativeNetPaidAtomic} atomic`, Object.entries(p.coverageCountsByStatus || {}).map(([k,v]) => `${STATUS[Number(k)] || k}: ${v}`).join(' · ') || '0']);
    const p = panel('Providers', 'REGISTRY', data, ['Provider ID','Owner','Payout','Free stake','Locked stake','Payout balance','Cumulative net paid','Coverage counts'], anchor, 'No providers registered.','providers');
    p.append(el('p', 'field-help', 'Cumulative net paid is derived from protocol events; it is not profit. Balances and totals use atomic units.')); return p;
  }
  function renderPolicies(rows, anchor) {
    return panel('Policies', 'REGISTRY', rows.map(x => [idText(x.policyId),idText(x.providerId),idText(x.policyHash),String(x.premiumBps),String(x.stakeBps),String(x.withholdingBps),`${x.duration}s`,x.poolOnlyAllowed ? 'Allowed' : 'Not allowed']),
      ['Policy ID','Provider ID','Policy hash','Premium bps','Stake bps','Withholding bps','Duration','Pool only'], anchor, 'No policies registered.','policies');
  }
  function evidenceAction(coverage) {
    if (coverage.status !== 2 || !coverage.hasEvidence || state.session.role !== 'adjudicator' || !state.capabilities.includes('finalizeClaim')) return '—';
    const b = button('Review evidence', 'button-secondary button-small', () => { void openEvidence(coverage.coverageId); });
    return b;
  }
  function coverageRows(rows) {
    return rows.map(c => {
      const details = el('details', 'coverage-details'); const summary = el('summary', '', 'Details');
      details.append(summary);
      const values = [['Payer',c.payer],['Provider ID',c.providerId],['Policy ID',c.policyId],['Gross',`${c.gross} atomic`],['Premium',`${c.premium} atomic`],['Withheld',`${c.withheld} atomic`],
        ['Stake lock',`${c.stakeLock} atomic`],['Pool reservation',`${c.poolReservation} atomic`],['Opened at (chain time)',c.openedAt],['Expires at (chain time)',c.expiresAt],['Pool-only allowed',String(c.poolOnlyAllowed)],['Has evidence',String(c.hasEvidence)]];
      if (c.outcome !== undefined) values.push(['Outcome',OUTCOME[c.outcome] || `Unknown (${c.outcome})`]);
      if (c.refundAmount !== undefined) values.push(['Refund amount',`${c.refundAmount} atomic`]);
      const dl = el('dl','detail-grid'); for (const [k,v] of values) { const item=el('div','detail-item'); item.append(el('dt','',k),el('dd',k.includes('ID')||k==='Payer'?'mono wrap-id':'',v)); dl.append(item); }
      details.append(dl); return [idText(c.coverageId), statusPill(c.status), String(c.hasEvidence), details, evidenceAction(c)];
    });
  }
  function renderCoverages(rows, anchor) {
    return panel('Coverages', 'COVERAGE', coverageRows(rows), ['Coverage ID','Status','Evidence present','Record details','Private review'], anchor, 'No coverages in this anchored view.','coverages');
  }
  function renderActions() {
    const wrap = el('section', 'action-grid'); wrap.id = 'actions-panel';
    if(state.uncertain)wrap.append(el('p','inline-warning action-lock','A managed operation is unresolved. Reconcile the original operation before preparing another action.'));
    const caps = new Set(state.capabilities);
    const add = (kind, title, desc) => { if (caps.has(kind)) wrap.append(actionForm(kind,title,desc)); };
    if (state.session.role === 'admin') {
      add('registerProvider','Register provider','Registry IDs are immutable once registered. Review the exact owner and payout before confirming.');
      add('registerPolicy','Register policy','Policy parameters are immutable. The preview includes the canonical policy hash.');
      add('setPaused','Set protocol pause state','Choose the desired state explicitly. The preview validates the current anchored state and role.');
      add('approveCore','Set exact Core allowance','This grants the exact amount only, to the configured Core contract.');
      add('fundPool','Fund pool','Funding is a separate confirmed action and uses the exact entered amount.');
    } else if (state.session.role === 'provider') {
      add('approveCore','Set exact Core allowance','This grants the exact amount only, to the configured Core contract.');
      add('depositStake','Deposit provider stake','The action is fixed to the host-configured primary provider.');
      add('withdrawStake','Withdraw free stake','Only free stake is available to withdraw; locked collateral remains reserved.');
    }
    if (!wrap.children.length) { const c = card('No financial actions available', 'READ ONLY', 'This session has no advertised signing capability.'); wrap.append(c); }
    return wrap;
  }
  function renderPrivatePane() {
    const pane = el('section','card private-card'); pane.id='private-evidence'; pane.setAttribute('aria-labelledby','private-title');
    pane.append(el('p','eyebrow','PRIVATE · ADJUDICATOR ONLY'),el('h2','','Evidence review'),el('p','muted','Evidence is untrusted content. It is rendered as plain text for this session and is not downloaded or stored by the browser.'));
    if (!state.evidence) { pane.append(el('p','empty-state','Select Review evidence on a Claim pending coverage.')); return pane; }
    const identity=el('p','mono wrap-id',`Coverage ${state.evidenceCoverage}`); pane.append(identity);
    const pre=el('pre','evidence-text'); pre.tabIndex=0; pre.textContent=state.evidence; pane.append(pre);
    pane.append(button('Clear private evidence','button-secondary',()=>{clearPrivate(); render();}));
    if(!state.capabilities.includes('finalizeClaim')){pane.append(el('p','inline-warning','This local seat has no adjudication signing capability.'));return pane;}
    const heading=el('h3','','Record an explicit decision'); pane.append(heading);
    const form=el('form','action-form decision-form'); form.dataset.operation='finalizeClaim';
    field(form,'Coverage ID','coverageId',{value:state.evidenceCoverage,readonly:true,maxlength:66});
    field(form,'Outcome','outcome',{type:'select',items:[['0','Reject · no refund'],['1','Provider fault · refund'],['2','Pool only · refund']]});
    field(form,'Refund amount (atomic units)','refundAmount',{inputmode:'numeric',pattern:'(?:0|[1-9][0-9]*)',maxlength:78,required:false,help:'Use zero for rejection; enter a positive integer for either refund outcome.'});
    field(form,'Decision reason (private)','reason',{type:'textarea',rows:4,help:'Maximum 8192 UTF-8 bytes. Stored through the existing private claims flow; preview shows only a reason hash.'});
    const submit=button('Review decision','button-primary',null);submit.type='submit';form.append(submit);
    form.addEventListener('submit',(event)=>{event.preventDefault(); if(state.submitting)return; try{void prepareAction(opFromForm('finalizeClaim',form));}catch(error){if(error.message!=='FORM_INVALID')onRequestError(error);}});
    pane.append(form); return pane;
  }
  function render() {
    const root = $('#content'); root.replaceChildren();
    if (!state.session) return;
    const role = state.session.role; $('#role-eyebrow').textContent = `${labelRole(role).toUpperCase()} WORKSPACE`;
    $('#page-title').textContent = role === 'provider' ? 'Provider account' : role === 'admin' ? 'Protocol controls' : role === 'operator' ? 'Runtime operations' : 'Claims review';
    $('#page-description').textContent = ({ provider:'Collateral, event-derived proceeds and associated coverages.', admin:'Immutable registry operations, protocol pause and pool funding.', operator:'Canonical protocol availability and managed-operation reconciliation.', adjudicator:'Private claim evidence and explicit, reviewed decisions.' })[role];
    const prov = $('#provenance'); prov.replaceChildren();
    prov.append(el('span','provenance-item',`Host-selected role · ${labelRole(role)}`),el('span','provenance-item','Local EVM fixture · chain 84532'),el('span','provenance-item',`Core · ${state.context.core}`),el('span','provenance-item',`Token · ${state.context.token}`));
    if (!state.currentData) { root.append(el('div','unavailable','Read data is unavailable. Use Refresh reads to try again.')); }
    else {
      root.append(state.currentData.summarySnapshot ? renderSummary(state.currentData.summarySnapshot) : readStatePanel('Protocol state', 'summary'));
      root.append(state.currentData.providers ? renderProviders(state.currentData.providers.items,state.currentData.providers.anchor) : readStatePanel('Providers', 'providers'));
      root.append(state.currentData.policies ? renderPolicies(state.currentData.policies.items,state.currentData.policies.anchor) : readStatePanel('Policies', 'policies'));
      root.append(state.currentData.coverages ? renderCoverages(state.currentData.coverages.items,state.currentData.coverages.anchor) : readStatePanel('Coverages', 'coverages'));
    }
    if (role === 'admin' || role === 'provider') root.append(renderActions());
    if (role === 'adjudicator') root.append(renderPrivatePane());
    {
      const rec = card('Managed operations','ORIGINAL HASH ONLY','Reconciliation checks saved operation hashes. It does not retry, resend, replace or accept an arbitrary hash.');
      rec.id='reconcile-panel'; rec.append(button('Reconcile original operations','button-primary',()=>{void reconcile();}));
      if(state.lastAction){const latest=el('div',state.uncertain?'operation-state operation-uncertain':'operation-state');latest.append(el('p','eyebrow',state.uncertain?'UNRESOLVED · ACTIONS PAUSED':'LATEST RETURNED STATUS'),el('strong','',`${state.lastAction.operation||'Managed operation'} · ${state.lastAction.status||'unknown'}`));
        if(state.lastAction.operationId)latest.append(el('p','mono wrap-id',`Operation ID · ${state.lastAction.operationId}`));
        if(state.lastAction.transaction)latest.append(el('p','mono wrap-id',`Original transaction · ${state.lastAction.transaction}`));
        if(state.lastAction.inclusion)latest.append(el('p','mono wrap-id',`Included at block ${state.lastAction.inclusion.number} · ${state.lastAction.inclusion.hash}`));
        if(state.lastAction.detail)latest.append(el('p','',state.lastAction.detail));rec.append(latest);}
      const results=state.reconcileRows || [];const resultsBox=el('div','reconcile-results');resultsBox.id='reconcile-results';
      if(state.reconciliationLoading)resultsBox.append(el('p','loading-state','Checking saved original operation hashes…'));
      else if(!state.reconciliationLoaded)resultsBox.append(el('p','empty-state','No reconciliation has been run in this session.'));
      else if(results.length)resultsBox.append(rowTable(['Operation ID','Role action','Status','Original transaction','Included at'],results.map(r=>[idText(r.operationId),r.operation,r.status,r.transaction?idText(r.transaction):'—',r.inclusion?`Block ${r.inclusion.number} · ${r.inclusion.hash}`:'—'])));
      else resultsBox.append(el('p','empty-state','No managed operations are recorded for this session.'));
      rec.append(resultsBox);
      root.append(rec);
    }
    const nav=$('#navigation'); nav.replaceChildren();
    const sections=[['Overview','protocol-state'],['Providers','providers'],['Policies','policies'],['Coverages','coverages']];
    if(role==='admin'||role==='provider') sections.push(['Actions','actions-panel']); sections.push(['Reconciliation','reconcile-panel']); if(role==='adjudicator')sections.push(['Private review','private-evidence']);
    for(const [name,id] of sections){ const link=el('a','nav-link',name); link.href=`#${id}`; link.addEventListener('click',()=>clearPrivate()); nav.append(link); }
    $('#workspace').hidden=false; $('#enrollment').hidden=true; $('#session-summary').textContent=`${labelRole(role)} · ${state.session.address}`; $('#logout-button').hidden=false;
    syncActionControls();
  }
  async function readList(kind, cursor) {
    const limit=state.pageSizes[kind]||25;const suffix = cursor ? `?limit=${limit}&cursor=${encodeURIComponent(cursor)}` : `?limit=${limit}`;
    return json(`/v1/${kind}${suffix}`);
  }
  async function loadAll() {
    announce('Loading anchored protocol reads…'); state.currentData={summarySnapshot:null,providers:null,policies:null,coverages:null}; state.lists={};
    for(const kind of ['summary','providers','policies','coverages'])state.loadingPanels[kind]=true;render();
    const versions={};for(const kind of ['summary','providers','policies','coverages'])versions[kind]=++state.readVersions[kind];
    const tasks=[['summary',async()=>json('/v1/summary')],['providers',()=>readList('providers')],['policies',()=>readList('policies')],['coverages',()=>readList('coverages')]];
    const failures=[];
    await Promise.all(tasks.map(async([kind,load])=>{
      try { const value=await load(); if(!state.currentData||versions[kind]!==state.readVersions[kind])return;
        if(kind==='summary')state.currentData.summarySnapshot=value;
        else {state.currentData[kind]=value;state.lists[kind]=value.nextCursor||null;}state.loadingPanels[kind]=false;
      } catch(error) { if(versions[kind]!==state.readVersions[kind])return;failures.push(error); if(state.currentData){if(kind==='summary')state.currentData.summarySnapshot=null;else state.currentData[kind]=null;}state.loadingPanels[kind]=false; onRequestError(error); }
    }));
    if(!state.session||!tasks.every(([kind])=>versions[kind]===state.readVersions[kind]))return;
    render(); for(const kind of ['providers','policies','coverages']) if(state.lists[kind]) addMoreButton(kind);
    announce(failures.length ? `${failures.length} panel${failures.length===1?' is':'s are'} unavailable. Retry each affected read.` : 'Anchored reads loaded. Each panel shows its own observed block.', failures.length?'warning':'success');
  }
  function unavailablePanel(title,kind) {
    const section=card(title,'UNAVAILABLE','No prior value is being shown as current.');section.append(el('p','inline-warning','This panel could not be loaded. Retry this read to obtain a fresh anchored value.'));
    section.append(button('Retry read','button-secondary',()=>{void reloadPanel(kind);}));return section;
  }
  function readStatePanel(title,kind) {
    if(state.loadingPanels[kind]){const section=card(title,'LOADING','Waiting for an anchored read from the local protocol API.');section.setAttribute('aria-busy','true');section.append(el('p','loading-state','Loading current panel…'));return section;}
    return unavailablePanel(title,kind);
  }
  function updateReconciliationPanel() {
    const box=$('#reconcile-results');if(!box)return;box.replaceChildren();const results=state.reconcileRows||[];
    if(state.reconciliationLoading)box.append(el('p','loading-state','Checking saved original operation hashes…'));
    else if(!state.reconciliationLoaded)box.append(el('p','empty-state','No reconciliation has been run in this session.'));
    else if(results.length)box.append(rowTable(['Operation ID','Role action','Status','Original transaction','Included at'],results.map(r=>[idText(r.operationId),r.operation,r.status,r.transaction?idText(r.transaction):'—',r.inclusion?`Block ${r.inclusion.number} · ${r.inclusion.hash}`:'—'])));
    else box.append(el('p','empty-state','No managed operations are recorded for this session.'));
  }
  async function reloadPanel(kind) {
    if(!state.currentData)return;const version=++state.readVersions[kind];state.currentData[kind==='summary'?'summarySnapshot':kind]=null;if(kind!=='summary')state.lists[kind]=null;state.loadingPanels[kind]=true;render();
    try {const value=kind==='summary'?await json('/v1/summary'):await readList(kind);
      if(version!==state.readVersions[kind]||!state.currentData)return;
      if(kind==='summary')state.currentData.summarySnapshot=value;else{state.currentData[kind]=value;state.lists[kind]=value.nextCursor||null;}state.loadingPanels[kind]=false;
      render();if(kind!=='summary'&&state.lists[kind])addMoreButton(kind);announce(`${titleCase(kind)} read refreshed at its own observed anchor.`,'success');
    }catch(error){if(version!==state.readVersions[kind])return;state.loadingPanels[kind]=false;onRequestError(error);if(state.session)render();}
  }
  function titleCase(value){return value[0].toUpperCase()+value.slice(1);}
  function addMoreButton(kind) {
    const section=$(`[data-section="${kind}"]`); if(!section||section.querySelector('[data-more]'))return;
    const b=button('Load next page','button-secondary',async()=>{
      b.disabled=true; const cursor=state.lists[kind]; const version=state.readVersions[kind];if(!cursor)return;
      try { const page=await readList(kind,cursor); const store=state.currentData[kind];
        if(version!==state.readVersions[kind]||!store)return;
        if(store.anchor.hash!==page.anchor.hash||store.anchor.number!==page.anchor.number) throw Object.assign(new Error('PROTOCOL_CURSOR_INVALID'),{code:'PROTOCOL_CURSOR_INVALID'});
        store.items.push(...page.items); state.lists[kind]=page.nextCursor||null; render(); if(state.lists[kind])addMoreButton(kind); announce('Next anchored page loaded.','success');
      }catch(error){if(version!==state.readVersions[kind])return;state.currentData[kind]=null;state.lists[kind]=null;render();onRequestError(error);} });
    b.dataset.more='true'; section.append(b);
  }
  async function connect() {
    if(state.seatConsumed)return;
    $('#connect-button').disabled=true; announce('Connecting to the host-selected local seat…');
    try { const session=await json('/console/session',{method:'POST',body:'{}'}); state.seatConsumed=true; await acceptSession(session); }
    catch(error){state.seatConsumed=true;$('#rearm-copy').hidden=false;$('#connect-button').disabled=true;onRequestError(error);}
  }
  async function acceptSession(session) {
    if(!session||!['provider','admin','operator','adjudicator'].includes(session.role)||session.role!==state.context?.role||!validAddress(session.address)||typeof session.csrfToken!=='string') throw new Error('PROTOCOL_SESSION_REQUIRED');
    state.session=session;state.csrf=session.csrfToken;state.capabilities=Array.isArray(session.capabilities)?session.capabilities:[];state.seatConsumed=true;
    $('#enrollment').hidden=true;$('#workspace').hidden=false;await loadAll();
  }
  async function resume() {
    try { const session=await json('/v1/session'); state.seatConsumed=true; await acceptSession(session); }
    catch(error){ if(error?.code==='PROTOCOL_SESSION_REQUIRED'||error?.message==='PROTOCOL_SESSION_REQUIRED'){ $('#enrollment').hidden=false;$('#rearm-copy').hidden=!state.seatConsumed;$('#connect-button').disabled=state.seatConsumed; return; } onRequestError(error); }
  }
  function setupContext(context) {
    if(!context||context.localOnly!==true||context.chainId!==84532||!['provider','admin','operator','adjudicator'].includes(context.role)||!validId(context.providerId)||!validId(context.policyId)||!validAddress(context.core)||!validAddress(context.token))throw new Error('PROTOCOL_CONTEXT_MISMATCH');
    state.context=context;$('#chain-label').textContent=`LOCAL EVM · ${context.chainId}`;
    $('#enrollment-copy').textContent=`The trusted host armed a one-use ${labelRole(context.role)} seat on local chain ${context.chainId}. This is a disposable local fixture, not a live network connection.`;
  }
  function renderReview(preview) {
    const box=$('#review-fields');box.replaceChildren();
    const rows=[['Role',labelRole(preview.role)],['Actor',preview.actor],['Operation',preview.operation]];
    const allow = new Set(Object.keys(REVIEW_LABELS));
    for(const [key,value] of Object.entries(preview.review||{})){
      if(!allow.has(key)||!['string','number','boolean'].includes(typeof value))continue;
      if(key==='outcome'){
        const label=OUTCOME[value]||'Unknown outcome';
        const code=value===0||value===1||value===2||value==='0'||value==='1'||value==='2'?` (${value})`:'';
        rows.push([REVIEW_LABELS[key],`${label}${code}`]);
      } else rows.push([REVIEW_LABELS[key]||key,String(value)]);
    }
    rows.push(['Chain ID',String(preview.chainId)],['Core',preview.core],['Observed block',preview.anchor.number],['Observed hash',preview.anchor.hash],['Observed chain time',preview.anchor.timestamp],['Preview expires (chain time)',preview.expiresAt],['Gas limit',preview.gas],['Max fee per gas (wei)',preview.maxFeePerGas],['Priority fee ceiling (wei)',preview.maxPriorityFeePerGas]);
    if(preview.operation==='finalizeClaim')rows.push(['Decision commitment','Created after explicit confirmation; no commitment is included in this preview.']);
    const dl=el('dl','review-list');for(const [k,v] of rows){const item=el('div','review-item');item.append(el('dt','',k),el('dd',k==='Actor'||k==='Core'||k.includes('hash')||k.includes('ID')?'mono wrap-id':'',v));dl.append(item);}box.append(dl);
    const reason=state.pendingReason; if(reason){box.append(el('p','private-note','The private reason text is not shown here. Review its reason hash above and retain the reason only in this local adjudicator view.'));state.pendingReason=null;}
  }
  async function prepareAction(operation) {
    if(state.uncertain){announce('Reconcile the original managed operation before preparing another action.','warning');return;}
    const origin=document.activeElement;state.lastFocus=origin;
    state.submitting=true;const generation=state.privateGeneration;const session=state.session;syncActionControls();
    try {
      state.reconciliationLoading=true;state.reconciliationLoaded=false;state.reconcileRows=null;updateReconciliationPanel();announce('Checking managed operation state before preparing a preview…');
      const baseline=await json('/v1/actions/reconcile',{method:'POST',body:'{}'});
      if(generation!==state.privateGeneration||session!==state.session){state.reconciliationLoading=false;state.reconciliationLoaded=false;state.reconcileRows=null;updateReconciliationPanel();state.submitting=false;syncActionControls();return;}
      state.reconcileRows=baseline;state.reconciliationLoaded=true;state.reconciliationLoading=false;updateReconciliationPanel();state.preActionOperationIds=new Set(baseline.map(row=>row.operationId));
      const unresolved=[...baseline].reverse().find(row=>!['success','reverted'].includes(row.status));
      if(unresolved){state.lastAction=unresolved;state.uncertain=true;state.submitting=false;render();announce('A managed operation is unresolved. Reconcile the original operation before preparing another action.','warning');return;}
    } catch(error) { state.reconciliationLoading=false;state.reconciliationLoaded=false;state.reconcileRows=null;updateReconciliationPanel();state.submitting=false;syncActionControls();if(generation!==state.privateGeneration||session!==state.session)return;onRequestError(error);return; }
    try {
      const preview=await json('/v1/actions/preview',{method:'POST',body:JSON.stringify({operation})});
      if(generation!==state.privateGeneration||session!==state.session)return;
      if(!preview||typeof preview.previewId!=='string'||!preview.anchor||!preview.review)throw new Error('PROTOCOL_OPERATION_FAILED');
      state.preview=preview;state.pendingReason=operation.kind==='finalizeClaim'?operation.reason:null;
      renderReview(preview);$('#review-warning').hidden=true;$('#confirm-action').disabled=false;$('#confirm-action').textContent='Confirm action';
      $('#review-dialog').showModal();$('#cancel-action').focus();announce('Review the exact preview before confirming.','');
    }catch(error){if(generation===state.privateGeneration&&session===state.session)onRequestError(error);}finally{state.submitting=false;syncActionControls();}
  }
  async function confirmAction() {
    if(state.submitting||!state.preview)return;
    const preview=state.preview;state.preview=null;state.submitting=true;$('#confirm-action').disabled=true;$('#cancel-action').disabled=true;
    const dialog=$('#review-dialog');if(dialog.open)dialog.close();
    const focus=state.lastFocus;try{
      const result=await json('/v1/actions/confirm',{method:'POST',body:JSON.stringify({previewId:preview.previewId})});
      clearPrivate();state.pendingReason=null;
      state.lastAction=result;state.uncertain=['unknown','prepared','reserved'].includes(result.status);
      if(state.uncertain) announce(`Operation status is ${result.status}. Reconcile the original operation before any further action.`,'warning');
      else announce(`Operation ${result.status}. The returned transaction is the managed original hash.`,'success');
      await loadAll();
    }catch(error){const code=error?.code||error?.message;
      const rejected=['PROTOCOL_PREVIEW_REQUIRED','PROTOCOL_PREVIEW_EXPIRED','PROTOCOL_PREVIEW_STALE','PROTOCOL_FORBIDDEN','PROTOCOL_ARGUMENT_INVALID','PROTOCOL_LIMIT','PROTOCOL_SIMULATION_FAILED','PROTOCOL_APPROVAL_REQUIRED'];
      if(!rejected.includes(code))clearPrivate();state.pendingReason=null;
      state.lastAction={operation:preview.operation,actor:preview.actor,status:rejected.includes(code)?'not sent':'unknown',detail:fixedError(code)};state.uncertain=!rejected.includes(code);
      onRequestError(error);announce(rejected.includes(code)?`${fixedError(code)} Prepare and review again if the operation is still intended.`:`${fixedError(code)} Use reconciliation to check the original managed operation. Do not retry this action.`,'warning');render();}
    finally {state.submitting=false;$('#cancel-action').disabled=false;syncActionControls();if(focus?.isConnected)focus.focus();}
  }
  async function reconcile() {
    if(state.submitting)return;state.submitting=true;syncActionControls();const session=state.session;state.reconciliationLoading=true;state.reconciliationLoaded=false;state.reconcileRows=null;updateReconciliationPanel();announce('Reconciling saved original operation hashes…');
    try {const rows=await json('/v1/actions/reconcile',{method:'POST',body:'{}'});
      if(session!==state.session)return;state.reconcileRows=rows;state.reconciliationLoading=false;state.reconciliationLoaded=true;
      const unresolved=[...rows].reverse().find(row=>!['success','reverted'].includes(row.status));
      if(unresolved){state.lastAction=unresolved;state.uncertain=true;}
      else if(state.uncertain&&state.lastAction){let match=state.lastAction.operationId?rows.find(r=>r.operationId===state.lastAction.operationId):null;
        if(!match)match=[...rows].reverse().find(r=>r.operation===state.lastAction.operation&&r.actor===state.lastAction.actor&&!state.preActionOperationIds.has(r.operationId));
        if(match){state.lastAction=match;state.uncertain=!['success','reverted'].includes(match.status);}}
      announce(state.uncertain?'No terminal result for the unresolved operation was verified. Financial actions remain paused.':'Reconciliation completed against saved original hashes. No operation was resent or replaced.','success');render();}
    catch(error){if(session===state.session){state.reconciliationLoading=false;state.reconciliationLoaded=false;state.reconcileRows=null;onRequestError(error);updateReconciliationPanel();}}finally{state.submitting=false;syncActionControls();}
  }
  async function openEvidence(coverageId) {
    clearPrivate();const generation=state.privateGeneration;const session=state.session;announce('Reading authorized private evidence…');
    try {const response=await request('/v1/evidence/read',{method:'POST',body:JSON.stringify({coverageId})});const bytes=await response.arrayBuffer();
      if(bytes.byteLength>65536)throw new Error('PROTOCOL_STATE_UNAVAILABLE');
      if(generation!==state.privateGeneration||session!==state.session)return;
      const text=new TextDecoder('utf-8',{fatal:false}).decode(bytes);state.evidence=text;state.evidenceCoverage=coverageId;announce('Private evidence is open in this adjudicator session.','success');render();
      const pane=$('#private-evidence');pane?.scrollIntoView({behavior:'smooth',block:'start'});pane?.querySelector('h2')?.focus?.();
    }catch(error){if(generation!==state.privateGeneration||session!==state.session)return;clearPrivate();onRequestError(error);}
  }
  async function logout() {
    if(!state.session)return;clearPrivate();
    try{await json('/v1/logout',{method:'POST',body:'{}'});}catch(error){if(error?.code!=='PROTOCOL_SESSION_REQUIRED')onRequestError(error);}
    state.session=null;state.csrf=null;state.currentData=null;state.lists={};state.reconcileRows=null;state.lastAction=null;state.uncertain=false;state.reconciliationLoaded=false;state.reconciliationLoading=false;$('#workspace').hidden=true;$('#logout-button').hidden=true;$('#session-summary').textContent='Not connected';$('#enrollment').hidden=false;$('#connect-button').disabled=true;$('#rearm-copy').hidden=false;announce('Session ended. Ask the trusted host to restart the console to arm another seat.','success');
  }
  $('#connect-button').addEventListener('click',()=>void connect());
  $('#refresh-button').addEventListener('click',()=>{clearPrivate();void loadAll();});
  $('#logout-button').addEventListener('click',()=>void logout());
  $('#confirm-action').addEventListener('click',()=>void confirmAction());
  $('#review-dialog').addEventListener('close',()=>{if(state.preview){state.preview=null;state.pendingReason=null;announce('Preview canceled. No operation was confirmed.','');}const focus=state.lastFocus;if(focus?.isConnected)focus.focus();});
  window.addEventListener('pagehide',clearPrivate);
  (async()=>{try{setupContext(await json('/console/context'));await resume();}catch(error){onRequestError(error);$('#enrollment').hidden=false;$('#connect-button').disabled=true;$('#enrollment-copy').textContent='The trusted host context is unavailable. Restart the local console and reload this page.';}})();
})();
