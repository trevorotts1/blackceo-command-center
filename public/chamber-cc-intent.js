/**
 * CTR-191 New-question intent adapter (Command Center owned).
 *
 * The canonical chamber is copied byte-for-byte and is not edited. This file
 * is the CC adapter's additive script, injected into the served document by
 * /api/council/chamber-index. It adds ONE client intent id to each Convene
 * submission:
 *
 *   - a new submission (the request body differs from every pending one)
 *     gets a fresh intent id, so an identical question asked later creates a
 *     new sitting instead of replaying the old one forever;
 *   - a retry of the SAME submission reuses the pending intent id, so a
 *     double click / failed-response retry returns the same session;
 *   - on HTTP 202 the intent is forgotten, so the NEXT question -- even one
 *     with identical text -- is a new request.
 *
 * The id travels on `X-Council-Intent-Id` and is namespaced server-side.
 * Nothing else is touched: same URL, same body, same auth.
 */
(function () {
  if (window.__ccCouncilIntentInstalled) return;
  window.__ccCouncilIntentInstalled = true;

  var pending = Object.create(null);
  var nativeFetch = window.fetch;

  function newIntentId() {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === 'function') {
        return window.crypto.randomUUID();
      }
    } catch (error) {
      /* fall through */
    }
    return 'intent-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  }

  function isConvene(url, init) {
    if (!init || typeof init.method !== 'string') return false;
    if (init.method.toUpperCase() !== 'POST') return false;
    return url.indexOf('/api/council/convene') !== -1;
  }

  window.fetch = function (input, init) {
    try {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      if (isConvene(url, init) && typeof init.body === 'string') {
        var bodyKey = init.body;
        var intent = pending[bodyKey];
        if (!intent) {
          intent = { id: newIntentId(), settled: false };
          pending[bodyKey] = intent;
        }
        var headers = new Headers(init.headers || {});
        if (!headers.has('X-Council-Intent-Id')) {
          headers.set('X-Council-Intent-Id', intent.id);
        }
        var nextInit = {};
        for (var key in init) {
          if (Object.prototype.hasOwnProperty.call(init, key)) nextInit[key] = init[key];
        }
        nextInit.headers = headers;
        var response = nativeFetch.call(window, input, nextInit);
        response.then(
          function (res) {
            if (res && res.status === 202) {
              intent.settled = true;
              if (pending[bodyKey] === intent) delete pending[bodyKey];
            }
          },
          function () {
            /* Keep the intent so a retry of this submission replays it. */
          },
        );
        return response;
      }
    } catch (error) {
      /* Never break the page's own fetch for an adapter failure. */
    }
    return nativeFetch.call(window, input, init);
  };
})();
