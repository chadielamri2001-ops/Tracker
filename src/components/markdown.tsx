"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// Aparte module zodat react-markdown + remark-gfm lazy (via next/dynamic) geladen
// kunnen worden: ze tellen alleen mee zodra de assistent een antwoord toont, niet
// in de initiële dashboard-bundle.
export default function Markdown({ children }: { children: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}
