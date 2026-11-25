# Bibliotecas de terceiros

- `webtorrent.min.js` e `sw-webtorrent.min.js` (service worker): WebTorrent 2.8.5, licença MIT,
  https://github.com/webtorrent/webtorrent (arquivos `dist/webtorrent.min.js` e `dist/sw.min.js` do pacote npm).
  Copiados para o projeto para não depender de CDN (inclusive dentro do APK).
- `qrcode.min.js`: QRCode.js 1.0.0 (davidshimjs), licença MIT, https://github.com/davidshimjs/qrcodejs
  (cópia do arquivo publicado no cdnjs). Gera o QR da invoice Lightning no diálogo de doação.
