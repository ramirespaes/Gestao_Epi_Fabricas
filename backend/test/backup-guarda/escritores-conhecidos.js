'use strict';

/**
 * LINHA DE BASE da guarda estática (D-ORF-6, P2, S10) — classificações PROPOSTAS, ocorrência por ocorrência, a partir do
 * inventário da árvore real de 02/11/2026 (1437 arquivos; 160 ocorrências). Os mapas `ocorrencias` (sinal → quantidade, por
 * arquivo e por categoria) foram gerados automaticamente por `mapasDeSinais` do núcleo (correção focal de 02/11/2026), nunca
 * contados à mão: a guarda compara cada mapa exatamente, nos dois sentidos.
 *
 * APROVAÇÃO HUMANA (gate P2, 2026-11-02): cada entrada aprovada traz `revisaoHumana: 'APROVADA'`, `aprovadoEm` e a `aprovacaoRef` do seu
 * grupo (A: ordinárias; B: E-05 com ressalva expressa; C: D-12 reclassificada pelo ensaio Linux), todas declaradas em `APROVACOES` com o
 * documento de decisão assinado e seu SHA-256, conferido pela guarda. Entrada não aprovada permanece `PENDENTE` e mantém o gate vermelho.
 */

const PENDENTE = Object.freeze({ revisaoHumana: 'PENDENTE', aprovadoEm: null, aprovacaoRef: null });
const DATA_DA_DECISAO = '2026-11-02';
const APROVADA_A = Object.freeze({ revisaoHumana: 'APROVADA', aprovadoEm: DATA_DA_DECISAO, aprovacaoRef: `GATE-P2-${DATA_DA_DECISAO}-A` });
const APROVADA_B = Object.freeze({ revisaoHumana: 'APROVADA', aprovadoEm: DATA_DA_DECISAO, aprovacaoRef: `GATE-P2-${DATA_DA_DECISAO}-B` });
const APROVADA_C = Object.freeze({ revisaoHumana: 'APROVADA', aprovadoEm: DATA_DA_DECISAO, aprovacaoRef: `GATE-P2-${DATA_DA_DECISAO}-C` });
const DATA_DA_DECISAO_45 = '2026-11-03';
const APROVADA_D = Object.freeze({ revisaoHumana: 'APROVADA', aprovadoEm: DATA_DA_DECISAO_45, aprovacaoRef: `GATE-P2-${DATA_DA_DECISAO_45}-D` });
const DATA_DA_DECISAO_46 = '2026-11-03';
const APROVADA_E = Object.freeze({ revisaoHumana: 'APROVADA', aprovadoEm: DATA_DA_DECISAO_46, aprovacaoRef: `GATE-P2-${DATA_DA_DECISAO_46}-E` });
const DATA_DA_DECISAO_47 = '2026-11-03';
const APROVADA_F = Object.freeze({ revisaoHumana: 'APROVADA', aprovadoEm: DATA_DA_DECISAO_47, aprovacaoRef: `GATE-P2-${DATA_DA_DECISAO_47}-F` });
const DATA_DA_DECISAO_48 = '2026-11-05';
const APROVADA_G = Object.freeze({ revisaoHumana: 'APROVADA', aprovadoEm: DATA_DA_DECISAO_48, aprovacaoRef: `GATE-P2-${DATA_DA_DECISAO_48}-G` });
const REF_DO_ADENDO_47 = `GATE-P2-${DATA_DA_DECISAO_48}-F1`;
// DEP-2 (H5/H4, 07/11/2026): três dependências de armazenamento do AWS SDK, classificadas como revisadas por decisão de Ramires.
const DATA_DA_DECISAO_49 = '2026-11-07';
const APROVADA_H = Object.freeze({ revisaoHumana: 'APROVADA', aprovadoEm: DATA_DA_DECISAO_49, aprovacaoRef: `GATE-P2-${DATA_DA_DECISAO_49}-H` });
const SAIDA = 'SAIDA_DO_BACKUP';

