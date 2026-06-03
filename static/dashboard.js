const STATUS = document.getElementById("status");
const STAGE_COLORS = {
  "APRESENTAÇÃO": "#6B7280",
  "SONDAGEM": "#3B82F6",
  "GERAÇÃO DE VALOR": "#6366F1",
  "NEGOCIAÇÃO": "#84CC16",
  "FECHAMENTO": "#FBBF24",
  "AGENDADO": "#22C55E",
  "FOLLOW-UP": "#FDBA74",
  "LEAD PRA O FUTURO": "#A78BFA",
  "DESQUALIFICADO": "#EF4444",
};

let chartFunil = null;
let chartConversas = null;
let currentMode = "otimista";  // otimista | realista
let currentPreset = "hoje";    // hoje | ontem | semana | mes | mes-atual | tudo | custom

function setStatus(msg, level = "info") {
  if (!STATUS) return;
  STATUS.textContent = msg;
  STATUS.style.color = level === "err" ? "var(--danger)" : "var(--text-dim)";
}

function fmtBRL(n) {
  if (n === null || n === undefined || isNaN(n)) return "R$ 0";
  return Number(n).toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
}

function fmtPct(n) {
  if (n === null || n === undefined || isNaN(n)) return "0.0%";
  return `${Number(n).toFixed(1)}%`;
}

// ====== DATAS / PRESETS ======
function presetToDates(preset) {
  const now = new Date();
  const startOfDay = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
  const endOfDay = d => { const x = new Date(d); x.setHours(23, 59, 59, 999); return x; };

  if (preset === "hoje") return { from: startOfDay(now), to: endOfDay(now), label: `Hoje · ${now.toLocaleDateString("pt-BR", {day: "2-digit", month: "2-digit"})}` };
  if (preset === "ontem") {
    const y = new Date(now); y.setDate(y.getDate() - 1);
    return { from: startOfDay(y), to: endOfDay(y), label: `Ontem · ${y.toLocaleDateString("pt-BR", {day: "2-digit", month: "2-digit"})}` };
  }
  if (preset === "semana") {
    const f = new Date(now); f.setDate(f.getDate() - 6);
    return { from: startOfDay(f), to: endOfDay(now), label: "Últimos 7 dias" };
  }
  if (preset === "mes") {
    const f = new Date(now); f.setDate(f.getDate() - 29);
    return { from: startOfDay(f), to: endOfDay(now), label: "Últimos 30 dias" };
  }
  if (preset === "mes-atual") {
    const f = new Date(now.getFullYear(), now.getMonth(), 1);
    return { from: startOfDay(f), to: endOfDay(now), label: `Este mês · ${now.toLocaleDateString("pt-BR", {month: "long"})}` };
  }
  return { from: null, to: null, label: "Todo o histórico" };
}

function periodParams() {
  const f = document.getElementById("dateFrom").value;
  const t = document.getElementById("dateTo").value;
  const params = new URLSearchParams();
  if (f) params.set("from", new Date(f).toISOString());
  if (t) params.set("to", new Date(t).toISOString());
  return params.toString();
}

function applyPreset(preset) {
  currentPreset = preset;
  const { from, to, label } = presetToDates(preset);
  const lblEl = document.getElementById("datePreset");
  if (lblEl) lblEl.innerHTML = label;
  const fromInput = document.getElementById("dateFrom");
  const toInput = document.getElementById("dateTo");
  if (from && to) {
    // datetime-local quer YYYY-MM-DDTHH:mm sem segundos
    const toLocal = d => {
      const pad = n => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    };
    fromInput.value = toLocal(from);
    toInput.value = toLocal(to);
  } else {
    fromInput.value = "";
    toInput.value = "";
  }
  closeDateDropdown();
  loadAll();
}

function openDateDropdown() {
  document.getElementById("dateDropdownMenu").classList.add("open");
}
function closeDateDropdown() {
  document.getElementById("dateDropdownMenu").classList.remove("open");
}
function toggleDateDropdown() {
  document.getElementById("dateDropdownMenu").classList.toggle("open");
}

// ====== TABS DA SIDEBAR ======
function setupTabs() {
  document.querySelectorAll(".nav-item[data-tab]").forEach(item => {
    item.addEventListener("click", e => {
      e.preventDefault();
      const target = item.dataset.tab;
      document.querySelectorAll(".nav-item").forEach(n => n.classList.remove("active"));
      item.classList.add("active");
      document.querySelectorAll(".tab-content").forEach(tab => {
        tab.classList.toggle("active", tab.dataset.tabContent === target);
      });
      // Carrega Vendedores e Relatórios lazy quando suas abas abrem
      if (target === "vendedores") loadVendedoresGrid();
      if (target === "relatorios") loadRelatorioFechamentos();
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  });
}

// ====== MODE TABS (OTIMISTA / REALISTA) ======
function setupModeTabs() {
  document.querySelectorAll(".mode-tab").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".mode-tab").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      currentMode = btn.dataset.mode;
      const ind = document.querySelector(".mode-indicator");
      ind.className = "mode-indicator mode-" + currentMode;
      const lbl = document.getElementById("modeLabel");
      lbl.textContent = currentMode === "otimista"
        ? "Otimista — todas as vendas AGENDADAS"
        : "Realista — só vendas com contrato formalizado";
      // Re-renderiza usando o cache (sem novo fetch) se já tem dado
      if (_cacheResumo && _cacheFat) renderMetricasCards();
      else loadMetricasBasicas();
    });
  });
}

