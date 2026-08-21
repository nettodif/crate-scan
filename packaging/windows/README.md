# Empacotamento Windows

Gera um `.exe` standalone do CrateScan (Node + app + `ffmpeg`/`ffprobe`/`yt-dlp`
embutidos) e um instalador — pra rodar num Windows sem precisar instalar nada manualmente.
Isso é **só pra quem vai gerar/distribuir o instalador**; não afeta `npm install`/
`npm start` normais, que continuam exatamente como sempre.

A UI continua sendo a mesma página web de sempre (`public/`) — o `.exe` só sobe o mesmo
servidor Express de sempre e abre o navegador padrão em `localhost`, sem reescrever nada
do frontend.

O passo do `pkg` (o que gera o `.exe`) **não precisa de um Windows de verdade** — `pkg`
injeta um binário Node pré-compilado do alvo (`node20-win-x64`) num app 100% JavaScript
puro, sem nada nativo pra compilar. Só o instalador (Inno Setup, `iscc`) exige Windows —
não tem build oficial pra Linux. Por isso há três formas de gerar o build, da mais rápida
(sem instalador) até a mais completa:

| Caminho | O que produz | Precisa de Windows? |
|---|---|---|
| Local direto (abaixo) | `.exe` + instalador | Sim (roda tudo na sua máquina Windows) |
| Docker (`build.Dockerfile`) | só o `.exe` (portable) | Não — roda em qualquer host com Docker |
| GitHub Actions (`build-windows.yml`) | `.exe` + instalador | Não — CI cuida de tudo, inclusive o passo Windows |

## Pré-requisitos (build local direto)

- Node.js 20+ e `npm install` já rodado na raiz do repo (inclui as devDependencies deste
  empacotamento: `@yao-pkg/pkg`, `extract-zip`).
- [Inno Setup](https://jrsoftware.org/isinfo.php) instalado (pro passo do instalador —
  `iscc` precisa estar no PATH).
- Acesso à internet (`build.mjs` baixa `yt-dlp.exe` das releases do próprio yt-dlp e um
  build estático de `ffmpeg`/`ffprobe` do [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds)).

## Build local direto (numa máquina Windows)

```bash
npm run package:win
iscc packaging/windows/installer.iss
```

Isso gera:

- `dist/CrateScan.exe` — o executável empacotado (via `pkg`).
- `dist/bin/{yt-dlp,ffmpeg,ffprobe}.exe` — binários externos baixados, copiados do lado.
- `dist/CrateScanSetup.exe` — instalador Inno Setup (empacota os dois itens acima).

## Build via Docker (sem precisar de Windows — só o `.exe`, sem instalador)

Pra quem não tem/quer usar uma máquina Windows só pra gerar o `.exe`: roda o passo do
`pkg` dentro de um container Linux comum. Não produz o instalador (isso só dá pra fazer
com Windows de verdade — ver a opção do GitHub Actions abaixo), mas o resultado já é um
`.exe` funcional standalone: zipe `CrateScan.exe` + a pasta `bin/` juntos e já dá pra rodar
num Windows sem instalar nada (só sem atalho no Menu Iniciar).

```bash
docker build -f packaging/windows/build.Dockerfile -t cratescan-winbuild .
docker run --rm -v "$(pwd)/dist:/app/dist" cratescan-winbuild
```

Gera `dist/CrateScan.exe` + `dist/bin/*.exe` no host, mesma saída do passo `pkg` do build
local.

## Build via GitHub Actions (pipeline completo, sem precisar de Windows local)

`.github/workflows/build-windows.yml` roda o pipeline inteiro em CI — um job Linux pro
`.exe` (mesma ideia do Docker acima) e um job `windows-latest` só pro instalador (runner
Windows nativo do GitHub, sem Wine nem gambiarra). Pra rodar: aba **Actions** do repo →
**Build Windows package** → **Run workflow**. Ao terminar, o artifact
`cratescan-installer` do job `build-installer` traz o `CrateScanSetup.exe` pronto pra
baixar — essa é a forma recomendada de gerar um release de verdade sem precisar tocar
numa máquina Windows.

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
