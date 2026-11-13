## v0.4.9 — Broad flight research (new)

Generate routes, then use **Broad flight research → Open next one-way search**. On the resulting Google Flights Best search page, open the RouteWise overlay and **Import all** displayed flight cards. When the URL matches the one-way search RouteWise opened, results are cached and compared automatically; otherwise choose the matching one-way task and click **Cache these one-way Best results & compare**. Repeat for remaining unique searches. The preliminary comparison reuses matching flight results across routes and estimates each train leg at **€20**. One-way quotes are **indicative**; verified single-leg fares and shared round-trip tickets are kept separate. See `RELEASE-v0.4.9.txt`.

## v0.4.8 - One round-trip ticket can price two flight legs

RouteWise now saves a **shared round-trip ticket** linking the exact outbound
and return flight legs (for example MAD → SPC Jan 11 and SPC → MAD Jan 18).
Enter the **all-in EUR price for both flights once**, not once per leg.
Both flight legs show the linked ticket; route totals count it exactly once.
Other ground and flight legs keep their independent prices. Partial routes
still show a known subtotal, never a claimed full total.

Click **Price as round trip €** on a paired outbound flight, or paste an
actual Google Flights **Selected flights** round-trip details page into
**Import flight** and use **Save as one round-trip ticket €** in the review.
If the copied page matches BOTH route dates/airports, its booking sellers
and displayed amounts can be chosen to prefill the new ticket form. They
are *quotes*, not verified totals: confirm the selected seller, both
flight choices and required overhead-bag fees before saving. Search-page
quotes alone cannot verify the chosen return flight.

Saving a shared ticket replaces any conflicting one-way prices for those
legs after a confirmation; removing the shared ticket makes the legs
available for individual pricing again. Flight details and price totals
are saved locally and included in JSON exports.

Apply exactly ONE patch from the ZIP depending on whether you're on
v0.4.7.1 or v0.4.7.2, then run `npm test` and reload the Chrome extension.
No new dependencies, API keys, server restart or GTFS reimport are needed.

## v0.4.7.2 - Google Flights import price saving and visible leg totals

Apply **directly over v0.4.7.1**. This update does not change the Google
Flights overlay or require SerpApi.

After selecting an imported Google Flights result, RouteWise shows its
captured search price separately from the editable **Checked one-way fare**
field. A displayed quote is not added to the itinerary by itself because a
round-trip or return-selection quote may cover more than one leg.

To price a flight leg from the import editor: verify the ticket amount for
that **one-way leg** with the booking seller, type that EUR amount in the
checked one-way fare field, check baggage included or enter its extra fee,
mark the **one-way fare verification** checkbox, and click
**Save checked one-way EUR fare**. This records the price under the exact
flight-leg key and updates all matching occurrences across routes. You can
also use **Add EUR** on the leg to enter a separate verified price directly.

A saved price is shown immediately: RouteWise scrolls to and highlights
the matching flight leg, displays the verified amount, and shows an
updated **known subtotal** (with a +) for routes with unpriced remaining
legs. A full trip total appears only when every leg is priced.

**Save checked departure time** never sets a price. A departure-airport
time zone is required for timing checks, but is optional when saving fare
only (that save does not create an unverified connection time).

Existing saved trip data, fares, and GTFS imports remain unchanged.

## v0.4.6 — Google Flights search-list import (cumulative from v0.4.4)

Apply **only this patch over v0.4.4**. Do not apply v0.4.5 first: the
v0.4.6 patch includes all of v0.4.5's round-trip detail-page import.

In Google Flights, use Ctrl+A / Ctrl+C on the flight search-results page,
then **Import flight** on the desired RouteWise flight leg. Paste into the
review box, click **Analyze pasted flight information**, and click **Use this
flight** next to a matching result. RouteWise handles several departing
options, including overnight +1 arrivals and connections. Alternatively,
paste one or more copied Google Flights flight-card `outerHTML` snippets;
these use the cards' accessibility descriptions rather than CSS class names.

The original selected round-trip booking page is also recognized, including
outbound and return segments, booking sellers, and carry-on notes. All
imported values still require user confirmation. Search-list prices such as
€163 "round trip" are **not** individual leg fares. The importer previews
them but intentionally blocks saving them to a one-way leg (including when
using the existing fare button). To save time, enter the departure airport's
IANA timezone, verify the details, check the confirmation box, and click
**Save checked departure time**. This feeds into connection buffer checks.
No live DOM capture, SerpApi calls, special browser permissions or additional
Node dependencies are introduced.

Install from the project root:

```sh
git apply --check routewise-v0.4.6-google-flights-search.patch
git apply routewise-v0.4.6-google-flights-search.patch
npm test
```

