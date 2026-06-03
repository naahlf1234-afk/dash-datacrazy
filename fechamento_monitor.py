"""Monitor de alta frequência da etapa FECHAMENTO.

Roda em background a cada SNAPSHOT_INTERVAL_SECONDS, detecta:
- Entradas: leads que apareceram em FECHAMENTO desde o último snapshot
- Saídas: leads que sumiram de FECHAMENTO (foram pra outro estágio)

Grava cada evento como uma linha JSON em FECHAMENTO_LOG_PATH.
A partir desses eventos dá pra reconstruir EXATAMENTE quantos
leads passaram por FECHAMENTO em qualquer período (a partir do bootstrap).

Limitação: depende do container estar acordado. Em Render Free precisa
de auto-ping (UptimeRobot ou similar) pra manter rodando 24/7.
"""
from __future__ import annotations

import json
import os
import threading
import time
from datetime import datetime, timezone

import datacrazy_client as dc

LOG_FILE = os.environ.get("FECHAMENTO_LOG_PATH", "fechamento_events.jsonl")
SNAPSHOT_INTERVAL_SECONDS = int(os.environ.get("FECHAMENTO_SNAPSHOT_INTERVAL", "180"))  # 3 min

_state_lock = threading.Lock()
_last_snapshot: dict[str, dict] = {}
_started_at: str | None = None
_total_events = 0
_started = False


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _stage_id_fechamento() -> str:
    return next(s["id"] for s in dc.STAGES_API if s["name"] == "FECHAMENTO")


def _snapshot_fresh() -> dict[str, dict]:
    """Bate no MCP sem usar cache pra pegar dado real-time da etapa FECHAMENTO."""
    sid = _stage_id_fechamento()
    bizs = dc._paginate("business_list_by_stage", {"stageId": sid})
    # atualiza cache pros outros endpoints (não desperdicia)
    dc._cache.set(("biz_stage", sid), bizs)
    return {b["id"]: b for b in bizs}


def _append_event(event: dict):
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(json.dumps(event, ensure_ascii=False) + "\n")
    except Exception as e:
        print(f"[fech-mon] erro gravando evento: {e}", flush=True)


def _diff_and_log(prev: dict, current: dict) -> tuple[int, int]:
    """Compara snapshots, grava entradas e saídas. Retorna (entered, exited)."""
    global _total_events
    now = _now_iso()
    prev_ids = set(prev.keys())
    cur_ids = set(current.keys())
    entered_ids = cur_ids - prev_ids
    exited_ids = prev_ids - cur_ids

    for bid in entered_ids:
        b = current[bid]
        _append_event({
            "type": "entered",
            "businessId": bid,
            "code": b.get("code"),
            "leadId": b.get("leadId"),
            "leadName": b.get("leadName"),
            "attendantId": b.get("attendantId"),
            "attendantName": b.get("attendantName"),
            "at": now,
        })

    for bid in exited_ids:
        b = prev.get(bid, {})
        _append_event({
            "type": "exited",
            "businessId": bid,
            "code": b.get("code"),
            "leadId": b.get("leadId"),
            "leadName": b.get("leadName"),
            "attendantId": b.get("attendantId"),
            "attendantName": b.get("attendantName"),
            "at": now,
        })

    _total_events += len(entered_ids) + len(exited_ids)
    return len(entered_ids), len(exited_ids)


def _monitor_loop():
    global _started_at, _last_snapshot

    # Bootstrap: espera servidor subir, faz primeira leitura SEM gerar eventos
    try:
        time.sleep(15)
        first = _snapshot_fresh()
        with _state_lock:
            _last_snapshot = first
            _started_at = _now_iso()
        _append_event({"type": "bootstrap", "count": len(first), "at": _started_at})
        print(f"[fech-mon] bootstrap: {len(first)} em FECHAMENTO", flush=True)
    except Exception as e:
        print(f"[fech-mon] bootstrap erro: {e}", flush=True)
        return

    while True:
        try:
            time.sleep(SNAPSHOT_INTERVAL_SECONDS)
            current = _snapshot_fresh()
            with _state_lock:
                prev = _last_snapshot
            ent, exi = _diff_and_log(prev, current)
            with _state_lock:
                _last_snapshot = current
            if ent or exi:
                print(f"[fech-mon] +{ent} -{exi}", flush=True)
        except Exception as e:
            print(f"[fech-mon] loop erro: {e}", flush=True)


def start():
    """Inicia monitor em thread daemon. Idempotente."""
    global _started
    if _started:
        return
    threading.Thread(target=_monitor_loop, daemon=True).start()
    _started = True


def status() -> dict:
    """Status atual do monitor."""
    with _state_lock:
        return {
            "rodando": _started,
            "iniciado_em": _started_at,
            "intervalo_segundos": SNAPSHOT_INTERVAL_SECONDS,
            "atualmente_em_fechamento": len(_last_snapshot),
            "total_eventos_registrados": _total_events,
            "log_file": LOG_FILE,
        }


def read_events(de: datetime | None = None, ate: datetime | None = None,
                tipo: str | None = None) -> list[dict]:
    """Lê eventos do log filtrando por período e tipo (entered/exited)."""
    if not os.path.exists(LOG_FILE):
        return []
    events: list[dict] = []
    try:
        with open(LOG_FILE, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    e = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if e.get("type") == "bootstrap":
                    continue
                if tipo and e.get("type") != tipo:
                    continue
                at_str = e.get("at")
                if not at_str:
                    continue
                try:
                    moment = datetime.fromisoformat(at_str.replace("Z", "+00:00"))
                except ValueError:
                    continue
                if de and moment < de:
                    continue
                if ate and moment > ate:
                    continue
                events.append(e)
    except Exception as e:
        print(f"[fech-mon] read_events erro: {e}", flush=True)
    return events
