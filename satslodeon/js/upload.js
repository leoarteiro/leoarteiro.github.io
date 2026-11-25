import { sha256Hex, authHeader, checkUpload, upload, mirror } from "./blossom.js";
import { createTorrentFile } from "./p2p.js";

const $ = (id) => document.getElementById(id);
let file = null;
let hash = null;

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
const updateSend = () => ($("send").disabled = !(file && hash && window.nostr));

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
  file = e.target.files[0] ?? null;
  hash = null;
  updateSend();
  if (!file) return;
  const mb = (file.size / 1048576).toFixed(1);
  $("hash").textContent = `Calculando hash de ${mb} MB…`;
  hash = await sha256Hex(file);
  $("hash").innerHTML = `SHA-256: <code>${hash}</code>`;
  updateSend();
};

$("send").onclick = async () => {
  const servers = [...document.querySelectorAll("#servers input:checked")].map((i) => i.value);
  $("send").disabled = true;
  $("log").replaceChildren();
  const ok = [];
  let sourceUrl = null;

  // Build the torrent first so a single signature covers both the video and its .torrent.
  const torrentFile = file.type.startsWith("video/") ? await buildTorrent(servers) : null;
  const torrentHash = torrentFile && (await sha256Hex(torrentFile));

  let auth;
  const signLine = log("Aguardando a assinatura na extensão Nostr (confira a janela da Alby/nos2x)…");
  try {
    auth = await authHeader("upload", [hash, torrentHash].filter(Boolean), `Satslodeon: enviar ${file.name}`);
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

  for (const server of servers) {
    const line = log(`${server}: verificando…`);
    try {
      if (sourceUrl) {
        // Mirror is cheaper: the server fetches from a mirror we already have.
        await mirror(server, sourceUrl, auth).catch(() => upload(server, file, auth));
      } else {
        const check = await checkUpload(server, file, hash).catch(() => ({ ok: true }));
        if (!check.ok) throw new Error(check.reason || `recusado (HTTP ${check.status})`);
        const blob = await upload(server, file, auth, (p) => (line.textContent = `${server}: enviando ${Math.round(p * 100)}%`));
        if (blob.sha256 && blob.sha256 !== hash) throw new Error("hash devolvido não confere");
        sourceUrl = blob.url;
      }
      line.textContent = `${server}: ok`;
      line.className = "ok";
      ok.push(server);
    } catch (e) {
      line.textContent = `${server}: ${e.message}`;
      line.className = "bad";
    }
  }

  if (ok.length) {
    const entry = { sha256: hash, ext: extOf(file.name), fallback: [] };
    if (torrentFile) entry.torrent = await storeTorrent(torrentFile, ok[0], auth);
    $("result").hidden = false;
    $("snippet").textContent = JSON.stringify(entry, null, 2);
  }
  updateSend();
};

// Creates the work's torrent; every selected Blossom server is a web seed (servers that end up
// refusing the video simply don't answer, the others keep the film available).
async function buildTorrent(servers) {
  const line = log("Gerando o torrent (P2P)…");
  try {
    const webSeeds = servers.map((s) => `${s.replace(/\/+$/, "")}/${hash}${extOf(file.name)}`);
    const { bytes } = await createTorrentFile(file, webSeeds);
    line.textContent = "Torrent gerado.";
    line.className = "ok";
    return new File([bytes], `${hash}.torrent`, { type: "application/x-bittorrent" });
  } catch (e) {
    line.textContent = `Não foi possível gerar o torrent: ${e.message}`;
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

