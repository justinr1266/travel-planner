// Mount the existing Google transit proxy onto the main RouteWise HTTP server.
// This module does not listen on a second port and never exposes the API key.
// In server.mjs, call this BEFORE its normal request routing:
//   if (await handleGroundTransitRequest(req, res)) return;
import {createGoogleGroundServer} from './google-ground-proxy.mjs';

export function createGroundTransitRequestHandler(options = {}) {
  // Reuse the proven proxy validation, CORS, quota and no-store behavior.
  // One listener is reused for the life of the main server, preserving its
  // per-process daily Google-call ceiling.
  let listener;
  return async function handleGroundTransitRequest(req, res) {
    if (req.url !== '/ground-transit') return false;
    if (!listener) {
      const proxy = createGoogleGroundServer(options);
      listener = proxy.listeners('request')[0];
    }
    await listener(req, res);
    return true;
  };
}

export const handleGroundTransitRequest = createGroundTransitRequestHandler();
