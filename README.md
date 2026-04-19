# RETRO BOT / Terminal Odzyskiwania Dostępu (MVP demo)

Electronowy prototyp demonstracyjny instalacji galeryjnej:

- keyboard-first flow (PL/EN)
- 3 błędne próby hasła
- przejście w "osobowość systemu"
- 5 pytań (otwarte)
- controlled arc 5 pytań (intencje Q1..Q5 + antyduplikacja)
- mikro-przejścia między pytaniami (600–1200 ms, Enter = skip)
- analiza (Gemini, LLM-required mode)
- ekranowy paragon
- lokalny zapis sesji (SQLite jeśli dostępny, JSON storage fallback)
- export do pliku txt
- analityka skuteczności (lokalnie, bez publicznego archiwum)

## Uruchomienie

1. `npm install`
2. Ustaw `GEMINI_API_KEY` (wymagane)
3. `npm start`

## Zmienne środowiskowe

- `GEMINI_API_KEY` - klucz Gemini (wymagany; bez niego sesja nie wystartuje)
- `GEMINI_MODEL` - domyślnie `gemini-3-flash-preview`
- `RETROBOT_TONE_PRESET` - `cruel_light`, `cruel_balanced`, `cruel_sharp`
- `RETROBOT_KIOSK` - `1` aby wymusić `kiosk: true`
- `RETROBOT_FULLSCREEN` - `0` aby wyłączyć fullscreen podczas developmentu
- `RETROBOT_IDLE_TIMEOUT_MS` - timeout bezczynności (domyślnie `50000`)
- `RETROBOT_POST_RESULT_TIMEOUT_MS` - timeout po wyniku (domyślnie `180000`)
- `RETROBOT_OPERATOR_MODE` - `1` aby odblokować IPC analityczne i eksport
- `GEMINI_THINKING_LEVEL_QUESTION` - `minimal|low|medium|high` (domyślnie `low`)
- `GEMINI_THINKING_LEVEL_REPORT` - `minimal|low|medium|high` (domyślnie `low`)
- `GEMINI_THINKING_LEVEL_REPAIR` - `minimal|low|medium|high` (domyślnie `minimal`)

## Kontrakt pytań adaptacyjnych (IPC)

`retrobot:get-adaptive-question` zwraca teraz:

- `question`
- `transitionLine`
- `meta` (`source`, `intentTag`, `rhetoricalForm`, `noveltyScore`, `anchorTokens`, `regenCount`)

Renderer wysyła też rozszerzony kontekst:

- `arcState` (`usedIntents`, `usedRhetoricalForms`, `usedAnchors`, `verbatimQuoteCount`)
- `experienceProfile=controlled_arc_balanced`

## Uwagi

- Aplikacja działa w trybie `LLM-required`: brak dostępności LLM blokuje start sesji i przełącza UI na ekran administracyjny.
- Utrata LLM w trakcie pytań lub analizy przerywa sesję i przełącza UI na ekran administracyjny (bez fallbacków treści).
- Jeśli `better-sqlite3` nie zainstaluje się lokalnie, aplikacja przejdzie na storage fallback plikowy JSON (dev convenience).
- MVP nie drukuje na drukarce ESC/POS; renderuje "receipt preview" na ekranie.
- Brak publicznego archiwum: wszystkie zapisane dane służą wyłącznie analityce skuteczności instalacji.
- IPC analityczne (`get-analytics-summary`, `get-quality-report`, `export-analytics`, `purge-logins`) są dostępne tylko w `RETROBOT_OPERATOR_MODE=1`.
