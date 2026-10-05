/* Applies the saved light/dark choice before the page paints (loaded in <head>) and powers the toggle button.
   Without a saved choice the page follows the system setting through CSS alone. */
(function () {
  'use strict';
  var KEY = 'friendsshare-theme';
  var root = document.documentElement;
  var dark = window.matchMedia('(prefers-color-scheme: dark)');

  function saved() {
    try {
      var v = localStorage.getItem(KEY);
      return v === 'light' || v === 'dark' ? v : null;
    } catch (e) {
      return null;
    }
  }
  function remember(v) {
    try {
      localStorage.setItem(KEY, v);
    } catch (e) {}
  }
  function effective() {
    return root.getAttribute('data-theme') || (dark.matches ? 'dark' : 'light');
  }

  var choice = saved();
  if (choice) root.setAttribute('data-theme', choice);

  /* keep the browser's address-bar colour in step with a manual choice */
  function syncBarColour() {
    if (!document.body) return;
    var bg = getComputedStyle(document.body).backgroundColor;
    var metas = document.querySelectorAll('meta[name="theme-color"]');
    for (var i = 0; i < metas.length; i++) metas[i].setAttribute('content', bg);
  }

  function wire() {
    var btn = document.getElementById('theme-toggle');
    if (!btn) return;
    function label() {
      btn.setAttribute('aria-label', 'Switch to ' + (effective() === 'dark' ? 'light' : 'dark') + ' theme');
    }
    btn.hidden = false;
    label();
    if (choice) syncBarColour();
    btn.addEventListener('click', function () {
      choice = effective() === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', choice);
      remember(choice);
      label();
      syncBarColour();
    });
    if (dark.addEventListener) dark.addEventListener('change', label);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
})();
