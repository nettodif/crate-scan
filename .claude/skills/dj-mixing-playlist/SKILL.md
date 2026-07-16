---
name: dj-mixing-playlist
description: Conhecimento de domínio sobre mixagem de DJ e curadoria de set/playlist (BPM, compatibilidade harmônica de tom, phrasing, curva de energia). Use ao discutir ou projetar funcionalidades do CrateScan relacionadas a compatibilidade entre faixas, composição de set ou curadoria de playlist.
---

# Mixagem de DJ e Curadoria de Set/Playlist

Conhecimento de domínio para avaliar compatibilidade entre faixas e composição de
sets, na perspectiva de um DJ experiente (rekordbox). Escopo: **genre-agnostic**
— não separar eletrônica de open format em modos distintos (ver seção de
diferenças de gênero abaixo). Este conhecimento é conceitual: o CrateScan é uma
ferramenta de pré-análise offline, não de performance ao vivo, então habilidades de
execução em tempo real (leitura de pista, etc.) estão fora de escopo.

## As quatro camadas de compatibilidade entre faixas

**BPM (andamento)**
- Compatibilidade não exige BPM idêntico: relações half-time/double-time (ex.: 174
  e 87, 128 e 64) também soam "no tempo".
- Variação interna de tempo (rubato, groove humano, breaks) é uma propriedade real
  da faixa, não um erro de leitura — mesmo com BPM nominal correto.
- BPM é condição necessária mas não suficiente: duas faixas no mesmo BPM ainda
  podem soar erradas juntas se tom ou energia não combinarem.

**Key / Tonalidade**
- Ferramenta central: roda de Camelot (mapeia tonalidade → posição geométrica, onde
  distância harmônica vira distância na roda).
- Ordem de compatibilidade, da mais segura à mais arriscada: mesma tonalidade →
  tons vizinhos (+1/-1) → relativa maior/menor (mesma posição, letra diferente) →
  +7 semitons mesma letra ("energy boost"). Fora dessas relações, tende a soar
  dissonante em crossfade.
- Ambiguidade de key em faixas percussivas/atonais ou com pitch-shift no master é
  uma propriedade real da música, não necessariamente erro de detecção.

**Phrasing (estrutura em compassos)**
- Faixas se organizam em blocos de 8/16/32 compassos (intro, build, breakdown,
  drop/hook, outro); transições limpas entram/saem nesses limites de frase.
- Phrasing dá contexto musical ao BPM/key: alinhamento técnico perfeito ainda soa
  errado se a transição cair no meio de uma frase.
- Compasso irregular (fora de 4/4 estrito, barras extras/faltando) é uma
  propriedade real de certas faixas, não uma falha de padrão — exige atenção
  redobrada, não é bug de detecção.

**Energia**
- A camada mais subjetiva, ainda assim analisável (ex.: escala 1-5 ou
  baixa/média/alta), influenciada por densidade percussiva, elementos de
  sustentação (pads/drones) e contraste dinâmico entre seções.
- Dá forma à curva narrativa do set inteiro (aquecer → sustentar → picos → respiros
  → fechamento) — BPM/key/phrasing são as ferramentas técnicas para executar essa
  curva sem atrito.
- Compatibilidade de energia entre faixas vizinhas importa tanto quanto
  compatibilidade harmônica: uma transição harmonicamente perfeita ainda soa
  errada se saltar de energia baixa para muito alta sem transição.

**Como se combinam:** BPM viabiliza a sincronia rítmica, Key garante limpeza
harmônica na sobreposição, Phrasing define onde dentro da faixa a transição pode
acontecer, Energia garante que a transição faça sentido na história do set. Avaliar
um set bem exige não só "essas faixas tocam bem juntas tecnicamente?" mas também
"essas faixas contam a história certa, na ordem certa?"

## Diferenças de gênero (eletrônica vs. open format): não bifurcar

Não criar modos/pipelines separados por gênero. As quatro camadas acima são
universais; a diferença de gênero se manifesta como **confiança do sinal**, não
como troca de regras:
- Eletrônica (produção 4/4, tonalidade única, phrasing regular) tende a dar
  leituras de key/phrasing mais confiáveis.
- Open format (pop, hip-hop, R&B — vocais desde o início, mudança de tom no meio da
  faixa, phrasing irregular) tende a gerar leituras mais ruidosas para as mesmas
  propriedades — a faixa em si é menos regular, não é falha de análise.
- Prefira sinalizar baixa confiança quando a estrutura for irregular (ex.: nota
  "estrutura de compassos irregular detectada") a criar dois caminhos de análise.
  Isso também é consistente com a filosofia do CrateScan de pipeline único, sem
  abstrações antecipadas (ver `CLAUDE.md` do repositório).

## Preparação técnica e curadoria (contexto de referência, não checklist do CrateScan)

Práticas de um DJ que domina isso na prática (rekordbox): BPM/Key corrigidos e
validados manualmente, beatgrid confiável, hot/memory cues bem posicionados,
organização em crates por energia/BPM/tonalidade/ocasião, tags e cores
consistentes, controle de qualidade da fonte de áudio (já coberto pelo CrateScan
via `spectrumAnalyzer.js`/`analysisPipeline.js`). Para o set em si: coerência de
gênero sem repetição, faixas-ponte entre blocos de BPM/Key diferentes, curva de
energia planejada, plano B por bloco, equilíbrio entre faixas conhecidas e
descobertas, e qualidade técnica como critério de corte — não só gosto musical.

## Relação com o pipeline atual do CrateScan

- **Já existe no pipeline** (`spectrumAnalyzer.js` + notas de
  `analysisPipeline.js`): corte espectral, mismatch de bitrate, sample rate —
  qualidade técnica da fonte.
- **Fora do pipeline hoje, mas em escopo para exploração futura**: BPM, key,
  phrasing, energia — propriedades musicais da faixa. Nenhuma implementação foi
  iniciada; este documento é conhecimento de domínio para embasar esse trabalho
  quando ele começar.
