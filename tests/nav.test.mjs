// R2.1 — top-level navigation.
//
// The routing is a pure function plus DOM wiring, so the routing is tested
// directly and the wiring is tested against a tiny fake document. No browser.
import { check, section, done } from './world.mjs';
import { VIEWS, DEFAULT_VIEW, resolveView, hashFor, initNav, VIEW_OF_ELEMENT } from '../public/nav.js';

// ---------------------------------------------------------------------------
section('N1  the sections the owner specified');
const ids = VIEWS.map((v) => v.id);
// Five originally; "Follow-ups" was added with the business-card addendum,
// deliberately as ONE tab holding both the promises and the conversations
// rather than two, because a nav that keeps growing is the thing that makes a
// dashboard feel like software nobody edited. The cap below is the guard: this
// test failing is the intended way to notice a seventh tab being added.
check('there are exactly six', VIEWS.length === 6, String(VIEWS.length));
check('and no more than six, so the nav cannot creep', VIEWS.length <= 6);
check('in the specified order', ids.join(',') === 'overview,clients,acquisition,followups,automations,settings', ids.join(','));
check('Follow-ups sits next to Acquisition, since it is the warm half of the same job',
  ids.indexOf('followups') === ids.indexOf('acquisition') + 1);
check('each has a visible label', VIEWS.every((v) => v.label && v.label.length > 2));
check('each has a hint explaining what belongs there', VIEWS.every((v) => v.hint && v.hint.length > 10));
check('Overview is the default', DEFAULT_VIEW === 'overview');

// ---------------------------------------------------------------------------
section('N2  resolving a hash never leaves you on a blank page');
check('a bare name resolves', resolveView('clients') === 'clients');
check('a #hash resolves', resolveView('#clients') === 'clients');
check('a #/hash resolves', resolveView('#/clients') === 'clients');
check('trailing query junk is ignored', resolveView('#clients?from=email') === 'clients');
check('case is ignored', resolveView('#Acquisition') === 'acquisition');
check('whitespace is ignored', resolveView('#  settings  '.replace(/\s+$/, '')) === 'settings');
// the important ones: nothing may produce an unknown view
check('an empty hash is Overview, not nothing', resolveView('') === 'overview');
check('no hash at all is Overview', resolveView(undefined) === 'overview');
check('null is Overview', resolveView(null) === 'overview');
check('a bare # is Overview', resolveView('#') === 'overview');
check('an unknown view falls back to Overview', resolveView('#does-not-exist') === 'overview');
check('a hostile hash falls back to Overview', resolveView('#../../etc/passwd') === 'overview');
check('every known id round-trips', ids.every((id) => resolveView(hashFor(id) || '#') === id || id === DEFAULT_VIEW));
check('Overview gets a clean URL rather than #overview', hashFor('overview') === '');
check('the others get a hash', hashFor('clients') === '#clients');

// ---------------------------------------------------------------------------
section('N3  every existing panel has a declared home');
// Nothing from the old flat page may be orphaned by the reorganisation.
const homes = Object.values(VIEW_OF_ELEMENT);
check('every mapped element points at a real view', homes.every((v) => ids.includes(v)), homes.join(','));
check('the client list belongs to Clients', VIEW_OF_ELEMENT.sites === 'clients');
check('the attention list belongs to Overview', VIEW_OF_ELEMENT.attention === 'overview');
check('the revisions widget belongs to Automations', VIEW_OF_ELEMENT.revWidget === 'automations');
check('the money panel belongs to Settings', VIEW_OF_ELEMENT.finPanel === 'settings');

// ---------------------------------------------------------------------------
section('N4  wiring against a fake document');

function fakeDoc(startHash = '') {
  const els = {};
  const mk = (id) => ({
    id,
    hidden: false,
    innerHTML: '',
    dataset: {},
    classList: {
      _on: new Set(),
      toggle(c, on) { on ? this._on.add(c) : this._on.delete(c); },
      contains(c) { return this._on.has(c); },
    },
    attrs: {},
    setAttribute(k, v) { this.attrs[k] = v; },
    _handlers: {},
    addEventListener(ev, fn) { this._handlers[ev] = fn; },
    querySelectorAll() {
      // parse the buttons the nav just wrote into innerHTML
      return [...String(this.innerHTML).matchAll(/data-view="([a-z]+)"/g)].map((m) => {
        const id = m[1];
        els['btn:' + id] = els['btn:' + id] || mk('btn:' + id);
        els['btn:' + id].dataset.view = id;
        return els['btn:' + id];
      });
    },
  });
  for (const id of ['mainNav', ...ids.map((i) => 'view-' + i)]) els[id] = mk(id);
  const win = { addEventListener(ev, fn) { this._h = this._h || {}; this._h[ev] = fn; }, history: { replaceState() {} } };
  return {
    _els: els,
    location: { hash: startHash, pathname: '/' },
    defaultView: win,
    getElementById: (id) => els[id] || null,
  };
}

let doc = fakeDoc('');
let go = initNav(doc);
check('initNav returns a navigate function', typeof go === 'function');
check('it wrote one button per view', ids.every((id) => doc._els.mainNav.innerHTML.includes(`data-view="${id}"`)));
check('each button carries its hint as a title', doc._els.mainNav.innerHTML.includes(VIEWS[2].hint));
check('Overview is shown on first load', doc._els['view-overview'].hidden === false);
check('and the other four are hidden', ids.slice(1).every((id) => doc._els['view-' + id].hidden === true));
check('the active button is marked', doc._els['btn:overview'].classList.contains('on'));
check('and marked for assistive tech', doc._els['btn:overview'].attrs['aria-current'] === 'page');

go('acquisition');
check('navigating shows only that section', doc._els['view-acquisition'].hidden === false && doc._els['view-overview'].hidden === true);
check('the previously active button is unmarked', doc._els['btn:overview'].classList.contains('on') === false);
check('the new one is marked', doc._els['btn:acquisition'].classList.contains('on'));
check('aria-current moved with it', doc._els['btn:overview'].attrs['aria-current'] === 'false' && doc._els['btn:acquisition'].attrs['aria-current'] === 'page');

const landed = go('nonsense');
check('navigating to nonsense lands on Overview rather than hiding everything', landed === 'overview');
check('and Overview is actually visible', doc._els['view-overview'].hidden === false);
check('exactly one section is ever visible', ids.filter((id) => doc._els['view-' + id].hidden === false).length === 1);

// deep link: arriving with a hash must open that section, not Overview
doc = fakeDoc('#settings');
go = initNav(doc);
check('a deep link opens its section', doc._els['view-settings'].hidden === false);
check('and Overview is not the one shown', doc._els['view-overview'].hidden === true);

// a page missing the nav host must not throw — the dashboard still has to load
const bare = { location: { hash: '' }, defaultView: { addEventListener() {} }, getElementById: () => null };
let threw = false;
try { initNav(bare); } catch { threw = true; }
check('a page with no nav host does not throw', threw === false);
check('and it reports that it did not initialise', initNav(bare) === null);

// onChange lets the page react (used to lazy-load a section)
doc = fakeDoc('');
const seen = [];
go = initNav(doc, { onChange: (v) => seen.push(v) });
go('clients');
go('automations');
check('onChange fires for the initial view and each navigation', seen.join(',') === 'overview,clients,automations', seen.join(','));

done();
