"""Aplica produtos detectados nos agendados sem produto.

Lê /api/agendados-sem-produto/sugestoes, filtra os que têm sugestão
e dispara em lote no endpoint /api/agendados-sem-produto/aplicar.

Os negócios sem detecção ficam INTOCADOS.
"""
import requests

BASE = "http://127.0.0.1:5000"

print("1) Buscando sugestões...")
r = requests.get(f"{BASE}/api/agendados-sem-produto/sugestoes", timeout=600)
r.raise_for_status()
data = r.json()
lista = data["lista"]
print(f"   {len(lista)} negócios sem produto retornados")

aplicacoes = []
sem_det = []
seis = 0
tres = 0
for item in lista:
    if item.get("sugestao_produto_id"):
        aplicacoes.append({
            "businessId": item["businessId"],
            "productId": item["sugestao_produto_id"],
        })
        if item["sugestao_produto_preco"] == 697:
            seis += 1
        else:
            tres += 1
    else:
        sem_det.append(item["leadName"])

print(f"   Plano 6 Meses: {seis}")
print(f"   Plano 3 Meses: {tres}")
print(f"   Sem detecção (intocados): {len(sem_det)} → {sem_det}")
print(f"   Total a aplicar: {len(aplicacoes)}")

print("\n2) Aplicando...")
r = requests.post(f"{BASE}/api/agendados-sem-produto/aplicar",
                  json={"aplicacoes": aplicacoes}, timeout=600)
r.raise_for_status()
resultado = r.json()

print(f"\n3) Resultado:")
print(f"   Sucesso: {resultado['sucesso']} de {resultado['total']}")
falhas = [r for r in resultado["resultados"] if not r["ok"]]
if falhas:
    print(f"   Falhas ({len(falhas)}):")
    for f in falhas[:10]:
        print(f"     - {f['businessId']}: {f.get('erro', '?')[:120]}")
else:
    print("   Sem falhas. ✅")
