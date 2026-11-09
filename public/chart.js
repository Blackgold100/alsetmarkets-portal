// Crosshair + tooltip for the performance chart. Data comes from data-points on .chart-plot.
(function () {
  var plot = document.querySelector('.chart-plot[data-points]');
  if (!plot) return;
  var pts;
  try { pts = JSON.parse(plot.getAttribute('data-points')); } catch (e) { return; }
  if (!pts || !pts.length) return;
  var cur = plot.getAttribute('data-currency') || 'USD';
  var sym = { USD: '$', EUR: '€', GBP: '£', NGN: '₦' }[cur] || '';
  var line = plot.querySelector('.xh-line');
  var dot = plot.querySelector('.xh-dot');
  var tip = plot.querySelector('.tip');
  var M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function money(v) {
    var s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return (v < 0 ? '−' : '') + sym + s;
  }
  function fdate(iso) {
    var p = iso.split('-');
    return Number(p[2]) + ' ' + M[Number(p[1]) - 1] + ' ' + p[0];
  }
  function show(i) {
    var p = pts[i];
    var left = p.x * 100;
    line.style.left = left + '%';
    dot.style.left = left + '%';
    dot.style.top = p.yb + 'px';
    line.style.display = dot.style.display = tip.style.display = 'block';
    var gain = p.bal - p.inv;
    tip.innerHTML = '';
    var d = document.createElement('div'); d.className = 't-date'; d.textContent = fdate(p.d); tip.appendChild(d);
    [['Account balance', money(p.bal), ''], ['Capital invested', money(p.inv), ''], ['Total return', (gain > 0 ? '+' : '') + money(gain), ' total']].forEach(function (r) {
      var row = document.createElement('div'); row.className = 't-row' + r[2];
      var a = document.createElement('span'); a.textContent = r[0];
      var b = document.createElement('span'); b.className = 'num'; b.textContent = r[1];
      row.appendChild(a); row.appendChild(b); tip.appendChild(row);
    });
    if (left > 65) { tip.style.left = 'auto'; tip.style.right = (100 - left) + '%'; tip.style.marginRight = '12px'; tip.style.marginLeft = '0'; }
    else { tip.style.right = 'auto'; tip.style.left = left + '%'; tip.style.marginLeft = '12px'; tip.style.marginRight = '0'; }
  }
  function hide() { line.style.display = dot.style.display = tip.style.display = 'none'; }
  function nearest(fx) {
    var best = 0, bd = Infinity;
    for (var i = 0; i < pts.length; i++) { var dd = Math.abs(pts[i].x - fx); if (dd < bd) { bd = dd; best = i; } }
    return best;
  }
  plot.addEventListener('mousemove', function (e) {
    var r = plot.getBoundingClientRect();
    show(nearest(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width))));
  });
  plot.addEventListener('touchstart', function (e) {
    var r = plot.getBoundingClientRect();
    show(nearest(Math.max(0, Math.min(1, (e.touches[0].clientX - r.left) / r.width))));
  }, { passive: true });
  plot.addEventListener('mouseleave', hide);
})();

// Confirm dialogs for destructive admin actions (no inline JS, CSP-safe)
document.addEventListener('submit', function (e) {
  var msg = e.target.getAttribute('data-confirm');
  if (msg && !window.confirm(msg)) e.preventDefault();
});

// Copy-to-clipboard buttons: <button data-copy="#elementId">
document.addEventListener('click', function (e) {
  var btn = e.target.closest('[data-copy]');
  if (!btn) return;
  var el = document.querySelector(btn.getAttribute('data-copy'));
  if (!el) return;
  var text = el.textContent.trim();
  var done = function () { var old = btn.textContent; btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = old; }, 1600); };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () {});
  else { var r = document.createRange(); r.selectNodeContents(el); var s = window.getSelection(); s.removeAllRanges(); s.addRange(r); try { document.execCommand('copy'); done(); } catch (x) {} }
});

// Limit the network list to networks that support the chosen currency
document.querySelectorAll('[data-asset-select]').forEach(function (assetSel) {
  var netSel = document.querySelector(assetSel.getAttribute('data-asset-select'));
  if (!netSel) return;
  function sync() {
    var a = assetSel.value, firstOk = null;
    Array.prototype.forEach.call(netSel.options, function (o) {
      var ok = (o.getAttribute('data-assets') || '').split(',').indexOf(a) !== -1;
      o.disabled = !ok; o.hidden = !ok;
      if (ok && !firstOk) firstOk = o;
    });
    if (netSel.selectedOptions[0] && netSel.selectedOptions[0].disabled && firstOk) netSel.value = firstOk.value;
  }
  assetSel.addEventListener('change', sync);
  sync();
});