// ====== FETCH ======
async function fetchJson(path) {
  const q = periodParams();
  const url = q ? `${path}${path.includes("?") ? "&" : "?"}${q}` : path;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

function setCount(id, n) {
  const el = document.getElementById(id);
  if (el) el.textContent = n;
}

// ====== CARDS DE MÉTRICAS (separados em 2 grupos pra cada um renderizar quando chega) ======
// Os 8 cards dependem de resumo + faturamento. Carrega os 2 em paralelo
// e renderiza os 8 cards de uma vez quando ambos chegam.
let _cacheResumo = null;
let _cacheFat = null;

async function loadMetricasBasicas() {
  try {
    const [resumo, fat] = await Promise.all([
      fetchJson("/api/resumo"),
      fetchJson("/api/faturamento"),
    ]);
    _cacheResumo = resumo;
    _cacheFat = fat;
    renderMetricasCards();
  } catch (e) { console.error("loadMetricasBasicas:", e); }
}

function renderMetricasCards() {
  if (!_cacheResumo || !_cacheFat) return;
  const resumo = _cacheResumo;
  const fat = _cacheFat;

  // Otimista = todas as AGENDADO. Realista = só com contrato formalizado.
  const totalAgendado = resumo.vendas;
  const comContrato = fat.com_contrato;
  const semContrato = fat.sem_contrato;
  const totalVendas = currentMode === "otimista" ? totalAgendado : comContrato;

  // Linha 1
  document.getElementById("mLeads").textContent = resumo.total_leads.toLocaleString("pt-BR");
  document.getElementById("mVendas").textContent = totalVendas;
  document.getElementById("mVendasHint").textContent =
    `${comContrato} com contrato · ${semContrato} sem`;
  document.getElementById("mFuturos").textContent = semContrato;
  const taxaConv = resumo.total_leads ? (totalVendas / resumo.total_leads * 100) : 0;
  document.getElementById("mConversao").textContent = fmtPct(taxaConv);

  // Linha 2
  document.getElementById("mFaturamento").textContent = fmtBRL(fat.faturamento);
  document.getElementById("mTicket").textContent = fmtBRL(fat.ticket_medio);
  document.getElementById("mSeisMeses").textContent = fmtPct(fat.pct_6_meses);
  document.getElementById("mAntecipadas").textContent = fmtPct(fat.pct_antecipadas);
}

// Stub mantido pra compat com loadAll (vazio porque já vem em loadMetricasBasicas)
async function loadMetricasFinanceiras() { /* coberto por loadMetricasBasicas */ }
async function loadMetricas() { await loadMetricasBasicas(); }

async function loadVendedoresCount() {
  try {
    const ranking = await fetchJson("/api/ranking");
    document.getElementById("mLeadsHint").textContent =
      `${ranking.filter(r => r.userId && r.userId !== "outros").length} vendedores`;
  } catch (e) { console.error("loadVendedoresCount:", e); }
}

// ====== FUNIL ======
async function loadFunil() {
  const data = await fetchJson("/api/funil");
  setCount("countFunil", data.reduce((s, d) => s + d.count, 0));
  const ctx = document.getElementById("chartFunil").getContext("2d");
  if (chartFunil) chartFunil.destroy();
  chartFunil = new Chart(ctx, {
    type: "bar",
    data: {
      labels: data.map(d => d.stage),
      datasets: [{
        label: "Negócios",
        data: data.map(d => d.count),
        backgroundColor: data.map(d => STAGE_COLORS[d.stage] || "#888"),
        borderRadius: 4,
      }],
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: "#64748b" }, grid: { color: "#e6e8ee" } },
        y: { ticks: { color: "#0f172a", font: { size: 11 } }, grid: { display: false } },
      },
    },
  });
}

// ====== RANKING ======
async function loadRanking() {
  const data = await fetchJson("/api/ranking");
  setCount("countRanking", data.length);
  const tbody = document.querySelector("#tableRanking tbody");
  tbody.innerHTML = data.map(r => `
    <tr>
      <td>${r.name}</td>
      <td class="num cell-vendas">${r.vendas}</td>
      <td class="num">${r.taxa_conversao}%</td>
      <td class="num">${r.em_negociacao}</td>
      <td class="num">${r.em_fechamento}</td>
      <td class="num">${r.desqualificados}</td>
      <td class="num">${r.total}</td>
      <td>${r.userId && r.userId !== "outros" ? `<button class="link-btn" data-user="${r.userId}" data-name="${r.name}">ver carteira</button>` : ""}</td>
    </tr>
  `).join("");

  tbody.querySelectorAll("button[data-user]").forEach(btn => {
    btn.addEventListener("click", () => loadCarteira(btn.dataset.user, btn.dataset.name));
  });
}

// ====== CONVERSAS ======
async function loadConversas() {
  const data = await fetchJson("/api/conversas");
  setCount("countConversas", data.total_abertas + data.total_aguardando);
  const labels = Object.keys(data.por_vendedor);
  const values = labels.map(k => data.por_vendedor[k]);

  const ctx = document.getElementById("chartConversas").getContext("2d");
  if (chartConversas) chartConversas.destroy();
  chartConversas = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [{
        label: "Conversas",
        data: values,
        backgroundColor: "#22c55e",
        borderRadius: 4,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: "#0f172a" }, grid: { display: false } },
        y: { ticks: { color: "#64748b" }, grid: { color: "#e6e8ee" }, beginAtZero: true },
      },
    },
  });

  document.getElementById("convResumo").innerHTML = `
    Total abertas: <b>${data.total_abertas}</b> &middot;
    Aguardando: <b>${data.total_aguardando}</b> &middot;
    Sem atendente: <b>${data.sem_atendente}</b> &middot;
    Outros: <b>${data.outros}</b>
  `;
}

// ====== VENDEDORES (GRID DA ABA) ======
async function loadVendedoresGrid() {
  const grid = document.getElementById("vendedoresGrid");
  if (!grid) return;
  if (grid.dataset.loaded === "1") return;  // só carrega uma vez por sessão
  try {
    const ranking = await fetchJson("/api/ranking");
    const vendedores = ranking.filter(r => r.userId && r.userId !== "outros");
    grid.innerHTML = vendedores.map(v => {
      const iniciais = v.name.split(" ").slice(0, 2).map(s => s[0]).join("").toUpperCase();
      return `
        <div class="vendedor-card" data-user="${v.userId}" data-name="${v.name}">
          <div class="vendedor-avatar">${iniciais}</div>
          <div class="vendedor-nome">${v.name}</div>
          <div class="vendedor-funcao">Vendedor · Pipeline API</div>
          <div class="vendedor-stats">
            <div class="vendedor-stat">
              <div class="vendedor-stat-value">${v.vendas}</div>
              <div class="vendedor-stat-label">Vendas</div>
            </div>
            <div class="vendedor-stat">
              <div class="vendedor-stat-value">${v.em_fechamento}</div>
              <div class="vendedor-stat-label">Fechamento</div>
            </div>
            <div class="vendedor-stat">
              <div class="vendedor-stat-value">${v.taxa_conversao}%</div>
              <div class="vendedor-stat-label">Conv.</div>
            </div>
          </div>
        </div>
      `;
    }).join("");

    grid.querySelectorAll(".vendedor-card").forEach(card => {
      card.addEventListener("click", () => {
        loadVendedorDetail(card.dataset.user, card.dataset.name);
      });
    });
    grid.dataset.loaded = "1";
  } catch (e) {
    grid.innerHTML = `<div class="placeholder-panel"><p>Erro ao carregar vendedores: ${e.message}</p></div>`;
  }
}

// ====== REGISTROS: CORREÇÃO DE VALORES NO CRM ======
let _regCorrecLista = [];

