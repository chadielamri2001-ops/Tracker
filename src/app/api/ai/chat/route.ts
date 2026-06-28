import Anthropic from "@anthropic-ai/sdk";
import { assertRateLimit } from "@/lib/rate-limit";
import { assertSameOrigin, clientIdentifier } from "@/lib/request";
import { requireUser } from "@/lib/auth";
import { getTrackerData } from "@/server/data";
import { getAnalytics } from "@/server/analytics";
import { buildInsightContext } from "@/lib/ai-context";

// Streaming chat-endpoint voor de AI-assistent. De Anthropic-call blijft volledig
// server-side (API-key lekt nooit naar de client); tokens worden woord-voor-woord
// teruggestreamd naar de browser. Context = privacy-veilige aggregaten uit
// buildInsightContext, vers per request berekend.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MODEL = "claude-opus-4-8";
const MAX_HISTORY = 8;
const MAX_MESSAGE_LENGTH = 2000;

const SYSTEM_PROMPT = `Je bent de vaste data-analist van een kleine snus- en vape-handel (één eigenaar, NL).
Je voert een doorlopend gesprek met de eigenaar en krijgt bij elke beurt een actuele JSON-samenvatting
van de cijfers (omzet, winst, marge, voorraad, weekdagen, prognose, pof, stempelkaarten, betaalmethodes).
Regels:
- Antwoord in het Nederlands, kort, concreet en zakelijk. Geen wollige inleiding.
- Het is een gesprek: bouw voort op eerdere vragen/antwoorden en begrijp follow-ups ("en vorige maand?").
- Gebruik UITSLUITEND de getallen uit de meegeleverde context. Reken niet zelf en verzin nooit cijfers;
  als iets niet in de context staat, zeg dat eerlijk.
- Bedragen in euro's (bv. € 1.240). Rond netjes af.
- Gebruik markdown waar het helpt: korte kopjes, bullets en compacte tabellen voor vergelijkingen.
- Wees praktisch: noem waar mogelijk een concrete vervolgactie.
- Privacy: er staan geen volledige klantnamen in de context; verzin ze niet.`;

type ChatMessage = { role: "user" | "assistant"; content: string };

function sanitizeMessages(input: unknown): ChatMessage[] | null {
  if (!Array.isArray(input)) return null;
  const cleaned: ChatMessage[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const role = (item as { role?: unknown }).role;
    const content = (item as { content?: unknown }).content;
    if ((role === "user" || role === "assistant") && typeof content === "string") {
      const text = content.trim();
      if (text) cleaned.push({ role, content: text.slice(0, MAX_MESSAGE_LENGTH) });
    }
  }
  if (cleaned.length === 0) return null;
  // De laatste beurt moet van de gebruiker zijn, anders is er niets om te beantwoorden.
  if (cleaned[cleaned.length - 1].role !== "user") return null;
  return cleaned.slice(-MAX_HISTORY);
}

export async function POST(request: Request) {
  try {
    await assertSameOrigin();
    await requireUser();
    await assertRateLimit({ scope: "ai:chat", identifier: await clientIdentifier(), limit: 30, windowMs: 60_000 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Niet toegestaan.";
    return Response.json({ error: message }, { status: 429 });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: "AI is nog niet geconfigureerd. Voeg ANTHROPIC_API_KEY toe aan je omgeving." },
      { status: 503 }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Ongeldige aanvraag." }, { status: 400 });
  }

  const messages = sanitizeMessages((body as { messages?: unknown } | null)?.messages);
  if (!messages) {
    return Response.json({ error: "Geen geldige vraag ontvangen." }, { status: 400 });
  }

  const client = new Anthropic({ apiKey });
  const [data, analytics] = await Promise.all([getTrackerData(), getAnalytics()]);
  const context = JSON.stringify(buildInsightContext(data, analytics));

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const messageStream = client.messages.stream({
          model: MODEL,
          max_tokens: 1800,
          thinking: { type: "adaptive" },
          system: [
            { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
            { type: "text", text: `Huidige cijfers (JSON):\n${context}`, cache_control: { type: "ephemeral" } }
          ],
          messages: messages.map((message) => ({ role: message.role, content: message.content }))
        });

        messageStream.on("text", (delta) => controller.enqueue(encoder.encode(delta)));
        await messageStream.finalMessage();
        controller.close();
      } catch (error) {
        console.error("AI-chat mislukt:", error);
        try {
          controller.enqueue(encoder.encode("\n\n_Er ging iets mis met de AI. Probeer het later opnieuw._"));
        } catch {
          // controller kan al gesloten zijn
        }
        controller.close();
      }
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no"
    }
  });
}
