import { sha256Hex, authHeader, checkUpload, upload, mirror } from "./blossom.js";
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

$("file").onchange = async (e) => {
  items = [...e.target.files].map((file) => ({ file, hash: null }));
  updateSend();
  if (!items.length) return;
  const total = items.reduce((n, i) => n + i.file.size, 0);
  $("hash").textContent = `Calculando o hash de ${items.length} arquivo(s), ${(total / 1048576).toFixed(1)} MB…`;
  for (const item of items) item.hash = await sha256Hex(item.file);
  $("hash").innerHTML = items.map((i) => `${i.file.name}: <code>${i.hash.slice(0, 16)}…</code>`).join("<br>");
  updateSend();
};

$("send").onclick = async () => {
  const servers = [...document.querySelectorAll("#servers input:checked")].map((i) => i.value);
  $("send").disabled = true;
  $("log").replaceChildren();

  // Build torrents first so one signature covers every file and every .torrent.
  for (const item of items) {
    item.torrentFile = item.file.type.startsWith("video/") ? await buildTorrent(item, servers) : null;
    item.torrentHash = item.torrentFile && (await sha256Hex(item.torrentFile));
  }

  let auth;
  const signLine = log("Aguardando a assinatura na extensão Nostr (confira a janela da extensão)…");
  try {
    const hashes = items.flatMap((i) => [i.hash, i.torrentHash]).filter(Boolean);
    const names = items.map((i) => i.file.name).join(", ");
    auth = await authHeader("upload", hashes, `Satslodeon: enviar ${names}`.slice(0, 300));
    signLine.textContent = "Assinado.";
    signLine.className = "ok";
  } catch (e) {
    signLine.className = "bad";
    signLine.textContent = /cancel|reject|denied/i.test(e.message)
      ? "A janela de assinatura foi fechada ou recusada. Recarregue a página (F5), conecte de novo, envie e aprove a assinatura na extensão."
      : `Assinatura falhou: ${e.message}`;
    updateSend();
    return;
  }

  const entries = [];
  for (const item of items) {
    const ok = await sendToServers(item, servers, auth);
    if (!ok.length) continue;
    const entry = { sha256: item.hash, ext: extOf(item.file.name), fallback: [] };
    if (item.torrentFile) entry.torrent = await storeTorrent(item.torrentFile, ok[0], auth);
    entries.push({ item, entry });
  }

  if (entries.length) {
    $("result").hidden = false;
    $("snippet").textContent = entries.map(({ item, entry }) => {
      const known = findInCatalog(item.hash);
      const head = known ? `// ${item.file.name}: já está no catálogo (${known}); nada a colar.` : `// ${item.file.name}`;
      return `${head}\n${JSON.stringify(entry, null, 2)}`;
    }).join("\n\n");
  }
  updateSend();
};

// Uploads one file to the first server that accepts it and asks the others to mirror it.
async function sendToServers(item, servers, auth) {
  const { file, hash } = item;
  const ok = [];
  let sourceUrl = null;
  for (const server of servers) {
    const line = log(`${file.name} → ${server}: verificando…`);
    try {
      if (sourceUrl) {
        // Mirror is cheaper: the server fetches from a mirror we already have.
        await mirror(server, sourceUrl, auth).catch(() => upload(server, file, auth));
      } else {
        const check = await checkUpload(server, file, hash).catch(() => ({ ok: true }));
        if (!check.ok) throw new Error(check.reason || `recusado (HTTP ${check.status})`);
        const blob = await upload(server, file, auth, (p) => (line.textContent = `${file.name} → ${server}: enviando ${Math.round(p * 100)}%`));
        if (blob.sha256 && blob.sha256 !== hash) throw new Error("hash devolvido não confere");
        sourceUrl = blob.url;
      }
      line.textContent = `${file.name} → ${server}: ok`;
      line.className = "ok";
      ok.push(server);
    } catch (e) {
      line.textContent = `${file.name} → ${server}: ${e.message}`;
      line.className = "bad";
    }
  }
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

