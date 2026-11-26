// Blossom (BUD-01/02/04/06) helpers: resolve blobs by sha256 across mirrors and upload them.

const HEAD_TIMEOUT_MS = 6000;

async function headOk(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HEAD_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: "HEAD", signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return url;
  } finally {
    clearTimeout(timer);
  }
}

const trim = (server) => server.replace(/\/+$/, "");

// Returns an ordered list of candidate URLs: the fastest Blossom mirror that has the
// blob first, then the remaining mirrors, then the legacy fallback URLs.
export async function resolveSources(blob, servers) {
  const fallback = blob.fallback ?? [];
  if (!blob.sha256) return fallback;
  const mirrors = servers.map((s) => `${trim(s)}/${blob.sha256}${blob.ext ?? ""}`);
  try {
    const fastest = await Promise.any(mirrors.map(headOk));
    return [fastest, ...mirrors.filter((u) => u !== fastest), ...fallback];
  } catch {
    return fallback;
  }
}

export async function sha256Hex(file) {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function toBase64Utf8(text) {
  let bin = "";
  for (const byte of new TextEncoder().encode(text)) bin += String.fromCharCode(byte);
  return btoa(bin);
}

// Signs a kind 24242 authorization event with the NIP-07 browser extension.
// One signature can cover several blobs: Blossom accepts multiple "x" tags (one per sha256).
export async function authHeader(action, sha256s, description) {
  if (!window.nostr) throw new Error("NIP-07 extension not found");
  const hashes = Array.isArray(sha256s) ? sha256s : [sha256s];
  const event = await window.nostr.signEvent({
    kind: 24242,
    created_at: Math.floor(Date.now() / 1000),
    content: description,
    tags: [
      ["t", action],
      ...hashes.map((h) => ["x", h]),
      ["expiration", String(Math.floor(Date.now() / 1000) + 600)],
    ],
  });
  return "Nostr " + toBase64Utf8(JSON.stringify(event));
}

// Browsers don't know HLS extensions and send them as "application/octet-stream", which Blossom
// servers refuse.
// ".ts" must win over the browser's guess, which on some systems is TypeScript source.
const TYPES_BY_EXT = { ".ts": "video/mp2t", ".m4s": "video/mp4", ".m3u8": "application/vnd.apple.mpegurl" };
export function contentTypeOf(file) {
  const ext = (file.name.match(/\.[a-z0-9]+$/i)?.[0] ?? "").toLowerCase();
  return TYPES_BY_EXT[ext] || file.type || "application/octet-stream";
}

// A server that never answers must not freeze the upload page (seen with cdn.satellite.earth).
function timeoutSignal(ms) {
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(new Error("o servidor não respondeu a tempo")), ms);
  return ctrl.signal;
}

// True if the server already serves this blob (so a repeated upload can skip it).
export async function hasBlob(server, sha256, ext = "") {
  try {
    const res = await fetch(`${trim(server)}/${sha256}${ext}`, { method: "HEAD", signal: timeoutSignal(8000) });
    return res.ok;
  } catch {
    return false;
  }
}

// BUD-06: asks the server whether it would accept the blob before sending it. Some servers
// (nostr.download) require the signed authorization even for this check.
export async function checkUpload(server, file, sha256, auth) {
  const res = await fetch(`${trim(server)}/upload`, {
    method: "HEAD",
    signal: timeoutSignal(15000),
    headers: {
      ...(auth ? { Authorization: auth } : {}),
      "X-SHA-256": sha256,
      "X-Content-Length": String(file.size),
      "X-Content-Type": contentTypeOf(file),
    },
  });
  return { ok: res.ok, status: res.status, reason: res.headers.get("X-Reason") };
}

export function upload(server, file, auth, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", `${trim(server)}/upload`);
    xhr.setRequestHeader("Authorization", auth);
    xhr.setRequestHeader("Content-Type", contentTypeOf(file));
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(JSON.parse(xhr.responseText));
      else reject(new Error(xhr.getResponseHeader("X-Reason") || `HTTP ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error("network error"));
    // At least 2 min, or ~50 KB/s for big files, before giving up on a silent server.
    xhr.timeout = Math.max(120000, (file.size / 50000) * 1000);
    xhr.ontimeout = () => reject(new Error("o servidor não respondeu a tempo"));
    xhr.send(file);
  });
}

// BUD-04: asks another server to copy a blob from a URL it can already reach.
export async function mirror(server, url, auth) {
  const res = await fetch(`${trim(server)}/mirror`, {
    method: "PUT",
    signal: timeoutSignal(30000),
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  if (!res.ok) throw new Error(res.headers.get("X-Reason") || `HTTP ${res.status}`);
  return res.json();
}
