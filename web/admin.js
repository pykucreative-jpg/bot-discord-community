'use strict';
(() => {
  const apiOrigin = 'https://bot-discord-community-production.up.railway.app';
  const find = (id) => document.getElementById(id);
  const flag = find('admin-status');
  const storageKey = 'pg-admin-session';
  let secret = sessionStorage.getItem(storageKey);
  let inventory;
  let pending;
  let timer;
  let older;
  const status = (text) => { flag.textContent = text; };
  const post = (data = {}) => ({ method: 'POST', body: JSON.stringify(data) });
  const showLogin = () => {
    find('admin-login').hidden = false;
    find('admin-console').hidden = true;
    find('login-challenge').hidden = true;
    find('admin-messages').replaceChildren();
    find('admin-members').replaceChildren();
    find('member-tools').hidden = true;
    find('mod-reason').value = '';
  };
  function clearSession() {
    clearTimeout(timer);
    pending = undefined;
    secret = null;
    inventory = undefined;
    sessionStorage.removeItem(storageKey);
    showLogin();
  }
  async function api(path, options = {}) {
    const response = await fetch(apiOrigin + '/v1' + path, {
      ...options,
      headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(secret ? { Authorization: `Bearer ${secret}` } : {}) },
      signal: AbortSignal.timeout(12000),
    });
    const data = await response.json();
    if (response.status === 401 && secret) clearSession();
    if (!response.ok) throw new Error(data.error || 'Serwis chwilowo nie odpowiada.');
    return data;
  }
  function use(id, event, handler) {
    const target = find(id);
    target.addEventListener(event, async (e) => {
      e.preventDefault();
      const control = target.tagName === 'BUTTON' ? target : target.querySelector('button[type=submit], button:not([type])');
      if (control?.disabled) return;
      if (control) control.disabled = true;
      try { await handler(e); } catch (error) { status(error.message); }
      finally { if (control) control.disabled = false; }
    });
  }
  const selectedRole = () => inventory?.roles.find(({ id }) => id === find('admin-roles').value);
  const selectedChannel = () => inventory?.channels.find(({ id }) => id === find('admin-channels').value);
  function options(select, items, label) {
    const previous = select.value;
    select.replaceChildren(...items.map((item) => new Option(label(item), item.id)));
    if (items.some(({ id }) => id === previous)) select.value = previous;
  }
  function roleFields() {
    const role = selectedRole();
    const field = find('role-perms');
    field.replaceChildren();
    for (const [key, name] of Object.entries(inventory.permissionNames)) {
      const label = document.createElement('label');
      const box = document.createElement('input');
      box.type = 'checkbox'; box.value = key; box.checked = role?.permissions.includes(key) ?? false; box.disabled = !role?.editable;
      label.append(box, name);field.append(label);
    }
    find('role-edit').querySelector('button').disabled = !role?.editable;
    find('role-details').hidden = !role?.editable;
    find('role-name').value = role?.name ?? '';
    find('role-color').value = role?.color ?? '#000000';
    find('role-help').textContent = role?.editable ? 'Zmiany obowiązują całą wybraną rolę.' : 'Tę rolę ogranicza hierarchia lub zarządza nią integracja.';
  }
  function channelFields() {
    const channel = selectedChannel();
    find('channel-edit').hidden = !channel?.editable || channel.ticket;
    find('channel-access-panel').hidden = !channel?.editable || channel.ticket;
    find('channel-access-panel').open = false;
    find('ticket-close').hidden = !channel?.ticket;
    find('load-messages').hidden = !channel?.text;
    find('channel-topic-field').hidden = !channel?.text;
    find('channel-slow-field').hidden = !channel?.text;
    find('channel-name').value = channel?.name ?? '';
    find('channel-topic').value = channel?.topic ?? '';
    find('channel-slow').value = channel?.slow ?? 0;
    find('admin-messages').replaceChildren();
    find('older-messages').hidden = true;
    older = undefined;
  }
  async function overview() {
    inventory = await api('/overview');
    find('admin-actor').textContent = `Zalogowano jako ${inventory.actor}`;
    options(find('admin-channels'), inventory.channels, (item) => `${item.category ? '▤' : item.text ? '#' : '◖'} ${item.name}${item.group ? ' · ' + item.group : ''}`);
    options(find('new-channel-parent'), [{id:'',name:'Bez kategorii'}, ...inventory.channels.filter(({category}) => category)], (item) => item.name);
    options(find('admin-roles'), inventory.roles, (item) => item.name);
    options(find('channel-access-role'), [{id:inventory.everyone,name:'@everyone'}, ...inventory.roles.filter(({editable}) => editable)], (item) => item.name);
    options(find('channel-access-permission'), inventory.channelPermissions.map((id) => ({id,name:inventory.permissionNames[id]})), (item) => item.name);
    roleFields();channelFields();
    find('admin-login').hidden = true;
    find('admin-console').hidden = false;
    status('Połączono z Discordem. Zmiany w tej sekcji są wykonywane na serwerze.');
  }
  async function checkLogin(challenge) {
    if (pending !== challenge) return;
    try {
      const result = await api('/login/check', post({ key: challenge.key }));
      if (pending !== challenge) return;
      if (result.pending) { timer = setTimeout(() => checkLogin(challenge), 2200); return; }
      pending = undefined;
      secret = result.token;
      sessionStorage.setItem(storageKey,secret);
      await overview();
    } catch (error) {
      pending = undefined;
      find('login-challenge').hidden = true;
      status(error.message);
    }
  }
  use('login-start','click',async () => {
    clearTimeout(timer);
    pending = undefined;
    const challenge = await api('/login', post());
    pending = challenge;
    find('login-code').textContent = challenge.code;
    find('login-challenge').hidden = false;
    status('W Discordzie wpisz komendę /panel-login i wklej kod do pola „kod”. Kod jest ważny 2 minuty.');
    timer = setTimeout(() => checkLogin(challenge), 1800);
  });
  use('login-copy','click',async () => {
    if (pending) await navigator.clipboard.writeText(pending.code);
    status('Kod skopiowany. Wklej go w komendzie /panel-login.');
  });
  use('logout','click',async () => {
    try { await api('/logout', post()); } finally { clearSession(); status('Wylogowano.'); }
  });
  use('admin-refresh','click',overview);
  find('admin-roles').addEventListener('change',roleFields);
  find('admin-channels').addEventListener('change',channelFields);
  async function loadMessages(append) {
    const channel = selectedChannel();
    if (!channel?.text) return;
    const query = new URLSearchParams({channel: channel.id});
    if (append && older) query.set('before',older);
    const { messages, before } = await api('/messages?' + query);
    if (selectedChannel()?.id !== channel.id) return;
    older = before;
    find('older-messages').hidden = !older;
    const list = find('admin-messages');
    if (!append) list.replaceChildren();
    for (const message of messages) {
      const entry = document.createElement('article'); entry.className = 'admin-message';
      const author = document.createElement('strong'); author.textContent = message.author;
      const date = document.createElement('small'); date.textContent = new Date(message.at).toLocaleString('pl-PL');
      const content = document.createElement('p'); content.textContent = [message.text, ...message.embeds,
        ...message.attachments.map((name) => '📎 ' + name)].filter(Boolean).join('\n') || 'Wiadomość systemowa';
      const remove = document.createElement('button');
      remove.className = 'small-button'; remove.type = 'button'; remove.textContent = 'Usuń wiadomość';
      remove.addEventListener('click', async () => {
        if (!confirm(`Trwale usunąć tę wiadomość z #${channel.name}?`)) return;
        remove.disabled = true;
        try {
          await api('/messages/delete',post({channel:channel.id,message:message.id}));
          entry.remove();status('Usunięto wiadomość.');
        } catch (error) { status(error.message);remove.disabled = false; }
      });
      entry.append(author,date,content,remove);list.append(entry);
    }
    if (!messages.length && !append) list.textContent = 'Brak wiadomości w tym kanale.';
    status(`Pobrano ${messages.length} wiadomości z #${channel.name}.`);
  }
  use('load-messages','click',() => loadMessages(false));
  use('older-messages','click',() => loadMessages(true));
  async function accessFields() {
    const channel = selectedChannel();
    const role = find('channel-access-role').value;
    const permission = find('channel-access-permission').value;
    const current = find('channel-access-current');
    find('channel-access-state').value = '';
    current.textContent = 'Sprawdzam ustawienie…';
    try {
      const result = await api('/channels/access?' + new URLSearchParams({channel:channel.id,role}));
      if (channel.id !== selectedChannel()?.id || role !== find('channel-access-role').value || permission !== find('channel-access-permission').value) return;
      const labels = {inherit:'Bez nadpisania', allow:'Zezwól', deny:'Zabroń'};
      current.textContent = 'Obecnie: ' + labels[result[permission]];
    } catch (error) { current.textContent = error.message; }
  }
  find('channel-access-panel').addEventListener('toggle', (event) => { if (event.currentTarget.open) accessFields(); });
  for (const id of ['channel-access-role','channel-access-permission']) find(id).addEventListener('change',accessFields);
  use('channel-access','submit',async () => {
    const channel = selectedChannel();
    const role = find('channel-access-role');
    const access = find('channel-access-state').value;
    if (!access || !confirm(`Zmienić dostęp roli „${role.selectedOptions[0].textContent}” w „${channel.name}”?`)) return;
    await api('/channels/access',post({channel:channel.id,role:role.value,permission:find('channel-access-permission').value,access}));
    await accessFields();status('Zapisano dostęp do kanału.');
  });
  use('ticket-close','click',async () => {
    const channel = selectedChannel();
    if (!channel?.ticket || !confirm(`Zamknąć i zapisać w archiwum zgłoszenie „${channel.name}”?`)) return;
    const result = await api('/tickets/close',post({channel:channel.id}));
    await overview();status(result.message);
  });
  find('new-channel-kind').addEventListener('change', () => {
    const parent = find('new-channel-parent');
    parent.disabled = find('new-channel-kind').value === 'category';
    if (parent.disabled) parent.value = '';
  });
  use('channel-create','submit',async () => {
    const name = find('new-channel-name');
    const result = await api('/channels/create',post({name:name.value,kind:find('new-channel-kind').value,parent:find('new-channel-parent').value}));
    name.value = '';await overview();find('admin-channels').value = result.id;channelFields();status('Utworzono kanał.');
  });
  use('channel-delete','click',async () => {
    const channel = selectedChannel();
    if (!channel?.editable || !confirm(`Trwale usunąć „${channel.name}” z Discorda?`)) return;
    await api('/channels/delete',post({channel:channel.id}));
    await overview();status('Usunięto kanał.');
  });
  use('channel-edit','submit',async () => {
    const channel = selectedChannel();
    if (!channel?.editable || !confirm(`Zapisać zmiany kanału #${channel.name} na Discordzie?`)) return;
    await api('/channels/edit',post({channel:channel.id,name:find('channel-name').value,topic:find('channel-topic').value,slow:find('channel-slow').value}));
    await overview();status('Zapisano kanał na Discordzie.');
  });
  use('role-edit','submit',async () => {
    const role = selectedRole();
    if (!role?.editable || !confirm(`Zapisać uprawnienia roli „${role.name}” na Discordzie?`)) return;
    const permissions = [...find('role-perms').querySelectorAll('input:checked')].map(({value}) => value);
    await api('/roles/permissions',post({role:role.id,permissions}));
    await overview();status('Zapisano uprawnienia roli.');
  });
  use('role-create','submit',async () => {
    const name = find('new-role-name');
    const result = await api('/roles/create',post({name:name.value,color:find('new-role-color').value}));
    name.value = '';await overview();find('admin-roles').value = result.id;roleFields();status('Utworzono rolę.');
  });
  use('role-details','submit',async () => {
    const role = selectedRole();
    if (!role?.editable) return;
    await api('/roles/edit',post({role:role.id,name:find('role-name').value,color:find('role-color').value}));
    await overview();status('Zapisano nazwę i kolor roli.');
  });
  use('role-delete','click',async () => {
    const role = selectedRole();
    if (!role?.editable || !confirm(`Trwale usunąć rolę „${role.name}” wraz z jej nadaniami?`)) return;
    await api('/roles/delete',post({role:role.id}));
    await overview();status('Usunięto rolę.');
  });
  use('member-search','submit',async () => {
    const {members} = await api('/members?' + new URLSearchParams({q:find('member-query').value}));
    options(find('admin-members'),members,(item) => item.name);
    find('member-tools').hidden = !members.length;
    status(members.length ? `Wyniki: ${members.length}.` : 'Brak wyników.');
  });
  for (const [id,add] of [['role-add',true],['role-remove',false]]) {
    use(id,'click',async () => {
      const role = selectedRole();
      const member = find('admin-members');
      if (!role?.editable || !member.value || !confirm(`${add ? 'Nadać' : 'Zdjąć'} rolę „${role.name}” dla ${member.selectedOptions[0].textContent}?`)) return;
      await api('/roles/member',post({role:role.id,member:member.value,add}));
      status(add ? 'Nadano rolę.' : 'Zdjęto rolę.');
    });
  }
  use('member-moderation','submit',async () => {
    const member = find('admin-members');
    const mode = find('mod-action');
    if (!member.value || !confirm(`Wykonać „${mode.selectedOptions[0].textContent}” dla ${member.selectedOptions[0].textContent}?`)) return;
    await api('/moderation',post({member:member.value,action:mode.value,reason:find('mod-reason').value}));
    find('mod-reason').value = '';status('Akcja została zapisana na Discordzie.');
  });
  if (secret) overview().catch((error) => { clearSession();status(error.message); });
  const botRow = elem('div','service');
  const botIcon = elem('span','metric-icon violet');botIcon.innerHTML = icon('activity');
  const botText = elem('div');botText.append(elem('b','','Połączenie bota'),elem('p','','Stan połączenia z Discordem.'));
  const botBadge = elem('em','','Sprawdzam…');botRow.append(botIcon,botText,botBadge);find('service-list').prepend(botRow);
  async function botStatus() {
    try { const result = await api('/health');botBadge.textContent = result.online ? '● Online' : '○ Offline'; }
    catch { botBadge.textContent = '○ Status niedostępny'; }
  }
  botStatus();setInterval(() => { if (!document.hidden) botStatus(); },60000);
})();
