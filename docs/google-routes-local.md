# Google Maps Routes API — RouteWise local transit prototype

This integration is **only for local transfers** (airport ↔ station, station ↔ port, etc.), not airline reservations or dynamically priced intercity rail tickets.

## Setup

1. In Google Cloud, enable **Routes API** for a project with billing configured.
2. Create a Google Maps Platform API key restricted to the **Routes API**. For a deployed backend also restrict by its server IP. Do not expose the key in browser code.
3. Add `GOOGLE_MAPS_API_KEY=...` to the existing root `.env` file (ignored by Git).
4. The Google transit endpoint is integrated into `server.mjs` on port `8787`.
   It uses the same Chrome-extension origin restrictions as the existing
   RouteWise endpoints, with the Google key kept server-side. No second HTTP
   listener or manual server edit is required.
5. Run only your normal server command:

   ```bash
   npm run server
   ```

6. In `chrome://extensions`, reload RouteWise, open a `transfer` leg and select
   **Research local transit with Google Maps**. Confirm the local time and IANA
   timezone, then click **Find transit options**.

Do not run `node --env-file=.env google-ground-proxy.mjs` separately after this change.
The old file remains as a reusable transport handler and for its existing tests,
but it does not need to listen on port 8788.

## Data rules

- Requests are sent only by explicit user clicks. Route generation never triggers billable Google requests. The merged ground handler caps calls at 100/day per running process; **also set a Google Cloud quota** to control spending if the proxy is restarted.
- Request fields: origin, destination, date-specific arrival/departure timestamp. Transit search supports a 7-day past / 100-day future window.
- RouteWise includes a Google transit fare in EUR in the provisional subtotal **only after the traveler checks the service/stations and clicks Use this estimated fare**, and only if the requested date matches the leg.
- Absent or other-currency fares stay **unknown**, not €0 or a fixed estimate.
- Intercity train fares have no universal assumed price; research ticket prices separately.
- Transit routes and fares may be incomplete or inaccurate; check station identity, exact service and connection buffer. Never treat this as a verified booking.
- Google responses are **not persisted** across panel/browser reloads; source attribution is displayed next to results.
- Price Import Test Mode does not change Groq usage. These Google requests are separately billable under your Google Cloud project.

Official docs: https://developers.google.com/maps/documentation/routes/transit-route
