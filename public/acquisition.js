// R2.3 / R3 / R4 / R6 — the Acquisition section.
//
// This is the screen layer over backends that were already built and tested but
// had no way in: card OCR, CSV import, contact storage with consent, discovery,
// and the sending-readiness gate.
//
// Two rules run through all of it:
//   * nothing here can send anything. The only send path is server-side and
//     refuses unless the owner has switched outreach on.
//   * a disconnected or unset thing says so (R2.9). No zeroed dashboard that
//     reads as "no prospects yet" when the truth is "never looked".
//
// Render functions are pure (state in, HTML out) so they can be tested in node.

export const TABS = Object.freeze([
  { id: 'contacts', label: 'Contacts' },
  { id: 'intake', label: 'Add contacts' },
  { id: 'prospects', label: 'Prospects' },
  { id: 'campaigns', label: 'Campaigns' },
  { id: 'inbox', label: 'Replies' },
  { id: 'bookings', label: 'Bookings' },
  { id: 'settings', label: 'Targeting & pricing' },
]);

export const KIND_LABEL = Object.freeze({
  interested: 'Interested',
  'wants-details': 'Wants details',
  'wants-preview': 'Wants a preview',
  'wants-call': 'Wants a call',
  'not-now': 'Not now',
  'not-interested': 'Not interested',
  'opt-out': 'Opted out',
  'auto-reply': 'Auto-reply',
  'delivery-failure': 'Bounced',
  ambiguous: 'Needs reading',
});

/** Kinds that deserve the owner's attention first. */
export const NEEDS_ATTENTION = new Set(['interested', 'wants-call', 'wants-preview', 'wants-details', 'ambiguous']);

export const CAMPAIGN_TYPE_LABEL = Object.freeze({
  'cold-no-site-found': 'Cold — no website found',
  'cold-weak-site': 'Cold — website did not load',
  'warm-card-followup': 'Warm — card / networking follow-up',
});

import { renderPanel, renderSuccess, PANEL } from './states.js';

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const val = (f) => (f && typeof f === 'object' && 'value' in f ? f.value : f);

/**
 * R2.5 — which state a panel is in, from what the host recorded about the last
 * fetch for it. `state.load[key]` is set by renderAcq; its absence means the
 * host has not reported anything, in which case an empty array really is empty.
 *
 * The case that matters: loaded === false with an error. Before this, every
 * panel turned a failed request into an empty list.
 */
export function panelState(state, key, rows) {
  if (state.loading) return { status: PANEL.LOADING, error: '' };
  const rec = state.load && state.load[key];
  if (rec && rec.error) {
    return { status: /locked|password|401/i.test(rec.error) ? PANEL.LOCKED : PANEL.ERROR, error: rec.error };
  }
  if (rec && rec.configured === false) return { status: PANEL.DISCONNECTED, error: '' };
  return { status: (rows || []).length ? PANEL.READY : PANEL.EMPTY, error: '' };
}

