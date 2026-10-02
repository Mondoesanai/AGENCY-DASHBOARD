// R2.7 — keyboard containment for the things that cover the page.
//
// The client drawer is a modal: it draws a scrim over everything and sits on
// top. But Tab did not know that. Measured in a real browser before this
// existed, 7 of 12 Tab presses from inside the open drawer landed on controls
// *behind* the scrim — invisible, unreachable by mouse, and still focusable.
// A keyboard user ended up operating a page they could not see.
//
// The rule a modal has to keep is small: while it is open, Tab cycles within
// it, and when it closes the keyboard goes back to whatever opened it.
//
// This is a module rather than four lines inline so the cycling can be driven
// in a test without a browser — the browser audit then confirms the real thing.

export const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The focusable elements inside a container, in document order, skipping the
 * ones that are disabled or in a hidden section. `isVisible` is injected so a
 * test can describe visibility without a layout engine.
 */
export function focusableIn(root, { isVisible } = {}) {
  if (!root || typeof root.querySelectorAll !== 'function') return [];
  const vis = isVisible || ((el) => el.offsetParent !== null);
  return [...root.querySelectorAll(FOCUSABLE)].filter((el) => {
    if (el.disabled) return false;
    if (typeof el.closest === 'function' && el.closest('[hidden]')) return false;
    return vis(el);
  });
}

/**
 * Where a Tab press should land, given what is focused now.
 *
 * Returns null when the browser's own behaviour is already right — moving
 * between two controls inside the modal needs no interference, and intervening
 * on every press would break things like a select's own key handling.
 *
 * @param {object} o
 * @param {Array}  o.items     focusable elements inside the modal, in order
 * @param {*}      o.active    document.activeElement
 * @param {boolean} o.shiftKey
 * @param {boolean} o.insideModal  whether `active` is inside the modal
 */
export function nextFocus({ items, active, shiftKey = false, insideModal }) {
  if (!items || !items.length) return null;
  const first = items[0];
  const last = items[items.length - 1];

  // focus has escaped (or never entered): pull it back to the near edge
  if (!insideModal) return shiftKey ? last : first;

  // at an edge, going out: wrap to the other edge
  if (shiftKey && active === first) return last;
  if (!shiftKey && active === last) return first;

  // somewhere in the middle: leave the browser alone
  return null;
}

/**
 * The whole Tab handler for one modal. Returns what it did, so a test can
 * assert on the decision rather than on a side effect.
 */
export function handleModalTab(e, modal, opts = {}) {
  if (!e || e.key !== 'Tab') return { handled: false, why: 'not a tab' };
  if (!modal || !opts.isOpen) return { handled: false, why: 'modal not open' };

  const items = focusableIn(modal, opts);
  if (!items.length) return { handled: false, why: 'nothing focusable' };

  const active = opts.activeElement;
  const insideModal = !!(active && typeof modal.contains === 'function' && modal.contains(active));
  const target = nextFocus({ items, active, shiftKey: !!e.shiftKey, insideModal });
  if (!target) return { handled: false, why: 'browser default is correct', insideModal };

  if (typeof e.preventDefault === 'function') e.preventDefault();
  if (typeof target.focus === 'function') target.focus();
  return { handled: true, moved: target, insideModal };
}

/**
 * Hand the keyboard back to whatever opened the modal. Checks the element is
 * still in the document first: the list behind the drawer gets re-rendered
 * while it is open, and focusing a detached node silently does nothing, which
 * drops the user at the top of the page.
 */
export function restoreFocus(opener, { contains } = {}) {
  if (!opener || typeof opener.focus !== 'function') return { restored: false, why: 'no opener' };
  const inDoc = contains ? contains(opener) : (opener.isConnected !== false);
  if (!inDoc) return { restored: false, why: 'opener is gone from the page' };
  try {
    opener.focus();
    return { restored: true };
  } catch {
    return { restored: false, why: 'focus threw' };
  }
}
