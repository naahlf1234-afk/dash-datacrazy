"""Cliente HTTP para o servidor MCP do datacrazy.

Encapsula o protocolo JSON-RPC sobre HTTP (Streamable HTTP MCP) e expõe
métodos de alto nível para o dashboard. Mantém cache em memória com TTL.
"""
from __future__ import annotations

import json
import os
import threading
import time
from typing import Any

import requests
from dotenv import load_dotenv

load_dotenv()

URL = os.environ["DATACRAZY_MCP_URL"]
TOKEN = os.environ["DATACRAZY_TOKEN"]

PIPELINE_API_ID = "827986b4-56a9-4074-a54e-440b6b7be6a5"

STAGES_API: list[dict[str, Any]] = [
    {"index": 0, "id": "5bb73d00-5568-4891-8b0e-92e314e4c2cd", "name": "APRESENTAÇÃO"},
    {"index": 1, "id": "d5418347-130e-40f3-890f-7713477d14a9", "name": "SONDAGEM"},
    {"index": 2, "id": "811a4f14-660a-4793-91ad-d31c44c85b87", "name": "GERAÇÃO DE VALOR"},
    {"index": 3, "id": "6a1350aa-f925-4f23-ae44-1666a8b16bc0", "name": "NEGOCIAÇÃO"},
    {"index": 4, "id": "17804096-eec5-4c99-bf5f-085153fab099", "name": "FECHAMENTO"},
    {"index": 5, "id": "4e9c143b-1990-4adb-88f1-74a68f8ddfcb", "name": "AGENDADO"},
    {"index": 6, "id": "ddb25392-da44-4c63-be74-3a0510ce8e2c", "name": "FOLLOW-UP"},
    {"index": 7, "id": "3173bbf9-8a63-4c36-90ae-64ce609a9245", "name": "LEAD PRA O FUTURO"},
    {"index": 8, "id": "ed8bd445-5961-478a-87aa-1196dea8d363", "name": "DESQUALIFICADO"},
]

VENDEDORES = [
    {"userId": "0Diym19CpgY34hsoRkukGKPZzDw2", "name": "Michele Langendorf"},
    {"userId": "5HvOBh3dkoRFMdUBr9mRPyE4LA12", "name": "Luan Sampaio"},
    {"userId": "AVSCM8VJtkZxIGVuDEIZEG9fzYD3", "name": "Alysson Oliveira"},
    {"userId": "wHNGaeo0SmYk0MiwvQ7LOdnXdcG3", "name": "Kauã Adryl"},
]

VENDEDOR_IDS = {v["userId"] for v in VENDEDORES}

HEADERS = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
    "Authorization": f"Bearer {TOKEN}",
    "MCP-Protocol-Version": "2025-03-26",
}

CACHE_TTL_SECONDS = 300


class _Cache:
    def __init__(self, ttl: int):
        self.ttl = ttl
        self._data: dict[tuple, tuple[float, Any]] = {}
        self._lock = threading.Lock()

    def get(self, key: tuple):
        with self._lock:
            entry = self._data.get(key)
            if not entry:
                return None
            ts, value = entry
            if time.time() - ts > self.ttl:
                del self._data[key]
                return None
            return value

    def set(self, key: tuple, value: Any):
        with self._lock:
            self._data[key] = (time.time(), value)

    def clear(self):
        with self._lock:
            self._data.clear()


_cache = _Cache(CACHE_TTL_SECONDS)


def _parse(resp: requests.Response) -> dict:
    ctype = resp.headers.get("content-type", "")
    if "text/event-stream" in ctype:
        for line in resp.text.splitlines():
            if line.startswith("data:"):
                return json.loads(line[5:].strip())
        raise RuntimeError(f"SSE sem campo data: {resp.text!r}")
    return resp.json()


def _call_tool(name: str, arguments: dict) -> dict:
    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {"name": name, "arguments": arguments},
    }
    resp = requests.post(URL, json=payload, headers=HEADERS, timeout=30)
    if resp.status_code >= 400:
        raise RuntimeError(f"MCP {name} HTTP {resp.status_code}: {resp.text[:300]}")
    data = _parse(resp)
    if "error" in data:
        raise RuntimeError(f"MCP {name} erro: {data['error']}")
    content = data.get("result", {}).get("content", [])
    if not content:
        return {}
    return json.loads(content[0]["text"])


def _paginate(tool_name: str, base_args: dict, page_size: int = 100, max_pages: int = 200) -> list[dict]:
    out: list[dict] = []
    skip = 0
    for _ in range(max_pages):
        args = dict(base_args)
        args["limit"] = page_size
        args["skip"] = skip
        result = _call_tool(tool_name, args)
        chunk = result.get("data", [])
        if not chunk:
            break
        out.extend(chunk)
        if len(chunk) < page_size:
            break
        skip += page_size
    return out


def clear_cache():
    _cache.clear()


def businesses_by_stage(stage_id: str) -> list[dict]:
    key = ("biz_stage", stage_id)
    cached = _cache.get(key)
    if cached is not None:
        return cached
    data = _paginate("business_list_by_stage", {"stageId": stage_id})
    _cache.set(key, data)
    return data


def businesses_by_attendant(user_id: str) -> list[dict]:
    key = ("biz_att", user_id)
    cached = _cache.get(key)
    if cached is not None:
        return cached
    data = _paginate("business_list_by_attendant", {"userId": user_id})
    _cache.set(key, data)
    return data


