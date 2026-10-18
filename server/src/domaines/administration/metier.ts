import { prisma } from '../../db';
import { fuseauHoraireEntrepriseValide } from '../../commun/dates';
import { upsertSingleton } from '../parametres/metier';

const COMPANY_TEXT_FIELDS = [
  'raisonSociale', 'nomCommercial', 'siret', 'tvaIntra', 'adresse', 'codePostal',
  'ville', 'pays', 'telephone', 'email', 'siteWeb', 'logoUrl', 'prefixeFacture', 'prefixeAvoir', 'piedFacture',
] as const;

const COULEUR_HEX = /^#[0-9a-fA-F]{6}$/;

export function companySettingsPayload(body: Record<string, unknown>): Record<string, string | null> {
  const data: Record<string, string | null> = {};
  for (const field of COMPANY_TEXT_FIELDS) {
    if (body[field] === undefined) continue;
    if (typeof body[field] !== 'string' || body[field].length > 2000) {
      throw new Error(`Champ société invalide : ${field}`);
    }
    data[field] = body[field].trim() || null;
  }
  for (const field of ['couleurPrimaire', 'couleurSecondaire'] as const) {
    if (body[field] === undefined) continue;
    if (typeof body[field] !== 'string' || !COULEUR_HEX.test(body[field])) {
      throw new Error(`Couleur invalide : ${field}`);
    }
    data[field] = body[field].toLowerCase();
  }
  if (body.fuseauHoraire !== undefined) {
    if (!fuseauHoraireEntrepriseValide(body.fuseauHoraire)) throw new Error('Fuseau horaire invalide.');
    data.fuseauHoraire = body.fuseauHoraire;
  }
  return data;
}

export async function getCompanySettings() {
  return upsertSingleton(() => prisma.companySettings.upsert({
    where: { id: 'singleton' },
    update: {},
    create: { id: 'singleton' },
  }));
}
