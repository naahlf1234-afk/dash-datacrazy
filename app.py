"""Servidor Flask do dashboard comercial."""
from __future__ import annotations

import os
import threading
import time
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from typing import Any

from flask import Flask, jsonify, render_template, request

import contract_parser
import datacrazy_client as dc

app = Flask(__name__)

# Operação atual começa em 22/05/2026 — qualquer movimentação antes disso é
# histórico de operação anterior e NÃO entra nas métricas.
OPERATION_START_DATE = datetime(2026, 5, 22, 0, 0, 0, tzinfo=timezone.utc)


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _is_in_period(iso: str | None, date_from: datetime | None, date_to: datetime | None) -> bool:
    if not date_from and not date_to:
        return True
    moment = _parse_iso(iso)
    if not moment:
        return False
    if date_from and moment < date_from:
        return False
    if date_to and moment > date_to:
        return False
    return True


def _effective_from(date_from: datetime | None) -> datetime:
    """Aplica o piso da operação. Filtros podem ser mais restritivos, nunca menos."""
    if date_from and date_from > OPERATION_START_DATE:
        return date_from
    return OPERATION_START_DATE


def _filter_period(businesses: list[dict], date_from: datetime | None, date_to: datetime | None) -> list[dict]:
    eff_from = _effective_from(date_from)
    return [b for b in businesses if _is_in_period(b.get("lastMovedAt"), eff_from, date_to)]


def _get_period():
    df = _parse_iso(request.args.get("from"))
    dt = _parse_iso(request.args.get("to"))
    return df, dt


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/refresh", methods=["POST"])
def refresh():
    dc.clear_cache()
    return jsonify({"ok": True})


STAGE_VENDA = "AGENDADO"
STAGE_PRE_VENDA = "FECHAMENTO"
STAGE_PERDA = "DESQUALIFICADO"
STAGE_LATENTE = "LEAD PRA O FUTURO"


@app.route("/api/resumo")
def resumo():
    """Cards de topo: vendas, em fechamento (pre-venda humana), desqualificados, leads, conversas."""
    df, dt = _get_period()
    businesses = _filter_period(dc.all_businesses_api_pipeline(), df, dt)
    # Leads: não filtra por data (formato YYYY-MM-DD não é aceito pelo MCP e
    # ISO completo é caro de paginar). total_leads conta a base inteira;
    # taxa_conversao usa total_leads, então o % fica subestimado mas estável.
    leads_list = dc.leads()
    convs = dc.conversations(status="opened")

    total_negocios = len(businesses)
    vendas = sum(1 for b in businesses if b.get("stageName") == STAGE_VENDA)
    em_fechamento = sum(1 for b in businesses if b.get("stageName") == STAGE_PRE_VENDA)
    desqualificados = sum(1 for b in businesses if b.get("stageName") == STAGE_PERDA)

    # taxa de conversão: vendas / negócios que saíram do topo
    base_conversao = total_negocios - sum(
        1 for b in businesses if b.get("stageName") == "APRESENTAÇÃO"
    )
    taxa_conversao = round((vendas / base_conversao * 100), 1) if base_conversao else 0

    return jsonify({
        "total_negocios": total_negocios,
        "vendas": vendas,
        "em_fechamento": em_fechamento,
        "desqualificados": desqualificados,
        "taxa_conversao": taxa_conversao,
        "total_leads": len(leads_list),
        "conversas_abertas": len(convs),
    })


# ===== EXTRAÇÃO DE CONTRATOS (FASE 2) =====
_contracts_cache_lock = threading.Lock()
_contracts_cache: dict[str, Any] = {"ts": 0.0, "data": []}
CONTRACTS_CACHE_TTL = 600  # 10 min


