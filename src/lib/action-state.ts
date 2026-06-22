// Resultaat dat elke form-action teruggeeft, zodat de UI een nette melding kan
// tonen i.p.v. het volledige crash-scherm (error.tsx). `null` = nog niets gedaan.
// Staat los van de "use server"-actions, omdat zo'n module alleen async functies
// mag exporteren.
export type ActionState = { ok: true } | { ok: false; error: string } | null;
