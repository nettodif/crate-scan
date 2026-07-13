# CrateScan

Pré-análise de qualidade de áudio para faixas do YouTube / YouTube Music, inspirado no
carregamento de faixas no rekordbox: baixa o áudio, extrai metadados técnicos (codec,
bitrate, sample rate) e gera um espectrograma + um "corte espectral estimado" que ajuda a
identificar faixas transcodificadas ou de baixo bitrate mesmo quando o bitrate declarado
parece bom.

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

## Rodando localmente

```bash
npm install
npm start
```

Abra `http://localhost:5178` no navegador, cole uma URL do YouTube ou YouTube Music e
clique em **Analisar**.

> A porta é `5178` por padrão; mude com a variável de ambiente `PORT`.

## Estrutura do projeto

```
create-scan/
  src/
    server.js                   # Express app: rotas + orquestração da análise
    config.js                    # caminhos das ferramentas externas + porta
    services/
      ytDlpService.js             # download via yt-dlp
      ffmpegService.js            # metadados + espectrograma + decodificação PCM
      spectrumAnalyzer.js         # FFT e heurística de corte espectral
      processRunner.js            # helper para rodar processos externos
  public/
    index.html / styles.css / app.js   # frontend (HTML/CSS/JS puro, sem build step)
```

## Limitações conhecidas da v1 (próximas iterações)

- O "corte espectral" é uma heurística (limiar de -24dB abaixo da banda de referência
  1-5kHz). Funciona bem para casos claros (128kbps vs lossless), mas pode ser impreciso em
  fronteiras (ex.: 192kbps vs 224kbps).
- ~~Cada análise baixa o áudio do zero (sem cache); faixas longas demoram mais.~~ Resolvido:
  há cache em memória por `videoId` (TTL 1h, ver `src/services/analysisCache.js`) — uma
  segunda análise da mesma faixa retorna instantânea com `cached: true`.
- Sem fila/streaming de progresso — a requisição fica bloqueada até terminar. Para faixas
  muito longas isso pode exigir aumentar o timeout do lado do cliente/proxy.
- Sem persistência: nada é salvo em banco; cada análise é isolada (o cache em memória
  zera a cada restart do processo).
- Roda em um único processo/porta local; ainda não há Dockerfile (fica para quando formos
  falar de deploy no Railway/Cloudflare).

## Ideias para as próximas iterações

- Fila com progresso em tempo real (Server-Sent Events ou WebSockets) para faixas longas.
- Suporte a playlists (analisar várias faixas em lote).
- Exportar relatório (PDF/CSV) de uma sessão de análise.
- Dockerfile + docker-compose (com ffmpeg/yt-dlp já embutidos na imagem) para preparar o
  deploy no Railway.