async function detectarCorrecoes() {
  const btn = document.getElementById("regBtnDetectar");
  btn.disabled = true;
  btn.textContent = "Analisando…";
  document.getElementById("regCorrecInfo").style.display = "none";
  document.getElementById("regCorrecResultado").style.display = "none";

  try {
    const data = await fetchJson("/api/correcoes/preview");
    _regCorrecLista = data.lista;
    setCount("regCountCorrec", data.total);

    if (!data.total) {
      document.getElementById("regCorrecInfo").style.display = "block";
      document.getElementById("regCorrecInfo").innerHTML =
        `<span style="color:#16a34a;font-weight:600">✓ Todos os valores já estão coerentes com os contratos.</span>`;
      btn.textContent = "🔍 Detectar correções";
      btn.disabled = false;
      return;
    }

    document.getElementById("regCorrecStats").style.display = "flex";
    const sinal = data.diferenca_total >= 0 ? "+" : "";
    document.getElementById("regCorrecStats").innerHTML = `
      <span class="carteira-stat">Total: <b>${data.total}</b> negócios</span>
      <span class="carteira-stat ${data.diferenca_total >= 0 ? 'carteira-stat-venda' : 'carteira-stat-danger'}">
        Ajuste líquido: <b>${sinal}${fmtBRL(data.diferenca_total)}</b>
      </span>
    `;

    document.getElementById("regCorrecLista").style.display = "block";
    renderCorrecoesTabela();
  } catch (e) {
    document.getElementById("regCorrecInfo").style.display = "block";
    document.getElementById("regCorrecInfo").innerHTML =
      `<span style="color:var(--danger)">Erro: ${e.message}</span>`;
  }
  btn.textContent = "🔍 Detectar correções";
  btn.disabled = false;
}

function renderCorrecoesTabela() {
  const tbody = document.querySelector("#regTableCorrec tbody");
  tbody.innerHTML = _regCorrecLista.map((c, i) => {
    const sinal = c.diferenca >= 0 ? "+" : "";
    const corDif = c.diferenca >= 0 ? "#16a34a" : "#dc2626";
    return `
      <tr data-i="${i}">
        <td><input type="checkbox" class="check-correc"></td>
        <td><b>${c.leadName || "—"}</b><br><small style="color:var(--text-dim)">#${c.code}</small></td>
        <td>${c.attendantName}</td>
        <td class="num">${fmtBRL(c.valor_atual)}</td>
        <td class="num"><b>${fmtBRL(c.valor_contrato)}</b></td>
        <td class="num" style="color:${corDif};font-weight:700">${sinal}${fmtBRL(c.diferenca)}</td>
        <td>${c.plano_meses ? c.plano_meses + " meses" : "—"}</td>
      </tr>
    `;
  }).join("");

  tbody.querySelectorAll(".check-correc").forEach((cb, i) => {
    cb.addEventListener("change", atualizaCountAplicarCorrec);
  });
  atualizaCountAplicarCorrec();
}

function atualizaCountAplicarCorrec() {
  const checked = document.querySelectorAll(".check-correc:checked").length;
  document.getElementById("regCountAplicar").textContent = checked;
  document.getElementById("regBtnAplicar").disabled = checked === 0;
}

async function aplicarCorrecoes() {
  const aplicacoes = [];
  document.querySelectorAll("#regTableCorrec tbody tr").forEach(tr => {
    const cb = tr.querySelector(".check-correc");
    if (!cb.checked) return;
    const i = +tr.dataset.i;
    const c = _regCorrecLista[i];
    aplicacoes.push({ businessId: c.businessId, valor: c.valor_contrato });
  });

  if (!aplicacoes.length) return;
  if (!confirm(`Aplicar correção em ${aplicacoes.length} negócio(s)?\n\nO valor no CRM será sobrescrito pelo valor do contrato.\nEssa ação NÃO pode ser desfeita automaticamente.`)) return;

  const btn = document.getElementById("regBtnAplicar");
  btn.disabled = true;
  btn.textContent = `Aplicando ${aplicacoes.length}…`;

  try {
    const res = await fetch("/api/correcoes/aplicar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ aplicacoes }),
    });
    const data = await res.json();

    const resEl = document.getElementById("regCorrecResultado");
    resEl.style.display = "block";
    resEl.innerHTML = `
      <div class="carteira-stats">
        <span class="carteira-stat carteira-stat-venda">Sucesso: <b>${data.sucesso}</b></span>
        ${(data.total - data.sucesso) > 0 ? `<span class="carteira-stat carteira-stat-danger">Falhas: <b>${data.total - data.sucesso}</b></span>` : ""}
      </div>
      ${data.resultados.filter(r => !r.ok).slice(0, 10).map(r =>
        `<small style="color:var(--danger);display:block">erro em ${r.businessId}: ${r.erro || "?"}</small>`
      ).join("")}
      <div style="margin-top:14px">
        <button class="btn btn-ghost" onclick="detectarCorrecoes()">Re-detectar</button>
      </div>
    `;
    btn.textContent = "Aplicado ✓";
    // recarrega o dashboard pra atualizar os cards de faturamento
    setTimeout(() => loadAll(), 1500);
  } catch (e) {
    alert(`Erro ao aplicar: ${e.message}`);
    btn.textContent = "Aplicar selecionadas";
    btn.disabled = false;
  }
}

document.getElementById("regBtnDetectar")?.addEventListener("click", detectarCorrecoes);
document.getElementById("regBtnAplicar")?.addEventListener("click", aplicarCorrecoes);
document.getElementById("regCheckAll")?.addEventListener("change", e => {
  document.querySelectorAll(".check-correc").forEach(cb => cb.checked = e.target.checked);
  atualizaCountAplicarCorrec();
});

// ====== RELATÓRIO: PASSARAM POR FECHAMENTO ======
let _relFechCache = null;
let _relFechVendedorAberto = null;

const DESTINO_STYLES = {
  "AGENDADO": { color: "#16a34a", bg: "#dcfce7", label: "✓ Vendeu", short: "vendeu" },
  "FECHAMENTO": { color: "#f59e0b", bg: "#fef3c7", label: "● Ainda em fechamento", short: "no fech." },
  "FOLLOW-UP": { color: "#fb923c", bg: "#ffedd5", label: "↻ Follow-up", short: "follow" },
  "LEAD PRA O FUTURO": { color: "#a78bfa", bg: "#ede9fe", label: "⏳ Futuro", short: "futuro" },
  "DESQUALIFICADO": { color: "#dc2626", bg: "#fee2e2", label: "✗ Desqualificou", short: "perdeu" },
};

function relFechQuery() {
  const filtro = document.getElementById("relFechFiltro").value;
  if (filtro === "hoje") return "";
  if (filtro === "ontem") {
    const y = new Date(); y.setDate(y.getDate() - 1);
    return `?dia=${y.getFullYear()}-${String(y.getMonth()+1).padStart(2,"0")}-${String(y.getDate()).padStart(2,"0")}`;
  }
  if (filtro === "data") {
    const d = document.getElementById("relFechData").value;
    return d ? `?dia=${d}` : "";
  }
  return `?dias=${filtro}`;
}