const ESCRITORES_CONHECIDOS = {
  'scripts/verificar-checksums.js': {
    classificacao: 'BUILD', ocorrencias: { escrita: { writefilesync: 1 }, remocao: {} }, ...APROVADA_A,
    justificativa: 'writeFileSync (linha 81) grava migrations/checksums.json SOMENTE no modo --atualizar: artefato versionado do repositório, não dado de execução. Risco se errado: um manifesto de migrations gravado em tempo de execução ficaria fora do backup; a CI o verifica por db:migrate:verificar.',
  },
  'src/email/transporte/arquivo.js': {
    classificacao: 'FONTE', fonteId: 'email-arquivo', ocorrencias: { escrita: { mkdir: 1, writefile: 1 }, remocao: {} }, ...APROVADA_A,
    justificativa: 'writeFile com flag wx e modo 0600 (linha 27) e mkdir 0700 (linha 34) em EMAIL_ARQUIVO_DIRETORIO: transporte de desenvolvimento, recusado em produção; nada no módulo remove os arquivos (persistência física real). Fonte registrada como PENDENTE_DECISAO (D-F2). Risco se errado: e-mails com dado pessoal e tokens ficariam fora de qualquer política declarada.',
  },
  'src/services/imagem-armazenamento-limpeza.service.js': {
    classificacao: 'FONTE', fonteId: 'imagens', ocorrencias: { escrita: {}, remocao: { rmdir: 1, unlink: 1 } }, ...APROVADA_A,
    justificativa: 'Únicos pontos de unlink (linha 286) e rmdir (linha 291) de órfãos de imagem, sob posse da janela LIMPEZA (CONS-02), caminho remontado de componentes validados. Risco se errado: remoção física de imagem fora da janela quebraria a consistência plano × cópia.',
  },
  'src/services/imagem-backup-diario-execucao.service.js': {
    classificacao: SAIDA, ocorrencias: { escrita: { mkdirsync: 3, o_append: 2, o_creat: 4, o_wronly: 4 }, remocao: { unlinksync: 2 } }, ...APROVADA_A,
    justificativa: 'Diário NDJSON de execução do backup (registro durável, travas de tentativa e reconciliação): criação exclusiva O_EXCL 0600 e unlink só do que o próprio escritor criou. É saída do backup, não fonte da aplicação; a política de retenção do diário é decisão operacional separada (D3/P10). Risco se errado: o diário conteria dado de negócio a proteger (não contém: formato fechado, sem caminhos, senhas ou tokens).',
  },
  'src/services/imagem-backup-orfaos.service.js': {
    classificacao: SAIDA, ocorrencias: { escrita: { mkdirsync: 2, writefilesync: 1 }, remocao: { rmdirsync: 3, unlinksync: 2 } }, ...APROVADA_B,
    justificativa: 'Identificação e remoção controlada de órfãos dos ARTEFATOS do backup (preparações, temporários): modo OPERACIONAL desativado por constante; remoção só em SIMULACAO/FIXTURE_DESCARTAVEL. Risco se errado: uma remoção real de dado de imagem por este módulo passaria sem registro de fonte; o módulo só opera sobre raízes autorizadas do backup.',
  },
  'src/services/imagem-backup-origem-preparacao-exclusiva.service.js': {
    classificacao: SAIDA, ocorrencias: { escrita: { mkdir: 1 }, remocao: {} }, ...APROVADA_A,
    justificativa: 'mkdir NÃO recursivo (linha 103) como ato de aquisição exclusiva da área de preparação do backup, depois de validar a separação física entre origem e preparação. Risco se errado: a preparação poderia ser criada dentro da origem de imagens (a validação de separação impede).',
  },
  'src/services/imagem-backup-portas-sistema.service.js': {
    classificacao: SAIDA, ocorrencias: { escrita: { o_creat: 1, o_wronly: 1 }, remocao: {} }, ...APROVADA_A,
    justificativa: 'Criador exclusivo do arquivo do dump (openSync O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW, 0600; linha 80) na área do backup; nunca reaproveita nem trunca. Risco se errado: criação de arquivo fora da área do backup (o spec exige diretório canônico e nome do padrão).',
  },
  'src/services/imagem-backup-publicacao.service.js': {
    classificacao: SAIDA, ocorrencias: { escrita: { mkdir: 3, o_creat: 1, o_wronly: 1, rename: 3 }, remocao: { rmdir: 3 } }, ...APROVADA_A,
    justificativa: 'Montagem do pacote (mkdir, incorporação do dump por criação exclusiva) e publicação atômica (rename, rmdir de temporários) no destino injetado do backup. Risco se errado: publicação sobre dado de origem (o destino é raiz injetada do backup, separada da origem).',
  },
  'src/services/imagem-backup-registro-publicacao.service.js': {
    classificacao: SAIDA, ocorrencias: { escrita: { mkdir: 2, o_creat: 1, o_wronly: 1, writefile: 1 }, remocao: {} }, ...APROVADA_A,
    justificativa: 'Registros duráveis de intenção/conclusão/quarentena da publicação: criação exclusiva O_EXCL|O_NOFOLLOW 0600, diretório 0700, sem sobrescrita, fora do pacote e da raiz de imagens. São evidência operacional do próprio backup; sua retenção é decisão separada (D3/P10). Risco se errado: registros gravados dentro de uma fonte protegida (o módulo os mantém fora).',
  },
  'src/services/imagem-backup-restauracao.service.js': {
    classificacao: SAIDA, ocorrencias: { escrita: { mkdir: 1 }, remocao: {} }, ...APROVADA_A,
    justificativa: 'mkdir 0700 (linha 250) do DESTINO NOVO de restauração; destino existente é recusado (DESTINO_EXISTENTE) e nada é sobrescrito; a gravação das imagens passa pelo armazenamento oficial. Risco se errado: restauração sobre a origem (a política de destino novo impede).',
  },
  'src/services/imagem-backup-selagem.service.js': {
    classificacao: SAIDA, ocorrencias: { escrita: { link: 1, o_creat: 1, o_wronly: 1, writefile: 1 }, remocao: { unlink: 1 } }, ...APROVADA_A,
    justificativa: 'Selagem de manifesto.json e manifesto.sha256 na área de preparação: temporário O_CREAT|O_EXCL|O_NOFOLLOW 0600 -> link (nunca sobrescreve) -> unlink só do temporário cujo dev/ino foi registrado. Risco se errado: remoção de arquivo alheio (a prova de propriedade por inode impede).',
  },
  'src/services/backup-fontes-fiscalizacao-arquivos.service.js': {
    classificacao: SAIDA, ocorrencias: { escrita: { link: 1, mkdir: 2, o_creat: 2, o_wronly: 2, writefile: 1 }, remocao: { rm: 1 } }, ...APROVADA_D,
    justificativa: 'P3 (D-F1, 03/11/2026): cópia verificada dos ZIPs da Fiscalização para a área de preparação do backup e restauração em destino NOVO: pasta da empresa por mkdir não recursivo 0700, temporário exclusivo O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW 0600 (writeFile em blocos com SHA-256 e tamanho recalculados), publicação por link (nunca sobrescreve) e rm SÓ do próprio temporário (force, sem recursive). Nunca escreve na origem (FISCALIZACAO_ARMAZENAMENTO_DIRETORIO) nem apaga arquivo publicado. Risco se errado: gravação fora da preparação ou do destino novo (o destino é diretório existente/novo validado por lstat+realpath, e a pasta da empresa vem só do formato da chave). Aprovada no gate de 2026-11-03 (ref D); as 44 anteriores não mudam.',
  },
  'src/services/backup-fontes-composicao-l2.service.js': {
    classificacao: SAIDA, ocorrencias: { escrita: { mkdir: 1 }, remocao: {} }, ...APROVADA_E,
    justificativa: 'P6 (03/11/2026): composição por fonte do pacote layout 2 e restauração por fonte. Única escrita própria: mkdir NÃO recursivo 0700 (linha 70) de um segmento novo (`arquivos`, `arquivos/<fonteId>`, destino novo da restauração) sob um pai conferido como diretório real por lstat+realpath; existente = recusa (DESTINO_EXISTENTE), nada reaproveitado, nada removido. As gravações de conteúdo passam pelos escritores já aprovados (armazenamento-imagens.gravar, backup-fontes-fiscalizacao-arquivos, selagem histórica). Leituras com O_RDONLY|O_NOFOLLOW; links recusados. Risco se errado: pasta criada fora da preparação/destino (o pai é validado como real e o nome é um único segmento seguro vindo do catálogo ou de constante). Entrada nova; não altera as 45 anteriores.',
  },
  'src/services/backup-fontes-cifra-envelope.service.js': {
    classificacao: SAIDA, ocorrencias: { escrita: { link: 1, mkdir: 1, o_creat: 2, o_wronly: 2, writefile: 1 }, remocao: { rm: 1 } }, ...APROVADA_F,
    justificativa: 'P11 (03/11/2026): cifra em envelope (AES-256-GCM por arquivo, DEK envolvida pela KEK, envelope HMAC-SHA256 encrypt-then-MAC) de um pacote layout 2 JÁ VERIFICADO por verificarPacoteL2, e a decifra para pacote NOVO. Escritas próprias: mkdir NÃO recursivo 0700 (linha 108) de um segmento novo sob pai conferido por lstat+realpath (contêiner novo, `dados/`, subpastas dos caminhos relativos do manifesto); temporário exclusivo O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW 0600 (linha 124) com writeFile em blocos (130), fsync e publicação por link (133) que nunca sobrescreve; rm SÓ do próprio temporário, com force e sem recursive (linha 137), inclusive em falha. Destino existente = recusa (DESTINO_EXISTENTE); nada é lido em claro de fora do pacote; leituras com O_RDONLY|O_NOFOLLOW. Chaves só de fonte TESTE_CONTROLADO (PROVEDORES_DE_CIFRA_APROVADOS vazia, D-F5). Risco se errado: gravação fora do contêiner/destino (o pai é validado como diretório real e cada segmento vem do caminho canônico do manifesto, sem `.`/`..`), ou publicação de arquivo cuja tag GCM não conferiu (decipher.final lança antes do link; o temporário é removido). Aprovada no gate de 2026-11-03 (ref F); as 46 anteriores não mudam.',
  },
  'src/services/backup-baixador-duravel.service.js': {
    classificacao: SAIDA, ocorrencias: { escrita: { link: 1, mkdir: 1, o_creat: 1, o_wronly: 1 }, remocao: { rm: 1 } }, ...APROVADA_G,
    justificativa: 'R-D45 (05/11/2026), versão 4, APROVADA (GATE-P2-2026-11-05-G; arquivo de SHA-256 111da4773726e94c9cbb7ae06187151c0c184d5814c4e37ef4d7e7fdf7f13e98): baixador de restauração por versão explícita do recibo, VINCULADO ao registro oficial DESTINOS_AUTORIZADOS (validador criarValidadorDeDestinos; lista real vazia): só cria um filho NOVO e direto de uma raiz autorizada, revalida a contenção a cada etapa (identidade dev/ino, dono, modo, sem link) e confere espaço, inodes e limites antes de gravar. Escritas próprias, todas nesse diretório NOVO: mkdir NÃO recursivo 0700 (linha 70) de um segmento novo, cuja identidade é registrada e reconferida (destino e subpastas vindas de caminhos do recibo, só segmentos simples); temporário exclusivo O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW 0600 (linha 197) escrito em blocos por FileHandle.write (que não é sinal da guarda), fsync (215) e publicação por link (220) ao nome final, que nunca sobrescreve; rm SÓ do próprio temporário, com force e sem recursive (linha 78), só se este módulo o criou (open com O_EXCL bem-sucedido), também em falha. Cada objeto é conferido (bytes e SHA-256 do recibo) ANTES do link; destino existente = recusa; nada é removido além do temporário próprio. A origem é sempre a versão explícita do recibo, lida pela porta de restauração (somente identidade e leitura por versão). Risco se errado: gravação fora de destino autorizado (a raiz vem do registro oficial e é revalidada antes de criar, de abrir cada temporário e de publicar; as pastas criadas têm identidade conferida; os segmentos vêm de chave validada, sem ponto, ponto-ponto ou vazio; depois do link o arquivo tem de ser o mesmo i-node do temporário) ou publicação de objeto diferente do recibo (a conferência precede o link). Residual: janela mínima entre conferência e uso, sem openat no Node, explorável só por quem já escreve na raiz 0700 do mesmo usuário. Aprovada no gate de 2026-11-05 (ref G), condicionada à correspondência integral com este mapa e com o SHA-256 acima: qualquer alteração do arquivo exige nova decisão; B1, B2 e B3 são condição do futuro ponto de entrada operacional. As 47 anteriores não mudam.',
  },
  'src/services/imagem-processador-area.service.js': {
    classificacao: 'NAO_PERSISTENTE', ocorrencias: { escrita: { mkdirsync: 1 }, remocao: { rmsync: 1 } }, ...APROVADA_A,
    justificativa: 'Área temporária EXCLUSIVA por execução do processador de imagens (D-12, 02/11/2026): mkdirSync não recursivo 0700 com nome aleatório sob os.tmpdir() (linha 29) e rmSync recursivo SÓ do diretório criado, depois de conferir tipo, dev, ino e dono e sem seguir links (linha 73); sobras são inventariadas antes. Persistência física breve (só durante a vida do filho) com valor de recuperação nulo: transitório, não FONTE (não é dado de negócio), não SAIDA_DO_BACKUP (não é artefato do backup) e não JANELA (não coordena escrita). Risco se errado: remoção fora da área (a prova de identidade por dev/ino e a recusa de link impedem) ou temporário do libvips fora de controle (a área é o TMPDIR e a pasta atual do filho). Entrada nova, pendente de revisão humana; não altera as 43 anteriores.',
  },
  'src/storage/armazenamento-imagens.js': {
    classificacao: 'FONTE', fonteId: 'imagens', ocorrencias: { escrita: { link: 1, mkdir: 1, mkdirsync: 1, o_creat: 1, o_wronly: 1, writefile: 1 }, remocao: { rm: 1, rmdir: 1, unlink: 2 } }, ...APROVADA_A,
    justificativa: 'Armazenamento oficial da Biblioteca de Imagens: mkdir 0700, temporário exclusivo 0600, writeFile, publicação por link (nunca sobrescreve), rm do temporário, e remoção física (unlink/rmdir) SOMENTE sob posse confirmada da janela LIMPEZA. Risco se errado: qualquer escrita aqui é dado de negócio protegido; classificação diferente de FONTE esconderia a fonte 0. A fonte continua IMPLEMENTADA_NAO_COMPROVADA (P0-CF-3).',
  },
  'src/storage/armazenamento-local.js': {
    classificacao: 'FONTE', fonteId: 'fiscalizacao-pacotes', ocorrencias: { escrita: { createwritestream: 1, link: 1, mkdir: 1, mkdirsync: 1 }, remocao: { rm: 4 } }, ...APROVADA_A,
    justificativa: 'Armazenamento dos ZIPs da Fiscalização (12K-D6): mkdir 0700, createWriteStream do temporário, publicação por link (EEXIST recusado), rm do temporário/abortado e removerResiduos (temporário e ZIP da mesma chave) SEM janela. Fonte PENDENTE_DECISAO (D-F1). Risco se errado: ZIPs entregues a fiscais ficariam fora do backup sem decisão registrada; ver ACH-FISC-01 (hipótese de remoção de ZIP CONCLUIDO no catch externo da geração, não reproduzida).',
  },
  'src/utils/janela-escrita-imagens.js': {
    classificacao: 'JANELA', ocorrencias: { escrita: { o_creat: 2, o_wronly: 2, writefile: 1 }, remocao: { unlink: 1 } }, ...APROVADA_A,
    justificativa: 'Arquivo único da janela de escrita (CONS-02): criação O_CREAT|O_EXCL|O_NOFOLLOW, writeFile do conteúdo e unlink só pelo dono com o token; nunca removida de dono morto. Mecanismo de coordenação, fonte EFEMERA `janela-escrita` (P0-CF-1). Risco se errado: tratar a trava como dado a restaurar bloquearia operações no destino.',
  },
};

