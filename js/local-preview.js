// Local-only test harness. No Gist token, no cloud writes, shared route across role tabs.
if (LOCAL_PREVIEW) {
  document.addEventListener('DOMContentLoaded', function() {
    var bar = document.createElement('div');
    bar.className = 'local-preview-bar';
    bar.innerHTML = '<span>Локально · без записи в облако</span>'
      + (PREVIEW_ROLE === 'admin' ? '<button class="publication-btn" id="loadLocalHistory">Мой маршрут · восстановленная копия</button>' : '')
      + '<div class="preview-roles" role="group" aria-label="Режим проверки">'
      + Object.entries({admin:'Владелец',reader:'Читатель',spectator:'Зритель'}).map(function(pair) {
        return '<button type="button" class="preview-role-btn" data-role="' + pair[0] + '" aria-pressed="' + (PREVIEW_ROLE === pair[0]) + '">' + pair[1] + '</button>';
      }).join('') + '</div>';
    document.body.prepend(bar);
    document.body.classList.add('local-preview');
    var loadHistory = document.getElementById('loadLocalHistory');
    if (loadHistory) loadHistory.addEventListener('click', async function() {
      try {
        var response = await fetch('./local-route.json', {cache:'no-store'});
        if (!response.ok) throw new Error('Локальная копия маршрута недоступна');
        var payload = await response.json();
        localStorage.setItem(routeStorageKey(), JSON.stringify(payload));
        location.href = location.pathname + '?preview=admin';
      } catch(e) { showToast(e.message); }
    });
    bar.querySelectorAll('[data-role]').forEach(function(button) {
      button.addEventListener('click', function() {
        location.href = location.pathname + '?preview=' + button.dataset.role + (button.dataset.role === 'spectator' ? '&chat=0' : '');
      });
    });
    var badge = document.getElementById('modeBadge');
    if (badge) badge.textContent = {admin:'локально · владелец',reader:'локально · читатель',spectator:'локально · зритель'}[PREVIEW_ROLE];
    var changelog = document.getElementById('changelogModal');
    if (changelog) changelog.classList.remove('show');
  });
  window.addEventListener('storage', function(event) {
    if (event.key === routeStorageKey() && PREVIEW_ROLE !== 'admin') location.reload();
  });
}
