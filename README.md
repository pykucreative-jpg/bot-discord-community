# Centrum społeczności graczy · Bot Discord

Konfigurator tworzy **20 ról, 7 kategorii i 23 kanały**. Jest sześć pokojów do rozmów i grania oraz trzy zablokowane kanały głosowe z licznikami. Bot publikuje karty powitania, wspólnego regulaminu z weryfikacją i wyboru ról. Kanały, role i uprawnienia działają po wyłączeniu programu. Komendy, liczniki i obsługa zdarzeń wymagają uruchomionego bota.

Po uruchomieniu bot sam buduje lub uzupełnia serwer, włącza brakujące reguły AutoMod, ustawia powiadomienia o boostach i sprawdza, czy panele nadal istnieją. W trakcie pracy reaguje na zdarzenia serwera i odświeża liczniki. Członkowie korzystają z przycisków i menu, a nietypowe zgłoszenia weryfikacyjne rozpatruje moderator.

## Układ serwera

| Kategoria | Zawartość |
| --- | --- |
| STATYSTYKI | Na samej górze, w kolejności Online, Offline i Osoby. |
| ╭─ 📌 START ─╮ | 👋│start-tutaj, 📜│regulamin-i-weryfikacja, 📣│ogloszenia, 🎭│wybierz-role |
| ├─ 💬 SPOŁECZNOŚĆ ─╮ | 💬│ogolny, 📸│media-i-memy, 👋│witamy z podziękowaniami za boosty oraz 🌙│pozegnania. |
| ├─ 🎮 GRY I EVENTY ─╮ | 🎮│gaming, 🤝│szukam-ekipy i 📅│wydarzenia na turnieje, konkursy i wspólne granie. |
| ├─ 🔊 GŁOSOWE ─╮ | ☕│Pogaduchy, 🎧│Duo (2), 🎮│Gramy 1 (5), 🕹️│Gramy 2 (5), 🏆│Rankedy (5) i 🌙│Chill. |
| ├─ 🔒 PRYWATNE ─╮ | 🛡️│modzi na rozmowy, zgłoszenia i kolejkę weryfikacji. 📋│logi-bota to osobny kanał na zdarzenia i alerty, do odczytu dla moderacji. |
| ╰─ 🔞 STREFA 18+ ─╯ | 🔞│nsfw z natywnym oznaczeniem kanału ograniczonego wiekowo. |

Przed weryfikacją nowi członkowie widzą w utworzonej strukturze powitanie oraz wspólny kanał regulaminu i weryfikacji. Po kliknięciu **Akceptuję regulamin** dostają rolę **Zweryfikowany**, która odblokowuje kanały członkowskie. Konto młodsze niż 7 dni lub weryfikacja podczas wykrytej fali dołączeń trafia do kolejki moderacji. Fala to co najmniej 6 dołączeń osób w 20 sekund. Wykrycie włącza ręczną ocenę na 10 minut. Zgłoszenie w kolejce zostaje oznaczone osobną rolą także po restarcie.

