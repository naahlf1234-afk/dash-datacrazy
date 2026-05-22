"""Analisa padrões nas conversas de leads que viraram VENDA (estágio AGENDADO).

Lê uma amostra de negócios em AGENDADO, busca as conversas, extrai as mensagens
do LEAD (não do atendente) e tabula:
  - palavras / expressões mais frequentes
  - tags mais comuns
  - tempo médio até virar venda
  - tamanho médio das mensagens

Útil pra calibrar o score do radar de leads quentes.

Uso:
  venv\\Scripts\\python.exe analise_padroes_venda.py [amostra]
  (amostra opcional, default 30)
"""
from __future__ import annotations

import re
import sys
from collections import Counter
from datetime import datetime, timezone

import datacrazy_client as dc


STOPWORDS = {
    "a","o","e","de","da","do","das","dos","em","na","no","um","uma","uns","umas",
    "que","se","é","ser","sou","tô","ta","tá","tao","são","foi","seja","ser",
    "para","pra","por","mas","ou","com","sem","ao","aos","à","às","já","ainda",
    "muito","bem","mais","menos","tudo","nada","só","também","aqui","ali","lá",
    "eu","você","voce","vc","ele","ela","nós","nos","vocês","eles","elas","meu","minha","seu","sua",
    "isso","isto","aquilo","esse","essa","esses","essas","este","esta","estes","estas",
    "não","nao","sim","ah","oi","ola","olá","obrigado","obrigada","ok","tá","ta","tô",
    "porque","pq","como","onde","quando","qual","quais","quem",
    "ter","tem","tinha","tive","ia","vai","vou","ir","posso","pode","podia","quer",
    "fazer","faz","fiz","feito","dar","dou","da","deu","ver","ver","vê","vi",
    "agora","hoje","ontem","amanhã","depois","antes","então","aí","ai",
    "bom","boa","boas","bons","gente","cara","amigo","amiga","senhor","senhora",
    "fico","fica","ficar","ficou","fica","quando","precisa","precisamos","ai",
    "to","s","t","n","sr","sra","dr","dra","oi","hi","ola","oii","oie","tlh","kkk","rs","kkkk",
    # ruído da operação:
    "doutor","saber",  # mensagem padrão do anúncio "olá doutor quero saber mais"
    # ruído de mensagens automáticas / links:
    "https","http","www","com","kwai","tiktok","video","campaign","event","trigger","lite",
}

# Tags que são automáticas / não-preditoras (excluir das estatísticas de tags)
TAGS_AUTOMATICAS = {"recepcionado"}

# Frases que indicam mensagem do anúncio (não do lead organicamente) — descartar essas msgs
FRASES_DO_ANUNCIO = [
    "olá doutor quero saber mais",
    "ola doutor quero saber mais",
    "doutor quero saber mais",
    "olá doutor, quero saber mais",
    "ola doutor, quero saber mais",
]

WORD_RE = re.compile(r"[a-záàâãéêíóôõúçñ]+", re.IGNORECASE)


def is_msg_do_anuncio(text: str) -> bool:
    low = text.lower().strip()
    for frase in FRASES_DO_ANUNCIO:
        if frase in low:
            return True
    return False


def tokenize(text: str) -> list[str]:
    text = text.lower()
    return [w for w in WORD_RE.findall(text) if len(w) >= 3 and w not in STOPWORDS]


