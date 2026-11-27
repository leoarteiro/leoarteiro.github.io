// The catalog published on Nostr: an addressable event (kind 30078, NIP-78 app data) signed by the
// project key, with the catalog JSON as content. Each new publication replaces the previous one, so
// readers ask several relays and keep the newest event with a valid signature from that key.
import { verifyEvent, nip19Decode } from "../vendor/nostr-tools.min.mjs";

// Only catalogs signed by this key are accepted. Changing it requires a new APK.
export const CATALOG_NPUB = "npub1k8jvsg4aqujwkfeahwex4zvvjlafwy2xq2rlrd5688qpegvprd0qdxum79";
export const CATALOG_KIND = 30078;
export const CATALOG_D_TAG = "satslodeon-catalog";
export const CATALOG_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.primal.net",
  "wss://nostr.mom",
  "wss://relay.snort.social",
];

export const catalogPubkey = () => (CATALOG_NPUB ? nip19Decode(CATALOG_NPUB).data : null);

// Once one relay answered, wait this long for the others (one of them may have a newer version).
const GRACE_MS = 700;

export function isCatalogEvent(event, pubkey) {
  return event?.kind === CATALOG_KIND && event.pubkey === pubkey
    && event.tags.some((t) => t[0] === "d" && t[1] === CATALOG_D_TAG) && verifyEvent(event);
}

// Resolves with { catalog, event, relays } (relays = where the chosen event was found) or rejects.
export function fetchNostrCatalog(timeoutMs = 4000, relays = CATALOG_RELAYS) {
  const pubkey = catalogPubkey();
  if (!pubkey) return Promise.reject(new Error("catalog key not set"));
  const filter = { kinds: [CATALOG_KIND], authors: [pubkey], "#d": [CATALOG_D_TAG] };

  return new Promise((resolve, reject) => {
    const sockets = [];
    let best = null; // { event, catalog, relays: Set }
    let pending = relays.length;
    let graceTimer = null;

    const finish = () => {
      clearTimeout(timer);
      clearTimeout(graceTimer);
      for (const ws of sockets) try { ws.close(); } catch {}
      if (best) resolve({ catalog: best.catalog, event: best.event, relays: [...best.relays] });
      else reject(new Error("no valid catalog on the relays"));
    };
    const timer = setTimeout(finish, timeoutMs);
    const relayDone = () => { if (--pending === 0) finish(); };

    for (const url of relays) {
      let ws;
      try { ws = new WebSocket(url); } catch { relayDone(); continue; }
      sockets.push(ws);
      const subId = "cat" + Math.random().toString(36).slice(2, 8);
      let done = false;
      const once = () => { if (!done) { done = true; relayDone(); } };
      ws.onopen = () => ws.send(JSON.stringify(["REQ", subId, filter]));
      ws.onerror = ws.onclose = once;
      ws.onmessage = (msg) => {
        let data;
        try { data = JSON.parse(msg.data); } catch { return; }
        if (data[0] === "EOSE" && data[1] === subId) { once(); try { ws.close(); } catch {} return; }
        if (data[0] !== "EVENT" || data[1] !== subId || !isCatalogEvent(data[2], pubkey)) return;
        const event = data[2];
        if (best?.event.id === event.id) { best.relays.add(url); return; }
        if (best && event.created_at <= best.event.created_at) return;
        let catalog;
        try { catalog = JSON.parse(event.content); } catch { return; }
        if (!Array.isArray(catalog?.works)) return;
        best = { event, catalog, relays: new Set([url]) };
        graceTimer ??= setTimeout(finish, GRACE_MS);
      };
    }
    if (!relays.length) finish();
  });
}