def all_businesses_api_pipeline() -> list[dict]:
    """Todos os negócios do pipeline API, agrupados via estágios."""
    key = ("biz_all_api",)
    cached = _cache.get(key)
    if cached is not None:
        return cached
    out: list[dict] = []
    for stage in STAGES_API:
        out.extend(businesses_by_stage(stage["id"]))
    _cache.set(key, out)
    return out


def leads(date_from: str | None = None, date_to: str | None = None) -> list[dict]:
    key = ("leads", date_from, date_to)
    cached = _cache.get(key)
    if cached is not None:
        return cached
    args: dict[str, Any] = {}
    if date_from:
        args["createdAtGreaterOrEqual"] = date_from
    if date_to:
        args["createdAtLessOrEqual"] = date_to
    data = _paginate("lead_list", args)
    _cache.set(key, data)
    return data


def leads_count(date_from: str | None = None, date_to: str | None = None) -> int:
    """Conta total de leads sem paginar — 1 chamada só com limit=1.
    Bem mais rápido que carregar a base inteira."""
    key = ("leads_count", date_from, date_to)
    cached = _cache.get(key)
    if cached is not None:
        return cached
    args: dict[str, Any] = {"limit": 1}
    if date_from:
        args["createdAtGreaterOrEqual"] = date_from
    if date_to:
        args["createdAtLessOrEqual"] = date_to
    result = _call_tool("lead_list", args)
    count = result.get("count")
    if count is None:
        # fallback: tenta data + len
        count = len(result.get("data", []))
    _cache.set(key, count)
    return count


def conversations(status: str = "all") -> list[dict]:
    key = ("conv", status)
    cached = _cache.get(key)
    if cached is not None:
        return cached
    data = _paginate("conversation_list", {"status": status})
    _cache.set(key, data)
    return data


def loss_reasons() -> list[dict]:
    key = ("loss",)
    cached = _cache.get(key)
    if cached is not None:
        return cached
    data = _call_tool("loss_reason_list", {"limit": 100}).get("data", [])
    _cache.set(key, data)
    return data


def tags() -> list[dict]:
    key = ("tags",)
    cached = _cache.get(key)
    if cached is not None:
        return cached
    data = _call_tool("tag_list", {"limit": 100}).get("data", [])
    _cache.set(key, data)
    return data


def attendants() -> list[dict]:
    key = ("attendants",)
    cached = _cache.get(key)
    if cached is not None:
        return cached
    data = _paginate("attendant_list", {})
    _cache.set(key, data)
    return data


def attendant_id_to_user_id() -> dict[str, str]:
    """Mapa de attendantId (id interno) -> userId."""
    return {a["id"]: a["userId"] for a in attendants() if a.get("id") and a.get("userId")}


def conversation_by_lead(lead_id: str) -> dict | None:
    """Retorna a conversa mais recente associada a um lead, ou None."""
    if not lead_id:
        return None
    key = ("conv_by_lead", lead_id)
    cached = _cache.get(key)
    if cached is not None:
        return cached or None
    try:
        result = _call_tool("conversation_get_by_lead", {"leadId": lead_id})
    except RuntimeError:
        result = None
    convs: list[dict] = []
    if isinstance(result, list):
        convs = result
    elif isinstance(result, dict):
        if result.get("id"):
            convs = [result]
        elif isinstance(result.get("data"), list):
            convs = result["data"]
        elif isinstance(result.get("data"), dict):
            convs = [result["data"]]
    convs = [c for c in convs if isinstance(c, dict) and c.get("id")]
    convs.sort(key=lambda c: c.get("lastMessageDate") or "", reverse=True)
    conv = convs[0] if convs else None
    _cache.set(key, conv or {})
    return conv


def conversation_messages(conv_id: str, limit: int = 30) -> list[dict]:
    """Mensagens de uma conversa, da mais nova pra mais antiga."""
    if not conv_id:
        return []
    key = ("msgs", conv_id, limit)
    cached = _cache.get(key)
    if cached is not None:
        return cached
    try:
        result = _call_tool("conversation_messages_list", {"id": conv_id, "limit": limit})
    except RuntimeError:
        result = []
    if isinstance(result, dict):
        msgs = result.get("data", [])
    elif isinstance(result, list):
        msgs = result
    else:
        msgs = []
    _cache.set(key, msgs)
    return msgs


def add_product(business_id: str, product_id: str, quantity: int = 1, price: float | None = None) -> dict:
    """Adiciona um produto a um negócio. Não usa cache (ação de escrita)."""
    args: dict = {"id": business_id, "productId": product_id, "quantity": quantity}
    if price is not None:
        args["price"] = price
    return _call_tool("business_add_product", args)


def products() -> list[dict]:
    key = ("products",)
    cached = _cache.get(key)
    if cached is not None:
        return cached
    data = _call_tool("product_list", {"limit": 100}).get("data", [])
    _cache.set(key, data)
    return data


def lead_by_ids(lead_ids: list[str]) -> list[dict]:
    """Busca leads pelos IDs (passa lista separada por vírgula). Pra pegar tags."""
    if not lead_ids:
        return []
    # quebra em chunks de 50 pra não estourar URL
    out: list[dict] = []
    chunk_size = 50
    for i in range(0, len(lead_ids), chunk_size):
        chunk = lead_ids[i : i + chunk_size]
        key = ("leads_by_ids", tuple(chunk))
        cached = _cache.get(key)
        if cached is not None:
            out.extend(cached)
            continue
        try:
            result = _call_tool("lead_list", {"id": ",".join(chunk), "limit": chunk_size})
        except RuntimeError:
            result = {"data": []}
        data = result.get("data", []) if isinstance(result, dict) else []
        _cache.set(key, data)
        out.extend(data)
    return out