async function loadRelatorioFechamentos() {
  const cardsEl = document.getElementById("relFechCards");
  cardsEl.innerHTML = `<div style="grid-column:1/-1;color:var(--text-dim);padding:20px">Carregando…</div>`;

  // Status do monitor sempre primeiro
  loadMonitorStatus();

  const fonte = document.getElementById("relFechFonte").value;
  const endpoint = fonte === "monitor" ? "/api/fechamento-monitor/eventos" : "/api/passou-fechamento";
  document.getElementById("relFechSub").textContent = fonte === "monitor"
    ? "Modo preciso · dados do monitor (a partir da hora de bootstrap)"
    : "Modo aproximado · usa lastMovedAt (~95% pro fluxo COD)";

  try {
    const data = await fetchJson(`${endpoint}${relFechQuery()}`);
    _relFechCache = data;
    setCount("relCountFech", data.total);

    // Resumo de destinos (só no modo aproximado tem essa info)
    const destEl = document.getElementById("relFechDestinos");
    if (data.destinos_atuais) {
      destEl.innerHTML = Object.entries(data.destinos_atuais)
        .sort(([,a],[,b]) => b - a)
        .map(([stage, count]) => {
          const s = DESTINO_STYLES[stage] || { bg: "#f1f5f9", color: "#475569" };
          return `<span class="carteira-stat" style="background:${s.bg};color:${s.color};border-color:${s.color}33"><b>${count}</b> ${s.label || stage}</span>`;
        }).join("");
    } else {
      destEl.innerHTML = "";
    }

    // Cards por vendedor
    cardsEl.innerHTML = data.por_vendedor.map(v => {
      const iniciais = v.vendedor.name.split(" ").slice(0, 2).map(s => s[0]).join("").toUpperCase();
      const isExVendedor = v.vendedor.userId === "outros" || v.vendedor.userId === null;
      const vendeu = v.destinos?.AGENDADO || 0;
      const taxa = v.count > 0 ? Math.round(vendeu / v.count * 100) : 0;
      const hasDestinos = !!v.destinos;
      return `
        <div class="vendedor-card" data-user="${v.vendedor.userId || 'sem'}">
          <div class="vendedor-avatar" style="${isExVendedor ? 'background: linear-gradient(135deg,#94a3b8,#64748b);' : ''}">${iniciais}</div>
          <div class="vendedor-nome">${v.vendedor.name}</div>
          <div class="vendedor-funcao">${isExVendedor ? '(legado)' : 'Vendedor ativo'}</div>
          <div class="vendedor-stats">
            <div class="vendedor-stat">
              <div class="vendedor-stat-value" style="color:#f59e0b">${v.count}</div>
              <div class="vendedor-stat-label">Passaram</div>
            </div>
            ${hasDestinos ? `
              <div class="vendedor-stat">
                <div class="vendedor-stat-value" style="color:#16a34a">${vendeu}</div>
                <div class="vendedor-stat-label">Venderam</div>
              </div>
              <div class="vendedor-stat">
                <div class="vendedor-stat-value">${taxa}%</div>
                <div class="vendedor-stat-label">Convers.</div>
              </div>
            ` : ""}
          </div>
        </div>
      `;
    }).join("");

    cardsEl.querySelectorAll(".vendedor-card").forEach(card => {
      card.addEventListener("click", () => mostrarFechamentosVendedor(card.dataset.user));
    });

    if (_relFechVendedorAberto) mostrarFechamentosVendedor(_relFechVendedorAberto);
  } catch (e) {
    cardsEl.innerHTML = `<div style="grid-column:1/-1;color:var(--danger);padding:20px">Erro: ${e.message}</div>`;
  }
}

function mostrarFechamentosVendedor(userId) {
  _relFechVendedorAberto = userId;
  if (!_relFechCache) return;
  const bucket = _relFechCache.por_vendedor.find(v => (v.vendedor.userId || "sem") === userId);
  if (!bucket) return;

  const det = document.getElementById("relFechDetalhe");
  // monitor retorna .leads, aprox retorna .negocios
  const itens = bucket.leads || bucket.negocios || [];
  if (!itens.length) {
    det.innerHTML = `<div style="color:var(--text-dim);padding:12px 0">Sem leads nesse período.</div>`;
    return;
  }
  det.innerHTML = `
    <h3 style="margin: 20px 0 12px; font-size:15px">📋 ${bucket.vendedor.name} — ${bucket.count} passaram por FECHAMENTO</h3>
    <div class="table-wrap">
      <table>
        <thead>
          <tr><th>Lead</th><th>Código</th>${bucket.negocios ? "<th>Destino atual</th>" : ""}<th>Quando</th></tr>
        </thead>
        <tbody>
          ${itens.map(n => {
            const when = n.lastMovedAt || n.at;
            const destinoCol = bucket.negocios ? (() => {
              const s = DESTINO_STYLES[n.destino_atual] || { color: "#475569", bg: "#f1f5f9" };
              return `<td><span class="tag-paid" style="background:${s.bg};color:${s.color}">${s.label || n.destino_atual}</span></td>`;
            })() : "";
            return `
              <tr>
                <td><b>${n.leadName || "—"}</b></td>
                <td>#${n.code}</td>
                ${destinoCol}
                <td>${when ? new Date(when).toLocaleString("pt-BR") : "—"} <small style="color:var(--text-dim)">(${timeAgo(when)})</small></td>
              </tr>
            `;
          }).join("")}
        </tbody>
      </table>
    </div>
  `;
}

async function loadMonitorStatus() {
  try {
    const s = await fetchJson("/api/fechamento-monitor/status");
    const el = document.getElementById("relMonitorStatus");
    if (!s.rodando) {
      el.innerHTML = `<span class="carteira-stat carteira-stat-danger">Monitor preciso: <b>parado</b></span>`;
      return;
    }
    const desdeIso = s.iniciado_em;
    const desde = desdeIso ? new Date(desdeIso) : null;
    const desdeStr = desde ? desde.toLocaleString("pt-BR") : "agora";
    const horasAtivo = desde ? Math.round((Date.now() - desde.getTime()) / 3600000) : 0;
    el.innerHTML = `
      <span class="carteira-stat carteira-stat-venda">🟢 Monitor ativo desde <b>${desdeStr}</b> (${horasAtivo}h)</span>
      <span class="carteira-stat">Em fechamento agora: <b>${s.atualmente_em_fechamento}</b></span>
      <span class="carteira-stat">Eventos registrados: <b>${s.total_eventos_registrados}</b></span>
      <span class="carteira-stat">Snapshot a cada <b>${Math.round(s.intervalo_segundos / 60)} min</b></span>
    `;
  } catch (e) {
    document.getElementById("relMonitorStatus").innerHTML =
      `<span class="carteira-stat carteira-stat-danger">Status do monitor indisponível</span>`;
  }
}

