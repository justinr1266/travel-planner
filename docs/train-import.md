# Train links and user-reviewed import (Google Routes paused)

Train fares come from a visible operator/search-provider page, **not** Groq, GTFS, or Google Maps Routes API.

1. Run `npm run server` as usual. `ROUTEWISE_GOOGLE_ROUTES_ENABLED` is **off by default**. The RouteWise panel hides the local transit lookup and cannot charge the Google Routes API. Do not start the old Google proxy separately.
2. Generate candidate itineraries. Intercity train legs with GTFS station labels appear in the **05 · Train research** section. They have dated search links with station names and the departure date, sent to Omio. The provider may ask you to confirm the correct stop, date, ticket type and train-only mode.
3. Press **Open and import**. RouteWise attempts to capture *visible* journey cards using a content script restricted to Omio and Trainline. If the provider is still loading or changes its layout, finish the search and press **Capture visible train results**, or paste one card into the import editor. This does **not** use a paid rail API.
4. RouteWise waits for stable journey cards, checks the requested exact stations and selects the least-expensive matching EUR journey (regardless of Omio's sorting). It can automatically cache **indicative only** when either the original dated URL remains intact, or RouteWise itself opened the dated URL and Omio's selected weekday/month/day agrees after a redirect. In the redirect case the year comes from the requested link rather than independently verified Omio data; the cache records that limitation. Wrong dates, conflicting URL parameters, changed stations, and unsupported page layouts stop the queue for manual review. The app never labels these prices verified booking offers. Use **Save checked train fare** only after independently confirming details, including date, passenger and ticket conditions.
5. If a price is missing/ambiguous or in another currency, it stays unknown. GTFS schedules are not ticket offers. Train fares, station-to-airport transfers, and flight quotes remain separate legs to prevent double counting.

The Omio search-link query keys `departurePosTerm`, `arrivalPosTerm`, and `departureDate` are documented by Omio. The actual result page may change; confirm values on the site. This implementation only reads visible page text from user-opened train searches and does not scrape provider APIs, bypass access controls, book or pay for anything.

If Google Routes is needed later, set `ROUTEWISE_GOOGLE_ROUTES_ENABLED=true` **and** re-enable the UI gate separately after reviewing billing and quota safeguards.

Sources: https://www.omio.com/affiliate/search-widget ; https://support.travelpayouts.com/hc/en-us/articles/360006719812-Omio-links
