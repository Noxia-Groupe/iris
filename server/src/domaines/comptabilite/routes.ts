import type { Express } from 'express';
import { Prisma } from '@prisma/client';
import crypto from 'crypto';
import { prisma, transactionVerifiee } from '../../db';
import { type AuthRequest, JWT_SECRET, requireAuth } from '../../http/auth';
import { requireAdmin } from '../../http/gardes';
import { decimalToNumber } from '../../commun/montants';
import { nombreDecimalNonNegatif } from '../../commun/validation';
import { motifContratValide } from '../contrats/metier';
import { CLES_COMPTABLES, NATURES_ATTENDUES, verrouillerParametrageComptable, libelleComptableValide } from './metier';

// Même règle Unicode, longueur en points de code et trim que les contrats.
function motifCompteComptableValide(value: unknown): string | null { return motifContratValide(value); }

class CompteComptableUtilise extends Error {}
class CompteComptableSansChangement extends Error {}
class CompteComptablePerime extends Error {}
class CompteComptableDejaDansCetEtat extends Error {}
class CompteComptableInactif extends Error {}
class NatureCompteInvalide extends Error {
  constructor(readonly messageMetier: string) { super(messageMetier); }
}
async function verrouillerCompteComptable(tx: Prisma.TransactionClient, compteId: string) {
  await verrouillerParametrageComptable(tx);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "CompteComptable" WHERE "id" = ${compteId} FOR UPDATE`);
}
type ModificationCompte = { libelle: string; nature: string; expectedUpdatedAt: string };
async function verifierModificationCompte(tx: Prisma.TransactionClient, avant: Prisma.CompteComptableGetPayload<object>, modification: ModificationCompte) {
  if (avant.updatedAt.toISOString() !== modification.expectedUpdatedAt) throw new CompteComptablePerime();
  const { libelle, nature } = modification;
  if (avant.libelle === libelle && avant.nature === nature) throw new CompteComptableSansChangement();
  if (avant.nature !== nature) {
    const [regles, reglesTva] = await Promise.all([
      tx.regleComptable.findMany({ where: { compteId: avant.id }, select: { cle: true } }),
      tx.regleTvaComptable.count({ where: { compteId: avant.id } }),
    ]);
    if (regles.some(r => NATURES_ATTENDUES[r.cle] && !NATURES_ATTENDUES[r.cle].includes(nature)) || (reglesTva && nature !== 'TVA')) throw new NatureCompteInvalide('Nature incompatible avec une règle client, vente ou TVA : remappez la règle auparavant.');
  }
}
async function appliquerModificationCompte(tx: Prisma.TransactionClient, avant: Prisma.CompteComptableGetPayload<object>, modification: ModificationCompte, motif: string, auteur: { id: string; name: string }) {
  await verifierModificationCompte(tx, avant, modification);
  const apres = await tx.compteComptable.update({ where: { id: avant.id }, data: { libelle: modification.libelle, nature: modification.nature } });
  await tx.journalCompteComptable.create({ data: {
    compteId: avant.id, auteurId: auteur.id, auteurNom: auteur.name,
    action: 'MODIFICATION', avantLibelle: avant.libelle, apresLibelle: apres.libelle,
    avantNature: avant.nature, apresNature: apres.nature, motif,
  } });
  return apres;
}

class ConflitImportComptable extends Error {
  constructor(readonly erreurs: { ligne: number; erreur: string }[]) { super('Import refusé : comptes existants différents.'); }
}
// Jeton signé, lié à l'acteur, au fichier et à la photographie complète du périmètre.
// Aucun brouillon en base : l'aperçu ne produit aucune écriture.
async function preparerApercuImport(tx: Prisma.TransactionClient, comptes: { code: string; libelle: string; nature: string }[]) {
  const existants = await tx.compteComptable.findMany({ where: { code: { in: comptes.map(c => c.code) } } });
  const parCode = new Map(existants.map(c => [c.code, c]));
  // Précharger les rattachements une fois pour le lot ; aucun aller-retour par ligne.
  const [regles, tva] = await Promise.all([
    tx.regleComptable.findMany({ orderBy: { cle: 'asc' } }),
    tx.regleTvaComptable.findMany({ orderBy: { taux: 'asc' } }),
  ]);
  const reglesParCompte = new Map<string, string[]>();
  for (const regle of regles) {
    if (!regle.compteId) continue;
    const rattachements = reglesParCompte.get(regle.compteId) ?? [];
    rattachements.push(regle.cle);
    reglesParCompte.set(regle.compteId, rattachements);
  }
  const comptesTva = new Set(tva.map(regle => regle.compteId));
  const actions = [] as { code: string; ligne: number; action: 'creer' | 'modifier' | 'ignorer'; avant?: { libelle: string; nature: string }; apres: { libelle: string; nature: string } }[];
  const erreurs: { ligne: number; erreur: string }[] = [];
  for (const [index, compte] of comptes.entries()) {
    const avant = parCode.get(compte.code);
    const apres = { libelle: compte.libelle, nature: compte.nature };
    if (avant && !avant.actif) { erreurs.push({ ligne: index + 1, erreur: `Le compte ${compte.code} est inactif : réactivez-le explicitement.` }); continue; }
    const action = !avant ? 'creer' : avant.libelle === compte.libelle && avant.nature === compte.nature ? 'ignorer' : 'modifier';
    if (avant && action === 'modifier' && avant.nature !== compte.nature &&
      ((reglesParCompte.get(avant.id) ?? []).some(cle => NATURES_ATTENDUES[cle] && !NATURES_ATTENDUES[cle].includes(compte.nature)) ||
        (comptesTva.has(avant.id) && compte.nature !== 'TVA'))) {
      erreurs.push({ ligne: index + 1, erreur: 'Nature incompatible avec une règle client, vente ou TVA : remappez la règle auparavant.' });
      continue;
    }
    actions.push({ code: compte.code, ligne: index + 1, action, ...(avant ? { avant: { libelle: avant.libelle, nature: avant.nature } } : {}), apres });
  }
  if (erreurs.length) throw new ConflitImportComptable(erreurs);
  // Les versions et l'activité capturent aussi les comptes inchangés ; les règles
  // sont incluses pour refuser un aperçu devenu caduc après un remappage.
  const empreinte = crypto.createHash('sha256').update(JSON.stringify({ comptes, existants: existants.sort((a, b) => a.code.localeCompare(b.code)), regles, tva })).digest('hex');
  return { actions, empreinte, parCode };
}
function signerApercu(empreinte: string, auteurId: string, delivre: number) {
  const contenu = Buffer.from(JSON.stringify({ empreinte, auteurId, delivre })).toString('base64url');
  const signature = crypto.createHmac('sha256', JWT_SECRET).update('iris:apercu-import-comptable:v1:').update(contenu).digest('base64url');
  return `${contenu}.${signature}`;
}
function apercuValide(jeton: unknown, empreinte: string, auteurId: string) {
  if (typeof jeton !== 'string' || jeton.length > 2048) return false;
  const [contenu, signature, surplus] = jeton.split('.');
  if (!contenu || !signature || surplus !== undefined) return false;
  const attendu = crypto.createHmac('sha256', JWT_SECRET).update('iris:apercu-import-comptable:v1:').update(contenu).digest();
  let fourni: Buffer;
  try { fourni = Buffer.from(signature, 'base64url'); } catch { return false; }
  if (fourni.length !== attendu.length || !crypto.timingSafeEqual(fourni, attendu)) return false;
  try {
    const donnees = JSON.parse(Buffer.from(contenu, 'base64url').toString());
    return donnees.empreinte === empreinte && donnees.auteurId === auteurId &&
      Number.isSafeInteger(donnees.delivre) && donnees.delivre <= Date.now() && Date.now() - donnees.delivre <= 10 * 60_000;
  } catch { return false; }
}

class RegleComptableSansChangement extends Error {}
class RegleComptableMotifManquant extends Error {}
class RegleComptableVersionManquante extends Error {}

// Retrait explicite du mapping courant, jamais du compte ni des écritures figées.
class RegleTvaPerimee extends Error {}

export function enregistrerRoutesComptabilite(app: Express): void {
  app.get('/api/comptabilite', requireAuth, requireAdmin, async (_req, res) => {
    try { const [comptes, regles, reglesTva] = await Promise.all([prisma.compteComptable.findMany({ orderBy: { code: 'asc' } }), prisma.regleComptable.findMany({ include: { compte: true }, orderBy: { cle: 'asc' } }), prisma.regleTvaComptable.findMany({ include: { compte: true }, orderBy: { taux: 'asc' } })]); res.json(decimalToNumber({ comptes, regles, reglesTva })); }
    catch { res.status(500).json({ error: 'Lecture du paramétrage comptable impossible.' }); }
  });

  app.post('/api/comptabilite/comptes', requireAuth, requireAdmin, async (req, res) => {
    try { const code = String(req.body?.code || '').trim(), libelleBrut = String(req.body?.libelle || ''), libelle = libelleBrut.trim(), nature = String(req.body?.nature || '');
      if (!/^\d{3,12}$/.test(code) || !libelle || !libelleComptableValide(libelleBrut) || !['ACTIF', 'PASSIF', 'PRODUIT', 'CHARGE', 'TVA'].includes(nature)) return res.status(400).json({ error: 'Compte comptable invalide.' });
      const compte = await transactionVerifiee(async tx => {
        await verrouillerParametrageComptable(tx);
        return tx.compteComptable.create({ data: { code, libelle, nature } });
      }); res.status(201).json(compte);
    } catch (error) { if ((error as { code?: string }).code === 'P2002') return res.status(409).json({ error: 'Ce code de compte existe déjà, éventuellement inactif. Consultez le plan et réactivez-le avec un motif si nécessaire.' }); res.status(500).json({ error: 'Création du compte impossible.' }); }
  });

  app.patch('/api/comptabilite/comptes/:id', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
        Object.keys(body).some(k => !['libelle', 'nature', 'motif', 'expectedUpdatedAt'].includes(k)) ||
        typeof body.expectedUpdatedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(body.expectedUpdatedAt) || !Number.isFinite(Date.parse(body.expectedUpdatedAt)) ||
        (!Object.hasOwn(body, 'libelle') && !Object.hasOwn(body, 'nature')) ||
        (Object.hasOwn(body, 'libelle') && (typeof body.libelle !== 'string' || !body.libelle.trim() || !libelleComptableValide(body.libelle))) ||
        (Object.hasOwn(body, 'nature') && (typeof body.nature !== 'string' || !['ACTIF', 'PASSIF', 'PRODUIT', 'CHARGE', 'TVA'].includes(body.nature))) ||
        !motifCompteComptableValide(body.motif)) {
      return res.status(400).json({ error: 'Libellé ou nature et motif de 3 à 500 caractères requis ; code non modifiable.' });
    }
    try {
      const compte = await transactionVerifiee(async tx => {
        await verrouillerCompteComptable(tx, String(req.params.id));
        const avant = await tx.compteComptable.findUnique({ where: { id: String(req.params.id) } });
        if (!avant) return null;
        return appliquerModificationCompte(tx, avant, {
          libelle: Object.hasOwn(body, 'libelle') ? body.libelle.trim() : avant.libelle,
          nature: Object.hasOwn(body, 'nature') ? body.nature : avant.nature,
          expectedUpdatedAt: body.expectedUpdatedAt,
        }, body.motif.trim(), req.user!);
      });
      if (!compte) return res.status(404).json({ error: 'Compte comptable introuvable.' });
      res.json(compte);
    } catch (error) {
      if (error instanceof CompteComptableSansChangement) return res.status(400).json({ error: 'Aucune modification du compte.' });
      if (error instanceof CompteComptablePerime) return res.status(409).json({ error: 'Compte modifié depuis son ouverture : actualisez le plan avant de réessayer.' });
      if (error instanceof NatureCompteInvalide) return res.status(409).json({ error: error.messageMetier });
      if ((error as { code?: string })?.code === 'P2034') return res.status(409).json({ error: 'Modification concurrente du compte : réessayez.' });
      res.status(500).json({ error: 'Modification du compte impossible.' });
    }
  });
  app.get('/api/comptabilite/comptes/:id/journal', requireAuth, requireAdmin, async (req, res) => {
    try {
      const id = String(req.params.id);
      if (!await prisma.compteComptable.findUnique({ where: { id }, select: { id: true } })) return res.status(404).json({ error: 'Compte comptable introuvable.' });
      res.json(await prisma.journalCompteComptable.findMany({ where: { compteId: id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }));
    } catch { res.status(500).json({ error: 'Lecture du journal du compte impossible.' }); }
  });
  app.patch('/api/comptabilite/comptes/:id/activation', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) ||
        Object.keys(req.body).length !== 2 || !Object.hasOwn(req.body, 'actif') || !Object.hasOwn(req.body, 'motif') ||
        typeof req.body.actif !== 'boolean' || !motifCompteComptableValide(req.body.motif)) {
      return res.status(400).json({ error: 'Statut booléen et motif de 3 à 500 caractères requis.' });
    }
    const motif = req.body.motif.trim();
    try {
      const compte = await transactionVerifiee(async tx => {
        await verrouillerCompteComptable(tx, String(req.params.id));
        const existant = await tx.compteComptable.findUnique({ where: { id: String(req.params.id) } });
        if (!existant) return null;
        if (existant.actif === req.body.actif) throw new CompteComptableDejaDansCetEtat();
        if (!req.body.actif) {
          const [regles, reglesTva] = await Promise.all([
            tx.regleComptable.count({ where: { compteId: existant.id } }),
            tx.regleTvaComptable.count({ where: { compteId: existant.id } }),
          ]);
          if (regles || reglesTva) throw new CompteComptableUtilise();
        }
        const modifie = await tx.compteComptable.update({ where: { id: existant.id }, data: { actif: req.body.actif } });
        await tx.journalCompteComptable.create({ data: {
          compteId: existant.id, auteurId: req.user!.id, auteurNom: req.user!.name,
          action: req.body.actif ? 'REACTIVATION' : 'DESACTIVATION', avant: existant.actif,
          apres: modifie.actif, motif,
        } });
        return modifie;
      });
      if (!compte) return res.status(404).json({ error: 'Compte comptable introuvable.' });
      res.json(compte);
    } catch (error) {
      if (error instanceof CompteComptableDejaDansCetEtat) return res.status(409).json({ error: 'Ce compte est déjà dans cet état.' });
      if (error instanceof CompteComptableUtilise) return res.status(409).json({ error: 'Compte utilisé par une règle comptable ou TVA : remappez la règle avant de désactiver.' });
      if ((error as { code?: string })?.code === 'P2034') return res.status(409).json({ error: 'Modification concurrente du compte : réessayez.' });
      res.status(500).json({ error: 'Modification du statut du compte impossible.' });
    }
  });

  app.post('/api/comptabilite/importer', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
    const lignes = Array.isArray(req.body?.lignes) ? req.body.lignes : [];
    if (!lignes.length || lignes.length > 5000) return res.status(400).json({ error: 'Le plan doit contenir entre 1 et 5 000 lignes.' });
    const vus = new Set<string>(); const erreurs: { ligne: number; erreur: string }[] = [];
    const comptes: { code: string; libelle: string; nature: string }[] = lignes.map((ligne: any, index: number) => {
      const code = String(ligne?.code || '').trim(), libelleBrut = String(ligne?.libelle || ''), libelle = libelleBrut.trim(), nature = String(ligne?.nature || '');
      if (!/^\d{3,12}$/.test(code) || !libelle || !libelleComptableValide(libelleBrut) || !['ACTIF', 'PASSIF', 'PRODUIT', 'CHARGE', 'TVA'].includes(nature)) erreurs.push({ ligne: index + 1, erreur: 'Code, libellé ou nature invalide.' });
      if (vus.has(code)) erreurs.push({ ligne: index + 1, erreur: 'Code dupliqué dans le fichier.' }); vus.add(code); return { code, libelle, nature };
    });
    if (erreurs.length) return res.status(400).json({ error: 'Import refusé : corrigez les lignes signalées.', erreurs });
    const mode = req.body?.mode;
    if (mode !== undefined && mode !== 'mettre_a_jour') return res.status(400).json({ error: 'Mode d’import inconnu.' });
    if (mode === 'mettre_a_jour') {
      if (!['apercu', 'confirmer'].includes(req.body?.phase) ||
        (req.body.phase === 'confirmer' && !motifCompteComptableValide(req.body.motif)))
        return res.status(400).json({ error: 'Phase ou motif de 3 à 500 caractères invalide.' });
      try {
        const resultat = await transactionVerifiee(async tx => {
          await verrouillerParametrageComptable(tx);
          const { actions, empreinte, parCode } = await preparerApercuImport(tx, comptes);
          if (req.body.phase === 'apercu') return { actions, apercuId: signerApercu(empreinte, req.user!.id, Date.now()) };
          if (!apercuValide(req.body.apercuId, empreinte, req.user!.id)) throw new CompteComptablePerime();
          for (const action of actions) {
            const cible = comptes[action.ligne - 1];
            if (action.action === 'creer') await tx.compteComptable.create({ data: cible });
            if (action.action === 'modifier') {
              const avant = parCode.get(action.code)!;
              await appliquerModificationCompte(tx, avant, { libelle: cible.libelle, nature: cible.nature, expectedUpdatedAt: avant.updatedAt.toISOString() }, req.body.motif.trim(), req.user!);
            }
          }
          return { crees: actions.filter(a => a.action === 'creer').length, modifies: actions.filter(a => a.action === 'modifier').length, ignores: actions.filter(a => a.action === 'ignorer').length };
        }, { maxWait: 10_000, timeout: 60_000 });
        return res.status(200).json(resultat);
      } catch (error) {
        if (error instanceof ConflitImportComptable) return res.status(409).json({ error: error.message, erreurs: error.erreurs });
        if (error instanceof CompteComptablePerime) return res.status(409).json({ error: 'Aperçu périmé : recommencez l’aperçu.' });
        if ((error as { code?: string })?.code === 'P2034') return res.status(409).json({ error: 'Import concurrent : recommencez l’aperçu.' });
        return res.status(500).json({ error: 'Mise à jour du plan comptable impossible.' });
      }
    }
    if (req.body?.phase !== undefined || req.body?.motif !== undefined || req.body?.apercuId !== undefined) return res.status(400).json({ error: 'Mode d’import requis.' });
    try {
      const resultat = await transactionVerifiee(async tx => {
        // Sérialise les imports et toutes les émissions/remappages comptables.
        await verrouillerParametrageComptable(tx);
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(814081)::text AS verrou`;
        const resultat = await tx.compteComptable.createMany({ data: comptes, skipDuplicates: true });
        const existants = await tx.compteComptable.findMany({ where: { code: { in: comptes.map(compte => compte.code) } }, select: { code: true, libelle: true, nature: true, actif: true } });
        const parCode = new Map(existants.map(compte => [compte.code, compte]));
        const divergences = comptes.flatMap((compte, index) => {
          const existant = parCode.get(compte.code);
          return existant && !existant.actif
            ? [{ ligne: index + 1, erreur: `Le compte ${compte.code} existe mais est inactif : réactivez-le explicitement avec un motif avant de relancer l’import.` }]
            : existant && (existant.libelle !== compte.libelle || existant.nature !== compte.nature)
            ? [{ ligne: index + 1, erreur: `Le compte ${compte.code} existe avec un libellé ou une nature différente.` }] : [];
        });
        if (divergences.length) throw new ConflitImportComptable(divergences);
        return resultat;
      }, { maxWait: 10_000, timeout: 60_000 });
      res.status(201).json({ importes: resultat.count, ignores: comptes.length - resultat.count });
    } catch (error) {
      if (error instanceof ConflitImportComptable) return res.status(409).json({ error: error.message, erreurs: error.erreurs });
      res.status(500).json({ error: 'Import du plan comptable impossible.' });
    }
  });
  app.get('/api/comptabilite/regles/journal', requireAuth, requireAdmin, async (_req, res) => {
    try { res.json(await prisma.journalRegleComptable.findMany({ orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })); }
    catch { res.status(500).json({ error: 'Lecture du journal des règles impossible.' }); }
  });

  app.put('/api/comptabilite/regles/:cle', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
    try { const cle = String(req.params.cle || ''); if (!CLES_COMPTABLES.includes(cle)) return res.status(400).json({ error: 'Règle comptable inconnue.' });
      const compteId = req.body?.compteId ? String(req.body.compteId) : null; const journal = req.body?.journal == null ? null : String(req.body.journal).trim() || null;
      if (cle === 'JOURNAL_VENTES' ? !journal : !compteId) return res.status(400).json({ error: 'Paramétrage de règle incomplet.' });
      if (journal && !/^[A-Z0-9]{1,8}$/.test(journal)) return res.status(400).json({ error: 'Le code journal doit compter au plus 8 caractères alphanumériques majuscules.' });
      const regle = await transactionVerifiee(async tx => {
        await verrouillerParametrageComptable(tx);
        if (compteId) {
          await verrouillerCompteComptable(tx, compteId);
          const compte = await tx.compteComptable.findFirst({ where: { id: compteId, actif: true } });
          if (!compte) throw new CompteComptableInactif();
          if (NATURES_ATTENDUES[cle] && !NATURES_ATTENDUES[cle].includes(compte.nature)) throw new NatureCompteInvalide(`Cette règle attend un compte de nature ${NATURES_ATTENDUES[cle].join(' ou ')}.`);
        }
        const courante = await tx.regleComptable.findUnique({ where: { cle } });
        if (courante) {
          // expectedValeur porte le code du journal pour JOURNAL_VENTES, l'id du compte sinon.
          // La TVA utilise séparément expectedCompteId : ne pas confondre les contrats.
          if (typeof req.body?.expectedValeur !== 'string' || typeof req.body?.expectedUpdatedAt !== 'string' || !Number.isFinite(Date.parse(req.body.expectedUpdatedAt))) throw new RegleComptableVersionManquante();
          if ((courante.journal ?? courante.compteId) !== req.body.expectedValeur || courante.updatedAt.toISOString() !== req.body.expectedUpdatedAt) throw new RegleTvaPerimee();
          if ((courante.journal ?? courante.compteId) === (journal ?? compteId)) throw new RegleComptableSansChangement();
          const motif = motifCompteComptableValide(req.body?.motif);
          if (!motif) throw new RegleComptableMotifManquant();
          const apres = await tx.regleComptable.update({ where: { cle }, data: { compteId, journal }, include: { compte: true } });
          await tx.journalRegleComptable.create({ data: { type: 'REGLE', cible: cle, action: 'REMAPPAGE', avant: (courante.journal ?? courante.compteId)!, apres: journal ?? compteId, motif, auteurId: req.user!.id, auteurNom: req.user!.name } });
          return apres;
        }
        const motif = motifCompteComptableValide(req.body?.motif);
        if (!motif) throw new RegleComptableMotifManquant();
        const creee = await tx.regleComptable.create({ data: { cle, compteId, journal }, include: { compte: true } });
        await tx.journalRegleComptable.create({ data: { type: 'REGLE', cible: cle, action: 'CREATION', apres: journal ?? compteId, motif, auteurId: req.user!.id, auteurNom: req.user!.name } });
        return creee;
      });
      res.json(regle);
    } catch (error) {
      if (error instanceof RegleComptableVersionManquante) return res.status(400).json({ error: 'Version de la règle requise.' });
      if (error instanceof RegleTvaPerimee) return res.status(409).json({ error: 'La règle a changé depuis son affichage. Actualisez avant de remapper.' });
      if (error instanceof RegleComptableMotifManquant) return res.status(400).json({ error: 'Motif de 3 à 500 caractères sans caractère de contrôle requis.' });
      if (error instanceof RegleComptableSansChangement) return res.status(409).json({ error: 'Règle inchangée.' });
      if (error instanceof CompteComptableInactif) return res.status(404).json({ error: 'Compte comptable actif introuvable.' });
      if (error instanceof NatureCompteInvalide) return res.status(400).json({ error: error.messageMetier });
      if ((error as { code?: string })?.code === 'P2034') return res.status(409).json({ error: 'Modification concurrente de la règle : réessayez.' });
      res.status(500).json({ error: 'Mise à jour du paramétrage impossible.' });
    }
  });

  app.delete('/api/comptabilite/regles/:cle', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
    const cle = String(req.params.cle);
    const body = req.body;
    if (!CLES_COMPTABLES.includes(cle) || !body || typeof body !== 'object' || Array.isArray(body) ||
        Object.keys(body).sort().join(',') !== 'expectedUpdatedAt,expectedValeur,motif' ||
        typeof body.expectedValeur !== 'string' || !body.expectedValeur ||
        typeof body.expectedUpdatedAt !== 'string' || !Number.isFinite(Date.parse(body.expectedUpdatedAt)) ||
        !motifCompteComptableValide(body.motif)) return res.status(400).json({ error: 'Version et motif de 3 à 500 caractères requis.' });
    try {
      const retire = await transactionVerifiee(async tx => {
        await verrouillerParametrageComptable(tx);
        const courante = await tx.regleComptable.findUnique({ where: { cle } });
        if (!courante) return false;
        if ((courante.journal ?? courante.compteId) !== body.expectedValeur || courante.updatedAt.toISOString() !== body.expectedUpdatedAt) throw new RegleTvaPerimee();
        await tx.regleComptable.delete({ where: { cle } });
        await tx.journalRegleComptable.create({ data: { type: 'REGLE', cible: cle, action: 'RETRAIT', avant: body.expectedValeur, motif: body.motif.trim(), auteurId: req.user!.id, auteurNom: req.user!.name } });
        return true;
      });
      if (!retire) return res.status(404).json({ error: 'Règle comptable introuvable.' });
      res.status(204).end();
    } catch (error) {
      if (error instanceof RegleTvaPerimee || (error as { code?: string })?.code === 'P2034') return res.status(409).json({ error: 'La règle a changé depuis son affichage.' });
      res.status(500).json({ error: 'Retrait de la règle impossible.' });
    }
  });

  app.delete('/api/comptabilite/tva/:taux', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
    const taux = nombreDecimalNonNegatif(req.params.taux, 3, true);
    const { confirmation, expectedCompteId, expectedUpdatedAt, motif } = req.body || {};
    if (taux === null || taux > 100 || Object.keys(req.body || {}).sort().join(',') !== 'confirmation,expectedCompteId,expectedUpdatedAt,motif' ||
        !motifCompteComptableValide(motif) ||
        typeof confirmation !== 'string' || confirmation.replace(',', '.') !== String(taux) ||
        typeof expectedCompteId !== 'string' || !expectedCompteId ||
        typeof expectedUpdatedAt !== 'string' || !Number.isFinite(Date.parse(expectedUpdatedAt))) {
      return res.status(400).json({ error: 'Confirmez le taux et la version de la règle TVA à retirer.' });
    }
    try {
      const supprimee = await transactionVerifiee(async tx => {
        await verrouillerParametrageComptable(tx);
        const courante = await tx.regleTvaComptable.findUnique({ where: { taux: new Prisma.Decimal(taux.toFixed(2)) } });
        if (!courante) return false;
        if (courante.compteId !== expectedCompteId || courante.updatedAt.toISOString() !== expectedUpdatedAt) throw new RegleTvaPerimee();
        await tx.regleTvaComptable.delete({ where: { id: courante.id } });
        await tx.journalRegleComptable.create({ data: { type: 'TVA', cible: String(taux), action: 'RETRAIT', avant: courante.compteId, motif: motif.trim(), auteurId: req.user!.id, auteurNom: req.user!.name } });
        return true;
      });
      if (!supprimee) return res.status(404).json({ error: 'Règle TVA introuvable.' });
      res.status(204).end();
    } catch (error) {
      if (error instanceof RegleTvaPerimee) return res.status(409).json({ error: 'La règle TVA a changé depuis son affichage. Actualisez avant de retirer.' });
      res.status(500).json({ error: 'Retrait de la règle TVA impossible.' });
    }
  });

  app.put('/api/comptabilite/tva/:taux', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
    try { const taux = nombreDecimalNonNegatif(req.params.taux, 3, true); const compteId = String(req.body?.compteId || '');
      if (taux === null || taux > 100) return res.status(400).json({ error: 'Taux de TVA invalide.' });
      const tauxDecimal = new Prisma.Decimal(taux.toFixed(2));
      const regle = await transactionVerifiee(async tx => {
        await verrouillerParametrageComptable(tx);
        await verrouillerCompteComptable(tx, compteId);
        const compte = await tx.compteComptable.findFirst({ where: { id: compteId, actif: true } });
        if (!compte) throw new CompteComptableInactif();
        if (compte.nature !== 'TVA') throw new NatureCompteInvalide('Une règle TVA attend un compte de nature TVA.');
        const courante = await tx.regleTvaComptable.findUnique({ where: { taux: tauxDecimal } });
        if (courante) {
          if (typeof req.body?.expectedCompteId !== 'string' || typeof req.body?.expectedUpdatedAt !== 'string' || !Number.isFinite(Date.parse(req.body.expectedUpdatedAt))) throw new RegleComptableVersionManquante();
          if (courante.compteId !== req.body.expectedCompteId || courante.updatedAt.toISOString() !== req.body.expectedUpdatedAt) throw new RegleTvaPerimee();
          if (courante.compteId === compteId) throw new RegleComptableSansChangement();
          const motif = motifCompteComptableValide(req.body?.motif);
          if (!motif) throw new RegleComptableMotifManquant();
          const apres = await tx.regleTvaComptable.update({ where: { id: courante.id }, data: { compteId }, include: { compte: true } });
          await tx.journalRegleComptable.create({ data: { type: 'TVA', cible: String(taux), action: 'REMAPPAGE', avant: courante.compteId, apres: compteId, motif, auteurId: req.user!.id, auteurNom: req.user!.name } });
          return apres;
        }
        const motif = motifCompteComptableValide(req.body?.motif);
        if (!motif) throw new RegleComptableMotifManquant();
        const creee = await tx.regleTvaComptable.create({ data: { taux: tauxDecimal, compteId }, include: { compte: true } });
        await tx.journalRegleComptable.create({ data: { type: 'TVA', cible: String(taux), action: 'CREATION', apres: compteId, motif, auteurId: req.user!.id, auteurNom: req.user!.name } });
        return creee;
      });
      res.json(regle);
    } catch (error) {
      if (error instanceof RegleComptableVersionManquante) return res.status(400).json({ error: 'Version de la règle TVA requise.' });
      if (error instanceof RegleTvaPerimee) return res.status(409).json({ error: 'La règle TVA a changé depuis son affichage. Actualisez avant de remapper.' });
      if (error instanceof RegleComptableMotifManquant) return res.status(400).json({ error: 'Motif de 3 à 500 caractères sans caractère de contrôle requis.' });
      if (error instanceof RegleComptableSansChangement) return res.status(409).json({ error: 'Règle inchangée.' });
      if (error instanceof CompteComptableInactif) return res.status(404).json({ error: 'Compte TVA actif introuvable.' });
      if (error instanceof NatureCompteInvalide) return res.status(400).json({ error: error.messageMetier });
      if ((error as { code?: string })?.code === 'P2034') return res.status(409).json({ error: 'Modification concurrente de la règle TVA : réessayez.' });

      res.status(500).json({ error: 'Mise à jour de la règle TVA impossible.' });
    }
  });
}