def main():
    amostra = int(sys.argv[1]) if len(sys.argv) > 1 else 80

    print(f"\n=== Análise de padrões de venda (amostra: {amostra} negócios) ===")
    print("Ignorando: msg do anúncio ('olá doutor quero saber mais') + tag automática 'Recepcionado'\n")

    print("Carregando negócios em AGENDADO...")
    stage_id = next(s["id"] for s in dc.STAGES_API if s["name"] == "AGENDADO")
    agendados = dc.businesses_by_stage(stage_id)
    print(f"  total no estágio: {len(agendados)}")

    agendados.sort(key=lambda b: b.get("lastMovedAt") or "", reverse=True)
    amostra_biz = agendados[:amostra]
    print(f"  analisando os {len(amostra_biz)} mais recentes\n")

    print("Carregando tags dos leads...")
    lead_ids = [b["leadId"] for b in amostra_biz if b.get("leadId")]
    leads_data = dc.lead_by_ids(lead_ids)
    leads_by_id = {l["id"]: l for l in leads_data}
    print(f"  {len(leads_by_id)} leads carregados\n")

    palavras: Counter[str] = Counter()
    bigramas: Counter[str] = Counter()
    tags_count: Counter[str] = Counter()
    tamanhos_msg: list[int] = []
    qtde_msgs_lead: list[int] = []
    qtde_audios_lead: list[int] = []
    leads_com_audio = 0
    leads_so_audio = 0
    leads_so_texto = 0
    leads_mistos = 0
    horas_da_venda: Counter[int] = Counter()
    dias_até_venda: list[float] = []
    leads_escreveram = 0  # tem ao menos uma msg com body de texto que não seja do anúncio
    msgs_anuncio_descartadas = 0

    for i, biz in enumerate(amostra_biz, 1):
        lead_id = biz.get("leadId")
        lead_name = biz.get("leadName", "?")
        print(f"  [{i}/{len(amostra_biz)}] {lead_name[:30]:30s} ", end="", flush=True)

        # hora do dia em que virou venda
        venda_em = biz.get("lastMovedAt")
        if venda_em:
            try:
                dt_venda = datetime.fromisoformat(venda_em.replace("Z", "+00:00")).astimezone(timezone.utc)
                # ajuste pra UTC-3 (Brasília)
                hora_local = (dt_venda.hour - 3) % 24
                horas_da_venda[hora_local] += 1
            except ValueError:
                dt_venda = None
        else:
            dt_venda = None

        # tags (ignorando automáticas)
        lead = leads_by_id.get(lead_id, {})
        for tag in (lead.get("tags") or []):
            nome = (tag.get("name") or "").strip()
            if nome.lower() in TAGS_AUTOMATICAS:
                continue
            tags_count[nome] += 1

        # conversa
        conv = dc.conversation_by_lead(lead_id) if lead_id else None
        if not conv:
            print("(sem conversa)")
            continue

        msgs = dc.conversation_messages(conv["id"], limit=80)
        msgs_lead = [m for m in msgs if m.get("received")]
        if not msgs_lead:
            print("(sem msg do lead)")
            continue

        # primeira mensagem -> calcula tempo até virar venda
        msgs_lead_ordered = sorted(msgs_lead, key=lambda m: m.get("createdAt") or "")
        try:
            primeira = datetime.fromisoformat((msgs_lead_ordered[0].get("createdAt") or "").replace("Z", "+00:00"))
            if dt_venda:
                delta_horas = (dt_venda - primeira).total_seconds() / 3600
                if delta_horas >= 0:
                    dias_até_venda.append(delta_horas / 24)
        except (ValueError, IndexError):
            pass

        qtde_msgs_lead.append(len(msgs_lead))
        n_audios = sum(1 for m in msgs_lead for a in (m.get("attachments") or []) if (a.get("type") or "").upper() == "AUDIO")
        qtde_audios_lead.append(n_audios)

        teve_audio = n_audios > 0
        # mensagens de texto reais do lead (não vazias e não a frase do anúncio)
        msgs_texto = [m for m in msgs_lead if (m.get("body") or "").strip() and not is_msg_do_anuncio(m.get("body") or "")]
        msgs_anuncio_descartadas += sum(1 for m in msgs_lead if is_msg_do_anuncio(m.get("body") or ""))

        if teve_audio:
            leads_com_audio += 1
        if teve_audio and not msgs_texto:
            leads_so_audio += 1
        elif msgs_texto and not teve_audio:
            leads_so_texto += 1
        elif msgs_texto and teve_audio:
            leads_mistos += 1

        if msgs_texto:
            leads_escreveram += 1

        for m in msgs_texto:
            body = m.get("body") or ""
            tamanhos_msg.append(len(body))
            tokens = tokenize(body)
            palavras.update(tokens)
            for a, b in zip(tokens, tokens[1:]):
                bigramas[f"{a} {b}"] += 1

        marker = "🔊" if leads_so_audio and not msgs_texto else "💬" if msgs_texto and not teve_audio else "🎭"
        print(f"{marker} ({len(msgs_lead)} msgs, {n_audios} áudios, {len(msgs_texto)} textos)")

    total = len(amostra_biz)
    print("\n" + "=" * 60)
    print("RESULTADOS")
    print("=" * 60)

    print(f"\n📊 Estatísticas gerais (amostra: {total} vendas):")
    if qtde_msgs_lead:
        print(f"  - Média msgs do lead: {sum(qtde_msgs_lead)/len(qtde_msgs_lead):.1f}  |  Mediana: {sorted(qtde_msgs_lead)[len(qtde_msgs_lead)//2]}")
    if qtde_audios_lead:
        print(f"  - Média de áudios: {sum(qtde_audios_lead)/len(qtde_audios_lead):.1f}")
    if dias_até_venda:
        d = sorted(dias_até_venda)
        print(f"  - Tempo do 1º contato até venda: mediana {d[len(d)//2]:.1f} dias  |  média {sum(d)/len(d):.1f} dias")
    print(f"  - Msgs do anúncio descartadas: {msgs_anuncio_descartadas}")

    print(f"\n🎤 Comportamento de comunicação:")
    print(f"  - Só áudio:        {leads_so_audio:3d}  ({leads_so_audio*100//max(total,1)}%)")
    print(f"  - Misto:           {leads_mistos:3d}  ({leads_mistos*100//max(total,1)}%)")
    print(f"  - Só texto:        {leads_so_texto:3d}  ({leads_so_texto*100//max(total,1)}%)")
    print(f"  - Qualquer áudio:  {leads_com_audio:3d}  ({leads_com_audio*100//max(total,1)}%)")

    print(f"\n⏰ Horário em que viraram venda (horário de Brasília):")
    for hora in sorted(horas_da_venda.keys()):
        n = horas_da_venda[hora]
        bar = "█" * n
        print(f"  {hora:02d}h  {bar} {n}")

    print(f"\n🏷️  Top 15 tags em leads que viraram venda (Recepcionado removido):")
    for tag, n in tags_count.most_common(15):
        if tag:
            print(f"  {n:3d}× {tag}")

    print(f"\n💬 Top 40 palavras mais frequentes (só dos {leads_escreveram} leads que escreveram texto real):")
    for word, n in palavras.most_common(40):
        print(f"  {n:3d}× {word}")

    print(f"\n🔗 Top 25 bigramas:")
    for bg, n in bigramas.most_common(25):
        if n >= 2:
            print(f"  {n:3d}× {bg}")

    print("\n=== fim ===\n")


if __name__ == "__main__":
    main()