Reload Chrome extension from `chrome://extensions`. No Groq server restart,
airport sync, GTFS reimport, or API key is required for this UI-only update.

---

## v0.4.2 — Operating-date-aware GTFS and diverse candidates

RouteWise now imports **GTFS calendars, service exceptions, and feed-local stop
arrival/departure times**, in addition to ground-network patterns. When a
candidate train/bus/ferry segment has an imported GTFS timetable record active
on the intended departure date, the UI labels that **ground leg** as scheduled
and displays its published local departure/arrival time and feed timezone.
Where the feed has missing or incomplete timetable evidence, RouteWise says
**date unverified** rather than guessing service. Calendar exceptions are
respected, including overnight GTFS times after 24:00.

The ground discovery endpoint now checks all imported ground patterns before
ranking, rather than stopping after the first set of matches. It can return
more suggestions for the selection algorithm to score and deduplicate. The
same scoring logic applies everywhere, using evidence quality, transfer count,
reciprocal flight-search pairing, and the trip's final endpoint. Candidate
selection reserves space for flight-only and ground alternatives where they
exist, and avoids returning repeated versions of the same rail corridor.
Unpriced routes retain this candidate order until actual fares are recorded.

**Installation:** Apply the v0.4.2 patch **over v0.4.1.1**, run `npm test`,
restart the server, and reload the extension. The new code does not rewrite
`.env`, your airport directory, or saved trip prices.

**Reimport required to enable dates:** The transit network imported under
v0.4.1 only stored undated patterns. Run the importer again after installing
v0.4.2 (using a feed you have permission to access). For example, using the direct Renfe URL that worked with v0.4.1:

```bash
npm run sync:transit -- --url=https://ssl.renfe.com/gtransit/Fichero_AV_LD/google_transit.zip --label=Renfe --attribution="Powered by Renfe; data licensed CC BY 4.0"
```

This replaces the existing `renfe` feed by ID and preserves other feeds.
Re-generate the trip afterward. Existing saved route snapshots aren't
retroactively modified. **GTFS time evidence only verifies a published
train/bus/ferry trip for the stated date.** It does not check live operational
status, seats, rail fares, station-to-airport transport, flight schedules,
minimum transfer times, or booking viability. A January 11 rail departure
cannot establish that an onward January 11 flight is feasible. Route rankings
are **unpriced heuristics**, not a claim to be the cheapest/fastest itineraries.
Imported schedule samples are capped per stop pair and may be incomplete; no
match from a truncated set must not be interpreted as proof that no service
exists. Times are feed-local and need time-zone handling for cross-border
connections. Feed-validity dates vary and require refreshes.

---

## v0.4.1 — Free GTFS-backed multimodal discovery (optional)

**New:** The local Node server can discover train, intercity bus, and ferry
**trip patterns** from a local GTFS static feed. These are NOT verified services
on your exact dates. Flight itineraries remain available with no transit feed.

**What this does:**

1. `scripts/sync-transit.mjs` downloads or reads a GTFS static ZIP. It parses
   `stops.txt`, `routes.txt`, `trips.txt`, and `stop_times.txt` using only Node
   built-ins (no paid API, tokens, or npm installation). It extracts directed
   pairs of stops on the **same published trip**, retaining train, bus and ferry
   mode. Other transit types are ignored. A snapshot is written to
   `data/transit-network.json`, which is excluded from Git.
2. The `/discover-ground` endpoint checks this local network, matching real
   stop coordinates to nearby airport coordinates from OurAirports, or using
   name-based matching if no coordinates are available.
3. Generate candidate routes combines a GTFS-grounded segment with tentative
   flights, inserting **explicit, unverified airport-to-station/port transfers**.
   It can replace a flight leg or suggest a ground journey to an alternate
   departure airport without any city-specific routing code. Only a limited
   number of unique mixed routes are displayed along with flight candidates.
4. Each new leg displays **GTFS trip pattern — date unverified**, the source,
   and any declared attribution. The user must confirm whether the train, bus,
   ferry and onward flights operate on their dates, station transfers, prices,
   availability and baggage allowances. GTFS validity ranges describe the feed,
   not a verified departure on the requested date.

**Install:** Apply the v0.4.1 patch over v0.4.0, run `npm test`, restart the local
Node server (`npm run server`), and reload the extension in `chrome://extensions`.
The patch does **not** overwrite your synced airport directory, `.env`, or saved prices.

**Load a GTFS feed (optional but necessary for ground alternatives):**

