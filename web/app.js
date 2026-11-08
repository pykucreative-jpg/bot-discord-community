'use strict';
const icons = {
  layout: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M9 10h12"/>', hash: '<path d="M10 3 8 21M16 3l-2 18M4 9h17M3 15h17"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5 9-5ZM3 12l9 5 9-5M3 16l9 5 9-5"/>', cursor: '<path d="m4 3 15 9-7 1-3 7-5-17Z"/>',
  activity: '<path d="M3 12h4l3-7 4 14 3-7h4"/>', eye: '<path d="M2 12s4-6 10-6 10 6 10 6-4 6-10 6-10-6-10-6Z"/><circle cx="12" cy="12" r="2"/>',
  external: '<path d="M13 5h6v6m0-6-9 9m6-2v6H5V7h6"/>', link: '<path d="M10 13a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-2 2m3 5a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6l2-2"/>',
  refresh: '<path d="M19 11a7 7 0 1 0-2 6m2-12v6h-6"/>', users: '<circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2m2-15a3 3 0 0 1 0 6m0 3a5 5 0 0 1 4 5"/>',
  moon: '<path d="M20 15A8 8 0 0 1 9 4a8 8 0 1 0 11 11Z"/>', search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  voice: '<path d="M4 9h4l5-4v14l-5-4H4zm12-1a6 6 0 0 1 0 8m2-10a9 9 0 0 1 0 12"/>',
};
const icon = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || ''}</svg>`;
const $ = (id) => document.getElementById(id);
const elem = (tag, className, text) => { const item = document.createElement(tag); if (className) item.className = className; if (text != null) item.textContent = text; return item; };
document.querySelectorAll('[data-icon]').forEach((node) => { node.innerHTML = icon(node.dataset.icon); });
let toastTimer;
function toast(text) { const note = $('toast'); note.textContent = text; note.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { note.hidden = true; }, 3000); }
async function copyText(text) { try { await navigator.clipboard.writeText(text); toast('Skopiowano'); } catch { toast('Zaznacz tekst i skopiuj ręcznie.'); } }
$('share').addEventListener('click', () => copyText(location.href.split('#')[0]));
const nav = [...document.querySelectorAll('.sidebar nav a')];
const selectNav = () => nav.forEach((link) => link.classList.toggle('selected', link.hash === (location.hash || '#przeglad')));
addEventListener('hashchange', selectNav);
selectNav();

const groups = [
  ['📌 Start', ['start-ticket','regulamin-i-weryfikacja','ogłoszenia','wybierz-role']],
  ['💬 Społeczność', ['ogólny','media-i-memy','witamy','pożegnania','podziękowania za boost','nie-pisz-tutaj']],
  ['🔊 Głosowe', ['Pogaduchy','Duo','Gramy 1','Gramy 2','Rankedy','Chill','Utwórz pokój','AFK'], 'voice'],
  ['🎵 Muzyka', ['panel-muzyki']],
  ['🎲 4FUN', ['liczenie','raz-na-6h','luźne-teksty','gry-i-monety']],
  ['🤝 Partnerstwa', ['nasza-reklama','partnerstwa']],
  ['📊 Statystyki', ['Online','Offline','Osoby'], 'voice'],
  ['🔞 Strefa 18+', ['nsfw']],
  ['🛟 Pomoc i administracja', ['centrum-administracji','panel-moderacji','modzi','archiwum-ticketów'], 'staff'],
  ['🎫 Tickety', ['Prywatne kanały otwartych zgłoszeń'], 'staff'],
  ['📋 Logi bota', ['wiadomości','role','zmiany-serwera','ochrona','tickety','moderacja','wejścia','wyjścia','bany','wyrzucenia','nadane-role','zabrane-role','usunięte-wiadomości','edycje-wiadomości','pseudonimy'], 'staff'],
];
const roleGroups = [
  ['🛡️ Ekipa', 'Moderacja, organizacja i dostęp do logów.', ['Właściciel','Administrator','Moderator','Pomocnik','Organizator']],
  ['💎 Wyróżnienia', 'Rangi przyznawane przez ekipę lub według aktywności.', ['VIP','Członek']],
  ['🎮 Zainteresowania', 'Role do samodzielnego wyboru.', ['Gaming','Muzyka','Technologia','Wydarzenia']],
  ['🎂 Wiek', 'Przedział wiekowy wybierany dobrowolnie.', ['13–17','18–24','25–34','35+']],
  ['👤 Tożsamość', 'Opcjonalne role profilu.', ['Kobieta','Mężczyzna','Osoba niebinarna']],
  ['🔐 Weryfikacja', 'Akceptacja zasad i kod przed odblokowaniem kanałów.', ['Zweryfikowany','Oczekuje','Wstrzymana']],
  ['🏅 Poziomy', 'Rangi za XP z czatu i aktywności na głosowym.', ['Poziom 5','Poziom 10','Poziom 20','Poziom 40']],
  ['🤝 Partnerzy', 'Miejsce na role partnerskich serwerów.', ['Separator Partnerzy']],
];
const services = [
  ['lock','Weryfikacja','Regulamin, kod i ręczna ocena wybranych kont.'],
  ['layers','Role i poziomy','Wybór ról, ozdobne separatory oraz XP za aktywność.'],
  ['hash','Tickety i archiwum','Prywatna rozmowa, transkrypt, link w logach i usunięcie kanału po zapisie.'],
  ['activity','Ochrona i logi','Antyspam, ostrzeżenia, logi działań i alerty dla moderacji.'],
  ['voice','Pokoje i AFK','Pokoje tworzone przy wejściu. Discord przenosi nieaktywnych do AFK po 5 minutach.'],
  ['users','Witamy, pożegnania i boosty','Karty powitalne, logi członków i podziękowania za wsparcie.'],
  ['cursor','Jockie Music','Panel przygotowuje komendy muzyczne do wysłania na Discordzie.'],
  ['moon','4FUN i partnerstwa','Liczenie, gra w 21, monety i strefa partnerska.'],
];
const plain = (value) => value.toLowerCase().normalize('NFKD').replace(/\p{M}/gu,'');
let filter = 'all';
function channels() {
  const query = plain($('channel-search').value.trim());
  const content = [];
  for (const [title, names, kind = 'text'] of groups) {
    if (filter !== 'all' && filter !== kind && !(filter === 'text' && kind === 'staff')) continue;
    const matches = names.filter((name) => plain(title).includes(query) || plain(name).includes(query));
    if (!matches.length) continue;
    const card = elem('article','channel-card');
    card.append(elem('h3','',title));
    const list = elem('ul');
    for (const name of matches) {
      const li = elem('li');
      li.innerHTML = icon(kind === 'voice' ? 'voice' : kind === 'staff' ? 'lock' : 'hash');
      li.append(elem('span','',name));
      list.append(li);
    }
    card.append(list);
    content.push(card);
  }
  $('channel-list').replaceChildren(...(content.length ? content : [elem('p','empty','Brak kanałów pasujących do filtra.')]));
}
channels();
$('channel-search').addEventListener('input',channels);
$('channel-filters').addEventListener('click',(event) => {
  const button = event.target.closest('[data-filter]');
  if (!button) return;
  filter = button.dataset.filter;
  $('channel-filters').querySelectorAll('button').forEach((item) => item.setAttribute('aria-pressed',String(item === button)));
  channels();
});
for (const [title, description, names] of roleGroups) {
  const card = elem('article','role-card');
  const pills = elem('div','role-pills');
  pills.append(...names.map((name) => elem('span','',name)));
  card.append(elem('h3','',title),elem('p','',description),pills);
  $('role-list').append(card);
}
for (const [symbol,title,description] of services) {
  const item = elem('div','service');
  const symbolBox = elem('span','metric-icon violet');
  symbolBox.innerHTML = icon(symbol);
  const text = elem('div');
  text.append(elem('b','',title),elem('p','',description));
  const tag = elem('em','', 'Wdrożone');
  tag.prepend(elem('span','dot'));
  item.append(symbolBox,text,tag);
  $('service-list').append(item);
}

const demo = {
  'Weryfikacja': ['regulamin-i-weryfikacja','🔐 Regulamin i weryfikacja','Po zaakceptowaniu zasad bot poprosi o jednorazowy kod.',[
    ['Akceptuję regulamin',() => {
      const code = String(Math.floor(10000 + Math.random()*90000));
      const input = elem('input');input.placeholder = 'Wpisz kod';input.inputMode = 'numeric';input.maxLength = 5;input.setAttribute('aria-label','Kod weryfikacji');
      const submit = action('Potwierdź',() => result(input.value.trim() === code ? '✓ W symulacji nadano rolę Zweryfikowany i odblokowano kanały.' : 'Kod się nie zgadza. Spróbuj jeszcze raz.'),true);
      $('demo-detail').replaceChildren(elem('p','',`Kod demonstracyjny: ${code}`),input,submit);input.focus();
    }]]],
  'Wybór ról': ['wybierz-role','🎭 Dopasuj swój profil','Wybierz opcjonalne role i zainteresowania.',[
    ['Pokaż wybór ról',() => {
      const select = elem('select');select.setAttribute('aria-label','Przykładowe role');
      for (const role of ['Gaming','Muzyka','Technologia','Kobieta','Mężczyzna','18–24 lata','25–34 lata']) select.append(new Option(role,role));
      $('demo-detail').replaceChildren(select,action('Zapisz wybór',() => result(`✓ Przykładowa rola: ${select.value}.`),true));select.focus();
    }]]],
  'Tickety': ['start-ticket','📨 Zgłoszenie do ekipy','Rozmowa odbywa się w prywatnym kanale zgłoszenia.',[
    ['Zgłoś sprawę',() => result('✓ Otwarto przykładowy ticket. Zgłaszający i moderacja mogą rozmawiać w osobnym kanale.')],
    ['Zamknij zgłoszenie',() => result('✓ Przykładowy zapis: rozmowa → prywatne archiwum → link w logu → usunięcie kanału.')]]],
  'Muzyka': ['panel-muzyki','🎧 Jockie Music','Wybierz akcję i skopiuj komendę do kanału na Discordzie.',[
    ['Dodaj utwór',() => {
      const input = elem('input');input.placeholder = 'Tytuł lub link Spotify';input.setAttribute('aria-label','Tytuł lub link');
      $('demo-detail').replaceChildren(input,action('Przygotuj komendę',() => result(input.value.trim() ? `Komenda: m!play ${input.value.trim()}` : 'Wpisz tytuł albo link.'),true));input.focus();
    }],['Kolejka',() => result('Komenda: m!queue')],['Pauza',() => result('Komenda: m!pause')],['Wznów',() => result('Komenda: m!resume')],['Pomiń',() => result('Komenda: m!skip')]]],
  'Gry i XP': ['gry-i-monety','🪙 Gry i monety','Przykładowy profil i wirtualne monety.',[
    ['Mój poziom',() => result('Przykładowy profil · Poziom 5 · 2500 XP · 120 monet.')],
    ['Dzienna wypłata',() => result('✓ Przykładowe saldo wzrosło o 100 monet.')],
    ['Zagraj w 21',() => result('Przykładowa ręka: 10 + 7. W Discordzie możesz dobrać kartę lub spasować.')]]],
  'Moderacja': ['panel-moderacji','🛡️ Centrum moderacji','Zarządzanie zgłoszeniami, wiadomościami i dostępem członków.',[
    ['Pokaż działania',() => result('Przykładowe działania: ostrzeżenie, wyciszenie, wyrzucenie, ban i czyszczenie wiadomości.')],
    ['Sprawdź logi',() => result('Przykładowy wpis: czas · wykonawca · osoba · akcja · powód.')]]],
};
function result(text) { $('demo-result').textContent = text; }
function action(label, callback, primary) {
  const button = elem('button',`button ${primary ? 'primary' : 'quiet'}`,label);button.type = 'button';button.addEventListener('click',callback);return button;
}
function selectDemo(key) {
  const [channel,title,description,actions] = demo[key];
  $('demo-channel').textContent = channel;$('demo-title').textContent = title;$('demo-description').textContent = description;
  $('demo-detail').replaceChildren();result('');
  $('demo-buttons').replaceChildren(...actions.map(([label,handler],i) => action(label,handler,i === 0)));
  $('demo-nav').querySelectorAll('button').forEach((button) => button.setAttribute('aria-pressed',String(button.textContent === key)));
}
for (const key of Object.keys(demo)) {
  const button = elem('button','demo-tab',key);button.type = 'button';button.addEventListener('click',() => selectDemo(key));$('demo-nav').append(button);
}
selectDemo('Weryfikacja');

let fetching = false;
async function stats() {
  if (fetching) return;
  fetching = true;$('refresh').disabled = true;
  const indicator = (text, tone) => $('stats-info').replaceChildren(elem('span',`dot ${tone}`),document.createTextNode(text));
  try {
    const response = await fetch('https://discord.com/api/v10/invites/hCX7cwZ55q?with_counts=true',{signal:AbortSignal.timeout(8000)});
    if (!response.ok) throw new Error('Discord');
    const data = await response.json();
    const total = data.approximate_member_count, online = data.approximate_presence_count;
    if (!Number.isInteger(total) || !Number.isInteger(online) || data.guild?.id !== '1568431258550272081') throw new Error('Liczniki');
    $('count-total').textContent = total.toLocaleString('pl-PL');
    $('count-online').textContent = online.toLocaleString('pl-PL');
    $('count-offline').textContent = Math.max(0,total-online).toLocaleString('pl-PL');
    indicator(`Dane przybliżone z Discorda · ${new Date().toLocaleTimeString('pl-PL',{hour:'2-digit',minute:'2-digit'})}`,'');
  } catch {
    indicator($('count-total').textContent === '—' ? 'Liczniki Discorda chwilowo niedostępne.' : 'Pokazuję ostatni odczyt. Discord chwilowo nie odpowiada.','off');
  } finally { fetching = false;$('refresh').disabled = false; }
}
$('refresh').addEventListener('click',stats);stats();setInterval(() => { if (!document.hidden) stats(); },60000);
