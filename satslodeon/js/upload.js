import { sha256Hex, authHeader, checkUpload, upload, mirror, hasBlob } from "./blossom.js";
import { createTorrentFile } from "./p2p.js";

const $ = (id) => document.getElementById(id);
let items = []; // [{ file, hash }] — several files can go with a single signature

const catalog = await (await fetch("catalog.json", { cache: "no-cache" })).json().catch(() => ({ blossomServers: [] }));
$("servers").append(...catalog.blossomServers.map((s) => {
  const label = document.createElement("label");
  const box = Object.assign(document.createElement("input"), { type: "checkbox", checked: true, value: s });
  label.append(box, s);
  return label;
}));

function log(text, cls = "") {
  const li = Object.assign(document.createElement("li"), { textContent: text, className: cls });
  $("log").append(li);
  return li;
}

const extOf = (name) => (name.match(/\.[a-z0-9]+$/i)?.[0] ?? "").toLowerCase();
const updateSend = () => ($("send").disabled = !(items.length && items.every((i) => i.hash) && window.nostr));

// Extensions inject window.nostr a moment after the page loads; wait a little for it.
async function waitForNostr(ms = 3000) {
  for (let t = 0; !window.nostr && t < ms; t += 200) await new Promise((r) => setTimeout(r, 200));
  return window.nostr;
}

$("connect").onclick = async () => {
  $("who").textContent = "Conectando…";
  if (!(await waitForNostr())) {
    $("who").textContent = "Extensão Nostr não encontrada nesta página. Confira se a Alby (ou nos2x) está instalada e ativa, e recarregue a página (F5).";
    return;
  }
  try {
    const pubkey = await window.nostr.getPublicKey();
    if (!pubkey) throw new Error("a extensão não devolveu a chave pública");
    $("who").textContent = `Conectado: ${pubkey.slice(0, 12)}…${pubkey.slice(-6)}`;
  } catch (e) {
    $("who").textContent = `A extensão recusou ou falhou: ${e?.message || e}. Na Alby, confira se há uma chave Nostr configurada (Configurações → Nostr) e se você permitiu este site.`;
  }
  updateSend();
};

const HASH_BATCH = 25; // hashes per signature: one header with ~1,600 hashes would be too big for servers
const PARALLEL = 3; // files sent at the same time

$("folder").onchange = $("file").onchange = async (e) => {
  items = [...e.target.files].filter((f) => !f.name.startsWith(".")).map((file) => ({ file, hash: null }));
  updateSend();
  if (!items.length) return;
  const total = items.reduce((n, i) => n + i.file.size, 0);
  $("hash").textContent = `Calculando o hash de ${items.length} arquivo(s), ${(total / 1048576).toFixed(1)} MB…`;
  for (const item of items) item.hash = await sha256Hex(item.file);
  $("hash").innerHTML = items.length > 8
    ? `${items.length} arquivos prontos (${(total / 1048576).toFixed(1)} MB). Serão pedidas ${Math.ceil(items.length / HASH_BATCH)} assinatura(s): na nos2x, escolha “autorizar sempre” para este site.`
    : items.map((i) => `${i.file.name}: <code>${i.hash.slice(0, 16)}…</code>`).join("<br>");
  updateSend();
};