const ROTAS_BINARIAS_CONHECIDAS = {
  'src/controllers/funcionario.controller.js': {
    classificacao: 'SAIDA_EM_FLUXO', ocorrencias: { 'attachment;': 1, 'content-disposition': 1 }, ...APROVADA_A,
    justificativa: 'Content-Disposition attachment (linha 100): exportação PDF/XLSX do histórico de funcionários gerada em memória e entregue por res.end; nada é gravado em disco. Natureza: transmissão. Risco se errado: uma exportação que passasse a persistir ficaria fora do catálogo (a guarda G2 detectaria a escrita).',
  },
  'src/controllers/relatorio.controller.js': {
    classificacao: 'SAIDA_EM_FLUXO', fonteId: 'fiscalizacao-pacotes', ocorrencias: { 'application/zip': 1, 'attachment;': 1, 'content-disposition': 1 }, ...APROVADA_A,
    justificativa: 'application/zip e Content-Disposition attachment (linhas 56-57): download do ZIP da Fiscalização lido do armazenamento (SHA-256 reconferido) por pipeline. Natureza: leitura + transmissão; não grava. Risco se errado: confundir o download com uma gravação nova.',
  },
  'src/email/marca.js': {
    classificacao: 'CONSTANTE_DE_TIPO', ocorrencias: { 'image/png': 1 }, ...APROVADA_A,
    justificativa: 'image/png (linha 18): tipo MIME do PNG de marca lido do repositório (src/email/assets, readFileSync na carga) e anexado ao e-mail por CID. Natureza: leitura de ativo versionado + transmissão; não é rota nem persistência. Risco se errado: nenhum efeito sobre o backup (ativo versionado no repositório).',
  },
  'src/middleware/conteudo.js': {
    classificacao: 'ENTRADA_BINARIA', fonteId: 'imagens', ocorrencias: { 'image/*': 1, 'image/jpeg': 1, 'image/png': 1, 'image/webp': 1 }, ...APROVADA_A,
    justificativa: 'image/* e os três tipos aceitos (linhas 89, 93): política de conteúdo do upload de imagem de material (caminho exato), que grava SOMENTE pelo armazenamento oficial de imagens. Natureza: aceitação de corpo; sem gravação neste arquivo. Risco se errado: um corpo binário aceito aqui e gravado por outro caminho escaparia do catálogo (G2 detectaria a escrita).',
  },
  'src/routes/imagem-material.routes.js': {
    classificacao: 'ENTRADA_BINARIA', fonteId: 'imagens', ocorrencias: { 'image/*': 1 }, ...APROVADA_A,
    justificativa: 'image/* (linha 63, fora de comentário): raw() da rota de upload da Biblioteca de Imagens (2 MiB, limites por usuário e empresa), ligada ao middleware de conteúdo e ao serviço de upload. Natureza: leitura de corpo; sem gravação neste arquivo. Risco se errado: idem ao middleware.',
  },
  'src/services/exportacao-historico/formatos.js': {
    classificacao: 'CONSTANTE_DE_TIPO', ocorrencias: { 'application/pdf': 1 }, ...APROVADA_A,
    justificativa: 'application/pdf (linha 8): tabela de formatos da exportação em fluxo (pdfkit/write-excel-file em memória). Natureza: constante; não persiste. Risco se errado: nenhum efeito sobre o backup.',
  },
  'src/services/imagem-material-entrega.service.js': {
    classificacao: 'SAIDA_EM_FLUXO', fonteId: 'imagens', ocorrencias: { 'image/webp': 1 }, ...APROVADA_A,
    justificativa: 'image/webp (linha 110): entrega HTTP das variantes lidas do armazenamento oficial (assinatura WebP conferida). Natureza: leitura + transmissão; não grava. Risco se errado: confundir leitura com gravação.',
  },
};

