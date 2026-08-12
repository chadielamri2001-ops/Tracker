-- Direct/voorverkochte doorverkopen: markeer of een verkoop de voorraad heeft
-- afgeboekt. Zo wordt bij verwijderen alleen voorraad teruggeboekt als die er
-- ooit is afgehaald.
ALTER TABLE "Sale" ADD COLUMN IF NOT EXISTS "voorraadGeboekt" BOOLEAN NOT NULL DEFAULT true;