$("send").onclick = async () => {
  const servers = [...document.querySelectorAll("#servers input:checked")].map((i) => i.value);
  $("send").disabled = true;
  $("log").replaceChildren();
  strikes.clear();
  // HLS pieces (.ts/.m4s) and playlists never get a torrent, even when re-sent on their own.
  const isHls = items.some((i) => /\.(m3u8|ts|m4s)$/.test(i.file.name));

  // Build torrents first (plain videos only; HLS pieces don't need one) so the signatures cover them.
  for (const item of items) {
    item.torrentFile = !isHls && item.file.type.startsWith("video/") ? await buildTorrent(item, servers) : null;
    item.torrentHash = item.torrentFile && (await sha256Hex(item.torrentFile));
  }

  // One signature per batch of files; with "always allow" in the extension these are silent.
  const batches = [];
  for (let i = 0; i < items.length; i += HASH_BATCH) batches.push(items.slice(i, i + HASH_BATCH));
  const signLine = log(`Aguardando ${batches.length} assinatura(s) na extensão Nostr (confira a janela da extensão)…`);
  try {
    for (const [n, batch] of batches.entries()) {
      const hashes = batch.flatMap((i) => [i.hash, i.torrentHash]).filter(Boolean);
      const names = batch.map((i) => i.file.name).join(", ");
      const auth = await authHeader("upload", hashes, `Satslodeon: enviar ${names}`.slice(0, 300));
      batch.forEach((i) => (i.auth = auth));
      signLine.textContent = `Assinando… ${n + 1}/${batches.length}`;
    }
    signLine.textContent = batches.length > 1 ? `Assinado (${batches.length} lotes).` : "Assinado.";
    signLine.className = "ok";
  } catch (e) {
    signLine.className = "bad";
    signLine.textContent = /cancel|reject|denied/i.test(e.message)
      ? "A janela de assinatura foi fechada ou recusada. Recarregue a página (F5), conecte de novo, envie e aprove a assinatura na extensão."
      : `Assinatura falhou: ${e.message}`;
    updateSend();
    return;
  }

  const progress = log(`Enviando 0/${items.length}…`);
  let done = 0, failed = 0;
  const queue = [...items];
  await Promise.all(Array.from({ length: PARALLEL }, async () => {
    while (queue.length) {
      const item = queue.shift();
      item.ok = await sendToServers(item, servers, item.auth);
      if (!item.ok.length) failed++;
      progress.textContent = `Enviando ${++done}/${items.length}…${failed ? ` (${failed} sem nenhum servidor)` : ""}`;
    }
  }));
  // Before warning, look again for the missing ones (a busy server may have refused only the check).
  for (const item of items.filter((i) => !i.ok.length)) {
    for (const server of servers) {
      if (await hasBlob(server, item.hash, extOf(item.file.name))) item.ok.push(server);
    }
  }
  failed = items.filter((i) => !i.ok.length).length;
  progress.textContent = `Envio concluído: ${items.length - failed}/${items.length} arquivos em pelo menos um servidor.`;
  progress.className = failed ? "bad" : "ok";

  const entries = [];
  for (const item of items.filter((i) => i.ok.length)) {
    const entry = { sha256: item.hash, ext: extOf(item.file.name), fallback: [] };
    if (item.torrentFile) entry.torrent = await storeTorrent(item.torrentFile, item.ok[0], item.auth);
    entries.push({ item, entry });
  }
  if (entries.length) {
    $("result").hidden = false;
    $("snippet").textContent = isHls ? await hlsSnippet(failed) : entries.map(({ item, entry }) => {
      const known = findInCatalog(item.hash);
      const head = known ? `// ${item.file.name}: já está no catálogo (${known}); nada a colar.` : `// ${item.file.name}`;
      return `${head}\n${JSON.stringify(entry, null, 2)}`;
    }).join("\n\n");
  }
  updateSend();
};

// For an HLS folder the catalog only needs the master playlist: the one that lists other playlists.
async function hlsSnippet(failed) {
  for (const item of items.filter((i) => i.file.name.endsWith(".m3u8"))) {
    if ((await item.file.text()).includes(".m3u8")) {
      const warn = failed ? `// ATENÇÃO: ${failed} arquivo(s) não entraram em nenhum servidor; o filme vai travar nesses pontos.\n` : "";
      return `${warn}// Filme em HLS: cole no campo "video" da obra (mantenha o "fallback" atual)\n` +
        JSON.stringify({ hls: { sha256: item.hash, ext: ".m3u8", fallback: [] } }, null, 2);
    }
  }
  return "// Não encontrei a lista principal (master) do HLS nesta pasta.";
}

// A server that fails twice in a row gets no uploads for a minute (servers rate-limit big batches;
// cdn.satellite.earth used to hang on every signed request). Blobs it already has still count.
const MAX_STRIKES = 2;
const COOLDOWN_MS = 60000;
const strikes = new Map(); // server -> { count, until }