W 🎭│wybierz-role są trzy menu. **Płeć** obejmuje Kobietę, Mężczyznę i Osobę niebinarną. **Wiek** obejmuje 13–17, 18–24, 25–34 i 35+. W **zainteresowaniach** są Gaming, Muzyka, Technologia i Powiadomienia o wydarzeniach. Płeć i wiek są dobrowolne, widoczne w profilu serwerowym i usuwalne opcją **Bez roli**. Role z menu są deklaracjami. Dostęp do treści 18+ dodatkowo sprawdza sam Discord za pomocą [ograniczenia wieku kanału](https://support.discord.com/hc/en-us/articles/115000084051-Age-Restricted-Channels-and-Content).

Rangi ekipy to **Administrator**, **Moderator**, **Pomocnik** i **Organizator**. **VIP** i **Członek** są wyróżnieniami. Właściciel nadaje je przez /serwer-rola. Osoby z uprawnieniem Administrator w samym Discordzie mają wbudowane prawo pomijania ograniczeń kanałów.

## Instalacja na Windows

1. Zainstaluj [Node.js](https://nodejs.org/en/download) w wersji co najmniej 24.17. Rozpakuj paczkę. Otwórz rozpakowany folder w Eksploratorze i wybierz **Otwórz w Terminalu**, a następnie wpisz:

       npm.cmd ci

2. W [Discord Developer Portal](https://discord.com/developers/applications) utwórz aplikację. Skopiuj jej **Application ID** z **General Information**. Włącz **Guild Install** w zakładce **Installation**. W zakładce **Bot** włącz **Server Members Intent** i **Presence Intent** oraz wygeneruj token. Dzięki tym ustawieniom bot odbiera zdarzenia członkostwa i może liczyć statusy online. Zachowaj token dla siebie.
3. Wygeneruj link instalacyjny poleceniem poniżej i otwórz go w przeglądarce. Dodaj bota do serwera jako jego właściciel. Przy aktualizacji wcześniejszej wersji wygeneruj link ponownie, aby nadać botu również nowe uprawnienia do odczytu audytu. Rola bota powinna znajdować się wyżej niż role osób, którymi ma zarządzać.

       node bot.mjs --link WSTAW_ID_APLIKACJI

4. W Discordzie włącz **Ustawienia użytkownika → Zaawansowane → Tryb dewelopera**. Kliknij prawym przyciskiem ikonę serwera i wybierz **Kopiuj identyfikator serwera**. W terminalu wpisz:

       Copy-Item .env.example .env
       notepad .env

   Wstaw token po DISCORD_TOKEN= oraz identyfikator serwera po DISCORD_GUILD_ID=. Zapisz i uruchom:

       npm.cmd start

5. Poczekaj na komunikat „Gotowe” w terminalu. Bot utworzy strukturę, opublikuje karty i spróbuje włączyć reguły AutoMod. Otwórz 👋│start-tutaj, by zobaczyć panel członkowski, oraz 🛡️│modzi, by zobaczyć panel moderatorów. Bot przypina panel moderatorów, jeśli ma uprawnienie do przypinania wiadomości.
6. Jeśli zastępujesz wcześniejszy układ, jako właściciel użyj **/serwer-porzadki podglad**. Sprawdź listę w prywatnym załączniku, a następnie potwierdź komendą **/serwer-porzadki usun** z kodem. Potwierdzenie jest przypisane do osoby, która otworzyła podgląd, i wygasa po 5 minutach. Usunięcie kanału usuwa jego historię, wątki i posty na forum. Jeśli lista się zmieni, bot poprosi o nowy podgląd. Jeżeli Discord zatrzyma operację na chronionym kanale, odpowiedź poda liczbę już usuniętych elementów.

Opcjonalnie ustaw `DISCORD_CLEANUP_ROLE_ID` na identyfikator istniejącej roli uprawnionej do sprzątania. Jej posiadacze mogą użyć /serwer-porzadki na kanale, na którym mają dostęp do komend. Bot sprawdza rolę przy podglądzie i przy potwierdzeniu. Delegacja obejmuje wyłącznie sprzątanie przez bota. Czyszczenie dotyczy kanałów i kategorii, a role pozostają na serwerze. Opcjonalna zmienna `DISCORD_CLEANUP_ROLE_NAME` zmienia nazwę wskazanej roli, jeśli bot ma uprawnienia do jej edycji.

## Wdrożenie na Railway

Wdróż repozytorium jako jedną usługę z Dockerfile. Bot łączy się z Discordem jako proces w tle, więc nie potrzebuje publicznej domeny ani portu HTTP. Do usługi podepnij trwały dysk z punktem montowania `/data`. Railway przekazuje jego ścieżkę przez `RAILWAY_VOLUME_MOUNT_PATH`. W **Variables** usługi ustaw `DISCORD_TOKEN` i `DISCORD_GUILD_ID`, a następnie zastosuj zmiany. Klucz dostępu wpisuj bezpośrednio w Railway.

Jeśli bot wcześniej budował ten sam serwer lokalnie, przed pierwszym startem na Railway przenieś zapisany plik `data/<ID-serwera>.json` na dysk Railway i wyłącz lokalną kopię. Dzięki zapisanym identyfikatorom bot rozpozna istniejący układ.

## Obsługa z paneli

| Gdzie | Co można zrobić |
| --- | --- |
| 👋│start-tutaj | **Zgłoś sprawę** otwiera prywatny formularz. |
| 📜│regulamin-i-weryfikacja | **Akceptuję regulamin** uruchamia automatyczną ocenę konta. |
| 🎭│wybierz-role | Menu nadają i zdejmują role społecznościowe. |
| 🛡️│modzi, karta zgłoszenia weryfikacyjnego | **Zatwierdź dostęp** lub **Wstrzymaj dostęp**. |
| 🛡️│modzi, panel moderatorów | Stan serwera, formularze ogłoszeń i wydarzeń oraz wybór osoby do ostrzeżenia, timeoutu, wyrzucenia, bana lub zmiany weryfikacji. Są też formularze odbanowania i czyszczenia wiadomości. Właściciel może zmieniać rangi. |

## Opcjonalne komendy

Nowa instalacja domyślnie używa paneli. Aby zarejestrować również poniższe komendy awaryjne, ustaw **DISCORD_SLASH_COMMANDS=true** w pliku .env i uruchom bota ponownie. Jeśli aplikacja miała już komendy z wcześniejszej instalacji, mogą nadal być dostępne na Discordzie.

| Komenda | Działanie |
| --- | --- |
| **/serwer-plan** | Pokazuje plan budowy i liczbę zmian aktualizacyjnych. |
| **/serwer-zbuduj** | Tworzy lub aktualizuje strukturę oraz próbuje włączyć ochronę AutoMod. |
| **/serwer-porzadki podglad / usun** | Pokazuje listę starych kanałów i usuwa ją po potwierdzeniu. |
| **/serwer-ochrona** | Po wpisaniu WLACZ dodaje brakujące reguły AutoMod dla spamu i masowych oznaczeń. Istniejące reguły zachowują swoje ustawienia. |
| **/serwer-boosty** | Po wpisaniu WLACZ ustawia 👋│witamy jako kanał systemowy Discorda, włącza tam systemowe powiadomienia o boostach i wycisza systemowe powitania. |
| **/serwer-rola** | Nadaje lub zdejmuje rangę ekipy albo wyróżnienie. |
| **/weryfikacja status** | Pokazuje własny status. |
| **/weryfikacja zatwierdz / wstrzymaj / odblokuj** | Moderator rozpatruje zgłoszenie, wstrzymuje dostęp lub umożliwia ponowne podejście. |
| **/moderacja ostrzez / timeout / untimeout** | Ostrzega użytkownika i zarządza ograniczeniem czasowym. |
| **/moderacja wyrzuc / zbanuj / odbanuj** | Wyrzuca, banuje lub odbanowuje po ID. |
| **/moderacja wyczysc** | Usuwa do 100 ostatnich wiadomości z kanału. Discord stosuje limit wieku 14 dni. |
| **/ogloszenie** | Publikuje kolorową kartę w ogłoszeniach lub wydarzeniach. Wymaga prawa pisania w wybranym kanale. |
| **/zglos** | Wysyła prywatne zgłoszenie z identyfikatorem autora do moderacji. |
| **/statystyki** | Podaje liczbę kont na serwerze oraz liczbę online i offline. |
| **/rola** | Dodaje lub usuwa pojedyncze zainteresowanie lub powiadomienia o wydarzeniach. |

Komendy zaczynające się od /serwer- są przeznaczone dla właściciela. Moderatorzy mają osobne uprawnienia do ostrzeżeń, ograniczeń, wyrzucania i czyszczenia. Ban i odbanowanie wymagają uprawnienia Discorda do banowania. Obowiązuje hierarchia ról Discorda.

## Ochrona, logi i statystyki

- **Spam i naloty.** AutoMod Discorda blokuje spam i wiadomości zawierające więcej niż 5 unikalnych oznaczeń, jeżeli reguły zostały dodane. Alerty trafiają do 📋│logi-bota. Niezależnie od AutoMod bot wykrywa 8 wiadomości w 8 sekund i stosuje 2 minuty ograniczenia pisania wobec kont, które może moderować. Sygnały podejrzanego konta oznaczają skierowanie do człowieka.
- **Logi serwera.** Dołączenia, wyjścia, przejścia między kanałami głosowymi, weryfikacje, decyzje, akcje moderacyjne i wybrane zdarzenia audytu Discorda, takie jak zmiany ról, kanałów, zaproszeń i banów. Karty zdarzeń, ostrzeżenia i alarmy trafiają do 📋│logi-bota.
- **Logi wiadomości.** Edycje, usunięcia i zbiorcze usunięcia w nowych kanałach i ich wątkach. Log zawiera metadane, bez kopii tekstu. Po wyczyszczeniu pamięci podręcznej Discord może dostarczyć zdarzenie bez danych autora.
- **Liczniki.** Razem obejmuje ludzi i boty. Online łączy dostępnych, bezczynnych i „Nie przeszkadzać”. Konta niewidoczne liczą się jako offline. Po restarcie liczby mogą się wyrównywać podczas pobierania statusów. Liczniki odświeżają się co 15 minut, żeby zmieścić się w limitach zmiany nazw.
- **Boosty.** Bot dziękuje po otrzymaniu zdarzenia systemowego boosta. Jeśli powiadomienia systemowe są wyłączone, może wykryć pierwszy boost danego członka przez zmianę jego statusu. Aby otrzymywać zdarzenia kolejnych boostów, użyj /serwer-boosty. Discord może wyświetlić również własną systemową wiadomość.

Przechowuj folder **data** z identyfikatorami utworzonych elementów. Uruchamiaj jedną kopię bota na serwer. Po zwykłym przerwaniu uruchom bota ponownie, żeby wznowił konfigurację. Jeśli po restarcie zgłasza blokadę, wyłącz wszystkie kopie, usuń wyłącznie pusty folder z końcówką .lock z folderu data i zachowaj plik .json. Jeśli przerwanie nastąpiło tuż po utworzeniu niezapisanego kanału, terminal wskaże konflikt nazw. Zmień nazwę konfliktowego kanału na Discordzie, uruchom bota ponownie i sprawdź go na liście do sprzątnięcia.

Przy aktualizacji wcześniejszej paczki zachowaj folder data. Bot przeniesie kanały szukania ekipy i wydarzeń do kategorii gier, a 📋│mod-log przemianuje na 🛡️│modzi, zachowując historię. Nowe alerty kieruje do 📋│logi-bota. Wycofane kanały i kategorie pojawią się na liście do usunięcia. Jeśli bot wykryje dodatkowe reguły dostępu w aktualizowanym kanale, zatrzyma podgląd do czasu sprawdzenia ich przez właściciela. Nowy układ tworzy weryfikację bota niezależnie od wbudowanego Onboardingu Discorda, który wymaga kanałów pozwalających @everyone pisać. Sam tryb [Discord Community](https://support.discord.com/hc/en-us/articles/360047132851-Enabling-Your-Community-Server) można włączyć w ustawieniach Discorda z 📜│regulamin i 🛡️│modzi jako kanałem aktualizacji. Zostaw kanał modów prywatny.

Podgląd nazw offline uruchomisz przez **npm.cmd run plan**.
