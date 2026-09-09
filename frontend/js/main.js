/* ═══════════════════════════════════════════════════════════════════════════
   GESTÃO DE EPIs — CAMADA DE BANCO DE DADOS + API SIMULADA
   
   Esta camada simula um backend real:
   - "Banco de dados" = localStorage (persiste entre sessões e entre páginas)
   - "API" = funções que retornam Promises com delay, como um fetch() real
   - Toda página/arquivo separado que incluir este script terá acesso
     ao MESMO banco de dados (porque localStorage é por domínio/origem)
   
   Estrutura do banco (equivalente às tabelas SQL):
   - empresas
   - usuarios
   - funcionarios
   - materiais
   - estoque_tamanhos
   - compras
   - solicitacoes
   - fichas_epi
   - entregas_epi
   - logs_auditoria
   - regras_eligibilidade
   - solicitacoes_titular (LGPD)
   - email_templates / email_historico
═══════════════════════════════════════════════════════════════════════════ */

/* db-api.js carregado via <script src="js/db-api.js"> */


    function toggleSidebar(){
      document.body.classList.toggle('mobile-menu-open');
    }

    function closeMobileMenu(){
      document.body.classList.remove('mobile-menu-open');
    }

    const dashboardPieData = [55,25,15,5];
    const dashboardPieLabels = ['Produção','Manutenção','Almoxarifado','Qualidade'];
    const dashboardPieColors = ['#1976d2','#2e9e5b','#f5c842','#d9534f'];
    let dashboardSort = { key: null, direction: 'asc' };
    const dashboardStatusOrder = {
      'Em uso (OK)': 1,
      'Próx. do vencimento': 2,
      'Vencido (uso excedido)': 3
    };

    const dashboardRows = [
      {nome:'João Pereira', ini:'JP', setor:'Produção', epi:'Protetor auricular', entrega:'01/04/2026', prazo:30},
      {nome:'Ana Souza', ini:'AS', setor:'Produção', epi:'Óculos de proteção', entrega:'05/04/2026', prazo:60},
      {nome:'Maria Fernandez', ini:'MF', setor:'Qualidade', epi:'Luva nitrílica', entrega:'10/03/2026', prazo:30},
      {nome:'Bruno Costa', ini:'BC', setor:'Qualidade', epi:'Capacete', entrega:'20/03/2026', prazo:90},
      {nome:'Ricardo Melo', ini:'RM', setor:'Manutenção', epi:'Botina de segurança', entrega:'25/03/2026', prazo:30},
      {nome:'Marcos Silva', ini:'MS', setor:'Manutenção', epi:'Botina de segurança', entrega:'12/04/2026', prazo:30}
    ];

    function renderDashboardLegend(){
      const el = document.getElementById('dashboardPieLegend');
      if(!el) return;
      el.innerHTML = dashboardPieLabels.map((label, i) => `
        <div class="legend-item">
          <div class="legend-dot" style="background:${dashboardPieColors[i]}"></div>
          <span class="legend-label">${label}</span>
          <span class="legend-value">${dashboardPieData[i]}%</span>
        </div>
      `).join('');
    }

    function calcularStatusUso(dataEntrega, prazoDias){
      const [dia, mes, ano] = dataEntrega.split('/').map(Number);
      const entrega = new Date(ano, mes - 1, dia);
      const hoje = new Date();
      hoje.setHours(0,0,0,0);
      const vencimento = new Date(entrega);
      vencimento.setDate(vencimento.getDate() + prazoDias);
      const diff = Math.ceil((vencimento - hoje) / (1000 * 60 * 60 * 24));

      if(diff < 0) return {texto:'Vencido (uso excedido)', classe:'badge-danger'};
      if(diff <= 5) return {texto:'Próx. do vencim. de uso', classe:'badge-warning'};
      return {texto:'Em uso (OK)', classe:'badge-ok'};
    }

    function parseDashboardDate(dateStr){
      const [dia, mes, ano] = dateStr.split('/').map(Number);
      return new Date(ano, mes - 1, dia).getTime();
    }

    function getDashboardStatusText(row){
      return calcularStatusUso(row.entrega, row.prazo).texto;
    }

    function sortDashboardTable(key){
      if(dashboardSort.key === key){
        dashboardSort.direction = dashboardSort.direction === 'asc' ? 'desc' : 'asc';
      } else {
        dashboardSort.key = key;
        dashboardSort.direction = 'asc';
      }

      dashboardRows.sort((a, b) => {
        let valueA;
        let valueB;

        if(key === 'entrega'){
          valueA = parseDashboardDate(a.entrega);
          valueB = parseDashboardDate(b.entrega);
        } else if(key === 'prazo'){
          valueA = a.prazo;
          valueB = b.prazo;
        } else if(key === 'status'){
          valueA = dashboardStatusOrder[getDashboardStatusText(a)] || 99;
          valueB = dashboardStatusOrder[getDashboardStatusText(b)] || 99;
        } else {
          valueA = String(a[key] || '').toLowerCase();
          valueB = String(b[key] || '').toLowerCase();
        }

        if(valueA < valueB) return dashboardSort.direction === 'asc' ? -1 : 1;
        if(valueA > valueB) return dashboardSort.direction === 'asc' ? 1 : -1;
        return 0;
      });

      renderDashboardTable();
    }

    function renderDashboardTable(){
      const el = document.getElementById('dashboardTableBody');
      if(!el) return;

      const priorityRows = dashboardRows
        .map(row => ({ row, statusCalc: calcularStatusUso(row.entrega, row.prazo) }))
        .filter(item => item.statusCalc.texto !== 'Em uso (OK)');

      const countEl = document.getElementById('dashboardPriorityCount');
      if(countEl){
        countEl.textContent = `${priorityRows.length} prioridades`;
      }

      const trocaImediata = priorityRows.filter(item => item.statusCalc.texto === 'Vencido (uso excedido)').length;
      const proximoVencimento = priorityRows.filter(item => item.statusCalc.texto === 'Próx. do vencim. de uso').length;
      const emailsResponsaveis = priorityRows.length ? 3 : 0;

      const kpiTroca = document.getElementById('kpiTrocaImediata');
      const kpiProximo = document.getElementById('kpiProximoVencimento');
      const kpiEmails = document.getElementById('kpiEmailsResponsaveis');
      if(kpiTroca) kpiTroca.textContent = trocaImediata;
      if(kpiProximo) kpiProximo.textContent = proximoVencimento;
      if(kpiEmails) kpiEmails.textContent = emailsResponsaveis;

      const mailList = document.getElementById('autoMailPreviewList');
      if(mailList){
        const recipients = ['sst@empresa.com','almoxarifado@empresa.com','lideranca@empresa.com'];
        mailList.innerHTML = priorityRows.length ? recipients.map((email, index) => `
          <div class="mail-preview-item">
            <strong>${email}</strong>
            <span>Assunto: Alerta automático de EPI ${index === 0 ? 'crítico' : 'próximo do vencimento de uso'}.</span>
            <span>${priorityRows.slice(0, 3).map(item => `${item.row.nome} · ${item.row.epi} · ${item.statusCalc.texto === 'Vencido (uso excedido)' ? 'Troca imediata' : 'Próximo do vencimento'}`).join(' | ')}</span>
            <span class="mail-chip"><span class="material-symbols-outlined" style="font-size:16px">schedule_send</span>Prévia automática</span>
          </div>
        `).join('') : `<div class="mail-preview-item"><strong>Nenhum alerta pendente</strong><span>No momento, não existem EPIs com prioridade para troca ou vencimento próximo.</span></div>`;
      }

      el.innerHTML = priorityRows.map((item, i) => {
        const row = item.row;
        const statusCalc = item.statusCalc;
        return `
          <tr onclick="openEmployeeHistoryFromDashboard('${row.nome}','${row.setor}')" style="cursor:pointer">
            <td data-label="Funcionário">
              <div class="user-cell">
                <div class="avatar" style="background:${['#2e7d32','#1565c0','#6a1b9a','#ad1457','#e65100','#546e4a'][i % 6]};color:#fff">${row.ini}</div>
                <div><strong>${row.nome}</strong></div>
              </div>
            </td>
            <td data-label="Setor">${row.setor}</td>
            <td data-label="EPI em uso">${row.epi}</td>
            <td data-label="Data da entrega">${row.entrega}</td>
            <td data-label="Prazo de uso">${row.prazo} dias</td>
            <td data-label="Status do EPI"><span class="badge ${statusCalc.classe}">${statusCalc.texto === 'Vencido (uso excedido)' ? 'Troca imediata' : 'Próximo do vencimento'}</span></td>
          </tr>
        `;
      }).join('');
    }

    function renderDashboardCharts(){
      renderDashboardLegend();
      renderDashboardTable();
      if(window.Chart){
        const pieCanvas = document.getElementById('dashboardPieChart');
        const barCanvas = document.getElementById('dashboardBarChart');
        if(pieCanvas && !pieCanvas.dataset.rendered){
          new Chart(pieCanvas, {
            type:'doughnut',
            data:{labels:dashboardPieLabels,datasets:[{data:dashboardPieData,backgroundColor:dashboardPieColors,borderWidth:3,borderColor:getComputedStyle(document.documentElement).getPropertyValue('--surface').trim(),hoverOffset:6}]},
            options:{responsive:false,cutout:'62%',plugins:{legend:{display:false}}}
          });
          pieCanvas.dataset.rendered = '1';
        }
        if(barCanvas && !barCanvas.dataset.rendered){
          new Chart(barCanvas, {
            type:'bar',
            data:{labels:['Entregues','Próx. vencimento','Disponíveis','Vencidos'],datasets:[{data:[152,8,312,15],backgroundColor:['rgba(25,118,210,.9)','rgba(239,139,19,.9)','rgba(61,152,64,.9)','rgba(204,49,49,.9)'],borderRadius:10,borderSkipped:false,barThickness:42}]},
            options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{x:{grid:{display:false}},y:{beginAtZero:true,grid:{color:'rgba(128,128,128,.12)'}}}}
          });
          barCanvas.dataset.rendered = '1';
        }
      }
    }

    const html = document.documentElement;
    let currentMenuPreviewRole = 'Master';
    const rolePermissions = {
      'Master': ['emailsGestao','dashboard','operations','reports','materials','eligibilityRules','purchases','stockValidity','availableItems','deliveredItems','epiFicha','importEmployees','newUser','employeeHistory','request','supervisorApproval','stockRequests','userAdmin','config','support','lgpd'],
      'Administrador': ['emailsGestao','dashboard','operations','reports','materials','eligibilityRules','purchases','stockValidity','availableItems','deliveredItems','epiFicha','employeeHistory','request','supervisorApproval','stockRequests','support','lgpd'],
      'Supervisor': ['emailsGestao','dashboard','reports','availableItems','deliveredItems','epiFicha','employeeHistory','request','supervisorApproval','stockRequests','support','lgpd'],
      'Usuário': ['emailsGestao','dashboard','request','employeeHistory','stockRequests','support','lgpd']
    };

    // PERMISSÕES DE AÇÃO — lista de ações BLOQUEADAS por perfil
    // Por padrão todos têm tudo. O Master pode bloquear ações específicas por perfil.
    var blockedActions = {
      'Master':        [],
      'Administrador': [],
      'Supervisor':    [],
      'Usuário':       [],
    };

    // Todas as ações existentes no sistema
    var ALL_ACTIONS = [
      'rules:add','rules:edit','rules:delete',
      'materials:add','materials:edit','materials:delete',
      'purchases:add','purchases:edit',
      'stock:edit',
      'epis:deliver','epis:return',
      'users:add','users:edit','users:deactivate',
      'requests:approve','requests:reject',
      'reports:export',
      'import:employees',
    ];

    function canDo(action) {
      // Master nunca pode ser bloqueado
      if (currentMenuPreviewRole === 'Master') return true;
      return !(blockedActions[currentMenuPreviewRole] || []).includes(action);
    }

    function applyActionPermissions() {
      // Botão Nova regra
      document.querySelectorAll('[onclick="openRuleModal()"]').forEach(function(btn) {
        var ok = canDo('rules:add');
        btn.style.display = ok ? '' : 'none';
      });
      // Rebuildamos tabelas que dependem de permissão
      if (typeof rulesFilter === 'function') rulesFilter();
    }


    function applyMenuPermissions(){
      const allPages = ['emailsGestao','dashboard','operations','reports','materials','eligibilityRules','purchases','stockValidity','availableItems','deliveredItems','epiFicha','importEmployees','newUser','employeeHistory','request','supervisorApproval','stockRequests','userAdmin','config','support','lgpd'];
      const allowed = currentMenuPreviewRole === 'Master'
        ? allPages
        : (rolePermissions[currentMenuPreviewRole] || []);

      document.querySelectorAll('.nav a[data-page]').forEach(link => {
        const page = link.dataset.page;
        link.style.display = allowed.includes(page) ? 'flex' : 'none';
      });

      document.querySelectorAll('[data-target-page]').forEach(el => {
        const targetPage = el.dataset.targetPage;
        const isAllowed = allowed.includes(targetPage);
        el.classList.toggle('permission-hidden', !isAllowed);
        el.classList.toggle('permission-disabled', !isAllowed);
        if(!isAllowed){
          el.setAttribute('aria-hidden', 'true');
          el.setAttribute('tabindex', '-1');
          if(el.tagName === 'BUTTON') el.disabled = true;
        } else {
          el.removeAttribute('aria-hidden');
          el.removeAttribute('tabindex');
          if(el.tagName === 'BUTTON') el.disabled = false;
        }
      });

      applyActionPermissions();
      const activeVisible = document.querySelector('.nav a.active[data-page]');
      if(!activeVisible || activeVisible.style.display === 'none'){
        const firstVisible = Array.from(document.querySelectorAll('.nav a[data-page]')).find(link => link.style.display !== 'none');
        if(firstVisible){
          setActiveNav(firstVisible);
          const pageMap = {
            dashboard:'dashboardView', operations:'operationsView', reports:'reportsView', materials:'materialsView', eligibilityRules:'eligibilityRulesView', purchases:'purchasesView', stockValidity:'stockValidityView', availableItems:'availableItemsView', deliveredItems:'deliveredItemsView', epiFicha:'epiFichaView', newUser:'newUserView', employeeHistory:'employeeHistoryView', request:'requestView', supervisorApproval:'supervisorApprovalView', stockRequests:'stockRequestsView', userAdmin:'userAdminView', config:'configView', support:'supportView'
          };
          showView(pageMap[firstVisible.dataset.page] || 'dashboardView');
        }
      }
    }

    function setMenuPreviewRole(role){
      currentMenuPreviewRole = role;
      applyMenuPermissions();
    }

    function toggleRolePermission(button){
      button.classList.toggle('active');
      const role = button.dataset.role;
      const page = button.dataset.page;
      if(!role || !page) return;
      const list = rolePermissions[role] || [];
      const index = list.indexOf(page);
      if(button.classList.contains('active')){
        if(index === -1) list.push(page);
      } else if(index !== -1){
        list.splice(index, 1);
      }
      rolePermissions[role] = list;
      if(currentMenuPreviewRole === role) applyMenuPermissions();
    }
        const followSystemBtn = document.getElementById('followSystem');
    const globalDarkBtn = document.getElementById('globalDark');
    const storageKey = 'app-theme-mode';
    const mq = window.matchMedia('(prefers-color-scheme: dark)');

    function applyTheme(mode){
      let resolved = mode;
      if(mode === 'system') resolved = mq.matches ? 'dark' : 'light';
      else if(mode === 'light') resolved = 'light';
      else resolved = 'dark';
      html.setAttribute('data-theme', resolved);
      // Estes botões só existem na página de Configurações — verificação
      // de nulo evita crash nas demais páginas separadas.
      if (followSystemBtn) followSystemBtn.classList.toggle('active', mode === 'system');
      if (globalDarkBtn)   globalDarkBtn.classList.toggle('active', mode === 'dark');
      // Quando está em modo claro manual, garante que data-theme seja removido
      if(resolved === 'light') html.removeAttribute('data-theme');
      else html.setAttribute('data-theme', resolved);
      localStorage.setItem(storageKey, mode);
    }

    function getSavedMode(){
      return localStorage.getItem(storageKey) || 'light';
    }

    // Estes botões só existem na página de Configurações — em qualquer outra
    // página separada (dashboard, materials, etc.) eles não estão no DOM.
    // Sem esta verificação, .addEventListener em null trava TODO o restante
    // do script (causa raiz da tela em branco nas páginas separadas).
    if (followSystemBtn) {
      followSystemBtn.addEventListener('click', () => {
        const current = getSavedMode();
        if(current === 'system') {
          applyTheme('light');
        } else {
          applyTheme('system');
        }
      });
    }

    if (globalDarkBtn) {
      globalDarkBtn.addEventListener('click', () => {
        const current = getSavedMode();
        if(current === 'dark') {
          applyTheme('light');
        } else {
          applyTheme('dark');
        }
      });
    }

    mq.addEventListener?.('change', () => {
      if(getSavedMode() === 'system') applyTheme('system');
    });

    applyTheme(getSavedMode());

    

    function showView(viewId){
      const target = document.getElementById(viewId);
      // Nas páginas separadas, cada arquivo HTML contém apenas UMA view.
      // Se a view solicitada não existir nesta página (ex.: código legado
      // tentando forçar 'dashboardView' em purchases.html), não fazemos nada —
      // isso evita apagar a classe 'active' da view real sem conseguir
      // restaurá-la, o que deixava a página inteira em branco.
      if (!target) {
        console.warn('[showView] "' + viewId + '" não existe nesta página — ignorando.');
        return;
      }
      document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
      target.classList.add('active');
      if(viewId === 'dashboardView') renderDashboardCharts();
    }

    function setActiveNav(link){
      document.querySelectorAll('.nav a').forEach(a => a.classList.remove('active'));
      if(link) link.classList.add('active');
      closeMobileMenu();
    }

    function toggleAccountEdit(){
      const form = document.getElementById('accountEditForm');
      const summary = document.getElementById('accountSummary');
      const isOpen = form.style.display === 'block';
      form.style.display = isOpen ? 'none' : 'block';
      summary.style.display = isOpen ? 'grid' : 'none';
    }

    function openPasswordModal() {
      // Reset fields
      ['pwdCurrent','pwdNew','pwdConfirm'].forEach(function(id){
        var el = document.getElementById(id);
        if (el) el.value = '';
      });
      checkPasswordStrength('');
      var msg = document.getElementById('pwdMatchMsg');
      if (msg) { msg.style.display='none'; }
      var btn = document.getElementById('pwdSaveBtn');
      if (btn) { btn.disabled=true; btn.style.opacity='0.5'; }
      document.getElementById('passwordModal').classList.add('open');
    }

    function closePasswordModal(event) {
      if (event && event.target && event.target.id !== 'passwordModal') return;
      document.getElementById('passwordModal').classList.remove('open');
    }

    function togglePwdVisibility(inputId, btn) {
      var inp = document.getElementById(inputId);
      if (!inp) return;
      var isHidden = inp.type === 'password';
      inp.type = isHidden ? 'text' : 'password';
      btn.textContent = isHidden ? 'visibility_off' : 'visibility';
    }

    function checkPasswordStrength(val) {
      var hasLen     = val.length >= 8;
      var hasUpper   = /[A-Z]/.test(val);
      var hasLower   = /[a-z]/.test(val);
      var hasNumber  = /[0-9]/.test(val);
      var hasSpecial = /[^A-Za-z0-9]/.test(val);

      // Update requirement badges
      function setReq(id, ok) {
        var el = document.getElementById(id);
        if (!el) return;
        el.classList.toggle('pwd-req-ok', ok);
      }
      setReq('req-len',     hasLen);
      setReq('req-upper',   hasUpper);
      setReq('req-lower',   hasLower);
      setReq('req-number',  hasNumber);
      setReq('req-special', hasSpecial);

      // Score: count criteria met
      var score = [hasLen, hasUpper, hasLower, hasNumber, hasSpecial].filter(Boolean).length;
      var bars  = ['pwdBar1','pwdBar2','pwdBar3','pwdBar4'];
      var label = document.getElementById('pwdStrengthLabel');

      if (!val) {
        bars.forEach(function(id){ var el=document.getElementById(id); if(el) el.className=''; el.style.background='var(--outline-variant)'; });
        if (label) { label.textContent='Digite a senha'; label.style.color='var(--on-surface-variant)'; }
        return;
      }

      var cfg = {
        1: { fill: 1, cls: 'pwd-bar-weak',   text: 'Muito fraca',  color: '#FF3B30' },
        2: { fill: 2, cls: 'pwd-bar-weak',    text: 'Fraca',        color: '#FF3B30' },
        3: { fill: 2, cls: 'pwd-bar-fair',    text: 'Média',        color: '#FF9500' },
        4: { fill: 3, cls: 'pwd-bar-good',    text: 'Forte',        color: '#34C759' },
        5: { fill: 4, cls: 'pwd-bar-strong',  text: 'Muito forte',  color: '#007AFF' },
      };
      var c = cfg[score] || cfg[1];
      bars.forEach(function(id, i) {
        var el = document.getElementById(id);
        if (!el) return;
        el.style.background = i < c.fill ? '' : 'var(--outline-variant)';
        el.className = i < c.fill ? c.cls : '';
      });
      if (label) { label.textContent = c.text; label.style.color = c.color; }

      // Enable save only when all 5 criteria met AND passwords match
      checkPasswordMatch();
    }

    function checkPasswordMatch() {
      var newPwd  = (document.getElementById('pwdNew')?.value     || '');
      var confirm = (document.getElementById('pwdConfirm')?.value || '');
      var msg     = document.getElementById('pwdMatchMsg');
      var btn     = document.getElementById('pwdSaveBtn');

      var allCriteria = newPwd.length >= 8 &&
        /[A-Z]/.test(newPwd) && /[a-z]/.test(newPwd) &&
        /[0-9]/.test(newPwd) && /[^A-Za-z0-9]/.test(newPwd);

      if (!confirm) {
        if (msg) msg.style.display = 'none';
      } else if (newPwd === confirm) {
        if (msg) { msg.style.display='block'; msg.textContent='✓ Senhas coincidem'; msg.style.color='#34C759'; }
      } else {
        if (msg) { msg.style.display='block'; msg.textContent='✗ Senhas não coincidem'; msg.style.color='#FF3B30'; }
      }

      var canSave = allCriteria && newPwd === confirm && confirm.length > 0;
      if (btn) { btn.disabled = !canSave; btn.style.opacity = canSave ? '1' : '0.5'; }
    }

    function saveNewPassword() {
      var current = document.getElementById('pwdCurrent').value.trim();
      var newPwd  = document.getElementById('pwdNew').value;
      var confirm = document.getElementById('pwdConfirm').value;
      if (!current) { alert('Digite a senha atual.'); return; }
      if (newPwd !== confirm) { alert('As senhas não coincidem.'); return; }
      closePasswordModal();
      showToast('Senha alterada com sucesso!', 'success');
    }

    
    function closePasswordModal(event){
      if(event && event.target && event.target.id !== 'passwordModal') return;
      document.getElementById('passwordModal').classList.remove('open');
    }

    function toggleCPFLabel(){
      const label = document.getElementById('cpfDisplay');
      const masked = '***.***.789-45';
      const full = '123.456.789-45';
      label.textContent = label.textContent === masked ? full : masked;
    }

    // Toggle visualização CPF
    function toggleCPF(){
      const input = document.getElementById('cpf');
      const full = input.getAttribute('data-full');
      const isMasked = input.value.includes('*');
      if(isMasked){
        input.value = formatCPF(full);
      } else {
        input.value = maskCPF(full);
      }
    }

    function maskCPF(cpf){
      const v = cpf.replace(/\D/g,'');
      const last5 = v.slice(-5);
      return '***.***.' + last5.slice(0,3) + '-' + last5.slice(3);
    }

    function formatCPF(cpf){
      const v = cpf.replace(/\D/g,'');
      return v.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/,'$1.$2.$3-$4');
    }
  
    function toggleCustomMaterialType(){
      const select = document.getElementById('materialTipo');
      const customField = document.getElementById('customMaterialTypeField');
      const customInput = document.getElementById('materialTipoCustom');
      const isOther = select && select.value === 'Outro';
      if(customField){
        customField.style.display = isOther ? 'flex' : 'none';
      }
      if(customInput && !isOther){
        customInput.value = '';
      }
    }

        function toggleValidityFields() {
      var val    = document.getElementById('materialValidade')?.value;
      var fields = document.getElementById('validityFields');
      if (fields) fields.style.display = val === 'nao' ? 'none' : '';
    }

    function updatePrazoLabel() {
      var tipo    = document.getElementById('materialValidadeTipo')?.value || 'meses';
      var label   = document.getElementById('materialPrazoLabel');
      var helper  = document.getElementById('materialPrazoHelper');
      var labels  = { meses: 'Prazo de uso (meses)', dias: 'Prazo de uso (dias)', anos: 'Prazo de uso (anos)' };
      var helpers = {
        meses: 'Quantos meses o funcionário pode usar este item após a entrega.',
        dias:  'Quantos dias o funcionário pode usar este item após a entrega.',
        anos:  'Quantos anos o funcionário pode usar este item após a entrega.',
      };
      if (label)  label.textContent  = labels[tipo]  || labels.meses;
      if (helper) helper.textContent = helpers[tipo] || helpers.meses;
      updatePrazoPreview();
    }

    function updatePrazoPreview() {
      var tipo   = document.getElementById('materialValidadeTipo')?.value || 'meses';
      var prazo  = parseInt(document.getElementById('materialPrazo')?.value || '0');
      var prev   = document.getElementById('materialPrazoPreview');
      var prevTx = document.getElementById('materialPrazoPreviewText');
      if (!prev || !prazo || prazo < 1) { if (prev) prev.style.display = 'none'; return; }

      // Calculate example date
      var ex = new Date();
      if (tipo === 'meses') ex.setMonth(ex.getMonth() + prazo);
      else if (tipo === 'dias')  ex.setDate(ex.getDate() + prazo);
      else if (tipo === 'anos')  ex.setFullYear(ex.getFullYear() + prazo);

      var unidade = tipo === 'meses'
        ? (prazo === 1 ? '1 mês' : prazo + ' meses')
        : tipo === 'anos'
          ? (prazo === 1 ? '1 ano' : prazo + ' anos')
          : (prazo === 1 ? '1 dia' : prazo + ' dias');

      prevTx.textContent = 'Entrega hoje → Vencimento em ' + unidade + ' → ' + ex.toLocaleDateString('pt-BR');
      prev.style.display = 'block';
    }

    function getUserRow(userId){
      return document.querySelector(`tr[data-user-id="${userId}"]`);
    }

    function closeGenericModal(modalId, event){
      if(event && event.target && event.target.id !== modalId) return;
      document.getElementById(modalId).classList.remove('open');
    }

    function getRoleBadge(role){
      const cls = role === 'Master' ? 'role-master' : role === 'Administrador' ? 'role-admin' : role === 'Supervisor' ? 'role-supervisor' : 'role-user';
      return `<span class="badge ${cls}">${role}</span>`;
    }

    function getStatusBadge(status){
      const active = status === 'Ativo';
      return `<span class="badge ${active ? 'status-active' : 'status-inactive'}">${status}</span>`;
    }

    function openUserEditModal(userId){
      const row = getUserRow(userId);
      if(!row) return;
      document.getElementById('editUserId').value = userId;
      document.getElementById('editUserName').value = row.dataset.userName;
      document.getElementById('editUserEmail').value = row.dataset.userEmail;
      document.getElementById('editUserMatricula').value = row.dataset.userMatricula;
      document.getElementById('editUserRole').value = row.dataset.userRole;
      document.getElementById('editUserStatus').value = row.dataset.userStatus;
      document.getElementById('userEditModal').classList.add('open');
    }

    function saveUserPreview(){
      const userId = document.getElementById('editUserId').value;
      const row = getUserRow(userId);
      if(!row) return;
      const name = document.getElementById('editUserName').value;
      const email = document.getElementById('editUserEmail').value;
      const role = document.getElementById('editUserRole').value;
      const status = document.getElementById('editUserStatus').value;
      row.dataset.userName = name;
      row.dataset.userEmail = email;
      row.dataset.userRole = role;
      row.dataset.userStatus = status;
      row.querySelector('.js-user-name').textContent = name;
      row.querySelector('.js-user-email').textContent = email;
      row.querySelector('.js-user-role').innerHTML = getRoleBadge(role);
      row.querySelector('.js-user-status').innerHTML = getStatusBadge(status);
      row.querySelector('.inline-actions').innerHTML = `
        <button class="mini-btn" type="button" onclick="openUserEditModal('${userId}')">Editar</button>
        ${role !== 'Usuário' ? `<button class="mini-btn" type="button" onclick="openPermissionsModal('${userId}')">Permissões</button>` : ''}
        <button class="mini-btn" type="button" onclick="toggleUserStatus('${userId}')">${status === 'Ativo' ? 'Desativar' : 'Reativar'}</button>
      `;
      if(userId === 'LF'){
        const accountTitle = document.querySelector('#accountSummary .account-meta h3');
        const accountSub = document.querySelector('#accountSummary .account-meta p');
        if(accountTitle) accountTitle.textContent = name;
        if(accountSub) accountSub.textContent = `${email} · (47) 99999-0000`;
        updateDashboardWelcome();
      }
      closeGenericModal('userEditModal');
    }

    function openPermissionsModal(userId){
      const row = getUserRow(userId);
      if(!row) return;
      document.getElementById('permissionsUserName').textContent = `Prévia de permissões para ${row.dataset.userName}.`;
      document.getElementById('permissionsModal').classList.add('open');
    }

    function toggleUserStatus(userId){
      const row = getUserRow(userId);
      if(!row) return;
      const next = row.dataset.userStatus === 'Ativo' ? 'Inativo' : 'Ativo';
      row.dataset.userStatus = next;
      row.querySelector('.js-user-status').innerHTML = getStatusBadge(next);
      const actionBtn = row.querySelector('.inline-actions .mini-btn:last-child');
      if(actionBtn) actionBtn.textContent = next === 'Ativo' ? 'Desativar' : 'Reativar';
    }

    function addEpiField(){
      const view = document.getElementById('requestView');
      const container = view ? view.querySelector('#epiContainer') : null;
      if(!container) return;

      const div = document.createElement('div');
      div.classList.add('form-grid','epi-item');
      div.style.marginTop = '10px';

      div.innerHTML = `
        <div class="field">
          <label>EPI necessário</label>
          <select class="select">
            <option>Botina de segurança</option>
            <option>Óculos de proteção</option>
            <option>Luva nitrílica</option>
            <option>Protetor auricular</option>
          </select>
        </div>
        <div class="field">
          <label>Tamanho</label>
          <select class="select">
            <option>39</option>
            <option>40</option>
            <option>41</option>
            <option>Único</option>
            <option>M</option>
            <option>G</option>
          </select>
        </div>
        <div class="field full">
          <label>Quantidade</label>
          <input type="number" class="input" value="1" min="1" />
        </div>
        <div class="field full epi-item-actions" style="justify-content:space-between;gap:10px">
          <button class="outlined-btn" type="button" onclick="addEpiField()">+ Adicionar</button>
          <button class="remove-epi-btn" type="button" onclick="removeEpiField(this)">Remover</button>
        </div>
      `;

      container.appendChild(div);
    }

    function removeEpiField(button){
      const view = document.getElementById('requestView');
      const container = view ? view.querySelector('#epiContainer') : null;
      if(!container) return;
      const items = container.querySelectorAll('.epi-item');
      if(items.length <= 1) return;
      const item = button.closest('.epi-item');
      if(item) item.remove();
    }

    function removeLastEpi(){
      const view = document.getElementById('requestView');
      const container = view ? view.querySelector('#epiContainer') : null;
      if(!container) return;
      const items = container.querySelectorAll('.epi-item');
      if(items.length <= 1) return;
      container.lastElementChild.remove();
    }

    function updateSaldoLabelsBase(){
      const material = document.getElementById('purchaseMaterial')?.value || '';
      let unidade = 'unidades';
      let nomeCurto = material || 'material';

      if(material.toLowerCase().includes('botina') || material.toLowerCase().includes('sapat')) {
        unidade = 'pares';
        nomeCurto = 'botina';
      }
      else if(material.toLowerCase().includes('luva')) {
        unidade = 'pares';
        nomeCurto = 'luva';
      }
      else if(material.toLowerCase().includes('óculos')) {
        unidade = 'unidades';
        nomeCurto = 'óculos';
      }
      else if(material.toLowerCase().includes('protetor')) {
        unidade = 'unidades';
        nomeCurto = 'protetor auricular';
      }

      // Estes labels só existem na página Compras/Entradas — verificação de
      // nulo evita crash nas demais páginas separadas.
      var labelSaldoAnterior = document.getElementById('labelSaldoAnterior');
      var labelNovaCompra    = document.getElementById('labelNovaCompra');
      var labelNovoSaldo     = document.getElementById('labelNovoSaldo');
      if (labelSaldoAnterior) labelSaldoAnterior.textContent = 'Saldo anterior ('+unidade+')';
      if (labelNovaCompra)    labelNovaCompra.textContent    = 'Nova compra ('+unidade+')';
      if (labelNovoSaldo)     labelNovoSaldo.textContent     = 'Novo saldo ('+unidade+')';

      const title = document.getElementById('purchaseSaldoTitle');
      const helper = document.getElementById('purchaseSaldoHelper');
      if(title) title.textContent = 'Saldo de ' + nomeCurto;
      if(helper) helper.textContent = 'Exemplo: se a ' + nomeCurto + ' tinha 8 ' + unidade + ' em estoque e foi registrada uma nova compra de 40 ' + unidade + ', o sistema deve passar a mostrar 48 ' + unidade + ' disponíveis.';
    }

    


    const displayModeKey = 'app-display-mode';

    function setDisplayMode(mode) {
      const htmlEl = document.documentElement;
      // Remove modo anterior
      htmlEl.removeAttribute('data-display');
      // Aplica novo se não for default
      if (mode !== 'default') htmlEl.setAttribute('data-display', mode);
      // Salva preferência
      localStorage.setItem(displayModeKey, mode);
      // Atualiza estado visual dos chips
      document.getElementById('chipDefault').classList.toggle('active',  mode === 'default');
      document.getElementById('chipContrast').classList.toggle('active', mode === 'contrast');
    }

    // Restaura modo salvo no carregamento
    (function() {
      const saved = localStorage.getItem(displayModeKey) || 'default';
      if (saved !== 'default') {
        document.documentElement.setAttribute('data-display', saved);
      }
      // Atualiza chips após DOM pronto
      document.addEventListener('DOMContentLoaded', () => {
      setTimeout(() => loadDashboardFromAPI(), 300);
        const s = localStorage.getItem(displayModeKey) || 'default';
        document.getElementById('chipDefault')?.classList.toggle('active',  s === 'default');
        document.getElementById('chipContrast')?.classList.toggle('active', s === 'contrast');
      });
    })();


    /* ── ACESSIBILIDADE VISUAL JS ── */
    const a11yKey = 'app-a11y-mode';
    const a11yModes = ['default','deuteranopia','protanopia','tritanopia','lowvision','monochrome'];

    function setA11y(mode) {
      const el = document.documentElement;
      el.removeAttribute('data-a11y');
      if (mode !== 'default') el.setAttribute('data-a11y', mode);
      localStorage.setItem(a11yKey, mode);
      a11yModes.forEach(m => {
        const btn = document.getElementById('a11y-' + m);
        if (btn) btn.classList.toggle('active', m === mode);
      });
    }

    function openA11yPanel() {
      const panel = document.getElementById('a11yPanel');
      if (!panel) return;
      panel.style.display = 'block';
      document.getElementById('chipA11y').classList.add('active');
      panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    function closeA11yPanel() {
      const panel = document.getElementById('a11yPanel');
      if (panel) panel.style.display = 'none';
      const saved = localStorage.getItem(a11yKey) || 'default';
      document.getElementById('chipA11y').classList.toggle('active', saved !== 'default');
    }

    // Restaura modo ao carregar
    (function() {
      const saved = localStorage.getItem(a11yKey) || 'default';
      if (saved !== 'default') document.documentElement.setAttribute('data-a11y', saved);
      document.addEventListener('DOMContentLoaded', () => {
        a11yModes.forEach(m => {
          const btn = document.getElementById('a11y-' + m);
          if (btn) btn.classList.toggle('active', m === saved);
        });
        if (saved !== 'default') {
          document.getElementById('chipA11y')?.classList.add('active');
        }
      });
    })();


    /* ── IMPORTAÇÃO DE FUNCIONÁRIOS JS ── */

    let importedRows = [];

    const IMPORT_COLS = [
      { key: 'nome',          label: 'Nome',          required: true  },
      { key: 'setor',         label: 'Setor',         required: true  },
      { key: 'telefone',      label: 'Telefone',      required: false },
      { key: 'cpf',           label: 'CPF',           required: true  },
      { key: 'matricula',     label: 'Matrícula',     required: true  },
      { key: 'nascimento',    label: 'Nascimento',    required: false },
      { key: 'contratacao',   label: 'Contratação',   required: true  },
      { key: 'cargo',         label: 'Cargo',         required: true  },
    ];

    // Normaliza cabeçalho da planilha para keys internas
    const HEADER_MAP = {
      'nome': 'nome', 'name': 'nome', 'funcionário': 'nome', 'funcionario': 'nome',
      'setor': 'setor', 'departamento': 'setor', 'area': 'setor', 'área': 'setor',
      'cpf': 'cpf',
      'matrícula': 'matricula', 'matricula': 'matricula', 'mat': 'matricula', 'registro': 'matricula',
      'nascimento': 'nascimento', 'data de nascimento': 'nascimento', 'dt nascimento': 'nascimento',
      'contratação': 'contratacao', 'contratacao': 'contratacao', 'admissão': 'contratacao',
      'admissao': 'contratacao', 'data de contratação': 'contratacao', 'data contratação': 'contratacao',
      'telefone': 'telefone', 'tel': 'telefone', 'celular': 'telefone', 'fone': 'telefone',
      'whatsapp': 'telefone', 'contato': 'telefone', 'número': 'telefone', 'numero': 'telefone',
      'cargo': 'cargo', 'função': 'cargo', 'funcao': 'cargo', 'função/cargo': 'cargo', 'posição': 'cargo',
    };

    function importNormKey(raw) {
      return (raw || '').toString().toLowerCase().trim().replace(/\s+/g,' ');
    }

    function importFormatCPF(v) {
      const d = v.replace(/\D/g,'');
      if (d.length !== 11) return v;
      return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
    }

    function importValidateCPF(v) {
      const d = v.replace(/\D/g,'');
      if (d.length !== 11 || /^(\d)\1+$/.test(d)) return false;
      let s = 0;
      for (let i = 0; i < 9; i++) s += +d[i] * (10 - i);
      let r = (s * 10) % 11; if (r === 10 || r === 11) r = 0;
      if (r !== +d[9]) return false;
      s = 0;
      for (let i = 0; i < 10; i++) s += +d[i] * (11 - i);
      r = (s * 10) % 11; if (r === 10 || r === 11) r = 0;
      return r === +d[10];
    }

    function importFormatDate(v) {
      if (!v) return '';
      // Excel serial number
      if (typeof v === 'number') {
        const d = new Date(Math.round((v - 25569) * 86400 * 1000));
        return d.toLocaleDateString('pt-BR');
      }
      const s = v.toString().trim();
      // already DD/MM/YYYY
      if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) return s;
      // YYYY-MM-DD
      const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (m) return `${m[3]}/${m[2]}/${m[1]}`;
      return s;
    }

    function importValidateDate(v) {
      if (!v) return false;
      const s = importFormatDate(v);
      return /^\d{2}\/\d{2}\/\d{4}$/.test(s);
    }

    function importDragOver(e) {
      e.preventDefault();
      document.getElementById('importDropzone').classList.add('drag-over');
    }
    function importDragLeave(e) {
      document.getElementById('importDropzone').classList.remove('drag-over');
    }
    function importDrop(e) {
      e.preventDefault();
      document.getElementById('importDropzone').classList.remove('drag-over');
      const file = e.dataTransfer.files[0];
      if (file) importHandleFile(file);
    }

    function importHandleFile(file) {
      if (!file) return;
      const ext = file.name.split('.').pop().toLowerCase();
      if (!['xlsx','xls','csv'].includes(ext)) {
        alert('Formato inválido. Use .xlsx, .xls ou .csv');
        return;
      }
      if (ext === 'csv') {
        const reader = new FileReader();
        reader.onload = e => importParseCSV(e.target.result, file.name);
        reader.readAsText(file, 'UTF-8');
      } else {
        const reader = new FileReader();
        reader.onload = e => importParseXLSX(e.target.result, file.name);
        reader.readAsArrayBuffer(file);
      }
    }

    function importParseCSV(text, filename) {
      const lines = text.split(/\r?\n/).filter(l => l.trim());
      if (lines.length < 2) { alert('Arquivo CSV vazio ou sem dados.'); return; }
      const sep = lines[0].includes(';') ? ';' : ',';
      const headers = lines[0].split(sep).map(h => h.replace(/^["']|["']$/g,'').trim());
      const keyMap = {};
      headers.forEach((h, i) => {
        const mapped = HEADER_MAP[importNormKey(h)];
        if (mapped) keyMap[i] = mapped;
      });
      const rows = [];
      for (let i = 1; i < lines.length; i++) {
        const cells = lines[i].split(sep).map(c => c.replace(/^["']|["']$/g,'').trim());
        const obj = {};
        Object.entries(keyMap).forEach(([idx, key]) => { obj[key] = cells[idx] || ''; });
        if (Object.values(obj).some(v => v)) rows.push(obj);
      }
      importProcessRows(rows, filename);
    }

    function importParseXLSX(buffer, filename) {
      if (typeof XLSX === 'undefined') {
        alert('Biblioteca XLSX não carregada. Tente usar CSV.');
        return;
      }
      const wb = XLSX.read(buffer, { type: 'array', cellDates: false });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
      if (data.length < 2) { alert('Planilha vazia ou sem dados.'); return; }
      const headers = data[0].map(h => h.toString().trim());
      const keyMap = {};
      headers.forEach((h, i) => {
        const mapped = HEADER_MAP[importNormKey(h)];
        if (mapped) keyMap[i] = mapped;
      });
      const rows = [];
      for (let i = 1; i < data.length; i++) {
        const obj = {};
        Object.entries(keyMap).forEach(([idx, key]) => { obj[key] = data[i][idx] !== undefined ? data[i][idx].toString().trim() : ''; });
        if (Object.values(obj).some(v => v)) rows.push(obj);
      }
      importProcessRows(rows, filename);
    }

    function importProcessRows(rows, filename) {
      const errors = [];
      const processed = rows.map((row, i) => {
        const rowErrors = [];
        const num = i + 2; // linha real na planilha (1=header)

        // Campos obrigatórios
        IMPORT_COLS.filter(c => c.required).forEach(col => {
          if (!row[col.key] || !row[col.key].toString().trim()) {
            rowErrors.push(`Linha ${num}: ${col.label} é obrigatório`);
          }
        });

        // Validação CPF
        if (row.cpf) {
          row.cpf = importFormatCPF(row.cpf.toString());
          if (!importValidateCPF(row.cpf)) {
            rowErrors.push(`Linha ${num}: CPF inválido (${row.cpf})`);
          }
        }

        // Formatar datas
        if (row.nascimento) row.nascimento = importFormatDate(row.nascimento);
        if (row.contratacao) {
          row.contratacao = importFormatDate(row.contratacao);
          if (!importValidateDate(row.contratacao)) {
            rowErrors.push(`Linha ${num}: Data de contratação inválida`);
          }
        }

        const status = rowErrors.length > 0 ? 'err' : 'ok';
        if (rowErrors.length) errors.push(...rowErrors);
        return { ...row, _status: status, _errors: rowErrors, _line: num };
      });

      importedRows = processed;
      importRenderPreview(processed, errors, filename);
    }

    function importRenderPreview(rows, errors, filename) {
      const total   = rows.length;
      const okCount = rows.filter(r => r._status === 'ok').length;
      const errCount = rows.filter(r => r._status === 'err').length;

      // Títulos
      document.getElementById('importPreviewTitle').textContent = `Prévia — ${filename}`;
      document.getElementById('importPreviewSub').textContent =
        `${total} funcionário${total !== 1 ? 's' : ''} encontrado${total !== 1 ? 's' : ''}. Verifique os dados antes de confirmar.`;

      // Resumo
      document.getElementById('importSummary').innerHTML = `
        <div class="import-stat"><span>Total de linhas</span><strong>${total}</strong></div>
        <div class="import-stat ok"><span>Válidos</span><strong>${okCount}</strong></div>
        <div class="import-stat err"><span>Com erro</span><strong>${errCount}</strong></div>
        <div class="import-stat"><span>Arquivo</span><strong style="font-size:13px;margin-top:8px">${filename}</strong></div>
      `;

      // Erros
      const errBox = document.getElementById('importErrorsBox');
      if (errors.length > 0) {
        errBox.style.display = 'block';
        errBox.innerHTML = `
          <div class="import-error-list">
            <strong><span class="material-symbols-outlined" style="font-size:16px;vertical-align:-3px">error</span>
            ${errors.length} problema${errors.length !== 1 ? 's' : ''} encontrado${errors.length !== 1 ? 's' : ''}</strong>
            ${errors.map(e => `<div class="import-error-item">
              <span class="material-symbols-outlined" style="font-size:14px;color:#FF3B30;flex-shrink:0">arrow_right</span>${e}
            </div>`).join('')}
          </div>`;
      } else {
        errBox.style.display = 'none';
      }

      // Tabela
      const tbody = document.getElementById('importPreviewBody');
      tbody.innerHTML = rows.map((row, i) => `
        <tr class="import-row-${row._status}">
          <td>${i + 1}</td>
          <td><strong>${row.nome || '—'}</strong></td>
          <td>${row.setor || '—'}</td>
          <td>${row.telefone || '—'}</td>
          <td>${row.cpf || '—'}</td>
          <td>${row.matricula || '—'}</td>
          <td>${row.nascimento || '—'}</td>
          <td>${row.contratacao || '—'}</td>
          <td>${row.cargo || '—'}</td>
          <td><span class="import-row-badge ${row._status}">${row._status === 'ok' ? 'Válido' : 'Erro'}</span></td>
        </tr>`).join('');

      // Desabilita confirmar se há erros
      const confirmBtn = document.getElementById('importConfirmBtn');
      if (errCount > 0) {
        confirmBtn.disabled = true;
        confirmBtn.style.opacity = '0.5';
        confirmBtn.title = `Corrija os ${errCount} erro(s) na planilha antes de importar`;
      } else {
        confirmBtn.disabled = false;
        confirmBtn.style.opacity = '1';
        confirmBtn.title = '';
      }

      document.getElementById('importUploadCard').style.display = 'none';
      document.getElementById('importPreviewCard').style.display = 'block';
      document.getElementById('importResultCard').style.display = 'none';
    }

    function importConfirm() {
      const valid = importedRows.filter(r => r._status === 'ok');
      // Aqui seria a integração com API/banco. Por ora, simula sucesso.
      document.getElementById('importPreviewCard').style.display = 'none';
      document.getElementById('importResultCard').style.display = 'block';
      document.getElementById('importResultSummary').innerHTML = `
        <div class="import-result-grid">
          <div class="import-stat ok">
            <span>Importados com sucesso</span>
            <strong>${valid.length}</strong>
          </div>
          <div class="import-stat">
            <span>Já existiam no sistema</span>
            <strong>0</strong>
          </div>
          <div class="import-stat">
            <span>Data da importação</span>
            <strong style="font-size:14px;margin-top:8px">${new Date().toLocaleDateString('pt-BR')} às ${new Date().toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'})}</strong>
          </div>
        </div>
        <div class="notice" style="margin-top:14px;background:rgba(52,199,89,0.08);color:#1A7A35;border-color:rgba(52,199,89,0.2)">
          <strong>${valid.length} funcionário${valid.length !== 1 ? 's' : ''} cadastrado${valid.length !== 1 ? 's' : ''} com sucesso.</strong>
          Eles já estão disponíveis em Administração de Usuários e Histórico de Funcionários.
        </div>`;
    }

    function importReset() {
      importedRows = [];
      document.getElementById('importFileInput').value = '';
      document.getElementById('importUploadCard').style.display = 'block';
      document.getElementById('importPreviewCard').style.display = 'none';
      document.getElementById('importResultCard').style.display = 'none';
    }

    function importDownloadTemplate() {
      // Gera CSV modelo para download
      const header = 'Nome,Setor,Telefone,CPF,Matrícula,Nascimento,Contratação,Cargo';
      const example = [
        'João Pereira,Produção,(47) 99999-0001,123.456.789-09,MAT-000001,15/03/1990,01/06/2020,Operador de Produção',
        'Ana Souza,Qualidade,(47) 99999-0002,987.654.321-00,MAT-000002,22/07/1985,10/01/2019,Analista de Qualidade',
        'Marcos Silva,Manutenção,(47) 99999-0003,456.789.123-87,MAT-000003,08/11/1992,15/08/2021,Mecânico de Manutenção',
      ];
      const csv = [header, ...example].join('\n');
      const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'modelo_funcionarios.csv';
      document.body.appendChild(a); a.click();
      document.body.removeChild(a); URL.revokeObjectURL(url);
    }


    /* ── REGRAS POR FUNÇÃO / SETOR / PGR ── */

    let rulesData = [
      { id: 1, setor: 'Produção',   funcao: 'Operador',  epis: 'Protetor auricular · Óculos de proteção', criterio: 'Exposição a ruído e partículas',        origem: 'PGR / Matriz de risco' },
      { id: 2, setor: 'Manutenção', funcao: 'Mecânico',  epis: 'Botina · Luva · Óculos',                  criterio: 'Risco mecânico e circulação em área fabril', origem: 'PGR / APR' },
      { id: 3, setor: 'Expedição',  funcao: 'Auxiliar',  epis: 'Uniforme operacional · Botina',           criterio: 'Movimentação e rotina operacional',     origem: 'Procedimento interno' },
    ];
    let rulesNextId = 4;
    let ruleDeleteTarget = null;

    function rulesRender(data) {
      const tbody = document.getElementById('rulesTableBody');
      if (!tbody) return;
      const countEl = document.getElementById('rulesCount');
      if (countEl) countEl.textContent = data.length + ' regra' + (data.length !== 1 ? 's' : '');

      if (data.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--on-surface-variant);padding:32px">Nenhuma regra encontrada.</td></tr>';
        return;
      }

      tbody.innerHTML = data.map(r => {
        const epiTags = r.epis.split(/[·,]/).map(e => e.trim()).filter(Boolean)
          .map(e => `<span class="rule-epi-tag">${e}</span>`).join('');
        const origemTag = r.origem ? `<span class="rule-origem-tag"><span class="material-symbols-outlined" style="font-size:13px">gavel</span>${r.origem}</span>` : '—';
        return `
          <tr data-rule-id="${r.id}">
            <td><strong>${r.setor}</strong></td>
            <td>${r.funcao}</td>
            <td style="min-width:200px">${epiTags}</td>
            <td style="font-size:13px;color:var(--on-surface-variant)">${r.criterio || '—'}</td>
            <td>${origemTag}</td>
            <td>
              <div class="inline-actions">
                ${canDo('rules:edit') ? `<button class="mini-btn" type="button" onclick="editRule(${r.id})"><span class="material-symbols-outlined" style="font-size:14px;vertical-align:-2px">edit</span> Editar</button>` : ''}
                ${canDo('rules:delete') ? `<button class="mini-btn" type="button" style="color:var(--error);border-color:rgba(255,59,48,0.25)" onclick="deleteRulePrompt(${r.id})"><span class="material-symbols-outlined" style="font-size:14px;vertical-align:-2px">delete</span> Excluir</button>` : ''}
                ${(!canDo('rules:edit') && !canDo('rules:delete')) ? '<span style="font-size:12px;color:var(--on-surface-variant)">Somente leitura</span>' : ''}
              </div>
            </td>
          </tr>`;
      }).join('');
    }

    function rulesFilter() {
      const q = (document.getElementById('rulesSearch')?.value || '').toLowerCase().trim();
      const filtered = q ? rulesData.filter(r =>
        r.setor.toLowerCase().includes(q) ||
        r.funcao.toLowerCase().includes(q) ||
        r.epis.toLowerCase().includes(q) ||
        (r.criterio || '').toLowerCase().includes(q) ||
        (r.origem || '').toLowerCase().includes(q)
      ) : rulesData;
      rulesRender(filtered);
    }

    function openRuleModal(rule) {
      document.getElementById('ruleEditId').value  = rule ? rule.id : '';
      document.getElementById('ruleModalTitle').textContent = rule ? 'Editar regra' : 'Nova regra';
      document.getElementById('ruleSetor').value    = rule ? rule.setor    : '';
      document.getElementById('ruleFuncao').value   = rule ? rule.funcao   : '';
      document.getElementById('ruleEpis').value     = rule ? rule.epis     : '';
      document.getElementById('ruleCriterio').value = rule ? rule.criterio : '';
      document.getElementById('ruleOrigem').value   = rule ? rule.origem   : '';
      document.getElementById('ruleModal').classList.add('open');
    }

    function closeRuleModal(event) {
      if (event && event.target && event.target.id !== 'ruleModal') return;
      document.getElementById('ruleModal').classList.remove('open');
    }

    function saveRule() {
      const setor   = document.getElementById('ruleSetor').value.trim();
      const funcao  = document.getElementById('ruleFuncao').value.trim();
      const epis    = document.getElementById('ruleEpis').value.trim();
      const crit    = document.getElementById('ruleCriterio').value.trim();
      const origem  = document.getElementById('ruleOrigem').value.trim();

      if (!setor || !funcao || !epis) {
        alert('Preencha os campos obrigatórios: Setor, Função e EPIs.');
        return;
      }

      const editId = document.getElementById('ruleEditId').value;
      if (editId) {
        const idx = rulesData.findIndex(r => r.id == editId);
        if (idx >= 0) rulesData[idx] = { id: Number(editId), setor, funcao, epis, criterio: crit, origem };
      } else {
        rulesData.push({ id: rulesNextId++, setor, funcao, epis, criterio: crit, origem });
      }

      closeRuleModal();
      rulesFilter();
    }

    function editRule(id) {
      const rule = rulesData.find(r => r.id === id);
      if (rule) openRuleModal(rule);
    }

    function deleteRulePrompt(id) {
      const rule = rulesData.find(r => r.id === id);
      if (!rule) return;
      ruleDeleteTarget = id;
      document.getElementById('ruleDeleteId').value = id;
      document.getElementById('ruleDeleteDesc').textContent =
        `Excluir regra: ${rule.funcao} — ${rule.setor}?`;
      document.getElementById('ruleDeleteModal').classList.add('open');
    }

    function closeRuleDeleteModal(event) {
      if (event && event.target && event.target.id !== 'ruleDeleteModal') return;
      document.getElementById('ruleDeleteModal').classList.remove('open');
      ruleDeleteTarget = null;
    }

    function confirmDeleteRule() {
      if (ruleDeleteTarget == null) return;
      rulesData = rulesData.filter(r => r.id !== ruleDeleteTarget);
      closeRuleDeleteModal();
      rulesFilter();
    }

    // Inicializa tabela quando a view é aberta



    /* ── PERMISSÕES DE AÇÃO ── */
    function toggleActionPerm(btn) {
      if (btn.dataset.role === 'Master') return;
      if (currentMenuPreviewRole !== 'Master') {
        alert('Apenas o perfil Master pode alterar as permissões de ação.');
        btn.classList.toggle('active'); // revert visual
        btn.classList.toggle('active');
        return;
      }
      btn.classList.toggle('active');
      var role   = btn.dataset.role;
      var action = btn.dataset.action;
      var blocked = blockedActions[role] || [];
      // Switch ATIVO = permitido = NÃO bloqueado
      // Switch INATIVO = bloqueado
      if (btn.classList.contains('active')) {
        // Remove do bloqueio
        var i = blocked.indexOf(action);
        if (i >= 0) blocked.splice(i, 1);
      } else {
        // Adiciona ao bloqueio
        if (!blocked.includes(action)) blocked.push(action);
      }
      blockedActions[role] = blocked;
      applyActionPermissions();
    }

    function saveActionPerms() {
      if (currentMenuPreviewRole !== 'Master') {
        alert('Apenas o perfil Master pode salvar as permissões de ação.');
        return;
      }
      // Sincroniza estado visual com blockedActions
      document.querySelectorAll('[data-action][data-role]').forEach(function(btn) {
        if (btn.dataset.role === 'Master') { btn.classList.add('active'); return; }
        var blocked = blockedActions[btn.dataset.role] || [];
        btn.classList.toggle('active', !blocked.includes(btn.dataset.action));
      });
      applyActionPermissions();
      var saveBtn = document.querySelector('[onclick="saveActionPerms()"]');
      if (saveBtn) {
        var orig = saveBtn.innerHTML;
        saveBtn.innerHTML = '<span class="material-symbols-outlined">check_circle</span>Salvo!';
        saveBtn.style.background = '#34C759';
        setTimeout(function() { saveBtn.innerHTML = orig; saveBtn.style.background = ''; }, 2000);
      }
    }

    // Sincroniza switches da tela com actionPermissions ao abrir a view
    


    /* ── LGPD / PRIVACIDADE JS ── */

    function checkCaValidity(dateVal) {
      const helper = document.getElementById('caValidityHelper');
      if (!helper || !dateVal) return;
      const chosen = new Date(dateVal);
      const today  = new Date();
      today.setHours(0,0,0,0);
      const diff = Math.ceil((chosen - today) / (1000 * 60 * 60 * 24));
      if (diff < 0) {
        helper.textContent = '⚠ CA vencido há ' + Math.abs(diff) + ' dias — não será possível entregar este EPI (NR-06).';
        helper.style.color = 'var(--error)';
      } else if (diff <= 30) {
        helper.textContent = '⚠ CA vence em ' + diff + ' dias — atenção ao prazo de validade.';
        helper.style.color = 'var(--warning)';
      } else {
        helper.textContent = '✓ CA válido por mais ' + diff + ' dias.';
        helper.style.color = 'var(--success)';
      }
    }

    function toggleDpoEdit() {
      var d = document.getElementById('dpoDisplay');
      var f = document.getElementById('dpoEditForm');
      var showing = f.style.display !== 'none';
      f.style.display = showing ? 'none' : 'block';
      d.style.display = showing ? 'block' : 'none';
      if (!showing) {
        document.getElementById('dpoNomeInput').value    = document.getElementById('dpoNome').textContent.replace('A definir','');
        document.getElementById('dpoEmailInput').value   = document.getElementById('dpoEmail').textContent.replace('A definir','');
        document.getElementById('dpoTelInput').value     = document.getElementById('dpoTel').textContent.replace('A definir','');
        document.getElementById('dpoEmpresaInput').value = document.getElementById('dpoEmpresa').textContent.replace('A definir','');
      }
    }

    function saveDpo() {
      document.getElementById('dpoNome').textContent    = document.getElementById('dpoNomeInput').value    || 'A definir';
      document.getElementById('dpoEmail').textContent   = document.getElementById('dpoEmailInput').value   || 'A definir';
      document.getElementById('dpoTel').textContent     = document.getElementById('dpoTelInput').value     || 'A definir';
      document.getElementById('dpoEmpresa').textContent = document.getElementById('dpoEmpresaInput').value || 'A definir';
      toggleDpoEdit();
    }

    function openTitularModal() {
      document.getElementById('titularNome').value      = '';
      document.getElementById('titularMatricula').value = '';
      document.getElementById('titularDireito').value   = '';
      document.getElementById('titularDesc').value      = '';
      document.getElementById('titularModal').classList.add('open');
    }

    function closeTitularModal(event) {
      if (event && event.target && event.target.id !== 'titularModal') return;
      document.getElementById('titularModal').classList.remove('open');
    }

    var titularRequests = [];
    function saveTitularRequest() {
      var nome     = document.getElementById('titularNome').value.trim();
      var mat      = document.getElementById('titularMatricula').value.trim();
      var direito  = document.getElementById('titularDireito').value;
      var desc     = document.getElementById('titularDesc').value.trim();
      if (!nome || !mat || !direito) { alert('Preencha os campos obrigatórios.'); return; }
      var req = { nome, mat, direito, desc,
        data: new Date().toLocaleDateString('pt-BR') + ' às ' + new Date().toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'}),
        prazo: new Date(Date.now() + 15*24*60*60*1000).toLocaleDateString('pt-BR'),
        status: 'Aberta'
      };
      titularRequests.unshift(req);
      renderTitularRequests();
      closeTitularModal();
    }

    function renderTitularRequests() {
      var el = document.getElementById('titularRequestList');
      if (!el) return;
      if (!titularRequests.length) {
        el.innerHTML = '<div style="font-size:13px;color:var(--on-surface-variant);text-align:center;padding:16px">Nenhuma solicitação registrada.</div>';
        return;
      }
      el.innerHTML = titularRequests.map(function(r) {
        return '<div class="request-item" style="margin-bottom:8px">' +
          '<div class="request-meta"><strong>' + r.nome + ' · ' + r.mat + '</strong>' +
          '<span>' + r.direito + '</span>' +
          '<span>Aberta em ' + r.data + ' · Prazo: ' + r.prazo + '</span></div>' +
          '<span class="badge status-active">' + r.status + '</span></div>';
      }).join('');
    }

    function createUserWithConsent() {
      var consent = document.getElementById('lgpdConsentNewUser');
      if (consent && !consent.checked) {
        alert('É necessário confirmar que o funcionário foi informado sobre a Política de Privacidade (LGPD) para prosseguir.');
        consent.focus();
        return;
      }
      alert('Usuário criado com registro de ciência LGPD. (Integração com backend pendente)');
    }

    // Bloqueia importação sem consentimento LGPD
    var _origImportConfirm = importConfirm;
    importConfirm = function() {
      var consent = document.getElementById('lgpdConsentImport');
      if (consent && !consent.checked) {
        alert('É necessário confirmar que os funcionários foram informados sobre a Política de Privacidade (LGPD) para confirmar a importação.');
        consent.focus();
        return;
      }
      _origImportConfirm();
    };


    /* ── GESTÃO DE E-MAILS JS ── */

    var emailTemplates = [
      { id: 1, tipo: 'boas-vindas',      icon: 'waving_hand',        color: '#007AFF', bg: 'rgba(0,122,255,0.10)',    nome: 'Boas-vindas',           desc: 'Enviado ao novo colaborador no cadastro. Contém link de acesso, instrução de uso e política de EPIs.',          ativo: true,  total: 24, ultima: '19/04/2026 às 08:41' },
      { id: 2, tipo: 'alerta-vencimento',icon: 'alarm',              color: '#FF9500', bg: 'rgba(255,149,0,0.10)',    nome: 'Alerta de vencimento',  desc: 'Enviado 30 dias antes do vencimento de uso do EPI. Destino: SST, liderança e RH.',                              ativo: true,  total: 8,  ultima: '18/04/2026 às 07:00' },
      { id: 3, tipo: 'alerta-troca',     icon: 'published_with_changes',color:'#FF3B30',bg:'rgba(255,59,48,0.10)',   nome: 'Troca imediata',        desc: 'EPI com prazo de uso vencido. Alerta crítico para SST e responsável direto.',                                    ativo: true,  total: 3,  ultima: '17/04/2026 às 14:22' },
      { id: 4, tipo: 'aprovacao',        icon: 'check_circle',       color: '#34C759', bg: 'rgba(52,199,89,0.10)',    nome: 'Aprovação de pedido',   desc: 'Confirmação ao colaborador quando o pedido de EPI é aprovado pelo supervisor.',                                  ativo: true,  total: 31, ultima: '19/04/2026 às 09:10' },
      { id: 5, tipo: 'entrega',          icon: 'inventory',          color: '#5AC8FA', bg: 'rgba(90,200,250,0.10)',   nome: 'Confirmação de entrega',desc: 'Enviado ao colaborador e SST após registro da entrega do EPI com número da ficha.',                              ativo: true,  total: 29, ultima: '19/04/2026 às 10:05' },
      { id: 6, tipo: 'estoque',          icon: 'inventory_2',        color: '#5856D6', bg: 'rgba(88,86,214,0.10)',    nome: 'Estoque mínimo',        desc: 'Alerta para compras/almoxarifado quando item atinge ou fica abaixo do estoque mínimo definido.',                 ativo: true,  total: 5,  ultima: '16/04/2026 às 11:30' },
      { id: 7, tipo: 'ca-vencendo',      icon: 'gpp_bad',            color: '#FF3B30', bg: 'rgba(255,59,48,0.10)',    nome: 'CA a vencer',           desc: 'Aviso 60 dias antes do vencimento do Certificado de Aprovação de um EPI em estoque (NR-06).',                    ativo: true,  total: 2,  ultima: '15/04/2026 às 08:00' },
      { id: 8, tipo: 'reprovacao',       icon: 'cancel',             color: '#FF9500', bg: 'rgba(255,149,0,0.10)',    nome: 'Reprovação de pedido',  desc: 'Informa ao colaborador que o pedido foi reprovado pelo supervisor, com o motivo registrado.',                     ativo: false, total: 1,  ultima: '14/04/2026 às 15:18' },
    ];

    var emailHistorico = [
      { id: 1,  dt: '19/04/2026 09:10', tipo: 'aprovacao',        dest: 'João Pereira',    email: 'joao@empresa.com',          assunto: 'Pedido de EPI aprovado',                ref: 'PED-0041',  status: 'enviado'  },
      { id: 2,  dt: '19/04/2026 08:41', tipo: 'boas-vindas',      dest: 'Carlos Mendes',   email: 'carlos@empresa.com',         assunto: 'Bem-vindo ao Gestão de EPIs',           ref: 'USR-0024',  status: 'enviado'  },
      { id: 3,  dt: '19/04/2026 08:41', tipo: 'boas-vindas',      dest: 'Fernanda Lima',   email: 'fernanda@empresa.com',       assunto: 'Bem-vindo ao Gestão de EPIs',           ref: 'USR-0025',  status: 'enviado'  },
      { id: 4,  dt: '19/04/2026 07:00', tipo: 'alerta-vencimento',dest: 'SST',             email: 'sst@empresa.com',            assunto: 'Alerta: 3 EPIs próximos do vencimento', ref: 'AUTO-007',  status: 'enviado'  },
      { id: 5,  dt: '19/04/2026 07:00', tipo: 'alerta-vencimento',dest: 'Luis Freitas',    email: 'luis@empresa.com',           assunto: 'Alerta: 3 EPIs próximos do vencimento', ref: 'AUTO-007',  status: 'enviado'  },
      { id: 6,  dt: '18/04/2026 16:50', tipo: 'estoque',          dest: 'Almoxarifado',    email: 'almoxarifado@empresa.com',   assunto: 'Estoque mínimo atingido: Botina nº40',  ref: 'EST-014',   status: 'falha'    },
      { id: 7,  dt: '18/04/2026 14:22', tipo: 'alerta-troca',     dest: 'SST',             email: 'sst@empresa.com',            assunto: 'URGENTE: Troca imediata — Marcos Silva',ref: 'AUTO-006',  status: 'enviado'  },
      { id: 8,  dt: '18/04/2026 14:22', tipo: 'alerta-troca',     dest: 'Liderança',       email: 'lideranca@empresa.com',      assunto: 'URGENTE: Troca imediata — Marcos Silva',ref: 'AUTO-006',  status: 'enviado'  },
      { id: 9,  dt: '18/04/2026 09:05', tipo: 'aprovacao',        dest: 'Ana Souza',       email: 'ana@empresa.com',            assunto: 'Pedido de EPI aprovado',                ref: 'PED-0040',  status: 'enviado'  },
      { id: 10, dt: '17/04/2026 10:30', tipo: 'entrega',          dest: 'Marcos Silva',    email: 'marcos@empresa.com',         assunto: 'EPI entregue — Ficha #0171',            ref: 'FIC-0171',  status: 'enviado'  },
      { id: 11, dt: '16/04/2026 11:30', tipo: 'estoque',          dest: 'Compras',         email: 'compras@empresa.com',        assunto: 'Estoque mínimo: Luva nitrílica',        ref: 'EST-013',   status: 'enviado'  },
      { id: 12, dt: '15/04/2026 08:00', tipo: 'ca-vencendo',      dest: 'SST',             email: 'sst@empresa.com',            assunto: 'CA a vencer: Protetor auricular',       ref: 'CA-0055',   status: 'enviado'  },
      { id: 13, dt: '14/04/2026 15:18', tipo: 'reprovacao',       dest: 'Pedro Alves',     email: 'pedro@empresa.com',          assunto: 'Pedido de EPI reprovado',               ref: 'PED-0039',  status: 'enviado'  },
      { id: 14, dt: '14/04/2026 07:00', tipo: 'alerta-vencimento',dest: 'SST',             email: 'sst@empresa.com',            assunto: 'Alerta: 2 EPIs próximos do vencimento', ref: 'AUTO-005',  status: 'falha'    },
    ];

    var destinatarios = [
      { id: 1, nome: 'Luis Freitas',   email: 'luis@empresa.com',          cargo: 'Master / SST',       tipos: ['boas-vindas','alerta-vencimento','alerta-troca','aprovacao','entrega','estoque','ca-vencendo'], status: 'ativo'  },
      { id: 2, nome: 'SST',            email: 'sst@empresa.com',            cargo: 'Segurança do Trabalho',tipos: ['alerta-vencimento','alerta-troca','entrega','ca-vencendo','estoque'],                        status: 'ativo'  },
      { id: 3, nome: 'Almoxarifado',   email: 'almoxarifado@empresa.com',   cargo: 'Almoxarifado',       tipos: ['estoque','alerta-vencimento'],                                                                status: 'ativo'  },
      { id: 4, nome: 'Liderança',      email: 'lideranca@empresa.com',      cargo: 'Liderança Produção',  tipos: ['alerta-troca','aprovacao'],                                                                  status: 'ativo'  },
      { id: 5, nome: 'Compras',        email: 'compras@empresa.com',        cargo: 'Compras',            tipos: ['estoque','ca-vencendo'],                                                                       status: 'ativo'  },
      { id: 6, nome: 'RH',             email: 'rh@empresa.com',             cargo: 'Recursos Humanos',   tipos: ['boas-vindas','reprovacao'],                                                                   status: 'inativo'},
    ];
    var destNextId = 7;

    var EMAIL_TYPE_LABELS = {
      'boas-vindas': 'Boas-vindas', 'alerta-vencimento': 'Alerta vencimento',
      'alerta-troca': 'Troca imediata', 'aprovacao': 'Aprovação',
      'reprovacao': 'Reprovação', 'entrega': 'Confirmação entrega',
      'estoque': 'Estoque mínimo', 'ca-vencendo': 'CA a vencer'
    };

    function emailRenderTemplates() {
      var el = document.getElementById('emailTemplatesGrid');
      if (!el) return;
      el.innerHTML = emailTemplates.map(function(t) {
        return '<div class="email-template-card' + (t.ativo ? '' : ' inactive') + '" onclick="emailToggleTemplate(' + t.id + ')">' +
          '<div class="email-template-top">' +
            '<div class="email-template-icon" style="background:' + t.bg + ';color:' + t.color + '">' + t.icon + '</div>' +
            '<div style="flex:1;min-width:0">' +
              '<div class="email-template-name">' + t.nome + '</div>' +
            '</div>' +
            '<button class="switch ' + (t.ativo ? 'active' : '') + '" type="button" onclick="event.stopPropagation();emailToggleTemplate(' + t.id + ')"></button>' +
          '</div>' +
          '<div class="email-template-desc">' + t.desc + '</div>' +
          '<div class="email-template-meta">' +
            '<span style="font-size:11px;color:var(--on-surface-variant)">' + t.total + ' enviados · último ' + t.ultima + '</span>' +
          '</div>' +
        '</div>';
      }).join('');
      document.getElementById('emailKpiTemplates').textContent = emailTemplates.filter(function(t){return t.ativo;}).length;
    }

    function emailToggleTemplate(id) {
      var t = emailTemplates.find(function(x){return x.id===id;});
      if (!t) return;
      t.ativo = !t.ativo;
      emailRenderTemplates();
    }

    function emailRenderHistorico(data) {
      var body = document.getElementById('emailHistoricoBody');
      var count = document.getElementById('emailHistoricoCount');
      if (!body) return;
      if (count) count.textContent = data.length + ' registro' + (data.length!==1?'s':'') + ' encontrado' + (data.length!==1?'s':'');
      if (!data.length) {
        body.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--on-surface-variant);padding:32px">Nenhum e-mail encontrado.</td></tr>';
        return;
      }
      body.innerHTML = data.map(function(e) {
        var statusCls = 'email-status-' + e.status;
        var statusLabel = {enviado:'Enviado',falha:'Falha',pendente:'Pendente',cancelado:'Cancelado'}[e.status] || e.status;
        var tipoBadge = EMAIL_TYPE_LABELS[e.tipo] || e.tipo;
        return '<tr>' +
          '<td style="white-space:nowrap;font-size:12px">' + e.dt + '</td>' +
          '<td><span class="badge" style="background:var(--primary-container);color:var(--primary);font-size:10px">' + tipoBadge + '</span></td>' +
          '<td><strong style="font-size:13px">' + e.dest + '</strong><br><span style="font-size:11px;color:var(--on-surface-variant)">' + e.email + '</span></td>' +
          '<td style="font-size:13px">' + e.assunto + '</td>' +
          '<td><span class="badge role-user" style="font-size:10px">' + e.ref + '</span></td>' +
          '<td><span class="email-status-badge ' + statusCls + '">' + statusLabel + '</span></td>' +
          '<td><div class="inline-actions">' +
            '<button class="mini-btn" type="button">Ver</button>' +
            (e.status === 'falha' ? '<button class="mini-btn" type="button" style="color:var(--primary)">Reenviar</button>' : '') +
          '</div></td>' +
        '</tr>';
      }).join('');
    }

    function emailRenderDestinatarios() {
      var body = document.getElementById('destinatariosBody');
      if (!body) return;
      document.getElementById('emailKpiDestinatarios').textContent = destinatarios.filter(function(d){return d.status==='ativo';}).length;
      body.innerHTML = destinatarios.map(function(d) {
        var tags = d.tipos.slice(0,3).map(function(t){ return '<span class="badge" style="background:var(--primary-container);color:var(--primary);font-size:10px;margin:1px">' + (EMAIL_TYPE_LABELS[t]||t) + '</span>'; }).join('') +
          (d.tipos.length > 3 ? '<span style="font-size:11px;color:var(--on-surface-variant)"> +' + (d.tipos.length-3) + '</span>' : '');
        return '<tr>' +
          '<td><strong>' + d.nome + '</strong></td>' +
          '<td style="font-size:13px">' + d.email + '</td>' +
          '<td style="font-size:13px">' + d.cargo + '</td>' +
          '<td>' + tags + '</td>' +
          '<td><span class="badge ' + (d.status==='ativo'?'status-active':'status-inactive') + '">' + (d.status==='ativo'?'Ativo':'Inativo') + '</span></td>' +
          '<td><div class="inline-actions">' +
            '<button class="mini-btn" onclick="editDestinatario(' + d.id + ')">Editar</button>' +
            '<button class="mini-btn" onclick="toggleDestinatario(' + d.id + ')" style="color:' + (d.status==='ativo'?'var(--error)':'var(--primary)') + '">' + (d.status==='ativo'?'Desativar':'Ativar') + '</button>' +
          '</div></td>' +
        '</tr>';
      }).join('');
    }

    function emailApplyFilters() {
      var tipo   = (document.getElementById('emailFilterType')?.value   || '').toLowerCase();
      var status = (document.getElementById('emailFilterStatus')?.value || '').toLowerCase();
      var dest   = (document.getElementById('emailFilterDest')?.value   || '').toLowerCase().trim();
      var data   = (document.getElementById('emailFilterData')?.value   || '');
      var filtered = emailHistorico.filter(function(e) {
        if (tipo   && e.tipo !== tipo)   return false;
        if (status && e.status !== status) return false;
        if (dest   && !e.dest.toLowerCase().includes(dest) && !e.email.toLowerCase().includes(dest)) return false;
        if (data) {
          var parts = data.split('-');
          var dtFormatted = parts[2]+'/'+parts[1]+'/'+parts[0];
          if (!e.dt.startsWith(dtFormatted)) return false;
        }
        return true;
      });
      emailRenderHistorico(filtered);
    }

    function emailClearFilters() {
      ['emailFilterType','emailFilterStatus','emailFilterDest','emailFilterData'].forEach(function(id){
        var el = document.getElementById(id);
        if (el) el.value = '';
      });
      emailRenderHistorico(emailHistorico);
    }

    function emailExport() {
      var header = 'Data/Hora,Tipo,Destinatário,E-mail,Assunto,Referência,Status';
      var rows = emailHistorico.map(function(e){
        return [e.dt,e.tipo,e.dest,e.email,e.assunto,e.ref,e.status].join(',');
      });
      var csv = [header,...rows].join('\n');
      var blob = new Blob(['\uFEFF'+csv],{type:'text/csv;charset=utf-8;'});
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href=url; a.download='historico_emails.csv';
      document.body.appendChild(a); a.click();
      document.body.removeChild(a); URL.revokeObjectURL(url);
    }

    function openDestinatarioModal(dest) {
      document.getElementById('destinatarioEditId').value = dest ? dest.id : '';
      document.getElementById('destinatarioModalTitle').textContent = dest ? 'Editar destinatário' : 'Adicionar destinatário';
      document.getElementById('destNome').value   = dest ? dest.nome  : '';
      document.getElementById('destEmail').value  = dest ? dest.email : '';
      document.getElementById('destCargo').value  = dest ? dest.cargo : '';
      document.getElementById('destStatus').value = dest ? dest.status: 'ativo';
      document.querySelectorAll('#destTiposCheckboxes input[type=checkbox]').forEach(function(cb){
        cb.checked = dest ? dest.tipos.includes(cb.value) : false;
      });
      document.getElementById('destinatarioModal').classList.add('open');
    }
    function closeDestinatarioModal(event) {
      if (event && event.target && event.target.id !== 'destinatarioModal') return;
      document.getElementById('destinatarioModal').classList.remove('open');
    }
    function saveDestinatario() {
      var nome  = document.getElementById('destNome').value.trim();
      var email = document.getElementById('destEmail').value.trim();
      if (!nome || !email) { alert('Preencha Nome e E-mail.'); return; }
      var tipos = Array.from(document.querySelectorAll('#destTiposCheckboxes input:checked')).map(function(c){return c.value;});
      var status = document.getElementById('destStatus').value;
      var editId = document.getElementById('destinatarioEditId').value;
      var cargo = document.getElementById('destCargo').value.trim();
      if (editId) {
        var idx = destinatarios.findIndex(function(d){return d.id==editId;});
        if (idx>=0) destinatarios[idx] = {id:Number(editId),nome,email,cargo,tipos,status};
      } else {
        destinatarios.push({id:destNextId++,nome,email,cargo,tipos,status});
      }
      closeDestinatarioModal();
      emailRenderDestinatarios();
    }
    function editDestinatario(id) {
      openDestinatarioModal(destinatarios.find(function(d){return d.id===id;}));
    }
    function toggleDestinatario(id) {
      var d = destinatarios.find(function(x){return x.id===id;});
      if (d) { d.status = d.status==='ativo'?'inativo':'ativo'; emailRenderDestinatarios(); }
    }
    function openNewEmailTemplateModal() { document.getElementById('newEmailTemplateModal').classList.add('open'); }

    // Init ao abrir a view
    


    /* ═══════════════════════════════════════════════════════════════════
       CORREÇÕES E FUNCIONALIDADES — batch fix
    ═══════════════════════════════════════════════════════════════════ */

    /* ── UTILITÁRIOS ── */
    function showToast(msg, type) {
      var t = document.createElement('div');
      var colors = {success:'#34C759',error:'#FF3B30',warning:'#FF9500',info:'#007AFF'};
      t.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:' +
        (colors[type]||colors.info) + ';color:#fff;padding:10px 20px;border-radius:99px;font-size:13px;' +
        'font-weight:500;z-index:9999;box-shadow:0 4px 20px rgba(0,0,0,0.2);white-space:nowrap';
      t.textContent = msg;
      document.body.appendChild(t);
      setTimeout(function(){t.remove();}, 3000);
    }

    function genericClose(modalId, event) {
      if (event && event.target && event.target.id !== modalId) return;
      document.getElementById(modalId).classList.remove('open');
    }

    /* ── SUPORTE ── */
    function openSupportModal(canal) {
      var titles = {sistema:'Abrir chamado — Sistema',almoxarifado:'Solicitar apoio — Almoxarifado',sst:'Contatar SST'};
      var subs   = {sistema:'Descreva o erro ou dúvida. Atendimento: suporte@empresa.com',
                    almoxarifado:'Dúvidas sobre saldo, entrega e reposição. Contato: almoxarifado@empresa.com',
                    sst:'Tratativas sobre validade de uso, troca e exigência de EPI. Contato: sst@empresa.com'};
      document.getElementById('supportModalTitle').textContent = titles[canal] || 'Abrir chamado';
      document.getElementById('supportModalSub').textContent   = subs[canal]   || '';
      document.getElementById('supportModal').classList.add('open');
    }
    function closeSupportModal(event) { genericClose('supportModal', event); }
    function submitSupportRequest() {
      var desc  = document.getElementById('supportDesc').value.trim();
      var nome  = document.getElementById('supportName').value.trim();
      var email = document.getElementById('supportEmail').value.trim();
      var tipo  = document.getElementById('supportType').value;
      if (!desc) { alert('Descreva a solicitação antes de enviar.'); return; }

      // Destino conforme canal
      var canal = document.getElementById('supportModalTitle').textContent;
      var destinos = {
        'sistema':       'suporte@empresa.com',
        'almoxarifado':  'almoxarifado@empresa.com',
        'sst':           'sst@empresa.com',
      };
      // Detectar pelo título
      var dest = 'suporte@empresa.com';
      if (canal.includes('Almoxarifado')) dest = 'almoxarifado@empresa.com';
      else if (canal.includes('SST'))     dest = 'sst@empresa.com';

      var assunto = encodeURIComponent('[Sistema EPI] ' + tipo + (nome ? ' — ' + nome : ''));
      var corpo   = encodeURIComponent(
        'Tipo: ' + tipo + '\n' +
        (nome  ? 'Nome: ' + nome  + '\n' : '') +
        (email ? 'E-mail para retorno: ' + email + '\n' : '') +
        '\nDescrição:\n' + desc + '\n\n' +
        '--- Enviado pelo sistema de Gestão de EPIs ---'
      );
      var mailtoLink = 'mailto:' + dest + '?subject=' + assunto + '&body=' + corpo;
      window.location.href = mailtoLink;

      closeSupportModal();
      showToast('Abrindo cliente de e-mail para envio...', 'success');
      // Limpar campos
      ['supportDesc','supportName','supportEmail'].forEach(function(id){
        var el = document.getElementById(id);
        if (el) el.value = '';
      });
    }

    /* ── ALERTA CONFIG (Solicitações sem Estoque) ── */
    function openAlertConfigModal() { document.getElementById('alertConfigModal').classList.add('open'); }
    function closeAlertConfigModal(event) { genericClose('alertConfigModal', event); }
    function saveAlertConfig() {
      var days = parseInt(document.getElementById('alertDays').value);
      if (isNaN(days) || days < 5) { alert('O mínimo configurável é 5 dias.'); return; }
      closeAlertConfigModal();
      showToast('Alerta configurado: ' + days + ' dias de antecedência', 'success');
    }

    /* ── STOCK REQUESTS ── */
    function stockRequestMarkAvailable(btn) {
      var item = btn.closest('.stock-request-item');
      if (!item) return;
      var badge = item.querySelector('.stock-request-actions .badge');
      if (badge) { badge.className = 'badge status-active'; badge.textContent = 'Disponível para entrega'; }
      btn.textContent = 'Disponível'; btn.disabled = true;
      showToast('Item marcado como disponível para entrega!', 'success');
    }
    function stockRequestDeliver(btn) {
      var item = btn.closest('.stock-request-item');
      if (!item) return;
      var badge = item.querySelector('.stock-request-actions .badge');
      if (badge) { badge.className = 'badge role-user'; badge.textContent = 'Entregue'; }
      btn.disabled = true;
      item.style.opacity = '0.7';
      showToast('Entrega registrada com sucesso!', 'success');
    }
    function stockRequestFinalize(btn) {
      var item = btn.closest('.stock-request-item');
      if (!item) return;
      var badge = item.querySelector('.stock-request-actions .badge');
      if (badge) { badge.className = 'badge role-user'; badge.textContent = 'Solicitação finalizada'; }
      btn.disabled = true; btn.style.opacity = '0.5';
      showToast('Solicitação finalizada!', 'success');
    }
    function stockRequestHistory(btn) { showToast('Histórico: funcionalidade em desenvolvimento.', 'info'); }

    /* ── SMS ── */
    function openSmsModal(btn) {
      var item = btn ? btn.closest('.stock-request-item') : null;
      var name = item ? (item.querySelector('.stock-request-main strong')?.textContent.split('·')[0].trim() || '') : '';
      document.getElementById('smsModalSub').textContent = name ? 'Funcionário: ' + name : 'Avise que o EPI está disponível.';
      document.getElementById('smsPhone').value = '';
      document.getElementById('smsModal').classList.add('open');
    }
    function closeSmsModal(event) { genericClose('smsModal', event); }
    function sendSms() {
      var phone = document.getElementById('smsPhone').value.trim();
      if (!phone) { alert('Informe o telefone do funcionário.'); return; }
      closeSmsModal();
      showToast('SMS enviado para ' + phone, 'success');
    }

    /* ── SUPERVISOR APPROVAL ── */
    function supervisorAction(btn, action) {
      var item = btn.closest('.stock-request-item');
      if (!item) return;
      if (action === 'approve') {
        var badge = item.querySelector('.stock-request-actions .badge');
        if (badge) { badge.className = 'badge status-active'; badge.textContent = 'Aprovado'; }
        item.querySelectorAll('.mini-btn').forEach(function(b){ b.disabled = true; b.style.opacity='0.5'; });
        var approved = document.createElement('span');
        approved.className = 'badge status-active';
        approved.textContent = 'Aprovado ✓';
        showToast('Solicitação aprovada!', 'success');
      } else if (action === 'reject') {
        document.getElementById('rejectTargetRow').value = '';
        item.dataset.rejectRef = Math.random().toString(36).slice(2);
        document.getElementById('rejectTargetRow').value = item.dataset.rejectRef;
        document.querySelectorAll('[data-reject-ref]').forEach(function(el){ el._rejectItem = null; });
        item._rejectItem = item;
        document.getElementById('rejectReason').value = '';
        document.getElementById('rejectModalSub').textContent = item.querySelector('.stock-request-main strong')?.textContent || 'Confirmar reprovação';
        document.getElementById('rejectModal').classList.add('open');
      } else if (action === 'adjust') {
        document.getElementById('adjustQtyModalSub').textContent = item.querySelector('.stock-request-main strong')?.textContent || 'Ajustar quantidade';
        document.getElementById('adjustQtyValue').value = '1';
        item._adjustItem = item;
        document.getElementById('adjustQtyModal').classList.add('open');
      }
    }
    function closeRejectModal(event) { genericClose('rejectModal', event); }
    function confirmReject() {
      var reason = document.getElementById('rejectReason').value.trim();
      if (!reason) { alert('Informe o motivo da reprovação.'); return; }
      closeRejectModal();
      showToast('Solicitação reprovada. Motivo registrado.', 'error');
    }
    function closeAdjustQtyModal(event) { genericClose('adjustQtyModal', event); }
    function confirmAdjustQty() {
      var qty = parseInt(document.getElementById('adjustQtyValue').value);
      if (!qty || qty < 1) { alert('Informe uma quantidade válida.'); return; }
      closeAdjustQtyModal();
      showToast('Quantidade ajustada para ' + qty + ' e aprovada!', 'success');
    }

    /* ── FICHA EPI — ASSINATURA ── */
    var _sigCanvas, _sigCtx, _sigDrawing = false;
    function openSignatureModal() {
      document.getElementById('signatureModal').classList.add('open');
      setTimeout(function() {
        _sigCanvas = document.getElementById('signatureCanvas');
        _sigCtx = _sigCanvas.getContext('2d');
        _sigCtx.strokeStyle = '#1C1C1E';
        _sigCtx.lineWidth = 2.5;
        _sigCtx.lineCap = 'round';
        _sigCtx.lineJoin = 'round';
        _sigCanvas.addEventListener('mousedown',  sigStart);
        _sigCanvas.addEventListener('mousemove',  sigDraw);
        _sigCanvas.addEventListener('mouseup',    sigEnd);
        _sigCanvas.addEventListener('touchstart', sigTStart, {passive:false});
        _sigCanvas.addEventListener('touchmove',  sigTMove,  {passive:false});
        _sigCanvas.addEventListener('touchend',   sigEnd);
      }, 50);
    }
    function closeSignatureModal(event) { genericClose('signatureModal', event); }
    function sigPos(e) {
      var r = _sigCanvas.getBoundingClientRect();
      var sx = _sigCanvas.width / r.width;
      var sy = _sigCanvas.height / r.height;
      var src = e.touches ? e.touches[0] : e;
      return { x: (src.clientX - r.left)*sx, y: (src.clientY - r.top)*sy };
    }
    function sigStart(e){ _sigDrawing=true; var p=sigPos(e); _sigCtx.beginPath(); _sigCtx.moveTo(p.x,p.y); }
    function sigDraw(e){ if(!_sigDrawing) return; var p=sigPos(e); _sigCtx.lineTo(p.x,p.y); _sigCtx.stroke(); }
    function sigEnd(){ _sigDrawing=false; }
    function sigTStart(e){ e.preventDefault(); sigStart(e); }
    function sigTMove(e){ e.preventDefault(); sigDraw(e); }
    function clearSignature(){ if(_sigCtx) _sigCtx.clearRect(0,0,_sigCanvas.width,_sigCanvas.height); }
    /* saveSignature() completa está definida mais abaixo — esta era uma versão
       antiga e mais simples que nunca chegava a executar (hoisting fazia a
       versão mais completa, abaixo, sempre vencer). Removida para evitar
       confusão e o código morto de "_origSaveSignature" que nunca era usado. */

    /* ── FICHA EPI — PDF / IMPRESSÃO ── */
    function epiFichaPrint() {
      showToast('Preparando impressão em 2 vias...', 'info');
      // Imprimir diretamente a janela atual em modo de impressão
      setTimeout(function(){
        var card = document.getElementById('fichaEpiCard');
        if (card) {
          var printWin = window.open('', '_blank', 'width=850,height=700');
          if (!printWin) { showToast('Permita popups para imprimir.', 'error'); return; }
          printWin.document.write('<html><head><title>Ficha EPI — 2 vias</title>' +
            '<style>@page{size:A4;margin:12mm 14mm} body{font-family:Arial,sans-serif;font-size:9pt} ' +
            '.no-print{display:none!important}</style></head><body>' +
            card.outerHTML + '<hr style="page-break-before:always;margin:20px 0">' +
            '<p style="text-align:center;font-size:8pt;color:#aaa">2ª via — arquivo</p>' +
            card.outerHTML + '</body></html>');
          printWin.document.close();
          printWin.onload = function(){ setTimeout(function(){ printWin.print(); }, 300); };
        } else {
          window.print();
        }
      }, 300);
    }
    function epiFichaGeneratePDF() {
      // ── Coletar dados da ficha ──────────────────────────────────────────
      // Carregar dados salvos da empresa
      var _emp = {};
      try { _emp = JSON.parse(localStorage.getItem('epi-ficha-empresa') || '{}'); } catch(e) {}

      var dados = {
        funcionario:  document.getElementById('fichaNome')?.textContent || 'Marcos Silva',
        matricula:    document.getElementById('fichaMatricula')?.textContent || 'MAT-000171',
        cpf:          document.getElementById('fichaCpf')?.textContent || '***.***.789-45',
        setor:        document.getElementById('fichaSetor')?.textContent || 'Manutenção',
        funcao:       document.getElementById('fichaFuncao')?.textContent || 'Mecânico',
        responsavel:  _emp.responsavel || 'Luis Freitas',
        cargo:        _emp.cargo || 'Responsável SST / Entregador',
        epi:          'Botina de segurança',
        ca:           '12345',
        quantidade:   '1 par',
        condicao:     'Novo',
        dataEntrega:  document.getElementById('fichaData')?.textContent || '18/04/2026',
        horaEntrega:  '14:20',
        local:        'Sala SST / Almoxarifado',
        fichaNum:     '0171',
        empresa:      _emp.empresa || document.getElementById('fichaEmpresa')?.textContent || 'RAMIRES / COBRESUL',
        cnpj:         _emp.cnpj || document.getElementById('fichaCnpj')?.textContent || '',
        cidade:       _emp.cidade || 'Joinville',
        uf:           _emp.uf || 'SC',
        endereco:     _emp.endereco || '',
        cep:          _emp.cep || '',
      };

      // ── Pegar assinatura do canvas (se existir) ────────────────────────
      var sigDataURL = '';
      var sigCanvas = document.getElementById('signatureCanvas');
      if (sigCanvas) {
        var blank = document.createElement('canvas');
        blank.width = sigCanvas.width; blank.height = sigCanvas.height;
        if (sigCanvas.toDataURL() !== blank.toDataURL()) {
          sigDataURL = sigCanvas.toDataURL('image/png');
        }
      }

      // ── Gerar HTML da ficha para impressão/PDF ─────────────────────────
      var assinaturaHtml = sigDataURL
        ? '<img src="' + sigDataURL + '" style="max-width:220px;max-height:70px;display:block;margin:4px auto">'
        : '<div style="width:220px;height:50px;border-bottom:1.5px solid #333;margin:0 auto"></div>';

      var fichaHtml = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<title>Ficha de EPI #${dados.fichaNum}</title>
<style>
  @page { size:A4; margin:12mm 14mm; }
  * { box-sizing:border-box; margin:0; padding:0; }
  body { font-family: Arial, sans-serif; font-size: 9pt; color: #1a1a1a; }
  .page { width:100%; }

  /* Cabeçalho */
  .header-bar {
    background:#1a3a6b; color:#fff; text-align:center;
    padding:8px 10px; font-size:12pt; font-weight:bold;
    letter-spacing:.3px; margin-bottom:6px;
  }
  .sub-title {
    text-align:center; font-size:8pt; color:#444;
    margin-bottom:8px; font-style:italic;
  }

  /* Seções */
  .section-title {
    background:#2b5ca8; color:#fff; font-weight:bold;
    font-size:8.5pt; padding:3px 6px; margin-bottom:2px;
  }

  /* Tabela de campos */
  .fields-table { width:100%; border-collapse:collapse; margin-bottom:5px; }
  .fields-table td {
    border:0.5px solid #aaa; padding:3px 5px; font-size:8.5pt; vertical-align:middle;
  }
  .fields-table .label {
    background:#eef2f9; font-weight:bold; width:22%;
    font-size:8pt; color:#1a3a6b;
  }

  /* Texto legal */
  .legal {
    font-size:7.5pt; text-align:justify; line-height:1.5;
    border:0.5px solid #ccc; padding:6px 8px;
    background:#fafbff; margin-bottom:6px; border-radius:3px;
  }

  /* Tabela de EPIs */
  .epi-table { width:100%; border-collapse:collapse; margin-bottom:6px; }
  .epi-table th {
    background:#1a3a6b; color:#fff; font-size:8pt;
    padding:4px 4px; text-align:center; border:0.5px solid #555;
  }
  .epi-table td {
    border:0.5px solid #aaa; padding:4px 4px;
    font-size:8.5pt; text-align:center; vertical-align:middle;
  }
  .epi-table tr:nth-child(even) td { background:#f0f4fb; }
  .epi-table .sig-cell { min-height:40px; }

  /* Declaração e assinatura */
  .declaracao {
    font-size:8pt; text-align:justify; line-height:1.5;
    margin-bottom:10px;
  }
  .sig-area {
    display:flex; justify-content:space-around; align-items:flex-end;
    margin-top:8px; gap:20px;
  }
  .sig-block { text-align:center; flex:1; }
  .sig-line { border-top:1.5px solid #333; padding-top:4px; font-size:8pt; color:#444; }

  /* Rodapé */
  .footer {
    border-top:1px solid #1a3a6b; padding-top:4px;
    display:flex; justify-content:space-between;
    font-size:7pt; color:#666; margin-top:8px;
  }

  /* Número de página */
  .page-num { text-align:right; font-size:7pt; color:#888; margin-bottom:6px; }

  /* Badge de assinado */
  .badge-signed {
    display:inline-block; background:#34C759; color:#fff;
    font-size:7pt; padding:2px 7px; border-radius:99px;
    font-weight:bold; vertical-align:middle; margin-left:6px;
  }
</style>
</head>
<body>
<div class="page">

  <!-- CABEÇALHO -->
  <div class="header-bar">FICHA DE ENTREGA DE EQUIPAMENTOS DE PROTEÇÃO INDIVIDUAL (EPI)</div>
  <div class="sub-title">Em conformidade com a NR-6 — Portaria MTB nº 3.214/78</div>
  <div class="page-num">Ficha #${dados.fichaNum} — ${dados.dataEntrega}</div>

  <!-- DADOS DA EMPRESA -->
  <div class="section-title">DADOS DA EMPRESA</div>
  <table class="fields-table">
    <tr>
      <td class="label">Empresa</td><td>${dados.empresa}</td>
      <td class="label">CNPJ</td><td>${dados.cnpj}</td>
    </tr>
    <tr>
      <td class="label">Cidade / UF</td><td>${dados.cidade} — ${dados.uf}</td>
      <td class="label">Data</td><td>${dados.dataEntrega}</td>
    </tr>
  </table>

  <!-- DADOS DO TRABALHADOR -->
  <div class="section-title">DADOS DO TRABALHADOR</div>
  <table class="fields-table">
    <tr>
      <td class="label">Nome</td><td>${dados.funcionario}</td>
      <td class="label">Matrícula</td><td>${dados.matricula}</td>
    </tr>
    <tr>
      <td class="label">CPF</td><td>${dados.cpf}</td>
      <td class="label">Local</td><td>${dados.local}</td>
    </tr>
    <tr>
      <td class="label">Função</td><td>${dados.funcao}</td>
      <td class="label">Setor</td><td>${dados.setor}</td>
    </tr>
  </table>

  <!-- TEXTO LEGAL -->
  <div class="legal">
    Esta ficha de entrega de Equipamentos de Proteção Individual (EPIs) está em conformidade com a
    Norma Regulamentadora NR-6. De acordo com a NR-6, o empregador é obrigado a fornecer aos
    trabalhadores, gratuitamente, os EPIs adequados aos riscos presentes no ambiente de trabalho,
    além de orientar e treinar o uso correto dos mesmos. O presente documento serve como comprovante
    da entrega e tem a finalidade de registrar o recebimento dos EPIs pelo trabalhador, conforme as
    instruções fornecidas, garantindo sua segurança e saúde no ambiente de trabalho. O trabalhador
    declara ter recebido os EPIs em perfeitas condições e se compromete a utilizá-los de forma
    adequada, conforme as instruções fornecidas e conforme a norma.
  </div>

  <!-- TABELA DE EPIs -->
  <div class="section-title">EPIs ENTREGUES</div>
  <table class="epi-table">
    <thead>
      <tr>
        <th>Data da Entrega</th>
        <th>Nome do EPI</th>
        <th>CA</th>
        <th>Validade do CA</th>
        <th>Qtd.</th>
        <th>Condição</th>
        <th>Assinatura do Trabalhador</th>
        <th>Data de Devolução</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td>${dados.dataEntrega} ${dados.horaEntrega}</td>
        <td style="text-align:left;font-weight:bold">${dados.epi}</td>
        <td>${dados.ca}</td>
        <td>10/2026</td>
        <td>${dados.quantidade}</td>
        <td>${dados.condicao}</td>
        <td class="sig-cell">${assinaturaHtml}</td>
        <td></td>
      </tr>
      <tr><td>&nbsp;</td><td></td><td></td><td></td><td></td><td></td><td class="sig-cell"></td><td></td></tr>
      <tr><td>&nbsp;</td><td></td><td></td><td></td><td></td><td></td><td class="sig-cell"></td><td></td></tr>
      <tr><td>&nbsp;</td><td></td><td></td><td></td><td></td><td></td><td class="sig-cell"></td><td></td></tr>
    </tbody>
  </table>

  <!-- DECLARAÇÃO -->
  <p class="declaracao">
    Declaro ter recebido os EPIs acima listados, em perfeito estado de uso, comprometendo-me a
    utilizá-los conforme instruções recebidas, bem como zelar por sua integridade e comunicar ao
    empregador qualquer necessidade de substituição.
    <span class="badge-signed">✓ Assinado digitalmente</span>
  </p>

  <!-- ASSINATURAS -->
  <div class="sig-area">
    <div class="sig-block">
      <div>${assinaturaHtml}</div>
      <div class="sig-line">
        <strong>${dados.funcionario}</strong><br>
        ${dados.funcao} · ${dados.setor}<br>
        Data: ${dados.dataEntrega} ${dados.horaEntrega}
      </div>
    </div>
    <div class="sig-block">
      <div style="height:50px;border-bottom:1.5px solid #333"></div>
      <div class="sig-line">
        <strong>${dados.responsavel}</strong><br>
        Responsável SST / Entregador<br>
        Data: ${dados.dataEntrega}
      </div>
    </div>
  </div>

  <!-- RODAPÉ -->
  <div class="footer">
    <span><b>${dados.empresa}</b> — Gestão de EPIs v1.0</span>
    <span>Ficha #${dados.fichaNum} — NR-06 — Gerado em ${new Date().toLocaleString('pt-BR')}</span>
    <span>Página 1 de 1</span>
  </div>

</div>
</body>
</html>`;

      // ── Abrir nova janela e imprimir como PDF ──────────────────────────
      var win = window.open('', '_blank', 'width=900,height=700');
      if (!win) {
        showToast('Popup bloqueado! Permita popups para este site e tente novamente.', 'error');
        return;
      }
      win.document.open();
      win.document.write(fichaHtml);
      win.document.close();
      // Aguardar carregamento e imprimir
      var checkReady = setInterval(function() {
        if (win.document.readyState === 'complete') {
          clearInterval(checkReady);
          setTimeout(function() { win.focus(); win.print(); }, 300);
        }
      }, 100);
      setTimeout(function() { clearInterval(checkReady); }, 5000);
      showToast('Ficha aberta! Escolha "Salvar como PDF" na janela de impressão.', 'success');
    }

    /* ── EXPORTAÇÕES ── */
    function exportCSV(filename, headers, rows) {
      var csv = [headers.join(',')].concat(rows.map(function(r){ return r.map(function(c){ return '"'+(c||'').toString().replace(/"/g,'""')+'"'; }).join(','); })).join('\n');
      var blob = new Blob(['\uFEFF'+csv], {type:'text/csv;charset=utf-8;'});
      var url  = URL.createObjectURL(blob);
      var a    = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click();
      document.body.removeChild(a); URL.revokeObjectURL(url);
      showToast('Exportado: ' + filename, 'success');
    }

    function exportDelivered() {
      exportCSV('epis_entregues.csv',
        ['Funcionário','Setor','Tipo','Item entregue','Tamanho','Quantidade','Data da entrega','Entregue por'],
        [
          ['Marcos Silva','Manutenção','Sapatão / Botina','Botina de segurança','40','1 par','12/04/2026','Luis Freitas'],
          ['João Pereira','Produção','Protetor auricular','Protetor auricular silicone','Único','2 unidades','11/04/2026','Tainara Alves'],
          ['Ana Souza','Produção','Óculos de proteção','Óculos incolor antiembaçante','Único','1 unidade','08/04/2026','Luis Freitas'],
          ['Carlos Mendes','Expedição','Roupa / Uniforme','Uniforme operacional','G','2 unidades','17/04/2026','Luis Freitas'],
        ]
      );
    }

    function exportAvailableItems() {
      var rows = [];
      document.querySelectorAll('#availableItemsView tbody tr').forEach(function(tr) {
        var cells = tr.querySelectorAll('td');
        if (cells.length) rows.push(Array.from(cells).map(function(td){ return td.textContent.trim(); }));
      });
      if (!rows.length) rows = [['Sem dados disponíveis']];
      exportCSV('itens_disponiveis.csv', ['Material','Tipo','Tamanho','Disponível','Status'], rows);
    }

    function exportStockValidity() {
      exportCSV('validade_estoque.csv',
        ['Produto','Validade','Quantidade','Data de entrada','Data de baixa'],
        [
          ['Botina de segurança — nº40','30/11/2026','40 pares','18/04/2026','—'],
          ['Óculos de proteção','15/09/2026','25 unidades','11/04/2026','—'],
          ['Luva nitrílica','22/12/2026','60 pares','05/04/2026','—'],
          ['Protetor auricular (lote vencido)','15/03/2026','15 unidades','01/01/2026','18/04/2026'],
        ]
      );
    }

    function exportEmployeeHistory() {
      exportCSV('historico_funcionario.csv',
        ['Data','EPI','Tamanho','Quantidade','CA','Validade','Status'],
        [
          ['12/04/2026 14:20','Botina de segurança','40','1 par','12345','12/10/2026','Ativo'],
          ['12/04/2026 14:21','Óculos de proteção','Único','1 unidade','99881','—','Ativo'],
          ['03/01/2026 09:10','Protetor auricular','Único','2 unidades','—','—','Ativo'],
          ['15/08/2025 16:44','Luva nitrílica','G','3 pares','55771','—','Encerrado'],
        ]
      );
    }

    function exportReport(tipo) {
      var headers = ['Material','Tipo','Comprado','Disponível','Estoque mínimo','Status'];
      var rows = [];
      document.querySelectorAll('#reportsView tbody tr').forEach(function(tr) {
        var cells = tr.querySelectorAll('td');
        if (cells.length) rows.push(Array.from(cells).map(function(td){ return td.textContent.trim(); }));
      });
      if (!rows.length) rows = [['Botina de segurança','Botina','120 pares','8 pares','15 pares','Acabando']];
      exportCSV('relatorio_' + tipo + '.csv', headers, rows);
    }

    /* ── EXPORTAR CONFIGURAÇÕES ── */
    function openExportConfigModal() { document.getElementById('exportConfigModal').classList.add('open'); }
    function closeExportConfigModal(event) { genericClose('exportConfigModal', event); }
    function doExportConfig() {
      var config = {
        exportedAt: new Date().toISOString(),
        exportedBy: 'Luis Freitas',
        users: [
          {nome:'Luis Freitas',email:'luis.freitas@empresa.com',role:'Master',status:'Ativo'},
          {nome:'Tainara Alves',email:'tainara@empresa.com',role:'Administrador',status:'Ativo'},
        ],
        rolePermissions: typeof rolePermissions !== 'undefined' ? rolePermissions : {},
        actionPermissions: typeof blockedActions !== 'undefined' ? blockedActions : {},
      };
      var json = JSON.stringify(config, null, 2);
      var blob = new Blob([json], {type:'application/json'});
      var url  = URL.createObjectURL(blob);
      var a    = document.createElement('a');
      a.href = url; a.download = 'configuracoes_gestao_epis.json';
      document.body.appendChild(a); a.click();
      document.body.removeChild(a); URL.revokeObjectURL(url);
      closeExportConfigModal();
      showToast('Configurações exportadas!', 'success');
    }


    /* ── NOVO TEMPLATE DE E-MAIL ── */
    function closeNewEmailTemplateModal(event) {
      if (event && event.target && event.target.id !== 'newEmailTemplateModal') return;
      document.getElementById('newEmailTemplateModal').classList.remove('open');
    }

    function insertVar(v) {
      var ta = document.getElementById('tmplCorpo');
      if (!ta) return;
      var start = ta.selectionStart, end = ta.selectionEnd;
      ta.value = ta.value.slice(0, start) + v + ta.value.slice(end);
      ta.selectionStart = ta.selectionEnd = start + v.length;
      ta.focus();
      tmplPreview();
    }

    function tmplPreview() {
      var assunto = document.getElementById('tmplAssunto').value || '—';
      var corpo   = document.getElementById('tmplCorpo').value   || '—';
      // Replace vars with sample values
      var samples = {
        '{{funcionario_nome}}':       'João Pereira',
        '{{funcionario_matricula}}':  'MAT-000121',
        '{{funcionario_setor}}':      'Produção',
        '{{epi_nome}}':               'Protetor auricular',
        '{{epi_ca}}':                 '55771',
        '{{data_vencimento}}':        '18/05/2026',
        '{{dias}}':                   '30',
        '{{data_entrega}}':           '19/04/2026',
        '{{responsavel_sst}}':        'Luis Freitas',
        '{{empresa_nome}}':           'Cobresul',
        '{{link_sistema}}':           'https://sistema.empresa.com',
      };
      Object.entries(samples).forEach(function(kv) {
        assunto = assunto.split(kv[0]).join('<em style="color:var(--primary)">'+kv[1]+'</em>');
        corpo   = corpo.split(kv[0]).join(kv[1]);
      });
      document.getElementById('tmplPreviewAssunto').innerHTML = assunto;
      document.getElementById('tmplPreviewCorpo').textContent = corpo;
    }

    // Live preview as user types
    document.addEventListener('DOMContentLoaded', function() {
      ['tmplAssunto','tmplCorpo'].forEach(function(id) {
        var el = document.getElementById(id);
        if (el) el.addEventListener('input', tmplPreview);
      });
    });

    function saveEmailTemplate() {
      var nome    = document.getElementById('tmplNome').value.trim();
      var tipo    = document.getElementById('tmplTipo').value;
      var assunto = document.getElementById('tmplAssunto').value.trim();
      var corpo   = document.getElementById('tmplCorpo').value.trim();
      if (!nome || !tipo || !assunto || !corpo) {
        alert('Preencha todos os campos obrigatórios: Nome, Tipo, Assunto e Corpo.');
        return;
      }
      var status = document.getElementById('tmplStatus').value;
      // Add to emailTemplates array
      if (typeof emailTemplates !== 'undefined') {
        var newId = emailTemplates.length + 1;
        emailTemplates.push({
          id: newId, tipo: tipo, icon: 'email',
          color: '#5856D6', bg: 'rgba(88,86,214,0.10)',
          nome: nome, desc: assunto,
          ativo: status === 'ativo', total: 0,
          ultima: '—'
        });
        if (typeof emailRenderTemplates === 'function') emailRenderTemplates();
      }
      closeNewEmailTemplateModal();
      showToast('Template "' + nome + '" salvo com sucesso!', 'success');
      // Reset form
      ['tmplNome','tmplAssunto','tmplCorpo','tmplCc'].forEach(function(id){
        var el = document.getElementById(id);
        if (el) el.value = '';
      });
      document.getElementById('tmplTipo').value = '';
      document.getElementById('tmplPreviewAssunto').innerHTML = '—';
      document.getElementById('tmplPreviewCorpo').textContent = '—';
    }


    /* ── EPIs ENTREGUES — tabela com validade dinâmica ── */

    // Prazo de vida útil em dias por categoria de EPI
    var EPI_VIDA_UTIL = {
      'Sapatão / Botina':   365,   // 1 ano
      'Óculos de proteção': 365,
      'Luva':               180,   // 6 meses
      'Protetor auricular': 180,
      'Roupa / Uniforme':   730,   // 2 anos
      'Capacete':           1095,  // 3 anos
      'Máscara':            30,
      'default':            365,
    };

    var deliveredData = [
      { func: 'Marcos Silva',  setor: 'Manutenção', tipo: 'Sapatão / Botina',   item: 'Botina de segurança',          tam: '40',    qtd: '1 par',      dt: '12/04/2026', por: 'Luis Freitas'  },
      { func: 'João Pereira',  setor: 'Produção',   tipo: 'Protetor auricular', item: 'Protetor auricular silicone',  tam: 'Único', qtd: '2 unidades', dt: '11/04/2026', por: 'Tainara Alves' },
      { func: 'Ana Souza',     setor: 'Produção',   tipo: 'Óculos de proteção', item: 'Óculos incolor antiembaçante', tam: 'Único', qtd: '1 unidade',  dt: '08/04/2026', por: 'Luis Freitas'  },
      { func: 'Carlos Mendes', setor: 'Expedição',  tipo: 'Roupa / Uniforme',   item: 'Uniforme operacional',         tam: 'G',     qtd: '2 unidades', dt: '17/04/2026', por: 'Luis Freitas'  },
      { func: 'Pedro Alves',   setor: 'Manutenção', tipo: 'Luva',               item: 'Luva nitrílica',               tam: 'G',     qtd: '3 pares',    dt: '01/11/2025', por: 'Luis Freitas'  },
      { func: 'Fernanda Lima', setor: 'Qualidade',  tipo: 'Óculos de proteção', item: 'Óculos ampla visão',           tam: 'Único', qtd: '1 unidade',  dt: '15/01/2026', por: 'Tainara Alves' },
      { func: 'Ricardo Souza', setor: 'Produção',   tipo: 'Capacete',           item: 'Capacete de segurança Classe B',tam:'Único', qtd: '1 unidade',  dt: '10/03/2024', por: 'Luis Freitas'  },
    ];

    function parseBR(dtStr) {
      // dd/mm/yyyy → Date
      var p = dtStr.split('/');
      return new Date(Number(p[2]), Number(p[1])-1, Number(p[0]));
    }

    function calcDeliveredStatus(row) {
      var dtEntrega = parseBR(row.dt);
      var vidaDias  = EPI_VIDA_UTIL[row.tipo] || EPI_VIDA_UTIL['default'];
      var dtValidade= new Date(dtEntrega.getTime() + vidaDias * 86400000);
      var today     = new Date(); today.setHours(0,0,0,0);
      var diasRest  = Math.ceil((dtValidade - today) / 86400000);
      var dtStr     = dtValidade.toLocaleDateString('pt-BR');

      var status, badgeCls, diasLabel;
      if (diasRest < 0) {
        status    = 'expired';
        badgeCls  = 'background:rgba(255,59,48,0.12);color:#C0221A';
        diasLabel = '<span style="color:#FF3B30;font-weight:500">Vencido há ' + Math.abs(diasRest) + ' dias</span>';
      } else if (diasRest <= 30) {
        status    = 'expiring';
        badgeCls  = 'background:rgba(255,149,0,0.12);color:#C07000';
        diasLabel = '<span style="color:#FF9500;font-weight:500">Vence em ' + diasRest + ' dias</span>';
      } else {
        status    = 'ok';
        badgeCls  = 'background:rgba(52,199,89,0.12);color:#1A7A35';
        diasLabel = '<span style="color:#34C759;font-weight:500">' + diasRest + ' dias</span>';
      }

      return { dtStr, vidaDias, diasRest, status, badgeCls, diasLabel };
    }

    function renderDeliveredTable() {
      var body = document.getElementById('deliveredTableBody');
      if (!body) return;

      var filterType   = (document.getElementById('deliveredType')?.value   || '');
      var filterEmp    = (document.getElementById('deliveredEmployee')?.value|| '').toLowerCase().trim();
      var filterPeriod = (document.getElementById('deliveredPeriod')?.value  || '').toLowerCase().trim();
      var filterStatus = (document.getElementById('deliveredStatus')?.value  || '');

      var rows = deliveredData.filter(function(r) {
        if (filterType   && filterType !== 'Todos' && r.tipo !== filterType) return false;
        if (filterEmp    && !r.func.toLowerCase().includes(filterEmp))       return false;
        if (filterPeriod && !r.dt.toLowerCase().includes(filterPeriod))      return false;
        var s = calcDeliveredStatus(r);
        if (filterStatus && s.status !== filterStatus)                        return false;
        return true;
      });

      if (!rows.length) {
        body.innerHTML = '<tr><td colspan="11" style="text-align:center;color:var(--on-surface-variant);padding:32px">Nenhum registro encontrado.</td></tr>';
        return;
      }

      body.innerHTML = rows.map(function(r) {
        var s = calcDeliveredStatus(r);
        var meses = Math.round(s.vidaDias / 30);
        var vidaLabel = meses >= 12 ? (meses/12) + ' ano' + (meses > 12 ? 's' : '') : meses + ' meses';
        return '<tr>' +
          '<td><strong>' + r.func  + '</strong></td>' +
          '<td>' + r.setor + '</td>' +
          '<td>' + r.tipo  + '</td>' +
          '<td>' + r.item  + '</td>' +
          '<td>' + r.tam   + '</td>' +
          '<td>' + r.qtd   + '</td>' +
          '<td style="white-space:nowrap">' + r.dt + '</td>' +
          '<td style="white-space:nowrap">' +
            '<div style="font-size:13px">' + s.dtStr + '</div>' +
            '<div style="font-size:11px;color:var(--on-surface-variant);margin-top:2px">(' + vidaLabel + ' de uso)</div>' +
          '</td>' +
          '<td>' + s.diasLabel + '</td>' +
          '<td><span class="badge" style="' + s.badgeCls + ';font-size:11px">' +
            (s.status === 'expired' ? 'Vencido' : s.status === 'expiring' ? 'A vencer' : 'Ok') +
          '</span></td>' +
          '<td style="font-size:13px">' + r.por + '</td>' +
        '</tr>';
      }).join('');
    }

    function clearDeliveredFilters() {
      ['deliveredType','deliveredEmployee','deliveredPeriod','deliveredStatus'].forEach(function(id) {
        var el = document.getElementById(id);
        if (el) { if (el.tagName === 'SELECT') el.selectedIndex = 0; else el.value = ''; }
      });
      renderDeliveredTable();
    }

    // Atualizar exportDelivered para incluir validade
    function exportDelivered() {
      var headers = ['Funcionário','Setor','Tipo','Item','Tamanho','Quantidade',
                     'Data Entrega','Validade de uso','Dias restantes','Status','Entregue por'];
      var rows = deliveredData.map(function(r) {
        var s = calcDeliveredStatus(r);
        return [r.func, r.setor, r.tipo, r.item, r.tam, r.qtd,
                r.dt, s.dtStr, s.diasRest, s.status === 'expired' ? 'Vencido' : s.status === 'expiring' ? 'A vencer' : 'Ok',
                r.por];
      });
      exportCSV('epis_entregues.csv', headers, rows);
    }

    // Init ao abrir a view
    


    /* ── VALIDADE DO CA (Certificado de Aprovação) ── */

    var caData = [
      { epi: 'Botina de segurança c/ biqueira',   tipo: 'Sapatão / Botina',   fab: 'Bracol',      ca: '38271', validade: '15/08/2026', qtd: '40 pares'   },
      { epi: 'Óculos de proteção incolor',         tipo: 'Óculos de proteção', fab: 'Danny',       ca: '99881', validade: '20/05/2026', qtd: '25 unidades'},
      { epi: 'Luva nitrílica descartável',         tipo: 'Luva',               fab: '3M',          ca: '55771', validade: '30/04/2026', qtd: '60 pares'   },
      { epi: 'Protetor auricular espuma',          tipo: 'Protetor auricular', fab: 'Moldex',      ca: '12045', validade: '10/04/2026', qtd: '15 unidades'},
      { epi: 'Capacete de segurança Classe B',     tipo: 'Capacete',           fab: 'MSA',         ca: '77210', validade: '01/03/2027', qtd: '10 unidades'},
      { epi: 'Respirador PFF2 sem válvula',        tipo: 'Respirador',         fab: '3M',          ca: '40219', validade: '28/04/2026', qtd: '30 unidades'},
      { epi: 'Óculos ampla visão antiembaçante',   tipo: 'Óculos de proteção', fab: 'Uvex',        ca: '31105', validade: '05/12/2026', qtd: '8 unidades' },
      { epi: 'Luva de raspa vaqueta',              tipo: 'Luva',               fab: 'Kalipso',     ca: '66433', validade: '10/02/2026', qtd: '20 pares'   },
      { epi: 'Protetor facial',                    tipo: 'Outro',              fab: 'Delta Plus',  ca: '',      validade: '',           qtd: '5 unidades' },
    ];

    function parseBRDate(s) {
      if (!s) return null;
      var p = s.split('/');
      if (p.length !== 3) return null;
      return new Date(+p[2], +p[1]-1, +p[0]);
    }

    function calcCaStatus(item) {
      if (!item.ca || !item.validade) return { status: 'none', dias: null };
      var dt = parseBRDate(item.validade);
      if (!dt) return { status: 'none', dias: null };
      var today = new Date(); today.setHours(0,0,0,0);
      var dias = Math.ceil((dt - today) / 86400000);
      if (dias < 0)  return { status: 'expired',  dias };
      if (dias <= 60) return { status: 'expiring', dias };
      return { status: 'ok', dias };
    }

    function renderCaTable() {
      var body     = document.getElementById('caTableBody');
      if (!body) return;
      var fTipo   = document.getElementById('caFilterTipo')?.value   || '';
      var fStatus = document.getElementById('caFilterStatus')?.value || '';

      var rows = caData.filter(function(r) {
        if (fTipo && r.tipo !== fTipo) return false;
        var s = calcCaStatus(r);
        if (fStatus && s.status !== fStatus) return false;
        return true;
      });

      // Update KPIs
      var kOk=0, kExp=0, kVenc=0, kNone=0;
      caData.forEach(function(r) {
        var s = calcCaStatus(r);
        if (s.status==='ok') kOk++;
        else if (s.status==='expiring') kExp++;
        else if (s.status==='expired') kVenc++;
        else kNone++;
      });
      var set = function(id,v){ var el=document.getElementById(id); if(el) el.textContent=v; };
      set('caKpiOk',kOk); set('caKpiExpiring',kExp); set('caKpiExpired',kVenc); set('caKpiNone',kNone);

      if (!rows.length) {
        body.innerHTML = '<tr><td colspan="9" style="text-align:center;color:var(--on-surface-variant);padding:32px">Nenhum item encontrado.</td></tr>';
        return;
      }

      body.innerHTML = rows.map(function(r) {
        var s = calcCaStatus(r);
        var badgeStyle, badgeLabel, diasLabel, acaoLabel;

        if (s.status === 'ok') {
          badgeStyle = 'background:rgba(52,199,89,0.12);color:#1A7A35';
          badgeLabel = 'CA válido';
          diasLabel  = '<span style="color:#34C759;font-weight:500">' + s.dias + ' dias</span>';
          acaoLabel  = '<span style="font-size:12px;color:var(--on-surface-variant)">Nenhuma</span>';
        } else if (s.status === 'expiring') {
          badgeStyle = 'background:rgba(255,149,0,0.12);color:#C07000';
          badgeLabel = 'A vencer';
          diasLabel  = '<span style="color:#FF9500;font-weight:500">Vence em ' + s.dias + ' dias</span>';
          acaoLabel  = '<button class="mini-btn" style="color:#FF9500" onclick="showToast(\'Renovação de CA solicitada.\',\'warning\')">Renovar CA</button>';
        } else if (s.status === 'expired') {
          badgeStyle = 'background:rgba(255,59,48,0.12);color:#C0221A';
          badgeLabel = 'CA vencido';
          diasLabel  = '<span style="color:#FF3B30;font-weight:500">Vencido há ' + Math.abs(s.dias) + ' dias</span>';
          acaoLabel  = '<button class="mini-btn" style="color:#FF3B30" onclick="showToast(\'Entrega bloqueada. Atualize o CA antes de prosseguir.\',\'error\')">🚫 Bloquear</button>';
        } else {
          badgeStyle = 'background:rgba(142,142,147,0.12);color:#555';
          badgeLabel = 'Sem CA';
          diasLabel  = '<span style="color:var(--on-surface-variant)">—</span>';
          acaoLabel  = '<button class="mini-btn" style="color:#007AFF" onclick="showToast(\'Cadastre o CA deste item em Materiais.\',\'info\')">Cadastrar CA</button>';
        }

        return '<tr>' +
          '<td><strong>' + r.epi + '</strong></td>' +
          '<td style="font-size:13px">' + r.tipo + '</td>' +
          '<td style="font-size:13px">' + r.fab + '</td>' +
          '<td><span class="badge role-user" style="font-size:11px">' + (r.ca || '—') + '</span></td>' +
          '<td style="white-space:nowrap;font-size:13px">' + (r.validade || '—') + '</td>' +
          '<td>' + diasLabel + '</td>' +
          '<td style="font-size:13px">' + r.qtd + '</td>' +
          '<td><span class="badge" style="' + badgeStyle + ';font-size:11px">' + badgeLabel + '</span></td>' +
          '<td>' + acaoLabel + '</td>' +
        '</tr>';
      }).join('');
    }

    function clearCaFilters() {
      ['caFilterTipo','caFilterStatus'].forEach(function(id) {
        var el = document.getElementById(id);
        if (el) el.selectedIndex = 0;
      });
      renderCaTable();
    }

    // Sobrescrever exportStockValidity para exportar dados de CA
    function exportStockValidity() {
      var headers = ['EPI','Tipo','Fabricante','Nº CA','Validade CA','Dias restantes','Qtd. estoque','Status'];
      var rows = caData.map(function(r) {
        var s = calcCaStatus(r);
        var statusLabel = {ok:'CA válido',expiring:'A vencer',expired:'CA vencido',none:'Sem CA'}[s.status];
        return [r.epi, r.tipo, r.fab, r.ca||'—', r.validade||'—',
                s.dias !== null ? s.dias : '—', r.qtd, statusLabel];
      });
      exportCSV('validade_ca.csv', headers, rows);
    }

    // Init ao abrir a view
    


    /* ── RELATÓRIO AUDITORIA — exportações ── */
    function exportUpcomingReport() {
      var headers = ['Funcionário','Setor','EPI','Data entrega','Prazo de uso','Vencimento do uso','Dias restantes','Status'];
      var rows = [
        ['Marcos Silva','Manutenção','Botina de segurança','12/04/2026','12 meses','12/04/2027','357','Ok'],
        ['João Pereira','Produção','Protetor auricular','11/04/2026','6 meses','11/10/2026','174','Ok'],
        ['Ana Souza','Produção','Óculos de proteção','08/04/2026','12 meses','08/04/2027','353','Ok'],
        ['Pedro Alves','Manutenção','Luva nitrílica','01/11/2025','6 meses','01/05/2026','11','A vencer'],
        ['Ricardo Souza','Produção','Capacete Classe B','10/03/2024','36 meses','10/03/2027','324','Ok'],
        ['Fernanda Lima','Qualidade','Luva de raspa','01/11/2025','6 meses','01/05/2026','11','A vencer'],
      ];
      exportCSV('relatorio_prazo_uso.csv', headers, rows);
    }

    function exportAuditSig() {
      var headers = ['Ficha','Funcionário','Setor','EPI entregue','Data entrega','Responsável'];
      var rows = [
        ['FIC-0168','Pedro Alves','Manutenção','Luva nitrílica','01/11/2025','Luis Freitas'],
        ['FIC-0155','Carlos Mendes','Expedição','Uniforme operacional','15/03/2026','Tainara Alves'],
        ['FIC-0149','Fernanda Lima','Qualidade','Óculos ampla visão','15/01/2026','Luis Freitas'],
      ];
      exportCSV('fichas_sem_assinatura.csv', headers, rows);
    }

    function exportAuditPending() {
      var headers = ['Pedido','Funcionário','EPI solicitado','Data aprovação','Supervisor','Dias em fila','Status'];
      var rows = [
        ['PED-0039','João Pereira','Capacete Classe B','10/04/2026','Fabio Santos','10','Aguardando entrega'],
        ['PED-0037','Marcos Silva','Respirador PFF2','05/04/2026','Luis Freitas','15','Atrasado'],
        ['PED-0035','Ana Souza','Luva de raspa vaqueta','01/04/2026','Fabio Santos','19','Atrasado'],
      ];
      exportCSV('solicitacoes_pendentes.csv', headers, rows);
    }

    function exportAuditLog() {
      var headers = ['Data/Hora','Usuário','Perfil','Ação','Referência','IP/Dispositivo'];
      var rows = [
        ['19/04/2026 10:05','Luis Freitas','Master','Entrega registrada','FIC-0171 · Marcos Silva','192.168.1.10 · Chrome/Win'],
        ['19/04/2026 09:10','Fabio Santos','Supervisor','Pedido aprovado','PED-0041 · João Pereira','192.168.1.22 · Safari/iOS'],
        ['19/04/2026 08:41','Luis Freitas','Master','Usuário cadastrado','USR-0025 · Fernanda Lima','192.168.1.10 · Chrome/Win'],
        ['18/04/2026 16:50','Tainara Alves','Admin','Alerta de estoque mínimo','EST-014 · Botina nº40','192.168.1.15 · Chrome/Mac'],
        ['18/04/2026 14:22','Luis Freitas','Master','Alerta crítico enviado','AUTO-006 · Marcos Silva','Sistema automático'],
        ['17/04/2026 10:30','Luis Freitas','Master','Assinatura coletada','FIC-0171 · Marcos Silva','192.168.1.10 · Chrome/Win'],
        ['16/04/2026 11:30','Tainara Alves','Admin','Compra registrada','EST-013 · Luva nitrílica','192.168.1.15 · Chrome/Mac'],
      ];
      exportCSV('log_auditoria.csv', headers, rows);
    }


    /* ── HISTÓRICO DO FUNCIONÁRIO — MODAL ── */

    // Dados de histórico por funcionário (simulado)
    var HISTORY_DATA = {
      'Marcos Silva': {
        nome: 'Marcos Silva', matricula: 'MAT-000171', setor: 'Manutenção', cracha: 'CR-001284',
        kpis: { total: 18, epis: 7, ultima: '12/04/2026', ativos: 4 },
        items: [
          { dt: '12/04/2026 14:20', epi: 'Botina de segurança',     tam: '40',    qtd: '1 par',      ca: '12345', motivo: 'Admissão',       por: 'Luis Freitas',  status: 'Ativo'     },
          { dt: '12/04/2026 14:21', epi: 'Óculos de proteção',      tam: 'Único', qtd: '1 unidade',  ca: '99881', motivo: 'Reposição',      por: 'Luis Freitas',  status: 'Ativo'     },
          { dt: '03/01/2026 09:10', epi: 'Protetor auricular',       tam: 'Único', qtd: '2 unidades', ca: '—',     motivo: 'Admissão',       por: 'Tainara Alves', status: 'Ativo'     },
          { dt: '15/08/2025 16:44', epi: 'Luva nitrílica',           tam: 'G',     qtd: '3 pares',    ca: '55771', motivo: 'Desgaste',       por: 'Luis Freitas',  status: 'Encerrado' },
          { dt: '10/03/2025 10:00', epi: 'Luva nitrílica',           tam: 'G',     qtd: '3 pares',    ca: '55771', motivo: 'Admissão',       por: 'Luis Freitas',  status: 'Encerrado' },
          { dt: '10/03/2025 10:05', epi: 'Capacete Classe B',        tam: 'Único', qtd: '1 unidade',  ca: '77210', motivo: 'Admissão',       por: 'Luis Freitas',  status: 'Ativo'     },
          { dt: '10/03/2025 10:10', epi: 'Uniforme operacional',     tam: 'G',     qtd: '2 unidades', ca: '—',     motivo: 'Admissão',       por: 'Luis Freitas',  status: 'Ativo'     },
          { dt: '20/09/2024 14:00', epi: 'Respirador PFF2',          tam: 'Único', qtd: '5 unidades', ca: '40219', motivo: 'Tarefa especial',por: 'Tainara Alves', status: 'Encerrado' },
        ]
      },
    };

    var _historyCurrentData = null;

    function openHistoryModal() {
      var searchVal  = (document.getElementById('historySearchValue')?.value || '').trim();
      var filterType = document.getElementById('historyFilterType')?.value || 'nome';

      // Buscar em EPI_RECORDS primeiro, depois HISTORY_DATA
      var funcKey = findFuncionario(searchVal, filterType) ||
                    findFuncionario(searchVal) ||
                    'Marcos Silva';
      var rec  = EPI_RECORDS[funcKey];
      var func = rec ? rec.func : { nome:'Marcos Silva', matricula:'MAT-000171', setor:'Manutenção', cracha:'CR-001284' };
      var entregas = rec ? rec.entregas : [];

      // Construir data compatível com _historyCurrentData
      _historyCurrentData = {
        nome:      func.nome,
        matricula: func.matricula || '',
        setor:     func.setor || '',
        cracha:    func.cracha || '',
        kpis: {
          total:  entregas.length,
          epis:   [...new Set(entregas.map(function(e){return e.epi;}))].length,
          ultima: entregas.length ? entregas[0].dt.split(' ')[0] : '—',
          ativos: entregas.filter(function(e){return e.status==='Ativo';}).length,
        },
        items: entregas.map(function(e){
          return { dt:e.dt, epi:e.epi, tam:e.tam, qtd:e.qtd, ca:e.ca,
                   motivo:e.motivo, por:e.por, status:e.status,
                   assinatura:e.assinatura, fichaNum:e.fichaNum };
        }),
        entregas: entregas,
        funcKey: funcKey,
      };

      // Fill modal header
      document.getElementById('historyModalName').textContent = 'Histórico — ' + func.nome;
      document.getElementById('historyModalMeta').textContent =
        (func.matricula||'') + ' · ' + (func.setor||'') + ' · ' + (func.cracha||'');

      // Fill KPIs
      document.getElementById('hkpi1').textContent = _historyCurrentData.kpis.total;
      document.getElementById('hkpi2').textContent = _historyCurrentData.kpis.epis;
      document.getElementById('hkpi3').textContent = _historyCurrentData.kpis.ultima;
      document.getElementById('hkpi4').textContent = _historyCurrentData.kpis.ativos;

      // Reset filter e tab
      var f = document.getElementById('historyModalFilter');
      if (f) f.value = '';
      showHistoryTab('tab-epis');

      // Open
      document.getElementById('historyModal').classList.add('open');
    }

    function closeHistoryModal(event) {
      if (event && event.target && event.target.id !== 'historyModal') return;
      document.getElementById('historyModal').classList.remove('open');
    }

    function showHistoryTab(tab) {
      document.querySelectorAll('.hist-tab-btn').forEach(function(b){
        b.style.background    = b.dataset.tab === tab ? 'var(--primary)' : 'transparent';
        b.style.color         = b.dataset.tab === tab ? '#fff' : 'var(--on-surface)';
        b.style.borderColor   = b.dataset.tab === tab ? 'var(--primary)' : 'var(--outline-variant)';
      });
      document.querySelectorAll('.hist-tab-panel').forEach(function(p){
        p.style.display = p.dataset.panel === tab ? 'block' : 'none';
      });
      if (!_historyCurrentData) return;
      if (tab === 'tab-epis')   renderHistoryModalTable(_historyCurrentData.items);
      if (tab === 'tab-fichas') renderHistoryFichas(_historyCurrentData.entregas || []);
    }

    function renderHistoryModalTable(items) {
      var body  = document.getElementById('historyModalBody');
      var count = document.getElementById('historyModalCount');
      if (!body) return;
      var filt  = document.getElementById('historyModalFilter')?.value || '';
      var list  = filt ? items.filter(function(r){return r.status===filt;}) : items;
      if (count) count.textContent = list.length + ' registro' + (list.length!==1?'s':'');
      if (!list.length) {
        body.innerHTML = '<tr><td colspan="9" style="text-align:center;color:var(--on-surface-variant);padding:24px">Nenhum registro encontrado.</td></tr>';
        return;
      }
      body.innerHTML = list.map(function(r) {
        var sc = r.status==='Ativo'
          ? 'background:rgba(52,199,89,0.12);color:#1A7A35'
          : 'background:rgba(142,142,147,0.12);color:#555';
        return '<tr>' +
          '<td style="white-space:nowrap;font-size:12px">'+ r.dt +'</td>' +
          '<td><strong>'+ r.epi +'</strong></td>' +
          '<td>'+ (r.tam||'—') +'</td>' +
          '<td>'+ (r.qtd||'—') +'</td>' +
          '<td><span class="badge role-user" style="font-size:10px">'+ (r.ca||'—') +'</span></td>' +
          '<td style="font-size:13px">'+ (r.motivo||'—') +'</td>' +
          '<td style="font-size:13px">'+ (r.por||'—') +'</td>' +
          '<td>'+ sigLabel(r.assinatura||'pendente') +'</td>' +
          '<td><span class="badge" style="'+ sc +';font-size:11px">'+ r.status +'</span></td>' +
          '</tr>';
      }).join('');
    }

    function renderHistoryFichas(entregas) {
      var body = document.getElementById('historyFichasBody');
      if (!body) return;
      if (!entregas || !entregas.length) {
        body.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--on-surface-variant);padding:24px">Nenhuma ficha encontrada.</td></tr>';
        return;
      }
      // Agrupar por fichaNum
      var fichas = {};
      entregas.forEach(function(e) {
        var fn = e.fichaNum || '—';
        if (!fichas[fn]) fichas[fn] = { num:fn, epis:[], dt:e.dt, por:e.por, assinaturas:[] };
        fichas[fn].epis.push(e.epi);
        fichas[fn].assinaturas.push(e.assinatura);
      });
      body.innerHTML = Object.values(fichas).map(function(f) {
        var allSigned  = f.assinaturas.every(function(s){return s!=='pendente';});
        var anyPending = f.assinaturas.some(function(s){return s==='pendente';});
        var badgeSig   = allSigned
          ? '<span class="badge status-active" style="font-size:10px">✓ Assinada</span>'
          : anyPending
            ? '<span class="badge role-supervisor" style="font-size:10px">Pendente</span>'
            : '<span class="badge role-user" style="font-size:10px">Parcial</span>';
        return '<tr>' +
          '<td><span class="badge role-user" style="font-size:11px">FIC-'+ f.num +'</span></td>' +
          '<td style="font-size:12px;white-space:nowrap">'+ f.dt +'</td>' +
          '<td style="font-size:12px">'+ f.epis.join(' · ') +'</td>' +
          '<td style="font-size:12px">'+ f.por +'</td>' +
          '<td>'+ badgeSig +'</td>' +
          '<td>' +
            '<button class="mini-btn" onclick="abrirFichaFromHistory(\'' + f.num + '\')">Abrir</button>' +
              '<span class="material-symbols-outlined" style="font-size:13px;vertical-align:-2px">open_in_new</span> Abrir' +
            '</button>' +
          '</td>' +
          '</tr>';
      }).join('');
    }

    function abrirFichaFromHistory(fichaNum) {
      closeHistoryModal();
      showView('epiFichaView');
      var nav = document.querySelector('.nav a[data-page="epiFicha"]');
      if (nav) setActiveNav(nav);
      showToast('Ficha FIC-' + fichaNum + ' carregada.', 'info');
    }

    function filterHistoryModal() {
      if (!_historyCurrentData) return;
      var f = document.getElementById('historyModalFilter')?.value || '';
      var items = f
        ? _historyCurrentData.items.filter(function(r){ return r.status === f; })
        : _historyCurrentData.items;
      renderHistoryModalTable(items);
    }

    function exportHistoryModal() {
      if (!_historyCurrentData) return;
      var headers = ['Data/Hora','EPI','Tamanho','Quantidade','CA','Motivo','Entregue por','Status'];
      var rows = _historyCurrentData.items.map(function(r) {
        return [r.dt, r.epi, r.tam, r.qtd, r.ca, r.motivo, r.por, r.status];
      });
      exportCSV('historico_' + _historyCurrentData.nome.replace(/ /g,'_') + '.csv', headers, rows);
    }

    function printHistoryModal() {
      showToast('Preparando impressão do histórico...', 'info');
      setTimeout(function(){ window.print(); }, 400);
    }

    function historyReset() {
      var sv = document.getElementById('historySearchValue');
      if (sv) sv.value = '';
    }


    /* ── GRADE DE TAMANHOS — ciclo de status ── */
    function cycleSizeChip(btn) {
      var states = ['chip-ok', 'chip-warning', 'chip-empty'];
      var labels = ['Disponível', 'Atenção (baixo estoque)', 'Em falta'];
      var current = states.findIndex(function(s){ return btn.classList.contains(s); });
      var next = (current + 1) % states.length;
      states.forEach(function(s){ btn.classList.remove(s); });
      btn.classList.add(states[next]);
      showToast(btn.textContent.trim() + ': ' + labels[next], next === 0 ? 'success' : next === 1 ? 'warning' : 'error');
    }


    /* ═══════════════════════════════════════════════════════════════════
       ESTOQUE INTEGRADO — sincroniza Compras com Grade de Tamanhos
    ═══════════════════════════════════════════════════════════════════ */

    // Estoque atual por material e tamanho
    // Estrutura: { 'Botina de segurança': { '40': 8, '39': 15, ... } }
    var STOCK_DATA = {
      'Botina de segurança': {
        '34':2, '35':5, '36':8, '37':3, '38':12, '39':15,
        '40':0, '41':6, '42':10, '43':2, '44':0,
        'minimo': 5
      },
      'Óculos de proteção': { 'Único': 25, 'minimo': 5 },
      'Luva nitrílica':     { 'PP':8, 'P':3, 'M':14, 'G':12, 'GG':0, 'minimo': 5 },
      'Protetor auricular': { 'Único': 15, 'minimo': 10 },
    };

    // Thresholds: abaixo de X% do mínimo → vermelho; abaixo de 2x mínimo → amarelo
    function getChipStatus(qty, minimo) {
      if (qty <= 0)         return 'chip-empty';    // vermelho — em falta
      if (qty < minimo)     return 'chip-warning';  // amarelo — atenção
      return 'chip-ok';                              // azul — ok
    }

    // Atualiza a grade de tamanhos visualmente com base no STOCK_DATA
    function updateSizeChipsFromStock(material) {
      var grid = document.getElementById('sizeChipsGrid');
      if (!grid) return;

      var stockForMat = STOCK_DATA[material];
      if (!stockForMat) return;

      var minimo = stockForMat.minimo || 5;
      var chips  = grid.querySelectorAll('.size-chip');

      chips.forEach(function(chip) {
        var size = chip.textContent.trim();
        if (size in stockForMat) {
          var qty    = stockForMat[size];
          var status = getChipStatus(qty, minimo);
          chip.classList.remove('chip-ok', 'chip-warning', 'chip-empty');
          chip.classList.add(status);
          // Update tooltip with quantity
          var label = status === 'chip-empty'   ? 'Em falta (0)'
                    : status === 'chip-warning'  ? 'Atenção (' + qty + ')'
                    : 'Disponível (' + qty + ')';
          chip.title = size + ': ' + label;
        }
      });

      // Update stock counter if exists
      updateStockSummary(material);
    }

    function updateStockSummary(material) {
      var stockForMat = STOCK_DATA[material];
      if (!stockForMat) return;
      var minimo = stockForMat.minimo || 5;
      var ok=0, warn=0, empty=0;
      Object.entries(stockForMat).forEach(function(kv) {
        if (kv[0] === 'minimo') return;
        var s = getChipStatus(kv[1], minimo);
        if (s === 'chip-ok') ok++;
        else if (s === 'chip-warning') warn++;
        else empty++;
      });
      var el = document.getElementById('stockSummaryText');
      if (el) {
        el.innerHTML =
          (ok    ? '<span style="color:#007AFF">'+ok+' disponível</span> ' : '') +
          (warn  ? '<span style="color:#FF9500">'+warn+' atenção</span> '  : '') +
          (empty ? '<span style="color:#FF3B30">'+empty+' em falta</span>' : '');
      }
    }

    // Quando trocar material no formulário de compra → mostra estoque atual na grade.
    // (Antes havia colisão de nome entre duas funções updateSaldoLabels() no mesmo
    // escopo — causava recursão infinita por causa do function hoisting do JS.
    // Corrigido: a função base tem nome próprio, sem ambiguidade.)
    function updateSaldoLabels() {
      if (typeof updateSaldoLabelsBase === 'function') updateSaldoLabelsBase();
      var mat = document.getElementById('purchaseMaterial')?.value || '';
      if (mat && typeof updateSizeChipsFromStock === 'function') updateSizeChipsFromStock(mat);
    }

    // Registrar nova entrada de estoque
    function savePurchase() {
      var mat   = document.getElementById('purchaseMaterial')?.value || '';
      var qty   = parseInt(document.getElementById('purchaseQty')?.value || '0');
      var size  = document.getElementById('purchaseSize')?.value   || 'Único';
      var ca    = document.getElementById('purchaseCa')?.value     || '';
      var unit  = document.getElementById('purchaseUnit')?.value   || 'Unidade';

      if (!mat) { alert('Selecione o material.'); return; }
      if (!qty || qty <= 0) { alert('Informe a quantidade.'); return; }

      var sizeKey = size || 'Único';

      // Atualizar STOCK_DATA
      if (!STOCK_DATA[mat]) STOCK_DATA[mat] = { minimo: 5 };
      STOCK_DATA[mat][sizeKey] = (STOCK_DATA[mat][sizeKey] || 0) + qty;

      // Atualizar grade de tamanhos visualmente
      updateSizeChipsFromStock(mat);

      // Feedback
      var statusAfter = getChipStatus(STOCK_DATA[mat][sizeKey], STOCK_DATA[mat].minimo || 5);
      var statusLabel = statusAfter === 'chip-ok' ? 'Disponível ✓' : statusAfter === 'chip-warning' ? 'Atenção ⚠' : 'Em falta';
      showToast(
        mat + (sizeKey !== 'Único' ? ' nº' + sizeKey : '') +
        ': +' + qty + ' ' + unit.toLowerCase() + ' → ' + statusLabel,
        statusAfter === 'chip-ok' ? 'success' : statusAfter === 'chip-warning' ? 'warning' : 'error'
      );

      // Limpar quantidade e tamanho
      var qtyEl  = document.getElementById('purchaseQty');
      var sizeEl = document.getElementById('purchaseSize');
      if (qtyEl)  qtyEl.value  = '';
      if (sizeEl) sizeEl.value = '';

      // Navegar para Cadastro de Materiais para ver a grade atualizada
      // (opcional — comentar se preferir ficar na tela de compras)
      // showView('materialsView');
    }

    // Inicializa os chips quando abre Cadastro de Materiais
    


    /* ── FICHA EPI — DADOS DA EMPRESA ── */
    var FICHA_EMPRESA_KEY = 'epi-ficha-empresa';

    function loadFichaEmpresa() {
      try {
        var saved = localStorage.getItem(FICHA_EMPRESA_KEY);
        return saved ? JSON.parse(saved) : null;
      } catch(e) { return null; }
    }

    function applyFichaEmpresa(d) {
      if (!d) return;
      var set = function(id, val) {
        var el = document.getElementById(id);
        if (el && val) el.textContent = val;
      };
      set('fichaEmpresa',  d.empresa  || 'RAMIRES / COBRESUL');
      set('fichaCnpj',     d.cnpj     || '');
      set('fichaEndereco', d.endereco || '');
      set('fichaCidade',   (d.cidade && d.uf) ? d.cidade + ' — ' + d.uf : d.cidade || 'Joinville — SC');
      // Atualizar responsável nos blocos de assinatura
      var resp = document.querySelectorAll('.fichaResponsavelNome');
      resp.forEach(function(el){ el.textContent = d.responsavel || 'Responsável SST'; });
      var cargo = document.querySelectorAll('.fichaResponsavelCargo');
      cargo.forEach(function(el){ el.textContent = d.cargo || 'Responsável SST / Entregador'; });
    }

    function openFichaEmpresaModal() {
      var d = loadFichaEmpresa() || {};
      document.getElementById('feEmpresa').value    = d.empresa    || '';
      document.getElementById('feCnpj').value       = d.cnpj       || '';
      document.getElementById('feCidade').value     = d.cidade     || '';
      document.getElementById('feUf').value         = d.uf         || '';
      document.getElementById('feCep').value        = d.cep        || '';
      document.getElementById('feEndereco').value   = d.endereco   || '';
      document.getElementById('feTelefone').value   = d.telefone   || '';
      document.getElementById('feEmail').value      = d.email      || '';

      document.getElementById('fichaEmpresaModal').classList.add('open');
    }

    function closeFichaEmpresaModal(event) {
      if (event && event.target && event.target.id !== 'fichaEmpresaModal') return;
      document.getElementById('fichaEmpresaModal').classList.remove('open');
    }

    function saveFichaEmpresa() {
      var empresa = document.getElementById('feEmpresa').value.trim();
      if (!empresa) { alert('O nome da empresa é obrigatório.'); return; }
      var d = {
        empresa:     empresa,
        cnpj:        document.getElementById('feCnpj').value.trim(),
        cidade:      document.getElementById('feCidade').value.trim(),
        uf:          document.getElementById('feUf').value.trim().toUpperCase(),
        cep:         document.getElementById('feCep').value.trim(),
        endereco:    document.getElementById('feEndereco').value.trim(),
        telefone:    document.getElementById('feTelefone').value.trim(),
        email:       document.getElementById('feEmail').value.trim(),

      };
      try { localStorage.setItem(FICHA_EMPRESA_KEY, JSON.stringify(d)); } catch(e) {}
      applyFichaEmpresa(d);
      closeFichaEmpresaModal();
      showToast('Dados da empresa salvos! Todas as fichas serão atualizadas.', 'success');
    }

    function resetFichaEmpresa() {
      if (!confirm('Limpar todos os dados da empresa?')) return;
      try { localStorage.removeItem(FICHA_EMPRESA_KEY); } catch(e) {}
      ['feEmpresa','feCnpj','feCidade','feUf','feCep','feEndereco','feTelefone','feEmail']
        .forEach(function(id){ var el=document.getElementById(id); if(el) el.value=''; });
      showToast('Dados da empresa removidos.', 'warning');
    }

    // Carregar dados ao abrir a view da ficha
    

    // Carregar na inicialização
    (function() {
      var d = loadFichaEmpresa();
      if (d) setTimeout(function(){ applyFichaEmpresa(d); }, 200);
    })();


    /* ── FICHA EPI — MODOS DE ASSINATURA ── */
    var _currentModoAssinatura = 'assinatura';
    var _digitalPressTimer = null;
    var _digitalProgressInterval = null;
    var _digitalPressStart = null;
    var DIGITAL_HOLD_MS = 3000; // 3 segundos

    function setModoAssinatura(modo) {
      _currentModoAssinatura = modo;
      var btnA = document.getElementById('btnModoAssinatura');
      var btnD = document.getElementById('btnModoDigital');
      var areaA = document.getElementById('modoAssinaturaArea');
      var areaD = document.getElementById('modoDigitalArea');

      if (modo === 'assinatura') {
        if (btnA) { btnA.style.background='var(--primary)'; btnA.style.color='#fff'; btnA.style.borderColor='var(--primary)'; }
        if (btnD) { btnD.style.background='transparent'; btnD.style.color='var(--on-surface)'; btnD.style.borderColor='var(--outline-variant)'; }
        if (areaA) areaA.style.display = 'flex';
        if (areaD) areaD.style.display = 'none';
      } else {
        if (btnD) { btnD.style.background='var(--primary)'; btnD.style.color='#fff'; btnD.style.borderColor='var(--primary)'; }
        if (btnA) { btnA.style.background='transparent'; btnA.style.color='var(--on-surface)'; btnA.style.borderColor='var(--outline-variant)'; }
        if (areaA) areaA.style.display = 'none';
        if (areaD) areaD.style.display = 'flex';
        // Resetar estado do botão digital
        resetDigitalBtn();
      }
    }

    function startDigitalPress(e) {
      if (e) e.preventDefault();
      _digitalPressStart = Date.now();
      var ring  = document.getElementById('digitalProgressRing');
      var label = document.getElementById('digitalBtnLabel');
      var msg   = document.getElementById('digitalStatusMsg');
      var btn   = document.getElementById('digitalBtn');
      var circumference = 439.8;

      if (btn)   { btn.style.transform   = 'translate(-50%,-50%) scale(0.95)'; btn.style.boxShadow = '0 2px 10px rgba(0,122,255,0.6)'; }
      if (msg)   msg.textContent = 'Segurando... não solte!';

      // Animar o anel de progresso
      _digitalProgressInterval = setInterval(function() {
        var elapsed = Date.now() - _digitalPressStart;
        var pct     = Math.min(elapsed / DIGITAL_HOLD_MS, 1);
        var offset  = circumference * (1 - pct);
        if (ring)  ring.style.strokeDashoffset = offset;
        if (label) label.textContent = Math.ceil((DIGITAL_HOLD_MS - elapsed) / 1000) + 's';
        if (pct >= 1) {
          clearInterval(_digitalProgressInterval);
          confirmDigitalPress();
        }
      }, 50);
    }

    function cancelDigitalPress() {
      if (!_digitalPressStart) return;
      clearInterval(_digitalProgressInterval);
      _digitalPressStart = null;
      var elapsed = 0;
      resetDigitalBtn();
    }

    function resetDigitalBtn() {
      _digitalPressStart = null;
      clearInterval(_digitalProgressInterval);
      var ring  = document.getElementById('digitalProgressRing');
      var label = document.getElementById('digitalBtnLabel');
      var msg   = document.getElementById('digitalStatusMsg');
      var btn   = document.getElementById('digitalBtn');
      if (ring)  { ring.style.strokeDashoffset = '439.8'; ring.style.stroke = '#007AFF'; }
      if (label) label.textContent = 'SEGURAR';
      if (msg)   msg.textContent = 'Pressione e segure para confirmar';
      if (btn)   { btn.style.transform = 'translate(-50%,-50%) scale(1)'; btn.style.boxShadow = '0 4px 20px rgba(0,122,255,0.4)'; }
    }

    function confirmDigitalPress() {
      var btn  = document.getElementById('digitalBtn');
      var ring = document.getElementById('digitalProgressRing');
      var msg  = document.getElementById('digitalStatusMsg');

      // Visual de sucesso no botão
      if (ring) ring.style.stroke = '#34C759';
      if (btn)  {
        btn.style.background = 'linear-gradient(135deg,#34C759,#30D158)';
        btn.style.transform  = 'translate(-50%,-50%) scale(1)';
        btn.innerHTML = '<span class="material-symbols-outlined" style="font-size:40px">check_circle</span>' +
                        '<span style="font-size:11px;font-weight:600">CONFIRMADO</span>';
        btn.disabled  = true;
      }
      if (msg) msg.textContent = '';

      var now = new Date().toLocaleDateString('pt-BR') + ' ' +
                new Date().toLocaleTimeString('pt-BR', {hour:'2-digit', minute:'2-digit'});
      var nome = document.getElementById('fichaNomeSig')?.textContent || '';

      // ── CÉLULA DA TABELA — mostrar confirmação de aceite digital ──────
      var cell = document.getElementById('fichaAssinaturaCell');
      if (cell) {
        cell.innerHTML =
          '<div style="display:flex;flex-direction:column;align-items:center;gap:3px;padding:4px">' +
            '<span class="material-symbols-outlined" style="font-size:28px;color:#34C759">fingerprint</span>' +
            '<span style="font-size:9px;font-weight:700;color:#34C759">ACEITE DIGITAL</span>' +
            '<span style="font-size:8px;color:#555">' + now + '</span>' +
            (nome ? '<span style="font-size:8px;color:#555">' + nome + '</span>' : '') +
          '</div>';
      }

      // ── PREVIEW abaixo da tabela ───────────────────────────────────────
      var preview = document.getElementById('fichaAssinaturaPreview');
      if (preview) {
        preview.style.borderStyle  = 'solid';
        preview.style.borderColor  = '#34C759';
        preview.style.cursor       = 'default';
        preview.removeAttribute('onclick');
        preview.innerHTML =
          '<div style="display:flex;flex-direction:column;align-items:center;gap:4px;padding:8px">' +
            '<span class="material-symbols-outlined" style="font-size:32px;color:#34C759">fingerprint</span>' +
            '<span style="font-size:10px;color:#34C759;font-weight:600">Aceite digital confirmado</span>' +
            '<span style="font-size:9px;color:#555">' + now + '</span>' +
          '</div>';
      }

      // ── BADGES de status ───────────────────────────────────────────────
      var badge = document.getElementById('fichaStatusTrabBadge');
      if (badge) badge.innerHTML =
        '<span class="badge status-active" style="font-size:11px">✓ Aceite digital — ' + now + '</span>';

      var st = document.getElementById('fichaStatusTrab');
      if (st) st.innerHTML = 'Trabalhador: <span class="badge status-active">Aceite digital ✓</span>';

      showToast('Recebimento confirmado por aceite digital!', 'success');
    }


    /* ── showView consolidado — um único override para todas as views ── */
    (function() {
      var _origShowView = showView;
      showView = function(viewId) {
        _origShowView(viewId);

        // Conectar telas à API (request/response real)
        if (viewId === 'dashboardView')          loadDashboardFromAPI();
        if (viewId === 'supervisorApprovalView') loadSolicitacoesFromAPI('PENDENTE');
        if (viewId === 'stockRequestsView')      loadSolicitacoesFromAPI();
        if (viewId === 'epiFichaView')           loadFichaFromAPI(1);
        if (viewId === 'reportsView')            loadAuditoriaFromAPI();
        if (viewId === 'selfServiceView') {
          const c = document.getElementById('selfCpf'); if (c) c.value = '';
          const b = document.getElementById('selfBirth'); if (b) b.value = '';
          const e = document.getElementById('selfServiceError'); if (e) e.style.display = 'none';
        }


        // userAdminView — sincronizar switches de permissão
        if (viewId === 'userAdminView') {
          document.querySelectorAll('[data-action][data-role]').forEach(function(btn) {
            if (btn.dataset.role === 'Master') { btn.classList.add('active'); btn.disabled = true; return; }
            var blocked = blockedActions[btn.dataset.role] || [];
            btn.classList.toggle('active', !blocked.includes(btn.dataset.action));
            if (currentMenuPreviewRole !== 'Master') {
              btn.disabled = true; btn.style.opacity = '0.5';
              btn.title = 'Apenas Master pode alterar';
            } else {
              btn.disabled = false; btn.style.opacity = '';  btn.title = '';
            }
          });
        }

        // emailsGestaoView — renderizar tabelas de e-mail
        if (viewId === 'emailsGestaoView') {
          if (typeof emailRenderTemplates === 'function') emailRenderTemplates();
          if (typeof emailRenderHistorico === 'function') emailRenderHistorico(emailHistorico);
          if (typeof emailRenderDestinatarios === 'function') emailRenderDestinatarios();
          var hoje = new Date().toLocaleDateString('pt-BR');
          var hj = (emailHistorico||[]).filter(function(e){return e.dt.startsWith(hoje);}).length;
          var kpiHoje = document.getElementById('emailKpiHoje');
          var kpiSem  = document.getElementById('emailKpiSemana');
          var kpiFal  = document.getElementById('emailKpiFalha');
          if (kpiHoje) kpiHoje.textContent = hj;
          if (kpiSem)  kpiSem.textContent  = (emailHistorico||[]).length;
          if (kpiFal)  kpiFal.textContent  = (emailHistorico||[]).filter(function(e){return e.status==='falha';}).length;
        }

        // deliveredItemsView — renderizar tabela de EPIs entregues
        if (viewId === 'deliveredItemsView') {
          if (typeof renderDeliveredTable === 'function') renderDeliveredTable();
        }

        // stockValidityView — renderizar tabela de CAs
        if (viewId === 'stockValidityView') {
          if (typeof renderCaTable === 'function') renderCaTable();
        }

        // materialsView — atualizar chips de estoque
        if (viewId === 'materialsView') {
          var mat = 'Botina de segurança';
          setTimeout(function(){ if (typeof updateSizeChipsFromStock === 'function') updateSizeChipsFromStock(mat); }, 50);
        }

        // epiFichaView — carregar dados da empresa + renderizar tabela
        if (viewId === 'epiFichaView') {
          if (typeof loadFichaEmpresa === 'function') {
            var d = loadFichaEmpresa();
            if (d && typeof applyFichaEmpresa === 'function') applyFichaEmpresa(d);
          }
          setTimeout(function(){
            if (typeof renderFichaTable === 'function') renderFichaTable(_fichaFuncAtual || 'Marcos Silva');
          }, 80);
        }

        // eligibilityRulesView — renderizar regras
        if (viewId === 'eligibilityRulesView') {
          if (typeof rulesFilter === 'function') rulesFilter();
        }
      };
    })();


    /* ═══════════════════════════════════════════════════════════════
       EPI_RECORDS — base central de registros de entrega
       Conecta: Histórico de Funcionários ↔ Ficha de EPI
    ═══════════════════════════════════════════════════════════════ */
    var EPI_RECORDS = {
      'Marcos Silva': {
        func: { nome:'Marcos Silva', matricula:'MAT-000171', cpf:'***.***.789-45',
                setor:'Manutenção', funcao:'Mecânico', cracha:'CR-001284' },
        entregas: [
          { id:'E001', dt:'12/04/2026 14:20', epi:'Botina de segurança',    tam:'40',    qtd:'1 par',      ca:'12345', valCa:'10/2026', motivo:'Admissão',  por:'Luis Freitas',  assinatura:'manual',  status:'Ativo',     fichaNum:'0171' },
          { id:'E002', dt:'12/04/2026 14:21', epi:'Óculos de proteção',     tam:'Único', qtd:'1 unidade',  ca:'99881', valCa:'09/2026', motivo:'Reposição', por:'Luis Freitas',  assinatura:'manual',  status:'Ativo',     fichaNum:'0171' },
          { id:'E003', dt:'03/01/2026 09:10', epi:'Protetor auricular',      tam:'Único', qtd:'2 unidades', ca:'—',     valCa:'—',       motivo:'Admissão',  por:'Tainara Alves', assinatura:'pendente',status:'Ativo',     fichaNum:'0165' },
          { id:'E004', dt:'15/08/2025 16:44', epi:'Luva nitrílica',          tam:'G',     qtd:'3 pares',    ca:'55771', valCa:'06/2026', motivo:'Desgaste',  por:'Luis Freitas',  assinatura:'manual',  status:'Encerrado', fichaNum:'0148' },
          { id:'E005', dt:'10/03/2025 10:05', epi:'Capacete Classe B',       tam:'Único', qtd:'1 unidade',  ca:'77210', valCa:'03/2028', motivo:'Admissão',  por:'Luis Freitas',  assinatura:'manual',  status:'Ativo',     fichaNum:'0132' },
          { id:'E006', dt:'10/03/2025 10:10', epi:'Uniforme operacional',    tam:'G',     qtd:'2 unidades', ca:'—',     valCa:'—',       motivo:'Admissão',  por:'Luis Freitas',  assinatura:'manual',  status:'Ativo',     fichaNum:'0132' },
          { id:'E007', dt:'20/09/2024 14:00', epi:'Respirador PFF2',         tam:'Único', qtd:'5 unidades', ca:'40219', valCa:'09/2025', motivo:'Tarefa',    por:'Tainara Alves', assinatura:'digital', status:'Encerrado', fichaNum:'0118' },
        ]
      },
      'João Pereira': {
        func: { nome:'João Pereira', matricula:'MAT-000121', cpf:'***.***.456-78',
                setor:'Produção', funcao:'Operador', cracha:'CR-000988' },
        entregas: [
          { id:'E010', dt:'11/04/2026 09:05', epi:'Protetor auricular',      tam:'Único', qtd:'2 unidades', ca:'12045', valCa:'04/2026', motivo:'Reposição', por:'Tainara Alves', assinatura:'manual',  status:'Ativo',     fichaNum:'0170' },
          { id:'E011', dt:'10/03/2025 11:00', epi:'Óculos de proteção',      tam:'Único', qtd:'1 unidade',  ca:'99881', valCa:'09/2026', motivo:'Admissão',  por:'Luis Freitas',  assinatura:'manual',  status:'Ativo',     fichaNum:'0133' },
        ]
      },
    };

    // Próximo ID de entrega
    var EPI_NEXT_ID = 20;
    // Próximo número de ficha
    var EPI_NEXT_FICHA = 172;

    /* Adicionar nova entrega — conecta histórico ↔ ficha automaticamente */
    function addEpiEntrega(nomeFuncionario, entregaData) {
      if (!EPI_RECORDS[nomeFuncionario]) {
        EPI_RECORDS[nomeFuncionario] = { func: { nome: nomeFuncionario }, entregas: [] };
      }
      var now = new Date().toLocaleDateString('pt-BR') + ' ' +
                new Date().toLocaleTimeString('pt-BR', {hour:'2-digit',minute:'2-digit'});
      var novaEntrega = Object.assign({
        id:         'E' + (EPI_NEXT_ID++),
        dt:         now,
        assinatura: 'pendente',
        status:     'Ativo',
        fichaNum:   String(EPI_NEXT_FICHA++).padStart(4,'0'),
      }, entregaData);
      EPI_RECORDS[nomeFuncionario].entregas.unshift(novaEntrega);
      return novaEntrega;
    }

    /* Buscar funcionário por nome, matrícula ou CPF */
    function findFuncionario(query, tipo) {
      query = (query || '').toLowerCase().trim();
      for (var key in EPI_RECORDS) {
        var f = EPI_RECORDS[key].func;
        if (tipo === 'nome'      && f.nome?.toLowerCase().includes(query)) return key;
        if (tipo === 'matricula' && f.matricula?.toLowerCase().includes(query)) return key;
        if (tipo === 'cpf'       && f.cpf?.toLowerCase().includes(query)) return key;
        if (!tipo && (
          f.nome?.toLowerCase().includes(query) ||
          f.matricula?.toLowerCase().includes(query) ||
          f.cpf?.toLowerCase().includes(query)
        )) return key;
      }
      return null;
    }

    /* Label de assinatura */
    function sigLabel(sig) {
      if (sig === 'manual')   return '<span class="badge status-active" style="font-size:10px">✓ Assinado</span>';
      if (sig === 'digital')  return '<span class="badge status-active" style="font-size:10px">👆 Digital</span>';
      return '<span class="badge role-supervisor" style="font-size:10px">Pendente</span>';
    }


    /* ═══ FICHA DE EPI — TABELA DINÂMICA ════════════════════════════════ */

    // Funcionário atual na ficha
    var _fichaFuncAtual = 'Marcos Silva';

    /* Renderizar tabela de EPIs da ficha — sem sobrescrever assinaturas */
    function renderFichaTable(funcKey) {
      _fichaFuncAtual = funcKey || _fichaFuncAtual;
      var rec = EPI_RECORDS[_fichaFuncAtual];
      if (!rec) return;
      var body = document.getElementById('fichaEpiTableBody');
      if (!body) return;

      // Preencher dados do trabalhador
      var f = rec.func;
      var set = function(id,v){ var el=document.getElementById(id); if(el&&v) el.textContent=v; };
      set('fichaNome',     f.nome);
      set('fichaCpf',      f.cpf);
      set('fichaFuncao',   f.funcao);
      set('fichaSetor',    f.setor);
      set('fichaMatricula',f.matricula);
      set('fichaNomeSig',  f.nome);
      set('fichaCargo',    (f.funcao||'') + (f.setor ? ' · ' + f.setor : ''));

      // Data de hoje
      var hoje = new Date().toLocaleDateString('pt-BR');
      set('fichaData', hoje);
      set('fichaDataSig', hoje + ' ' + new Date().toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'}));

      // Número da ficha (último)
      var fichaNum = rec.entregas.length ? rec.entregas[0].fichaNum : '0000';
      set('fichaNumLabel', 'Ficha #' + fichaNum + ' — ' + hoje);

      // Renderizar linhas — NUNCA sobrescreve assinaturas existentes
      body.innerHTML = rec.entregas.map(function(e, idx) {
        var sigCell;
        if (e.assinatura === 'manual' && e._sigImg) {
          sigCell = '<div style="display:flex;flex-direction:column;align-items:center;gap:2px;padding:2px">' +
            '<img src="'+e._sigImg+'" style="max-width:100px;max-height:38px;display:block">' +
            '<span style="font-size:8px;font-weight:700;color:#007AFF">ASSINATURA DIGITAL</span>' +
            '<span style="font-size:8px;color:#555">'+e.dt+'</span></div>';
        } else if (e.assinatura === 'digital') {
          sigCell = '<div style="display:flex;flex-direction:column;align-items:center;gap:2px;padding:4px">' +
            '<span class="material-symbols-outlined" style="font-size:22px;color:#34C759">fingerprint</span>' +
            '<span style="font-size:8px;font-weight:700;color:#34C759">ACEITE DIGITAL</span>' +
            '<span style="font-size:8px;color:#555">'+e.dt+'</span></div>';
        } else if (e.assinatura === 'manual') {
          sigCell = '<div style="display:flex;flex-direction:column;align-items:center;gap:2px;padding:4px">' +
            '<span class="material-symbols-outlined" style="font-size:20px;color:#007AFF">draw</span>' +
            '<span style="font-size:8px;font-weight:700;color:#007AFF">ASSINADO</span>' +
            '<span style="font-size:8px;color:#555">'+e.dt+'</span></div>';
        } else {
          // Pendente — botão para assinar
          sigCell = '<div style="display:flex;flex-direction:column;align-items:center;gap:3px;padding:4px">' +
            '<button onclick="assinarLinha('+idx+')" type="button" ' +
              'style="background:var(--primary);color:#fff;border:none;border-radius:8px;' +
                     'padding:4px 10px;font-size:10px;cursor:pointer;white-space:nowrap">' +
              '<span class="material-symbols-outlined" style="font-size:11px;vertical-align:-2px">gesture</span> Assinar' +
            '</button>' +
            '<span style="font-size:8px;color:#FF9500">Pendente</span></div>';
        }
        var bg = idx % 2 === 0 ? '' : 'background:#f0f4fb';
        return '<tr style="'+bg+'">' +
          '<td style="padding:5px 6px;border:0.5px solid #ccc;text-align:center;white-space:nowrap;font-size:10px">'+e.dt+'</td>' +
          '<td style="padding:5px 6px;border:0.5px solid #ccc;font-weight:600;font-size:11px">'+e.epi+'</td>' +
          '<td style="padding:5px 6px;border:0.5px solid #ccc;text-align:center;font-size:10px">'+(e.ca||'—')+'</td>' +
          '<td style="padding:5px 6px;border:0.5px solid #ccc;text-align:center;font-size:10px">'+(e.valCa||'—')+'</td>' +
          '<td style="padding:5px 6px;border:0.5px solid #ccc;text-align:center;font-size:10px">'+(e.qtd||'1 unidade')+'</td>' +
          '<td style="padding:5px 6px;border:0.5px solid #ccc;text-align:center;font-size:10px">'+(e.condicao||'Novo')+'</td>' +
          '<td style="padding:2px 4px;border:0.5px solid #ccc;min-height:50px">'+sigCell+'</td>' +
          '<td style="padding:5px 6px;border:0.5px solid #ccc;text-align:center;font-size:10px">'+(e.dtDevolucao||'')+'</td>' +
          '</tr>';
      }).join('');

      // Linhas vazias extras
      for (var i = 0; i < 2; i++) {
        body.innerHTML += '<tr style="'+(i%2===0?'background:#f0f4fb':'')+'">' +
          '<td style="padding:8px 6px;border:0.5px solid #ccc">&nbsp;</td>' +
          '<td style="border:0.5px solid #ccc"></td><td style="border:0.5px solid #ccc"></td>' +
          '<td style="border:0.5px solid #ccc"></td><td style="border:0.5px solid #ccc"></td>' +
          '<td style="border:0.5px solid #ccc"></td><td style="padding:8px;border:0.5px solid #ccc;min-height:40px"></td>' +
          '<td style="border:0.5px solid #ccc"></td></tr>';
      }
    }

    /* Assinar uma linha específica da ficha */
    var _assinandoLinha = -1;
    function assinarLinha(idx) {
      _assinandoLinha = idx;
      openSignatureModal();
    }

    /* Adicionar novo EPI na ficha — cria nova linha pendente (regra 4 e 5) */
    function addNovoEpiNaFicha() {
      var epi    = prompt('Nome do EPI a adicionar:');
      if (!epi) return;
      var ca     = prompt('Número do CA (deixe vazio se não houver):') || '—';
      var qtd    = prompt('Quantidade (ex.: 1 par, 2 unidades):') || '1 unidade';
      var nova   = addEpiEntrega(_fichaFuncAtual, { epi:epi, ca:ca, qtd:qtd,
                                                    motivo:'Manual', por:'Sistema' });
      renderFichaTable(_fichaFuncAtual);
      showToast('Novo EPI "'+epi+'" adicionado. Assinatura pendente.', 'success');
    }

    /* BUSCA DE FICHAS */
    function renderFichaSearch() {
      var qFunc   = (document.getElementById('fichaSearchFunc')?.value  ||'').toLowerCase().trim();
      var qEpi    = (document.getElementById('fichaSearchEpi')?.value   ||'').toLowerCase().trim();
      var qStatus = document.getElementById('fichaSearchStatus')?.value || '';
      var qData   = (document.getElementById('fichaSearchData')?.value  ||'').trim();
      var qNum    = (document.getElementById('fichaSearchNum')?.value   ||'').trim();

      var results = [];
      Object.keys(EPI_RECORDS).forEach(function(key) {
        var rec = EPI_RECORDS[key];
        var f   = rec.func;
        rec.entregas.forEach(function(e) {
          var matchFunc   = !qFunc   || f.nome?.toLowerCase().includes(qFunc) ||
                            f.cpf?.toLowerCase().includes(qFunc) ||
                            f.matricula?.toLowerCase().includes(qFunc);
          var matchEpi    = !qEpi    || e.epi.toLowerCase().includes(qEpi);
          var matchStatus = !qStatus || e.assinatura === qStatus;
          var matchData   = !qData   || e.dt.includes(qData);
          var matchNum    = !qNum    || (e.fichaNum||'').includes(qNum);
          if (matchFunc && matchEpi && matchStatus && matchData && matchNum) {
            results.push({ func:f, entrega:e, key:key });
          }
        });
      });

      var body = document.getElementById('fichaSearchBody');
      var wrap = document.getElementById('fichaSearchResults');
      if (!body || !wrap) return;

      wrap.style.display = 'block';

      if (!results.length) {
        body.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--on-surface-variant);padding:20px">Nenhuma ficha encontrada.</td></tr>';
        return;
      }

      body.innerHTML = results.map(function(r) {
        return '<tr>' +
          '<td><span class="badge role-user" style="font-size:10px">FIC-'+(r.entrega.fichaNum||'—')+'</span></td>' +
          '<td style="font-size:12px;font-weight:500">'+r.func.nome+'</td>' +
          '<td style="font-size:12px">'+r.entrega.epi+'</td>' +
          '<td style="font-size:12px;white-space:nowrap">'+r.entrega.dt+'</td>' +
          '<td>'+sigLabel(r.entrega.assinatura||'pendente')+'</td>' +
          '<td><span class="badge '+(r.entrega.status==='Ativo'?'status-active':'')+'\" style="font-size:10px">'+r.entrega.status+'</span></td>' +
          '<td>' +
            '<button class="mini-btn" onclick="abrirFichaFunc(\''+r.key+'\')">' +
              '<span class="material-symbols-outlined" style="font-size:12px;vertical-align:-2px">open_in_new</span> Abrir' +
            '</button>' +
          '</td>' +
          '</tr>';
      }).join('');
    }

    function clearFichaSearch() {
      ['fichaSearchFunc','fichaSearchEpi','fichaSearchData','fichaSearchNum'].forEach(function(id){
        var el = document.getElementById(id); if(el) el.value='';
      });
      var s = document.getElementById('fichaSearchStatus'); if(s) s.selectedIndex=0;
      var w = document.getElementById('fichaSearchResults'); if(w) w.style.display='none';
    }

    function abrirFichaFunc(key) {
      renderFichaTable(key);
      document.getElementById('fichaSearchResults').style.display = 'none';
      document.getElementById('fichaEpiCard').scrollIntoView({behavior:'smooth'});
      showToast('Ficha de '+EPI_RECORDS[key]?.func?.nome+' carregada.', 'success');
    }

    /* Override saveSignature para suportar linha específica */
    function saveSignature() {
      if (!_sigCanvas) { closeSignatureModal(); return; }
      var blank = document.createElement('canvas');
      blank.width = _sigCanvas.width; blank.height = _sigCanvas.height;
      if (_sigCanvas.toDataURL() === blank.toDataURL()) { alert('Por favor, assine antes de confirmar.'); return; }
      var sigImg = _sigCanvas.toDataURL('image/png');
      var rec = EPI_RECORDS[_fichaFuncAtual];

      if (_assinandoLinha >= 0 && rec) {
        // Assinar linha específica — NÃO altera outras
        rec.entregas[_assinandoLinha].assinatura = 'manual';
        rec.entregas[_assinandoLinha]._sigImg    = sigImg;
        _assinandoLinha = -1;
        renderFichaTable(_fichaFuncAtual);
        closeSignatureModal();
        showToast('Linha assinada com sucesso!', 'success');
        return;
      }

      // Assinatura geral (primeira linha pendente)
      if (rec) {
        var pendente = rec.entregas.find(function(e){ return e.assinatura==='pendente'; });
        if (pendente) { pendente.assinatura='manual'; pendente._sigImg=sigImg; }
      }

      // Atualizar preview
      var cell = document.getElementById('fichaAssinaturaCell');
      if (cell) cell.innerHTML =
        '<div style="display:flex;flex-direction:column;align-items:center;gap:2px;padding:2px">' +
        '<img src="'+sigImg+'" style="max-width:100px;max-height:38px;display:block">' +
        '<span style="font-size:8px;font-weight:700;color:#007AFF">ASSINATURA DIGITAL</span>' +
        '<span style="font-size:8px;color:#555">'+new Date().toLocaleDateString('pt-BR')+'</span>' +
        '</div>';

      var preview = document.getElementById('fichaAssinaturaPreview');
      if (preview) {
        preview.style.borderStyle = 'solid'; preview.style.borderColor = '#007AFF';
        preview.innerHTML = '<img src="'+sigImg+'" style="max-width:180px;max-height:56px;display:block;margin:0 auto">';
      }

      var badge = document.getElementById('fichaStatusTrabBadge');
      if (badge) badge.innerHTML = '<span class="badge status-active" style="font-size:11px">✓ Assinatura digital coletada</span>';
      var st = document.getElementById('fichaStatusTrab');
      if (st) st.innerHTML = 'Trabalhador: <span class="badge status-active">Assinado ✓</span>';

      renderFichaTable(_fichaFuncAtual);
      closeSignatureModal();
      showToast('Assinatura coletada e aplicada na ficha!', 'success');
    }


    /* ── FICHA BUSCA — toggle expandir/colapsar ── */
    var _fichaSearchOpen = false;
    function toggleFichaSearch() {
      _fichaSearchOpen = !_fichaSearchOpen;
      var panel   = document.getElementById('fichaSearchPanel');
      var chevron = document.getElementById('fichaSearchChevron');
      var toggle  = document.getElementById('fichaSearchToggle');
      if (!panel) return;
      if (_fichaSearchOpen) {
        panel.style.maxHeight   = panel.scrollHeight + 400 + 'px';
        if (chevron) chevron.style.transform = 'rotate(180deg)';
        if (toggle)  toggle.style.background = 'var(--surface-container-high)';
        // Focus no primeiro campo
        setTimeout(function(){ document.getElementById('fichaSearchFunc')?.focus(); }, 310);
      } else {
        panel.style.maxHeight   = '0';
        if (chevron) chevron.style.transform = 'rotate(0deg)';
        if (toggle)  toggle.style.background = 'var(--surface-container)';
        // Esconder resultados também
        var res = document.getElementById('fichaSearchResults');
        if (res) res.style.display = 'none';
      }
    }


    /* ── DASHBOARD — carregamento via EpiAPI (request/response real) ── */
    async function loadDashboardFromAPI() {
      console.log('%c[Dashboard] Solicitando KPIs...', 'color:#888');
      const res = await EpiAPI.query.dashboardKpis();
      if (!res.ok) { showToast('Erro ao carregar dashboard: ' + res.message, 'error'); return; }

      const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
      set('kpiTotalEntregas',   res.data.totalEntregas);
      set('kpiProximoVencimento', res.data.vencendo);
      set('kpiSolPendentes',    res.data.solPendentes);
      set('kpiFuncAtivos',      res.data.funcAtivos);
      set('kpiSemAssinatura',   res.data.semAssinatura);
      set('kpiCaVencidos',      res.data.caVencidos);

      // Carregar entregas detalhadas para a tabela de prioridades
      const entregasRes = await EpiAPI.query.entregasDetalhadas();
      if (entregasRes.ok) renderDashboardPriorityTable(entregasRes.data);

      console.log('%c[Dashboard] Carregado:', 'color:#34C759', res.data);
    }

    function renderDashboardPriorityTable(entregas) {
      const body = document.getElementById('dashboardPriorityBody');
      if (!body) return;
      const hoje = new Date();
      const rows = entregas
        .filter(e => e.status === 'Ativo')
        .map(e => {
          const venc = e.data_vencimento ? new Date(e.data_vencimento) : null;
          const dias = venc ? Math.ceil((venc - hoje) / 86400000) : null;
          return { ...e, dias };
        })
        .filter(e => e.dias !== null && e.dias <= 30)
        .sort((a,b) => a.dias - b.dias)
        .slice(0, 8);

      if (!rows.length) {
        body.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--on-surface-variant);padding:20px">Nenhum item próximo do vencimento de uso.</td></tr>';
        return;
      }

      body.innerHTML = rows.map(e => {
        const badgeCls = e.dias < 0 ? 'background:rgba(255,59,48,0.12);color:#C0221A'
                       : e.dias <= 15 ? 'background:rgba(255,149,0,0.12);color:#C07000'
                       : 'background:rgba(52,199,89,0.12);color:#1A7A35';
        const label = e.dias < 0 ? `Vencido há ${Math.abs(e.dias)}d` : `${e.dias}d restantes`;
        return `<tr>
          <td><strong>${e.funcionario?.nome || '—'}</strong></td>
          <td>${e.funcionario?.setor || '—'}</td>
          <td>${e.material?.nome || '—'}</td>
          <td>${e.assinatura_tipo === 'pendente' ? '<span class="badge role-supervisor">Pendente</span>' : '<span class="badge status-active">Assinado</span>'}</td>
          <td><span class="badge" style="${badgeCls}">${label}</span></td>
        </tr>`;
      }).join('');
    }


    /* ── SOLICITAÇÕES — request/response real via EpiAPI ── */
    async function loadSolicitacoesFromAPI(filtroStatus) {
      console.log('%c[Solicitações] GET /solicitacoes?status=' + (filtroStatus||'todas'), 'color:#888');
      const res = await EpiAPI.query.solicitacoesDetalhadas(filtroStatus);
      if (!res.ok) { showToast('Erro ao buscar solicitações', 'error'); return; }
      renderSolicitacoesTable(res.data);
      return res.data;
    }

    function renderSolicitacoesTable(rows) {
      const body = document.getElementById('supervisorApprovalBody') || document.getElementById('stockRequestsBody');
      if (!body) return;
      if (!rows.length) {
        body.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--on-surface-variant);padding:20px">Nenhuma solicitação encontrada.</td></tr>';
        return;
      }
      body.innerHTML = rows.map(s => {
        const statusBadge = {
          PENDENTE:  'background:rgba(255,149,0,0.12);color:#C07000',
          APROVADA:  'background:rgba(52,199,89,0.12);color:#1A7A35',
          REPROVADA: 'background:rgba(255,59,48,0.12);color:#C0221A',
          ENTREGUE:  'background:rgba(0,122,255,0.12);color:#0056CC',
        }[s.status] || '';
        return `<tr>
          <td><span class="badge role-user" style="font-size:10px">${s.codigo}</span></td>
          <td><strong>${s.funcionario?.nome}</strong></td>
          <td>${s.material?.nome}</td>
          <td>${new Date(s.criado_em).toLocaleDateString('pt-BR')}</td>
          <td><span class="badge" style="${statusBadge}">${s.status}</span></td>
          <td>
            ${s.status === 'PENDENTE' ? `
              <button class="mini-btn" onclick="aprovarSolicitacao(${s.id})" style="color:#34C759">Aprovar</button>
              <button class="mini-btn" onclick="reprovarSolicitacaoPrompt(${s.id})" style="color:#FF3B30">Reprovar</button>
            ` : '—'}
          </td>
        </tr>`;
      }).join('');
    }

    async function aprovarSolicitacao(id) {
      console.log('%c[Solicitações] POST /solicitacoes/' + id + '/aprovar', 'color:#888');
      const res = await EpiAPI.request('POST', `/solicitacoes/${id}/aprovar`, { aprovado_por: (CURRENT_USER && CURRENT_USER.id) || 3 });
      if (res.ok) { showToast('Solicitação aprovada!', 'success'); loadSolicitacoesFromAPI(); }
      else showToast('Erro: ' + res.message, 'error');
    }

    async function reprovarSolicitacaoPrompt(id) {
      const justificativa = prompt('Motivo da reprovação:');
      if (!justificativa) return;
      console.log('%c[Solicitações] POST /solicitacoes/' + id + '/reprovar', 'color:#888');
      const res = await EpiAPI.request('POST', `/solicitacoes/${id}/reprovar`, { aprovado_por: (CURRENT_USER && CURRENT_USER.id) || 3, justificativa });
      if (res.ok) { showToast('Solicitação reprovada.', 'warning'); loadSolicitacoesFromAPI(); }
      else showToast('Erro: ' + res.message, 'error');
    }

    async function criarSolicitacao(payload) {
      console.log('%c[Solicitações] POST /solicitacoes', 'color:#888', payload);
      const res = await EpiAPI.request('POST', '/solicitacoes', {
        codigo: 'PED-' + String(Date.now()).slice(-4),
        status: 'PENDENTE', aprovado_por: null, justif_reprov: null,
        ...payload,
      });
      if (res.ok) showToast('Solicitação enviada para aprovação!', 'success');
      else showToast('Erro ao criar solicitação', 'error');
      return res;
    }

    var CURRENT_USER = { id: 1, nome: 'Luis Freitas', perfil: 'MASTER' };


    /* ── MATERIAIS / COMPRAS — request/response real via EpiAPI ── */
    async function loadMateriaisFromAPI() {
      console.log('%c[Materiais] GET /materiais (com estoque)', 'color:#888');
      const res = await EpiAPI.query.materiaisComEstoque();
      if (!res.ok) { showToast('Erro ao carregar materiais', 'error'); return []; }
      return res.data;
    }

    async function popularSelectMateriais(selectId) {
      const materiais = await loadMateriaisFromAPI();
      const sel = document.getElementById(selectId);
      if (!sel) return;
      sel.innerHTML = '<option value="">Selecionar material...</option>' +
        materiais.map(m => `<option value="${m.id}">${m.nome}</option>`).join('');
    }

    async function updateSizeChipsFromStockAPI(materialId) {
      const grid = document.getElementById('sizeChipsGrid');
      if (!grid) return;
      console.log('%c[Materiais] GET /materiais/' + materialId, 'color:#888');
      const res = await EpiAPI.request('GET', `/materiais/${materialId}`);
      if (!res.ok) return;
      const minimo = res.data.estoque_minimo || 5;
      const dbObj  = EpiAPI._db();
      const tamanhos = dbObj.estoque_tamanhos.filter(t => t.material_id === materialId);

      grid.querySelectorAll('.size-chip').forEach(chip => {
        const tam = chip.textContent.trim();
        const t = tamanhos.find(x => x.tamanho === tam);
        if (!t) return;
        chip.classList.remove('chip-ok','chip-warning','chip-empty');
        if (t.quantidade <= 0) chip.classList.add('chip-empty');
        else if (t.quantidade < minimo) chip.classList.add('chip-warning');
        else chip.classList.add('chip-ok');
        chip.title = `${tam}: ${t.quantidade} em estoque`;
      });
    }

    async function registrarCompra(materialId, tamanho, quantidade, extra) {
      console.log('%c[Compras] POST /materiais/' + materialId + '/entrada-estoque', 'color:#888', { tamanho, quantidade });
      const res = await EpiAPI.request('POST', `/materiais/${materialId}/entrada-estoque`, {
        tamanho, quantidade: Number(quantidade), responsavel_id: CURRENT_USER.id, ...extra
      });
      if (res.ok) {
        showToast(`Estoque atualizado: +${quantidade} ${tamanho}`, 'success');
        updateSizeChipsFromStockAPI(materialId);
      } else {
        showToast('Erro ao registrar compra: ' + res.message, 'error');
      }
      return res;
    }

    async function cadastrarMaterial(payload) {
      console.log('%c[Materiais] POST /materiais', 'color:#888', payload);
      const res = await EpiAPI.request('POST', '/materiais', payload);
      if (res.ok) showToast('Material cadastrado com sucesso!', 'success');
      else showToast('Erro ao cadastrar material', 'error');
      return res;
    }


    /* ── FICHA DE EPI — request/response real via EpiAPI ── */
    var _fichaAtualId = null;

    async function loadFichaFromAPI(funcionarioId) {
      console.log('%c[Ficha EPI] GET /funcionarios/' + funcionarioId + ' (completo)', 'color:#888');
      const res = await EpiAPI.query.funcionarioCompleto(funcionarioId);
      if (!res.ok) { showToast('Funcionário não encontrado', 'error'); return; }

      const func = res.data;
      const set = (id, v) => { const el = document.getElementById(id); if (el && v != null) el.textContent = v; };
      set('fichaNome', func.nome);
      set('fichaCpf', func.cpf ? '***.***.' + func.cpf.slice(6,9) + '-' + func.cpf.slice(9) : '');
      set('fichaFuncao', func.funcao);
      set('fichaSetor', func.setor);
      set('fichaMatricula', func.matricula);
      set('fichaNomeSig', func.nome);
      set('fichaCargo', `${func.funcao||''} · ${func.setor||''}`);

      const ultimaFicha = func.fichas?.[0];
      if (ultimaFicha) {
        _fichaAtualId = ultimaFicha.id;
        set('fichaNumLabel', `Ficha #${ultimaFicha.numero} — ${new Date(ultimaFicha.criado_em).toLocaleDateString('pt-BR')}`);
        renderFichaTableFromAPI(ultimaFicha.entregas);
      }
      console.log('%c[Ficha EPI] Carregada:', 'color:#34C759', func);
    }

    function renderFichaTableFromAPI(entregas) {
      const body = document.getElementById('fichaEpiTableBody');
      if (!body) return;
      body.innerHTML = entregas.map((e, idx) => {
        let sigCell;
        if (e.assinatura_tipo === 'manual' && e.assinatura_img) {
          sigCell = `<div style="display:flex;flex-direction:column;align-items:center;gap:2px;padding:2px">
            <img src="${e.assinatura_img}" style="max-width:100px;max-height:38px">
            <span style="font-size:8px;font-weight:700;color:#007AFF">ASSINATURA DIGITAL</span></div>`;
        } else if (e.assinatura_tipo === 'digital') {
          sigCell = `<div style="display:flex;flex-direction:column;align-items:center;gap:2px;padding:4px">
            <span class="material-symbols-outlined" style="font-size:22px;color:#34C759">fingerprint</span>
            <span style="font-size:8px;font-weight:700;color:#34C759">ACEITE DIGITAL</span></div>`;
        } else if (e.assinatura_tipo === 'manual') {
          sigCell = `<div style="display:flex;flex-direction:column;align-items:center;gap:2px;padding:4px">
            <span class="material-symbols-outlined" style="font-size:20px;color:#007AFF">draw</span>
            <span style="font-size:8px;font-weight:700;color:#007AFF">ASSINADO</span></div>`;
        } else {
          sigCell = `<button onclick="assinarEntregaAPI(${e.id})" type="button"
            style="background:var(--primary);color:#fff;border:none;border-radius:8px;padding:4px 10px;font-size:10px;cursor:pointer">
            <span class="material-symbols-outlined" style="font-size:11px;vertical-align:-2px">gesture</span> Assinar</button>`;
        }
        const bg = idx % 2 === 0 ? '' : 'background:#f0f4fb';
        return `<tr style="${bg}">
          <td style="padding:5px 6px;border:0.5px solid #ccc;text-align:center;font-size:10px">${new Date(e.data_entrega).toLocaleString('pt-BR')}</td>
          <td style="padding:5px 6px;border:0.5px solid #ccc;font-weight:600;font-size:11px">${e.material?.nome||''}</td>
          <td style="padding:5px 6px;border:0.5px solid #ccc;text-align:center;font-size:10px">${e.material?.ca_numero||'—'}</td>
          <td style="padding:5px 6px;border:0.5px solid #ccc;text-align:center;font-size:10px">${e.material?.ca_validade ? new Date(e.material.ca_validade).toLocaleDateString('pt-BR') : '—'}</td>
          <td style="padding:5px 6px;border:0.5px solid #ccc;text-align:center;font-size:10px">${e.quantidade}</td>
          <td style="padding:5px 6px;border:0.5px solid #ccc;text-align:center;font-size:10px">${e.condicao}</td>
          <td style="padding:2px 4px;border:0.5px solid #ccc">${sigCell}</td>
          <td style="padding:5px 6px;border:0.5px solid #ccc;text-align:center;font-size:10px">${e.data_devolucao||''}</td>
        </tr>`;
      }).join('');
    }

    async function assinarEntregaAPI(entregaId, tipo, imagem) {
      console.log('%c[Ficha EPI] POST /entregas_epi/' + entregaId + '/assinar', 'color:#888', { tipo });
      const res = await EpiAPI.request('POST', `/entregas_epi/${entregaId}/assinar`, { tipo: tipo || 'manual', imagem });
      if (res.ok) {
        showToast('Assinatura registrada!', 'success');
        const ficha = EpiAPI._db().fichas_epi.find(f => f.id === _fichaAtualId);
        if (ficha) loadFichaFromAPI(ficha.funcionario_id);
      }
      return res;
    }

    async function buscarFichasAPI(filtros) {
      console.log('%c[Ficha EPI] GET /_query/buscar-fichas', 'color:#888', filtros);
      const res = await EpiAPI.query.buscarFichas(filtros);
      return res.data;
    }


    /* ── HISTÓRICO + AUDITORIA — request/response real via EpiAPI ── */
    async function openHistoryModalAPI(query) {
      console.log('%c[Histórico] GET /_query/funcionario-completo', 'color:#888', query);
      const db = EpiAPI._db();
      let func = db.funcionarios.find(f =>
        f.nome.toLowerCase().includes((query||'').toLowerCase()) ||
        f.matricula.toLowerCase().includes((query||'').toLowerCase()) ||
        f.cpf.includes(query||'')
      );
      if (!func) func = db.funcionarios[0];

      const res = await EpiAPI.query.funcionarioCompleto(func.id);
      if (!res.ok) { showToast('Funcionário não encontrado', 'error'); return; }

      const data = res.data;
      const allEntregas = data.fichas.flatMap(f => f.entregas);

      document.getElementById('historyModalName').textContent = 'Histórico — ' + data.nome;
      document.getElementById('historyModalMeta').textContent = `${data.matricula} · ${data.setor} · ${data.cracha||''}`;
      document.getElementById('hkpi1').textContent = allEntregas.length;
      document.getElementById('hkpi2').textContent = new Set(allEntregas.map(e=>e.material_id)).size;
      document.getElementById('hkpi3').textContent = allEntregas[0] ? new Date(allEntregas[0].data_entrega).toLocaleDateString('pt-BR') : '—';
      document.getElementById('hkpi4').textContent = allEntregas.filter(e=>e.status==='Ativo').length;

      document.getElementById('historyModal').classList.add('open');
      console.log('%c[Histórico] Carregado:', 'color:#34C759', data);
    }

    async function loadAuditoriaFromAPI() {
      console.log('%c[Auditoria] GET /logs_auditoria (detalhado)', 'color:#888');
      const res = await EpiAPI.query.logsDetalhados();
      if (!res.ok) return;
      const body = document.getElementById('auditLogBody');
      if (!body) return;
      body.innerHTML = res.data.slice(0, 50).map(l => `<tr>
        <td style="white-space:nowrap;font-size:12px">${new Date(l.criado_em).toLocaleString('pt-BR')}</td>
        <td><strong>${l.usuario?.nome || 'Sistema'}</strong></td>
        <td><span class="badge role-${(l.usuario?.perfil||'').toLowerCase()}" style="font-size:10px">${l.usuario?.perfil||'—'}</span></td>
        <td>${l.acao}</td>
        <td>${l.referencia||''}</td>
        <td style="font-size:12px;color:var(--on-surface-variant)">${l.ip} · ${l.dispositivo}</td>
      </tr>`).join('');
    }


    /* ── AUTOATENDIMENTO (TOTEM) — identificação por CPF + data nascimento ── */

    function formatCpfInput(el) {
      let v = el.value.replace(/\D/g, '').slice(0, 11);
      if (v.length > 9)  v = v.replace(/(\d{3})(\d{3})(\d{3})(\d{0,2})/, '$1.$2.$3-$4');
      else if (v.length > 6) v = v.replace(/(\d{3})(\d{3})(\d{0,3})/, '$1.$2.$3');
      else if (v.length > 3) v = v.replace(/(\d{3})(\d{0,3})/, '$1.$2');
      el.value = v;
    }

    async function selfServiceLogin() {
      const cpfRaw = (document.getElementById('selfCpf').value || '').replace(/\D/g, '');
      const birth  = document.getElementById('selfBirth').value; // yyyy-mm-dd
      const errBox = document.getElementById('selfServiceError');

      if (cpfRaw.length !== 11 || !birth) {
        errBox.style.display = 'block';
        errBox.querySelector('.notice').textContent = 'Preencha o CPF completo e a data de nascimento.';
        return;
      }

      console.log('%c[Autoatendimento] GET /_query/identificar-funcionario', 'color:#888', { cpf: cpfRaw, birth });

      // Consultar o banco real via EpiAPI
      const db = EpiAPI._db();
      const funcionario = db.funcionarios.find(f =>
        f.cpf === cpfRaw && f.data_nascimento === birth && f.ativo
      );

      if (!funcionario) {
        errBox.style.display = 'block';
        errBox.querySelector('.notice').textContent = 'CPF ou data de nascimento não encontrados. Verifique os dados ou procure o RH.';
        showToast('Identificação não encontrada', 'error');
        console.log('%c[Autoatendimento] Funcionário não encontrado', 'color:#FF3B30');
        return;
      }

      errBox.style.display = 'none';
      console.log('%c[Autoatendimento] Identificado:', 'color:#34C759', funcionario);

      // Define o funcionário atual da sessão de autoatendimento
      window.SELF_SERVICE_USER = funcionario;

      // Preencher automaticamente a tela de Pedido de EPI com os dados reais
      const elName  = document.getElementById('requestEmployee');
      const elBadge = document.getElementById('requestBadge');
      const elCpf   = document.getElementById('requestCpfMasked');
      if (elName)  elName.value  = funcionario.nome;
      if (elBadge) elBadge.value = funcionario.cracha || '—';
      if (elCpf)   elCpf.value   = '***.***.' + funcionario.cpf.slice(6,9) + '-' + funcionario.cpf.slice(9);

      showToast('Bem-vindo(a), ' + funcionario.nome.split(' ')[0] + '!', 'success');

      // Log de auditoria real
      EpiAPI._db().logs_auditoria.push({
        id: (EpiAPI._db().logs_auditoria.length + 1),
        usuario_id: null,
        acao: 'AUTOATENDIMENTO_LOGIN',
        referencia: `Funcionário: ${funcionario.nome} (${funcionario.matricula})`,
        descricao: 'Identificação via CPF + data de nascimento (totem)',
        ip: '127.0.0.1', dispositivo: navigator.userAgent.slice(0,60),
        criado_em: new Date().toISOString(),
      });

      // Navegar para a tela de pedido
      setTimeout(() => {
        showView('requestView');
        const navLink = document.querySelector('.nav a[data-page="request"]');
        if (navLink) setActiveNav(navLink);
        selfServiceStartSession();
      }, 600);
    }

    // Limpar campos de identificação ao reabrir a tela de autoatendimento
    var _selfServiceShowOrig = typeof showView === 'function' ? null : null;


    /* ═══════════════════════════════════════════════════════════════════
       MODO QUIOSQUE — bloqueio de navegação para totens/chão de fábrica
    ═══════════════════════════════════════════════════════════════════ */
    var KIOSK_KEY = 'epi-kiosk-mode';

    function isKioskActive() {
      try { return localStorage.getItem(KIOSK_KEY) !== null; } catch(e) { return false; }
    }

    function openKioskActivateModal() {
      document.getElementById('kioskActivateModal').classList.add('open');
    }
    function closeKioskActivateModal(event) {
      if (event && event.target && event.target.id !== 'kioskActivateModal') return;
      document.getElementById('kioskActivateModal').classList.remove('open');
    }

    function activateKioskMode() {
      var pass = document.getElementById('kioskPassword').value.trim();
      if (pass.length < 4) { alert('A senha deve ter no mínimo 4 dígitos.'); return; }
      try { localStorage.setItem(KIOSK_KEY, pass); } catch(e) {}
      closeKioskActivateModal();
      showToast('Modo Quiosque ativado. Indo para Autoatendimento...', 'success');
      setTimeout(function() {
        engageKioskLock();
        showView('selfServiceView');
      }, 600);
    }

    function engageKioskLock() {
      document.getElementById('kioskLockOverlay').style.display = 'flex';
      // Esconde a sidebar e o botão sanduíche por trás do overlay
      document.body.classList.add('kiosk-locked');
      var sIcon = document.getElementById('kioskStatusIcon');
      var sLabel = document.getElementById('kioskStatusLabel');
      if (sIcon)  { sIcon.textContent = 'lock'; sIcon.style.color = '#007AFF'; }
      if (sLabel) sLabel.textContent = 'Modo Quiosque ativado neste dispositivo';
    }

    function unlockKioskMode() {
      var input = document.getElementById('kioskUnlockInput');
      var saved = '';
      try { saved = localStorage.getItem(KIOSK_KEY) || ''; } catch(e) {}
      var errEl = document.getElementById('kioskUnlockError');

      if (input.value === saved) {
        try { localStorage.removeItem(KIOSK_KEY); } catch(e) {}
        document.getElementById('kioskLockOverlay').style.display = 'none';
        document.body.classList.remove('kiosk-locked');
        input.value = '';
        errEl.style.display = 'none';
        showToast('Modo Quiosque desativado.', 'success');
        var sIcon = document.getElementById('kioskStatusIcon');
        var sLabel = document.getElementById('kioskStatusLabel');
        if (sIcon)  { sIcon.textContent = 'lock_open'; sIcon.style.color = 'var(--on-surface-variant)'; }
        if (sLabel) sLabel.textContent = 'Modo Quiosque desativado';
      } else {
        errEl.style.display = 'block';
        input.value = '';
        input.focus();
      }
    }

    // Ao carregar a página, se o quiosque já estava ativo (refresh/recarregar), reengajar o bloqueio
    document.addEventListener('DOMContentLoaded', function() {
      if (isKioskActive()) {
        setTimeout(function() {
          engageKioskLock();
          showView('selfServiceView');
        }, 200);
      }
    });

    /* ─── Interceptar showView para impedir navegação para fora do
           autoatendimento enquanto o Modo Quiosque estiver ativo ─── */
    var _kioskShowViewOrig = showView;
    showView = function(viewId) {
      var ALLOWED_IN_KIOSK = ['selfServiceView', 'requestView'];
      if (isKioskActive() && ALLOWED_IN_KIOSK.indexOf(viewId) === -1) {
        showToast('Navegação bloqueada — Modo Quiosque ativo.', 'warning');
        return;
      }
      _kioskShowViewOrig(viewId);
    };


    /* ═══════════════════════════════════════════════════════════════════
       SESSÃO DE AUTOATENDIMENTO — timeout de inatividade + logout
    ═══════════════════════════════════════════════════════════════════ */
    var SELF_SERVICE_TIMEOUT_S = 60; // segundos de inatividade até logout automático
    var _selfServiceCountdownVal = SELF_SERVICE_TIMEOUT_S;
    var _selfServiceTimer = null;
    var _selfServiceInterval = null;

    function selfServiceStartSession() {
      var bar = document.getElementById('selfServiceSessionBar');
      if (bar) bar.style.display = 'block';
      resetSelfServiceTimer();

      // Qualquer interação na tela reseta o cronômetro
      ['click','keydown','touchstart','mousemove'].forEach(function(evt) {
        document.addEventListener(evt, resetSelfServiceTimer);
      });
    }

    function resetSelfServiceTimer() {
      if (!window.SELF_SERVICE_USER) return; // só conta enquanto há sessão ativa
      _selfServiceCountdownVal = SELF_SERVICE_TIMEOUT_S;
      var el = document.getElementById('selfServiceCountdown');
      if (el) el.textContent = _selfServiceCountdownVal;

      clearInterval(_selfServiceInterval);
      _selfServiceInterval = setInterval(function() {
        _selfServiceCountdownVal--;
        var el2 = document.getElementById('selfServiceCountdown');
        if (el2) el2.textContent = _selfServiceCountdownVal;
        if (_selfServiceCountdownVal <= 0) {
          clearInterval(_selfServiceInterval);
          showToast('Sessão encerrada por inatividade.', 'warning');
          selfServiceLogout();
        }
      }, 1000);
    }

    function selfServiceLogout() {
      clearInterval(_selfServiceInterval);
      ['click','keydown','touchstart','mousemove'].forEach(function(evt) {
        document.removeEventListener(evt, resetSelfServiceTimer);
      });

      // Log de auditoria de saída
      if (window.SELF_SERVICE_USER) {
        EpiAPI._db().logs_auditoria.push({
          id: (EpiAPI._db().logs_auditoria.length + 1),
          usuario_id: null,
          acao: 'AUTOATENDIMENTO_LOGOUT',
          referencia: 'Funcionário: ' + window.SELF_SERVICE_USER.nome,
          descricao: 'Sessão encerrada (manual ou por inatividade)',
          ip: '127.0.0.1', dispositivo: navigator.userAgent.slice(0,60),
          criado_em: new Date().toISOString(),
        });
      }

      window.SELF_SERVICE_USER = null;
      var bar = document.getElementById('selfServiceSessionBar');
      if (bar) bar.style.display = 'none';

      // Limpar campos preenchidos da tela de pedido
      var elName  = document.getElementById('requestEmployee');
      var elBadge = document.getElementById('requestBadge');
      var elCpf   = document.getElementById('requestCpfMasked');
      if (elName)  elName.value  = '';
      if (elBadge) elBadge.value = '';
      if (elCpf)   elCpf.value   = '';

      showToast('Até logo! Sessão encerrada.', 'info');
      showView('selfServiceView');
    }


    /* ═══════════════════════════════════════════════════════════════════
       SISTEMA DE LOGIN — autenticação, recuperação de senha e biometria
    ═══════════════════════════════════════════════════════════════════ */

    var SESSION_KEY = 'epi-session-user';
    var _recoveryCode = null;
    var _recoveryUserId = null;

    function showLoginPanel(panelId) {
      ['loginPanel','recoverPanel','biometricSetupPanel'].forEach(function(id) {
        var el = document.getElementById(id);
        if (el) el.style.display = (id === panelId) ? 'block' : 'none';
      });
      // Reset etapas de recuperação
      document.getElementById('recoverStep1').style.display = 'block';
      document.getElementById('recoverStep2').style.display = 'none';
      var err = document.getElementById('loginError'); if (err) err.style.display = 'none';
    }

    /* ── LOGIN NORMAL (e-mail + senha contra o banco real) ── */
    function doLogin() {
      var email = (document.getElementById('loginEmail').value || '').trim().toLowerCase();
      var senha = document.getElementById('loginPassword').value || '';
      var errEl = document.getElementById('loginError');

      console.log('%c[Login] POST /auth/login', 'color:#888', { email });

      var db = EpiAPI._db();
      var user = db.usuarios.find(function(u) {
        return u.email.toLowerCase() === email && u.senha === senha && u.ativo;
      });

      if (!user) {
        errEl.style.display = 'block';
        showToast('E-mail ou senha incorretos', 'error');
        console.log('%c[Login] Falhou — credenciais inválidas', 'color:#FF3B30');
        return;
      }

      errEl.style.display = 'none';
      completeLogin(user);
    }

    function completeLogin(user) {
      var sessionData = { id: user.id, nome: user.nome, perfil: user.perfil, email: user.email };

      // Tentativa 1: localStorage (funciona com Live Server / mesma origem)
      try { localStorage.setItem(SESSION_KEY, JSON.stringify(sessionData)); } catch(e) {}
      // Tentativa 2: sessionStorage (fallback adicional)
      try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(sessionData)); } catch(e) {}
      // Tentativa 3: cookie (funciona mesmo em file:// entre páginas na mesma pasta)
      try { document.cookie = SESSION_KEY + '=' + encodeURIComponent(JSON.stringify(sessionData)) + ';path=/;max-age=28800'; } catch(e) {}

      CURRENT_USER = { id: user.id, nome: user.nome, perfil: user.perfil };

      EpiAPI._db().logs_auditoria.push({
        id: (EpiAPI._db().logs_auditoria.length + 1),
        usuario_id: user.id, acao: 'LOGIN', referencia: user.nome,
        descricao: 'Login realizado no sistema principal',
        ip: '127.0.0.1', dispositivo: navigator.userAgent.slice(0,60),
        criado_em: new Date().toISOString(),
      });

      showToast('Bem-vindo(a), ' + user.nome.split(' ')[0] + '!', 'success');
      document.getElementById('loginScreen').style.display = 'none';

      // Reescrever todos os links do menu para propagar a sessão via querystring
      // (garante login persistente mesmo quando localStorage não é compartilhado entre arquivos file://)
      watchNavLinksForSession();

      console.log('%c[Login] Sucesso:', 'color:#34C759', user);
    }

    /* Anexa ?_s=<sessão codificada> em todos os links do menu lateral.
       Roda DEPOIS do fileMap (que troca javascript:void(0) pelo arquivo real),
       então sempre vê o href final — nunca perde a corrida entre os dois scripts. */
    function appendSessionToNavLinks() {
      var saved = getStoredSession();
      if (!saved) return;
      var encoded = encodeURIComponent(btoa(JSON.stringify(saved)));
      document.querySelectorAll('.nav a[href]').forEach(function(a) {
        var href = a.getAttribute('href');
        if (!href || href.startsWith('javascript:')) return; // ainda não foi mapeado — ignorar por ora
        var base = href.split('?')[0];
        var newHref = base + '?_s=' + encoded;
        if (href === newHref) return; // já está correto — não tocar no DOM (evita trabalho/mutação desnecessária)
        a.setAttribute('href', newHref);
      });
    }

    /* Observa mudanças nos links do menu (criados/alterados por outro script)
       e garante que QUALQUER link, a qualquer momento, sempre tenha o token de sessão. */
    function watchNavLinksForSession() {
      // Sem MutationObserver — observar 'href' e também escrever em 'href' causava
      // loop infinito de mutação (o próprio observer disparava a si mesmo, travando a aba).
      // Em vez disso, reaplicamos algumas vezes em janelas de tempo curtas, o que é
      // suficiente para cobrir a corrida com o script inline que troca javascript:void(0).
      appendSessionToNavLinks();
      setTimeout(appendSessionToNavLinks, 50);
      setTimeout(appendSessionToNavLinks, 200);
      setTimeout(appendSessionToNavLinks, 600);
      setTimeout(appendSessionToNavLinks, 1200);
    }

    /* Lê a sessão tentando, em ordem: localStorage, sessionStorage, cookie, querystring da URL atual */
    function getStoredSession() {
      try {
        var fromLocal = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
        if (fromLocal) return fromLocal;
      } catch(e) {}
      try {
        var fromSession = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
        if (fromSession) return fromSession;
      } catch(e) {}
      try {
        var match = document.cookie.match(new RegExp('(?:^|; )' + SESSION_KEY + '=([^;]*)'));
        if (match) return JSON.parse(decodeURIComponent(match[1]));
      } catch(e) {}
      try {
        var params = new URLSearchParams(window.location.search);
        var token = params.get('_s');
        if (token) return JSON.parse(atob(decodeURIComponent(token)));
      } catch(e) {}
      return null;
    }

    function doLogout() {
      try { localStorage.removeItem(SESSION_KEY); } catch(e) {}
      try { sessionStorage.removeItem(SESSION_KEY); } catch(e) {}
      try { document.cookie = SESSION_KEY + '=;path=/;max-age=0'; } catch(e) {}
      // Remover token da URL atual e dos links do menu
      try {
        var url = new URL(window.location.href);
        url.searchParams.delete('_s');
        window.history.replaceState({}, '', url.toString());
      } catch(e) {}
      document.querySelectorAll('.nav a[href]').forEach(function(a) {
        var href = a.getAttribute('href');
        if (href) a.setAttribute('href', href.split('?')[0]);
      });
      CURRENT_USER = null;
      document.getElementById('loginScreen').style.display = 'flex';
      showLoginPanel('loginPanel');
      document.getElementById('loginEmail').value = '';
      document.getElementById('loginPassword').value = '';
      showToast('Sessão encerrada.', 'info');
    }

    /* ── RECUPERAÇÃO DE SENHA (simulada — código no console) ── */
    function sendRecoveryCode() {
      var email = (document.getElementById('recoverEmail').value || '').trim().toLowerCase();
      var db = EpiAPI._db();
      var user = db.usuarios.find(function(u) { return u.email.toLowerCase() === email; });

      if (!user) {
        showToast('E-mail não encontrado no sistema.', 'error');
        return;
      }

      _recoveryCode   = String(Math.floor(100000 + Math.random() * 900000));
      _recoveryUserId = user.id;

      console.log('%c[Recuperação de senha] Código gerado para ' + email + ':', 'color:#FF9500;font-weight:700;font-size:14px', _recoveryCode);
      console.log('%c(Em produção, este código seria enviado por e-mail real)', 'color:#888');

      document.getElementById('recoverEmailDisplay').textContent = email;
      document.getElementById('recoverStep1').style.display = 'none';
      document.getElementById('recoverStep2').style.display = 'block';
      showToast('Código enviado! Verifique o console (F12) na simulação.', 'info');
    }

    function confirmPasswordReset() {
      var code = document.getElementById('recoverCode').value.trim();
      var newPass = document.getElementById('recoverNewPassword').value;

      if (code !== _recoveryCode) {
        showToast('Código de verificação incorreto.', 'error');
        return;
      }
      if (newPass.length < 8) {
        showToast('A nova senha deve ter no mínimo 8 caracteres.', 'error');
        return;
      }

      var db = EpiAPI._db();
      var user = db.usuarios.find(function(u) { return u.id === _recoveryUserId; });
      if (user) {
        user.senha = newPass;
        console.log('%c[Recuperação de senha] Senha redefinida para ' + user.email, 'color:#34C759');
      }

      _recoveryCode = null; _recoveryUserId = null;
      showToast('Senha redefinida com sucesso! Faça login.', 'success');
      showLoginPanel('loginPanel');
      document.getElementById('loginEmail').value = user ? user.email : '';
    }

    /* ── LOGIN BIOMÉTRICO via WebAuthn (Touch ID / Face ID / Windows Hello) ── */
    function webAuthnSupported() {
      return !!(window.PublicKeyCredential && navigator.credentials);
    }

    async function registerBiometrics() {
      var email = (document.getElementById('biometricEmail').value || '').trim().toLowerCase();
      var senha = document.getElementById('biometricPassword').value || '';
      var db    = EpiAPI._db();
      var user  = db.usuarios.find(function(u) { return u.email.toLowerCase() === email && u.senha === senha; });

      if (!user) { showToast('E-mail ou senha incorretos.', 'error'); return; }

      if (!webAuthnSupported()) {
        document.getElementById('biometricUnsupported').style.display = 'block';
        showToast('Biometria não suportada neste dispositivo.', 'error');
        return;
      }

      try {
        console.log('%c[WebAuthn] Iniciando cadastro de credencial biométrica...', 'color:#888');

        var challenge = new Uint8Array(32);
        crypto.getRandomValues(challenge);
        var userIdBytes = new TextEncoder().encode(String(user.id));

        var credential = await navigator.credentials.create({
          publicKey: {
            challenge: challenge,
            rp: { name: 'Gestão de EPIs — Cobresul' },
            user: { id: userIdBytes, name: user.email, displayName: user.nome },
            pubKeyCredParams: [{ alg: -7, type: 'public-key' }, { alg: -257, type: 'public-key' }],
            authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required' },
            timeout: 60000,
          }
        });

        // Salvar referência da credencial (id) vinculada ao usuário
        var credId = btoa(String.fromCharCode.apply(null, new Uint8Array(credential.rawId)));
        try { localStorage.setItem('epi-biometric-' + user.id, credId); } catch(e) {}
        user.biometria_cadastrada = true;

        console.log('%c[WebAuthn] Biometria cadastrada com sucesso!', 'color:#34C759', credential);
        showToast('Biometria cadastrada! Use o botão "Entrar com biometria" no próximo acesso.', 'success');
        showLoginPanel('loginPanel');
        checkBiometricAvailability();
      } catch (err) {
        console.error('[WebAuthn] Erro ao cadastrar biometria:', err);
        showToast('Cadastro de biometria cancelado ou falhou.', 'error');
      }
    }

    async function loginWithBiometrics() {
      if (!webAuthnSupported()) { showToast('Biometria não suportada.', 'error'); return; }

      try {
        console.log('%c[WebAuthn] Solicitando verificação biométrica...', 'color:#888');
        var challenge = new Uint8Array(32);
        crypto.getRandomValues(challenge);

        var assertion = await navigator.credentials.get({
          publicKey: { challenge: challenge, timeout: 60000, userVerification: 'required' }
        });

        // Encontrar o usuário pela credencial usada
        var credId = btoa(String.fromCharCode.apply(null, new Uint8Array(assertion.rawId)));
        var db = EpiAPI._db();
        var matchedUser = db.usuarios.find(function(u) {
          var saved = localStorage.getItem('epi-biometric-' + u.id);
          return saved === credId;
        });

        if (!matchedUser) {
          showToast('Biometria não reconhecida. Faça login com e-mail e senha.', 'error');
          return;
        }

        console.log('%c[WebAuthn] Verificação bem-sucedida!', 'color:#34C759', matchedUser.nome);
        completeLogin(matchedUser);
      } catch (err) {
        console.error('[WebAuthn] Erro na verificação biométrica:', err);
        showToast('Verificação biométrica cancelada ou falhou.', 'warning');
      }
    }

    /* Mostrar botão de biometria apenas se já houver credencial cadastrada para ALGUM usuário */
    function checkBiometricAvailability() {
      var db = EpiAPI._db();
      var anyRegistered = db.usuarios.some(function(u) { return u.biometria_cadastrada; });
      var btn = document.getElementById('biometricLoginBtn');
      if (btn) btn.style.display = (anyRegistered && webAuthnSupported()) ? 'flex' : 'none';
    }

    /* ── Verificar sessão existente ao carregar a página ── */
    document.addEventListener('DOMContentLoaded', function() {
      checkBiometricAvailability();
      var saved = getStoredSession();
      if (saved) {
        CURRENT_USER = saved;
        document.getElementById('loginScreen').style.display = 'none';
        // Re-persistir em todas as camadas (garante que sobrevive mesmo se só uma funcionou)
        try { localStorage.setItem(SESSION_KEY, JSON.stringify(saved)); } catch(e) {}
        try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(saved)); } catch(e) {}
        try { document.cookie = SESSION_KEY + '=' + encodeURIComponent(JSON.stringify(saved)) + ';path=/;max-age=28800'; } catch(e) {}
        console.log('%c[Login] Sessão restaurada:', 'color:#34C759', saved);
      } else {
        console.log('%c[Login] Nenhuma sessão encontrada — exibindo tela de login', 'color:#888');
      }

      // Vigia os links do menu e garante que sempre tenham o token de sessão,
      // independente da ordem em que outros scripts (ex: fileMap) alterem o href.
      watchNavLinksForSession();
    });

    window.addEventListener('resize', () => {
      if(window.innerWidth > 1024){
        document.body.classList.remove('mobile-menu-open');
      }
    });

    function updateDashboardWelcome(){
      const titleEl = document.getElementById('dashboardWelcomeTitle');
      const userEl = document.getElementById('dashboardWelcomeUser');
      const accountName = document.querySelector('#accountSummary .account-meta h3')?.textContent?.trim() || 'Usuário';
      if(titleEl) titleEl.textContent = 'Bem-vindo ao Gestão de EPIs';
      if(userEl) userEl.textContent = `Olá, ${accountName}.`;
    }

    document.addEventListener('DOMContentLoaded', () => {
      currentMenuPreviewRole = 'Master';
      const previewSelect = document.getElementById('menuPreviewRole');
      if(previewSelect) previewSelect.value = 'Master';

      document.querySelectorAll('.access-page-item .switch[data-role][data-page]').forEach(btn => {
        const role = btn.dataset.role;
        const page = btn.dataset.page;
        const allPages = ['emailsGestao','dashboard','operations','reports','materials','eligibilityRules','purchases','stockValidity','availableItems','deliveredItems','epiFicha','importEmployees','newUser','employeeHistory','request','supervisorApproval','stockRequests','userAdmin','config','support','lgpd'];
        if(role === 'Master'){
          btn.classList.add('active');
          if(!rolePermissions.Master.includes(page)) rolePermissions.Master.push(page);
        } else {
          btn.classList.toggle('active', (rolePermissions[role] || []).includes(page));
        }
      });
      applyMenuPermissions();
      updateDashboardWelcome();
      updateSaldoLabels();
      renderDashboardCharts();
      const firstNav = document.querySelector('.nav a');
      if(firstNav) setActiveNav(firstNav);
      showView('dashboardView');

      // 🔥 NOVA REGRA: atualização automática de status
      atualizarStatusEstoque();
    });

    function atualizarStatusEstoque(){
      const itens = document.querySelectorAll('.stock-request-item');

      itens.forEach(item => {
        const infoCompra = (item.textContent || '').toLowerCase();
        const badge = item.querySelector('.stock-request-actions .badge');
        const botao = item.querySelector('.stock-request-actions button');

        if(infoCompra.includes('entrada registrada')){
          if(badge){
            badge.className = 'badge status-active';
            badge.innerText = 'Disponível para entrega';
          }

          if(botao){
            botao.innerText = 'Entregar agora';
          }
        }
      });
    }

    function showReportTab(tabId){
      document.querySelectorAll('.report-subview').forEach(v => v.classList.remove('active'));
      const target = document.getElementById(tabId);
      if(target) target.classList.add('active');
      document.querySelectorAll('.report-tab').forEach(btn => btn.classList.remove('active'));
      const clicked = Array.from(document.querySelectorAll('.report-tab')).find(btn => btn.getAttribute('onclick')?.includes(tabId));
      if(clicked) clicked.classList.add('active');
    }

    function openUpcomingExpirations(){
      const navLinks = document.querySelectorAll('.nav a');
      const reportsNav = Array.from(navLinks).find(a => a.textContent.includes('Relatórios'));
      if(reportsNav) setActiveNav(reportsNav);
      showView('reportsView');
      showReportTab('reportUpcoming');
    }

    function openExpiredStock(){
      const navLinks = document.querySelectorAll('.nav a');
      const stockValidityNav = Array.from(navLinks).find(a => a.textContent.includes('Validade do Estoque'));
      if(stockValidityNav) setActiveNav(stockValidityNav);
      showView('stockValidityView');
      const expiredSection = document.querySelector('#stockValidityView .card:nth-of-type(2)');
      if(expiredSection) expiredSection.scrollIntoView({behavior:'smooth', block:'start'});
    }

    function openAvailableItems(){
      const navLinks = document.querySelectorAll('.nav a');
      const availableNav = Array.from(navLinks).find(a => a.textContent.includes('Itens Disponíveis'));
      if(availableNav) setActiveNav(availableNav);
      showView('availableItemsView');
    }

    function openDeliveredItems(){
      const navLinks = document.querySelectorAll('.nav a');
      const deliveredNav = Array.from(navLinks).find(a => a.textContent.includes('EPIs Entregues'));
      if(deliveredNav) setActiveNav(deliveredNav);
      showView('deliveredItemsView');
    }

    function openEmployeeHistoryPanel(){
      const navLinks = document.querySelectorAll('.nav a');
      const historyNav = Array.from(navLinks).find(a => a.textContent.includes('Histórico de Funcionários'));
      if(historyNav) setActiveNav(historyNav);
      showView('employeeHistoryView');
    }

    function openEmployeeHistoryFromDashboard(nome, setor){
      const navLinks = document.querySelectorAll('.nav a');
      const historyNav = Array.from(navLinks).find(a => a.textContent.includes('Histórico de Funcionários'));
      if(historyNav) setActiveNav(historyNav);
      showView('employeeHistoryView');

      const filterType = document.getElementById('historyFilterType');
      const searchValue = document.getElementById('historySearchValue');
      const employeeName = document.getElementById('historyEmployeeName');
      const employeeSector = document.getElementById('historySector');

      if(filterType) filterType.value = 'nome';
      if(searchValue) searchValue.value = nome;
      if(employeeName) employeeName.value = nome;
      if(employeeSector) employeeSector.value = setor;
    }