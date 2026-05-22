"""Teste de conexão com o servidor MCP do datacrazy.

Roda um handshake mínimo (initialize -> initialized -> tools/call) e
lista os pipelines disponíveis. Se imprimir os 2 pipelines no final,
está tudo certo pra seguir.
"""
import os
import json
import sys
import requests
from dotenv import load_dotenv

load_dotenv()

URL = os.environ["DATACRAZY_MCP_URL"]
TOKEN = os.environ["DATACRAZY_TOKEN"]

HEADERS = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
    "Authorization": f"Bearer {TOKEN}",
    "MCP-Protocol-Version": "2025-03-26",
}


def parse_response(resp):
    ctype = resp.headers.get("content-type", "")
    if "text/event-stream" in ctype:
        for line in resp.text.splitlines():
            if line.startswith("data:"):
                return json.loads(line[5:].strip())
        raise RuntimeError(f"SSE sem data: {resp.text!r}")
    return resp.json()


def main():
    session = requests.Session()
    session.headers.update(HEADERS)

    print("1) initialize...")
    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-03-26",
            "capabilities": {},
            "clientInfo": {"name": "dashboard-comercial", "version": "0.1"},
        },
    }
    r = session.post(URL, json=payload, timeout=30)
    print(f"   HTTP {r.status_code}")
    if r.status_code >= 400:
        print(f"   ERRO: {r.text[:500]}")
        sys.exit(1)

    sid = r.headers.get("mcp-session-id") or r.headers.get("Mcp-Session-Id")
    print(f"   Session: {sid}")
    init_resp = parse_response(r)
    server = init_resp.get("result", {}).get("serverInfo", {})
    print(f"   Servidor: {server.get('name')} v{server.get('version')}")

    if sid:
        session.headers["Mcp-Session-Id"] = sid

    print("2) notifications/initialized...")
    r = session.post(URL, json={"jsonrpc": "2.0", "method": "notifications/initialized"}, timeout=30)
    print(f"   HTTP {r.status_code}")

    print("3) tools/call pipeline_list...")
    payload = {
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tools/call",
        "params": {"name": "pipeline_list", "arguments": {"limit": 10}},
    }
    r = session.post(URL, json=payload, timeout=30)
    print(f"   HTTP {r.status_code}")
    if r.status_code >= 400:
        print(f"   ERRO: {r.text[:500]}")
        sys.exit(1)

    data = parse_response(r)
    content = data.get("result", {}).get("content", [])
    if not content:
        print(f"   Resposta sem content: {data}")
        sys.exit(1)

    pipelines = json.loads(content[0]["text"])["data"]
    print(f"\n--- {len(pipelines)} pipelines encontrados ---")
    for p in pipelines:
        print(f"  - {p['name']} (id={p['id']}, {p['stagesCount']} estagios)")


if __name__ == "__main__":
    main()