def _extract_one_contract(biz: dict) -> dict:
    """Lê a conversa do lead e tenta extrair o contrato. Devolve sempre algo (com ou sem contract)."""
    lead_id = biz.get("leadId")
    contract = None
    if lead_id:
        conv = dc.conversation_by_lead(lead_id)
        if conv and conv.get("id"):
            msgs = dc.conversation_messages(conv["id"], limit=50)
            contract = contract_parser.find_contract_in_messages(msgs)
    return {
        "businessId": biz.get("id"),
        "code": biz.get("code"),
        "leadId": lead_id,
        "leadName": biz.get("leadName"),
        "attendantId": biz.get("attendantId"),
        "attendantName": (biz.get("attendantName") or "—").strip(),
        "lastMovedAt": biz.get("lastMovedAt"),
        "business_total": biz.get("total") or 0,
        "contract": contract,
    }


def _get_all_contracts_cached() -> list[dict]:
    """Extrai contratos de TODOS os AGENDADO pós-22/05/2026. Cache 10 min.
    Primeira chamada é cara (~30-60s com paralelismo), depois é instantânea."""
    with _contracts_cache_lock:
        if time.time() - _contracts_cache["ts"] < CONTRACTS_CACHE_TTL and _contracts_cache["data"]:
            return _contracts_cache["data"]

    stage_id = next(s["id"] for s in dc.STAGES_API if s["name"] == STAGE_VENDA)
    agendados = dc.businesses_by_stage(stage_id)

    # aplica o piso da operação
    agendados_pos = []
    for b in agendados:
        moved = _parse_iso(b.get("lastMovedAt"))
        if moved and moved >= OPERATION_START_DATE:
            agendados_pos.append(b)

    results: list[dict] = []
    with ThreadPoolExecutor(max_workers=10) as pool:
        futures = [pool.submit(_extract_one_contract, b) for b in agendados_pos]
        for fut in as_completed(futures):
            try:
                results.append(fut.result())
            except Exception as e:
                print(f"[contratos] erro extraindo: {e}")

    with _contracts_cache_lock:
        _contracts_cache["ts"] = time.time()
        _contracts_cache["data"] = results

    return results


def _filter_contracts_in_period(all_data: list[dict], df: datetime | None, dt: datetime | None) -> list[dict]:
    eff_from = _effective_from(df)
    out = []
    for d in all_data:
        moved = _parse_iso(d.get("lastMovedAt"))
        if not moved or moved < eff_from:
            continue
        if dt and moved > dt:
            continue
        out.append(d)
    return out


@app.route("/api/faturamento")
def faturamento():
    """Faturamento, ticket médio, % 6 meses, % antecipadas a partir dos contratos extraídos."""
    df, dt = _get_period()
    all_data = _get_all_contracts_cached()
    in_window = _filter_contracts_in_period(all_data, df, dt)
    com_contrato = [d for d in in_window if d["contract"]]

    valores = [d["contract"]["valor"] for d in com_contrato if d["contract"].get("valor")]
    fat = sum(valores)
    ticket = (fat / len(valores)) if valores else 0

    seis = sum(1 for d in com_contrato if d["contract"].get("plano_meses") == 6)
    pct_6 = (seis / len(com_contrato) * 100) if com_contrato else 0

    antecip = sum(1 for d in com_contrato if d["contract"].get("is_antecipada") is True)
    pct_antecip = (antecip / len(com_contrato) * 100) if com_contrato else 0

    return jsonify({
        "faturamento": round(fat, 2),
        "ticket_medio": round(ticket, 2),
        "total_agendados": len(in_window),
        "com_contrato": len(com_contrato),
        "sem_contrato": len(in_window) - len(com_contrato),
        "pct_6_meses": round(pct_6, 1),
        "pct_antecipadas": round(pct_antecip, 1),
    })


@app.route("/api/contratos")
def contratos():
    """Lista completa dos contratos extraídos no período."""
    df, dt = _get_period()
    all_data = _get_all_contracts_cached()
    in_window = _filter_contracts_in_period(all_data, df, dt)
    return jsonify({
        "total": len(in_window),
        "com_contrato": sum(1 for d in in_window if d["contract"]),
        "sem_contrato": sum(1 for d in in_window if not d["contract"]),
        "lista": in_window,
    })


