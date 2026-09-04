/*!
 * Portfolio tracker — ~1KB, no cookies, no consent banner needed.
 *
 * Embed once, before </body>, on any site you want visitor data from:
 *   <script defer src="https://YOUR-DASHBOARD.vercel.app/t.js"></script>
 *
 * The site is identified automatically by its domain, so you don't have to
 * configure anything per-site. (Optional: add data-site="my-slug" to the
 * tag if you want to force a specific id.)
 *
 * Conversions: add data-track to any link/button/form, e.g.
 *   <a href="tel:+1..." data-track="call">Call</a>
 *   <form data-track="lead-form"> ... </form>
 */
(function () {
  var s = document.currentScript || {};
  var endpoint = (s.src || '').replace(/\/t\.js.*$/, '') + '/api/collect';
  var site =
    (s.getAttribute && s.getAttribute('data-site')) ||
    location.hostname.replace(/^www\./, '');

  function send(type, name, path) {
    var body = JSON.stringify({
      s: site,
      e: type,
      n: name || '',
      p: path || location.pathname,
      r: document.referrer || '',
      w: window.innerWidth || 0,
      u: location.origin || '',
    });
    // sendBeacon survives page unload; fetch is the fallback
    if (navigator.sendBeacon) {
      navigator.sendBeacon(endpoint, body);
    } else {
      fetch(endpoint, { method: 'POST', body: body, keepalive: true }).catch(function () {});
    }
  }

  // initial pageview
  send('pv');

  // SPA / hash route changes
  var lastPath = location.pathname;
  setInterval(function () {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      send('pv');
    }
  }, 800);

  // conversions
  document.addEventListener(
    'click',
    function (ev) {
      var el = ev.target && ev.target.closest ? ev.target.closest('[data-track]') : null;
      if (!el) return;
      send('ev', el.getAttribute('data-track') || 'click');
    },
    true
  );
  document.addEventListener(
    'submit',
    function (ev) {
      var el = ev.target;
      if (!el || !el.matches) return;
      if (el.matches('[data-track]')) send('ev', el.getAttribute('data-track') || 'form');
      else send('ev', 'form-' + ((el.getAttribute('name') || el.id || 'submit').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24)));
    },
    true
  );

  // auto-catch the common conversion types even without data-track, so a site
  // works the moment the snippet is added. Add data-track="…" for anything custom.
  document.addEventListener(
    'click',
    function (ev) {
      var a = ev.target && ev.target.closest ? ev.target.closest('a[href], button') : null;
      if (!a || a.hasAttribute('data-track')) return;
      var href = (a.getAttribute && a.getAttribute('href')) || '';
      var txt = (a.textContent || '').toLowerCase();
      if (/^tel:/i.test(href)) send('ev', 'call');
      else if (/^sms:/i.test(href)) send('ev', 'text');
      else if (/^mailto:/i.test(href)) send('ev', 'email');
      else if (/wa\.me|api\.whatsapp|whatsapp\.com/i.test(href)) send('ev', 'whatsapp');
      else if (/calendly\.com|acuityscheduling|cal\.com|squareup\.com\/appointments|book(ing)?/i.test(href)) send('ev', 'booking');
      else if (/writereview|g\.page\/.+\/review|\/review|search\.google\.com\/local\/writereview/i.test(href) || /leave (a )?review|write a review/.test(txt)) send('ev', 'review-click');
      else if (/maps\.google|google\.[a-z.]+\/maps|goo\.gl\/maps/i.test(href)) send('ev', 'directions');
      else if (/get (a )?quote|request (a )?quote|free quote|get started/.test(txt) && a.tagName === 'BUTTON') send('ev', 'quote-cta');
    },
    true
  );
})();
