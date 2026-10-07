/* Progressive enhancement only: every page works without this file.

   Charts: the value of the column under the pointer or the keyboard focus. The same numbers are in
   the table at the end of the page. */
(function () {
  'use strict';
  var columns = document.querySelectorAll('.chart-col');
  if (!columns.length) return;

  var tip = document.createElement('div');
  var value = document.createElement('strong');
  var day = document.createElement('span');
  tip.className = 'chart-tip';
  tip.hidden = true;
  tip.append(value, day);
  document.body.append(tip);

  columns.forEach(function (column) {
    function show() {
      var bar = column.querySelector('.chart-bar');
      var slot = column.querySelector('.chart-hit').getBoundingClientRect();
      value.textContent = column.dataset.tip;
      day.textContent = column.dataset.tipSub;
      tip.hidden = false;
      var width = tip.offsetWidth;
      var x = Math.min(Math.max(8, slot.left + slot.width / 2 - width / 2), window.innerWidth - width - 8);
      var top = bar ? bar.getBoundingClientRect().top : slot.bottom;
      tip.style.left = x + 'px';
      tip.style.top = Math.max(8, top - tip.offsetHeight - 8) + 'px';
    }
    function hide() {
      tip.hidden = true;
    }
    column.addEventListener('pointerenter', show);
    column.addEventListener('focus', show);
    column.addEventListener('pointerleave', hide);
    column.addEventListener('blur', hide);
  });
})();
