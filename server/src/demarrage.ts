import express from 'express';
import type http from 'http';
import { Prisma } from '@prisma/client';
import { prisma, transactionVerifiee } from './db';
import { ROLE_SUPERADMIN } from './droits/roles';
import { journaliserAdministration, purgerJournalAdministration } from './commun/journal-administration';
import { upsertSingleton } from './domaines/parametres/metier';
import { normalizeEmail } from './domaines/authentification/sso';
import { libelleCompteJournal, delierFicheSiPlusTechnicien, journaliserDroitsCompte, lireCompteVerrouille, ISOLATION_RETRAIT } from './domaines/utilisateurs/comptes';

// --- Comptes super administrateurs de départ ---
// La liste vient EXCLUSIVEMENT de SUPERADMIN_EMAILS (emails séparés par des virgules).
// Aucun email n'est écrit ici : une instance livrée à un client ne doit pas créer d'office
// un compte d'administration appartenant à l'éditeur.
// Traitement IDEMPOTENT et non destructif : un compte déjà présent est simplement promu
// SUPERADMIN (son nom, son mot de passe et ses rattachements sont conservés) ; un compte
// absent est créé. Aucun compte n'est jamais rétrogradé ici — retirer le rôle superadmin
// se fait depuis Administration > Utilisateurs, par un superadmin.
// « prenom.nom@societe.fr » -> « Prenom Nom » : nom d'affichage par défaut d'un compte
// créé automatiquement, que son titulaire ou un superadmin pourra corriger ensuite.
function nameFromEmail(email: string): string {
  const local = email.split('@')[0].replace(/[._-]+/g, ' ').trim();
  return local.replace(/\b\w/g, (c) => c.toUpperCase()) || email;
}

// Un compte de départ dont la promotion ou la création échoue n'arrête pas le serveur : appelée
// depuis le rappel de listen, cette fonction ne rejette jamais, sans quoi le processus
// s'arrêterait sur un rejet non géré (#231). L'opération est retentée une fois, aussitôt : ce
// second essai vise les refus de concurrence (fiche intervenant reliée au même moment, compte créé
// au même moment par ailleurs) ; une base indisponible le fait échouer aussi. L'échec est alors
// signalé, le démarrage continue avec les comptes suivants, et le prochain démarrage réessaiera.
const ESSAIS_COMPTE_DE_DEPART = 2;

export const ensureSuperAdmins = async () => {
  const emails = (process.env.SUPERADMIN_EMAILS || '')
    .split(',')
    .map(normalizeEmail)
    .filter(Boolean);

  for (const email of emails) {
    for (let essai = 1; essai <= ESSAIS_COMPTE_DE_DEPART; essai += 1) {
      try {
        await assurerSuperAdmin(email);
        break;
      } catch (error) {
        if (essai < ESSAIS_COMPTE_DE_DEPART) {
          console.warn(`[DÉMARRAGE] Compte super administrateur ${email} : essai ${essai} en échec, nouvel essai.`, error);
        } else {
          console.error(`[DÉMARRAGE] Compte super administrateur ${email} ni promu ni créé après ${ESSAIS_COMPTE_DE_DEPART} essais : nouvel essai au prochain démarrage.`, error);
        }
      }
    }
  }

  try {
    const total = await prisma.user.count({ where: { role: ROLE_SUPERADMIN } });
    if (total === 0) {
      console.warn('[AVERTISSEMENT] Aucun compte super administrateur : les modules de l\'application ne peuvent pas être pilotés.');
    }
  } catch (error) {
    console.error('[DÉMARRAGE] Décompte des super administrateurs impossible :', error);
  }
};

