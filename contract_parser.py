"""Extrator de dados de contrato/declaração de compra das conversas do datacrazy.

Os 4 vendedores mandam DENTRO da conversa do lead (no CRM via WhatsApp) uma
mensagem com o contrato no formato:

    📄 Declaração de Confirmação de Compra
    Eu, JOAO BELARMINO DE SOUZA, portador do 190.020.251-49, ...
    📅 Data: 02/06/2026
    📦 Pedido: 3 meses
    💰 Valor: R$ 497
    💳 Pagamento: Boleto

OU no formato:

    📄 PEDIDO REALIZADO E CONFIRMADO ✅
    Nome: JOAO BELARMINO DE SOUZA
    CPF: 190.020.251-49
    Telefone: (62) 99565-5523
    Tratamento: 3 meses
    Valor da compra: R$ 497
    Forma de pagamento: Boleto

Este módulo varre uma lista de mensagens e devolve os dados estruturados.
"""
from __future__ import annotations

import re
from typing import Any

# Frases que indicam o início de um bloco de contrato/declaração
CONTRACT_TRIGGERS = [
    "declaração de confirmação",
    "pedido realizado e confirmado",
    "confirmação de compra",
    "informações da sua compra",
]

# Mapeia padrões de forma de pagamento -> normalizado
PAGAMENTO_NORMALIZA = {
    "boleto": "boleto",
    "pix": "pix",
    "cartão": "cartao",
    "cartao": "cartao",
    "dinheiro": "dinheiro",
    "transferência": "transferencia",
    "transferencia": "transferencia",
}

# Pagamentos que são "antecipados" (cliente paga upfront, não no ato da entrega)
PAGAMENTOS_ANTECIPADOS = {"pix", "cartao", "dinheiro", "transferencia"}

RE_CPF = re.compile(r"\b(\d{3}\.\d{3}\.\d{3}-\d{2})\b")
RE_VALOR = re.compile(
    r"(?:valor(?:\s+da\s+compra)?|💰\s*valor)[:\s]+R\$\s*([\d\.,]+)",
    re.IGNORECASE,
)
RE_VALOR_SIMPLES = re.compile(r"R\$\s*([\d\.]{3,})", re.IGNORECASE)
RE_PLANO_MESES = re.compile(
    r"(?:pedido|tratamento|plano)[:\s]+(\d+)\s*meses?",
    re.IGNORECASE,
)
RE_PAGAMENTO = re.compile(
    # Exige ":" depois do rótulo pra evitar capturar "pagamento no ato"
    r"(?:forma\s+de\s+pagamento|💳\s*pagamento|^\s*pagamento)\s*:\s*([A-Za-zçãéúí]+)",
    re.IGNORECASE | re.MULTILINE,
)
RE_NOME_DECLARACAO = re.compile(
    r"Eu,\s+([A-ZÁÉÍÓÚÂÊÔÃÕÇ ]{6,80}?),\s+portador",
    re.IGNORECASE,
)
RE_NOME_PEDIDO = re.compile(
    r"Nome[:\s]+([A-ZÁÉÍÓÚÂÊÔÃÕÇ ][A-Za-zÁÉÍÓÚÂÊÔÃÕÇáéíóúâêôãõç ]{4,80})",
)
RE_DATA = re.compile(
    r"(?:📅\s*data|data)[:\s]+(\d{2}/\d{2}/\d{4})",
    re.IGNORECASE,
)
RE_ENDERECO_LINHA = re.compile(
    r"endereço[:\s]+([^\n]{5,200})",
    re.IGNORECASE,
)


def _is_contract_message(body: str) -> bool:
    if not body:
        return False
    low = body.lower()
    return any(trigger in low for trigger in CONTRACT_TRIGGERS)


def _parse_valor(text: str) -> float | None:
    """Tenta extrair o valor numérico do trecho."""
    m = RE_VALOR.search(text)
    if not m:
        # fallback: primeiro R$ que aparecer
        m = RE_VALOR_SIMPLES.search(text)
        if not m:
            return None
    raw = m.group(1).strip()
    # "1.500,00" -> 1500.00 / "697" -> 697 / "697,00" -> 697.00
    cleaned = raw.replace(".", "").replace(",", ".")
    # se sobrou um único ponto decimal já tá certo; se sobraram zero, é inteiro
    try:
        return float(cleaned)
    except ValueError:
        return None