const MIGRATIONS_CONHECIDAS = {
  'migrations/049_create_fatores_mfa_plataforma.sql': {
    classificacao: 'INTERNO_AO_BANCO', ocorrencias: { bytea: 2 }, ...APROVADA_A,
    justificativa: 'Duas colunas BYTEA (linhas 25-26: totp_nonce e totp_segredo_cifrado): segredo TOTP cifrado da plataforma, armazenado DENTRO do banco e portanto dentro do dump; não referencia arquivo externo. Risco se errado: se um dia a coluna apontasse para arquivo externo, a fonte faltaria (o mapa fixo obriga revisão a cada mudança).',
  },
  'migrations/080_create_fiscalizacao_pacotes.sql': {
    classificacao: 'FONTE', fonteId: 'fiscalizacao-pacotes', ocorrencias: { chave_armazenamento: 7, sha256: 7 }, ...APROVADA_A,
    justificativa: 'sha256 e chave_armazenamento (colunas, CHECKs e gatilhos de imutabilidade): tabela de referência dos ZIPs da Fiscalização, cujos arquivos ficam FORA do banco. Fonte PENDENTE_DECISAO (D-F1). Risco se errado: a referência a arquivo externo ficaria classificada como interna e a perda dos ZIPs passaria despercebida.',
  },
  'migrations/090_create_biblioteca_imagens_material.sql': {
    classificacao: 'FONTE', fonteId: 'imagens', ocorrencias: { arquivo_origem: 2, sha256: 8 }, ...APROVADA_A,
    justificativa: 'sha256 em imagens_padrao e imagens_empresa: tabelas de referência da Biblioteca de Imagens, cujos arquivos ficam fora do banco; arquivo_origem é metadado interno (nome do arquivo no pacote padrão). Risco se errado: idem à 080.',
  },
};