@app.route("/api/sem-contrato")
def sem_contrato():
    """Vendas AGENDADAS que NÃO têm contrato enviado na conversa do CRM.
    Esse é o alerta principal pra o gerente: venda suspeita / não formalizada."""
    df, dt = _get_period()
    all_data = _get_all_contracts_cached()
    in_window = _filter_contracts_in_period(all_data, df, dt)
    sem = [d for d in in_window if not d["contract"]]
    sem.sort(key=lambda x: x.get("lastMovedAt") or "", reverse=True)

    # agrupa por vendedor pra mostrar quem tá deixando passar
    by_vendedor: dict[str, int] = {}
    for d in sem:
        n = d["attendantName"]
        by_vendedor[n] = by_vendedor.get(n, 0) + 1
    by_vendedor_list = sorted(
        [{"vendedor": k, "count": v} for k, v in by_vendedor.items()],
        key=lambda x: x["count"], reverse=True,
    )

    return jsonify({
        "total_sem_contrato": len(sem),
        "total_no_periodo": len(in_window),
        "por_vendedor": by_vendedor_list,
        "lista": sem[:50],
    })


@app.route("/api/funil")
def funil():
    df, dt = _get_period()
    businesses = _filter_period(dc.all_businesses_api_pipeline(), df, dt)
    counts: Counter[str] = Counter()
    for b in businesses:
        counts[b.get("stageName", "?")] += 1

    out = []
    for stage in dc.STAGES_API:
        out.append({
            "stage": stage["name"],
            "index": stage["index"],
            "count": counts.get(stage["name"], 0),
        })
    return jsonify(out)


def _new_bucket(user_id: str | None, name: str) -> dict[str, Any]:
    return {
        "userId": user_id,
        "name": name,
        "total": 0,
        "vendas": 0,
        "em_fechamento": 0,
        "em_negociacao": 0,
        "desqualificados": 0,
        "ativos": 0,
        "por_estagio": defaultdict(int),
    }


@app.route("/api/ranking")
def ranking():
    df, dt = _get_period()
    businesses = _filter_period(dc.all_businesses_api_pipeline(), df, dt)
    att_to_user = dc.attendant_id_to_user_id()

    by_user: dict[str, dict[str, Any]] = {
        v["userId"]: _new_bucket(v["userId"], v["name"].strip()) for v in dc.VENDEDORES
    }
    sem_dono = _new_bucket(None, "Sem atendente")
    outros = _new_bucket("outros", "Outros atendentes")

    estagios_ativos = {"SONDAGEM", "GERAÇÃO DE VALOR", "NEGOCIAÇÃO", "FECHAMENTO"}

    for b in businesses:
        att_id = b.get("attendantId")
        if not att_id:
            bucket = sem_dono
        else:
            user_id = att_to_user.get(att_id)
            bucket = by_user.get(user_id, outros) if user_id else outros

        bucket["total"] += 1
        stage = b.get("stageName", "?")
        bucket["por_estagio"][stage] += 1
        if stage == STAGE_VENDA:
            bucket["vendas"] += 1
        elif stage == STAGE_PRE_VENDA:
            bucket["em_fechamento"] += 1
        if stage == "NEGOCIAÇÃO":
            bucket["em_negociacao"] += 1
        if stage == STAGE_PERDA:
            bucket["desqualificados"] += 1
        if stage in estagios_ativos:
            bucket["ativos"] += 1

    result = list(by_user.values()) + [sem_dono, outros]
    for r in result:
        # taxa de conversão: vendas / (vendas + ativos + perdas) — exclui topo e latentes
        base = r["vendas"] + r["ativos"] + r["desqualificados"]
        r["taxa_conversao"] = round((r["vendas"] / base * 100), 1) if base else 0
        r["por_estagio"] = dict(r["por_estagio"])
    result.sort(key=lambda x: x["vendas"], reverse=True)
    return jsonify(result)