const coolingDown = (server) => {
  const st = strikes.get(server);
  if (!st || st.count < MAX_STRIKES) return false;
  if (Date.now() < st.until) return true;
  strikes.delete(server); // cooldown over: try again
  return false;
};
const strike = (server) => {
  const st = strikes.get(server) ?? { count: 0, until: 0 };
  st.count++;
  if (st.count >= MAX_STRIKES) st.until = Date.now() + COOLDOWN_MS;
  strikes.set(server, st);
};

// Uploads one file to the first server that accepts it and asks the others to mirror it.
// One log line per file, updated as each server answers.
async function sendToServers(item, servers, auth) {
  const { file, hash } = item;
  const ok = [];
  const marks = [];
  const line = log(`${file.name}: …`);
  const show = () => (line.textContent = `${file.name}: ${marks.join(" · ")}`);
  let sourceUrl = null;
  for (const server of servers) {
    const host = new URL(server).host;
    try {
      // Already there (e.g. a repeated upload of a big film): nothing to send.
      if (await hasBlob(server, hash, extOf(file.name))) {
        marks.push(`${host} ✓ (já estava)`);
        ok.push(server);
        sourceUrl ??= `${server.replace(/\/+$/, "")}/${hash}${extOf(file.name)}`;
        show();
        continue;
      }
      if (coolingDown(server)) {
        marks.push(`${host} — pausa (falhou várias vezes; tenta de novo em instantes)`);
        show();
        continue;
      }
      if (sourceUrl) {
        // Mirror is cheaper: the server fetches from a mirror we already have.
        await mirror(server, sourceUrl, auth).catch(() => upload(server, file, auth));
      } else {
        const check = await checkUpload(server, file, hash, auth).catch(() => ({ ok: true }));
        if (!check.ok) throw new Error(check.reason || `recusado (HTTP ${check.status})`);
        const blob = await upload(server, file, auth);
        if (blob.sha256 && blob.sha256 !== hash) throw new Error("hash devolvido não confere");
        sourceUrl = blob.url;
      }
      marks.push(`${host} ✓`);
      ok.push(server);
      strikes.delete(server);
    } catch (e) {
      marks.push(`${host} ✗ (${e.message})`);
      strike(server);
    }
    show();
  }
  line.className = ok.length ? "ok" : "bad";
  return ok;
}

// Name of the work that already uses this hash (so the catalog needs no edit), if any.
function findInCatalog(hash) {
  for (const work of catalog.works ?? []) {
    if (work.video?.sha256 === hash) return `vídeo de "${work.title}"`;
    if (work.poster?.sha256 === hash) return `capa de "${work.title}"`;
  }
  return null;
}

// Creates a video's torrent; every selected Blossom server is a web seed (servers that end up
// refusing the video simply don't answer, the others keep the film available).
async function buildTorrent(item, servers) {
  const line = log(`${item.file.name}: gerando o torrent (P2P)…`);
  try {
    const webSeeds = servers.map((s) => `${s.replace(/\/+$/, "")}/${item.hash}${extOf(item.file.name)}`);
    const { bytes } = await createTorrentFile(item.file, webSeeds);
    line.textContent = `${item.file.name}: torrent gerado.`;
    line.className = "ok";
    return new File([bytes], `${item.hash}.torrent`, { type: "application/x-bittorrent" });
  } catch (e) {
    line.textContent = `${item.file.name}: não foi possível gerar o torrent: ${e.message}`;
    line.className = "bad";
    return null;
  }
}

// Stores the .torrent on Blossom with the same signature; falls back to a download.
async function storeTorrent(torrentFile, server, auth) {
  const line = log("Enviando o torrent…");
  try {
    const blob = await upload(server, torrentFile, auth);
    line.textContent = `Torrent enviado: ${blob.url}`;
    line.className = "ok";
    return blob.url;
  } catch (e) {
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(torrentFile), download: torrentFile.name });
    a.click();
    line.textContent = `O envio do torrent falhou (${e.message}); ele foi baixado como ${torrentFile.name}. Mande o arquivo para colocá-lo em web/torrents/.`;
    line.className = "bad";
    return `torrents/${torrentFile.name}`;
  }
}

$("copySnippet").onclick = () => navigator.clipboard.writeText($("snippet").textContent);

