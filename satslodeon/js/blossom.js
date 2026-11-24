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
export async function authHeader(action, sha256, description) {
  if (!window.nostr) throw new Error("NIP-07 extension not found");
  const event = await window.nostr.signEvent({
    kind: 24242,
    created_at: Math.floor(Date.now() / 1000),
    content: description,
    tags: [
      ["t", action],
      ["x", sha256],
      ["expiration", String(Math.floor(Date.now() / 1000) + 600)],
    ],
  });
  return "Nostr " + toBase64Utf8(JSON.stringify(event));
}

// BUD-06: asks the server whether it would accept the blob before sending it.
export async function checkUpload(server, file, sha256) {
  const res = await fetch(`${trim(server)}/upload`, {
    method: "HEAD",
    headers: {
      "X-SHA-256": sha256,
      "X-Content-Length": String(file.size),
      "X-Content-Type": file.type || "application/octet-stream",
    },
  });
  return { ok: res.ok, status: res.status, reason: res.headers.get("X-Reason") };
}

export function upload(server, file, auth, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", `${trim(server)}/upload`);
    xhr.setRequestHeader("Authorization", auth);
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(JSON.parse(xhr.responseText));
      else reject(new Error(xhr.getResponseHeader("X-Reason") || `HTTP ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error("network error"));
    xhr.send(file);
  });
}

// BUD-04: asks another server to copy a blob from a URL it can already reach.
export async function mirror(server, url, auth) {
  const res = await fetch(`${trim(server)}/mirror`, {
    method: "PUT",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  if (!res.ok) throw new Error(res.headers.get("X-Reason") || `HTTP ${res.status}`);
  return res.json();
}
