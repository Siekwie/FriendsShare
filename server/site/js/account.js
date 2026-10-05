/* Account page: loads /api/me and fills in the plan, sign-in methods and actions (contract section 2, JSON API). */
(function () {
  'use strict';

  var $ = function (id) {
    return document.getElementById(id);
  };
  var returned = new URLSearchParams(location.search).get('billing'); /* 'success' | 'cancelled' | null, set by Stripe's return */
  var PROVIDERS = [
    { id: 'github', name: 'GitHub' },
    { id: 'google', name: 'Google' }
  ];
  var LOGIN = '/login?next=/account';

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
          if (!res.ok) {
            var err = new Error((data && data.message) || 'Something went wrong. Please try again.');
            err.status = res.status;
            throw err;
          }
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
      btn.setAttribute('aria-busy', 'true');
    } else {
      if (btn.dataset.label) btn.textContent = btn.dataset.label;
      btn.removeAttribute('aria-busy');
    }
    btn.disabled = on;
  }
  function date(ms) {
    return new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  }
  /* a failed action: an ended session sends the person to sign in again, anything else is shown as it is */
  function failed(err, target) {
    if (err.status === 401) location.href = LOGIN;
    else say(target, err.message);
  }

  /* ---- drawing the page ---- */

  var confirming = false; /* back from a checkout and waiting for the plan to turn Pro */

  function drawProfile(account) {
    var initial = $('acct-initial');
    var photo = $('acct-avatar');
    $('acct-name').textContent = account.name || account.email || 'Your account';
    $('acct-email').textContent = account.email || '';
    initial.textContent = ((account.name || account.email || '?').trim().charAt(0) || '?').toUpperCase();
    initial.hidden = false;
    photo.hidden = true;
    if (account.avatar) {
      photo.onload = function () {
        photo.hidden = false;
        initial.hidden = true;
      };
      photo.onerror = function () {
        photo.hidden = true;
        initial.hidden = false;
      };
      photo.src = account.avatar;
    }
  }

  function drawPlan(data) {
    var pro = data.plan === 'pro';
    var sub = data.subscription;
    var badge = $('plan-badge');
    badge.textContent = pro ? 'Pro' : 'Free';
    badge.classList.toggle('is-pro', pro);
    $('plan-free').hidden = pro;
    $('plan-pro').hidden = !pro;
    say($('plan-error'), '');

    if (pro) {
      var line = '';
      if (sub && sub.renews_at) {
        var billed = sub.interval === 'year' ? 'Billed yearly. ' : sub.interval === 'month' ? 'Billed monthly. ' : '';
        line = sub.cancel_at_period_end
          ? 'Your subscription is cancelled. Pro ends on ' + date(sub.renews_at) + ', and after that your account is on the Free plan.'
          : billed + 'Renews on ' + date(sub.renews_at) + '.';
      }
      if (sub && sub.status === 'past_due') line = 'Your last payment did not go through. Open Manage subscription to update your payment details. ' + line;
      else if (sub && sub.status && sub.status !== 'active' && sub.status !== 'trialing') line = 'Subscription status: ' + sub.status + '. ' + line;
      $('pro-status').textContent = line.trim();
      $('pro-status').hidden = !line;
      return;
    }

    var canBuy = !!data.billing;
    $('free-text').textContent = canBuy
      ? 'You are on the Free plan: up to ' + data.free_limit + ' folders at a time, counting folders you share and folders you received.'
      : 'You are on the Free plan.';
    $('upgrade').hidden = !canBuy || confirming; /* no second purchase while the first is being confirmed */
    $('free-nobilling').hidden = canBuy;
    if (canBuy && data.prices) {
      $('free-limit').textContent = data.free_limit;
      $('price-yearly-pm').textContent = data.prices.yearly_per_month;
      $('price-yearly').textContent = data.prices.yearly;
      $('price-monthly').textContent = data.prices.monthly;
    }
  }

  function drawMethods(data) {
    var list = $('methods');
    var connected = (data.account && data.account.providers) || [];
    list.textContent = '';
    PROVIDERS.forEach(function (p) {
      var isConnected = connected.indexOf(p.id) !== -1;
      if (!isConnected && !(data.providers && data.providers[p.id])) return;
      var row = document.createElement('li');
      var label = document.createElement('b');
      label.textContent = p.name;
      row.appendChild(label);
      if (isConnected) {
        var tag = document.createElement('span');
        tag.className = 'muted';
        tag.textContent = 'Connected';
        row.appendChild(tag);
      } else {
        var link = document.createElement('a');
        link.className = 'btn btn-sm';
        link.href = '/auth/' + p.id + '?link=1&next=/account';
        link.textContent = 'Connect ' + p.name;
        row.appendChild(link);
      }
      list.appendChild(row);
    });
  }

  function drawNote(data) {
    var text = '';
    var recheck = false;
    if (returned === 'cancelled') {
      if (data.plan !== 'pro') text = 'Checkout was cancelled and nothing was charged. You can upgrade whenever you like.';
    } else if (returned === 'success') {
      if (data.plan === 'pro') text = 'Thank you. Your payment went through and you are on Pro now.';
      else if (confirming) text = 'Thank you. We are confirming your payment, which can take a few seconds.';
      else {
        text = 'Your payment can take a minute to show up here. If this page still says Free then, check again.';
        recheck = true;
      }
    }
    $('billing-text').textContent = text;
    $('btn-recheck').hidden = !recheck;
    $('billing-note').hidden = !text;
  }

  function draw(data) {
    $('acct-loading').hidden = true;
    $('acct-fail').hidden = true;
    $('acct').hidden = false;
    drawProfile(data.account);
    drawPlan(data);
    drawMethods(data);
    drawNote(data);
    $('dlg-pro-line').hidden = data.plan !== 'pro';
  }

  /* ---- loading ---- */

  /* reads /api/me; resolves with null after sending a signed-out visitor to the sign-in page */
  function read() {
    return request('GET', '/api/me').then(function (data) {
      if (data && data.account) return data;
      location.replace(LOGIN);
      return null;
    });
  }

  /* After Stripe sends the person back, the plan can lag behind the payment: read again after 2 and 6 seconds. */
  function waitForPro() {
    var delays = [2000, 6000];
    delays.forEach(function (ms, i) {
      setTimeout(function () {
        if (!confirming) return;
        read().then(function (data) {
          if (!data) return;
          if (data.plan === 'pro' || i === delays.length - 1) confirming = false;
          if (data.plan === 'pro') history.replaceState(null, '', '/account');
          draw(data);
        }).catch(function () {
          if (i === delays.length - 1) {
            confirming = false;
            $('billing-text').textContent = 'Your payment can take a minute to show up here. Check again in a moment.';
            $('btn-recheck').hidden = false;
          }
        });
      }, ms);
    });
  }

  function start() {
    $('acct-loading').hidden = false;
    $('acct-fail').hidden = true;
    read().then(function (data) {
      if (!data) return;
      confirming = returned === 'success' && data.plan !== 'pro';
      draw(data);
      if (confirming) waitForPro();
    }).catch(function (err) {
      $('acct-loading').hidden = true;
      say($('acct-fail-msg'), err.message);
      $('acct-fail').hidden = false;
    });
  }

  /* ---- actions ---- */

  $('acct-retry').addEventListener('click', start);

  $('btn-recheck').addEventListener('click', function () {
    var btn = $('btn-recheck');
    busy(btn, true, 'Checking…');
    read().then(function (data) {
      if (data) draw(data);
    }).catch(function (err) {
      say($('plan-error'), err.message);
    }).then(function () {
      busy(btn, false);
    });
  });

  $('btn-checkout').addEventListener('click', function () {
    var btn = $('btn-checkout');
    var chosen = document.querySelector('input[name="interval"]:checked');
    say($('plan-error'), '');
    busy(btn, true, 'Opening checkout…');
    request('POST', '/api/billing/checkout', { interval: chosen ? chosen.value : 'year' }).then(function (data) {
      if (!data || !data.url) throw new Error('The server did not return a checkout page. Please try again.');
      location.href = data.url;
    }).catch(function (err) {
      busy(btn, false);
      failed(err, $('plan-error'));
    });
  });

  $('btn-portal').addEventListener('click', function () {
    var btn = $('btn-portal');
    say($('plan-error'), '');
    busy(btn, true, 'Opening Stripe…');
    request('POST', '/api/billing/portal').then(function (data) {
      if (!data || !data.url) throw new Error('The server did not return the subscription page. Please try again.');
      location.href = data.url;
    }).catch(function (err) {
      busy(btn, false);
      failed(err, $('plan-error'));
    });
  });

  /* "Sign out" ends this browser's session; "Sign out everywhere" ends every session of the account, apps included */
  function signOut(everywhere) {
    var btn = $(everywhere ? 'btn-signout-all' : 'btn-signout');
    var other = $(everywhere ? 'btn-signout' : 'btn-signout-all');
    say($('signout-error'), '');
    busy(btn, true, 'Signing out…');
    other.disabled = true;
    request('POST', '/api/logout', everywhere ? { everywhere: true } : undefined).then(function () {
      location.href = '/';
    }).catch(function (err) {
      busy(btn, false);
      other.disabled = false;
      say($('signout-error'), err.message);
    });
  }
  $('btn-signout').addEventListener('click', function () {
    signOut(false);
  });
  $('btn-signout-all').addEventListener('click', function () {
    signOut(true);
  });

  var dialog = $('dlg-delete');
  function deleteAccount() {
    var btn = $('btn-delete-confirm');
    say($('delete-error'), '');
    busy(btn, true, 'Deleting…');
    request('POST', '/api/account/delete').then(function () {
      location.href = '/';
    }).catch(function (err) {
      busy(btn, false);
      failed(err, $('delete-error'));
    });
  }
  $('btn-delete').addEventListener('click', function () {
    say($('delete-error'), '');
    if (dialog.showModal) dialog.showModal();
    else if (window.confirm('Delete your account? This cannot be undone. Folders and files on your PC are not touched.')) deleteAccount();
  });
  $('btn-delete-cancel').addEventListener('click', function () {
    dialog.close();
  });
  $('btn-delete-confirm').addEventListener('click', deleteAccount);

  start();
})();
