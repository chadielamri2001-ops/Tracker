"use client";

export default function Error({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="state-screen">
      <div className="state-card">
        <h1>Er ging iets mis</h1>
        <p>Er trad een onverwachte fout op. Probeer het opnieuw — als het blijft gebeuren, herlaad de pagina.</p>
        <button className="primary" type="button" onClick={() => reset()}>
          Opnieuw proberen
        </button>
      </div>
    </div>
  );
}