async function assurerSuperAdmin(email: string) {
  const existing = await prisma.user.findUnique({ where: { email } });
  // Promotions et créations du démarrage : journalisées comme les autres changements de droits,
  // sans auteur (AUTEUR_JOURNAL_DEMARRAGE), et réservées au super administrateur.
  if (existing) {
    if (existing.role === ROLE_SUPERADMIN) return;
    // Fiches puis compte verrouillés, comme le changement de type ; le compte est relu sous son
    // verrou, en READ COMMITTED explicite (ISOLATION_RETRAIT) : le garde des fiches reliées
    // entre-temps et l'état « avant » journalisé portent sur le compte du moment.
    const promu = await transactionVerifiee(async (tx) => {
      const fiches = await tx.$queryRaw<Array<{ id: string; nom: string }>>(Prisma.sql`SELECT "id", "nom" FROM "Intervenant" WHERE "userId" = ${existing.id} FOR UPDATE`);
      const avant = await lireCompteVerrouille(tx, existing.id);
      if (!avant || avant.role === ROLE_SUPERADMIN) return false;
      const apres = await tx.user.update({ where: { id: existing.id }, data: { role: ROLE_SUPERADMIN } });
      await journaliserDroitsCompte(tx, { } as express.Request, 'TYPE_COMPTE', avant, apres, ['role']);
      await delierFicheSiPlusTechnicien(tx, null, avant, ROLE_SUPERADMIN, fiches);
      return true;
    }, ISOLATION_RETRAIT);
    if (promu) console.log(`Compte promu super administrateur : ${email}`);
    return;
  }
  await transactionVerifiee(async (tx) => {
    const cree = await tx.user.create({
      data: {
        email,
        name: nameFromEmail(email),
        role: ROLE_SUPERADMIN,
      },
    });
    await journaliserAdministration(tx, null, {
      domaine: 'DROITS', type: 'COMPTE', action: 'CREATION', cibleId: cree.id, cibleLibelle: libelleCompteJournal(cree), concerneSuperAdmin: true,
      apres: { role: cree.role, estCommercial: cree.estCommercial, accesFinance: cree.accesFinance, permissions: cree.permissions, actif: cree.actif },
    });
  });
  console.log(`Compte super administrateur créé : ${email} (connexion Microsoft Entra ID)`);
}

// Initialisation BDD (Seeding)
export const initDb = async () => {
  // Garantit l'existence de la ligne de paramètres (singleton) dès le démarrage. Le serveur
  // écoute déjà : une première requête peut la créer au même instant, et une erreur levée ici
  // (rappel de listen) arrêterait le processus avant ensureSuperAdmins.
  await upsertSingleton(() => prisma.parametres.upsert({ where: { id: 'singleton' }, update: {}, create: { id: 'singleton' } }));
  // Une purge qui échoue ne doit pas arrêter le démarrage avant ensureSuperAdmins : elle sera
  // rejouée à la prochaine consultation du journal.
  try {
    await purgerJournalAdministration();
  } catch (error) {
    console.error('[JOURNAL] Purge des entrées échues impossible au démarrage :', error);
  }
};

// Délais de connexion du serveur HTTP. Node ferme par défaut une connexion keep-alive inactive
// au bout de 5 s : un client qui la réutilise à cet instant précis (navigateur, Playwright,
// répartiteur de charge) reçoit « socket hang up » ou `read ECONNRESET`, comme une fois dans la
// CI E2E de #123 puis de #129. Le serveur garde donc ses connexions inactives 65 s, plus
// longtemps que les clients et répartiteurs courants (60 s) : un client qui ne ferme pas de
// lui-même ses connexions inactives (l'agent de Playwright) ne risque plus cette course
// qu'après plus d'une minute d'inactivité sur une même connexion. headersTimeout, qui ne
// s'applique qu'à une requête commencée, reste au-delà de keepAliveTimeout, comme le
// recommandaient les anciennes versions de Node (Node 20 exige seulement qu'il ne dépasse pas
// requestTimeout, 300 s par défaut).
const DELAI_CONNEXION_INACTIVE_MS = 65_000;
export function reglerDelaisConnexion(serveur: http.Server): http.Server {
  serveur.keepAliveTimeout = DELAI_CONNEXION_INACTIVE_MS;
  serveur.headersTimeout = DELAI_CONNEXION_INACTIVE_MS + 1_000;
  return serveur;
}
