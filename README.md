# Tracker

Productie-waardige Next.js versie van de inkoop/verkoop tracker. De oude publieke Google Apps Script backend is verwijderd uit de runtime: de browser praat alleen met deze app, en alle data wordt server-side gelezen en geschreven via Prisma/Postgres.

## Stack

- Next.js App Router + TypeScript
- Auth.js/NextAuth credentials-login
- Prisma + Postgres
- Zod voor server-side inputvalidatie
- Server Actions voor mutaties
- Database-backed rate limiting voor login en schrijfacties

Let op: dit project gebruikt tijdelijk `next@16.3.0-canary.53`, omdat npm audit op 17 juni 2026 de nieuwste stabiele Next-versie nog als kwetsbaar markeerde. Zodra er een gepatchte stable release is, pin Next terug naar die stable versie. Het buildscript gebruikt bewust `next build --webpack`, omdat de canary Turbopack build op Windows in deze omgeving vroeg stopte zonder bruikbare foutmelding.

## Projectstructuur

```text
prisma/schema.prisma              Datamodel voor gebruikers, voorraad, verkoop, poflijst, prijzen en rate limits
prisma/seed.ts                    Maakt de eerste admin en standaardprijzen aan
scripts/migrate-legacy-state.ts   Eenmalige migratie vanuit een lokaal JSON-exportbestand
src/app/page.tsx                  Beveiligde hoofdroute
src/app/login/page.tsx            Loginpagina
src/app/api/auth/[...nextauth]    Auth.js route handler
src/components/tracker-app.tsx    React UI zonder raw HTML rendering
src/lib/auth.ts                   Auth.js config en server-side requireUser()
src/lib/validators.ts             Zod schemas voor input en geladen data
src/server/actions.ts             Server Actions voor inkoop, verkoop, poflijst en prijzen
src/server/data.ts                Server-side data loader met Zod parse op output
src/proxy.ts                      Auth-gate en security headers/CSP
```

## Belangrijkste server-side ingangen

- `src/app/api/auth/[...nextauth]/route.ts`: alleen Auth.js login/logout/session routes.
- `src/server/actions.ts`: alle mutaties. Elke action doet `requireUser()`, `assertSameOrigin()`, rate limiting en Zod-validatie voordat Prisma wordt aangeroepen.
- `src/server/data.ts`: alle leesacties voor trackerdata. De browser krijgt alleen data na een geldige sessie.

Er zijn bewust geen publieke JSON API-routes voor trackerdata.

## Setup

1. Installeer dependencies:

```bash
npm install
```

2. Maak `.env` op basis van `.env.example`:

```bash
cp .env.example .env
```

Vul minimaal in:

- `DATABASE_URL`
- `NEXTAUTH_SECRET`
- `NEXTAUTH_URL`
- `INITIAL_ADMIN_EMAIL`
- `INITIAL_ADMIN_PASSWORD`

3. Maak de database-tabellen aan en seed de eerste admin:

```bash
npm run prisma:migrate
npm run db:seed
```

4. Start lokaal:

```bash
npm run dev
```

## Migratie uit oude JSON

Roep de oude publieke Apps Script URL niet meer aan. Exporteer de oude JSON handmatig naar een lokaal bestand, bijvoorbeeld `legacy-export.json`, en draai:

```bash
npm run migrate:legacy -- ./legacy-export.json
```

Het script valideert de oude shape met Zod en schrijft varianten, verkoop, poflijst en prijzen naar Postgres.

## Beveiliging

- Authenticatie is verplicht voor alle trackerdata. Middleware stuurt niet-ingelogde bezoekers naar `/login`.
- Alle schrijfacties roepen server-side `requireUser()` aan. Er is geen client-side database URL en geen secret in de browserbundle.
- Input wordt server-side gevalideerd met Zod voordat Prisma wordt aangeroepen.
- React rendert gebruikersinvoer als tekst. Er wordt geen `dangerouslySetInnerHTML` gebruikt. DOMPurify is daarom niet toegevoegd: er is geen legitieme plek waar HTML-invoer nodig is. Als later rich-text/HTML wordt toegevoegd, moet dat veld eerst server-side en client-side gesanitized worden.
- Auth cookies zijn `httpOnly`, `sameSite=lax` en in productie `secure`.
- Server Actions controleren de `Origin` tegen de host als CSRF-verdediging. Auth.js gebruikt daarnaast zijn eigen CSRF-mechanisme voor credentials-login.
- Security headers en CSP worden via middleware/Next headers gezet.
- Login en schrijfacties hebben rate limiting in de database (`RateLimitBucket`), zodat het ook over meerdere server instances werkt.
- Poflijst bevat persoonsgegevens. Verwijderen kan via de knop `Verwijder` in de poflijst; dit verwijdert het pofrecord uit de database. Gebruik dit voor het recht op vergetelheid. Verkoopregels blijven alleen zonder los pofrecord bewaard wanneer die boekhoudkundig nodig zijn.

## Handmatig na deploy

- Vul productie-`.env` secrets in bij je host.
- Zet een Postgres database op en draai `npm run prisma:migrate`.
- Seed of maak ten minste één geautoriseerde gebruiker aan.
- Migreer de oude JSON alleen vanuit een lokaal exportbestand.
- Haal de oude Google Apps Script Web App deployment offline, of beperk die direct, zodat de publieke dataset niet meer via GET bereikbaar is.
- Verwijder eventuele oude GitHub Pages static deployment die nog de oude `index.html` serveert.

  Vercel deploy trigger
