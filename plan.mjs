import { pathToFileURL } from 'node:url';

const moderation = ['ManageMessages', 'ManageThreads', 'ModerateMembers', 'KickMembers'];
export const roles = [
  { key: 'blocked', name: 'Weryfikacja wstrzymana' },
  { key: 'review', name: 'Oczekuje na weryfikację' },
  { key: 'verified', name: 'Zweryfikowany', color: 0x2CA58D },
  { key: 'woman', name: 'Kobieta', group: 'plec', emoji: '♀️' },
  { key: 'man', name: 'Mężczyzna', group: 'plec', emoji: '♂️' },
  { key: 'nonbinary', name: 'Osoba niebinarna', group: 'plec' },
  { key: 'age13', name: '13–17 lat', group: 'wiek' },
  { key: 'age18', name: '18–24 lata', group: 'wiek' },
  { key: 'age25', name: '25–34 lata', group: 'wiek' },
  { key: 'age35', name: '35+ lat', group: 'wiek' },
  { key: 'gaming', name: 'Gaming', group: 'tematy', emoji: '🎮', color: 0x5865F2 },
  { key: 'music', name: 'Muzyka', group: 'tematy', emoji: '🎵', color: 0xB35AB3 },
  { key: 'tech', name: 'Technologia', group: 'tematy', emoji: '💻', color: 0x3498DB },
  { key: 'events', name: 'Powiadomienia o wydarzeniach', group: 'tematy', emoji: '🔔' },
  { key: 'member', name: 'Członek', color: 0x2ECC71 },
  { key: 'vip', name: 'VIP', color: 0xE67E22 },
  { key: 'organizer', name: 'Organizator', color: 0x9B59B6, hoist: true },
  { key: 'helper', name: 'Pomocnik', color: 0x1ABC9C, hoist: true },
  { key: 'mod', name: 'Moderator', color: 0x3498DB, hoist: true, permissions: moderation },
  {
    key: 'admin', name: 'Administrator', color: 0xE74C3C, hoist: true,
    permissions: [...moderation, 'BanMembers', 'ManageGuild', 'ManageChannels', 'ManageRoles'],
  },
];

const roleOrnaments = {
  blocked: '🔒', review: '⏳', verified: '✅',
  woman: '♀️', man: '♂️', nonbinary: '🌈',
  age13: '🗓️', age18: '🗓️', age25: '🗓️', age35: '🗓️',
  gaming: '🎮', music: '🎵', tech: '💻', events: '🔔',
  member: '👥', vip: '💎', organizer: '🎯', helper: '🛟', mod: '🛡️', admin: '👑',
};

export const roleLabel = (role) => `「${roleOrnaments[role.key]}」${role.name}`;

export const roleMenus = [
  { key: 'plec', label: '👤  Płeć (opcjonalnie)', multiple: false },
  { key: 'wiek', label: '🗓️  Przedział wiekowy (opcjonalnie)', multiple: false },
  { key: 'tematy', label: '🎯  Zainteresowania i powiadomienia', multiple: true },
];

export const musicChannelKey = 'music-voice';
export const musicPanelKey = 'music-panel';

export const categories = [
  {
    key: 'live-stats', name: 'STATYSTYKI', access: 'stats',
    channels: [
      { name: 'statsOnline', label: 'Online', voice: true, counter: 'online' },
      { name: 'statsOffline', label: 'Offline', voice: true, counter: 'offline' },
      { name: 'Statystyki', label: 'Osoby', legacyEmoji: '📊', voice: true, counter: 'total',
        legacyCategory: 'voice', layout: 4 },
    ],
  },
  {
    key: 'start', name: '📌 START', access: 'lobby',
    channels: [
      { name: 'start-tutaj', emoji: '👋', topic: 'Pierwsze kroki na serwerze.' },
      { name: 'regulamin', label: 'regulamin-i-weryfikacja', emoji: '📜', layout: 4,
        topic: 'Przeczytaj zasady i zaakceptuj je, żeby odblokować serwer.' },
      { name: 'ogloszenia', emoji: '📣', topic: 'Informacje od ekipy serwera.', access: 'read' },
      { name: 'wybierz-role', emoji: '🎭', topic: 'Panel wyboru ról. Płeć i wiek są dobrowolne.', access: 'read' },
    ],
  },
  {
    key: 'community', name: '💬 SPOŁECZNOŚĆ', access: 'public',
    channels: [
      { name: 'ogolny', emoji: '💬', topic: 'Rozmowy, przedstawianie się i pytania o serwer. Prywatne zgłoszenia znajdziesz w kanale startowym.' },
      { name: 'media-i-memy', emoji: '📸', topic: 'Zdjęcia, klipy z gier i memy.' },
      { name: 'witamy', emoji: '👋', topic: 'Powitania nowych członków i podziękowania za boosty.', access: 'read' },
      { name: 'pozegnania', emoji: '🌙', topic: 'Pożegnania osób, które opuściły serwer.', access: 'read' },
    ],
  },
  {
    key: 'topics', name: '🎮 GRY I EVENTY', legacyName: '🎮 ZAINTERESOWANIA', access: 'public',
    channels: [
      { name: 'gaming', emoji: '🎮', topic: 'Rozmowy o grach, premierach i turniejach.' },
      { name: 'szukam-ekipy', emoji: '🤝', topic: 'Szukasz drużyny? Podaj grę, tryb i godzinę.', legacyCategory: 'projects' },
      { name: 'wydarzenia', emoji: '📅', topic: 'Terminy turniejów, konkursów i wspólnego grania.', access: 'events', legacyCategory: 'events' },
    ],
  },
  {
    key: 'voice', name: '🔊 GŁOSOWE', access: 'voice',
    channels: [
      { name: 'Pogaduchy', emoji: '☕', voice: true },
      { name: 'Duo', emoji: '🎧', voice: true, limit: 2 },
      { name: 'Gramy 1', emoji: '🎮', voice: true, limit: 5 },
      { name: 'Gramy 2', emoji: '🕹️', voice: true, limit: 5 },
      { name: 'Rankedy', emoji: '🏆', voice: true, limit: 5 },
      { name: 'Chill', emoji: '🌙', voice: true },
    ],
  },
  {
    key: 'moderation', name: '🔒 PRYWATNE', legacyName: '🛡️ MODERACJA', access: 'mods',
    channels: [
      { name: 'mod-log', label: 'modzi', emoji: '🛡️', legacyEmoji: '📋', layout: 5,
        topic: 'Prywatny czat moderatorów.' },
      { name: 'panel-moderacji', emoji: '🛠️', topic: 'Panel i narzędzia moderacji.', access: 'logs' },
    ],
  },
  {
    key: 'bot-logs', name: '📋・LOGI BOTA', access: 'logs',
    channels: [
      { name: 'log-wiadomosci', label: 'wiadomosci', emoji: '📝', topic: 'Edycje, usunięcia i czyszczenie wiadomości.' },
      { name: 'log-role', label: 'role', emoji: '🎭', topic: 'Dodawanie, zdejmowanie i zmiany ról.' },
      { name: 'logi-bota', label: 'zmiany-serwera', emoji: '⚙️', legacyEmoji: '📋', legacyCategory: 'moderation',
        layout: 5, topic: 'Zmiany ustawień i kanałów oraz zdarzenia członków serwera.' },
      { name: 'log-ochrona', label: 'ochrona', emoji: '🚨', topic: 'Alerty AutoMod, spam i naloty.' },
      { name: 'log-tickety', label: 'tickety', emoji: '🎫', topic: 'Otwarcia i zamknięcia prywatnych ticketów.' },
      { name: 'log-moderacja', label: 'moderacja', emoji: '🛡️', topic: 'Akcje moderacyjne i decyzje weryfikacyjne.' },
    ],
  },
  {
    key: 'adult', name: '🔞 STREFA 18+', access: 'public',
    channels: [
      { name: 'nsfw', emoji: '🔞', topic: 'Kanał dla dorosłych z ograniczeniem wiekowym Discorda.', adult: true },
    ],
  },
];

