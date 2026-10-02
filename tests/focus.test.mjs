// R2.7 — keyboard containment.
//
// Measured in a real browser before this existed: 7 of 12 Tab presses from
// inside the open client drawer landed on controls BEHIND the scrim —
// invisible, unreachable by mouse, still focusable. A keyboard user was
// operating a page they could not see.
import { check, section, done } from './world.mjs';
import { focusableIn, nextFocus, handleModalTab, restoreFocus, FOCUSABLE } from '../public/focus.js';

/** The smallest DOM that can answer these questions honestly. */
function el(tag, props = {}) {
  const e = {
    tagName: tag.toUpperCase(),
    focused: 0,
    disabled: false,
    hidden: false,
    offsetParent: {},
    isConnected: true,
    focus() { this.focused++; LAST = this; },
    closest(sel) { return sel === '[hidden]' && this.hidden ? this : null; },
    ...props,
  };
  return e;
}
let LAST = null;
function modal(items, { open = true } = {}) {
  return {
    _items: items,
    querySelectorAll: () => items,
    contains: (x) => items.includes(x),
    classList: { contains: () => open },
  };
}
const tab = (shiftKey = false) => { let prevented = false; return { key: 'Tab', shiftKey, preventDefault() { prevented = true; }, get prevented() { return prevented; } }; };

// ---------------------------------------------------------------------------
section('F1  which elements count as focusable');
const a = el('button'), b = el('input'), c = el('button', { disabled: true }), d = el('a', { hidden: true }), e2 = el('select', { offsetParent: null });
let items = focusableIn(modal([a, b, c, d, e2]));
check('a disabled control is skipped', !items.includes(c), String(items.length));
check('a control in a hidden section is skipped', !items.includes(d));
check('an invisible control is skipped', !items.includes(e2));
check('the real ones are kept, in order', items[0] === a && items[1] === b && items.length === 2);
check('a missing container yields nothing rather than throwing', focusableIn(null).length === 0);
check('the selector covers the controls a dashboard actually uses',
  ['a[href]', 'button', 'input', 'select', 'textarea', '[tabindex]'].every((s) => FOCUSABLE.includes(s)), FOCUSABLE);

// ---------------------------------------------------------------------------
section('F2  Tab cycles inside the modal instead of walking out behind it');
const one = el('button'), two = el('input'), three = el('button');
const list = [one, two, three];
check('from the last item, Tab wraps to the first', nextFocus({ items: list, active: three, insideModal: true }) === one);
check('from the first, Shift+Tab wraps to the last', nextFocus({ items: list, active: one, shiftKey: true, insideModal: true }) === three);
check('in the middle the browser is left alone', nextFocus({ items: list, active: two, insideModal: true }) === null);
check('Shift+Tab in the middle is also left alone', nextFocus({ items: list, active: two, shiftKey: true, insideModal: true }) === null);
// the measured defect: focus is outside the modal entirely
check('focus that escaped is pulled back to the first item', nextFocus({ items: list, active: null, insideModal: false }) === one);
check('and to the last item when shift-tabbing back in', nextFocus({ items: list, active: null, shiftKey: true, insideModal: false }) === three);
check('an empty modal asks for nothing', nextFocus({ items: [], active: null, insideModal: false }) === null);
check('a single-item modal keeps focus on that item', nextFocus({ items: [one], active: one, insideModal: true }) === one);

// ---------------------------------------------------------------------------
section('F3  the handler only intervenes when it should');
const m = modal(list);
let ev = tab();
let r = handleModalTab(ev, m, { isOpen: true, activeElement: three });
check('at the edge it takes over', r.handled === true);
check('it stops the browser leaving', ev.prevented === true);
check('and moves focus to the first item', r.moved === one && one.focused === 1);

ev = tab();
r = handleModalTab(ev, m, { isOpen: true, activeElement: two });
check('mid-list it does nothing', r.handled === false, JSON.stringify(r));
check('and does not block the browser', ev.prevented === false);

ev = tab();
r = handleModalTab(ev, m, { isOpen: false, activeElement: two });
check('a closed modal is not trapped', r.handled === false && /not open/.test(r.why));

ev = { key: 'a', preventDefault() {} };
check('a key that is not Tab is ignored', handleModalTab(ev, m, { isOpen: true, activeElement: two }).handled === false);

check('a modal with nothing focusable does not trap the user', handleModalTab(tab(), modal([]), { isOpen: true, activeElement: null }).handled === false);

// the exact measured failure, end to end
const outsider = el('button'); // a control behind the scrim
ev = tab();
r = handleModalTab(ev, m, { isOpen: true, activeElement: outsider });
check('focus sitting behind the scrim is brought back in', r.handled === true && r.moved === one);
check('and the control behind it is never focused', outsider.focused === 0);

// ---------------------------------------------------------------------------
section('F4  closing hands the keyboard back');
const opener = el('div');
check('the opener is refocused', restoreFocus(opener, { contains: () => true }).restored === true && opener.focused === 1);
check('no opener is not an error', restoreFocus(null).restored === false);
// the list behind the drawer is re-rendered while it is open, so the opener can
// be a detached node by the time it closes — focusing that silently does
// nothing and drops the user at the top of the page
const stale = el('div');
r = restoreFocus(stale, { contains: () => false });
check('a detached opener is not focused', r.restored === false && stale.focused === 0);
check('and the reason says so', /gone from the page/.test(r.why), r.why);
const throws = el('div', { focus() { throw new Error('detached'); } });
check('an opener that throws does not break closing', restoreFocus(throws, { contains: () => true }).restored === false);

done();
