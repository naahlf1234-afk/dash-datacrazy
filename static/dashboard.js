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
      // Carrega Vendedores lazy quando a aba abre
      if (target === "vendedores") loadVendedoresGrid();
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
        ? "Otimista — Confirmadas + Reservas/Futuros"
        : "Realista — Só vendas confirmadas (AGENDADO)";
      loadMetricas();
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

// ====== 8 CARDS DE MÉTRICAS ======
async function loadMetricas() {
  try {
    const [resumo, ranking] = await Promise.all([
      fetchJson("/api/resumo"),
      fetchJson("/api/ranking"),
    ]);

    // Otimista: vendas (AGENDADO) + em_fechamento como "futuros"
    // Realista: só AGENDADO
    const vendasConfirm = resumo.vendas;
    const futuros = resumo.em_fechamento;
    const totalVendas = currentMode === "otimista" ? vendasConfirm + futuros : vendasConfirm;

    document.getElementById("mLeads").textContent = resumo.total_leads.toLocaleString("pt-BR");
    document.getElementById("mLeadsHint").textContent = `${ranking.filter(r => r.userId && r.userId !== "outros").length} vendedores`;

    document.getElementById("mVendas").textContent = totalVendas;
    document.getElementById("mVendasHint").textContent =
      `${vendasConfirm} confirm. · ${futuros} futuros`;

    document.getElementById("mFuturos").textContent = futuros;

    const taxaConv = resumo.total_leads ? (totalVendas / resumo.total_leads * 100) : 0;
    document.getElementById("mConversao").textContent = fmtPct(taxaConv);

    // FATURAMENTO / TICKET: por enquanto baseado em business.total quando preenchido
    // (na Fase 2 trocamos pelo valor extraído do contrato)
    const fatRes = await fetch("/api/faturamento").catch(() => null);
    if (fatRes && fatRes.ok) {
      const fat = await fatRes.json();
      document.getElementById("mFaturamento").textContent = fmtBRL(fat.faturamento);
      document.getElementById("mTicket").textContent = fmtBRL(fat.ticket_medio);
      document.getElementById("mSeisMeses").textContent = fmtPct(fat.pct_6_meses);
      document.getElementById("mAntecipadas").textContent = fmtPct(fat.pct_antecipadas);
    } else {
      document.getElementById("mFaturamento").textContent = "—";
      document.getElementById("mTicket").textContent = "—";
      document.getElementById("mSeisMeses").textContent = "—";
      document.getElementById("mAntecipadas").textContent = "—";
    }
  } catch (e) {
    console.error("loadMetricas:", e);
  }
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
        // Por enquanto, troca pra tab Dashboard e abre a carteira
        document.querySelector('.nav-item[data-tab="dashboard"]').click();
        setTimeout(() => loadCarteira(card.dataset.user, card.dataset.name), 200);
      });
    });
    grid.dataset.loaded = "1";
  } catch (e) {
    grid.innerHTML = `<div class="placeholder-panel"><p>Erro ao carregar vendedores: ${e.message}</p></div>`;
  }
}

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
async function loadAll() {
  setStatus("carregando dados...");
  try {
    await Promise.all([
      loadMetricas(),
      loadFunil(),
      loadRanking(),
      loadConversas(),
      loadFechamento(),
      loadQuentes(),
      loadGoldenBadge(),
      loadSemProduto(),
      loadSemContrato(),
    ]);
    const ts = new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    setStatus(`última atualização: ${ts}`);
    const syncTime = document.getElementById("syncTime");
    if (syncTime) syncTime.textContent = ts;
    const syncFooter = document.getElementById("syncFooter");
    if (syncFooter) syncFooter.textContent = `sync: ${ts}`;
    // Vendedores grid recarrega se a aba já tiver sido visitada
    const grid = document.getElementById("vendedoresGrid");
    if (grid && grid.dataset.loaded === "1") { grid.dataset.loaded = "0"; loadVendedoresGrid(); }
  } catch (e) {
    setStatus(`erro: ${e.message}`, "err");
    console.error(e);
  }
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
