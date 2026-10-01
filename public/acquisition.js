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

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const val = (f) => (f && typeof f === 'object' && 'value' in f ? f.value : f);

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
  if (state.loading) return '<div class="loading">Loading contacts…</div>';
  if (!rows.length) {
    return `<div class="note" style="line-height:1.7">
      <b>No contacts yet.</b> This list fills from the <b>Add contacts</b> tab — scan business cards,
      import a CSV, or add someone by hand. Nothing is imported automatically.
    </div>`;
  }
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
    <input type="file" id="acqCardFiles" accept="image/*" multiple />
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
  if (state.loading) return '<div class="loading">Loading prospects…</div>';

  const head = `<div class="note" style="line-height:1.7">
    Discovery reads <b>OpenStreetMap</b> and checks whether each business has a working website.
    It stores prospects only — <b>it never contacts anyone</b>.
    ${state.targetingStatus === 'draft' ? '<br /><b>Targeting is still a draft</b> (DFW service businesses). Confirm it under Targeting &amp; pricing before treating results as a real list.' : ''}
  </div>
  <div class="btn-row"><button class="btn" id="acqDiscoverBtn">Find businesses</button>
    <span class="faint" id="acqDiscoverNote"></span></div>`;

  if (!rows.length) {
    return `${head}<div class="note"><b>Nothing searched yet.</b> This is empty because discovery has
      not run, which is not the same as there being no businesses to find.</div>`;
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
        <td><input type="checkbox" class="pr_pick" value="${esc(p.id)}" ${p.email ? '' : 'disabled title="No email on the listing"'} /></td>
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
  if (!s) return '<div class="loading">Loading settings…</div>';
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
    ${renderReadiness(state.readiness)}
  </div>`;
}

export function renderReadiness(r) {
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
  if (state.loading) return '<div class="loading">Loading campaigns…</div>';
  const list = state.campaigns || [];
  const r = state.readiness;

  // The sending state belongs at the top of this screen, not buried in
  // settings: whether anything can actually go out is the first thing an
  // operator needs to know before building a campaign.
  const gate = r && !r.ready
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
  if (state.loading) return '<div class="loading">Loading replies…</div>';
  const rows = state.replies || [];
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
    return `${modeBar}<div class="note"><b>No replies yet.</b> This fills as people answer. A reply
      pauses that contact's follow-ups the moment it arrives, before anything else happens.</div>`;
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
  if (tab === 'settings') return renderAcqSettings(state);
  return '<div class="note">Unknown tab.</div>';
}
