// Streams a work over WebTorrent (other viewers + Blossom web seeds) through the service
// worker, keeping only ~30 s buffered ahead so viewers who stop early don't download the
// whole film. Settings come from the lab tests in docs/teste-webtorrent-2026-11.md.

import { isCellular, onCellularChange } from "./net.js";

const WSS_TRACKERS = ["wss://tracker.openwebtorrent.com", "wss://tracker.webtorrent.dev"];
const AHEAD_PAUSE_S = 30;
const AHEAD_RESUME_S = 15;
const START_TIMEOUT_MS = 15000;

export const p2pSupported = () => "serviceWorker" in navigator && "RTCPeerConnection" in window;

let clientPromise = null;

function getClient() {
  clientPromise ??= (async () => {
    const { default: WebTorrent } = await import("../vendor/webtorrent.min.js");
    await navigator.serviceWorker.register("sw.js");
    const reg = await navigator.serviceWorker.ready;
    // "ready" can resolve while the worker is still activating (seen in the Android WebView).
    if (reg.active.state !== "activated") {
      await new Promise((ok) => reg.active.addEventListener("statechange", (e) => e.target.state === "activated" && ok()));
    }
    const client = new WebTorrent();
    client.createServer({ controller: reg });
    // Don't spend the viewer's mobile data plan sharing with others (inside the APK the
    // WebView can't tell, so the native network plugin is asked; see net.js).
    if (await isCellular()) client.throttleUpload(0);
    onCellularChange((onCellular) => client.throttleUpload(onCellular ? 0 : -1));
    return client;
  })();
  clientPromise.catch(() => (clientPromise = null));
  return clientPromise;
}

function addTorrent(client, torrentUrl) {
  return new Promise((resolve, reject) => {
    const existing = client.torrents.find((t) => t.p2pSourceUrl === torrentUrl);
    if (existing) return existing.ready ? resolve(existing) : existing.once("ready", () => resolve(existing));
    const torrent = client.add(torrentUrl, { announce: WSS_TRACKERS });
    torrent.p2pSourceUrl = torrentUrl;
    torrent.once("ready", () => resolve(torrent));
    torrent.once("error", reject);
  });
}

// Seconds of video already downloaded in sequence after the playhead.
function secondsAhead(torrent, file, video) {
  if (!video.duration) return 0;
  const bytesPerSec = file.length / video.duration;
  const pieceLen = torrent.pieceLength;
  const offset = file.offset + Math.floor(video.currentTime * bytesPerSec);
  const last = Math.floor((file.offset + file.length - 1) / pieceLen);
  let piece = Math.floor(offset / pieceLen);
  let bytes = 0;
  while (piece <= last && torrent.bitfield.get(piece)) { bytes += pieceLen; piece++; }
  return Math.max(0, bytes - (offset % pieceLen)) / bytesPerSec;
}

function peerShare(torrent) {
  let fromPeers = 0, total = 0;
  for (const wire of torrent.wires) {
    total += wire.downloaded;
    if (wire.type !== "webSeed") fromPeers += wire.downloaded;
  }
  return total ? Math.round((fromPeers / total) * 100) : 0;
}

// Starts P2P playback. Resolves with a stop() handle once the first frame plays;
// rejects if it can't start in time, so the caller can fall back to direct URLs.
export async function playTorrent(video, blob, mirrorUrls, onStats) {
  const client = await getClient();
  const torrent = await addTorrent(client, blob.torrent);

  // Single-file torrents can use every Blossom mirror as a web seed, even ones added later.
  if (torrent.files.length === 1) {
    for (const url of mirrorUrls) if (!torrent.urlList.includes(url)) torrent.addWebSeed(url);
  }
  const file = torrent.files.reduce((a, b) => (b.length > a.length ? b : a));
  // Download only what the player asks for (same as the lab test): nothing is selected upfront.
  torrent.files.forEach((f) => f.deselect());
  torrent.deselect(0, torrent.pieces.length - 1, false);

  let paused = false;
  const timer = setInterval(() => {
    const ahead = secondsAhead(torrent, file, video);
    if (!paused && ahead > AHEAD_PAUSE_S) { client.throttleDownload(0); paused = true; }
    else if (paused && ahead < AHEAD_RESUME_S) { client.throttleDownload(-1); paused = false; }
    onStats?.({ peers: torrent.numPeers, peerShare: peerShare(torrent), downloadedMB: torrent.downloaded / 1e6 });
  }, 500);

  const stop = () => {
    clearInterval(timer);
    client.throttleDownload(-1);
    file.deselect(); // keep sharing what we have, stop downloading more
  };

  video.preload = "auto"; // feed slides start with preload="none", which would never load
  file.streamTo(video);

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { cleanup(); stop(); reject(new Error("p2p start timeout")); }, START_TIMEOUT_MS);
    const ok = () => { cleanup(); resolve(); };
    const cleanup = () => { clearTimeout(timeout); video.removeEventListener("loadeddata", ok); };
    video.addEventListener("loadeddata", ok);
  });
  return { stop };
}

// Builds a .torrent for a video already on Blossom: every mirror becomes a web seed, so the
// film is always available even with no other viewers online. Runs fully in the browser.
export async function createTorrentFile(file, webSeedUrls) {
  const { default: WebTorrent } = await import("../vendor/webtorrent.min.js");
  const client = new WebTorrent();
  try {
    const torrent = await new Promise((resolve, reject) => {
      client.once("error", reject);
      client.seed(file, { announce: WSS_TRACKERS, urlList: webSeedUrls, name: file.name }, resolve);
    });
    return { bytes: new Uint8Array(torrent.torrentFile), infoHash: torrent.infoHash };
  } finally {
    client.destroy();
  }
}
