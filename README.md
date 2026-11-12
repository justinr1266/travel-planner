# RouteWise v0.3 (Groq edition) — Chrome travel planning companion

**Milestone 3: region-aware candidate itinerary generation** (ATLS 4519 / personal prototype).

This version builds on v0.2.1 and retains the **local Node server** which optionally calls the Groq Chat Completions API to convert a travel description to a **validated, structured trip plan**. It does not make any automatic Google Flights/Kayak searches, retrieve live prices, or claim that suggested routes exist.

## Try it without a key (UI demo)

1. Install Google Chrome and Node.js **20.6 or newer**.
2. Unzip the archive. Open Chrome: `chrome://extensions` > **Developer mode** > **Load unpacked**.
3. Select the **routewise-starter** folder containing `manifest.json`.
4. Click the RouteWise toolbar icon. The extension's side panel opens.
5. Click **Preview sample (no AI)** to see an example parsed trip. Click **Apply known details to trip form**, review dates, choose a requested region, and then **Generate candidate routes**.

This sample is clearly labeled, and makes *zero* API calls.

## Connect AI trip interpretation

The extension **does not receive or store your API key**. A local server performs API requests from your machine. Groq offers a free API tier subject to request and token limits; create an API key at https://console.groq.com/keys. No OpenAI API account is needed.

1. Open this `routewise-starter` folder in VS Code, then open a terminal there.
2. Copy `.env.example` to `.env`. In PowerShell: `Copy-Item .env.example .env`. On Mac/Linux: `cp .env.example .env`.
3. Edit `.env`, replacing `replace-with-your-groq-key` with your real Groq API key. Leave `.env` on your computer; **never paste the key in chat, commit it to Git, or put it in Chrome's extension code**.
4. Run `npm run server`. It should print `RouteWise local parser running at http://127.0.0.1:8787`.
5. In a browser, open http://127.0.0.1:8787/health to check whether the server is running and configured.
6. Return to RouteWise's Chrome panel. Enter a travel description and click **Interpret trip with AI**.
7. **Read the extracted result**, including any unanswered questions. Click **Apply known details to trip form** only when it makes sense; review dates and click **Generate candidate routes** to see region-aware route patterns.

**Example prompt for the AI button:**

> I am starting in Barcelona and must finish in Madrid by February 10, 2027. I can depart between February 2 and 4, 2027. I want to spend as much time as possible on La Palma but I am open to Tenerife if it helps. I have one overhead carry-on. Prefer low cost, but no departures before 7 AM and ideally no more than one connection per journey.

**Security note:** the local server listens only on `127.0.0.1`, not your public network, and accepts requests from Chrome extension origins. For additional local protection, find the extension ID at `chrome://extensions` and enter it as `ROUTEWISE_EXTENSION_ID` in `.env`. Restart the server. It will then reject requests from other extension IDs. This is a development-only server; do not expose it publicly or deploy it unmodified. The `.gitignore` protects `.env` from normal Git commits; check `git status` before pushing your code.

## How it works

```text
Chrome Side Panel (panel.mjs)
     |  POST description to http://127.0.0.1:8787/parse-trip
     v
Local Node HTTP Server (server.mjs)
     |  Groq Chat Completions API, openai/gpt-oss-20b by default
     |  Strict JSON Schema in trip-parser.mjs
     v
Validated structured plan
     |  Show dates, cities, bag type, optional stops, limits, questions
     v
User reviews -> Apply known details -> Generate candidate routes
     |  Explicitly saved user-verified prices only
     v
Compare costs with core.mjs
```

The plan includes:

- Origin, optional preferred stop, final destination, and requested country/region (Portugal or the Canary Islands supported for candidate generation). Airports: BCN/MAD/SPC/TFN/TFS/LPA/LIS/OPO/FAO.
- Fixed dates, departure windows, or arrival deadlines. **Unknown dates remain null in the AI result.** The UI displays warnings and keeps existing form dates until you intentionally change/apply them.
- Optional stops, minimum nights, max connections, earliest departure hour, soft preferences, hard constraints, and follow-up questions.
- Bag category and user-specified dimensions/weight, if provided. If dimensions aren't mentioned, it retains existing profile measurements only when you apply the interpretation.
- A priority such as cost, time at preferred destination, fastest route, or balance.

**Important boundary:** v0.3 generates up to five **route patterns**, with tentative dates within the stated departure window and arrival deadline. It can check tentative minimum nights, but it does **not** verify flights, trains, ferries, baggage rules, connection feasibility, preferred departure hours, or real prices. Routes are not the actual five cheapest bookable itineraries. Unsupported regions are rejected rather than guessed.

## Tests and debugging

```bash
npm test
```

Runs 22 tests across pricing, parsing, Groq integration (mocked), and route-generation logic. No `npm install` is needed: Node's built-in server, `fetch`, and test runner are used.

To reload UI changes, open `chrome://extensions`, find RouteWise, and click **Reload**. If AI parsing fails, confirm:

- `npm run server` is running in a separate terminal.
- Your Groq key is valid and your free-tier rate limit is not exhausted, and the server health endpoint says `configured: true`.
- The `.env` file is in the *same folder* as `server.mjs`.
- If `ROUTEWISE_EXTENSION_ID` is set, it exactly matches the installed extension's ID.
- Chrome has the declared `http://127.0.0.1:8787/*` host permission.

The Groq API request uses Chat Completions with `response_format` set to strict JSON Schema, using `openai/gpt-oss-20b` by default. Your trip description is sent to Groq only when you press **Interpret trip with AI**; the extension does not automatically send your saved travel offers.

## Project files

- `panel.html`, `panel.mjs`, `styles.css`: Chrome side panel and review flow.
- `manifest.json`, `service-worker.js`: Chrome Manifest V3 entrypoints.
- `server.mjs`: Node server with no third-party dependencies; holds API key server-side.
- `trip-parser.mjs`: AI output schema, validation, sample parsed plan.
- `plan-ui.mjs`: testable mapping from AI fields to the trip form.
- `core.mjs`: saved offers, airport catalog, deterministic cost ranking, and legacy route demo helpers.
- `route-engine.mjs`: region-aware candidate route generation and tentative dates.
- `demo-results.html`, `demo-results.mjs`: fake flight-results DOM extraction sandbox; no live site scraping.
- `tests/`: route and plan validation tests.

## Still to build

1. **Milestone 3 continuation:** richer route graph; real airline, train, ferry and port connections; actual travel-time and connection feasibility; schedule and time-of-day constraints.
2. **Milestone 4:** permitted live flight-price sources and baggage-price verification, plus supported train/ferry operators.
3. **Milestone 5:** evaluation versus conventional trip research, measured accuracy, time, completeness, and trust.

## Official docs

- [Groq Structured Outputs](https://console.groq.com/docs/structured-outputs)
- [Groq API key](https://console.groq.com/keys)
- [Groq free-tier rate limits](https://console.groq.com/docs/rate-limits)
- [Chrome Side Panel](https://developer.chrome.com/docs/extensions/reference/api/sidePanel)
- [Chrome extension storage](https://developer.chrome.com/docs/extensions/reference/api/storage)

## Updating from v0.2.1 without reinstalling

Open your existing `routewise-starter` folder in the VS Code terminal, place the downloaded `routewise-v0.3.patch` file in this folder, then run:

```bash
git apply --check routewise-v0.3.patch
git apply routewise-v0.3.patch
npm test
```

Restart `npm run server` and reload at `chrome://extensions`. Do not delete or replace `.env`. The patch only changes source files and adds route-engine files; the Chrome extension remains installed in the same directory.

No live Groq call was performed during creation; API integration was verified with mocked responses.

## v0.3 update: dynamic candidate patterns and countries

- The AI can preserve country-level stops (e.g. Portugal) in `requested_regions` without inventing a city.
- The side panel now lets you choose a region and leave the specific preferred stop blank.
- The local route pattern engine generates up to five *unverified* candidates for Portugal or the Canary Islands. It proposes tentative dates within the reviewed departure window and arrival deadline. Unsupported regions fail explicitly.
- Date edits in the panel override previously interpreted dates. Saved prices only reappear for identical origin/destination/date/mode keys.
- Route pattern generation does not verify actual airline service, flight times, transfers, fares, or baggage policies. It cannot truthfully identify the five cheapest bookable trips yet.

This update can be applied to an existing v0.2.1 installation using the Git patch instead of replacing the extension folder. No `.env` changes are needed.

## v0.3.1: Find fare search links

Flight-leg **Find fare** buttons now open a Google Flights text-query URL containing the selected origin and destination airport codes and one-way departure date. This is a user-directed navigation shortcut, not an API or live-fare retrieval. Google's query parsing is not a documented, guaranteed interface, so verify that the route/date are populated before using a price. Train and ferry links remain homepage handoffs for manual searching.

To apply this patch from the project folder, run `git apply --check routewise-v0.3.1-find-fare.patch`, then `git apply routewise-v0.3.1-find-fare.patch`, then `npm test`. Reload the extension at `chrome://extensions`. No API key or server change is required.

### Flight search links (v0.3.3)

Each flight leg still has a **One way** Google Flights link. When a scenario
contains reciprocal flight legs (e.g. Madrid → La Palma on Feb 5, and La Palma
→ Madrid on Feb 10), its outbound leg also shows a **Round trip** link. This
uses the *two tentative dates in that scenario*, not an invented return date.
Check both dates on Google Flights before booking. The search link format is
undocumented and may break if Google changes it.

Round-trip fares are **one combined price for both flights**. The current
per-leg price editor does not yet store bundled round-trip offers: do not enter
the full round-trip price into both legs or the comparison will double-count.
Use one-way fare entries or wait for a combined-ticket price editor feature.