const DEPENDENCIAS_REVISADAS = {
  argon2: { classificacao: 'SEM_RELACAO_COM_ARMAZENAMENTO', justificativa: 'Hash de senha em memória (Argon2id).', ...APROVADA_A },
  cookie: { classificacao: 'SEM_RELACAO_COM_ARMAZENAMENTO', justificativa: 'Serialização e leitura de cookies HTTP.', ...APROVADA_A },
  cors: { classificacao: 'SEM_RELACAO_COM_ARMAZENAMENTO', justificativa: 'Cabeçalhos CORS.', ...APROVADA_A },
  dotenv: { classificacao: 'SEM_RELACAO_COM_ARMAZENAMENTO', justificativa: 'LÊ o arquivo de ambiente (segredos, categoria A: fonte EXCLUIDA); não grava.', ...APROVADA_A },
  express: { classificacao: 'SEM_RELACAO_COM_ARMAZENAMENTO', justificativa: 'Servidor HTTP; express.static/express.raw vigiados por G7 (o raw aparece na rota de upload).', ...APROVADA_A },
  'express-rate-limit': { classificacao: 'SEM_RELACAO_COM_ARMAZENAMENTO', justificativa: 'Limitador com MemoryStore (memória do processo); um store externo seria dependência nova (G6 detecta).', ...APROVADA_A },
  helmet: { classificacao: 'SEM_RELACAO_COM_ARMAZENAMENTO', justificativa: 'Cabeçalhos de segurança HTTP.', ...APROVADA_A },
  nodemailer: { classificacao: 'SEM_RELACAO_COM_ARMAZENAMENTO', justificativa: 'Transporte SMTP (rede); o transporte em arquivo do projeto é módulo próprio (src/email/transporte/arquivo.js, fonte email-arquivo).', ...APROVADA_A },
  otpauth: { classificacao: 'SEM_RELACAO_COM_ARMAZENAMENTO', justificativa: 'TOTP em memória; o segredo cifrado é persistido no banco (migration 049).', ...APROVADA_A },
  pdfkit: { classificacao: 'PROCESSAMENTO_SEM_PERSISTENCIA', justificativa: 'Gera PDF em memória para a exportação do histórico (entregue por res.end); sem gravação em disco localizada no projeto.', ...APROVADA_A },
  pg: { classificacao: 'ARMAZENAMENTO_REVISADO', justificativa: 'Cliente do PostgreSQL: acesso à fonte postgres-aplicacao (dump completo), sem arquivo local.', ...APROVADA_A },
  sharp: {
    classificacao: 'PROCESSAMENTO_SEM_PERSISTENCIA', ...APROVADA_C,
    justificativa: 'Processamento de imagens em processo filho isolado (área temporária exclusiva por execução como TMPDIR e pasta atual; VIPS_DISC_THRESHOLD fixo em 256 MiB contra um decodificado máximo de 32 MiB); a persistência final das imagens é só pelo armazenamento oficial. Comprovação dinâmica: ensaio Linux sob strace (commit 73b2ef4f82c6fa6b25be791e76c60aeaa9a4949d, execução GitHub Actions 41521210163, 8 cenários PNG/JPEG/WebP inclusive no teto de pixels) sem nenhuma abertura em modo de escrita, criação, remoção ou renomeação pelo filho. Limites: conjunto finito de cenários, Linux x64, sem controle positivo; não é prova de ausência universal.',
  },
  'write-excel-file': { classificacao: 'PROCESSAMENTO_SEM_PERSISTENCIA', justificativa: 'escreverXlsx(abas).toBuffer() em memória para a exportação em fluxo.', ...APROVADA_A },
  yauzl: { classificacao: 'PROCESSAMENTO_SEM_PERSISTENCIA', justificativa: 'Leitura de ZIP (pacote padrão de imagens); não grava.', ...APROVADA_A },
  yazl: { classificacao: 'PROCESSAMENTO_SEM_PERSISTENCIA', justificativa: 'Geração de ZIP em fluxo para o gravador do armazenamento-local; a persistência é do armazenamento (fonte fiscalizacao-pacotes).', ...APROVADA_A },
  zod: { classificacao: 'SEM_RELACAO_COM_ARMAZENAMENTO', justificativa: 'Validação de esquemas.', ...APROVADA_A },
  'node-pg-migrate': { classificacao: 'FERRAMENTA_DE_DESENVOLVIMENTO', justificativa: 'devDependency sem uso localizado no código (pendência registrada no CLAUDE.md).', ...APROVADA_A },
  nodemon: { classificacao: 'FERRAMENTA_DE_DESENVOLVIMENTO', justificativa: 'Recarga em desenvolvimento.', ...APROVADA_A },
  supertest: { classificacao: 'FERRAMENTA_DE_DESENVOLVIMENTO', justificativa: 'Testes HTTP.', ...APROVADA_A },
  '@aws-sdk/client-kms': {
    classificacao: 'ARMAZENAMENTO_REVISADO',
    justificativa: 'Cliente do KMS (D-F5): DescribeKey e Decrypt de chaves pré-resolvidas; carregado só por backup-aws-sdk-carregador e usado só por backup-aws-portas; sem arquivo local.',
    ...APROVADA_H,
  },
  '@aws-sdk/client-s3': {
    classificacao: 'ARMAZENAMENTO_REVISADO',
    justificativa: 'Cliente do S3 do destino durável (D-F4, Object Lock e versionamento): PutObject condicional, GetObject, HeadObject, ListObjectVersions e leitura da configuração do bucket; carregado só por backup-aws-sdk-carregador e usado só por backup-aws-portas; não grava em disco (a gravação local da restauração é do baixador já classificado).',
    ...APROVADA_H,
  },
  '@aws-sdk/client-sts': {
    classificacao: 'ARMAZENAMENTO_REVISADO',
    justificativa: 'Cliente do STS: GetCallerIdentity para conferir o papel em uso; carregado só por backup-aws-sdk-carregador e usado só por backup-aws-portas; sem arquivo local.',
    ...APROVADA_H,
  },
};

