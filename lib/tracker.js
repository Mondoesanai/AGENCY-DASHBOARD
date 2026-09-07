// The tracker script body, served by api/t.js with __ENDPOINT__ replaced by the
// dashboard's own /api/collect URL. Baking the endpoint in means it never
// depends on document.currentScript (which is null for some deferred / injected
// script setups — that was making beacons post to the client's own domain).
export const TRACKER_JS = `/*! Inspiring Websites tracker — no cookies, no consent banner */
(function () {
  var ENDPOINT = "__ENDPOINT__";
  var tag =
    document.currentScript ||
    document.querySelector('script[src*="/t.js"]') ||
    document.querySelector('script[data-site]') || {};
  var site =
    (tag.getAttribute && tag.getAttribute("data-site")) ||
    (location.hostname || "").replace(/^www\\./, "");
  var DEBUG = /[?&]iwdebug/.test((tag.src || "")) || window.__iwDebug;

  function send(type, name, path) {
    var body = JSON.stringify({
      s: site, e: type, n: name || "",
      p: path || location.pathname,
      r: document.referrer || "", w: window.innerWidth || 0,
      u: location.origin || ""
    });
    if (DEBUG) try { console.log("[iw]", type, name || "", "->", ENDPOINT, body); } catch (e) {}
    try {
      if (navigator.sendBeacon && navigator.sendBeacon(ENDPOINT, body)) return;
    } catch (e) {}
    try {
      fetch(ENDPOINT, { method: "POST", body: body, keepalive: true, mode: "cors" }).catch(function () {});
    } catch (e) {
      var i = new Image();
      i.src = ENDPOINT + "?" + body.replace(/[{}"]/g, "").replace(/:/g, "=").replace(/,/g, "&");
    }
  }

  send("pv");

  var lastPath = location.pathname;
  setInterval(function () {
    if (location.pathname !== lastPath) { lastPath = location.pathname; send("pv"); }
  }, 800);

  document.addEventListener("click", function (ev) {
    var el = ev.target && ev.target.closest ? ev.target.closest("[data-track]") : null;
    if (el) send("ev", el.getAttribute("data-track") || "click");
  }, true);

  document.addEventListener("submit", function (ev) {
    var el = ev.target;
    if (!el || !el.matches) return;
    if (el.matches("[data-track]")) send("ev", el.getAttribute("data-track") || "form");
    else send("ev", "form-" + ((el.getAttribute("name") || el.id || "submit").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 24)));
  }, true);

  document.addEventListener("click", function (ev) {
    var a = ev.target && ev.target.closest ? ev.target.closest("a[href], button") : null;
    if (!a || a.hasAttribute("data-track")) return;
    var href = (a.getAttribute && a.getAttribute("href")) || "";
    var txt = (a.textContent || "").toLowerCase();
    if (/^tel:/i.test(href)) send("ev", "call");
    else if (/^sms:/i.test(href)) send("ev", "text");
    else if (/^mailto:/i.test(href)) send("ev", "email");
    else if (/wa\\.me|api\\.whatsapp|whatsapp\\.com/i.test(href)) send("ev", "whatsapp");
    else if (/calendly\\.com|acuityscheduling|cal\\.com|squareup\\.com\\/appointments|book(ing)?/i.test(href)) send("ev", "booking");
    else if (/writereview|g\\.page\\/.+\\/review|\\/review|search\\.google\\.com\\/local\\/writereview/i.test(href) || /leave (a )?review|write a review/.test(txt)) send("ev", "review-click");
    else if (/maps\\.google|google\\.[a-z.]+\\/maps|goo\\.gl\\/maps/i.test(href)) send("ev", "directions");
    else if (/get (a )?quote|request (a )?quote|free quote|get started/.test(txt) && a.tagName === "BUTTON") send("ev", "quote-cta");
  }, true);
})();
`;
