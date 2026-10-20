import { adresseIntervention, joursPlanifies, libelleCreneau, lienTelephone, nomContact, type ContactIntervention, type Planification, type SiteIntervention } from '../lib/intervention';

// Où et quand se rendre : créneau planifié, adresse et contact à appeler (lot pilote 3b-4).
export function CoordonneesIntervention({ intervention }: { intervention: { site?: SiteIntervention | null; chantier?: { adresse?: string | null } | null; contact?: ContactIntervention | null; planningEvent?: Planification | null } }) {
  const adresse = adresseIntervention(intervention);
  const contact = intervention.contact;
  const telephone = contact?.telephone?.trim() || '';
  const lien = lienTelephone(telephone);
  return <div className="mt-2 space-y-1 text-sm text-gray-700">
    {intervention.planningEvent && <p><span className="text-gray-500">Planifiée :</span> {joursPlanifies(intervention.planningEvent)} · {libelleCreneau(intervention.planningEvent)}</p>}
    <p><span className="text-gray-500">Adresse :</span> {adresse || 'non renseignée'}</p>
    {contact && <p><span className="text-gray-500">Contact :</span> {nomContact(contact)}{telephone && <> · {lien ? <a href={lien} className="font-medium text-blue-700 underline">{telephone}</a> : telephone}</>}</p>}
  </div>;
}
