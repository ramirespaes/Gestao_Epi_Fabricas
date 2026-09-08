(function (global) {
  'use strict';

  const DB_KEY     = 'epi_db_v2'; // v2: inclui senha/data_nascimento/biometria — força reset de dados antigos
  const NET_DELAY  = 220; // ms — simula latência de rede real

  // ── Schema inicial (seed) ──────────────────────────────────────────────────
  const SEED = {
    empresas: [
      { id: 1, nome: 'RAMIRES / COBRESUL', cnpj: '00.000.000/0000-00',
        cidade: 'Joinville', uf: 'SC', cep: '', endereco: '', telefone: '', email: '',
        dpo_nome: '', dpo_email: '', dpo_tel: '' }
    ],

    usuarios: [
      { id: 1, empresa_id: 1, nome: 'Luis Freitas',    email: 'luis.freitas@cobresul.com.br',    senha: 'Master@2026', perfil: 'MASTER',        ativo: true, bloqueios: [], biometria_cadastrada: false },
      { id: 2, empresa_id: 1, nome: 'Tainara Alves',   email: 'tainara.alves@cobresul.com.br',   senha: 'Admin@2026',  perfil: 'ADMINISTRADOR', ativo: true, bloqueios: [], biometria_cadastrada: false },
      { id: 3, empresa_id: 1, nome: 'Fabio Santos',    email: 'fabio.santos@cobresul.com.br',    senha: 'Super@2026',  perfil: 'SUPERVISOR',    ativo: true, bloqueios: [], biometria_cadastrada: false },
      { id: 4, empresa_id: 1, nome: 'Marcos Silva',    email: 'marcos.silva@cobresul.com.br',    senha: 'User@2026',   perfil: 'USUARIO',       ativo: true, bloqueios: [], biometria_cadastrada: false },
    ],

    funcionarios: [
      { id: 1, empresa_id: 1, matricula: 'MAT-000171', nome: 'Marcos Silva',  cpf: '12345678945', data_nascimento: '1990-03-15', setor: 'Manutenção', funcao: 'Mecânico', cracha: 'CR-001284', telefone: '', ativo: true },
      { id: 2, empresa_id: 1, matricula: 'MAT-000121', nome: 'João Pereira',  cpf: '23456789056', data_nascimento: '1988-07-22', setor: 'Produção',   funcao: 'Operador', cracha: 'CR-000988', telefone: '', ativo: true },
      { id: 3, empresa_id: 1, matricula: 'MAT-000098', nome: 'Ana Souza',     cpf: '34567890167', data_nascimento: '1995-11-30', setor: 'Produção',   funcao: 'Operadora',cracha: 'CR-000754', telefone: '', ativo: true },
      { id: 4, empresa_id: 1, matricula: 'MAT-000205', nome: 'Carlos Mendes', cpf: '45678901278', data_nascimento: '1982-01-09', setor: 'Expedição',  funcao: 'Auxiliar', cracha: 'CR-001390', telefone: '', ativo: true },
      { id: 5, empresa_id: 1, matricula: 'MAT-000033', nome: 'Pedro Alves',   cpf: '56789012389', data_nascimento: '1993-05-18', setor: 'Manutenção', funcao: 'Mecânico', cracha: 'CR-000412', telefone: '', ativo: true },
      { id: 6, empresa_id: 1, matricula: 'MAT-000260', nome: 'Fernanda Lima', cpf: '67890123490', data_nascimento: '1991-09-04', setor: 'Qualidade',  funcao: 'Analista', cracha: 'CR-001501', telefone: '', ativo: true },
      { id: 7, empresa_id: 1, matricula: 'MAT-000015', nome: 'Ricardo Souza', cpf: '78901234501', data_nascimento: '1979-12-25', setor: 'Produção',   funcao: 'Supervisor',cracha: 'CR-000189', telefone: '', ativo: true },
    ],

    materiais: [
      { id: 1, empresa_id: 1, nome: 'Botina de segurança',      tipo: 'Sapatão / Botina',   fabricante: 'Bracol',     ca_numero: '38271', ca_validade: '2026-08-15', prazo_uso_dias: 365, unidade: 'par',     estoque_minimo: 5 },
      { id: 2, empresa_id: 1, nome: 'Óculos de proteção',       tipo: 'Óculos de proteção', fabricante: 'Danny',      ca_numero: '99881', ca_validade: '2026-05-20', prazo_uso_dias: 365, unidade: 'unidade', estoque_minimo: 5 },
      { id: 3, empresa_id: 1, nome: 'Luva nitrílica',            tipo: 'Luva',               fabricante: '3M',         ca_numero: '55771', ca_validade: '2026-04-30', prazo_uso_dias: 180, unidade: 'par',     estoque_minimo: 5 },
      { id: 4, empresa_id: 1, nome: 'Protetor auricular',        tipo: 'Protetor auricular', fabricante: 'Moldex',     ca_numero: '12045', ca_validade: '2026-04-10', prazo_uso_dias: 180, unidade: 'unidade', estoque_minimo: 10 },
      { id: 5, empresa_id: 1, nome: 'Capacete Classe B',         tipo: 'Capacete',           fabricante: 'MSA',        ca_numero: '77210', ca_validade: '2027-03-01', prazo_uso_dias: 1095, unidade: 'unidade', estoque_minimo: 5 },
      { id: 6, empresa_id: 1, nome: 'Respirador PFF2',           tipo: 'Respirador',         fabricante: '3M',         ca_numero: '40219', ca_validade: '2026-04-28', prazo_uso_dias: 30,  unidade: 'unidade', estoque_minimo: 10 },
      { id: 7, empresa_id: 1, nome: 'Uniforme operacional',      tipo: 'Roupa / Uniforme',   fabricante: '',           ca_numero: '',      ca_validade: null,         prazo_uso_dias: 730, unidade: 'unidade', estoque_minimo: 5 },
    ],

    estoque_tamanhos: [
      { id: 1,  material_id: 1, tamanho: '37', quantidade: 3  },
      { id: 2,  material_id: 1, tamanho: '38', quantidade: 12 },
      { id: 3,  material_id: 1, tamanho: '39', quantidade: 15 },
      { id: 4,  material_id: 1, tamanho: '40', quantidade: 0  },
      { id: 5,  material_id: 1, tamanho: '41', quantidade: 6  },
      { id: 6,  material_id: 1, tamanho: '42', quantidade: 10 },
      { id: 7,  material_id: 1, tamanho: '43', quantidade: 2  },
      { id: 8,  material_id: 1, tamanho: '44', quantidade: 0  },
      { id: 9,  material_id: 2, tamanho: 'Único', quantidade: 25 },
      { id: 10, material_id: 3, tamanho: 'P', quantidade: 3  },
      { id: 11, material_id: 3, tamanho: 'M', quantidade: 14 },
      { id: 12, material_id: 3, tamanho: 'G', quantidade: 12 },
      { id: 13, material_id: 3, tamanho: 'GG', quantidade: 0 },
      { id: 14, material_id: 4, tamanho: 'Único', quantidade: 15 },
      { id: 15, material_id: 5, tamanho: 'Único', quantidade: 10 },
      { id: 16, material_id: 6, tamanho: 'Único', quantidade: 30 },
      { id: 17, material_id: 7, tamanho: 'G', quantidade: 8 },
    ],

    compras: [
      { id: 1, material_id: 1, tamanho: '39', quantidade: 15, ca_numero: '38271', ca_validade: '2026-08-15', fornecedor: 'Safework', responsavel_id: 1, criado_em: '2026-01-16T11:30:00' },
      { id: 2, material_id: 3, tamanho: 'M',  quantidade: 14, ca_numero: '55771', ca_validade: '2026-04-30', fornecedor: 'EPI Distribuidora', responsavel_id: 2, criado_em: '2026-03-01T09:00:00' },
    ],

    solicitacoes: [
      { id: 1, codigo: 'PED-0041', funcionario_id: 2, material_id: 5, tamanho: 'Único', quantidade: 1, motivo: 'Desgaste',  status: 'PENDENTE',  solicitado_por: 2, aprovado_por: null, justif_reprov: null, criado_em: '2026-04-19T10:00:00' },
      { id: 2, codigo: 'PED-0040', funcionario_id: 3, material_id: 3, tamanho: 'M',     quantidade: 2, motivo: 'Reposição', status: 'APROVADA',  solicitado_por: 3, aprovado_por: 3,   justif_reprov: null, criado_em: '2026-04-18T09:00:00' },
      { id: 3, codigo: 'PED-0039', funcionario_id: 1, material_id: 6, tamanho: 'Único', quantidade: 5, motivo: 'Tarefa especial', status: 'ENTREGUE', solicitado_por: 1, aprovado_por: 1, justif_reprov: null, criado_em: '2026-04-15T08:00:00' },
      { id: 4, codigo: 'PED-0038', funcionario_id: 4, material_id: 1, tamanho: '42',    quantidade: 1, motivo: 'Substituição', status: 'REPROVADA', solicitado_por: 4, aprovado_por: 3, justif_reprov: 'Substituição antecipada sem justificativa', criado_em: '2026-04-14T14:00:00' },
      { id: 5, codigo: 'PED-0037', funcionario_id: 5, material_id: 2, tamanho: 'Único', quantidade: 1, motivo: 'Admissão',  status: 'PENDENTE',  solicitado_por: 5, aprovado_por: null, justif_reprov: null, criado_em: '2026-04-13T11:00:00' },
    ],

    fichas_epi: [
      { id: 1, numero: '0171', funcionario_id: 1, responsavel_id: 1, criado_em: '2026-04-12T14:20:00' },
      { id: 2, numero: '0170', funcionario_id: 2, responsavel_id: 2, criado_em: '2026-04-11T09:05:00' },
      { id: 3, numero: '0165', funcionario_id: 1, responsavel_id: 2, criado_em: '2026-01-03T09:10:00' },
      { id: 4, numero: '0148', funcionario_id: 1, responsavel_id: 1, criado_em: '2025-08-15T16:44:00' },
      { id: 5, numero: '0132', funcionario_id: 1, responsavel_id: 1, criado_em: '2025-03-10T10:05:00' },
    ],

    entregas_epi: [
      { id: 1,  ficha_id: 1, funcionario_id: 1, material_id: 1, tamanho: '40',    quantidade: '1 par',      condicao: 'Novo', motivo: 'Admissão',  entregue_por: 1, data_entrega: '2026-04-12T14:20:00', data_vencimento: '2027-04-12', data_devolucao: null, assinatura_tipo: 'manual',  assinatura_img: null, status: 'Ativo' },
      { id: 2,  ficha_id: 1, funcionario_id: 1, material_id: 2, tamanho: 'Único', quantidade: '1 unidade',  condicao: 'Novo', motivo: 'Reposição', entregue_por: 1, data_entrega: '2026-04-12T14:21:00', data_vencimento: '2027-04-12', data_devolucao: null, assinatura_tipo: 'manual',  assinatura_img: null, status: 'Ativo' },
      { id: 3,  ficha_id: 2, funcionario_id: 2, material_id: 4, tamanho: 'Único', quantidade: '2 unidades', condicao: 'Novo', motivo: 'Reposição', entregue_por: 2, data_entrega: '2026-04-11T09:05:00', data_vencimento: '2026-10-08', data_devolucao: null, assinatura_tipo: 'manual',  assinatura_img: null, status: 'Ativo' },
      { id: 4,  ficha_id: 3, funcionario_id: 1, material_id: 4, tamanho: 'Único', quantidade: '2 unidades', condicao: 'Novo', motivo: 'Admissão',  entregue_por: 2, data_entrega: '2026-01-03T09:10:00', data_vencimento: '2026-07-02', data_devolucao: null, assinatura_tipo: 'pendente',assinatura_img: null, status: 'Ativo' },
      { id: 5,  ficha_id: 4, funcionario_id: 1, material_id: 3, tamanho: 'G',     quantidade: '3 pares',    condicao: 'Usado',motivo: 'Desgaste',  entregue_por: 1, data_entrega: '2025-08-15T16:44:00', data_vencimento: '2026-02-11', data_devolucao: null, assinatura_tipo: 'manual',  assinatura_img: null, status: 'Encerrado' },
      { id: 6,  ficha_id: 5, funcionario_id: 1, material_id: 5, tamanho: 'Único', quantidade: '1 unidade',  condicao: 'Novo', motivo: 'Admissão',  entregue_por: 1, data_entrega: '2025-03-10T10:05:00', data_vencimento: '2028-03-09', data_devolucao: null, assinatura_tipo: 'manual',  assinatura_img: null, status: 'Ativo' },
    ],

    logs_auditoria: [
      { id: 1, usuario_id: 1, acao: 'ENTREGA_REGISTRADA',   referencia: 'FIC-0171 · Marcos Silva',  descricao: '', ip: '192.168.1.10', dispositivo: 'Chrome/Win', criado_em: '2026-04-19T10:05:00' },
      { id: 2, usuario_id: 3, acao: 'SOLICITACAO_APROVADA', referencia: 'PED-0041 · João Pereira',  descricao: '', ip: '192.168.1.22', dispositivo: 'Safari/iOS', criado_em: '2026-04-19T09:10:00' },
      { id: 3, usuario_id: 1, acao: 'USUARIO_CADASTRADO',    referencia: 'USR-0025 · Fernanda Lima', descricao: '', ip: '192.168.1.10', dispositivo: 'Chrome/Win', criado_em: '2026-04-19T08:41:00' },
    ],

    regras_eligibilidade: [
      { id: 1, funcao: 'Mecânico', setor: 'Manutenção', epi_tipo: 'Sapatão / Botina',   descricao: 'Obrigatório por risco de esmagamento' },
      { id: 2, funcao: 'Mecânico', setor: 'Manutenção', epi_tipo: 'Luva',               descricao: 'Proteção contra cortes e abrasões' },
      { id: 3, funcao: 'Operador', setor: 'Produção',   epi_tipo: 'Protetor auricular', descricao: 'Ruído acima de 85 dB(A)' },
      { id: 4, funcao: 'Operador', setor: 'Produção',   epi_tipo: 'Óculos de proteção', descricao: 'Partículas e respingos' },
    ],

    solicitacoes_titular: [],

    email_templates: [
      { id: 1, nome: 'Alerta de CA Vencido',     assunto: '⚠️ CA Vencido — {EPI}',         corpo: 'O CA do EPI {EPI} está vencido desde {DATA}.', tipo: 'alerta',    ativo: true },
      { id: 2, nome: 'Confirmação de Entrega',    assunto: '✅ EPI entregue — {FUNCIONARIO}', corpo: 'Confirmamos a entrega do EPI {EPI} em {DATA}.', tipo: 'entrega',  ativo: true },
    ],

    email_historico: [],

    _meta: { next_id: { } }
  };

  // ── Inicialização do "banco" ────────────────────────────────────────────────
  function loadDB() {
    try {
      const raw = localStorage.getItem(DB_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        // Validação de integridade: garante que o schema salvo é compatível com o atual
        // (evita telas em branco por dados antigos de versões anteriores do sistema)
        const usuariosOk = Array.isArray(parsed.usuarios) &&
          parsed.usuarios.length > 0 &&
          'senha' in parsed.usuarios[0];
        const funcionariosOk = Array.isArray(parsed.funcionarios) &&
          parsed.funcionarios.length > 0 &&
          'data_nascimento' in parsed.funcionarios[0];
        if (usuariosOk && funcionariosOk) return parsed;
        console.warn('[DB] Dados salvos são de uma versão antiga do schema — recriando com o seed atual.');
      }
    } catch (e) { console.warn('[DB] erro ao ler localStorage, recriando seed', e); }
    saveDB(SEED);
    return JSON.parse(JSON.stringify(SEED));
  }

  function saveDB(db) {
    localStorage.setItem(DB_KEY, JSON.stringify(db));
  }

  let DB = loadDB();

  function nextId(table) {
    const rows = DB[table] || [];
    return rows.length ? Math.max(...rows.map(r => r.id)) + 1 : 1;
  }

  function persist() { saveDB(DB); }

  // ── Simulação de request/response real ──────────────────────────────────────
  function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

  function makeResponse(status, data, message) {
    return { status, ok: status >= 200 && status < 300, data: data ?? null, message: message || null, timestamp: new Date().toISOString() };
  }

  /**
   * apiRequest — simula fetch() real
   * @param {string} method  GET | POST | PUT | DELETE
   * @param {string} endpoint  ex: '/funcionarios', '/entregas/5'
   * @param {object} body  payload (para POST/PUT)
   */
  async function apiRequest(method, endpoint, body) {
    await delay(NET_DELAY);
    console.log(`%c[API] ${method} ${endpoint}`, 'color:#007AFF;font-weight:600', body || '');

    const parts   = endpoint.replace(/^\//, '').split('/');
    const table   = parts[0];
    const id      = parts[1] ? parseInt(parts[1], 10) : null;
    const sub     = parts[2]; // ex: /solicitacoes/3/aprovar

    try {
      if (!DB[table] && table !== '_query') {
        return makeResponse(404, null, `Tabela "${table}" não encontrada`);
      }

      switch (method) {
        case 'GET': {
          if (id) {
            const row = DB[table].find(r => r.id === id);
            return row ? makeResponse(200, row) : makeResponse(404, null, 'Registro não encontrado');
          }
          return makeResponse(200, DB[table]);
        }

        case 'POST': {
          if (sub) return handleAction(table, id, sub, body);
          const row = { id: nextId(table), ...body, criado_em: new Date().toISOString() };
          DB[table].push(row);
          persist();
          logAction('CREATE', table, row.id);
          return makeResponse(201, row, 'Criado com sucesso');
        }

        case 'PUT': {
          const idx = DB[table].findIndex(r => r.id === id);
          if (idx < 0) return makeResponse(404, null, 'Registro não encontrado');
          DB[table][idx] = { ...DB[table][idx], ...body };
          persist();
          logAction('UPDATE', table, id);
          return makeResponse(200, DB[table][idx], 'Atualizado com sucesso');
        }

        case 'DELETE': {
          const idx = DB[table].findIndex(r => r.id === id);
          if (idx < 0) return makeResponse(404, null, 'Registro não encontrado');
          DB[table].splice(idx, 1);
          persist();
          logAction('DELETE', table, id);
          return makeResponse(200, null, 'Removido com sucesso');
        }

        default:
          return makeResponse(405, null, 'Método não permitido');
      }
    } catch (err) {
      console.error('[API] erro interno', err);
      return makeResponse(500, null, err.message);
    }
  }

  function logAction(op, table, id) {
    if (table === 'logs_auditoria') return; // evita loop
    DB.logs_auditoria.push({
      id: nextId('logs_auditoria'),
      usuario_id: (global.CURRENT_USER && global.CURRENT_USER.id) || null,
      acao: op + '_' + table.toUpperCase(),
      referencia: `${table}#${id}`,
      descricao: '',
      ip: '127.0.0.1', dispositivo: navigator.userAgent.slice(0, 60),
      criado_em: new Date().toISOString(),
    });
  }

  // ── Ações de negócio específicas (não são CRUD puro) ─────────────────────────
  async function handleAction(table, id, action, body) {
    if (table === 'solicitacoes' && action === 'aprovar') {
      const s = DB.solicitacoes.find(r => r.id === id);
      if (!s) return makeResponse(404, null, 'Solicitação não encontrada');
      s.status = 'APROVADA'; s.aprovado_por = body.aprovado_por;
      persist(); logAction('APROVAR', table, id);
      return makeResponse(200, s, 'Solicitação aprovada');
    }
    if (table === 'solicitacoes' && action === 'reprovar') {
      const s = DB.solicitacoes.find(r => r.id === id);
      if (!s) return makeResponse(404, null, 'Solicitação não encontrada');
      s.status = 'REPROVADA'; s.aprovado_por = body.aprovado_por; s.justif_reprov = body.justificativa;
      persist(); logAction('REPROVAR', table, id);
      return makeResponse(200, s, 'Solicitação reprovada');
    }
    if (table === 'materiais' && action === 'entrada-estoque') {
      const mat = DB.materiais.find(r => r.id === id);
      if (!mat) return makeResponse(404, null, 'Material não encontrado');
      const { tamanho, quantidade } = body;
      let et = DB.estoque_tamanhos.find(r => r.material_id === id && r.tamanho === tamanho);
      if (et) et.quantidade += quantidade;
      else { et = { id: nextId('estoque_tamanhos'), material_id: id, tamanho, quantidade }; DB.estoque_tamanhos.push(et); }
      DB.compras.push({ id: nextId('compras'), material_id: id, tamanho, quantidade, ...body, criado_em: new Date().toISOString() });
      persist(); logAction('ENTRADA_ESTOQUE', table, id);
      return makeResponse(200, et, 'Estoque atualizado');
    }
    if (table === 'entregas_epi' && action === 'assinar') {
      const e = DB.entregas_epi.find(r => r.id === id);
      if (!e) return makeResponse(404, null, 'Entrega não encontrada');
      e.assinatura_tipo = body.tipo; e.assinatura_img = body.imagem || null;
      persist(); logAction('ASSINAR', table, id);
      return makeResponse(200, e, 'Assinatura coletada');
    }
    return makeResponse(404, null, `Ação "${action}" não implementada`);
  }

  // ── Queries compostas (joins) — equivalente a uma view SQL ───────────────────
  const Query = {
    /** Funcionário + suas fichas + entregas (histórico completo) */
    async funcionarioCompleto(funcionarioId) {
      await delay(NET_DELAY);
      const func = DB.funcionarios.find(f => f.id === funcionarioId);
      if (!func) return makeResponse(404, null, 'Funcionário não encontrado');
      const fichas = DB.fichas_epi.filter(f => f.funcionario_id === funcionarioId).map(f => ({
        ...f,
        entregas: DB.entregas_epi.filter(e => e.ficha_id === f.id).map(e => ({
          ...e, material: DB.materiais.find(m => m.id === e.material_id)
        }))
      }));
      return makeResponse(200, { ...func, fichas });
    },

    /** Materiais com estoque por tamanho + status de CA calculado */
    async materiaisComEstoque() {
      await delay(NET_DELAY);
      const data = DB.materiais.map(m => ({
        ...m,
        tamanhos: DB.estoque_tamanhos.filter(t => t.material_id === m.id),
      }));
      return makeResponse(200, data);
    },

    /** Solicitações com dados de funcionário e material já populados */
    async solicitacoesDetalhadas(filtroStatus) {
      await delay(NET_DELAY);
      let rows = DB.solicitacoes.map(s => ({
        ...s,
        funcionario: DB.funcionarios.find(f => f.id === s.funcionario_id),
        material:    DB.materiais.find(m => m.id === s.material_id),
        solicitante: DB.usuarios.find(u => u.id === s.solicitado_por),
        aprovador:   DB.usuarios.find(u => u.id === s.aprovado_por),
      }));
      if (filtroStatus) rows = rows.filter(r => r.status === filtroStatus);
      return makeResponse(200, rows);
    },

    /** Entregas com funcionário e material populados (para EPIs Entregues / Dashboard) */
    async entregasDetalhadas() {
      await delay(NET_DELAY);
      const rows = DB.entregas_epi.map(e => ({
        ...e,
        funcionario: DB.funcionarios.find(f => f.id === e.funcionario_id),
        material:    DB.materiais.find(m => m.id === e.material_id),
        ficha:       DB.fichas_epi.find(f => f.id === e.ficha_id),
        responsavel: DB.usuarios.find(u => u.id === e.entregue_por),
      }));
      return makeResponse(200, rows);
    },

    /** KPIs para o Dashboard — equivalente a várias queries agregadas */
    async dashboardKpis() {
      await delay(NET_DELAY);
      const hoje = new Date();
      const em30 = new Date(hoje.getTime() + 30 * 86400000);
      const totalEntregas  = DB.entregas_epi.length;
      const vencendo       = DB.entregas_epi.filter(e => {
        if (e.status !== 'Ativo' || !e.data_vencimento) return false;
        const dt = new Date(e.data_vencimento);
        return dt >= hoje && dt <= em30;
      }).length;
      const solPendentes  = DB.solicitacoes.filter(s => s.status === 'PENDENTE').length;
      const funcAtivos    = DB.funcionarios.filter(f => f.ativo).length;
      const semAssinatura = DB.entregas_epi.filter(e => e.assinatura_tipo === 'pendente').length;
      const caVencidos    = DB.materiais.filter(m => m.ca_validade && new Date(m.ca_validade) < hoje).length;
      return makeResponse(200, { totalEntregas, vencendo, solPendentes, funcAtivos, semAssinatura, caVencidos });
    },

    /** Ficha de EPI completa para a tela Ficha de EPI */
    async fichaCompleta(fichaId) {
      await delay(NET_DELAY);
      const ficha = DB.fichas_epi.find(f => f.id === fichaId);
      if (!ficha) return makeResponse(404, null, 'Ficha não encontrada');
      const entregas = DB.entregas_epi.filter(e => e.ficha_id === fichaId).map(e => ({
        ...e, material: DB.materiais.find(m => m.id === e.material_id)
      }));
      const funcionario = DB.funcionarios.find(f => f.id === ficha.funcionario_id);
      return makeResponse(200, { ...ficha, funcionario, entregas });
    },

    /** Busca de fichas (tela Ficha de EPI > busca colapsável) */
    async buscarFichas({ q, epi, status, data, numero } = {}) {
      await delay(NET_DELAY);
      let rows = DB.entregas_epi.map(e => ({
        ...e,
        funcionario: DB.funcionarios.find(f => f.id === e.funcionario_id),
        material:    DB.materiais.find(m => m.id === e.material_id),
        ficha:       DB.fichas_epi.find(f => f.id === e.ficha_id),
      }));
      if (q) {
        const ql = q.toLowerCase();
        rows = rows.filter(r =>
          r.funcionario?.nome.toLowerCase().includes(ql) ||
          r.funcionario?.cpf.includes(q) ||
          r.funcionario?.matricula.toLowerCase().includes(ql)
        );
      }
      if (epi)    rows = rows.filter(r => r.material?.nome.toLowerCase().includes(epi.toLowerCase()));
      if (status) rows = rows.filter(r => r.assinatura_tipo === status);
      if (numero) rows = rows.filter(r => r.ficha?.numero.includes(numero));
      return makeResponse(200, rows);
    },

    /** Log de auditoria com nome do usuário populado */
    async logsDetalhados() {
      await delay(NET_DELAY);
      const rows = DB.logs_auditoria.map(l => ({
        ...l, usuario: DB.usuarios.find(u => u.id === l.usuario_id)
      })).sort((a,b) => new Date(b.criado_em) - new Date(a.criado_em));
      return makeResponse(200, rows);
    },
  };

  // ── Expor API global (acessível em todas as 21 páginas) ───────────────────────
  global.EpiAPI = {
    request: apiRequest,   // EpiAPI.request('GET', '/funcionarios')
    query:   Query,        // EpiAPI.query.dashboardKpis()
    _db:     () => DB,     // debug: ver o banco inteiro
    _reset:  () => { DB = JSON.parse(JSON.stringify(SEED)); persist(); console.log('[DB] resetado para o seed'); },
  };

  console.log('%c[EpiAPI] Camada de banco de dados + API carregada ✅', 'color:#34C759;font-weight:700');
})(window);