// Plays content-addressed HLS made by tools/hls-pack.py: every playlist and segment is named by
// its sha256, fetched from whichever Blossom mirror has it (or from other viewers, P2P), and
// verified before the player uses it.

import { resolveSources } from "./blossom.js";

const P2P_TRACKERS = ["wss://tracker.novage.com.ua", "wss://tracker.webtorrent.dev", "wss://tracker.openwebtorrent.com"];

const HASH_NAME = /([0-9a-f]{64})(\.[a-z0-9]+)$/;
const FETCH_TIMEOUT_MS = 6000;
const START_TIMEOUT_MS = 20000;

async function sha256OfBuffer(buf) {
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Wraps hls.js's own loader (which keeps the bandwidth stats that drive quality switching):
// blobs named by hash are requested from each mirror in turn and rejected if their hash differs.
// hls.js loaders can be used only once, so every attempt gets a fresh one.
// Mirrors are tried best-first by their track record (hits minus misses), so one that has only part
// of the film (e.g. nostr.download while it fills up) doesn't become the first try after a single hit.
function mirrorBook(bases) {
  const score = new Map(bases.map((b) => [b, 0]));
  return {
    bases,
    ranked: () => [...bases].sort((a, b) => score.get(b) - score.get(a)),
    hit: (base) => score.set(base, score.get(base) + 1),
    miss: (base) => score.set(base, score.get(base) - 1),
  };
}

async function hashMatches(url, data) {
  const match = HASH_NAME.exec(new URL(url).pathname);
  return !match || (await sha256OfBuffer(data)) === match[1];
}

function makeLoader(BaseLoader, mirrors, onServed) {
  const { bases, ranked } = mirrors;

  return class BlossomLoader {
    constructor(hlsConfig) {
      this.hlsConfig = hlsConfig;
      this.inner = null;
      this.stats = {
        aborted: false, loaded: 0, retry: 0, total: 0, chunkCount: 0, bwEstimate: 0,
        loading: { start: 0, first: 0, end: 0 }, parsing: { start: 0, end: 0 }, buffering: { start: 0, first: 0, end: 0 },
      };
      this.context = null;
      this.aborted = false;
    }

    destroy() { this.inner?.destroy(); }

    getCacheAge() { return this.inner?.getCacheAge?.() ?? null; }

    getResponseHeader(name) { return this.inner?.getResponseHeader?.(name) ?? null; }

    abort() {
      this.aborted = true;
      this.inner?.abort();
    }

    // hls.js keeps a reference to this.stats from the start, so the same object is reset in place
    // and handed to each new loader (which writes the timings used for quality switching).
    fresh() {
      this.inner?.destroy();
      this.inner = new BaseLoader(this.hlsConfig);
      Object.assign(this.stats, { aborted: false, loaded: 0, retry: 0, total: 0, chunkCount: 0, bwEstimate: 0 });
      Object.assign(this.stats.loading, { start: 0, first: 0, end: 0 });
      Object.assign(this.stats.parsing, { start: 0, end: 0 });
      Object.assign(this.stats.buffering, { start: 0, first: 0, end: 0 });
      this.inner.stats = this.stats;
      return this.inner;
    }

    load(context, config, callbacks) {
      this.context = context;
      const match = HASH_NAME.exec(new URL(context.url).pathname);
      if (!match) return this.fresh().load(context, config, callbacks);
      const order = ranked();
      // hls.js reads its timeouts from loadPolicy; a mirror that never answers (seen with
      // cdn.satellite.earth) must time out so the next one is tried.
      const loadPolicy = { ...config.loadPolicy, maxTimeToFirstByteMs: FETCH_TIMEOUT_MS, maxLoadTimeMs: 4 * FETCH_TIMEOUT_MS };
      let attempt = 0;

      const tryNext = (reason) => {
        if (this.aborted) return;
        if (reason) {
          console.warn(`HLS: ${order[attempt - 1]}${match[1].slice(0, 12)}… failed (${reason}), trying next mirror`);
          mirrors.miss(order[attempt - 1]);
        }
        if (attempt >= order.length) {
          return callbacks.onError({ code: 404, text: "not available on any mirror" }, context, null, this.stats);
        }
        const base = order[attempt++];
        // Fetch from the mirror but keep the original address everywhere else: the P2P layer
        // identifies pieces by URL, so rewriting it (as before) made P2P ignore every piece.
        const mirrorContext = { ...context, url: base + match[1] + match[2] };
        this.fresh().load(mirrorContext, { ...config, loadPolicy, timeout: FETCH_TIMEOUT_MS, maxRetry: 0 }, {
          ...callbacks,
          onSuccess: async (response, stats, _ctx, details) => {
            const data = response.data;
            const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
            if ((await sha256OfBuffer(bytes)) !== match[1]) return tryNext("hash mismatch");
            mirrors.hit(base);
            onServed?.(new URL(base).host);
            callbacks.onSuccess({ ...response, url: context.url }, stats, context, details);
          },
          onError: (error) => tryNext(error?.text || `HTTP ${error?.code}`),
          onTimeout: () => tryNext("timeout"),
        });
      };
      tryNext();
    }
  };
}

// P2P (p2p-media-loader): pieces also come from other viewers of the same film. Every piece is still
// checked against its hash, wherever it came from; HTTP requests go to the best Blossom mirror and move
// to the next one on each retry.
async function p2pConfig(swarmId, mirrors, onServed, onShare) {
  const { HlsJsP2PEngine } = await import("../vendor/p2p-media-loader-hlsjs.es.min.js");
  const attempts = new Map(); // piece -> retries so far
  const lastMirror = new Map(); // piece -> mirror used by the last HTTP request
  const share = { http: 0, p2p: 0, uploaded: 0, p2pChecked: 0, p2pRejected: 0 };
  const cellular = navigator.connection?.type === "cellular" || navigator.connection?.saveData;

  const config = {
    core: {
      segmentMemoryStorageLimit: 150, // MB of pieces kept to share with others (phones have little RAM)
      swarmId, // the film's hash: viewers on different mirrors still share with each other
      announceTrackers: P2P_TRACKERS,
      isP2PUploadDisabled: Boolean(cellular), // don't spend the viewer's mobile data on others
      // The library's defaults fetch up to 50 min ahead over HTTP and 100 min over P2P (made for TV);
      // keep it close to our 30 s buffer so nobody downloads the whole film for a few minutes watched.
      highDemandTimeWindow: 15,
      httpDownloadTimeWindow: 30,
      p2pDownloadTimeWindow: 60,
      httpErrorRetries: mirrors.bases.length,
      httpRequestSetup: async (url, byteRange, signal, requestByteRange) => {
        const match = HASH_NAME.exec(new URL(url).pathname);
        if (!match) return undefined;
        const n = attempts.get(match[1]) ?? 0;
        attempts.set(match[1], n + 1);
        const order = mirrors.ranked();
        const base = order[n % order.length];
        if (n > 0) mirrors.miss(lastMirror.get(match[1]));
        lastMirror.set(match[1], base);
        const headers = new Headers();
        if (requestByteRange) headers.set("Range", `bytes=${requestByteRange.start}-${requestByteRange.end ?? ""}`);
        return new Request(base + match[1] + match[2], { headers, signal });
      },
      validateHTTPSegment: async (url, _range, data) => {
        const ok = await hashMatches(url, data);
        const match = HASH_NAME.exec(new URL(url).pathname);
        const base = match && lastMirror.get(match[1]);
        if (base) {
          (ok ? mirrors.hit : mirrors.miss)(base);
          if (ok) onServed(new URL(base).host);
        }
        return ok;
      },
      validateP2PSegment: async (url, _range, data) => {
        const ok = await hashMatches(url, data);
        share.p2pChecked++;
        if (!ok) share.p2pRejected++;
        return ok;
      },
    },
    onHlsJsCreated: (hls) => {
      const engine = hls.p2pEngine;
      engine.addEventListener("onChunkDownloaded", (bytes, source) => {
        share[source === "p2p" ? "p2p" : "http"] += bytes;
        onShare(share);
      });
      engine.addEventListener("onChunkUploaded", (bytes) => {
        share.uploaded += bytes;
        onShare(share);
      });
    },
  };
  return { HlsJsP2PEngine, config, share };
}

// Starts playback; resolves with a stop() handle once the first frame is ready, or rejects so the
// caller can fall back to a plain video file. If P2P can't start, it retries with HTTP only.
export async function playHls(video, hlsBlob, servers, opts = {}) {
  try {
    return await startHls(video, hlsBlob, servers, { ...opts, p2p: opts.p2p ?? true });
  } catch (e) {
    if (opts.p2p === false) throw e;
    console.warn("HLS with P2P failed, retrying with HTTP only:", e);
    return startHls(video, hlsBlob, servers, { ...opts, p2p: false });
  }
}

async function startHls(video, hlsBlob, servers, { startAt = 0, onStats, p2p }) {
  const { default: Hls } = await import("../vendor/hls.light.min.mjs");
  if (!Hls.isSupported()) throw new Error("HLS (MediaSource) not supported");

  // Mirror order: whoever answers first for the master playlist, then the rest, then fallbacks.
  const masterUrls = await resolveSources(hlsBlob, servers);
  if (!masterUrls.length) throw new Error("no source for the master playlist");
  const mirrors = mirrorBook([...new Set(masterUrls.map((u) => u.slice(0, u.lastIndexOf("/") + 1)))]);

  let host = "";
  let share = null;
  const onServed = (h) => (host = h);
  const usesP2P = p2p && "RTCPeerConnection" in window;
  const p2pSetup = usesP2P ? await p2pConfig(hlsBlob.sha256, mirrors, onServed, (s) => (share = s)) : null;
  const HlsClass = p2pSetup ? p2pSetup.HlsJsP2PEngine.injectMixin(Hls) : Hls;

  const hls = new HlsClass({
    loader: makeLoader(Hls.DefaultConfig.loader, mirrors, onServed),
    startPosition: startAt || -1,
    startLevel: -1, // pick the first quality from the bandwidth estimate, not the playlist order
    maxBufferLength: 30, // same 30 s of buffer that worked in the WebTorrent tests
    maxMaxBufferLength: 60,
    capLevelToPlayerSize: true, // no 720p on a small phone screen
    // Our loader already tries every mirror; if a piece is missing everywhere, give up fast so hls.js
    // plays that stretch from another quality instead of stalling (seen with a 720p piece missing).
    fragLoadPolicy: {
      default: {
        maxTimeToFirstByteMs: 10000,
        maxLoadTimeMs: 60000,
        timeoutRetry: { maxNumRetry: 1, retryDelayMs: 0, maxRetryDelayMs: 0 },
        errorRetry: { maxNumRetry: 1, retryDelayMs: 300, maxRetryDelayMs: 1000 },
      },
    },
    ...(p2pSetup ? { p2p: p2pSetup.config } : {}),
  });
  const report = () => {
    const level = hls.levels?.[hls.currentLevel];
    const total = share ? share.http + share.p2p : 0;
    onStats?.({
      height: level?.height ?? 0,
      host,
      p2pShare: total ? Math.round((share.p2p / total) * 100) : null,
    });
  };
  hls.on(Hls.Events.LEVEL_SWITCHED, report);
  hls.on(Hls.Events.FRAG_LOADED, report);

  video.hlsPlayer = hls; // for inspection in tests/devtools
  video.hlsShare = () => share;
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