def _parse_pagamento(text: str) -> tuple[str | None, bool | None]:
    """Retorna (forma_normalizada, is_antecipada).
    Itera por todos os matches até achar um que normaliza pra forma conhecida."""
    for m in RE_PAGAMENTO.finditer(text):
        raw = m.group(1).strip().lower()
        norm = PAGAMENTO_NORMALIZA.get(raw)
        if not norm:
            # tenta detectar mesmo se vier "no boleto" ou "via pix"
            for key, val in PAGAMENTO_NORMALIZA.items():
                if key in raw:
                    norm = val
                    break
        if norm:
            return norm, norm in PAGAMENTOS_ANTECIPADOS
    return None, None


def _parse_nome(text: str) -> str | None:
    m = RE_NOME_DECLARACAO.search(text)
    if m:
        nome = m.group(1).strip()
        # remove vírgulas finais
        return nome.rstrip(",").strip()
    m = RE_NOME_PEDIDO.search(text)
    if m:
        return m.group(1).strip()
    return None


def _parse_plano(text: str) -> int | None:
    m = RE_PLANO_MESES.search(text)
    if not m:
        return None
    try:
        return int(m.group(1))
    except ValueError:
        return None


def parse_contract_from_text(body: str) -> dict[str, Any] | None:
    """Recebe o texto de uma mensagem e tenta extrair os campos do contrato.
    Retorna None se não parece ser uma mensagem de contrato."""
    if not _is_contract_message(body):
        return None

    cpf_m = RE_CPF.search(body)
    cpf = cpf_m.group(1) if cpf_m else None

    nome = _parse_nome(body)
    valor = _parse_valor(body)
    plano_meses = _parse_plano(body)
    pagamento, antecipada = _parse_pagamento(body)
    data_m = RE_DATA.search(body)
    data = data_m.group(1) if data_m else None
    end_m = RE_ENDERECO_LINHA.search(body)
    endereco = end_m.group(1).strip() if end_m else None

    return {
        "nome_completo": nome,
        "cpf": cpf,
        "valor": valor,
        "plano_meses": plano_meses,
        "pagamento": pagamento,
        "is_antecipada": antecipada,
        "data": data,
        "endereco": endereco,
        "tem_dados_completos": all([nome, cpf, valor, plano_meses, pagamento]),
    }


def find_contract_in_messages(messages: list[dict]) -> dict[str, Any] | None:
    """Varre as mensagens (do mais novo pro mais antigo) procurando contrato.
    Retorna o contrato mais recente encontrado ou None.

    Cada mensagem deve ter 'body', 'createdAt' e opcionalmente 'attendantName'.
    """
    for m in messages:
        body = m.get("body") or ""
        result = parse_contract_from_text(body)
        if result:
            result["mensagem_em"] = m.get("createdAt")
            result["enviado_por"] = m.get("attendantName")
            return result
    return None


# ===== TESTES INTEGRADOS =====
# Rodar com `python contract_parser.py` pra verificar parsing.
if __name__ == "__main__":
    sample_declaracao = """📄 Declaração de Confirmação de Compra

Conforme eu li para o senhor em ligação e o senhor confirmou.

Eu, JOAO BELARMINO DE SOUZA, portador do 190.020.251-49, confirmo a compra do produto, comprometendo-me a realizar o pagamento no ato da entrega, conforme as condições acordadas.

⚠️ Advertência
Em caso de inadimplência, estou ciente de que será aplicada:
• Multa de 10% sobre o valor do produto

📅 Data: 02/06/2026
📦 Pedido: 3 meses
💰 Valor: R$ 497
💳 Pagamento: Boleto"""

    sample_pedido = """📄 PEDIDO REALIZADO E CONFIRMADO ✅

Segue as informações da sua compra:

Nome: JOAO BELARMINO DE SOUZA
CPF: 190.020.251-49
Telefone: (62) 99565-5523
Endereço: Rua Engenheiro Portela, 510 — Centro — Anápolis/GO
CEP: 75024-959
Clique e Retire — Agência dos Correios

Tratamento: 3 meses
Valor da compra: R$ 497
Forma de pagamento: Boleto

📅 Prazo para pagamento: Ato da entrega"""

    sample_antecipada = """📄 Declaração de Confirmação de Compra

Eu, MARIA DA SILVA SANTOS, portador do 123.456.789-00, confirmo a compra.

📅 Data: 03/06/2026
📦 Pedido: 6 meses
💰 Valor: R$ 697
💳 Pagamento: PIX"""

    print("=== Declaração ===")
    print(parse_contract_from_text(sample_declaracao))
    print()
    print("=== Pedido ===")
    print(parse_contract_from_text(sample_pedido))
    print()
    print("=== PIX (Antecipada) ===")
    print(parse_contract_from_text(sample_antecipada))
    print()
    print("=== Texto qualquer (deve dar None) ===")
    print(parse_contract_from_text("Oi, tudo bem?"))
