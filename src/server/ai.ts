"use server";

import Anthropic from "@anthropic-ai/sdk";
import { assertRateLimit } from "@/lib/rate-limit";
import { assertSameOrigin, clientIdentifier } from "@/lib/request";
import { requireUser } from "@/lib/auth";
import { getTrackerData } from "@/server/data";
import { getAnalytics } from "@/server/analytics";
import { buildInsightContext } from "@/lib/ai-context";
import { aiQuestionSchema } from "@/lib/validators";
import type { AiResult } from "@/lib/action-state";

const MODEL = "claude-opus-4-8";

const SYSTEM_PROMPT = `Je bent de vaste data-analist van een kleine snus- en vape-handel (één eigenaar, NL).
Je krijgt een JSON-samenvatting van de cijfers (omzet, winst, marge, voorraad, weekdagen, prognose, pof, stempelkaarten, betaalmethodes).
Regels:
- Antwoord in het Nederlands, kort, concreet en zakelijk. Geen wollige inleiding.
- Gebruik UITSLUITEND de getallen uit de context. Reken niet zelf en verzin nooit cijfers; als iets niet in de context staat, zeg dat eerlijk.
- Bedragen in euro's (bv. € 1.240). Rond netjes af.
- Wees praktisch: noem waar mogelijk een concrete vervolgactie.
- Privacy: er staan geen volledige klantnamen in de context; verzin ze niet.`;

function getClient(): Anthropic | null {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  return new Anthropic({ apiKey: key });
}

async function guard(scope: string) {
  await assertSameOrigin();
  await requireUser();
  await assertRateLimit({ scope, identifier: await clientIdentifier(), limit: 30, windowMs: 60_000 });
}

async function ask(scope: string, instruction: string, maxTokens = 1500): Promise<AiResult> {
  try {
    await guard(scope);
    const client = getClient();
    if (!client) {
      return { ok: false, error: "AI is nog niet geconfigureerd. Voeg ANTHROPIC_API_KEY toe aan je omgeving." };
    }
    const [data, analytics] = await Promise.all([getTrackerData(), getAnalytics()]);
    const context = JSON.stringify(buildInsightContext(data, analytics));

    const message = await client.messages.create({
      model: MODEL,
      max_tokens: maxTokens,
      thinking: { type: "adaptive" },
      system: [
        { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
        { type: "text", text: `Huidige cijfers (JSON):\n${context}`, cache_control: { type: "ephemeral" } }
      ],
      messages: [{ role: "user", content: instruction }]
    });

    const text = message.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();

    if (!text) return { ok: false, error: "Geen antwoord ontvangen. Probeer het opnieuw." };
    return { ok: true, text };
  } catch (error) {
    console.error("AI-actie mislukt:", error);
    const reason = error instanceof Anthropic.APIError ? `AI-fout (${error.status ?? "?"}).` : "Er ging iets mis met de AI.";
    return { ok: false, error: `${reason} Probeer het later opnieuw.` };
  }
}

export async function askInsights(_prev: AiResult, formData: FormData): Promise<AiResult> {
  const parsed = aiQuestionSchema.safeParse({ vraag: formData.get("vraag") });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Controleer je vraag." };
  }
  return ask("ai:ask", `Beantwoord deze vraag van de eigenaar op basis van de cijfers:\n"${parsed.data.vraag}"`);
}

export async function weeklySummary(_prev: AiResult, _formData: FormData): Promise<AiResult> {
  return ask(
    "ai:summary",
    "Schrijf een korte weeksamenvatting (max 5 zinnen): hoe ging de afgelopen 7 dagen versus de 7 dagen ervoor (omzet/winst), het sterkste en het zwakste signaal, en sluit af met één concrete tip.",
    900
  );
}

export async function promoAdvice(_prev: AiResult, _formData: FormData): Promise<AiResult> {
  return ask(
    "ai:advice",
    "Geef een concreet promo- en inkoopadvies. Gebruik de traag-lopende voorraad, de weekdag-prestaties en de marges. Zeg welke producten afprijzen of bundelen en op welke (zwakke) dag, en welke hardlopers juist NIET afprijzen. Maximaal 6 bullets."
  );
}

export async function anomalyScan(_prev: AiResult, _formData: FormData): Promise<AiResult> {
  return ask(
    "ai:anomaly",
    "Noem de 3 tot 5 opvallendste signalen in de cijfers (pieken, dalen, stilstaande voorraad, dalende marge, openstaande pof) met telkens één zin uitleg. Als er niets bijzonders is, zeg dat eerlijk."
  );
}
