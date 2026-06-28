"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";

// Markdown-renderer lazy laden: alleen ophalen zodra er een afgerond antwoord is.
const Markdown = dynamic(() => import("./markdown"), {
  ssr: false,
  loading: () => <span className="ai-md-loading">…</span>
});

type ChatRole = "user" | "assistant";
type ChatMessage = { id: number; role: ChatRole; content: string; streaming?: boolean; error?: boolean };

// Vooraf ingevulde startvragen + één-klik analyses; sturen direct een bericht in de chat.
const STARTERS = [
  "Wat was mijn beste week?",
  "Welke smaak loopt achteruit?",
  "Hoeveel marge maak ik gemiddeld?",
  "Op welke dag kan ik het best een actie doen?"
];

const QUICK_ACTIONS: Array<{ label: string; prompt: string }> = [
  {
    label: "Weeksamenvatting",
    prompt:
      "Geef een korte weeksamenvatting (max 5 zinnen): hoe ging de afgelopen 7 dagen versus de 7 dagen ervoor (omzet/winst), het sterkste en het zwakste signaal, en sluit af met één concrete tip."
  },
  {
    label: "Promo-advies",
    prompt:
      "Geef een concreet promo- en inkoopadvies. Gebruik de traag-lopende voorraad, de weekdag-prestaties en de marges. Zeg welke producten afprijzen of bundelen en op welke (zwakke) dag, en welke hardlopers juist NIET afprijzen. Maximaal 6 bullets."
  },
  {
    label: "Signalen",
    prompt:
      "Noem de 3 tot 5 opvallendste signalen in de cijfers (pieken, dalen, stilstaande voorraad, dalende marge, openstaande pof) met telkens één zin uitleg. Als er niets bijzonders is, zeg dat eerlijk."
  }
];

let messageCounter = 0;
function nextId() {
  return ++messageCounter;
}

// AI-assistent: streaming, meedenkende chat op de echte cijfers. De Anthropic-call
// loopt server-side via /api/ai/chat; hier houden we alleen de gespreksstaat bij.
export function AiAssistant() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const send = useCallback(
    async (text: string) => {
      const question = text.trim();
      if (!question || busy) return;

      const history = messages.map(({ role, content }) => ({ role, content }));
      const userMessage: ChatMessage = { id: nextId(), role: "user", content: question };
      const assistantMessage: ChatMessage = { id: nextId(), role: "assistant", content: "", streaming: true };
      setMessages((prev) => [...prev, userMessage, assistantMessage]);
      setInput("");
      setBusy(true);

      const finish = (content: string, error = false) => {
        setMessages((prev) =>
          prev.map((message) =>
            message.id === assistantMessage.id ? { ...message, content, streaming: false, error } : message
          )
        );
      };
      const appendDelta = (delta: string) => {
        setMessages((prev) =>
          prev.map((message) =>
            message.id === assistantMessage.id ? { ...message, content: message.content + delta } : message
          )
        );
      };

      try {
        const response = await fetch("/api/ai/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: [...history, { role: "user", content: question }] })
        });

        if (!response.ok || !response.body) {
          let error = "Er ging iets mis met de AI. Probeer het later opnieuw.";
          try {
            const data = await response.json();
            if (data?.error) error = data.error;
          } catch {
            // geen JSON-body
          }
          finish(error, true);
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let full = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          if (chunk) {
            full += chunk;
            appendDelta(chunk);
          }
        }
        finish(full.trim() || "Geen antwoord ontvangen. Probeer het opnieuw.");
      } catch {
        finish("Verbinding mislukt. Controleer je internet en probeer het opnieuw.", true);
      } finally {
        setBusy(false);
      }
    },
    [busy, messages]
  );

  const onSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    void send(input);
  };

  const reset = () => {
    if (busy) return;
    setMessages([]);
    setInput("");
  };

  const empty = messages.length === 0;

  return (
    <section className="ai-console" aria-label="AI-assistent">
      <div className="ai-console-glow" aria-hidden="true" />
      <div className="ai-console-inner">
        <header className="ai-console-head">
          <span className="ai-badge" aria-hidden="true">✦</span>
          <div className="ai-console-title">
            <strong>AI-assistent</strong>
            <span className="muted">Vraag alles over je cijfers — hij denkt mee.</span>
          </div>
          {!empty ? (
            <button type="button" className="ghost ai-reset" onClick={reset} disabled={busy}>
              Nieuwe chat
            </button>
          ) : null}
        </header>

        {empty ? (
          <div className="ai-quick">
            <div className="ai-chips">
              {STARTERS.map((chip) => (
                <button type="button" key={chip} className="ai-chip" onClick={() => void send(chip)} disabled={busy}>
                  {chip}
                </button>
              ))}
            </div>
            <div className="ai-actions">
              {QUICK_ACTIONS.map((action) => (
                <button
                  type="button"
                  key={action.label}
                  className="ai-action"
                  onClick={() => void send(action.prompt)}
                  disabled={busy}
                >
                  {action.label}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="ai-thread" ref={scrollRef}>
            {messages.map((message) => (
              <div key={message.id} className={`ai-bubble ${message.role}${message.error ? " error" : ""}`}>
                {message.role === "assistant" && message.streaming && !message.content ? (
                  <span className="ai-typing" aria-label="AI denkt na">
                    <span /><span /><span />
                  </span>
                ) : message.role === "assistant" && !message.streaming && !message.error ? (
                  <Markdown>{message.content}</Markdown>
                ) : (
                  <p className="ai-bubble-text">{message.content}</p>
                )}
              </div>
            ))}
          </div>
        )}

        <form className="ai-input-row" onSubmit={onSubmit}>
          <input
            name="vraag"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="Vraag iets over je cijfers…"
            maxLength={500}
            autoComplete="off"
            disabled={busy}
          />
          <button type="submit" className="primary ai-send" disabled={busy || !input.trim()}>
            {busy ? "Denkt na…" : "Vraag"}
          </button>
        </form>
      </div>
    </section>
  );
}
