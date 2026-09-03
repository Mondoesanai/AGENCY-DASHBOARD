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
      if (el && el.matches && el.matches('[data-track]')) {
        send('ev', el.getAttribute('data-track') || 'form');
      }
    },
    true
  );

  // auto-catch the two most common conversions even without data-track
  document.addEventListener(
    'click',
    function (ev) {
      var a = ev.target && ev.target.closest ? ev.target.closest('a[href]') : null;
      if (!a || a.hasAttribute('data-track')) return;
      var href = a.getAttribute('href') || '';
      if (/^tel:/i.test(href)) send('ev', 'call');
      else if (/^mailto:/i.test(href)) send('ev', 'email');
      else if (/calendly\.com|acuityscheduling|cal\.com|book/i.test(href)) send('ev', 'booking');
    },
    true
  );
})();
