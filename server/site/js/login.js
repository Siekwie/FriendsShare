/* Sign-in page: shows what went wrong after a failed sign-in, passes "next" on to the provider, and takes part in the
   hand-over to the desktop app (contract section 3). The page also works without this script, as a plain page of links. */
(function () {
  'use strict';

  var $ = function (id) {
    return document.getElementById(id);
  };
  var query = new URLSearchParams(location.search);

  /* text: what happened; retry: what to do next. The retry sentence is left out when the page shows its own hint. */
  var ERRORS = {
    denied: { text: 'The sign-in was cancelled, so nothing was changed.', retry: 'You can try again whenever you like.' },
    state: { text: 'The sign-in could not be confirmed. It may have taken too long, or it was started in another browser.', retry: 'Please try again.' },
    provider: { text: 'The sign-in service did not complete the request.', retry: 'Please try again in a moment.' },
    not_configured: { text: 'This way of signing in is not set up on this server.', retry: 'Please use another one.' },
    email_unverified: { text: 'The sign-in service has no verified email address for you. Verify your email address there.', retry: 'Then try again.' },
    linked_elsewhere: { text: 'That login already belongs to another FriendsShare account, so it could not be added to this one. Sign in with it directly, or connect a different login.' },
    link: { text: 'This link was already used or has expired. Click the button in the FriendsShare app again to get a new one, or sign in below.' }
  };

  function request(method, url, body) {
    var opts = { method: method, credentials: 'same-origin', cache: 'no-store', headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    return fetch(url, opts).then(
      function (res) {
        if (res.status === 204) return null;
        return res.json().catch(function () { return null; }).then(function (data) {
          if (!res.ok) throw new Error((data && data.message) || 'Something went wrong. Please try again.');
          return data;
        });
      },
      function () {
        throw new Error('Could not reach the server. Check your connection and try again.');
      }
    );
  }

  function say(el, text) {
    el.textContent = text || '';
    el.hidden = !text;
  }
  function busy(btn, on, label) {
    if (on) {
      btn.dataset.label = btn.textContent;
      btn.textContent = label;
    } else if (btn.dataset.label) {
      btn.textContent = btn.dataset.label;
    }
    btn.disabled = on;
    if (on) btn.setAttribute('aria-busy', 'true');
    else btn.removeAttribute('aria-busy');
  }

  /* what the page was opened with */
  var next = query.get('next');
  if (!(next && /^\/(?![\/\\])/.test(next))) next = null;

  var ID = /^[A-Za-z0-9_-]{16,128}$/;
  var port = Number(query.get('app_port'));
  var app = null;
  if (Number.isInteger(port) && port >= 1024 && port <= 65535 && ID.test(query.get('app_state') || '') && ID.test(query.get('app_challenge') || '')) {
    app = { app_port: port, app_state: query.get('app_state'), app_challenge: query.get('app_challenge') };
  }

  function qs(obj) {
    return Object.keys(obj)
      .map(function (k) {
        return encodeURIComponent(k) + '=' + encodeURIComponent(obj[k]);
      })
      .join('&');
  }

  /* provider links carry the app values, or else the page to return to */
  var extra = app || (next ? { next: next } : null);
  ['github', 'google'].forEach(function (name) {
    var link = $('login-' + name);
    if (link && extra) link.href = '/auth/' + name + '?' + qs(extra);
  });

  /* a failed sign-in sends the browser back here with ?error=<code> */
  var code = query.get('error');
  if (code) {
    var e = Object.prototype.hasOwnProperty.call(ERRORS, code) ? ERRORS[code] : { text: 'The sign-in did not work.', retry: 'Please try again.' };
    var parts = [e.text];
    /* "link" comes from the app's Upgrade or Manage button and "linked_elsewhere" from the account page: neither is an app sign-in */
    if (code !== 'link' && code !== 'linked_elsewhere') {
      /* the server keeps the app's values on a failed app sign-in, so the buttons below still lead back to the app */
      if (app) parts.push('You can try again with the buttons below.');
      else parts.push(e.retry, 'If you started from the FriendsShare app, click "Sign in" in the app again.');
    }
    say($('login-error'), parts.join(' '));
    if (code === 'linked_elsewhere') $('back-account').hidden = false;
  }

  /* desktop app: signed-in browsers can continue with one click */
  var providers = $('login-providers');
  function showProviders() {
    $('login-checking').hidden = true;
    $('login-continue').hidden = true;
    providers.hidden = false;
  }

  function offerContinue(account) {
    var who = account.name || account.email || 'your account';
    var go = $('continue-btn');
    var other = $('switch-btn');
    go.textContent = 'Continue as ' + who;
    $('login-checking').hidden = true;
    $('login-continue').hidden = false;

    go.addEventListener('click', function () {
      say($('continue-error'), '');
      busy(go, true, 'Continuing…');
      request('POST', '/auth/app/continue', app).then(
        function (data) {
          if (!data || !/^http:\/\/127\.0\.0\.1:\d+\//.test(data.redirect || '')) throw new Error('The server sent an unexpected answer. Please try again.');
          location.href = data.redirect;
        }
      ).catch(function (e) {
        busy(go, false);
        say($('continue-error'), e.message);
      });
    });

    other.addEventListener('click', function () {
      say($('continue-error'), '');
      busy(other, true, 'Signing out…');
      request('POST', '/api/logout').then(
        function () {
          busy(other, false);
          showProviders();
        }
      ).catch(function (e) {
        busy(other, false);
        say($('continue-error'), e.message);
      });
    });
  }

  if (app) {
    $('login-lede').textContent = 'This signs in the FriendsShare app on this PC.';
    $('app-caution').hidden = false;
    providers.hidden = true;
    $('login-checking').hidden = false;
    request('GET', '/api/me').then(function (me) {
      if (me && me.account) offerContinue(me.account);
      else showProviders();
    }).catch(showProviders);
  }
})();