@app.route("/api/carteira/<user_id>")
def carteira(user_id: str):
    df, dt = _get_period()
    businesses = _filter_period(dc.businesses_by_attendant(user_id), df, dt)
    api_only = [b for b in businesses if b.get("pipelineId") == dc.PIPELINE_API_ID]
    api_only.sort(key=lambda x: x.get("lastMovedAt", ""), reverse=True)
    return jsonify(api_only)


@app.route("/api/parados")
def parados():
    """Negócios sem movimento há mais de N dias (default 7)."""
    dias = int(request.args.get("dias", 7))
    now = _now_utc()
    businesses = dc.all_businesses_api_pipeline()

    out = []
    for b in businesses:
        if b.get("stageName") in ("DESQUALIFICADO", "LEAD PRA O FUTURO"):
            continue
        moved = _parse_iso(b.get("lastMovedAt"))
        if not moved:
            continue
        dias_parado = (now - moved).days
        if dias_parado >= dias:
            out.append({**b, "dias_parado": dias_parado})

    out.sort(key=lambda x: x["dias_parado"], reverse=True)
    return jsonify(out[:100])


@app.route("/api/conversas")
def conversas_endpoint():
    convs_open = dc.conversations(status="opened")
    convs_wait = dc.conversations(status="waiting")

    by_vendedor: dict[str, int] = {v["name"]: 0 for v in dc.VENDEDORES}
    sem_atendente = 0
    outros = 0

    for c in convs_open + convs_wait:
        atts = c.get("attendants") or []
        if not atts:
            sem_atendente += 1
            continue
        matched = False
        for a in atts:
            for v in dc.VENDEDORES:
                if (a.get("name") or "").strip().lower() == v["name"].strip().lower():
                    by_vendedor[v["name"]] += 1
                    matched = True
                    break
            if matched:
                break
        if not matched:
            outros += 1

    return jsonify({
        "total_abertas": len(convs_open),
        "total_aguardando": len(convs_wait),
        "por_vendedor": by_vendedor,
        "sem_atendente": sem_atendente,
        "outros": outros,
    })


@app.route("/api/vendedores")
def vendedores():
    return jsonify(dc.VENDEDORES)


