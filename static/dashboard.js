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

function setStatus(msg, level = "info") {
  STATUS.textContent = msg;
  STATUS.style.color = level === "err" ? "var(--danger)" : "var(--text-dim)";
}

function periodParams() {
  const f = document.getElementById("dateFrom").value;
  const t = document.getElementById("dateTo").value;
  const params = new URLSearchParams();
  if (f) params.set("from", new Date(f).toISOString());
  if (t) params.set("to", new Date(t).toISOString());
  return params.toString();
}

async function fetchJson(path) {
  const q = periodParams();
  const url = q ? `${path}${path.includes("?") ? "&" : "?"}${q}` : path;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

async function loadResumo() {
  const data = await fetchJson("/api/resumo");
  const cards = [
    { label: "Vendas (Agendados)", value: data.vendas, highlight: true },
    { label: "Taxa de conversão", value: `${data.taxa_conversao}%` },
    { label: "Em fechamento", value: data.em_fechamento, hint: "aguardando confirmação humana" },
    { label: "Negócios no funil", value: data.total_negocios },
    { label: "Desqualificados", value: data.desqualificados, danger: true },
    { label: "Leads na base", value: data.total_leads.toLocaleString("pt-BR") },
    { label: "Conversas abertas", value: data.conversas_abertas },
  ];
  document.getElementById("cards").innerHTML = cards
    .map(c => {
      const cls = c.highlight ? "card highlight" : c.danger ? "card danger" : "card";
      const hint = c.hint ? `<div class="hint">${c.hint}</div>` : "";
      return `<div class="${cls}"><div class="label">${c.label}</div><div class="value">${c.value}</div>${hint}</div>`;
    })
    .join("");
}

function setCount(id, n) {
  const el = document.getElementById(id);
  if (el) el.textContent = n;
}

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
        backgroundColor: "#4f8cf2",
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

  // estatísticas por estágio
  const porEstagio = {};
  for (const b of data) {
    porEstagio[b.stageName] = (porEstagio[b.stageName] || 0) + 1;
  }
  const stats = [
    { stage: "AGENDADO", label: "Vendas", cls: "carteira-stat-venda" },
    { stage: "FECHAMENTO", label: "Fechamento" },
    { stage: "NEGOCIAÇÃO", label: "Negociação" },
    { stage: "GERAÇÃO DE VALOR", label: "Geração de valor" },
    { stage: "SONDAGEM", label: "Sondagem" },
    { stage: "APRESENTAÇÃO", label: "Apresentação" },
    { stage: "AGENDADO", label: "" },  // skip duplicate, handled
    { stage: "FOLLOW-UP", label: "Follow-up" },
    { stage: "LEAD PRA O FUTURO", label: "Futuro" },
    { stage: "DESQUALIFICADO", label: "Desqualificados", cls: "carteira-stat-danger" },
  ];
  const seen = new Set();
  document.getElementById("carteiraStats").innerHTML = stats
    .filter(s => s.label && porEstagio[s.stage] && !seen.has(s.stage) && seen.add(s.stage))
    .map(s => `<span class="carteira-stat ${s.cls || ''}">${s.label}: <b>${porEstagio[s.stage]}</b></span>`)
    .join("");

  renderCarteira(false);
  setStatus("");
  document.getElementById("carteiraPanel").scrollIntoView({ behavior: "smooth", block: "start" });
}

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
  // remove caracteres invisíveis de zero-width que aparecem em mensagens
  return text.replace(/[​-‍﻿]/g, "").trim() || "(mensagem invisível)";
}

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

async function loadGoldenBadge() {
  const res = await fetch("/api/golden-time");
  const data = await res.json();
  const el = document.getElementById("goldenBadge");
  el.textContent = `${data.mensagem} · ${String(data.hora_brasilia).padStart(2, "0")}h`;
  el.className = "golden-badge " + (data.is_peak ? "peak" : data.is_golden ? "golden" : "off");
}

async function loadAll() {
  setStatus("carregando dados...");
  try {
    await Promise.all([loadResumo(), loadFunil(), loadRanking(), loadConversas(), loadFechamento(), loadQuentes(), loadGoldenBadge(), loadSemProduto()]);
    const ts = new Date().toLocaleString("pt-BR");
    setStatus(`última atualização: ${ts}`);
    const syncFooter = document.getElementById("syncFooter");
    if (syncFooter) syncFooter.textContent = `sync: ${new Date().toLocaleTimeString("pt-BR", {hour: "2-digit", minute: "2-digit"})}`;
  } catch (e) {
    setStatus(`erro: ${e.message}`, "err");
    console.error(e);
  }
}

document.getElementById("btnApply").addEventListener("click", loadAll);
document.getElementById("btnClear").addEventListener("click", () => {
  document.getElementById("dateFrom").value = "";
  document.getElementById("dateTo").value = "";
  loadAll();
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

// ====== DETEC PRODUTO ======
let detecProdutos = [];   // [{id,name,price}]
let detecLista = [];      // mutável: usuário pode mudar o produto de cada linha

function fmtBRL(n) {
  return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function renderDetecTabela() {
  const tbody = document.querySelector("#tableDetec tbody");
  tbody.innerHTML = detecLista.map((r, i) => {
    const opcoes = detecProdutos.map(p =>
      `<option value="${p.id}" ${p.id === r.sugestao_produto_id ? "selected" : ""}>${p.name} · ${fmtBRL(p.price)}</option>`
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
  // recarrega o dashboard
  setTimeout(() => { loadAll(); }, 2000);
}

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

loadAll();
