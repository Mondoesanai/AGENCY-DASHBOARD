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

export const VIEWS = Object.freeze([
  { id: 'overview', label: 'Overview', hint: 'What needs attention today' },
  { id: 'clients', label: 'Clients', hint: 'Each client, their analytics, sites and revisions' },
  { id: 'acquisition', label: 'Acquisition', hint: 'Prospecting, contacts, campaigns, conversations, bookings' },
  // People you have actually met, what you promised them, and the conversation
  // you are having. Deliberately separate from Acquisition: the whole point of
  // the relationship work is that these are not cold prospects.
  { id: 'followups', label: 'Follow-ups', hint: 'What you promised people you met, previews owed, and conversations' },
  { id: 'automations', label: 'Automations', hint: 'What is running, what is paused, what is blocked' },
  { id: 'settings', label: 'Settings', hint: 'Business settings, integrations, budgets' },
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

  const sections = {};
  for (const v of VIEWS) sections[v.id] = doc.getElementById('view-' + v.id);

  const render = (view) => {
    for (const v of VIEWS) {
      const el = sections[v.id];
      if (el) el.hidden = v.id !== view;
    }
    host.querySelectorAll('.navbtn').forEach((b) => {
      const on = b.dataset.view === view;
      b.classList.toggle('on', on);
      b.setAttribute('aria-current', on ? 'page' : 'false');
    });
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
  doc.defaultView?.addEventListener?.('hashchange', () => render(resolveView(doc.location.hash)));

  render(resolveView(doc.location?.hash));
  return go;
}