@app.route("/api/golden-time")
def golden_time():
    """Retorna se o momento atual está dentro do horário nobre (11h-16h Brasília)
    onde 66% das vendas acontecem. Pico absoluto: 13h-14h."""
    now_brt = _now_utc().timestamp() - 3 * 3600  # UTC-3
    hour = (int(now_brt // 3600) % 24)
    is_golden = 11 <= hour <= 16
    is_peak = hour in (13, 14)
    return jsonify({
        "hora_brasilia": hour,
        "is_golden": is_golden,
        "is_peak": is_peak,
        "mensagem": "🎯 PICO DE VENDAS" if is_peak else "🟢 GOLDEN TIME" if is_golden else f"⏰ Fora do horário nobre (pico é 13h-14h)",
    })


PRODUTO_6_MESES_ID = "7727f306-42e0-40d3-a436-9557d7ead5ae"
PRODUTO_3_MESES_ID = "2cd02674-cef6-450f-825e-25e7cba08914"

DETEC_PRODUTO_6 = ["697", "6 meses", "seis meses", "plano 6", "plano de 6", "plano vitalidade"]
DETEC_PRODUTO_3 = ["497", "3 meses", "três meses", "tres meses", "plano 3", "plano de 3"]


def _detectar_produto(messages: list[dict]) -> tuple[str | None, str]:
    """Olha as msgs (do lead E do atendente) e tenta detectar qual plano foi vendido.
    Retorna (productId, razão_legível) ou (None, '').
    Prioriza match mais recente."""
    for m in messages:  # mais recentes primeiro
        body = (m.get("body") or "").lower()
        if not body:
            continue
        for kw in DETEC_PRODUTO_6:
            if kw in body:
                return PRODUTO_6_MESES_ID, f"'{kw}' em msg de {'lead' if m.get('received') else 'vendedor'}"
        for kw in DETEC_PRODUTO_3:
            if kw in body:
                return PRODUTO_3_MESES_ID, f"'{kw}' em msg de {'lead' if m.get('received') else 'vendedor'}"
    return None, ""


@app.route("/api/agendados-sem-produto/sugestoes")
def sugestoes_produto():
    """Para cada agendado sem produto, detecta o produto provável lendo a conversa."""
    stage_id = next(s["id"] for s in dc.STAGES_API if s["name"] == "AGENDADO")
    agendados = dc.businesses_by_stage(stage_id)
    sem = [b for b in agendados if (b.get("productsCount") or 0) == 0]
    sem.sort(key=lambda b: b.get("lastMovedAt") or "", reverse=True)

    produtos = {p["id"]: p for p in dc.products()}
    out = []
    for biz in sem:
        lead_id = biz.get("leadId")
        produto_id = None
        razao = ""
        if lead_id:
            conv = dc.conversation_by_lead(lead_id)
            if conv and conv.get("id"):
                msgs = dc.conversation_messages(conv["id"], limit=50)
                produto_id, razao = _detectar_produto(msgs)

        produto_nome = produtos[produto_id]["name"] if produto_id else None
        produto_preco = produtos[produto_id]["price"] if produto_id else None

        out.append({
            "businessId": biz.get("id"),
            "code": biz.get("code"),
            "leadId": lead_id,
            "leadName": biz.get("leadName"),
            "attendantName": (biz.get("attendantName") or "—").strip(),
            "lastMovedAt": biz.get("lastMovedAt"),
            "sugestao_produto_id": produto_id,
            "sugestao_produto_nome": produto_nome,
            "sugestao_produto_preco": produto_preco,
            "razao": razao,
        })
    return jsonify({
        "produtos": [{"id": p["id"], "name": p["name"], "price": p["price"]} for p in dc.products()],
        "lista": out,
    })


@app.route("/api/agendados-sem-produto/aplicar", methods=["POST"])
def aplicar_produtos():
    """Recebe { aplicacoes: [{ businessId, productId }] } e aplica em lote."""
    payload = request.get_json(silent=True) or {}
    aplicacoes = payload.get("aplicacoes") or []
    resultados = []
    for ap in aplicacoes:
        bid = ap.get("businessId")
        pid = ap.get("productId")
        if not bid or not pid:
            resultados.append({"businessId": bid, "ok": False, "erro": "campos obrigatórios"})
            continue
        try:
            dc.add_product(bid, pid, quantity=1)
            resultados.append({"businessId": bid, "ok": True})
        except Exception as e:
            resultados.append({"businessId": bid, "ok": False, "erro": str(e)[:200]})
    # invalida cache de negócios pra refletir
    dc.clear_cache()
    return jsonify({"resultados": resultados, "total": len(resultados),
                    "sucesso": sum(1 for r in resultados if r["ok"])})


@app.route("/api/agendados-sem-produto")
def agendados_sem_produto():
    """Lista negócios em AGENDADO sem produtos vinculados (productsCount == 0)."""
    stage_id = next(s["id"] for s in dc.STAGES_API if s["name"] == "AGENDADO")
    agendados = dc.businesses_by_stage(stage_id)
    sem = [b for b in agendados if (b.get("productsCount") or 0) == 0]
    com = len(agendados) - len(sem)
    sem.sort(key=lambda b: b.get("lastMovedAt") or "", reverse=True)
    out = []
    for b in sem:
        out.append({
            "id": b.get("id"),
            "code": b.get("code"),
            "leadId": b.get("leadId"),
            "leadName": b.get("leadName"),
            "attendantName": (b.get("attendantName") or "—").strip(),
            "lastMovedAt": b.get("lastMovedAt"),
        })
    return jsonify({
        "total_agendados": len(agendados),
        "com_produto": com,
        "sem_produto": len(sem),
        "lista": out,
    })


@app.route("/api/motivos-perda")
def motivos_perda():
    """Lista os motivos de perda configurados. Histórico de perdas
    por motivo precisaria de endpoint adicional na API."""
    return jsonify(dc.loss_reasons())


def _format_msg_preview(msg: dict) -> str:
    body = (msg.get("body") or "").strip()
    if body:
        return body[:140]
    atts = msg.get("attachments") or []
    if atts:
        t = (atts[0].get("type") or "?").lower()
        emojis = {"audio": "🎤 áudio", "video": "🎬 vídeo", "image": "🖼️ imagem", "document": "📄 documento"}
        return f"[{emojis.get(t, t)}]"
    return "—"


def _last_lead_message(messages: list[dict]) -> dict | None:
    for m in messages:
        if not m.get("received"):
            continue
        if m.get("body") or m.get("attachments"):
            return m
    return None


KEYWORDS_PAGAMENTO = [
    "boleto", "pix", "cartão", "cartao", "entrada", "parcela", "pagamento",
    "pagar", "pago", "valor", "quanto", "forma de pagamento",
]
KEYWORDS_DADOS = [
    "cpf", "nome", "rua", "endereço", "endereco",
]
KEYWORDS_INTENCAO = [
    "quero", "comprar", "fechar", "fechado", "manda", "envia", "consigo",
    "vou fazer", "aceito", "topo", "vamos fechar",
]

# Tags que tiram o lead da lista de quentes (não pontuam — só filtram).
TAGS_FILTRO_QUENTES = {
    "DESQUALIFICADO",
    "CLIENTE JÁ COMPROU O TRATAMENTO",
}

STAGE_SCORES_QUENTE = {
    "FECHAMENTO": 20,
    "NEGOCIAÇÃO": 15,
    "GERAÇÃO DE VALOR": 10,
    "SONDAGEM": 5,
}

ANUNCIO_FRASES = [
    "olá doutor quero saber mais",
    "ola doutor quero saber mais",
    "doutor quero saber mais",
    "olá doutor, quero saber mais",
    "ola doutor, quero saber mais",
]


def _is_anuncio(text: str) -> bool:
    low = (text or "").lower().strip()
    return any(f in low for f in ANUNCIO_FRASES)


def _keyword_hits_in_messages(bodies: list[str]) -> tuple[int, list[str]]:
    """Varre TODAS as mensagens do lead procurando palavras-chave únicas.
    Cada keyword conta uma vez só (mesmo se aparecer em várias msgs).
    Ignora frase do anúncio."""
    hits_pag: set[str] = set()
    hits_dad: set[str] = set()
    hits_int: set[str] = set()
    for body in bodies:
        if not body or _is_anuncio(body):
            continue
        low = body.lower()
        for kw in KEYWORDS_PAGAMENTO:
            if kw in low:
                hits_pag.add(kw)
        for kw in KEYWORDS_DADOS:
            if kw in low:
                hits_dad.add(kw)
        for kw in KEYWORDS_INTENCAO:
            if kw in low:
                hits_int.add(kw)

    razoes: list[str] = []
    pts = 0
    if hits_pag:
        p = min(len(hits_pag) * 15, 30)
        pts += p
        razoes.append(f"+{p} pagamento ({', '.join(sorted(hits_pag)[:3])})")
    if hits_dad:
        p = min(len(hits_dad) * 12, 24)
        pts += p
        razoes.append(f"+{p} dados ({', '.join(sorted(hits_dad)[:3])})")
    if hits_int:
        p = min(len(hits_int) * 8, 16)
        pts += p
        razoes.append(f"+{p} intenção ({', '.join(sorted(hits_int)[:3])})")
    return pts, razoes


def _recency_score(iso: str | None) -> tuple[int, str]:
    """Retorna (pontos, descrição amigável com a idade da última msg)."""
    if not iso:
        return 0, ""
    m = _parse_iso(iso)
    if not m:
        return 0, ""
    hours = (_now_utc() - m).total_seconds() / 3600
    if hours < 1:
        label = f"última msg há {int(hours * 60)}min"
    elif hours < 24:
        label = f"última msg há {int(hours)}h"
    else:
        label = f"última msg há {int(hours / 24)}d"
    if hours < 2:
        return 10, label
    if hours < 24:
        return 5, label
    if hours < 72:
        return 0, label
    return -5, label


@app.route("/api/leads-quentes")
def leads_quentes():
    """Score de leads quentes nos estágios ativos. Combina tags, palavras-chave e recência.
    Filtra somente negócios que entraram no estágio dentro da janela (default 24h)."""
    horas = int(request.args.get("horas", 24))
    stages_quentes = ["SONDAGEM", "GERAÇÃO DE VALOR", "NEGOCIAÇÃO", "FECHAMENTO"]
    cutoff = _now_utc().timestamp() - horas * 3600
    all_biz = dc.all_businesses_api_pipeline()
    biz_ativos = []
    for b in all_biz:
        if b.get("stageName") not in stages_quentes:
            continue
        moved = _parse_iso(b.get("lastMovedAt"))
        if moved and moved.timestamp() >= cutoff:
            biz_ativos.append(b)

    lead_ids = list({b["leadId"] for b in biz_ativos if b.get("leadId")})
    leads = dc.lead_by_ids(lead_ids)
    leads_by_id = {l["id"]: l for l in leads}

    convs = dc.conversations(status="all")
    convs_by_lead: dict[str, dict] = {}
    for c in convs:
        lid = c.get("leadId")
        if not lid:
            continue
        existing = convs_by_lead.get(lid)
        if not existing or (c.get("lastMessageDate") or "") > (existing.get("lastMessageDate") or ""):
            convs_by_lead[lid] = c

    now = _now_utc()
    scored = []
    for biz in biz_ativos:
        lid = biz.get("leadId")
        if not lid:
            continue
        lead = leads_by_id.get(lid, {})
        conv = convs_by_lead.get(lid, {})

        score = 0
        razoes: list[str] = []

        # tags só filtram (não pontuam): pula leads desqualificados ou que já compraram
        tags_upper = {(t.get("name") or "").strip().upper() for t in (lead.get("tags") or [])}
        if any(filtro in tags_upper for filtro in TAGS_FILTRO_QUENTES):
            continue

        # abre TODAS as msgs do lead (últimas 50, dos últimos 7 dias)
        # pra detectar áudio E palavras-chave em qualquer mensagem,
        # não só na última. Aproveita uma chamada só.
        mandou_audio = False
        ultima_msg_lead_body = ""
        ultima_msg_lead_em = None
        bodies_lead: list[str] = []
        conv_id = conv.get("id")
        if conv_id:
            msgs = dc.conversation_messages(conv_id, limit=50)
            limite_idade = _now_utc().timestamp() - 7 * 86400
            for m in msgs:
                if not m.get("received"):
                    continue
                m_dt = _parse_iso(m.get("createdAt"))
                if m_dt and m_dt.timestamp() < limite_idade:
                    continue
                body = (m.get("body") or "").strip()
                if body:
                    bodies_lead.append(body)
                    if not ultima_msg_lead_body:  # msgs vêm do mais novo pro mais antigo
                        ultima_msg_lead_body = body
                        ultima_msg_lead_em = m.get("createdAt")
                for a in (m.get("attachments") or []):
                    if (a.get("type") or "").upper() == "AUDIO":
                        mandou_audio = True

        # OBRIGATÓRIO: lead só entra no radar se demonstrou intenção.
        # Varre TODAS as msgs do lead (não só a última) procurando keywords.
        kw_pts, kw_razoes = _keyword_hits_in_messages(bodies_lead)
        if kw_pts == 0:
            continue
        score += kw_pts
        razoes.extend(kw_razoes)

        # estágio
        stage = biz.get("stageName", "")
        stage_pts = STAGE_SCORES_QUENTE.get(stage, 0)
        if stage_pts:
            score += stage_pts
            razoes.append(f"+{stage_pts} estágio {stage}")

        if mandou_audio:
            score += 10
            razoes.append("+10 mandou áudio")

        # recência da última msg DO LEAD (não do atendente)
        rec_pts, rec_label = _recency_score(ultima_msg_lead_em or conv.get("lastMessageDate"))
        if rec_pts != 0 or rec_label:
            score += rec_pts
            if rec_pts != 0:
                sinal = "+" if rec_pts > 0 else ""
                razoes.append(f"{sinal}{rec_pts} {rec_label}")
            else:
                razoes.append(rec_label)

        # tempo parado no estágio
        moved = _parse_iso(biz.get("lastMovedAt"))
        if moved:
            dias = (now - moved).days
            if dias > 7:
                penal = -min(dias - 7, 15)
                score += penal
                razoes.append(f"{penal} parado {dias}d")

        # pula leads com score muito baixo
        if score <= 0:
            continue

        scored.append({
            "code": biz.get("code"),
            "leadId": lid,
            "leadName": biz.get("leadName"),
            "attendantName": (biz.get("attendantName") or "—").strip(),
            "stageName": stage,
            "score": score,
            "razoes": razoes,
            "ultima_msg_em": ultima_msg_lead_em or conv.get("lastMessageDate"),
            "ultima_msg_preview": (ultima_msg_lead_body or "")[:140],
            "conversationId": conv.get("id"),
            "mandou_audio": mandou_audio,
        })

    scored.sort(key=lambda x: x["score"], reverse=True)
    return jsonify(scored[:20])


@app.route("/api/leads-fechamento")
def leads_fechamento():
    """Negócios que entraram em FECHAMENTO dentro da janela (default 24h),
    com preview da última msg do lead."""
    horas = int(request.args.get("horas", 24))
    stage_id = next(s["id"] for s in dc.STAGES_API if s["name"] == "FECHAMENTO")
    todos = dc.businesses_by_stage(stage_id)
    cutoff = _now_utc().timestamp() - horas * 3600
    fechamentos = []
    for b in todos:
        moved = _parse_iso(b.get("lastMovedAt"))
        if moved and moved.timestamp() >= cutoff:
            fechamentos.append(b)
    now = _now_utc()

    result = []
    for biz in fechamentos:
        lead_id = biz.get("leadId")
        conv = dc.conversation_by_lead(lead_id) if lead_id else None

        preview = "—"
        ultima_msg_em = None
        conv_id = None
        if conv and conv.get("id"):
            conv_id = conv["id"]
            msgs = dc.conversation_messages(conv_id, limit=20)
            last_lead_msg = _last_lead_message(msgs)
            if last_lead_msg:
                preview = _format_msg_preview(last_lead_msg)
                ultima_msg_em = last_lead_msg.get("createdAt")
            elif msgs:
                preview = "(sem resposta do lead) " + _format_msg_preview(msgs[0])

        moved = _parse_iso(biz.get("lastMovedAt"))
        dias_no_estagio = (now - moved).days if moved else None

        result.append({
            "code": biz.get("code"),
            "leadId": lead_id,
            "leadName": biz.get("leadName"),
            "attendantName": (biz.get("attendantName") or "—").strip(),
            "lastMovedAt": biz.get("lastMovedAt"),
            "dias_no_estagio": dias_no_estagio,
            "preview_lead": preview,
            "ultima_msg_em": ultima_msg_em,
            "conversationId": conv_id,
        })

    # ordena por mensagem mais recente do lead (quentes primeiro)
    def _sort_key(r):
        return r.get("ultima_msg_em") or r.get("lastMovedAt") or ""
    result.sort(key=_sort_key, reverse=True)
    return jsonify(result)


if __name__ == "__main__":
    # 0.0.0.0 permite acesso de outros dispositivos na mesma rede Wi-Fi
    # (celular, outro PC). No celular, acesse http://<IP-DO-PC>:5000
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=True)
