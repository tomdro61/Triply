/**
 * The inline GA4 and Clarity start-up scripts the root layout injects, as
 * strings, so a test can run them against a stubbed page (see
 * __tests__/inline-analytics-scripts.test.ts). Both keep the params in
 * RECORDED_URL_SECRET_PARAMS (the guest's email, the Stripe client secret, the
 * booking key) out of what they record.
 */
import { RECORDED_URL_SECRET_PARAMS } from "./recorded-url-params";

const SECRET_PARAMS_JS = JSON.stringify(RECORDED_URL_SECRET_PARAMS);

/** Reads the stored analytics opt-out from the consent cookie. */
const READ_OPT_OUT = `
  var _optOut = false;
  try {
    var _m = document.cookie.match(/triply_cookie_consent=([^;]+)/);
    if (_m) _optOut = JSON.parse(decodeURIComponent(_m[1])).analyticsOptOut === true;
  } catch(e) {}
`;

/**
 * gtag consent defaults + config. Never sends a customer's address (GA's
 * terms forbid PII), a booking key or a Stripe client secret: an emailed
 * confirmation link lands with ?email= (and ?booking_key=) and Stripe's 3-D
 * Secure return with ?payment_intent_client_secret=, and this runs before the
 * page strips them. The first page_view goes out with them removed;
 * page_location is set on that event only, so later page views keep their own
 * URLs. GA's other hits on that page (engagement, scroll) still read the
 * original location — GA4's "Redact data" property setting covers those
 * (email, and the URL query parameters payment_intent_client_secret and
 * booking_key; runbook § 38).
 */
export function gtagInitScript(measurementId: string): string {
  return `
    window.dataLayer = window.dataLayer || [];
    function gtag(){dataLayer.push(arguments);}
    ${READ_OPT_OUT}
    gtag('consent', 'default', {
      analytics_storage: _optOut ? 'denied' : 'granted',
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied',
    });
    gtag('js', new Date());
    var _pl = null;
    try {
      var _u = new URL(location.href), _hit = false;
      ${SECRET_PARAMS_JS}.forEach(function(p) {
        if (_u.searchParams.has(p)) { _u.searchParams.delete(p); _hit = true; }
      });
      if (_hit) _pl = _u.toString();
    } catch(e) {}
    if (_pl) {
      gtag('config', ${JSON.stringify(measurementId)}, { send_page_view: false });
      gtag('event', 'page_view', { page_location: _pl });
    } else {
      gtag('config', ${JSON.stringify(measurementId)});
    }
  `;
}

/**
 * Minty Recover (formerly AddShoppers / SafeOpt) loader: the abandoned-visitor
 * pilot (Command Center task 7346cabe). Minty matches an anonymous visitor to
 * its opted-in shopper network and emails them our TRIP5 offer. Ships dark:
 * the layout renders it only when NEXT_PUBLIC_MINTY_SITE_ID is set.
 *
 * Not started at all when:
 *  - the visitor opted out of analytics (same cookie as GA / Clarity);
 *  - the URL or the referrer carries a secret param (email, booking key,
 *    Stripe client secret);
 *  - the visit LANDS on a page where the guest has given us their details or
 *    holds a booking (checkout, confirmation, reservations, account, admin,
 *    auth, review). Those guests are ours to email for free (checkout-recovery
 *    cron), and a third-party widget has no business reading those forms.
 *    A script cannot be unloaded, so a visitor who lands on /search and then
 *    walks into checkout keeps the widget running: excluding them from
 *    Minty's emails is Minty-side config (call Q3), not something this can do.
 *
 * The loader URL is AddShoppers' documented async widget; the site id rides in
 * the hash. Attribution is code-only on our side: a recovered booking is one
 * with promo_code = 'TRIP5' (bookings table), no conversion pixel needed for
 * our read-out. If Minty requires a conversion call for billing, add it to the
 * confirmation page's once-per-booking purchase hook.
 */
export const MINTY_SKIP_PATH_PREFIXES = [
  "/checkout",
  "/confirmation",
  "/reservations",
  "/account",
  "/admin",
  "/auth",
  "/review",
] as const;

/** Minty site ids are 24 lowercase hex chars (a Mongo ObjectId). */
export function isValidMintySiteId(id: string | undefined): id is string {
  return typeof id === "string" && /^[a-f0-9]{24}$/.test(id);
}

export function mintyInitScript(siteId: string): string {
  if (!isValidMintySiteId(siteId)) throw new Error("mintyInitScript: invalid site id");
  return `
    ${READ_OPT_OUT}
    var _skipMinty = _optOut;
    try {
      var _secretM = ${SECRET_PARAMS_JS};
      var _hasM = function(href) {
        if (!href) return false;
        var q = new URL(href, location.href).searchParams;
        return _secretM.some(function(p) { return q.has(p); });
      };
      if (_hasM(location.href) || _hasM(document.referrer)) _skipMinty = true;
      var _path = new URL(location.href).pathname;
      ${JSON.stringify(MINTY_SKIP_PATH_PREFIXES)}.forEach(function(p) {
        if (_path === p || _path.indexOf(p + "/") === 0) _skipMinty = true;
      });
    } catch(e) { _skipMinty = true; }
    if (!_skipMinty) {
      var _js = document.createElement("script");
      _js.type = "text/javascript";
      _js.async = true;
      _js.id = "AddShoppers";
      _js.src = "https://shop.pe/widget/widget_async.js#" + ${JSON.stringify(siteId)};
      var _first = document.getElementsByTagName("script")[0];
      _first.parentNode.insertBefore(_js, _first);
    }
  `;
}

/**
 * Clarity loader. Clarity waits for load + idle, so the confirmation page has
 * normally stripped ?email= (and /checkout/complete its client secret) by the
 * time this runs. Clarity records the page URL and document.referrer, so it is
 * not started at all when:
 *  - the visitor opted out of analytics (a mid-session opt-out still goes
 *    through clarity('consent', false) in lib/analytics/clarity.ts);
 *  - the URL or the referrer still carries a secret param (storage was
 *    blocked, so the page kept ?email= for reloads).
 */
export function clarityInitScript(clarityId: string): string {
  return `
    ${READ_OPT_OUT}
    var _skipClarity = _optOut;
    try {
      var _secret = ${SECRET_PARAMS_JS};
      var _has = function(href) {
        if (!href) return false;
        var q = new URL(href, location.href).searchParams;
        return _secret.some(function(p) { return q.has(p); });
      };
      if (_has(location.href) || _has(document.referrer)) _skipClarity = true;
    } catch(e) {}
    if (!_skipClarity) {
      (function(c,l,a,r,i,t,y){
        c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};
        t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;
        y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);
      })(window, document, "clarity", "script", ${JSON.stringify(clarityId)});
    }
  `;
}
