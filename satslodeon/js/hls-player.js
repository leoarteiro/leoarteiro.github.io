// Plays content-addressed HLS made by tools/hls-pack.py: every playlist and segment is named by
// its sha256, fetched from whichever Blossom mirror has it, and verified before the player uses it.

import { resolveSources } from "./blossom.js";

const HASH_NAME = /([0-9a-f]{64})(\.[a-z0-9]+)$/;
const FETCH_TIMEOUT_MS = 15000;
const START_TIMEOUT_MS = 20000;

async function sha256OfBuffer(buf) {
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Extends hls.js's own loader (which keeps the bandwidth stats that drive quality switching):
// blobs named by hash are requested from each mirror in turn and rejected if their hash differs.
function makeLoader(BaseLoader, bases, onServed) {
  let preferred = 0; // index of the mirror that answered last

  return class BlossomLoader extends BaseLoader {
    load(context, config, callbacks) {
      const match = HASH_NAME.exec(new URL(context.url).pathname);
      if (!match) return super.load(context, config, callbacks);
      const order = bases.map((_, i) => bases[(preferred + i) % bases.length]);
      let attempt = 0;

      const tryNext = (reason) => {
        if (reason) console.warn(`HLS: ${context.url} failed (${reason}), trying next mirror`);
        if (attempt >= order.length) {
          return callbacks.onError({ code: 404, text: "not available on any mirror" }, context, null, this.stats);
        }
        const base = order[attempt++];
        context.url = base + match[1] + match[2];
        super.load(context, { ...config, timeout: FETCH_TIMEOUT_MS, maxRetry: 0 }, {
          ...callbacks,
          onSuccess: async (response, stats, ctx, details) => {
            const data = response.data;
            const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
            if ((await sha256OfBuffer(bytes)) !== match[1]) return tryNext("hash mismatch");
            preferred = bases.indexOf(base);
            onServed?.(new URL(context.url).host);
            callbacks.onSuccess(response, stats, ctx, details);
          },
          onError: (error) => tryNext(error?.text || `HTTP ${error?.code}`),
          onTimeout: () => tryNext("timeout"),
        });
      };
      tryNext();
    }
  };
}

// Starts playback; resolves with a stop() handle once the first frame is ready, or rejects so the
// caller can fall back to a plain video file.
export async function playHls(video, hlsBlob, servers, { startAt = 0, onStats } = {}) {
  const { default: Hls } = await import("../vendor/hls.light.min.mjs");
  if (!Hls.isSupported()) throw new Error("HLS (MediaSource) not supported");

  // Mirror order: whoever answers first for the master playlist, then the rest, then fallbacks.
  const masterUrls = await resolveSources(hlsBlob, servers);
  if (!masterUrls.length) throw new Error("no source for the master playlist");
  const bases = [...new Set(masterUrls.map((u) => u.slice(0, u.lastIndexOf("/") + 1)))];

  let host = "";
  const hls = new Hls({
    loader: makeLoader(Hls.DefaultConfig.loader, bases, (h) => (host = h)),
    startPosition: startAt || -1,
    startLevel: -1, // pick the first quality from the bandwidth estimate, not the playlist order
    maxBufferLength: 30, // same 30 s of buffer that worked in the WebTorrent tests
    maxMaxBufferLength: 60,
    capLevelToPlayerSize: true, // no 720p on a small phone screen
  });
  const report = () => {
    const level = hls.levels?.[hls.currentLevel];
    onStats?.({ height: level?.height ?? 0, host });
  };
  hls.on(Hls.Events.LEVEL_SWITCHED, report);
  hls.on(Hls.Events.FRAG_LOADED, report);

  video.hlsPlayer = hls; // for inspection in tests/devtools
  video.preload = "auto";
  hls.loadSource(masterUrls[0]);
  hls.attachMedia(video);

  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("HLS start timeout")), START_TIMEOUT_MS);
      video.addEventListener("loadeddata", () => { clearTimeout(timeout); resolve(); }, { once: true });
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (data.fatal) { clearTimeout(timeout); reject(new Error(`HLS: ${data.details}`)); }
      });
    });
  } catch (e) {
    hls.destroy();
    throw e;
  }
  return { stop: () => hls.destroy() };
}