```bash
# Refresh airports to add coordinate columns (recommended, one time for v0.4.1)
npm run sync:airports

# Renfe intercity/AVE sample source. Public GTFS URL may change over time.
npm run sync:transit -- --url=https://gtfs-source-feeds.transit.land/es-nap-1098.zip --label=Renfe --attribution="Powered by MITRAMS; data from Renfe"

# Alternatively, after downloading an authorized GTFS feed yourself:
npm run sync:transit -- --file=/path/to/feed.zip --label=MyTransitOperator --id=my-transit-operator

npm run server
```

Renfe NAP listing: https://nap.transportes.gob.es/ConjuntoDato/Detail/897 .
Its attribution terms and feed license must be followed. Check the license
for any other feed you import. A public feed being downloadable does not make
it public-domain. `sync:transit` supports multiple feeds; repeated `--id`
replaces only that feed's prior snapshot data, leaving others intact.

**Test case:** Ask for Barcelona → La Palma → Madrid on January 11–18, 2027.
With a suitable Renfe GTFS feed and matching airport coordinates, RouteWise
can include Barcelona airport → Barcelona rail station (transfer placeholder),
rail → Madrid station (GTFS trip pattern), Madrid station → MAD airport
(transfer placeholder), then MAD → La Palma → MAD hypothetical flights.
A same-day train + flight connection is *not* verified, even if a GTFS pattern
was found; schedule-aware feasibility will be implemented in a later version.

**Limits:** This is not a journey planner with live schedules. It recognizes
stop pairs on a single GTFS trip, not arbitrary chains of train connections.
Airports and stations are not guaranteed to be connected by public transport.
No ground fare or flight time is invented. GTFS coverage and feed quality vary.
Feeds over 75 MB compressed or missing required tables are rejected. Multiple
nearby airports can be ambiguous; review every stop and destination in the UI.

---

## v0.3.9.1 — Explicit primary-destination grounding

An explicitly named vacation place in the original request now takes precedence over a Groq-proposed primary airport. `findExplicitPreferred()` reads destination-bearing phrases such as "want to go to", "visit", "spend time in", and "primary destination", then resolves the **longest name directly following that phrase** against a cached airport/city alias index. Generic airport suffixes ("Airport", "International Airport") are stripped to support names such as "La Palma" without any La Palma-specific code. When both endpoints are in the same country, that country helps disambiguate same-name places; it does not force all vacations into that country. This avoids regex-scanning the entire airport catalog on every request.

The normalization step overrides a wrong or valid-but-unrelated `preferred` value only when it finds grounded destination evidence in the user's request. Developer diagnostics show `source` and the actual `evidence` for that correction. Groq's instructions explicitly discourage substituting nearby airports or speculative codes. Open-ended or country-only requests still use their discovery path. The patch changes the local server's interpretation and the resolver, not route generation, stored offers or the API key. Restart the server and reload the extension after applying.

Airport alias resolution is not comprehensive geographic entity recognition. If the user names a non-airport island/landmark absent from the directory, RouteWise may still need a geography source or clarification rather than make a guaranteed match. No live flights or prices are introduced.

---

## v0.3.9 — Generalized airport connection hypotheses

The previous v0.3.8 generic planner produced only `origin -> named primary -> final` for a specified destination. **Generate candidate routes** now optionally calls a new local `/suggest-connections` endpoint to ask Groq for possible outbound and inbound airport hubs. The same algorithm works for any named destination; no La Palma, Madrid, Spain or country-specific hub list is built in.

- Groq brainstorms up to four hubs in each direction, constrained by the departure location, primary vacation destination, final location, dates and travel text.
- The local OurAirports directory validates each suggested **airport** and its country. Metropolitan all-airport codes, duplicates, nonexistent airports and endpoints of their own leg are rejected. A final city *may* be used as an outbound hub: `BCN -> MAD -> SPC -> MAD`.
- The generic route builder presents **up to five unique** patterns: the direct-leg hypothesis, one outbound connection, one inbound connection, connections in both directions, and other available hub alternatives. It preserves max-connections=0 and stays at the primary destination.
- Hub suggestions are cached for an unchanged trip. The extension continues generating the direct pattern if Groq connection discovery fails, with a visible warning. It keeps existing offers and one-way/round-trip Google Flights search handoffs.
- **All legs remain unverified flight hypotheses.** The airport directory does not prove service, timetable compatibility, carrier connection protection, or baggage rules. Same-day connections and maximum potential nights are optimistic. This version does not invent train or ferry legs or automatically search fares.

**Install on v0.3.8.4:** Run `git apply --check routewise-v0.3.9-generic-connections.patch`, `git apply routewise-v0.3.9-generic-connections.patch`, and `npm test`. Restart `npm run server` and reload the Chrome extension. Your `.env`, synced airport catalog and saved prices are not part of the patch.

---

## v0.3.8.2 — Region discovery minimum-nights bug fix