// ====== FICHA INDIVIDUAL DO VENDEDOR ======
let _vdChart = null;

async function loadVendedorDetail(userId, nome) {
  const sec = document.getElementById("vendedorDetail");
  sec.style.display = "block";
  document.getElementById("vdHeader").textContent = `👤 ${nome}`;
  document.getElementById("vdStats").innerHTML = '<div style="grid-column:1/-1;padding:20px;color:var(--text-dim)">Carregando…</div>';
  sec.scrollIntoView({ behavior: "smooth", block: "start" });

  try {
    const data = await fetchJson(`/api/vendedor/${userId}`);
    const s = data.stats;

    document.getElementById("vdStats").innerHTML = `
      <div class="vd-stat vd-stat-success">
        <div class="vd-stat-label">Vendas hoje</div>
        <div class="vd-stat-value">${s.vendas_hoje}</div>
      </div>
      <div class="vd-stat vd-stat-success">
        <div class="vd-stat-label">Faturamento</div>
        <div class="vd-stat-value">${fmtBRL(s.faturamento)}</div>
      </div>
      <div class="vd-stat">
        <div class="vd-stat-label">Total agendado</div>
        <div class="vd-stat-value">${s.total_agendado}</div>
      </div>
      <div class="vd-stat vd-stat-danger">
        <div class="vd-stat-label">Sem contrato</div>
        <div class="vd-stat-value">${s.sem_contrato}</div>
      </div>
      <div class="vd-stat">
        <div class="vd-stat-label">Ticket médio</div>
        <div class="vd-stat-value">${fmtBRL(s.ticket_medio)}</div>
      </div>
      <div class="vd-stat">
        <div class="vd-stat-label">% 6 meses</div>
        <div class="vd-stat-value">${fmtPct(s.pct_6_meses)}</div>
      </div>
      <div class="vd-stat vd-stat-warn">
        <div class="vd-stat-label">% Antecipadas</div>
        <div class="vd-stat-value">${fmtPct(s.pct_antecipadas)}</div>
      </div>
    `;

    // Tendência 14 dias
    const ctx = document.getElementById("vdChartTendencia").getContext("2d");
    if (_vdChart) _vdChart.destroy();
    _vdChart = new Chart(ctx, {
      type: "bar",
      data: {
        labels: data.tendencia_14_dias.map(d => d.label),
        datasets: [{
          label: "Vendas",
          data: data.tendencia_14_dias.map(d => d.vendas),
          backgroundColor: "#22c55e",
          borderRadius: 3,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: "#64748b", font: { size: 10 } }, grid: { display: false } },
          y: { ticks: { color: "#64748b", stepSize: 1 }, grid: { color: "#e6e8ee" }, beginAtZero: true },
        },
      },
    });

    // Vendas do dia
    setCount("vdCountHoje", data.vendas_hoje.length);
    const tbody = document.querySelector("#vdTableHoje tbody");
    if (!data.vendas_hoje.length) {
      tbody.innerHTML = `<tr><td colspan="6" style="color:var(--text-dim)">Nenhuma venda agendada hoje.</td></tr>`;
    } else {
      tbody.innerHTML = data.vendas_hoje.map(v => {
        const nome = v.lead_name_contrato || v.lead_name_original || "—";
        const valor = v.valor ? fmtBRL(v.valor) : "—";
        const plano = v.plano_meses ? `${v.plano_meses} meses` : "—";
        let pagTag;
        if (!v.pagamento) pagTag = '<span class="tag-paid tag-paid-sem">—</span>';
        else if (v.is_antecipada) pagTag = `<span class="tag-paid tag-paid-antecip">${v.pagamento}</span>`;
        else pagTag = `<span class="tag-paid tag-paid-boleto">${v.pagamento}</span>`;
        const hora = v.movido_em ? new Date(v.movido_em).toLocaleTimeString("pt-BR", {hour: "2-digit", minute: "2-digit"}) : "—";
        const status = v.tem_contrato
          ? '<span style="color:#16a34a;font-weight:600">✓ Contrato</span>'
          : '<span style="color:var(--danger);font-weight:600">⚠ Sem contrato</span>';
        return `
          <tr>
            <td><b>${nome}</b><br><small style="color:var(--text-dim)">#${v.code}</small></td>
            <td><b>${valor}</b></td>
            <td>${plano}</td>
            <td>${pagTag}</td>
            <td>${hora}</td>
            <td>${status}</td>
          </tr>
        `;
      }).join("");
    }

    // Carrega notas do localStorage
    const notasKey = `vd-notas-${userId}`;
    const notas = localStorage.getItem(notasKey) || "";
    const ta = document.getElementById("vdNotas");
    ta.value = notas;
    const statusEl = document.getElementById("vdNotasStatus");
    statusEl.textContent = notas ? "Salvo localmente" : "Sem notas ainda";

    document.getElementById("vdNotasSalvar").onclick = () => {
      localStorage.setItem(notasKey, ta.value);
      statusEl.textContent = `Salvo · ${new Date().toLocaleTimeString("pt-BR", {hour: "2-digit", minute: "2-digit"})}`;
    };
  } catch (e) {
    document.getElementById("vdStats").innerHTML =
      `<div style="grid-column:1/-1;padding:20px;color:var(--danger)">Erro: ${e.message}</div>`;
    console.error("loadVendedorDetail:", e);
  }
}

document.getElementById("vdClose")?.addEventListener("click", () => {
  document.getElementById("vendedorDetail").style.display = "none";
});

