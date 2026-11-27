# Bibliotecas de terceiros

- `webtorrent.min.js` e `sw-webtorrent.min.js` (service worker): WebTorrent 2.8.5, licença MIT,
  https://github.com/webtorrent/webtorrent (arquivos `dist/webtorrent.min.js` e `dist/sw.min.js` do pacote npm).
  Copiados para o projeto para não depender de CDN (inclusive dentro do APK).
- `qrcode.min.js`: QRCode.js 1.0.0 (davidshimjs), licença MIT, https://github.com/davidshimjs/qrcodejs
  (cópia do arquivo publicado no cdnjs). Gera o QR da invoice Lightning no diálogo de doação.
- `hls.light.min.mjs`: hls.js 1.7.4 (versão "light"), licença Apache-2.0, https://github.com/video-dev/hls.js
  (arquivo `dist/hls.light.min.mjs` do pacote npm). Toca os filmes longos em HLS.
- `p2p-media-loader-core.es.min.js` e `p2p-media-loader-hlsjs.es.min.js`: p2p-media-loader 4.0.0 (Novage), licença
  Apache-2.0, https://github.com/Novage/p2p-media-loader. No arquivo hlsjs, o import `"p2p-media-loader-core"` foi
  trocado pelo caminho relativo do arquivo local (o navegador não resolve nomes de pacote).
- `nostr-tools.min.mjs`: nostr-tools 2.26.1, licença Unlicense, https://github.com/nbd-wtf/nostr-tools. Pacote único
  gerado com esbuild só com `verifyEvent` (pure) e `decode`/`npubEncode` (nip19): confere a assinatura do catálogo
  publicado no Nostr.
- `nostr-connect.min.mjs`: nostr-tools 2.26.1 (mesma licença), pacote separado com `BunkerSigner` e
  `createNostrConnectURI` (NIP-46) para a página de publicação assinar pelo Amber. Fica fora do app.
