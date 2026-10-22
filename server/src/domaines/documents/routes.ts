import type { Express } from 'express';
import { randomUUID } from 'crypto';
import type { Prisma } from '@prisma/client';
import { prisma, transactionVerifiee } from '../../db';
import { type AuthRequest, requireAuth } from '../../http/auth';
import { requireSuperAdmin } from '../../http/gardes';
import { journaliserAdministration, verrouillerReglage } from '../../commun/journal-administration';
import { LogoInvalideError, validerLogo } from './logo';

type LogoDecrit = { id: string; empreinte: string; taille: number; typeMime: string } | null | undefined;
const selectionLogo = { id: true, empreinte: true, taille: true, typeMime: true } as const;

// Le journal décrit le fichier sans son contenu : format, taille et début de l'empreinte.
const descriptionLogo = (logo: LogoDecrit) => (logo ? `${logo.typeMime === 'image/png' ? 'PNG' : 'JPEG'}, ${Math.ceil(logo.taille / 1024)} Ko, empreinte ${logo.empreinte.slice(0, 12)}` : null);

// Un logo remplacé ou retiré n'est supprimé que si aucune pièce figée ne l'imprime. Le verrou
// exclusif de la société, pris avant, attend les émissions en cours (verrou partagé de
// figerIdentiteEmetteur) : leur copie, validée, est vue ici.
async function supprimerLogoOrphelin(tx: Prisma.TransactionClient, logoId: string | null | undefined) {
  if (!logoId) return;
  await tx.$executeRaw`DELETE FROM "LogoDocument" WHERE "id" = ${logoId}
    AND NOT EXISTS (SELECT 1 FROM "IdentiteEmetteur" WHERE "logoId" = ${logoId})
    AND NOT EXISTS (SELECT 1 FROM "CompanySettings" WHERE "logoDocumentId" = ${logoId})`;
}

// L'appelant a verrouillé la société (verrouillerReglage) avant toute lecture ou écriture de logo :
// un logo lu ne peut plus être supprimé par un remplacement concurrent.
async function changerLogo(tx: Prisma.TransactionClient, req: AuthRequest, logoId: string | null) {
  const avant = await tx.companySettings.findUnique({ where: { id: 'singleton' }, select: { logoDocument: { select: selectionLogo } } });
  const apres = await tx.companySettings.upsert({ where: { id: 'singleton' }, update: { logoDocumentId: logoId }, create: { id: 'singleton', logoDocumentId: logoId } });
  const ancien = avant?.logoDocument ?? null;
  if ((ancien?.id ?? null) !== logoId) {
    const nouveau = logoId ? await tx.logoDocument.findUniqueOrThrow({ where: { id: logoId }, select: selectionLogo }) : null;
    await journaliserAdministration(tx, req, {
      domaine: 'REGLAGES', type: 'SOCIETE', action: logoId ? 'LOGO_DOCUMENTS' : 'LOGO_DOCUMENTS_RETIRE',
      avant: { logoDocuments: descriptionLogo(ancien) }, apres: { logoDocuments: descriptionLogo(nouveau) },
    });
    await supprimerLogoOrphelin(tx, ancien?.id);
  }
  return apres;
}

export function enregistrerRoutesLogoDocuments(app: Express): void {
  // Logo actuel des documents, lisible par tout compte connecté comme l'identité de la société.
  app.get('/api/company/logo', requireAuth, async (_req, res) => {
    try {
      const societe = await prisma.companySettings.findUnique({ where: { id: 'singleton' }, select: { logoDocument: { select: { contenu: true, typeMime: true } } } });
      if (!societe?.logoDocument) return res.status(404).json({ error: 'Aucun logo enregistré.' });
      res.setHeader('Content-Type', societe.logoDocument.typeMime);
      res.setHeader('Cache-Control', 'private, no-cache');
      return res.send(Buffer.from(societe.logoDocument.contenu));
    } catch { return res.status(500).json({ error: 'Lecture du logo impossible.' }); }
  });

  // Téléversement réservé au super administrateur, comme l'identité de la société. Les pièces
  // déjà émises gardent le logo copié à leur émission.
  app.put('/api/company/logo', requireAuth, requireSuperAdmin, async (req: AuthRequest, res) => {
    try {
      const logo = validerLogo(req.body?.fichier);
      const societe = await transactionVerifiee(async (tx) => {
        await verrouillerReglage(tx, 'CompanySettings');
        await tx.$executeRaw`INSERT INTO "LogoDocument" ("id", "contenu", "typeMime", "empreinte", "taille")
          VALUES (${randomUUID()}, ${logo.contenu}, ${logo.typeMime}, ${logo.empreinte}, ${logo.taille})
          ON CONFLICT ("empreinte") DO NOTHING`;
        const enregistre = await tx.logoDocument.findUniqueOrThrow({ where: { empreinte: logo.empreinte }, select: { id: true } });
        return changerLogo(tx, req, enregistre.id);
      });
      return res.json(societe);
    } catch (error) {
      if (error instanceof LogoInvalideError) return res.status(400).json({ error: error.message });
      return res.status(500).json({ error: 'Enregistrement du logo impossible.' });
    }
  });

  app.delete('/api/company/logo', requireAuth, requireSuperAdmin, async (req: AuthRequest, res) => {
    try {
      return res.json(await transactionVerifiee(async (tx) => {
        await verrouillerReglage(tx, 'CompanySettings');
        return changerLogo(tx, req, null);
      }));
    } catch { return res.status(500).json({ error: 'Retrait du logo impossible.' }); }
  });
}
