// Live support chat: client widget, admin inbox and admin unread badge.
// All text is inserted with textContent, so message bodies can never inject HTML.
(function () {
  var CSRF = (document.querySelector('meta[name="csrf-token"]') || {}).content || '';
  var baseTitle = document.title;

  function api(method, url, body) {
    var opts = { method: method, headers: { 'Accept': 'application/json', 'x-csrf-token': CSRF }, credentials: 'same-origin' };
    if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return fetch(url, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) { var e = new Error(j.error || 'Something went wrong. Please try again.'); e.status = r.status; throw e; }
        return j;
      });
    });
  }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function fmtTime(iso) {
    var d = new Date(iso), now = new Date();
    var t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return d.toDateString() === now.toDateString() ? t : d.toLocaleDateString([], { day: 'numeric', month: 'short' }) + ', ' + t;
  }
  function autoGrow(ta) {
    ta.addEventListener('input', function () { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 140) + 'px'; });
  }
  function enterToSend(ta, form) {
    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event('submit', { cancelable: true })); }
    });
  }

  // Renders messages into a log; `mine` is the role shown on the right.
  function Log(container, mine, emptyText) {
    var seen = {}, lastId = 0, empty = null;
    function showEmpty() {
      if (!emptyText || empty || lastId) return;
      empty = el('div', 'chat-empty', emptyText);
      container.appendChild(empty);
    }
    function add(m) {
      if (seen[m.id]) return false;
      seen[m.id] = true;
      if (m.id > lastId) lastId = m.id;
      if (empty) { empty.remove(); empty = null; }
      var row = el('div', 'msg msg-' + (m.role === 'system' ? 'system' : m.role === mine ? 'mine' : 'theirs'));
      var bubble = el('div', 'bubble', m.body);
      row.appendChild(bubble);
      var meta = m.role === 'system' ? 'Automatic message' : (m.role === mine ? 'You' : (m.name || (m.role === 'admin' ? 'Support' : 'Client'))) + ' · ' + fmtTime(m.at);
      row.appendChild(el('div', 'meta', meta));
      container.appendChild(row);
      return true;
    }
    function addAll(list) {
      var nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 80;
      var added = 0;
      (list || []).forEach(function (m) { if (add(m)) added++; });
      if (added && (nearBottom || added === list.length)) container.scrollTop = container.scrollHeight;
      showEmpty();
      return added;
    }
    showEmpty();
    return { addAll: addAll, last: function () { return lastId; }, scrollEnd: function () { container.scrollTop = container.scrollHeight; } };
  }

  function sendFrom(form, ta, url, log, btn) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var body = ta.value.trim();
      if (!body) return;
      ta.disabled = true; if (btn) btn.disabled = true;
      api('POST', url, { body: body }).then(function (j) {
        ta.value = ''; ta.style.height = 'auto';
        log.addAll([j.message]); log.scrollEnd();
        document.dispatchEvent(new Event('chat:sent'));
      }).catch(function (err) {
        alertInline(form, err.message);
      }).then(function () { ta.disabled = false; if (btn) btn.disabled = false; ta.focus(); });
    });
  }
  function alertInline(form, text) {
    var n = form.parentNode.querySelector('.chat-error');
    if (!n) { n = el('div', 'chat-error'); n.setAttribute('role', 'alert'); form.parentNode.insertBefore(n, form); }
    n.textContent = text;
    setTimeout(function () { if (n) n.remove(); }, 6000);
  }

  // Polls `fn` faster while the page is visible.
  function poller(fn, fast, slow) {
    var timer = null;
    function tick() {
      clearTimeout(timer);
      Promise.resolve(fn()).catch(function () {}).then(function () {
        timer = setTimeout(tick, document.hidden ? slow : fast());
      });
    }
    document.addEventListener('visibilitychange', function () { if (!document.hidden) tick(); });
    document.addEventListener('chat:sent', function () { setTimeout(tick, 300); });
    tick();
    return { now: tick };
  }

  // ===================== Client widget =====================
  var widget = document.querySelector('[data-chat-widget]');
  if (widget) {
    var panel = widget.querySelector('[data-chat-panel]');
    var badge = widget.querySelector('[data-chat-badge]');
    var logEl = widget.querySelector('[data-chat-log]');
    var form = widget.querySelector('[data-chat-form]');
    var input = widget.querySelector('[data-chat-input]');
    var fab = widget.querySelector('.chat-fab');
    var dot = widget.querySelector('[data-chat-dot]');
    var presence = widget.querySelector('[data-chat-presence]');
    var first = widget.getAttribute('data-first-name') || '';
    var log = Log(logEl, 'client', 'Hi ' + first + '. Ask us anything about your account, deposits or withdrawals. A member of our team will reply here.');
    var open = false, unread = 0;
    try { open = sessionStorage.getItem('chatOpen') === '1'; } catch (e) {}

    function setBadge(n) {
      unread = n;
      badge.hidden = !n || open;
      badge.textContent = n > 9 ? '9+' : String(n);
      document.title = n && !open ? '(' + n + ') ' + baseTitle : baseTitle;
    }
    function markRead() { if (unread) api('POST', '/chat/api/read').then(function () { setBadge(0); }).catch(function () {}); }
    function setOpen(v) {
      open = v;
      panel.hidden = !v;
      fab.setAttribute('aria-expanded', v ? 'true' : 'false');
      widget.classList.toggle('is-open', v);
      try { sessionStorage.setItem('chatOpen', v ? '1' : '0'); } catch (e) {}
      if (v) { setBadge(unread); markRead(); log.scrollEnd(); setTimeout(function () { input.focus(); }, 50); p.now(); }
      else setBadge(unread);
    }
    widget.querySelectorAll('[data-chat-toggle]').forEach(function (b) { b.addEventListener('click', function () { setOpen(!open); }); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && open) { setOpen(false); fab.focus(); } });
    autoGrow(input); enterToSend(input, form);
    sendFrom(form, input, '/chat/api/messages', log, form.querySelector('button'));

    var p = poller(function () {
      return api('GET', '/chat/api/messages?after=' + log.last()).then(function (j) {
        log.addAll(j.messages);
        dot.classList.toggle('on', !!j.online);
        presence.textContent = j.online ? 'Online now. We usually reply in minutes.' : 'Offline. Leave a message and we’ll reply here.';
        setBadge(j.unread);
        if (open && j.unread && !document.hidden) markRead();
      });
    }, function () { return open ? 3000 : 12000; }, 30000);
    if (open) setOpen(true);
  }

  // ===================== Admin: nav badge + desktop alerts =====================
  var navBadge = document.querySelector('[data-support-badge]');
  if (navBadge) {
    var lastLatest = null;
    var notifyBtn = document.querySelector('[data-enable-notify]');
    if (notifyBtn && 'Notification' in window && Notification.permission === 'default') {
      notifyBtn.hidden = false;
      notifyBtn.addEventListener('click', function () { Notification.requestPermission().then(function () { notifyBtn.hidden = true; }); });
    }
    poller(function () {
      return api('GET', '/admin/chat/api/summary').then(function (j) {
        navBadge.hidden = !j.unread;
        navBadge.textContent = j.unread > 99 ? '99+' : String(j.unread);
        if (!document.querySelector('[data-admin-log]')) document.title = j.unread ? '(' + j.unread + ') ' + baseTitle : baseTitle;
        if (lastLatest !== null && j.latest > lastLatest && document.hidden && 'Notification' in window && Notification.permission === 'granted') {
          var n = new Notification('New client message', { body: 'A client is waiting in Support chat.', tag: 'alset-chat' });
          n.onclick = function () { window.focus(); location.href = '/admin/chat'; };
        }
        lastLatest = j.latest;
      });
    }, function () { return 8000; }, 20000);
  }

  // ===================== Admin: inbox list =====================
  var inbox = document.querySelector('[data-inbox]');
  var listEl = inbox && inbox.querySelector('[data-thread-list]');
  if (listEl) {
    var filter = inbox.getAttribute('data-filter') || 'open';
    var active = inbox.getAttribute('data-active');
    function renderThreads(threads) {
      listEl.textContent = '';
      if (!threads.length) { listEl.appendChild(el('div', 'empty', 'No ' + (filter === 'all' ? '' : filter + ' ') + 'conversations.')); return; }
      threads.forEach(function (t) {
        var a = el('a', 'thread-item' + (String(t.id) === active ? ' active' : ''));
        a.href = '/admin/chat/' + t.id + '?filter=' + filter;
        var top = el('span', 'thread-top');
        top.appendChild(el('strong', null, t.name));
        top.appendChild(el('span', 'muted thread-time', fmtTime(t.lastAt)));
        a.appendChild(top);
        a.appendChild(el('span', 'thread-preview', (t.lastRole === 'admin' ? 'You: ' : '') + t.lastBody));
        var meta = el('span', 'thread-meta');
        meta.appendChild(el('span', 'num muted', t.account || ''));
        if (t.unread) meta.appendChild(el('span', 'pill pill-pending', t.unread + ' new'));
        else if (t.waiting) meta.appendChild(el('span', 'pill pill-pending', 'Awaiting reply'));
        if (t.status === 'closed') meta.appendChild(el('span', 'pill pill-neutral', 'Closed'));
        a.appendChild(meta);
        listEl.appendChild(a);
      });
    }
    poller(function () {
      return api('GET', '/admin/chat/api/threads?filter=' + filter).then(function (j) { renderThreads(j.threads); });
    }, function () { return 5000; }, 20000);
  }

  // ===================== Admin: conversation =====================
  var adminLog = document.querySelector('[data-admin-log]');
  if (adminLog) {
    var tid = adminLog.getAttribute('data-thread');
    var aForm = document.querySelector('[data-admin-form]');
    var aInput = document.querySelector('[data-admin-input]');
    var alog = Log(adminLog, 'admin', null);
    autoGrow(aInput); enterToSend(aInput, aForm);
    sendFrom(aForm, aInput, '/admin/chat/api/threads/' + tid + '/messages', alog, aForm.querySelector('button'));
    document.querySelectorAll('[data-quick]').forEach(function (b) {
      b.addEventListener('click', function () {
        aInput.value = (aInput.value ? aInput.value.trim() + ' ' : '') + b.getAttribute('data-quick');
        aInput.dispatchEvent(new Event('input')); aInput.focus();
      });
    });
    poller(function () {
      return api('GET', '/admin/chat/api/threads/' + tid + '/messages?after=' + alog.last()).then(function (j) {
        var added = alog.addAll(j.messages);
        if (added && !document.hidden) api('POST', '/admin/chat/api/threads/' + tid + '/read').catch(function () {});
        if (added && document.hidden) document.title = '(new) ' + baseTitle;
      });
    }, function () { return 2500; }, 15000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) { document.title = baseTitle; api('POST', '/admin/chat/api/threads/' + tid + '/read').catch(function () {}); } });
    aInput.focus();
  }
})();