export function channelLabel(channel) {
  const name = channel.label ?? channel.name;
  return channel.emoji ? `${channel.emoji}│${name}` : name;
}

export const categoryLabel = (category) => {
  if (category.key === 'live-stats') return category.name;
  if (category.key === 'bot-logs') return `╭━━ ${category.name} ━━╮`;
  const frame = category.key === 'start' ? '╭' : category.key === 'adult' ? '╰' : '├';
  return `${frame}━━ ${category.name} ━━${category.key === 'adult' ? '╯' : '╮'}`;
};

export const starterMessages = {
  'start-tutaj': (channel) => [
    '👋 Witaj na serwerze!',
    `1. Przejdź do ${channel('regulamin')}, przeczytaj zasady i kliknij **Akceptuję regulamin**.`,
    `2. Gdy odblokują się kanały, wybierz role w ${channel('wybierz-role')} i przywitaj się na ${channel('ogolny')}.`,
    `Do wspólnego grania znajdziesz ludzi na ${channel('szukam-ekipy')}. Pod tą kartą możesz prywatnie zgłosić sprawę.`,
  ].join('\n'),
  regulamin: () => [
    '📜 Regulamin i weryfikacja',
    '1. Szanuj innych. Nękanie, groźby i mowa nienawiści są zabronione.',
    '2. Nie spamuj i nie reklamuj bez zgody ekipy.',
    '3. Dbaj o prywatność. Nie publikuj cudzych danych ani prywatnych rozmów bez zgody.',
    '4. Trzymaj się tematu kanału. Nie publikuj treści NSFW ani niebezpiecznych linków.',
    '5. Przestrzegaj zasad Discorda. Naruszenia zgłaszaj przyciskiem **Zgłoś sprawę** w kanale startowym.',
    '6. Materiały dla dorosłych publikuj wyłącznie w kanale oznaczonym jako 18+ i w granicach zasad Discorda.',
    '7. Unikaj masowych oznaczeń, powtarzania wiadomości i obchodzenia blokad. Wiek i płeć podajesz dobrowolnie.',
    '',
    'Kliknij **Akceptuję regulamin**, aby dostać rolę **Zweryfikowany** i odblokować kanały. Nowe konta mogą trafić do ręcznej oceny moderatora.',
  ].join('\n'),
  'wybierz-role': () => [
    '🎭 Wybierz swoje role',
    'Wybierz płeć, przedział wiekowy lub zainteresowania z menu poniżej.',
    'Płeć i wiek są dobrowolne. Każdą z tych ról możesz zdjąć opcją **Bez roli**.',
    'Role widać na profilu serwerowym. Podawaj tylko informacje, którymi chcesz się dzielić.',
    'W ostatnim menu wybierz wszystkie zainteresowania, które chcesz zachować, albo wybierz samo **Bez roli**.',
  ].join('\n'),
  'panel-moderacji': () => [
    '🛡️ Panel moderatorów',
    'Z menu poniżej wybierzesz osobę lub kanał do moderacji.',
  ].join('\n\n'),
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log('Role od najniższej do najwyższej:');
  for (const role of roles) console.log(`- ${roleLabel(role)}${role.group ? ' (do wyboru)' : ''}`);
  console.log('\nKategorie i kanały:');
  for (const category of categories) {
    console.log(categoryLabel(category));
    for (const channel of category.channels) console.log(`  - ${channel.voice ? '' : '#'}${channelLabel(channel)}`);
  }
}
