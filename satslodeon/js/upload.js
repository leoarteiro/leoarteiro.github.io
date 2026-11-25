import { sha256Hex, authHeader, checkUpload, upload, mirror } from "./blossom.js";
import { createTorrentFile } from "./p2p.js";

const $ = (id) => document.getElementById(id);
let file = null;
let hash = null;

const catalog = await (await fetch("catalog.json", { cache: "no-cache" })).json();
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

$("connect").onclick = async () => {
  if (!window.nostr) { $("who").textContent = "Extensão NIP-07 não encontrada. Instale Alby ou nos2x e recarregue."; return; }
  const pubkey = await window.nostr.getPublicKey();
  $("who").textContent = `Conectado: ${pubkey.slice(0, 12)}…${pubkey.slice(-6)}`;
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

  try {
    const auth = await authHeader("upload", hash, `Satslodeon: ${file.name}`);
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
  } catch (e) {
    log(`Assinatura recusada: ${e.message}`, "bad");
  }

  if (ok.length) {
    const entry = { sha256: hash, ext: extOf(file.name), fallback: [] };
    if (file.type.startsWith("video/")) entry.torrent = await makeTorrent(ok);
    $("result").hidden = false;
    $("snippet").textContent = JSON.stringify(entry, null, 2);
  }
  updateSend();
};

$("copySnippet").onclick = () => navigator.clipboard.writeText($("snippet").textContent);

// Creates the work's torrent (web seeds = Blossom mirrors that accepted the video) and stores
// the .torrent on Blossom too. Falls back to a download if that upload fails.
async function makeTorrent(servers) {
  const line = log("Gerando o torrent (P2P)…");
  try {
    const webSeeds = servers.map((s) => `${s.replace(/\/+$/, "")}/${hash}${extOf(file.name)}`);
    const { bytes } = await createTorrentFile(file, webSeeds);
    const torrentFile = new File([bytes], `${hash}.torrent`, { type: "application/x-bittorrent" });
    const torrentHash = await sha256Hex(torrentFile);
    try {
      const auth = await authHeader("upload", torrentHash, `Satslodeon: torrent de ${file.name}`);
      const blob = await upload(servers[0], torrentFile, auth);
      line.textContent = `Torrent gerado e enviado: ${blob.url}`;
      line.className = "ok";
      return blob.url;
    } catch (e) {
      const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(torrentFile), download: torrentFile.name });
      a.click();
      line.textContent = `Torrent gerado (baixado como ${torrentFile.name}; o envio falhou: ${e.message}). Coloque-o em web/torrents/.`;
      line.className = "bad";
      return `torrents/${torrentFile.name}`;
    }
  } catch (e) {
    line.textContent = `Não foi possível gerar o torrent: ${e.message}`;
    line.className = "bad";
    return undefined;
  }
}
