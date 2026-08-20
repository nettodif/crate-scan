# Empacotamento Windows

Gera um `.exe` standalone do CrateScan (Node + app + `ffmpeg`/`ffprobe`/`yt-dlp`
embutidos) e um instalador — pra rodar num Windows sem precisar instalar nada manualmente.
Isso é **só pra quem vai gerar/distribuir o instalador**; não afeta `npm install`/
`npm start` normais, que continuam exatamente como sempre.

A UI continua sendo a mesma página web de sempre (`public/`) — o `.exe` só sobe o mesmo
servidor Express de sempre e abre o navegador padrão em `localhost`, sem reescrever nada
do frontend.

## Pré-requisitos

- Node.js 20+ e `npm install` já rodado na raiz do repo (inclui as devDependencies deste
  empacotamento: `@yao-pkg/pkg`, `extract-zip`).
- [Inno Setup](https://jrsoftware.org/isinfo.php) instalado (pro passo do instalador —
  `iscc` precisa estar no PATH).
- Acesso à internet (`build.mjs` baixa `yt-dlp.exe` das releases do próprio yt-dlp e um
  build estático de `ffmpeg`/`ffprobe` do [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds)).

## Build

```bash
npm run package:win
iscc packaging/windows/installer.iss
```

Isso gera:

- `dist/CrateScan.exe` — o executável empacotado (via `pkg`).
- `dist/bin/{yt-dlp,ffmpeg,ffprobe}.exe` — binários externos baixados, copiados do lado.
- `dist/CrateScanSetup.exe` — instalador Inno Setup (empacota os dois itens acima).

## Como funciona

- **`launcher.mjs`** é o ponto de entrada empacotado: define defaults de `COOKIES_DIR`/
  `LIBRARY_ROOT`/`SPECTROGRAM_DIR`/`YTDLP_PATH`/`FFMPEG_PATH`/`FFPROBE_PATH` (só quando
  ainda não setados) apontando pra pastas do usuário (`%APPDATA%`/Documentos) e pros
  binários que ficam do lado do `.exe`, depois sobe `src/server.js` sem tocar em nada
  dele — o app já era 100% dirigido por essas env vars (`src/config.js`), então empacotar
  é só uma questão de defini-las diferente, não de mudar como são usadas.
- **`build.mjs`** baixa os binários, roda `pkg` sobre `launcher.mjs` (que arrasta
  `src/`, `node_modules` e — via a config `pkg.assets` no `package.json` da raiz —
  `public/` pro snapshot do executável) e copia os binários pra `dist/bin`.
- **`installer.iss`**: instala em modo **por usuário** (`PrivilegesRequired=lowest`, sem
  pedir elevação/UAC), cria atalho no Menu Iniciar (+ desktop opcional).

## Onde os dados ficam (app instalado)

- Cookies: `%APPDATA%\CrateScan\auth\cookies.txt`
- Biblioteca de música organizada: `Documentos\CrateScan\`
- Espectrogramas (cache visual): `%APPDATA%\CrateScan\spectrograms`

Tudo fora da pasta de instalação — sobrevive a reinstalar/atualizar o app. Pra apontar
pra outro lugar, defina as env vars antes de abrir o `.exe` (mesmas usadas em
`npm start`/Docker: `COOKIES_DIR`, `LIBRARY_ROOT`, `SPECTROGRAM_DIR`, `YTDLP_PATH`,
`FFMPEG_PATH`, `FFPROBE_PATH`, `PORT`).

## Limitações desta primeira versão

- Sem ícone de bandeja do sistema nem opção de iniciar com o Windows — fechar a janela do
  `.exe` encerra o servidor (mesmo comportamento de fechar um `npm start` no terminal).
- `AppId` do `installer.iss` é um placeholder — gere um GUID novo (Tools → Generate GUID
  no editor do Inno Setup) antes de um release de verdade.