const SUPERFICIE_ESPERADA = {
  imagens: { modulo: 'src/storage/armazenamento-imagens.js', exportsEsperados: ['criarArmazenamentoImagens', 'executarComRemocaoProtegida', 'chaveDe'], regexChave: 'imagem-v1', variavel: 'IMAGENS_ARMAZENAMENTO_DIRETORIO', arquivoDeConfig: 'src/config/imagens.js', versaoContrato: 1 },
  'fiscalizacao-pacotes': { modulo: 'src/storage/armazenamento-local.js', exportsEsperados: ['criarArmazenamentoLocal'], regexChave: null, variavel: 'FISCALIZACAO_ARMAZENAMENTO_DIRETORIO', arquivoDeConfig: 'src/config/fiscalizacao.js', versaoContrato: 1 },
  'email-arquivo': { modulo: 'src/email/transporte/arquivo.js', exportsEsperados: ['criarArquivo'], regexChave: null, variavel: 'EMAIL_ARQUIVO_DIRETORIO', arquivoDeConfig: 'src/config/email.js', versaoContrato: 1 },
  'janela-escrita': { modulo: 'src/utils/janela-escrita-imagens.js', exportsEsperados: ['TIPOS', 'VARIAVEL_ARQUIVO', 'ErroDeJanela', 'adquirirJanela', 'lerJanela', 'lerArquivoDaJanela', 'validarArquivoDaJanela', 'ehPosseDeJanela'], regexChave: null, variavel: 'IMAGENS_JANELA_ESCRITA_ARQUIVO', arquivoDeConfig: '.env.example', versaoContrato: 1 },
};

