// R2.1 — task-based top-level navigation.
//
// The dashboard was one flat page: a portfolio overview, a list of sites, and
// a few panels toggled by header buttons. Nothing told you where you were, and
// there was no place to put the acquisition system at all.
//
// The five sections are the ones the owner specified:
//   Overview · Clients · Acquisition · Automations · Settings
//
// Routing rules, all deliberate:
//   * the view is in the URL hash, so a view can be linked and survives reload
//   * an unknown or missing hash resolves to Overview rather than a blank page
//   * a view that exists in the markup but has nothing in it yet says so
//     plainly (R2.9: an unbuilt section must never look like an empty success)
//
// Kept as a separate module so the routing is testable without a browser —
// `resolveView` is pure, and the DOM wiring is the only part that needs one.

// `short` is the label on the phone tab bar, where six full words do not fit
// in 360px without either truncating or shrinking below a readable size. The
// icon is a simple stroke glyph — enough to tell the tabs apart at a glance
// without the label having to carry it alone.
export const VIEWS = Object.freeze([
  { id: 'overview', label: 'Overview', short: 'Today', icon: 'M3 11l9-8 9 8M5 10v10h14V10', hint: 'What needs attention today' },
  { id: 'clients', label: 'Clients', short: 'Clients', icon: 'M16 20v-2a4 4 0 00-8 0v2M12 11a3.5 3.5 0 100-7 3.5 3.5 0 000 7', hint: 'Each client, their analytics, sites and revisions' },
  { id: 'acquisition', label: 'Acquisition', short: 'Growth', icon: 'M4 19V5M4 19h16M8 16V9M12 16v-5M16 16v-9', hint: 'Prospecting, contacts, campaigns, conversations, bookings' },
  // People you have actually met, what you promised them, and the conversation
  // you are having. Deliberately separate from Acquisition: the whole point of
  // the relationship work is that these are not cold prospects.
  { id: 'followups', label: 'Follow-ups', short: 'People', icon: 'M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z', hint: 'What you promised people you met, previews owed, and conversations' },
  { id: 'automations', label: 'Automations', short: 'Health', icon: 'M22 12h-4l-3 9L9 3l-3 9H2', hint: 'What is running, what is paused, what is blocked' },
  { id: 'settings', label: 'Settings', short: 'Settings', icon: 'M12 15a3 3 0 100-6 3 3 0 000 6M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 008 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06A1.65 1.65 0 003.6 15a1.65 1.65 0 00-1.51-1H2a2 2 0 110-4h.09A1.65 1.65 0 003.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06A1.65 1.65 0 018 4.6a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06A1.65 1.65 0 0020.4 9c.14.35.38.65.69.86', hint: 'Business settings, integrations, budgets' },
]);

export const DEFAULT_VIEW = 'overview';

const ids = new Set(VIEWS.map((v) => v.id));

/**
 * Decide which view a hash refers to. Pure.
 *
 * Accepts '#clients', 'clients', '#/clients', '#clients?x=1', with any case,
 * because all four forms turn up in links people actually write. Anything it
 * does not recognise resolves to Overview — a wrong hash must never leave the
 * page empty.
 */
export function resolveView(hash, { available = ids } = {}) {
  const raw = String(hash ?? '')
    .replace(/^#/, '')
    .replace(/^\/+/, '')
    .split(/[?&]/)[0]
    .trim()
    .toLowerCase();
  if (!raw) return DEFAULT_VIEW;
  const has = available instanceof Set ? (x) => available.has(x) : (x) => available.includes(x);
  if (has(raw)) return raw;
  return DEFAULT_VIEW;
}

/** The hash to write for a view. Overview gets a clean URL, not '#overview'. */
export function hashFor(view) {
  return view === DEFAULT_VIEW ? '' : '#' + view;
}

/**
 * Which view should own an element, given the ids that already exist in the
 * page. Used once, to move the existing panels into the new sections instead
 * of rebuilding them.
 */
export const VIEW_OF_ELEMENT = Object.freeze({
  attention: 'overview',
  overview: 'overview',
  sysHealth: 'overview',
  'section-h-sites': 'clients',
  sites: 'clients',
  footNote: 'clients',
  revWidget: 'automations',
  seoOverview: 'automations',
  finPanel: 'settings',
});

/**
 * Build the nav, move existing panels into their section, and route.
 * Returns a `go(view)` function so the rest of the page can navigate.
 */
export function initNav(doc = document, { onChange = null } = {}) {
  const host = doc.getElementById('mainNav');
  if (!host) return null;

  host.innerHTML = VIEWS.map(
    (v) =>
      `<button type="button" class="navbtn" data-view="${v.id}" title="${v.hint}" aria-current="false">${v.label}</button>`
  ).join('');

  // The phone tab bar. Built from the SAME VIEWS list and updated by the SAME
  // render() as the top nav, so the two cannot drift apart — a second
  // navigation with its own state is how "the tab says Clients and the page
  // shows Settings" happens. The top nav is hidden by CSS at phone widths and
  // this takes over; neither is duplicated content, it is one nav in two
  // presentations.
  // This module is deliberately runnable against a minimal document stub so
  // the routing can be tested without a browser — so creating the bar has to
  // be optional, not assumed. If there is nothing to create it in, routing
  // still works and the bar is simply absent.
  let bar = doc.getElementById?.('tabBar') || null;
  if (!bar && typeof doc.createElement === 'function' && doc.body?.appendChild) {
    bar = doc.createElement('nav');
    bar.id = 'tabBar';
    bar.className = 'tabbar';
    bar.setAttribute('aria-label', 'Sections');
    doc.body.appendChild(bar);
  }
  // a no-op stand-in keeps the render and click paths below branch-free
  if (!bar) bar = { innerHTML: '', querySelectorAll: () => [], addEventListener: () => {} };
  bar.innerHTML = VIEWS.map(
    (v) =>
      `<button type="button" class="tabbtn" data-view="${v.id}" aria-current="false">` +
      `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${v.icon}"/></svg>` +
      `<span>${v.short || v.label}</span></button>`
  ).join('');

  const sections = {};
  for (const v of VIEWS) sections[v.id] = doc.getElementById('view-' + v.id);

  const render = (view) => {
    for (const v of VIEWS) {
      const el = sections[v.id];
      if (el) el.hidden = v.id !== view;
    }
    for (const b of [...host.querySelectorAll('.navbtn'), ...bar.querySelectorAll('.tabbtn')]) {
      const on = b.dataset.view === view;
      b.classList.toggle('on', on);
      b.setAttribute('aria-current', on ? 'page' : 'false');
    }
    if (onChange) onChange(view);
  };

  const go = (view) => {
    const v = resolveView(view);
    const want = hashFor(v);
    if ((doc.location?.hash || '') !== want) {
      try {
        doc.defaultView.history.replaceState(null, '', want || doc.location.pathname);
      } catch {
        /* navigating without history is still fine */
      }
    }
    render(v);
    return v;
  };

  host.addEventListener('click', (e) => {
    const b = e.target.closest?.('.navbtn');
    if (b) go(b.dataset.view);
  });
  bar.addEventListener('click', (e) => {
    const b = e.target.closest?.('.tabbtn');
    if (!b) return;
    go(b.dataset.view);
    // changing section on a phone should start at the top of that section,
    // not halfway down wherever the last one was scrolled to
    try { doc.defaultView?.scrollTo({ top: 0, behavior: 'instant' }); } catch { /* older browsers */ }
  });
  doc.defaultView?.addEventListener?.('hashchange', () => render(resolveView(doc.location.hash)));

  render(resolveView(doc.location?.hash));
  return go;
}