This small patch applies directly over **v0.3.8**. You do not need to install v0.3.8.1 first. It can also apply after v0.3.8.1 because the patches modify different files.

- Region and open-ended discovery do not require a preselected primary destination. The proposed city becomes the primary destination for **each** generated candidate, and its tentative nights are checked against any explicit minimum.
- If the user did not mention nights or an overnight stay, an AI-invented minimum-night requirement is cleared during normalization. The correction is visible in developer diagnostics after interpreting the request again.
- If no candidate can satisfy an actual minimum stay, RouteWise now gives a specific error explaining that the stay constraint cannot fit within the dates.
- Existing saved prices, airport directory, Groq configuration and routes are unchanged. Reload the Chrome extension after applying. Restarting the server is required for the AI normalization change.

To install: `git apply --check routewise-v0.3.8.2-region-stay-fix.patch`, then `git apply routewise-v0.3.8.2-region-stay-fix.patch`, `npm test`, restart `npm run server`, and reload Chrome extension. For an already parsed trip, simply clicking Generate candidate routes works with a one-night minimum. To clear an AI-invented minimum in the review, re-run Interpret trip with AI.

---

## v0.3.8 — Data-driven location resolution and generic route suggestions

The country-specific route templates and predefined five-city weekend list are removed from the **active route generator**. RouteWise now uses the same flow for Sweden, Portugal, the Canary Islands, or a completely open-ended weekend:

1. Groq extracts arbitrary location names or IATA codes, dates, and constraints (Stage A).
2. An offline airport directory resolves names to actual IATA airport entries. A **bootstrap directory of 16** familiar codes is included so the older demo works immediately. **For worldwide coverage, do the one-time airport sync below.** A city missing from the directory is flagged, not accepted as a verified airport.
3. For open or region-restricted trips, Groq proposes candidate cities (Stage B). Its suggestions are matched against the directory and checked against a recognized country where possible. An airport directory entry does not establish that a route operates.
4. One general route builder creates origin → candidate city → final destination trips, or origin → explicitly requested intermediate stop(s) → primary destination → final destination. No countries or inter-island hubs are hard-coded into route-generation logic. Only user-requested alternates are added.
5. All legs are **hypothetical flight legs**, not verified direct services. Train/ferry options are deliberately not invented until a real multimodal transport source is integrated. The tool can return fewer than five destinations when fewer valid suggestions are available.

### One-time worldwide airport data installation

From your existing RouteWise folder (with `package.json`), run:

```bash
npm run sync:airports
npm test
```