const { NOMES_QUE_NAO_SAO_RAIZ } = require('../../src/services/backup-fontes-catalogo.service');

/** Registros de aprovação de Ramires: um por grupo, todos apontando para o mesmo documento de decisão assinado (caminho relativo a backend/, SHA-256 calculado após a assinatura). */
const DOCUMENTO_DA_DECISAO = `test/backup-guarda/aprovacoes/GATE-P2-${DATA_DA_DECISAO}.md`;
const SHA256_DA_DECISAO = 'a1902f800ff494313a994f934e16be2f963ee5c9a8845b3510a6b9e3d63a6c88';
const APROVACOES = [
  { ref: APROVADA_A.aprovacaoRef, documento: DOCUMENTO_DA_DECISAO, sha256: SHA256_DA_DECISAO },
  { ref: APROVADA_B.aprovacaoRef, documento: DOCUMENTO_DA_DECISAO, sha256: SHA256_DA_DECISAO },
  { ref: APROVADA_C.aprovacaoRef, documento: DOCUMENTO_DA_DECISAO, sha256: SHA256_DA_DECISAO },
  { ref: APROVADA_D.aprovacaoRef, documento: `test/backup-guarda/aprovacoes/GATE-P2-${DATA_DA_DECISAO_45}-D.md`, sha256: '35a6841842801801087343afc2fc00c66b12f3eba5f64b9d1fbc889124c192a1' },
  { ref: APROVADA_E.aprovacaoRef, documento: `test/backup-guarda/aprovacoes/GATE-P2-${DATA_DA_DECISAO_46}-E.md`, sha256: '743b1cc3354fe0441df111730836856959f1666606e87081b21578be6b54e906' },
  { ref: APROVADA_F.aprovacaoRef, documento: `test/backup-guarda/aprovacoes/GATE-P2-${DATA_DA_DECISAO_47}-F.md`, sha256: '3e0f082f2e2c704da261f8bca7abf6e815202fa2e151f8b7e44d1e067586d51a' },
  { ref: REF_DO_ADENDO_47, documento: `test/backup-guarda/aprovacoes/GATE-P2-${DATA_DA_DECISAO_48}-F1.md`, sha256: 'f5543e7c8cb51250dd93990e4066ab34c008248970b96926fdee9c2a2eb861da' },
  { ref: APROVADA_G.aprovacaoRef, documento: `test/backup-guarda/aprovacoes/GATE-P2-${DATA_DA_DECISAO_48}-G.md`, sha256: 'cb6ba45137626892bc75914e00d05706add2a064c0248923059e98b72031155a' },
  { ref: APROVADA_H.aprovacaoRef, documento: `test/backup-guarda/aprovacoes/GATE-P2-${DATA_DA_DECISAO_49}-H.md`, sha256: '31c4aa92940a79d8c9e47b9e2c91949b5a55ea2d6e8f3d21d239d939122250ce' },
];

module.exports = Object.freeze({
  ESCRITORES_CONHECIDOS, ROTAS_BINARIAS_CONHECIDAS, MIGRATIONS_CONHECIDAS, DEPENDENCIAS_REVISADAS, SUPERFICIE_ESPERADA,
  NOMES_QUE_NAO_SAO_RAIZ: NOMES_QUE_NAO_SAO_RAIZ.map((e) => ({ ...e })), APROVACOES, minimoDeArquivos: 1000,
});
