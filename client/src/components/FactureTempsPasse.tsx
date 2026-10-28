import { useEffect, useState } from 'react';
import { apiFetch } from '../api';
import { type ApercuFactureTempsPasse, heuresComptees, heuresFr, regleFactureTempsPasse } from '../lib/factureTempsPasse';

const formatMontant = (montant: number) => montant.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });

// Aperçu de la facture au temps passé d'une intervention, calculé par le serveur : heures saisies sur
// l'intervention et ses suites, règle du devis, heures facturées et lignes. Le parent reçoit l'aperçu (ou
// null tant qu'il n'est pas lu ou qu'il est refusé) pour envoyer le total HT lu à la création.
export default function FactureTempsPasse({ interventionId, onApercu }: { interventionId: string; onApercu: (apercu: ApercuFactureTempsPasse | null) => void }) {
  const [apercu, setApercu] = useState<ApercuFactureTempsPasse | null>(null);
  const [erreur, setErreur] = useState('');
  const [chargement, setChargement] = useState(true);

  useEffect(() => {
    let actif = true;
    setApercu(null);
    setErreur('');
    setChargement(true);
    onApercu(null);
    (async () => {
      try {
        const res = await apiFetch(`/interventions/${interventionId}/facture-temps-passe`);
        const data = await res.json().catch(() => ({}));
        if (!actif) return;
        if (!res.ok) { setErreur(data.error || 'Aperçu de la facture au temps passé impossible.'); return; }
        setApercu(data);
        onApercu(data);
      } catch {
        if (actif) setErreur('Aperçu de la facture au temps passé impossible : le serveur ne répond pas.');
      } finally {
        if (actif) setChargement(false);
      }
    })();
    return () => { actif = false; };
    // onApercu est un setter stable du parent : seul le changement d'intervention relance l'aperçu.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interventionId]);

  return (
    <section className="space-y-3" aria-label="Facture au temps passé">
      <div>
        <h3 className="font-medium">Facture au temps passé</h3>
        <p className="text-sm text-gray-500">
          Les lignes reprennent le devis de l’intervention ; la ligne au temps passé vaut les heures saisies sur l’intervention et ses suites, une fois au total.
          La facture fige les heures du jour de sa création.
        </p>
      </div>
      {chargement && <p role="status" className="text-sm">Calcul de la facture au temps passé…</p>}
      {erreur && <p role="alert" className="text-sm text-red-700">{erreur}</p>}
      {apercu && (
        <div className="space-y-3">
          <div className="rounded-lg border p-3 text-sm space-y-1">
            <p><strong>Devis :</strong> {apercu.devis.numero} (version {apercu.devis.version})</p>
            <ul className="list-disc pl-5" aria-label="Heures comptées">
              {heuresComptees(apercu).map((texte) => <li key={texte}>{texte}</li>)}
            </ul>
            <p><strong>Heures saisies :</strong> {heuresFr(apercu.heures.saisies)}</p>
            <p>{regleFactureTempsPasse(apercu.heures)}</p>
            <p><strong>Heures facturées :</strong> <span aria-label="Heures facturées">{heuresFr(apercu.heures.facturees)}</span></p>
          </div>
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left text-gray-500">
                <tr><th className="p-2">Désignation</th><th className="p-2">Qté</th><th className="p-2">PU HT</th><th className="p-2">TVA</th><th className="p-2">Total HT</th></tr>
              </thead>
              <tbody>
                {apercu.lignes.map((ligne) => (
                  <tr key={ligne.ordre} className="border-t">
                    <td className="p-2">{ligne.designation}{ligne.tempsPasse && <span className="block text-xs text-gray-500">Au temps passé</span>}</td>
                    <td className="p-2">{ligne.quantite.toLocaleString('fr-FR', { maximumFractionDigits: 3 })}</td>
                    <td className="p-2">{formatMontant(ligne.prixUnitaireHt)}</td>
                    <td className="p-2">{ligne.tauxTva.toLocaleString('fr-FR')} %</td>
                    <td className="p-2">{formatMontant(ligne.totalHt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-sm" aria-label="Totaux de la facture au temps passé">
            Total HT {formatMontant(apercu.totalHt)} · TVA {formatMontant(apercu.totalTva)} · Total TTC {formatMontant(apercu.totalTtc)}
          </p>
        </div>
      )}
    </section>
  );
}