This downloads [OurAirports public-domain airport data](https://ourairports.com/data/), keeps scheduled-service airports with three-letter IATA codes, and writes a compact `airport-catalog.mjs` file for the local server and extension. **Restart `npm run server` and reload the extension in `chrome://extensions`** after the sync. Your existing `.env`, API key, extension ID, saved routes, and fares are not modified. The directory is a data snapshot, not a guarantee of live service, schedules, or prices.

If the automatic download is blocked, manually download the official `airports.csv` from [OurAirports](https://ourairports.com/data/) and run:

```bash
npm run sync:airports -- --file=path/to/airports.csv
```

The built-in country matching uses `Intl.DisplayNames` for recognized country names. Subnational regions (such as the Canary Islands) are **not yet independently geofenced**; check suggested city locations in the UI. Geographic synonyms may need manual review.

Existing legacy `generateRoutes()` remains as a small generic compatibility wrapper. The actual side-panel workflow calls `generatePlannedRoutes()`.

**Limitations:** The model's destination recommendations are not based on live fare or timetable feeds. The current one-way and round-trip Google Flights handoff remains available. The airport directory validates location codes, but cannot prove flight frequency, airfare, transit feasibility, or baggage allowances.

---
## Historical release notes (prior behavior may be superseded)

# RouteWise v0.3.7 — Region discovery and next-occurrence dates

This patch builds on v0.3.6. Chrome keeps the same extension ID and local storage.

## Changes

- **Generate candidate routes** for a country outside the existing sample catalog (such as Sweden) now calls the local Groq server to suggest up to five cities/airport codes. Those candidates are **not verified flight options or the five cheapest destinations**. Confirm city names, airport codes, availability, and prices yourself.
- The generator preserves `destination_search=region` rather than overwriting it when you apply an AI interpretation.
- Failures and ongoing requests are visible immediately underneath the Generate button instead of only at the bottom of the panel.
- Route cards display the suggested city names and store the generated candidate routes locally.
- Missing years default to the next occurrence of the trip's starting date relative to your computer's local date (an explicitly provided year always takes priority). No confirmation question is necessary, although the debug view records when a year was inferred.
- Previously supported Portugal, Canary Islands, and open-ended sample routes remain available.

## Installation

Place `routewise-v0.3.7-regions.patch` in the extension folder containing `manifest.json`, then run:

```bash
git apply --check routewise-v0.3.7-regions.patch
git apply routewise-v0.3.7-regions.patch
npm test
```

Restart the local server (`npm run server`) and reload the extension at `chrome://extensions`.
Your `.env` and Groq key are unchanged.

## Test

> I want to go on a weekend trip to Sweden from January 21 to January 24, starting and ending in Milan.

Click Interpret trip with AI, Apply known details, then Generate candidate routes. RouteWise should request unverified Swedish city suggestions from Groq and show candidate round-trip structures from Milan for January 21–24, 2027.

The destination-suggestion endpoint uses your existing Groq key and therefore counts toward Groq free-tier limits. No transport prices, schedules or baggage guarantees are obtained.

## Limitations

Destination discovery currently relies on Groq to propose real cities and IATA codes; it is not checked against an authoritative airport database. Results are suggestions, not a search result from Google Flights. Provider search handoffs use undocumented URL formats and require confirmation in the browser. The existing prototype still requires manual price capture.

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


## v0.3.4: Primary destination and time-first planning

- In Trip setup, select **Primary vacation destination** and the **Main planning goal**. New trips default to **Maximize time at primary destination**. The supported destinations and candidate route patterns remain limited to the earlier catalog.
- Pick whether final arrival is **by** a date or **exactly on** that date. Groq now gets more explicit examples, with a small deterministic correction for phrasing such as *ending in Madrid on January 18, 2027*. Restart `npm run server` after applying this patch.
- For a primary-destination goal, RouteWise dates inbound legs on the earliest candidate departure day and outbound legs on the latest arrival day. **These are optimistic date-only scenarios, not confirmed connections, actual full vacation days, or available tickets.** Multi-leg same-day travel especially needs verification.
- Scenario cards show the maximum *potential* calendar nights at the primary destination and warn about same-day connections. Hours and actual usable vacation time require verified timetables.
- Individual one-way searches and detected round-trip searches remain available; pricing is still manually entered and round-trip fares still cannot be saved as a bundled price.
- v0.3.3 local data is retained. The migration now restores `parsedRequest` across panel reloads, preserving reviewed flexible windows. Existing `.env` and `GROQ_API_KEY` are not changed.


## v0.3.5: Open-ended weekend trips

The parser recognizes Milan (MIL metropolitan city code) and phrases such as
'get back to Milan on January 24'. An open-ended request such as 'any cool
vacation spots' enables **Explore weekend destinations** instead of demanding
a named primary destination. The starter catalog currently offers Amsterdam,
Prague, Budapest, Dublin and Vienna. These are *examples* — not a live search,
not a recommendation ranking, and not evidence of direct flights or low fares.

Without an explicit year, the app may use an interpreted year from the AI's
departure date, but prompts for confirmation. MIL is a metropolitan code;
Google Flights link behavior for city-level codes should be manually verified.

## v0.3.6: Trip interpretation reliability and diagnostics

**Apply only after v0.3.5.** This patch does not replace the extension folder or touch `.env`.

- Groq is now prompted only to extract trip requirements (Stage A). Its schema distinguishes a **country or region with no chosen city** (`destination_search: 'region'`) from unrestricted discovery (`'open'`).
- New `date-intent.mjs` applies deterministic guardrails for common *explicit* month/day phrases: **January 21 to January 24** (fixed trip dates), **leave February 2–4** (flexible outbound window), and **return on** vs **arrive by** (fixed vs deadline). It uses the local server's current UTC date for an omitted year and requests confirmation. These patterns are not a comprehensive natural-language date library: unsupported/ambiguous phrasing remains for Groq and user review.
- Location normalization detects phrases like **starting and ending in Milan** using a small endpoint alias catalog, instead of a one-off Milan-only rule. It does **not** support arbitrary airport names yet.
- The review panel includes a collapsed **Developer diagnostics** section comparing the original Groq JSON, the normalized result, and fields that were corrected. This contains your trip details but **not** your API key. It is saved locally in Chrome storage and included when you export trip data; do not share it publicly.
- New country names from Groq (e.g., Sweden) remain visible and selectable in the form. This does **not** add Swedish cities to the sample route engine: trying to generate routes for Sweden still explains that the region is not supported. The only candidate catalogs remain the pre-existing ones.
- No live pricing, baggage rule retrieval, train timetables, or automated destination discovery is added.

From the existing RouteWise project folder:

```bash
git apply --check routewise-v0.3.6-trip-parsing.patch
git apply routewise-v0.3.6-trip-parsing.patch
npm test
```

Restart the local Groq server (`Ctrl+C`, then `npm run server`) and reload the extension at `chrome://extensions`.

Try: **“I want to go on a weekend trip to Sweden from January 21 to January 24, starting and ending in Milan.”** Expected: `MIL` start and end, required region Sweden, fixed Jan 21–24, 2027 with a year-confirmation question, and no city invented. Open **Developer diagnostics** to see which fields Groq itself returned and which the normalizer corrected.

To compare Groq models, change `GROQ_MODEL` in `.env` to `openai/gpt-oss-120b` and restart the server. Use identical prompts to compare *raw* results; model usage is subject to your Groq limits. Do not put your API key into the browser or share your `.env`.

## v0.4.0: Multimodal foundations (manual, not timetable-backed)

**Update from v0.3.9.1:** Apply `routewise-v0.4.0-multimodal.patch` directly over
v0.3.9.1, then run `npm test` and reload the Chrome extension. The local Groq
server and `.env` do not need changes. Previously saved prices, generated
candidate routes and the synced OurAirports catalog are retained.

This release intentionally does **not** ask Groq to invent train lines or
ferry schedules. No route feasibility, departure times, fares, connection buffers,
station identity or ferry service is independently verified.

### Create a mixed-mode scenario

1. Generate a normal flight-based candidate route.
2. On its card click **Make multimodal copy** (or **Edit multimodal route** on
   one of your own copies).
3. Change a flight leg to **Train**, **Bus**, **Ferry**, or **Transfer**. Enter
   the **exact terminal names**. Select the terminal kinds explicitly: airport,
   station, bus stop, port or place. Flights require *physical* IATA airports;
   train legs require stations; ferry legs require ports. Bus/transfer legs can
   join different terminal types.
4. Use **+ Transfer after** to insert a leg between a rail station and the
   airport (or between any other two terminals). The editor fills the next
   leg's from-terminal as the new transfer destination. Names/kinds must match
   exactly after normalization, so no invisible transfer is permitted.
5. Confirm the leg dates, enter a scenario name, and press **Save multimodal
   alternative**. It appears alongside the original generated scenarios. You
   can edit or remove your copy without changing the AI-generated route.
6. Click **Find train**, **Find bus**, **Find ferry**, or **Directions** to open
   an external planning website. Ground dates aren't prefilled; choose the
   specific travel date and confirm the actual station, service and price.
   The flight buttons continue to open Google Flights.
7. Enter each **externally verified** fare, baggage fee, and transfer cost
   once, on its applicable leg. If a station-to-airport transfer is a separate
   leg, do not also enter its cost as an extra fee on a flight. The price
   comparison still requires *every* leg to have a saved amount.

### Technical implementation

- `multimodal.mjs`: Five allowed modes (`flight`, `train`, `bus`, `ferry`,
  `transfer`), five terminal kinds, typed stop IDs, leg normalization,
  continuity/date validation, route cloning and trip-specific saved alternatives.
- `transport-links.mjs`: Explicit provider handoffs. Flights retain Google
  Flights one-way/round-trip URLs. Rail, bus and transfers open Google Maps
  transit directions; ferries open Ferryhopper for manual searches. Transit
  and ferry links are NOT live prices, bookability evidence or confirmed
  departure times. Google may change its URL behavior.
- `panel.mjs`/`panel.html`: A side-panel editor for copying a route and
  inserting/replacing legs. Manually authored routes live in a separate
  `manualRoutes` Chrome-local storage key and are shown only for their original
  trip context. The AI generator can be rerun without deleting them.
- Existing `legKey`, `costSummary` and `rankRoutes` remain unchanged. Flight
  segments shared between manual and automatic scenarios reuse their saved
  per-leg price; station/port IDs are mode-typed to avoid conflating them with
  airport IATA codes. The round-trip flight-search button also works for
  reciprocal flight segments inside a mixed-mode journey.
- No new API key, package dependency, or location-specific train/ferry rules.

### Known limitations / v0.4.1 inputs

- Station, port and bus stop names are **user-entered text**, not verified
  against a train-station or ferry-terminal registry. They should include city
  context when names might be ambiguous. Airport entries remain checked
  against the synced airport catalog.
- This does not automatically propose rail/ferry alternatives: that requires
  validated GTFS/transit/ferry data and a transfer-aware route search.
- Each leg has a date but not yet an actual time or time zone; connection
  feasibility and *usable hours* at the primary destination cannot be ranked.
- Combined round-trip airline tickets still require a future bundled-price
  model. Do not enter the same combined ticket price on both flight legs.
- No private login, scraping, booking, or purchases are performed.


### v0.4.1.1: Destination and fixed-date safety guardrails

- The side panel re-normalizes Groq's extracted trip against the original request, using its local airport directory. The original model output remains available in developer diagnostics; any additional side-panel corrections are shown separately.
- The **Apply** and **Generate** buttons check that an explicitly named vacation destination is not silently replaced by an unrelated airport code. This uses the generic airport name resolver, not a La Palma-specific rule.
- If the edited form conflicts with an explicitly fixed arrival/departure date from the interpreted request, route generation stops with a clear error until the request is updated or the date is corrected. It does not silently shift the trip by a day.
- GTFS and flight legs remain schedule-unverified. An airport code existing in the directory is not proof of a bookable passenger service.

- Grounding fallback: if AI proposes an airport not named in the traveler's text and no named destination can be resolved, the app clears the proposed primary destination for review instead of silently accepting a real-but-unrelated airport. Explicit traveler destinations still take precedence when found.


## v0.4.3 — Connection planning windows

The side panel now supports a **ground arrival → onward flight planning buffer**
(2, 3, or 4 hours, with 3 hours selected by default). This is a scenario
planning assumption covering the station/port to airport transfer plus airport
check-in; it is not a measured journey time. It applies to all geographies.

For a GTFS leg with a matching operating date and published arrival time,
RouteWise displays the earliest suggested onward flight departure in the
GTFS agency's local time zone. When adding a checked flight fare, you can
also save its departure time (24-hour HH:MM) and IANA time zone such as
`Europe/Madrid`. If the flight and GTFS schedule use the same time zone,
RouteWise flags whether the recorded time meets your chosen buffer. With
missing or different time zones it declines to make a definite comparison.

Ground alternatives whose planning buffer pushes their earliest onward
flight past the candidate date are penalized in the initial route selection,
but retained when they are the only evidenced ground alternative. All
previously stored fares and routes remain compatible; rerun Generate to
re-rank scenarios using a changed buffer.

The comparison cards show one concise connection note where needed rather
than repeating the same unverified-service caveat several times. The existing
price collection, Google Flights links and GTFS import remain unchanged.


## v0.4.3.1 — Connection checks beside onward flights

On any candidate containing a **GTFS-scheduled** ground segment followed by
an onward flight, the comparison card now shows a connection timeline:
**published ground arrival**, **selected buffer** (2/3/4 hours), and the
**earliest onward-flight target**. Users can enter a tentative departure time
and airport time zone right on that card and click **Check time**. These time
entries are saved independently of price estimates, shared across matching
flight legs, and used in route conflict rankings. The existing Add € editor
still works and can edit flight times with fares.

Where the train and flight use different or unknown time zones, the display
marks the comparison uncertain. A planning buffer is not proof that the airport
transfer or flight will operate. No need to reimport GTFS or change `.env`.


## v0.4.3.2 — Connection buffers visible even without GTFS times

The Scenario Comparison section now explicitly states the selected 2/3/4-hour
planning buffer and whether any candidate actually has a ground-to-flight
connection. All train, bus, or ferry legs followed by a flight (with optional
local-transfer placeholders in between) show a connection panel, even when the
GTFS feed contains only an undated trip pattern. If the ground arrival is
unknown, the panel says so and lets you enter a user-checked ground arrival
date, clock time, and IANA zone. Enter the corresponding flight departure time
and zone to check the minimum buffer and update the ranking; neither requires
a fare. Your manual times are saved locally and can be cleared individually.
Time-zone mismatches remain unverified instead of being counted as a pass.
The buffer is a planning assumption, not proof of feasible real transportation.

## v0.4.4 — Manual flight research first (no flight API needed)

Apply v0.4.4 **directly over v0.4.3.2**. Do not apply v0.5.0 first.

- Each flight leg has an **Import flight** button. Open the existing **One way** or **Round trip** search link, find a specific flight, and either paste its details into the import form or highlight flight details on that website and right-click **Send selected flight details to RouteWise**. Return to RouteWise, click **Import flight** on the matching leg, and click **Use highlighted selection** if necessary.
- Text suggestions are local-only and conservative: only unambiguous departure/arrival clock pairs and single EUR prices are extracted. The traveler checks the airport pair, travel date, actual flight, airline, departure time zone, baggage and price in the review form. Raw selected page text is not submitted to Groq or stored with an approved fare.
- **Save checked departure time** records the schedule time without entering any fare. Existing ground-to-flight buffer checks and route ranking update from that time.
- **Save checked EUR fare** adds the cost through the existing leg-offer model, only when the overhead carry-on is confirmed included or its fee has been checked. The saved offer includes a source link and review notes. Non-EUR prices must be entered as a checked EUR figure manually; there is no automatic conversion.
- The extension reads only explicitly highlighted text via Chrome's `contextMenus` selection API and its `pageUrl`, not the DOM. No scraping, broad website permissions, SerpApi key, or server restart is needed. Captured text remains in local Chrome storage pending review; **Discard highlighted selection** clears it.
- Round-trip flight searches remain available. Don't enter the *full* round-trip fare on both leg records; the existing price model is still per leg.

After applying the patch, run `npm test` and reload the extension at `chrome://extensions` (the updated version adds the `contextMenus` permission). Your saved trip, fares, Renfe data, and Groq server remain unchanged.


## v0.4.5 — Pasted Google Flights round-trip results

Copy an expanded **Selected flights** round-trip page from Google Flights using Ctrl+A / Ctrl+C,
then click **Import flight** for the corresponding RouteWise flight leg, paste the text and click
**Analyze selected flight text**. RouteWise separates **Departing flight** and **Returning flight**,
recognizes connecting segments even when AM/PM touches the airport name, and displays the two
directions and the booking seller quotes. It populates the selected leg's times, airline and stop
count only when the airports **and travel day** match. Time zones still require your review.

The displayed lowest Google Flights price is a **complete round-trip ticket quote**, not an
individual leg price. RouteWise deliberately leaves the one-way fare field empty and blocks
**Save checked EUR fare** for these pasted pages to avoid double-counting. Use **Save checked
departure time** on each relevant leg; the quote remains in the preview while you review.
Ticket-level price storage is a future milestone. If you need to record a per-leg fare, research
a true individual one-way fare separately. Allowances such as `1 free carry-on` are visible,
but baggage for third-party sellers must be checked with the seller before pricing.

The example in `tests/fixtures/google-flights-mad-spc-rt.txt` is copied user-supplied Google
Flights text (Madrid–Tenerife–La Palma, returning via Tenerife), including multiple EUR/USD
booking prices and attached metadata. No web scraping, API call or additional permission is used.


## v0.4.7: one-click Google Flights overlay

On `https://www.google.com/travel/flights` or its search/results pages, a
small **RouteWise · Import flights** button appears at the bottom right.
Click it to view flight results detected from currently rendered Google
Flights cards. You can **Import all** the displayed options or click
**Import** beside a specific option, including the floating button shown
on each original card. Results are sent to RouteWise's local review queue;
they are not added to a trip yet. Alternatively, in the RouteWise side panel,
click **Show flight import overlay on Google Flights** while that tab is active.

Then click **Import flight** on the matching itinerary flight leg. Review
the detected flight and confirm the airports, travel date and departure time
zone before saving the departure time. Google Flights listing prices are
**search quotes** that may be round-trip, one-way, or unlabeled. The importer
shows the price scope when known and never silently saves these amounts as
verified individual leg fares. Nothing is sent to Groq or an
external API by the on-page overlay.

The overlay is scoped to Google Flights pages hosted on `www.google.com`.
After installing or upgrading the extension, refresh any existing Google
Flights tabs once to load the content script. Use **Refresh** in the overlay
after Google Flights loads more results or changes the search.


## v0.4.7.1: Google Flights return/one-way result card fix

Fixes an overlay showing **0 flight options** when Google Flights displays
return/one-way results such as SPC → MAD with €82/€84/€87 amounts. Card
recognition no longer requires the accessibility label to say
"round trip total". It reads visible route codes, time accessibility
labels, airline, date, and displayed EUR price independently when needed.

To install over v0.4.7, apply `routewise-v0.4.7.1-one-way-overlay.patch`,
reload the extension at `chrome://extensions`, **refresh Google Flights**,
open the overlay, and click **Refresh**. All captured results still require
a manual review step before a flight time is saved. An unlabeled search
price is explicitly marked *scope unverified* and is never saved as a fare.

### v0.4.8.1 — Google Flights result-card quotes in the round-trip editor

With **Save one round-trip ticket** open, click **Import** on an individual
Google Flights result card. If the card explicitly quotes a round-trip amount
and its airports/date match either flight of the linked pair, the displayed
amount is now prefilled immediately as a **draft**. The booking seller remains
blank: a search card does not identify who will sell the final two-flight
booking. Both confirmation checkboxes are reset, and the ticket is not saved
until the user verifies the actual two directions, seller, overhead-bag terms,
fees and final total. A card with an unlabeled or one-way price cannot prefill
an entire round trip.

**Import all** likewise shows all matching round-trip quotes in a selector;
choose one to prefill the draft. From the RouteWise flight-import screen, the
**Use round-trip quote €** button beside a matching search result opens the
same ticket editor with that one option prefilled. Fully selected round-trip
booking-page imports still show their existing seller choices.

No SerpApi calls or server restart are required. Saved flight, ticket and GTFS
data remain intact. Apply the v0.4.8.1 patch over v0.4.8 only.
