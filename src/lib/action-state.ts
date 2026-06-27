// Resultaat dat elke form-action teruggeeft, zodat de UI een nette melding kan
// tonen i.p.v. het volledige crash-scherm (error.tsx). `null` = nog niets gedaan.
// Staat los van de "use server"-actions, omdat zo'n module alleen async functies
// mag exporteren.
export type ActionState = { ok: true } | { ok: false; error: string } | null;

// Resultaat van een AI-actie: tekst-antwoord of nette foutmelding.
export type AiResult = { ok: true; text: string } | { ok: false; error: string } | null;
