# CrateScan

Pré-análise de qualidade de áudio para faixas do YouTube, YouTube Music e SoundCloud,
inspirado no carregamento de faixas no rekordbox: baixa o áudio, extrai metadados técnicos
(codec, bitrate, sample rate) e gera um espectrograma + um "corte espectral estimado" que
ajuda a identificar faixas transcodificadas ou de baixo bitrate mesmo quando o bitrate
declarado parece bom.

## Como funciona

1. **Download**: `yt-dlp` baixa o melhor stream de áudio nativo disponível (sem reencodar).
2. **Metadados**: `ffprobe` lê codec, bitrate declarado, sample rate, canais e duração.
3. **Espectrograma**: `ffmpeg` (`showspectrumpic`) gera uma imagem PNG do espectro completo.
4. **Análise de corte espectral**: o backend decodifica o áudio para PCM mono via `ffmpeg`,
   roda FFT (janelas de Hann, [`fft.js`](https://www.npmjs.com/package/fft.js)) em ~60
   pontos ao longo da faixa, calcula o espectro médio em dB e estima a frequência onde a
   energia cai de forma consistente — o "cutoff". Um cutoff baixo (ex.: ~15kHz) mesmo com
   bitrate declarado alto é um forte indício de que a fonte original era de baixa qualidade e
   foi reencodada/upsampled.

Esse heurístico é o mesmo princípio usado por ferramentas como Spek/Sonic Visualiser para
"ver" a qualidade real de um MP3 — aqui ele é automatizado e resumido num veredito.

## Stack

- **Backend: Node.js (JavaScript puro, sem TypeScript, sem build step)** com
  [Express](https://expressjs.com/) para roteamento/arquivos estáticos.
- **Frontend: HTML + CSS + JS puro, sem framework, sem build step** — servido como
  arquivos estáticos direto pelo Express (`express.static`).

## Pré-requisitos

Instale e garanta que estejam no PATH:

- **Node.js 20+**
- **ffmpeg** (inclui `ffprobe`) — https://ffmpeg.org/download.html
  - Windows: `winget install ffmpeg` ou baixe o build estático e adicione ao PATH
  - macOS: `brew install ffmpeg`
  - Linux: `sudo apt install ffmpeg`
- **yt-dlp** — https://github.com/yt-dlp/yt-dlp
  - `pip install -U yt-dlp` ou baixe o binário standalone

Verifique com:

```bash
node --version
ffmpeg -version
ffprobe -version
yt-dlp --version
```

Se algum comando não estiver no PATH, ajuste os caminhos completos via variáveis de
ambiente: `YTDLP_PATH`, `FFMPEG_PATH`, `FFPROBE_PATH`.

### Usando uma conta logada (YouTube Music Premium / SoundCloud) para bitrate mais alto

Sem autenticação, o yt-dlp baixa como visitante anônimo e cada serviço só oferece os
formatos padrão (~128kbps no YouTube) — mesmo que a faixa tenha um stream de bitrate maior
disponível só para contas logadas (Premium no YouTube Music, Go+/faixas privadas no
SoundCloud). Pra desbloquear esses formatos, passe cookies de uma sessão logada, por um dos
dois jeitos abaixo (o primeiro que estiver configurado vence):

1. **Upload pela UI** (recomendado, funciona em qualquer lugar incluindo Docker/deploy
   remoto): exporte o cookies.txt de um navegador logado (extensão "Get cookies.txt
   LOCALLY" ou similar — um único export já carrega os cookies de todos os domínios
   visitados nessa sessão, então o mesmo arquivo serve tanto pra YouTube quanto pra
   SoundCloud, sem precisar de dois uploads separados) e envie pelo botão "Enviar
   cookies.txt" no topo da página. Na hora do upload, o servidor roda uma checagem rápida
   com yt-dlp contra os dois serviços em paralelo (uma URL pública de cada) e aceita o
   cookie se pelo menos um validar — cobre tanto o caso de um cookie só de YouTube/YouTube
   Music quanto um export combinado com SoundCloud junto, e rejeita com mensagem clara só se
   o export estiver expirado/corrompido pros dois, em vez de só falhar depois na hora de
   analisar uma faixa de verdade.
2. `YTDLP_COOKIES_FILE=/caminho/cookies.txt` — mesma ideia, mas apontando o caminho direto
   via variável de ambiente em vez de subir pela UI.

Os dois métodos acabam apontando pra um cookies.txt salvo em `COOKIES_DIR` (padrão
`/app/data/auth` — monte um volume aí, como já vem configurado no `docker-compose.yml`,
pra persistir entre restarts). Como cada container serve um usuário só, não há risco de um
cookie vazar pra outra pessoa.

> Não há um jeito confiável de ler os cookies direto do navegador instalado (via
> `--cookies-from-browser`): no Windows, o Chrome mantém o próprio arquivo de cookies
> travado enquanto está rodando ([yt-dlp#7271](https://github.com/yt-dlp/yt-dlp/issues/7271)),
> então essa abordagem falha com frequência — o export manual (opção 1 acima) é o caminho
> confiável.

Se `Requested format is not available`/`No video formats found!` aparecer numa faixa real
mesmo com um cookies.txt válido, primeiro confirme que o yt-dlp está atualizado (`pip
install -U yt-dlp` local, ou rebuild da imagem Docker — o `Dockerfile` já baixa o release
mais recente no build). Se persistir só com cookie ativo (sem cookie funciona normal): com
autenticação, o YouTube muda o client usado pelo yt-dlp pra um que exige resolver um
"desafio n" via runtime JavaScript, e o yt-dlp só confia em Deno por padrão — sem isso, todo
formato é descartado. O app já contorna isso sozinho, apontando o yt-dlp pro mesmo binário
Node.js que roda o próprio CrateScan (`--js-runtimes node:<caminho do node>`), sem precisar
instalar nada a mais. Se for rodar yt-dlp manualmente fora do app, adicione
`--js-runtimes node` (ou instale o [Deno](https://deno.com/)) no comando.

Com cookies válidos, o app já escolhe automaticamente o melhor formato disponível
(`-f bestaudio/best`) — nenhuma configuração extra é necessária além do acima.

Se aparecer `HTTP Error 403: Forbidden` ao baixar uma faixa **sem** cookie configurado
(diferente do erro acima — a listagem de formatos funciona, só a URL do arquivo de áudio
em si é rejeitada), é o YouTube bloqueando acesso anônimo de forma inconsistente
(por vídeo/região/momento), não um problema do app. Enviar um cookies.txt de uma conta
logada normalmente resolve — não precisa ser Premium, só uma conta autenticada.

## Rodando localmente

```bash
npm install
npm start
```

Abra `http://localhost:5178` no navegador, cole a URL de uma faixa ou playlist do YouTube,
YouTube Music ou SoundCloud e clique em **Analisar** — a plataforma é detectada
automaticamente pela URL, sem precisar selecionar nada antes.

> A porta é `5178` por padrão; mude com a variável de ambiente `PORT`.

## Rodando com Docker

Não precisa instalar Node, ffmpeg nem yt-dlp na máquina — tudo já vem na imagem
(`Dockerfile`: Node 20 + ffmpeg + yt-dlp standalone). Só precisa de Docker + Docker
Compose.

```bash
docker compose up --build
```

Abre em `http://localhost:5178`. Pra rodar em background: `docker compose up -d --build`.
Pra parar: `docker compose down` (os volumes continuam — os dados não somem entre
restarts; use `docker compose down -v` se quiser apagar tudo).

O `docker-compose.yml` já vem com dois volumes nomeados que persistem entre restarts:

- `spectrograms` — imagens de espectrograma geradas (`/app/public/spectrograms`).
- `cookies_data` — cookies.txt enviado pela UI (`/app/data/auth`). O upload pelo botão
  "Enviar cookies.txt" funciona exatamente igual ao rodando local — é o jeito recomendado de
  configurar autenticação em Docker (veja a seção acima).

Além desses, a biblioteca organizada (`LIBRARY_ROOT`, ver seção acima sobre o modo
"Baixar") vem montada como **bind-mount pro host** (não volume nomeado) por padrão, em
`./data/library`, pra dar pra abrir os arquivos direto no explorador de arquivos/Rekordbox
sem precisar entrar no container. Pra apontar pra outra pasta do host:

```bash
LIBRARY_HOST_PATH=/caminho/no/host/minha-musica docker compose up --build
```

Pra mudar a porta exposta no host, edite o mapeamento `ports` em `docker-compose.yml`
(ex. `"8080:5178"`).

Se preferir pré-configurar um cookie sem passar pela UI (ex. automatizando o deploy),
dá pra montar um cookies.txt do host direto, sem precisar entrar na UI depois de subir:

```bash
YTDLP_COOKIES_HOST_PATH=/caminho/no/host/cookies.txt YTDLP_COOKIES_FILE=/app/cookies.txt \
  docker compose up --build
```

## Estrutura do projeto

```
create-scan/
  src/
    server.js                   # Express app: rotas + orquestração da análise
    config.js                    # caminhos das ferramentas externas, porta, cookies
    services/
      ytDlpService.js             # download/listagem via yt-dlp + autenticação por cookie
      ffmpegService.js            # metadados + espectrograma + decodificação PCM + remux
      spectrumAnalyzer.js         # FFT e heurística de corte espectral
      analysisPipeline.js         # orquestra download → metadados → espectro → veredito
      downloadPipeline.js         # modo "Baixar": só download + remux, sem análise
      analysisCache.js            # cache em memória por videoId (TTL 1h)
      downloadStore.js            # mantém o áudio baixado disponível pra download local
      libraryStore.js             # copia o download final pra dentro de LIBRARY_ROOT, organizado
      cookieStore.js              # cookies.txt enviado pela UI
      reportGenerator.js          # export de relatório em CSV/PDF
      processRunner.js            # helper para rodar processos externos
  public/
    index.html / styles.css / app.js   # frontend (HTML/CSS/JS puro, sem build step)
```

## Funcionalidades

- **Detecção automática de plataforma**: não há seletor de plataforma na UI — cole a URL
  (YouTube, YouTube Music ou SoundCloud, faixa isolada ou playlist/set) e o yt-dlp detecta o
  serviço sozinho pelo próprio link.
- **Streaming de progresso**: `GET /api/analyze/stream?url=...` expõe a análise via
  Server-Sent Events, emitindo estágios (`download_start`, `download_progress`,
  `metadata_start`, `spectrogram_start`, `fft_start`, `done`/`error`) — o frontend consome
  via `EventSource`. `POST /api/analyze` (bloqueante) também está disponível.
- **Playlist com seleção**: colar uma URL de playlist lista as faixas primeiro (via yt-dlp
  `--flat-playlist`, sem baixar nada) pra você escolher quais analisar antes de qualquer
  download. `GET /api/analyze-playlist/stream?url=...` também existe como endpoint separado
  que analisa a playlist inteira automaticamente (não é o fluxo usado pela UI hoje).
- **Download local**: depois de analisada, a faixa fica disponível pra baixar
  (`GET /api/download/:id`), remuxada pra uma extensão compatível com o codec real (sem
  reencode) — ver seção de cookies acima pra qualidade mais alta.
- **Modo "Baixar" (aba separada da análise)**: cole uma URL de faixa, álbum ou playlist e
  baixe o áudio nativo direto, sem rodar espectrograma/FFT. Cada faixa baixada é
  automaticamente copiada pra dentro da biblioteca local organizada (pasta configurada via
  `LIBRARY_ROOT`, padrão `data/library`) — dá pra definir uma subpasta de destino, ligar
  uma pasta agregadora com o nome da playlist/álbum e numerar as faixas na ordem original
  (`01 - `, `02 - `, ...). O link "Baixar novamente" (`GET /api/download-track/stream`)
  continua disponível como reserva além da cópia salva na biblioteca.
- **Cache de análise**: resultado fica em memória por `videoId` (TTL 1h); "Limpar cache" na
  UI invalida uma faixa específica ou tudo, útil depois de configurar/trocar um cookie.
- **Exportar relatório**: `POST /api/report?format=csv|pdf`, body `{ sessions: [...] }` com
  resultados de `/api/analyze` já obtidos pelo cliente (sem storage no servidor). Gera CSV
  (uma linha por faixa) ou PDF (uma seção por faixa, via `pdfkit`).

## Limitações conhecidas

- O "corte espectral" é uma heurística (limiar de -24dB abaixo da banda de referência
  1-5kHz). Funciona bem para casos claros (128kbps vs lossless), mas pode ser impreciso em
  fronteiras (ex.: 192kbps vs 224kbps).
- Sem persistência: nada é salvo em banco; cache e cookie ficam em memória/disco do
  processo (cache zera a cada restart; cookie sobrevive se `data/`/`cookies_data` estiver
  num volume persistente).