/** A field a human still needs to look at is marked, not quietly used. */
export function fieldCell(f) {
  if (!f || val(f) == null || val(f) === '') return '<span class="faint">—</span>';
  const needs = f && typeof f === 'object' && f.needsReview;
  return `${esc(val(f))}${needs ? ' <span class="pill warn sm" title="Low confidence — check this before using it">check</span>' : ''}`;
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

export function renderContacts(state) {
  const rows = state.contacts || [];
  // R2.5 — a failed load used to render "No contacts yet", which is a false
  // statement in a calm voice. It now has to say it could not read them.
  const shell = renderPanel(panelState(state, 'contacts', rows), {
    thing: 'contacts',
    retryKey: 'contacts',
    empty: `<b>No contacts yet.</b> This list fills from the <b>Add contacts</b> tab — scan business cards,
      import a CSV, or add someone by hand. Nothing is imported automatically.`,
  });
  if (shell) return shell;
  const body = rows
    .map((c) => {
      const opted = c.optedOutAt || c.emailStatus === 'complained';
      const bounced = c.emailStatus === 'hard_bounce';
      const statusPill = opted
        ? '<span class="pill neg sm">opted out</span>'
        : bounced
          ? '<span class="pill warn sm">bounced</span>'
          : c.email
            ? '<span class="pill sm">emailable</span>'
            : '<span class="pill sm faint">no email</span>';
      return `<tr data-id="${esc(c.id)}">
        <td>${fieldCell(c.name)}</td>
        <td>${fieldCell(c.businessName)}</td>
        <td>${fieldCell(c.email)}</td>
        <td>${fieldCell(c.phone)}</td>
        <td>${esc(c.relationship || 'none').replace(/_/g, ' ')}</td>
        <td>${esc(c.source || '')}</td>
        <td>${statusPill}</td>
      </tr>`;
    })
    .join('');
  return `<div class="note" style="margin-bottom:10px">${rows.length} contact${rows.length === 1 ? '' : 's'}.
    An opted-out contact stays listed on purpose — deleting the record would lose the opt-out.</div>
    <table class="acq-table"><thead><tr>
      <th>Name</th><th>Business</th><th>Email</th><th>Phone</th><th>Relationship</th><th>Source</th><th>Status</th>
    </tr></thead><tbody>${body}</tbody></table>`;
}

// ---------------------------------------------------------------------------
// Intake — cards, CSV, manual
// ---------------------------------------------------------------------------

export function renderIntake(state) {
  const scan = state.scan;
  const preview = state.csvPreview;

  const scanBlock = !scan
    ? ''
    : scan.error
      ? `<div class="note neg">Could not read the photos: ${esc(scan.error)}</div>`
      : `<div class="note">${esc(scan.note || '')}</div>
         ${scan.cards
           .map(
             (c, i) => `<div class="acq-card" data-card="${i}">
             <div class="acq-card-h"><b>${esc(val(c.name) || 'Unnamed card')}</b>
               ${c.review.length ? `<span class="pill warn sm">${c.review.length} to check</span>` : '<span class="pill sm">clear</span>'}</div>
             <div class="acq-grid">
               ${['name', 'businessName', 'role', 'email', 'phone', 'website']
                 .map((k) => `<label>${k}<input data-f="${k}" value="${esc(val(c[k]) || '')}" /></label>`)
                 .join('')}
             </div>
             ${c.review.length ? `<div class="note warn">Unsure about: ${c.review.map((r) => esc(r.field)).join(', ')} — correct these before saving.</div>` : ''}
             ${c.injectionFlag ? `<div class="note neg">⚠ This card contains text that reads like an instruction to the software
                  (${c.injectionFlag.patterns.map(esc).join('; ')}). It was treated as ordinary text and nothing was acted on,
                  but check the card before saving this contact.</div>` : ''}
           </div>`
           )
           .join('')}
         <div class="btn-row"><button class="btn" id="acqCommitCards">Save ${scan.cards.length} contact${scan.cards.length === 1 ? '' : 's'}</button></div>`;

  const previewBlock = !preview
    ? ''
    : `<div class="note">${esc(preview.willImport ?? preview.rows?.length ?? 0)} row(s) would be imported,
        ${esc(preview.skipped?.length || 0)} skipped. <b>Nothing has been written yet.</b></div>
       ${(preview.skipped || []).length ? `<div class="note warn">Skipped: ${preview.skipped.slice(0, 5).map((s) => esc(s.reason || s)).join('; ')}</div>` : ''}
       <div class="btn-row"><button class="btn" id="acqCommitCsv">Import for real</button></div>`;

  return `
  <div class="acq-panel">
    <h3>Scan business cards</h3>
    <p class="note">One or many cards per photo, front and back. Nothing is saved until you press save —
      the scan only proposes, so a misread never becomes a contact on its own.</p>
    <!-- R2.7 — this was the one control on the whole dashboard a screen reader
         announced as just "file upload button" with no idea what it wanted. -->
    <label class="acq-inline" for="acqCardFiles">Photos of the cards</label>
    <input type="file" id="acqCardFiles" accept="image/*" multiple
      aria-label="Choose photos of business cards to scan" />
    <label class="acq-inline">Where did you meet them?
      <select id="acqRelationship">
        <option value="met_in_person">I met them in person</option>
        <option value="same_networking_group">Same networking group (we have not met)</option>
        <option value="none">Neither</option>
      </select>
    </label>
    <div class="btn-row"><button class="btn" id="acqScanBtn">Read the cards</button></div>
    ${scanBlock}
  </div>

  <div class="acq-panel">
    <h3>Import a CSV</h3>
    <p class="note">Preview first. The preview and the import use the same rules, so what it says will
      happen is what happens.</p>
    <textarea id="acqCsv" rows="6" placeholder="Paste CSV here, including the header row"></textarea>
    <div class="btn-row"><button class="btn ghost" id="acqPreviewBtn">Preview</button></div>
    ${previewBlock}
  </div>

  <div class="acq-panel">
    <h3>Add one by hand</h3>
    <div class="acq-grid">
      <label>Name<input id="m_name" /></label>
      <label>Business<input id="m_business" /></label>
      <label>Email<input id="m_email" /></label>
      <label>Phone<input id="m_phone" /></label>
    </div>
    <label class="acq-inline">How do you know them?
      <select id="m_rel">
        <option value="none">We have not met</option>
        <option value="met_in_person">I met them in person</option>
        <option value="same_networking_group">Same networking group</option>
        <option value="referred">Referred to me</option>
      </select>
    </label>
    <label class="acq-block">Where you met / what you talked about
      <textarea id="m_notes" rows="3" placeholder="Chamber breakfast — wants a quote for a new site"></textarea>
    </label>
    <p class="note faint">Notes are stored against the contact and are what a warm follow-up draws on.
      Saying you met someone you have not met is the one thing this will not do, so the relationship
      above is recorded exactly as you set it.</p>
    <div class="btn-row"><button class="btn" id="acqManualSave">Add contact</button></div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Prospects
// ---------------------------------------------------------------------------

export const SEGMENT_LABEL = Object.freeze({
  'no-site-found': 'No website found',
  'weak-site': 'Website did not load',
  'has-site': 'Has a working website',
  uncertain: 'Uncertain',
});

export function renderProspects(state) {
  const rows = state.prospects || [];
  const st = panelState(state, 'prospects', rows);
  if (st.status === PANEL.LOADING || st.status === PANEL.ERROR || st.status === PANEL.LOCKED) {
    return renderPanel(st, { thing: 'prospects', retryKey: 'prospects' });
  }

  const head = `<div class="note" style="line-height:1.7">
    Discovery reads <b>OpenStreetMap</b> and checks whether each business has a working website.
    It stores prospects only — <b>it never contacts anyone</b>.
    ${state.targetingStatus === 'draft' ? '<br /><b>Targeting is still a draft</b> (DFW service businesses). Confirm it under Targeting &amp; pricing before treating results as a real list.' : ''}
  </div>
  <div class="btn-row"><button class="btn" id="acqDiscoverBtn">Find businesses</button>
    <span class="faint" id="acqDiscoverNote"></span></div>`;

  if (!rows.length) {
    // the head carries the "Find businesses" button, so the empty state keeps
    // it rather than replacing the only way out of being empty
    return `${head}${renderPanel({ status: PANEL.EMPTY }, {
      thing: 'prospects',
      empty: `<b>Nothing searched yet.</b> This is empty because discovery has
        not run, which is not the same as there being no businesses to find.`,
    })}`;
  }

  const counts = rows.reduce((m, p) => { const s = p.qualification?.segment || 'uncertain'; m[s] = (m[s] || 0) + 1; return m; }, {});
  const summary = Object.entries(counts)
    .map(([k, n]) => `<span class="pill sm">${esc(SEGMENT_LABEL[k] || k)}: ${n}</span>`)
    .join(' ');

  const campaignPicker = (state.campaigns || []).length
    ? `<div class="acq-inline">Add selected to
         <select id="pr_campaign">${state.campaigns.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}</select>
         <button class="btn sm" id="pr_enrol">Add to campaign</button>
         <span class="faint" id="pr_enrol_note"></span>
       </div>`
    : '<div class="note faint">Create a campaign first to enrol these prospects.</div>';

  const body = rows
    .map((p) => {
      const seg = p.qualification?.segment || 'uncertain';
      const web = p.web || {};
      return `<tr>
        <td><input type="checkbox" class="pr_pick" value="${esc(p.id)}"
          aria-label="Select ${esc(p.name || 'this business')}"
          ${p.email ? '' : 'disabled title="No email on the listing"'} /></td>
        <td>${esc(p.name)}</td>
        <td>${esc(p.city || '')}</td>
        <td>${esc(p.industry || '')}</td>
        <td><span class="pill sm ${seg === 'no-site-found' ? 'warn' : ''}">${esc(SEGMENT_LABEL[seg] || seg)}</span></td>
        <td class="faint">${esc(web.observation || '')}</td>
        <td>
          ${p.evidence?.sourceUrl ? `<a href="${esc(p.evidence.sourceUrl)}" target="_blank" rel="noopener">source</a> ` : ''}
          <button class="btn sm ghost" data-preview="${esc(p.id)}">Preview message</button>
        </td>
      </tr>`;
    })
    .join('');

  return `${head}
    <div style="margin:10px 0">${summary}</div>
    ${campaignPicker}
    <table class="acq-table"><thead><tr>
      <th></th><th>Business</th><th>City</th><th>Trade</th><th>Web presence</th><th>What was actually observed</th><th></th>
    </tr></thead><tbody>${body}</tbody></table>
    <p class="note faint">A prospect with no email on the listing cannot be selected — we do not guess an
      address from a domain. ${esc(state.attribution || '')}</p>`;
}

// ---------------------------------------------------------------------------
// Settings — pricing (G1) and targeting (G4)
// ---------------------------------------------------------------------------

export function renderAcqSettings(state) {
  const s = state.settings;
  // R2.5 — settings that failed to load used to sit on "Loading settings…"
  // forever, which is a spinner telling the owner a lie about what is happening.
  if (!s) {
    const sts = panelState(state, 'settings', []);
    return renderPanel(sts.status === PANEL.EMPTY ? { status: PANEL.LOADING } : sts, {
      thing: 'settings',
      retryKey: 'settings',
      loading: 'Loading settings…',
    });
  }
  const p = s.pricing;
  const t = s.targeting;

  return `
  <div class="acq-panel">
    <h3>Pricing</h3>
    ${p.configured
      ? '<div class="note">Set. Outgoing messages may quote this.</div>'
      : `<div class="note warn">${esc(state.pricingBlocker || 'Not set yet.')}</div>`}
    <div class="acq-grid">
      <label>Initial build price<input id="p_build" value="${p.buildPrice ?? ''}" placeholder="not set" /></label>
      <label>Monthly maintenance<input id="p_monthly" value="${p.monthlyFee ?? ''}" placeholder="not set" /></label>
    </div>
    <p class="note faint">The monthly fee covers: ${(p.includes || []).map(esc).join(' · ')}.</p>
    <div class="btn-row"><button class="btn" id="acqSavePricing">Save pricing</button></div>
  </div>

  <div class="acq-panel">
    <h3>Targeting</h3>
    <div class="note ${t.status === 'draft' ? 'warn' : ''}">
      Status: <b>${esc(t.status)}</b> — ${esc(t.source)}.
      ${t.status === 'draft' ? 'This is a starting point for building and testing, not a decision to contact anyone.' : ''}
    </div>
    <div class="acq-grid">
      <label>Area<input id="t_area" value="${esc(t.geography.label)}" /></label>
      <label>Businesses per week<input id="t_volume" value="${esc(t.weeklyVolume)}" /></label>
      <label>Minimum years trading<input id="t_years" value="${esc(t.exclusions.minYearsInBusiness)}" /></label>
    </div>
    <p class="note faint">Trades: ${(t.industries || []).map((i) => esc(i.label)).join(' · ') || 'none'}</p>
    <div class="btn-row">
      <button class="btn ghost" id="acqSaveTargeting">Save as draft</button>
      <button class="btn" id="acqConfirmTargeting">Confirm this targeting</button>
    </div>
  </div>

  <div class="acq-panel">
    <h3>Sending</h3>
    ${renderReadiness(state.readiness, state.readinessError)}
  </div>

  <div class="acq-panel">
    <h3>Spending</h3>
    ${renderBudget(state.budget, state.budgetError)}
  </div>

  <div class="acq-panel">
    <h3>Integrations</h3>
    ${renderIntegrations(state.integrations, state.integrationsError)}
  </div>

  <div class="acq-panel">
    <h3>Text messaging</h3>
    ${renderSms(state)}
  </div>`;
}

const money = (cents) => (cents == null ? '—' : `$${(cents / 100).toFixed(2)}`);

/**
 * R8.8 — period, spent, reserved, remaining, next reset, for both windows.
 *
 * The thing this has to get across is that the two rows are NOT two budgets.
 * A dollar spent appears in both, because they are two windows over the same
 * money; adding them together would double count. The screen says so, rather
 * than leaving the owner to work out why the numbers do not sum.
 */
export function renderBudget(b, error = '') {
  if (error) {
    return `<div class="note neg"><b>Could not read the spending state.</b> ${esc(error)}
      <br />This is not a report of zero spending — nothing could be read.
      <button class="btn sm ghost" data-retry="budget">Try again</button></div>`;
  }
  if (!b) return '<div class="loading">Reading the spending state…</div>';

  // `limitConfigured` is "the owner typed a number in"; `enforced` is "a code
  // path applies it". Only the second one may be described as a cap.
  const row = (w) => {
    const noLimit = !(w.limitConfigured ?? w.enforced);
    return `<tr>
      <td><b>${esc(w.period === 'week' ? 'This week' : 'This month')}</b><div class="faint">${esc(w.key)}</div></td>
      <td>${noLimit ? '<span class="faint">no limit set</span>' : money(w.limitCents)}</td>
      <td>${money(w.spentCents)}</td>
      <td>${money(w.reservedCents)}<div class="faint">jobs still running</div></td>
      <td>${noLimit ? '<span class="faint">—</span>' : `<b>${money(w.remainingCents)}</b>`}</td>
      <td>${esc(resetWords(w.resetsAt))}</td>
    </tr>`;
  };

  // The panel may only claim a limit is stopping work if something applies it.
  const binding = b.capWired === false
    ? `<div class="note warn"><b>These limits are not being applied.</b> ${esc(b.capUnwiredNote || '')}</div>`
    : b.bindingPeriod
      ? `<div class="note">The <b>${esc(b.bindingPeriod === 'week' ? 'weekly' : 'monthly')}</b> limit is the one actually stopping work right now.</div>`
      : `<div class="note warn"><b>No limit is set,</b> so nothing is capping what this app chooses to spend.
         Spending is still recorded below — this is not a claim that nothing is being spent.</div>`;

  return `
    ${b.paused ? '<div class="note warn"><b>Automation is paused.</b> Nothing new will be started or charged until it is resumed.</div>' : ''}
    ${binding}
    ${renderObservedSpend(b.observed)}
    ${renderActiveCaps(b.activeCaps)}
    ${renderPaidPaths(b.paidPaths, b.essentialWork)}
    <h4 class="acq-h4">${b.capWired ? 'Your spending limit' : 'Limits on record'}</h4>
    ${renderLimitForm(b)}
    <table class="acq-table">
      <thead><tr><th>Window</th><th>Limit</th><th>Spent</th><th>Reserved</th><th>Remaining</th><th>Resets</th></tr></thead>
      <tbody>${row(b.week)}${row(b.month)}</tbody>
    </table>
    <p class="note faint">These two rows are <b>two windows over the same money</b>, not two budgets —
      a dollar spent today appears in both. Do not add them together.
      ${b.capWired === false
    ? 'Their spent and reserved columns stay at zero because nothing writes to them yet, not because nothing has been spent.'
    : b.week.conversationReserveCents ? `${money(b.week.conversationReserveCents)} of the weekly limit is held back for live conversations, so a reply never fails for want of budget.` : ''}</p>
    <p class="note faint">${esc(b.uncappableNote || '')}</p>`;
}

/**
 * What has actually been spent, from the counters the AI features write.
 *
 * This is here because the table above reads zero by construction, and a zero
 * that means "nothing records this" looks exactly like a zero that means
 * "nothing was spent".
 */
export function renderObservedSpend(o) {
  if (!o) return '';
  if (o.error) {
    return `<div class="note neg"><b>Could not read what has been spent.</b> ${esc(o.error)}.
      <div class="faint">${esc(o.note || '')}</div></div>`;
  }
  const rows = (o.byFeature || []).map((f) => `<li>${esc(f.what)} — <b>$${Number(f.usd || 0).toFixed(2)}</b></li>`).join('');
  return `<div class="acq-spend">
    <h4 class="acq-h4">What has actually been spent</h4>
    <div class="acq-spend-total"><b>$${Number(o.totalUsd || 0).toFixed(2)}</b>
      <span class="faint">on AI so far in ${esc(o.month || 'this month')}</span></div>
    ${rows ? `<ul class="acq-spend-list">${rows}</ul>` : ''}
    <p class="note faint">${esc(o.source || '')}. ${esc(o.note || '')}</p>
  </div>`;
}

/**
 * R16.3 — setting the limit the enforcement path actually reads.
 *
 * Blank means "no limit", which is deliberately not the same as 0: a zero would
 * refuse everything, and clearing a field must not silently stop all work.
 */
export function renderLimitForm(b) {
  const usd = (c) => (c == null ? '' : (c / 100).toFixed(2));
  return `<form class="acq-limit" id="budgetForm">
    <label class="field"><span>Weekly limit ($)</span>
      <input id="bgWeekly" inputmode="decimal" placeholder="no limit" value="${esc(usd(b.week?.limitCents))}" /></label>
    <label class="field"><span>Monthly limit ($)</span>
      <input id="bgMonthly" inputmode="decimal" placeholder="no limit" value="${esc(usd(b.month?.limitCents))}" /></label>
    <label class="field"><span>Held back for live replies (%)</span>
      <input id="bgReserve" inputmode="numeric" value="${esc(b.settings?.conversationReservePct ?? 20)}" /></label>
    <div class="acq-limit-actions">
      <button class="btn sm" type="submit">Save limit</button>
      <span class="faint">Blank means no limit. It is not the same as 0, which would refuse everything.</span>
    </div>
  </form>`;
}

/**
 * What this limit can and cannot stop.
 *
 * The honest half of a spending cap: refusing our own discretionary jobs is
 * entirely within our control; a provider's subscription or a charge already in
 * flight is not. Showing only the first would imply a ceiling that does not exist.
 */
export function renderPaidPaths(p, essential) {
  if (!p) return '';
  const row = (x) => `<li><b>${esc(x.what)}</b> <span class="faint">${esc(x.where)}</span></li>`;
  return `<details class="acq-paths">
    <summary>What this limit covers</summary>
    <div class="acq-paths-in">
      <h5>Stopped by this limit</h5>
      <ul>${(p.enforceable || []).map(row).join('') || '<li class="faint">none</li>'}</ul>
      ${p.ownCap?.length ? `<h5>Capped separately by the feature itself</h5><ul>${p.ownCap.map(row).join('')}</ul>` : ''}
      ${p.notConnected?.length ? `<h5>Not connected, so nothing can be spent</h5><ul>${p.notConnected.map(row).join('')}</ul>` : ''}
      ${essential ? `<h5>Keeps running even at zero</h5>
        <ul>${(essential.kinds || []).map((k) => `<li>${esc(String(k).replace(/_/g, ' '))}</li>`).join('')}</ul>
        <p class="note faint">${esc(essential.note || '')}</p>` : ''}
      <p class="note faint">${esc(p.note || '')}</p>
    </div>
  </details>`;
}

/** The limits that really do refuse work — and the one that only warns. */
export function renderActiveCaps(caps) {
  if (!caps?.length) return '';
  return `<div class="acq-caps">
    <h4 class="acq-h4">Limits that are actually applied</h4>
    <ul class="acq-caps-list">${caps.map((c) => `<li class="${c.refuses ? 'cap-hard' : 'cap-soft'}">
      <b>${esc(c.what)}</b> — ${esc(c.limit)}
      <span class="tag">${c.refuses ? 'stops work' : 'warns only'}</span>
      <div class="faint">${esc(c.note || '')} <span class="faint">(${esc(c.where || '')})</span></div>
    </li>`).join('')}</ul>
  </div>`;
}

/** "in 3 days" reads better than an ISO string, but keep the date too. */
export function resetWords(iso, now = Date.now()) {
  const t = Date.parse(iso || '');
  if (Number.isNaN(t)) return 'unknown';
  const mins = Math.round((t - now) / 60000);
  if (mins <= 0) return 'now';
  if (mins < 60) return `in ${mins} min`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `in ${hrs} hour${hrs === 1 ? '' : 's'}`;
  return `in ${Math.round(hrs / 24)} days`;
}

export function renderReadiness(r, error = '') {
  // R2.5 — a readiness check that failed used to sit on "Checking…" forever,
  // which is a spinner claiming work is in progress when nothing is happening.
  // It matters more here than elsewhere: this panel is the one that says
  // whether outreach can send.
  if (error) {
    return `<div class="note neg"><b>Could not check whether sending is possible.</b> ${esc(error)}
      <br />Treat this as unknown, not as ready — nothing is being sent either way, because sending
      is refused server-side unless every check passes.
      <button class="btn sm ghost" data-retry="readiness">Try again</button></div>`;
  }
  if (!r) return '<div class="loading">Checking…</div>';
  const pill = r.ready
    ? '<span class="pill sm">ready</span>'
    : r.connected
      ? '<span class="pill warn sm">connected, not activated</span>'
      : '<span class="pill neg sm">not connected</span>';
  return `<div class="note">Email provider: <b>${esc(r.provider)}</b> ${pill}</div>
    ${r.blockers.length
      ? `<ul class="acq-blockers">${r.blockers.map((b) => `<li>${esc(b.text)}</li>`).join('')}</ul>
         <div class="note"><b>Outreach cannot send while anything above is outstanding.</b> Every one of these is yours to decide — none of it is a bug.</div>`
      : '<div class="note">All checks pass. Sending is live.</div>'}`;
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

export function renderShell(activeTab) {
  return `<div class="section-h"><h2>Acquisition</h2></div>
    <nav class="dtabs acq-tabs" id="acqTabs">
      ${TABS.map((t) => `<button data-acq="${t.id}" class="${t.id === activeTab ? 'on' : ''}">${t.label}</button>`).join('')}
    </nav>
    <div id="acqBody"></div>`;
}

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------

export function renderCampaigns(state) {
  const list = state.campaigns || [];
  const stc = panelState(state, 'campaigns', list);
  if (stc.status === PANEL.LOADING || stc.status === PANEL.ERROR || stc.status === PANEL.LOCKED) {
    return renderPanel(stc, { thing: 'campaigns', retryKey: 'campaigns' });
  }
  const r = state.readiness;

  // The sending state belongs at the top of this screen, not buried in
  // settings: whether anything can actually go out is the first thing an
  // operator needs to know before building a campaign.
  // R2.5 — the worst state this screen could be in. When the readiness check
  // has not answered, `r` is undefined, and this used to fall through to
  // "Sending is live." — a false all-clear on the most consequential sentence
  // in the app. Unknown is now its own answer.
  const gate = !r
    ? `<div class="note warn" style="line-height:1.7"><b>Whether anything can be sent is not known right now</b> —
         the readiness check has not answered. This is not a green light.
         Nothing goes out regardless: sending is refused server-side unless every check passes.
         <button class="btn sm ghost" data-retry="readiness">Check again</button></div>`
    : !r.ready
      ? `<div class="note warn" style="line-height:1.7"><b>Nothing can be sent yet.</b>
         ${r.blockers.map((b) => esc(b.text)).join(' ')}
         <br />You can still build and preview campaigns — composing is safe, sending is what is gated.</div>`
      : '<div class="note">Sending is live.</div>';

  const preview = state.campaignPreview;
  const previewBlock = !preview
    ? ''
    : preview.ok === false || preview.message?.ok === false
      ? `<div class="acq-panel"><h3>Preview</h3><div class="note warn">No message can be written for this prospect: ${esc(preview.message?.reason || preview.error)}</div>
         <p class="note faint">That is the system working. A business with a verified website gives us no honest observation to open with.</p></div>`
      : `<div class="acq-panel"><h3>Preview — the exact words</h3>
         <div class="note">Subject: <b>${esc(preview.message.subject)}</b></div>
         <pre class="acq-pre">${esc(preview.message.body)}</pre>
         <p class="note faint">
           ${preview.message.mentionsPrice ? 'Quotes your price. ' : 'No price quoted — pricing is not set. '}
           ${preview.message.mentionsPreview ? 'Mentions a preview that exists.' : 'No preview mentioned.'}
         </p></div>`;

  const rows = list.length
    ? `<table class="acq-table"><thead><tr><th>Campaign</th><th>Type</th><th>Cadence</th><th>Status</th><th></th></tr></thead><tbody>
       ${list
         .map(
           (c) => `<tr>
           <td>${esc(c.name)}</td>
           <td>${esc(CAMPAIGN_TYPE_LABEL[c.type] || c.type)}</td>
           <td>intro + ${c.cadence.followUps}, ${c.cadence.gapDays}d apart</td>
           <td><span class="pill sm ${c.status === 'running' ? '' : 'warn'}">${esc(c.status)}</span></td>
           <td><button class="btn sm ghost" data-camp="${esc(c.id)}" data-act="${c.status === 'running' ? 'paused' : 'running'}">
             ${c.status === 'running' ? 'Pause' : 'Start'}</button></td>
         </tr>`
         )
         .join('')}</tbody></table>`
    : `<div class="note"><b>No campaigns yet.</b> A campaign is a message plus a cadence, pointed at a
         group of prospects. Creating one sends nothing — campaigns start as drafts.</div>`;

  return `${gate}
    <div class="acq-panel">
      <h3>Create a campaign</h3>
      <div class="acq-grid">
        <label>Name<input id="cp_name" placeholder="DFW flooring — no site found" /></label>
        <label>Type<select id="cp_type">
          ${Object.entries(CAMPAIGN_TYPE_LABEL).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}
        </select></label>
        <label>Days between messages<input id="cp_gap" value="4" /></label>
        <label>Follow-ups<input id="cp_follow" value="2" /></label>
      </div>
      <p class="note faint">Follow-ups are capped at 2 (1 for warm) and the gap at 2–30 days. Anything outside that is clamped and the change is reported back to you.</p>
      <div class="btn-row"><button class="btn" id="cp_create">Create as draft</button></div>
    </div>
    ${rows}
    ${previewBlock}`;
}

// ---------------------------------------------------------------------------
// Replies (R7.7)
// ---------------------------------------------------------------------------

const DRAFT_STATUS_LABEL = Object.freeze({
  'awaiting-review': 'draft ready for you',
  'needs-a-person': 'needs you to write it',
  withheld: 'draft withheld',
  'no-reply-appropriate': 'no reply needed',
  sent: 'sent',
});

export function renderInbox(state) {
  const rows = state.replies || [];
  const sti = panelState(state, 'inbox', rows);
  if (sti.status === PANEL.LOADING || sti.status === PANEL.ERROR || sti.status === PANEL.LOCKED) {
    return renderPanel(sti, { thing: 'replies', retryKey: 'inbox' });
  }
  const mode = state.replyMode || 'draft-only';

  const modeBar = `<div class="note ${mode === 'automatic' ? 'warn' : ''}" style="line-height:1.7">
      Reply mode: <b>${esc(mode)}</b>.
      ${mode === 'draft-only'
        ? 'Nothing is sent until you press send on a draft. This is the default.'
        : '<b>Replies can go out without you reading them first.</b> Every guard still applies — approved answers only, loop brakes, and the claims check.'}
      <button class="btn sm ghost" id="rp_mode" data-mode="${mode === 'automatic' ? 'draft-only' : 'automatic'}">
        Switch to ${mode === 'automatic' ? 'draft-only' : 'automatic'}</button>
    </div>`;

  if (!rows.length) {
    return `${modeBar}${renderPanel(sti, {
      thing: 'replies',
      empty: `<b>No replies yet.</b> This fills as people answer. A reply
        pauses that contact's follow-ups the moment it arrives, before anything else happens.`,
    })}`;
  }

  const attention = rows.filter((r) => !r.handled && NEEDS_ATTENTION.has(r.kind));
  const head = attention.length
    ? `<div class="note warn"><b>${attention.length} reply(ies) worth your time</b> — ${attention.map((r) => esc(KIND_LABEL[r.kind] || r.kind)).join(', ')}.</div>`
    : '<div class="note">Nothing needs you right now.</div>';

  const body = rows
    .map((r) => {
      const d = r.draft || {};
      const statusPill = r.handled
        ? '<span class="pill sm">handled</span>'
        : `<span class="pill sm ${NEEDS_ATTENTION.has(r.kind) ? 'warn' : ''}">${esc(KIND_LABEL[r.kind] || r.kind)}</span>`;
      const draftBlock = d.body
        ? `<div class="acq-draft"><div class="faint">${esc(DRAFT_STATUS_LABEL[d.status] || d.status)}${d.brake ? ` — held by the ${esc(d.brake)} brake` : ''}</div>
             <pre class="acq-pre">${esc(d.body)}</pre>
             ${d.respectedInformationFirst ? '<div class="faint">They asked for information first, so no booking link was offered.</div>' : ''}
             ${d.status === 'sent' ? `<div class="faint">Sent${d.approvedBy ? ` — approved by ${esc(d.approvedBy)}` : ''}.</div>`
               : `<div class="btn-row"><button class="btn sm" data-send="${esc(r.id)}">Send this</button>
                  <button class="btn sm ghost" data-takeover="${esc(r.contactId)}">I'll handle it</button></div>`}
           </div>`
        : `<div class="acq-draft"><div class="faint">${esc(DRAFT_STATUS_LABEL[d.status] || 'no draft')}${d.reason ? ` — ${esc(d.reason)}` : ''}</div>
             ${(d.withheldBecause || []).length ? `<div class="note warn">Withheld because the draft ${(d.withheldBecause || []).map(esc).join(', ')}.</div>` : ''}
             <div class="btn-row"><button class="btn sm ghost" data-takeover="${esc(r.contactId)}">I'll handle it</button></div>
           </div>`;

      return `<div class="acq-card">
        <div class="acq-card-h"><b>${esc(r.fromName || r.contactId)}</b> ${statusPill}
          <span class="faint" style="margin-left:auto">${new Date(r.at).toLocaleString()}</span></div>
        <pre class="acq-pre quoted">${esc(String(r.text || '').slice(0, 600))}</pre>
        ${draftBlock}
      </div>`;
    })
    .join('');

  return `${modeBar}${head}${body}`;
}

export function renderBody(tab, state) {
  if (tab === 'inbox') return renderInbox(state);
  if (tab === 'contacts') return renderContacts(state);
  if (tab === 'intake') return renderIntake(state);
  if (tab === 'prospects') return renderProspects(state);
  if (tab === 'campaigns') return renderCampaigns(state);
  if (tab === 'bookings') return renderBookings(state);
  if (tab === 'settings') return renderAcqSettings(state);
  return '<div class="note">Unknown tab.</div>';
}


// ---------------------------------------------------------------------------
// Bookings (R2.8 — "View bookings" needed somewhere to go)
//
// lib/bookings.js has existed, tested, since it was written, with no screen.
// The rule it enforces is the one this screen has to keep visible: a click on
// a booking link is NOT a booking. Clicks are counted separately and are never
// added in. A dashboard that blurs the two turns interest into revenue on
// paper, which is the single most tempting lie an acquisition tool can tell.
// ---------------------------------------------------------------------------

export const BOOKING_STATUS_LABEL = Object.freeze({
  scheduled: 'booked',
  cancelled: 'cancelled',
  rescheduled: 'moved',
  attended: 'attended',
  'no-show': 'did not show',
});

export const BOOKING_SOURCE_LABEL = Object.freeze({
  'verified-webhook': 'confirmed by the scheduler',
  'owner-recorded': 'entered by you',
});

export function renderBookings(state) {
  const rows = state.bookings || [];
  const st = panelState(state, 'bookings', rows);
  if (st.status === PANEL.LOADING || st.status === PANEL.ERROR || st.status === PANEL.LOCKED) {
    return renderPanel(st, { thing: 'bookings', retryKey: 'bookings' });
  }

  const s = state.bookingStats;
  const summary = s
    ? `<div class="acq-stats">
        <span class="pill sm">${s.verifiedBookings} verified</span>
        <span class="pill sm">${s.scheduled} booked</span>
        <span class="pill sm">${s.attended} attended</span>
        <span class="pill sm">${s.noShow} no-show</span>
        <span class="pill sm">${s.cancelled} cancelled</span>
      </div>
      <p class="note">${esc(s.note || '')}</p>`
    : '<p class="note">The counts have not loaded, so none are shown. This is not a report of zero bookings.</p>';

  if (!rows.length) {
    return `${summary}${renderPanel({ status: PANEL.EMPTY }, {
      thing: 'bookings',
      empty: `<b>No bookings yet.</b> One appears here when the scheduler confirms it by webhook,
        or when you record one you took yourself. A click on a booking link does
        <b>not</b> create one — clicks are counted separately and are never added in.`,
    })}`;
  }

  const body = rows
    .map((b) => {
      const when = b.startAt ? new Date(b.startAt) : null;
      const ok = !Number.isNaN(when?.getTime?.());
      return `<tr>
        <td>${ok && when ? esc(when.toLocaleString()) : '<span class="faint">time not given</span>'}</td>
        <td>${esc(b.inviteeEmail || '—')}</td>
        <td><span class="pill sm ${b.status === 'cancelled' || b.status === 'no-show' ? 'warn' : ''}">${esc(BOOKING_STATUS_LABEL[b.status] || b.status)}</span></td>
        <td>${b.verified ? esc(BOOKING_SOURCE_LABEL[b.source] || b.source) : '<span class="pill warn sm">not verified</span>'}</td>
        <td>${b.attribution?.campaignId ? esc(b.attribution.campaignId) : '<span class="faint">not attributed</span>'}</td>
      </tr>`;
    })
    .join('');

  return `${summary}
    <table class="acq-table">
      <thead><tr><th>When</th><th>Who</th><th>Status</th><th>How we know</th><th>Campaign</th></tr></thead>
      <tbody>${body}</tbody>
    </table>
    <p class="note faint">"Not attributed" means the booking is real but could not be tied to a campaign.
      It is shown as unknown rather than assigned to the most likely one.</p>`;
}

// ---------------------------------------------------------------------------
// Integrations (R2.9 — a key existing is not a connection)
//
// Every integration used to be reported from one fact: is the environment
// variable set? A key can be present and wrong — revoked, mistyped, pointed at
// the wrong account, out of credit — and the dashboard would still show it as
// connected. That is an invented integration.
//
// The middle state is the one that was missing and the one that matters:
// "set up, never confirmed". It is not a failure and it is not a tick.
// ---------------------------------------------------------------------------

export const INTEGRATION_TONE = Object.freeze({
  'not-configured': 'faint',
  configured: 'warn',
  working: 'good',
  failing: 'neg',
});

export function renderIntegrations(list, error = '') {
  if (error) {
    return `<div class="note neg"><b>Could not read the integration status.</b> ${esc(error)}
      <br />Treat every one of them as unknown — this is not a report that they are working.
      <button class="btn sm ghost" data-retry="integrations">Try again</button></div>`;
  }
  if (!list) return '<div class="loading">Checking what is actually connected…</div>';
  if (!list.length) return '<div class="note">No integrations are defined.</div>';

  const rows = list
    .map((i) => {
      const tone = INTEGRATION_TONE[i.state] || 'warn';
      return `<div class="auto-row tone-${esc(tone === 'faint' ? '' : tone)}">
        <div class="auto-h">
          <b>${esc(i.label)}</b>
          <span class="pill sm ${esc(tone === 'good' ? '' : tone)}">${esc(stateWords(i.state))}</span>
        </div>
        <div class="auto-t">${esc(i.evidence || '')}</div>
        <div class="faint">${esc(i.what || '')}</div>
      </div>`;
    })
    .join('');

  const unproven = list.filter((i) => i.state === 'configured').length;
  const head = unproven
    ? `<div class="note warn"><b>${unproven} integration${unproven === 1 ? ' has' : 's have'} a credential but no proof.</b>
         A key can be set and still be wrong. None of them is shown as working until a real call succeeds.</div>`
    : '<div class="note">Each line below is what the last real call to that service proved, not what is configured.</div>';

  return `${head}${rows}`;
}

function stateWords(state) {
  return {
    'not-configured': 'not set up',
    configured: 'set up, never confirmed',
    working: 'confirmed working',
    failing: 'failing',
  }[state] || 'unknown';
}

// ---------------------------------------------------------------------------
// SMS (R6.11 — built, deliberately disconnected)
//
// The point of showing a disconnected integration at all is that "we have not
// built it" and "we built it and chose not to switch it on" are different
// facts, and only one of them is true here. The panel shows exactly what would
// have to become true, and who can make each one true, so connecting it later
// is supplying facts rather than rediscovering the requirements.
// ---------------------------------------------------------------------------

export function renderSms(state) {
  const s = state.sms;
  if (state.smsError) {
    return `<div class="note neg"><b>Could not read the SMS status.</b> ${esc(state.smsError)}
      <br />Treat it as unknown. Nothing is being texted either way — the send path refuses server-side.
      <button class="btn sm ghost" data-retry="sms">Try again</button></div>`;
  }
  if (!s) return '<div class="loading">Checking the SMS status…</div>';

  const reg = s.registration || { state: 'not-started', supplied: 0, total: 0, missing: [] };
  const rows = (reg.missing || [])
    .map(
      (m) => `<tr>
        <td>${esc(m.label)}</td>
        <td><span class="pill sm ${m.who === 'owner' ? 'warn' : ''}">${esc(m.who === 'owner' ? 'you' : 'built here')}</span></td>
        <td class="faint">${esc(m.what)}</td>
      </tr>`
    )
    .join('');

  return `
    <div class="note warn"><b>Text messaging is built and switched off.</b>
      ${esc(s.displayStatus || '')}. Nothing has ever been sent through it, and nothing in the dashboard can turn it on —
      the send path refuses on the server.</div>

    <div class="note">Why it is off, in order: the owner decided SMS stays off this round; US carriers require
      <b>A2P 10DLC registration</b> before a business may text from a normal number, and unregistered traffic is
      <b>filtered by the carriers</b>, not merely discouraged; and the registration's opt-in description is a sworn
      statement about consent that must actually be held.</div>

    <div class="note"><b>Registration: ${esc(reg.state)}</b> — ${reg.supplied}/${reg.total} facts supplied.</div>
    ${rows
      ? `<table class="acq-table"><thead><tr><th>Still needed</th><th>Who</th><th>What it means</th></tr></thead><tbody>${rows}</tbody></table>`
      : '<div class="note">Every registration fact has been supplied. Approval is still the carriers\' decision.</div>'}

    ${(s.blockers || []).length
      ? `<ul class="acq-blockers">${s.blockers.map((b) => `<li>${esc(b.text)}</li>`).join('')}</ul>`
      : ''}

    <p class="note faint">Costs to expect when it is connected: a one-time brand registration fee, a per-campaign
      vetting fee, a monthly campaign fee, per-segment message pricing and carrier fees on top. These are the
      provider's published figures and must be re-checked before registering — this dashboard cannot verify a price.</p>`;
}