document.getElementById("relFechFonte")?.addEventListener("change", loadRelatorioFechamentos);
document.getElementById("relFechFiltro")?.addEventListener("change", e => {
  const dataInput = document.getElementById("relFechData");
  if (e.target.value === "data") {
    dataInput.style.display = "inline-block";
    if (!dataInput.value) {
      const today = new Date();
      dataInput.value = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,"0")}-${String(today.getDate()).padStart(2,"0")}`;
    }
  } else {
    dataInput.style.display = "none";
    loadRelatorioFechamentos();
  }
});
document.getElementById("relFechData")?.addEventListener("change", loadRelatorioFechamentos);

// ====== CARTEIRA ======
const CARTEIRA_RESUMO_LIMITE = 8;
let carteiraFull = [];
let semProdutoFull = [];

function renderSemProduto(expanded) {
  const tbody = document.querySelector("#tableSemProduto tbody");
  const itens = expanded ? semProdutoFull : semProdutoFull.slice(0, CARTEIRA_RESUMO_LIMITE);
  if (!itens.length) {
    tbody.innerHTML = `<tr><td colspan="4" style="color:var(--text-dim)">Todos os agendados têm produto vinculado.</td></tr>`;
    return;
  }
  tbody.innerHTML = itens.map(b => `
    <tr>
      <td>#${b.code}</td>
      <td><b>${b.leadName || "—"}</b></td>
      <td>${b.attendantName}</td>
      <td>${b.lastMovedAt ? new Date(b.lastMovedAt).toLocaleString("pt-BR") : "—"}</td>
    </tr>
  `).join("");
  const wrap = document.getElementById("semProdutoExpandWrap");
  const btn = document.getElementById("btnExpandSemProduto");
  if (semProdutoFull.length > CARTEIRA_RESUMO_LIMITE) {
    wrap.style.display = "block";
    btn.innerHTML = expanded ? "Recolher" : `Ver todos os <b>${semProdutoFull.length}</b>`;
    btn.dataset.expanded = expanded ? "1" : "0";
  } else {
    wrap.style.display = "none";
  }
}

async function loadSemProduto() {
  const res = await fetch("/api/agendados-sem-produto");
  const data = await res.json();
  semProdutoFull = data.lista;
  setCount("countSemProduto", data.sem_produto);
  const pct = data.total_agendados ? Math.round(data.sem_produto * 100 / data.total_agendados) : 0;
  document.getElementById("semProdutoSub").innerHTML =
    `<b>${data.sem_produto}</b> de <b>${data.total_agendados}</b> agendados (${pct}%) sem produto vinculado`;
  document.getElementById("semProdutoStats").innerHTML = `
    <span class="carteira-stat carteira-stat-venda">Com produto: <b>${data.com_produto}</b></span>
    <span class="carteira-stat carteira-stat-danger">Sem produto: <b>${data.sem_produto}</b></span>
  `;
  renderSemProduto(false);
}

function renderCarteira(expanded) {
  const tbody = document.querySelector("#tableCarteira tbody");
  const itens = expanded ? carteiraFull : carteiraFull.slice(0, CARTEIRA_RESUMO_LIMITE);
  tbody.innerHTML = itens.map(b => `
    <tr>
      <td>#${b.code}</td>
      <td>${b.leadName || "—"}</td>
      <td><span class="tag-stage">${b.stageName}</span></td>
      <td>${b.lastMovedAt ? new Date(b.lastMovedAt).toLocaleString("pt-BR") : "—"}</td>
    </tr>
  `).join("");

  const expandWrap = document.getElementById("carteiraExpandWrap");
  const btn = document.getElementById("btnExpandCarteira");
  if (carteiraFull.length > CARTEIRA_RESUMO_LIMITE) {
    expandWrap.style.display = "block";
    if (expanded) {
      btn.innerHTML = `Recolher (mostrar só os ${CARTEIRA_RESUMO_LIMITE} mais recentes)`;
      btn.dataset.expanded = "1";
    } else {
      btn.innerHTML = `Ver todos os <b>${carteiraFull.length}</b> negócios`;
      btn.dataset.expanded = "0";
    }
  } else {
    expandWrap.style.display = "none";
  }
}

async function loadCarteira(userId, nome) {
  setStatus(`carregando carteira de ${nome}...`);
  const res = await fetch(`/api/carteira/${userId}`);
  const data = await res.json();
  carteiraFull = data;

  document.getElementById("carteiraNome").textContent = nome.trim();
  document.getElementById("carteiraPanel").style.display = "block";
  setCount("countCarteira", data.length);

  const porEstagio = {};
  for (const b of data) porEstagio[b.stageName] = (porEstagio[b.stageName] || 0) + 1;
  const stats = [
    { stage: "AGENDADO", label: "Vendas", cls: "carteira-stat-venda" },
    { stage: "FECHAMENTO", label: "Fechamento" },
    { stage: "NEGOCIAÇÃO", label: "Negociação" },
    { stage: "GERAÇÃO DE VALOR", label: "Geração de valor" },
    { stage: "SONDAGEM", label: "Sondagem" },
    { stage: "APRESENTAÇÃO", label: "Apresentação" },
    { stage: "FOLLOW-UP", label: "Follow-up" },
    { stage: "LEAD PRA O FUTURO", label: "Futuro" },
    { stage: "DESQUALIFICADO", label: "Desqualificados", cls: "carteira-stat-danger" },
  ];
  document.getElementById("carteiraStats").innerHTML = stats
    .filter(s => s.label && porEstagio[s.stage])
    .map(s => `<span class="carteira-stat ${s.cls || ''}">${s.label}: <b>${porEstagio[s.stage]}</b></span>`)
    .join("");

  renderCarteira(false);
  setStatus("");
  document.getElementById("carteiraPanel").scrollIntoView({ behavior: "smooth", block: "start" });
}

// ====== UTIL ======
function timeAgo(iso) {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60000);
  if (min < 1) return "agora";
  if (min < 60) return `${min}min`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const d = Math.floor(hr / 24);
  return `${d}d`;
}

function sanitizePreview(text) {
  if (!text) return "—";
  return text.replace(/[​-‍﻿]/g, "").trim() || "(mensagem invisível)";
}

// ====== LEADS QUENTES ======
async function loadQuentes() {
  const loading = document.getElementById("loadingQuentes");
  const table = document.getElementById("tableQuentes");
  loading.style.display = "block";
  table.style.display = "none";

  const horas = document.getElementById("horasQuentes").value || 24;
  const res = await fetch(`/api/leads-quentes?horas=${horas}`);
  const data = await res.json();
  const tbody = table.querySelector("tbody");
  setCount("countQuentes", data.length);

  loading.style.display = "none";
  table.style.display = "table";

  if (!data.length) {
    tbody.innerHTML = `<tr><td colspan="6" style="color:var(--text-dim)">Nenhum lead quente identificado nesse momento.</td></tr>`;
    return;
  }

  tbody.innerHTML = data.map(r => {
    const scoreCls = r.score >= 60 ? "score-hot" : r.score >= 35 ? "score-warm" : "score-mild";
    const preview = sanitizePreview(r.ultima_msg_preview);
    return `
      <tr>
        <td><span class="score-pill ${scoreCls}">${r.score}</span></td>
        <td><b>${r.leadName || "—"}</b><br><small style="color:var(--text-dim)">#${r.code}</small></td>
        <td>${r.attendantName}</td>
        <td><span class="tag-stage">${r.stageName}</span></td>
        <td class="preview-msg">${preview}<br><small style="color:var(--text-dim)">${timeAgo(r.ultima_msg_em)} atrás</small></td>
        <td class="razoes">${r.razoes.map(x => `<span class="razao">${x}</span>`).join("")}</td>
      </tr>
    `;
  }).join("");
}

// ====== FECHAMENTO ======
async function loadFechamento() {
  const horas = document.getElementById("horasFechamento").value || 24;
  const res = await fetch(`/api/leads-fechamento?horas=${horas}`);
  const data = await res.json();
  setCount("countFechamento", data.length);
  const tbody = document.querySelector("#tableFechamento tbody");
  if (!data.length) {
    tbody.innerHTML = `<tr><td colspan="5" style="color:var(--text-dim)">Nenhum lead em FECHAMENTO.</td></tr>`;
    return;
  }
  tbody.innerHTML = data.map(r => {
    const preview = sanitizePreview(r.preview_lead);
    const ago = timeAgo(r.ultima_msg_em);
    const agoCls = !r.ultima_msg_em ? "" : (Date.now() - new Date(r.ultima_msg_em).getTime()) < 7200000 ? "dias-grave" : "";
    return `
      <tr>
        <td><b>${r.leadName || "—"}</b><br><small style="color:var(--text-dim)">#${r.code}</small></td>
        <td>${r.attendantName}</td>
        <td class="preview-msg">${preview}</td>
        <td class="num ${agoCls}">${ago}</td>
        <td class="num">${r.dias_no_estagio ?? "—"}d</td>
      </tr>
    `;
  }).join("");
}

// ====== SEM CONTRATO (alerta) ======
async function loadSemContrato() {
  try {
    const data = await fetchJson("/api/sem-contrato");
    const sec = document.getElementById("alertSemContrato");
    if (!sec) return;
    if (!data.total_sem_contrato) {
      sec.style.display = "none";
      return;
    }
    sec.style.display = "block";
    setCount("countSemContrato", data.total_sem_contrato);
    const pct = data.total_no_periodo ? Math.round(data.total_sem_contrato * 100 / data.total_no_periodo) : 0;
    document.getElementById("semContratoSub").innerHTML =
      `<b>${data.total_sem_contrato}</b> de <b>${data.total_no_periodo}</b> agendados (${pct}%) sem declaração de compra na conversa`;

    document.getElementById("semContratoPorVendedor").innerHTML = data.por_vendedor
      .map(v => `<span class="carteira-stat carteira-stat-danger">${v.vendedor}: <b>${v.count}</b></span>`)
      .join("");

    const tbody = document.querySelector("#tableSemContrato tbody");
    tbody.innerHTML = data.lista.map(d => `
      <tr>
        <td><b>${d.leadName || "—"}</b><br><small style="color:var(--text-dim)">#${d.code}</small></td>
        <td>${d.attendantName}</td>
        <td>${d.lastMovedAt ? new Date(d.lastMovedAt).toLocaleString("pt-BR") : "—"}</td>
        <td class="num dias-aviso">${timeAgo(d.lastMovedAt)}</td>
        <td><a class="link-btn" href="https://app.datacrazy.io/conversation/${d.leadId}" target="_blank">abrir conversa →</a></td>
      </tr>
    `).join("");
  } catch (e) {
    console.error("loadSemContrato:", e);
  }
}

// ====== GOLDEN ======
async function loadGoldenBadge() {
  const res = await fetch("/api/golden-time");
  const data = await res.json();
  const el = document.getElementById("goldenBadge");
  el.textContent = `${data.mensagem} · ${String(data.hora_brasilia).padStart(2, "0")}h`;
  el.className = "golden-badge " + (data.is_peak ? "peak" : data.is_golden ? "golden" : "off");
}

// ====== LOAD ALL ======
// Cada carregamento é independente: rendereiza assim que chega, sem bloquear os outros.
async function loadAll() {
  setStatus("carregando dados…");
  const ts = new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  const syncTime = document.getElementById("syncTime");
  if (syncTime) syncTime.textContent = `${ts} (atualizando…)`;

  const tasks = [
    ["m-cards", loadMetricasBasicas],
    ["vend-count", loadVendedoresCount],
    ["funil", loadFunil],
    ["ranking", loadRanking],
    ["conversas", loadConversas],
    ["fechamento", loadFechamento],
    ["quentes", loadQuentes],
    ["golden", loadGoldenBadge],
    ["sem-produto", loadSemProduto],
    ["sem-contrato", loadSemContrato],
  ];

  let pendentes = tasks.length;
  const onDone = (name, ok) => {
    pendentes--;
    if (pendentes === 0) {
      const ts2 = new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
      setStatus(`última atualização: ${ts2}`);
      if (syncTime) syncTime.textContent = ts2;
      const syncFooter = document.getElementById("syncFooter");
      if (syncFooter) syncFooter.textContent = `sync: ${ts2}`;
    }
    if (!ok) console.warn(`[${name}] falhou`);
  };
  tasks.forEach(([name, fn]) => {
    Promise.resolve(fn()).then(() => onDone(name, true)).catch(e => { console.error(name, e); onDone(name, false); });
  });

  // Vendedores grid recarrega se a aba já tiver sido visitada
  const grid = document.getElementById("vendedoresGrid");
  if (grid && grid.dataset.loaded === "1") { grid.dataset.loaded = "0"; loadVendedoresGrid(); }
}

// ====== DETEC PRODUTO ======
let detecProdutos = [];
let detecLista = [];

function fmtBRLPrice(n) {
  return Number(n).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function renderDetecTabela() {
  const tbody = document.querySelector("#tableDetec tbody");
  tbody.innerHTML = detecLista.map((r, i) => {
    const opcoes = detecProdutos.map(p =>
      `<option value="${p.id}" ${p.id === r.sugestao_produto_id ? "selected" : ""}>${p.name} · ${fmtBRLPrice(p.price)}</option>`
    ).join("");
    return `
      <tr data-i="${i}">
        <td><input type="checkbox" class="check-detec" ${r.sugestao_produto_id ? "checked" : ""}></td>
        <td><b>${r.leadName || "—"}</b><br><small style="color:var(--text-dim)">#${r.code}</small></td>
        <td>${r.attendantName}</td>
        <td>
          <select class="select-produto">
            <option value="">— pular —</option>
            ${opcoes}
          </select>
        </td>
        <td class="razoes" style="max-width:240px"><small>${r.razao || "<i style='color:var(--text-dim)'>sem indício na conversa</i>"}</small></td>
      </tr>
    `;
  }).join("");

  tbody.querySelectorAll("tr").forEach(tr => {
    const i = +tr.dataset.i;
    tr.querySelector(".check-detec").addEventListener("change", e => {
      detecLista[i]._incluir = e.target.checked;
      atualizaCountAplicar();
    });
    tr.querySelector(".select-produto").addEventListener("change", e => {
      detecLista[i].sugestao_produto_id = e.target.value || null;
      const cb = tr.querySelector(".check-detec");
      if (!e.target.value) { cb.checked = false; detecLista[i]._incluir = false; }
      else { cb.checked = true; detecLista[i]._incluir = true; }
      atualizaCountAplicar();
    });
    detecLista[i]._incluir = tr.querySelector(".check-detec").checked;
  });
  atualizaCountAplicar();
}

function atualizaCountAplicar() {
  const n = detecLista.filter(r => r._incluir && r.sugestao_produto_id).length;
  document.getElementById("countAplicar").textContent = n;
  document.getElementById("btnAplicarProdutos").disabled = n === 0;
}

async function abrirDetec() {
  document.getElementById("semProdutoModoLista").style.display = "none";
  const wrap = document.getElementById("semProdutoModoDetec");
  wrap.style.display = "block";
  document.getElementById("detecLoading").style.display = "block";
  document.getElementById("tableDetec").style.display = "none";
  document.getElementById("detecResumo").style.display = "none";
  document.getElementById("detecActions").style.display = "none";
  document.getElementById("detecResultado").style.display = "none";

  const res = await fetch("/api/agendados-sem-produto/sugestoes");
  const data = await res.json();
  detecProdutos = data.produtos;
  detecLista = data.lista;

  document.getElementById("detecLoading").style.display = "none";

  const detectados = detecLista.filter(r => r.sugestao_produto_id).length;
  const seis = detecLista.filter(r => r.sugestao_produto_id === detecProdutos.find(p => p.price === 697)?.id).length;
  const tres = detecLista.filter(r => r.sugestao_produto_id === detecProdutos.find(p => p.price === 497)?.id).length;
  const semDeteccao = detecLista.length - detectados;
  document.getElementById("detecResumo").style.display = "flex";
  document.getElementById("detecResumo").innerHTML = `
    <span class="carteira-stat">Total: <b>${detecLista.length}</b></span>
    <span class="carteira-stat carteira-stat-venda">Detectado 6 meses: <b>${seis}</b></span>
    <span class="carteira-stat carteira-stat-venda">Detectado 3 meses: <b>${tres}</b></span>
    <span class="carteira-stat carteira-stat-danger">Sem detecção: <b>${semDeteccao}</b></span>
  `;

  document.getElementById("tableDetec").style.display = "table";
  document.getElementById("detecActions").style.display = "block";
  renderDetecTabela();
}

function fecharDetec() {
  document.getElementById("semProdutoModoDetec").style.display = "none";
  document.getElementById("semProdutoModoLista").style.display = "block";
}

async function aplicarProdutos() {
  const aplicacoes = detecLista
    .filter(r => r._incluir && r.sugestao_produto_id)
    .map(r => ({ businessId: r.businessId, productId: r.sugestao_produto_id }));

  if (!aplicacoes.length) return;
  if (!confirm(`Confirmar aplicação em ${aplicacoes.length} negócios?\nEssa ação altera o CRM e não pode ser desfeita automaticamente.`)) return;

  const btn = document.getElementById("btnAplicarProdutos");
  btn.disabled = true;
  btn.textContent = `Aplicando ${aplicacoes.length}…`;

  const res = await fetch("/api/agendados-sem-produto/aplicar", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ aplicacoes }),
  });
  const data = await res.json();

  document.getElementById("detecResultado").style.display = "block";
  document.getElementById("detecResultado").innerHTML = `
    <div class="carteira-stats">
      <span class="carteira-stat carteira-stat-venda">Sucesso: <b>${data.sucesso}</b></span>
      <span class="carteira-stat carteira-stat-danger">Falhas: <b>${data.total - data.sucesso}</b></span>
    </div>
    ${data.resultados.filter(r => !r.ok).slice(0, 10).map(r => `<small style="color:var(--danger)">erro em ${r.businessId}: ${r.erro}</small><br>`).join("")}
  `;
  btn.textContent = "Aplicado!";
  setTimeout(() => { loadAll(); }, 2000);
}

// ====== EVENT LISTENERS ======
document.getElementById("btnApply").addEventListener("click", () => { closeDateDropdown(); loadAll(); });
document.getElementById("btnClear").addEventListener("click", () => {
  document.getElementById("dateFrom").value = "";
  document.getElementById("dateTo").value = "";
  applyPreset("tudo");
});
document.getElementById("btnRefresh").addEventListener("click", async () => {
  setStatus("limpando cache e recarregando...");
  await fetch("/api/refresh", { method: "POST" });
  loadAll();
});
document.getElementById("horasQuentes").addEventListener("change", loadQuentes);
document.getElementById("horasFechamento").addEventListener("change", loadFechamento);
document.getElementById("closeCart").addEventListener("click", () => {
  document.getElementById("carteiraPanel").style.display = "none";
});
document.getElementById("btnExpandCarteira").addEventListener("click", () => {
  const btn = document.getElementById("btnExpandCarteira");
  renderCarteira(btn.dataset.expanded !== "1");
});
document.getElementById("btnExpandSemProduto").addEventListener("click", () => {
  const btn = document.getElementById("btnExpandSemProduto");
  renderSemProduto(btn.dataset.expanded !== "1");
});
document.getElementById("btnDetectarProduto").addEventListener("click", abrirDetec);
document.getElementById("btnCancelDetec").addEventListener("click", fecharDetec);
document.getElementById("btnAplicarProdutos").addEventListener("click", aplicarProdutos);
document.getElementById("checkAllDetec").addEventListener("change", e => {
  document.querySelectorAll(".check-detec").forEach((cb, i) => {
    if (detecLista[i].sugestao_produto_id) {
      cb.checked = e.target.checked;
      detecLista[i]._incluir = e.target.checked;
    }
  });
  atualizaCountAplicar();
});

// Date dropdown
document.getElementById("btnDateDropdown").addEventListener("click", e => {
  e.stopPropagation();
  toggleDateDropdown();
});
document.querySelectorAll(".date-dropdown-menu button[data-preset]").forEach(btn => {
  btn.addEventListener("click", () => applyPreset(btn.dataset.preset));
});
document.addEventListener("click", e => {
  const dd = document.getElementById("dateDropdownMenu");
  const btn = document.getElementById("btnDateDropdown");
  if (!dd.contains(e.target) && !btn.contains(e.target)) closeDateDropdown();
});

// Ajuda
document.getElementById("btnAjuda").addEventListener("click", () => {
  alert("Comercial Hub · Controle Interno\n\n" +
    "📊 Dashboard — visão consolidada do dia\n" +
    "📈 Relatórios — atividade do time (em construção)\n" +
    "🕓 Futuros — leads em espera (em construção)\n" +
    "👥 Vendedores — ficha individual dos 4\n" +
    "📋 Registros — histórico diário (em construção)\n\n" +
    "Modo Otimista soma vendas confirmadas + futuros.\n" +
    "Modo Realista mostra só as confirmadas (AGENDADO)."
  );
});

// Init
setupTabs();
setupModeTabs();
applyPreset("hoje");  // já chama loadAll()
