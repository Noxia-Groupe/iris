import { useEffect, useState } from 'react';
import { Ban, CheckCircle2, Download, FilePlus2, Plus, RefreshCw, Send, Trash2 } from 'lucide-react';
import { apiFetch } from '../api';

type Client = { id: string; raisonSociale: string };
type Origine = 'CHANTIER' | 'INTERVENTION' | 'CONTRAT' | 'HORS_AFFAIRE';
type NatureLigne = 'PRESTATION' | 'ARTICLE';
type Source = { id: string; nom?: string; titre?: string; reference?: string; clientId?: string; client?: Client };
type Ligne = { designation: string; nature: NatureLigne; quantite: string; prixUnitaireHt: string; tauxTva: string };
type Facture = {
  id: string;
  numero: string | null;
  statut: string;
  type: 'FACTURE' | 'AVOIR';
  factureOrigine?: { id: string; numero: string | null } | null;
  avoirs?: { id: string; numero: string | null; estAvoirAnnulation: boolean }[];
  dateEmission: string;
  dateEcheance: string;
  totalHt: number;
  totalTva: number;
  totalTtc: number;
  origine: Origine;
  motifHorsAffaire?: string | null;
  client: Client;
  lignes: Ligne[];
};

const nouvelleLigne = (): Ligne => ({ designation: '', nature: 'PRESTATION', quantite: '1', prixUnitaireHt: '', tauxTva: '20' });
const nombreFr = (valeur: string): number | null => { const normalise = valeur.trim().replace(',', '.'); return /^\d+(\.\d+)?$/.test(normalise) ? Number(normalise) : null; };
const dateFrancaiseDuJour = (fuseauHoraire: string) => {
  const parties = new Intl.DateTimeFormat('en-CA', { timeZone: fuseauHoraire, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const valeur = (type: Intl.DateTimeFormatPartTypes) => parties.find((partie) => partie.type === type)?.value || '';
  return `${valeur('day')}-${valeur('month')}-${valeur('year')}`;
};
const formatDate = (date: string) => new Date(date).toLocaleDateString('fr-FR', { timeZone: 'UTC' }).replace(/\//g, '-');
const formatMontant = (montant: number) => montant.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });
// Même arithmétique que le serveur : chaque ligne est arrondie au centime avant
// agrégation, puis la TVA est calculée par taux. L’aperçu doit annoncer le document émis.
const centimes = (montant: number) => Math.round((montant + Number.EPSILON) * 100) / 100;
const avoirsPartiels = (facture: Facture) => (facture.avoirs || []).filter((avoir) => !avoir.estAvoirAnnulation);

export default function Factures() {
  const [factures, setFactures] = useState<Facture[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [chantiers, setChantiers] = useState<Source[]>([]);
  const [interventions, setInterventions] = useState<Source[]>([]);
  const [contrats, setContrats] = useState<Source[]>([]);
  const [erreur, setErreur] = useState('');
  const [succes, setSucces] = useState('');
  const [ouvert, setOuvert] = useState(false);
  const [origine, setOrigine] = useState<Origine>('HORS_AFFAIRE');
  const [clientSelection, setClientSelection] = useState('');
  const [lignes, setLignes] = useState<Ligne[]>([nouvelleLigne()]);
  const [fuseauHoraire, setFuseauHoraire] = useState('Europe/Paris');
  const [factureAvoir, setFactureAvoir] = useState<Facture | null>(null);
  const [lignesAvoir, setLignesAvoir] = useState<Ligne[]>([nouvelleLigne()]);

  const charger = async () => {
    try {
      const reponses = await Promise.all(
        ['/factures', '/clients', '/chantiers', '/interventions', '/contrats-maintenance', '/company'].map((path) => apiFetch(path)),
      );
      const donnees = await Promise.all(reponses.map((reponse) => reponse.json()));
      if (!reponses.every((reponse) => reponse.ok)) throw new Error(donnees.find((donnee) => donnee?.error)?.error || 'Chargement impossible.');
      setFactures(Array.isArray(donnees[0]) ? donnees[0] : []);
      setClients(donnees[1].clients || donnees[1] || []);
      setChantiers(Array.isArray(donnees[2]) ? donnees[2] : []);
      setInterventions(Array.isArray(donnees[3]) ? donnees[3] : []);
      setContrats(Array.isArray(donnees[4]) ? donnees[4] : []);
      setFuseauHoraire(donnees[5]?.fuseauHoraire || 'Europe/Paris');
    } catch (e) {
      setErreur(e instanceof Error ? e.message : 'Chargement impossible.');
    }
  };

  useEffect(() => { void charger(); }, []);

  const ouvrirFormulaire = () => {
    setErreur('');
    setSucces('');
    setClientSelection('');
    setOrigine('HORS_AFFAIRE');
    setLignes([nouvelleLigne()]);
    setOuvert(true);
  };

  const modifierLigne = <Champ extends keyof Ligne>(index: number, champ: Champ, valeur: Ligne[Champ]) => {
    setLignes((lignesActuelles) => lignesActuelles.map((ligne, ligneIndex) => (
      ligneIndex === index ? { ...ligne, [champ]: valeur } : ligne
    )));
  };

  const supprimerLigne = (index: number) => {
    setLignes((lignesActuelles) => lignesActuelles.length > 1
      ? lignesActuelles.filter((_, ligneIndex) => ligneIndex !== index)
      : lignesActuelles);
  };

  const ouvrirAvoirPartiel = (facture: Facture) => {
    setErreur('');
    setSucces('');
    setFactureAvoir(facture);
    setLignesAvoir([nouvelleLigne()]);
  };

  const modifierLigneAvoir = <Champ extends keyof Ligne>(index: number, champ: Champ, valeur: Ligne[Champ]) => {
    setLignesAvoir((lignesActuelles) => lignesActuelles.map((ligne, ligneIndex) => (
      ligneIndex === index ? { ...ligne, [champ]: valeur } : ligne
    )));
  };

  const supprimerLigneAvoir = (index: number) => {
    setLignesAvoir((lignesActuelles) => lignesActuelles.length > 1
      ? lignesActuelles.filter((_, ligneIndex) => ligneIndex !== index)
      : lignesActuelles);
  };

  const totauxAvoir = (() => {
    const htParTaux = new Map<number, number>();
    for (const ligne of lignesAvoir) {
      const quantite = nombreFr(ligne.quantite) ?? 0;
      const prixUnitaireHt = nombreFr(ligne.prixUnitaireHt) ?? 0;
      const tauxTva = nombreFr(ligne.tauxTva) ?? 0;
      // Le serveur arrondit chaque ligne avant de sommer : faire de même ici évite
      // qu’un aperçu à côté d’un plafond annonce un montant différent du document.
      htParTaux.set(tauxTva, centimes((htParTaux.get(tauxTva) || 0) + centimes(quantite * prixUnitaireHt)));
    }
    const totalHt = centimes([...htParTaux.values()].reduce((somme, ht) => somme + ht, 0));
    const totalTva = centimes([...htParTaux.entries()].reduce((somme, [taux, ht]) => somme + centimes(ht * taux / 100), 0));
    return { totalHt, totalTva, totalTtc: centimes(totalHt + totalTva) };
  })();

  const creerAvoirPartiel = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!factureAvoir) return;
    setErreur('');
    setSucces('');
    const lignesConverties = lignesAvoir.map((ligne) => ({ ...ligne, designation: ligne.designation.trim(), quantite: nombreFr(ligne.quantite), prixUnitaireHt: nombreFr(ligne.prixUnitaireHt), tauxTva: nombreFr(ligne.tauxTva) }));
    const fautive = lignesConverties.findIndex((ligne) => !ligne.designation || ligne.quantite === null || ligne.quantite <= 0 || ligne.prixUnitaireHt === null || ligne.prixUnitaireHt < 0 || ligne.tauxTva === null || ligne.tauxTva < 0 || ligne.tauxTva > 100);
    if (fautive >= 0) return setErreur(`Ligne d’avoir ${fautive + 1} : désignation obligatoire, quantité supérieure à zéro et montants numériques attendus (TVA entre 0 et 100).`);
    const res = await apiFetch(`/factures/${factureAvoir.id}/avoirs`, { method: 'POST', body: JSON.stringify({ lignes: lignesConverties }) });
    const data = await res.json();
    if (!res.ok) return setErreur(data.error || 'Création de l’avoir partiel impossible.');
    setFactureAvoir(null);
    setSucces(`Avoir ${data.numero || ''} créé et émis.`.trim());
    await charger();
  };

  const creer = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setErreur('');
    setSucces('');
    const form = new FormData(event.currentTarget);
    const lignesConverties = lignes.map((ligne) => ({ ...ligne, quantite: nombreFr(ligne.quantite), prixUnitaireHt: nombreFr(ligne.prixUnitaireHt), tauxTva: nombreFr(ligne.tauxTva) }));
    const fautive = lignesConverties.findIndex((ligne) => ligne.quantite === null || ligne.quantite <= 0 || ligne.prixUnitaireHt === null || ligne.tauxTva === null || ligne.tauxTva > 100);
    if (fautive >= 0) return setErreur(`Ligne ${fautive + 1} : la quantité doit être supérieure à zéro, le prix et le taux de TVA doivent être des nombres (la virgule est acceptée, le taux ne dépasse pas 100).`);
    const payload: Record<string, unknown> = {
      clientId: form.get('clientId'),
      origine,
      dateEmission: form.get('dateEmission'),
      dateEcheance: form.get('dateEcheance'),
      lignes: lignesConverties,
    };
    if (origine === 'CHANTIER') payload.chantierId = form.get('chantierId');
    if (origine === 'INTERVENTION') payload.interventionId = form.get('interventionId');
    if (origine === 'CONTRAT') payload.contratMaintenanceId = form.get('contratMaintenanceId');
    if (origine === 'HORS_AFFAIRE') payload.motifHorsAffaire = form.get('motifHorsAffaire');

    const res = await apiFetch('/factures', { method: 'POST', body: JSON.stringify(payload) });
    const data = await res.json();
    if (!res.ok) return setErreur(data.error || 'Création impossible.');
    setOuvert(false);
    setSucces('Brouillon créé : il ne porte aucun numéro tant qu’il n’est pas émis.');
    await charger();
  };

  const emettre = async (facture: Facture) => {
    setErreur('');
    setSucces('');
    const res = await apiFetch(`/factures/${facture.id}/emettre`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) return setErreur(data.error || 'Émission impossible.');
    setSucces(`Facture ${data.numero} émise et figée.`);
    await charger();
  };

  const changerStatut = async (facture: Facture, action: 'regler' | 'annuler') => {
    const reglement = action === 'regler';
    const confirmation = reglement
      ? `Confirmer le règlement de la facture ${facture.numero} ? Son montant et ses lignes resteront inchangés.`
      : `Annuler la facture ${facture.numero} ? Cette opération crée immédiatement un avoir total numéroté, conserve les deux documents et ne peut pas être annulée depuis cet écran.`;
    if (!window.confirm(confirmation)) return;
    setErreur('');
    setSucces('');
    const res = await apiFetch(`/factures/${facture.id}/${action}`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) return setErreur(data.error || 'Changement de statut impossible.');
    const document = data;
    const avoir = !reglement ? data.avoir : null;
    setSucces(reglement ? `Facture ${document.numero} marquée comme réglée.` : `Facture ${document.numero} annulée ; avoir ${avoir?.numero || 'créé'} disponible.`);
    await charger();
  };

  const exporter = async () => {
    setErreur('');
    const res = await apiFetch('/factures/export-comptable.csv');
    if (!res.ok) {
      const data = await res.json();
      return setErreur(data.error || 'Export impossible.');
    }
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = 'export-ventes.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const telechargerDocument = async (facture: Facture) => {
    setErreur('');
    const res = await apiFetch(`/factures/${facture.id}/document.pdf`);
    if (!res.ok) {
      const data = await res.json();
      return setErreur(data.error || 'Document indisponible.');
    }
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = `${facture.numero || 'facture'}.pdf`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const sources = (origine === 'CHANTIER' ? chantiers : origine === 'INTERVENTION' ? interventions : contrats)
    .filter((source) => !clientSelection || source.clientId === clientSelection || source.client?.id === clientSelection);
  const sourceName = (source: Source) => source.nom || source.titre || source.reference || source.id;

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <div className="flex justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Factures</h1>
          <p className="text-gray-500">Facturation française native et numérotation attribuée à l’émission.</p>
        </div>
        <div className="flex gap-2">
          <button className="btn btn-secondary" onClick={() => void charger()}><RefreshCw size={16} /> Actualiser</button>
          <button className="btn btn-secondary" onClick={() => void exporter()}><Download size={16} /> Export comptable</button>
          <button className="btn btn-primary" onClick={ouvrirFormulaire}><FilePlus2 size={16} /> Nouvelle facture</button>
        </div>
      </div>

      {erreur && <p className="text-red-600">{erreur}</p>}
      {succes && <p className="text-emerald-700">{succes}</p>}

      {factureAvoir && (
        <form className="rounded-xl border border-amber-300 bg-amber-50 p-5 space-y-4" onSubmit={creerAvoirPartiel}>
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="font-semibold">Nouvel avoir partiel</h2>
              <p className="text-sm text-gray-600">Facture {factureAvoir.numero} du {formatDate(factureAvoir.dateEmission)} — {factureAvoir.client.raisonSociale}</p>
            </div>
            <button type="button" className="btn btn-secondary" onClick={() => setFactureAvoir(null)}>Annuler</button>
          </div>
          <p className="text-sm text-gray-600">Les plafonds cumulés et les taux autorisés sont contrôlés par le serveur lors de la création.</p>
          <section className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h3 className="font-medium">Lignes à créditer</h3>
              <button type="button" className="btn btn-secondary" onClick={() => setLignesAvoir((lignesActuelles) => [...lignesActuelles, nouvelleLigne()])}>
                <Plus size={16} /> Ajouter une ligne d’avoir
              </button>
            </div>
            {lignesAvoir.map((ligne, index) => (
              <div key={index} className="grid gap-3 rounded-lg border bg-white p-3 sm:grid-cols-12">
                <input required className="form-input sm:col-span-4" value={ligne.designation} onChange={(e) => modifierLigneAvoir(index, 'designation', e.target.value)} placeholder="Désignation" aria-label={`Désignation ligne avoir ${index + 1}`} />
                <select className="form-input sm:col-span-2" value={ligne.nature} onChange={(e) => modifierLigneAvoir(index, 'nature', e.target.value as NatureLigne)} aria-label={`Nature ligne avoir ${index + 1}`}>
                  <option value="PRESTATION">Prestation</option>
                  <option value="ARTICLE">Article</option>
                </select>
                <input required inputMode="decimal" className="form-input sm:col-span-1" value={ligne.quantite} onChange={(e) => modifierLigneAvoir(index, 'quantite', e.target.value)} placeholder="Qté" aria-label={`Quantité ligne avoir ${index + 1}`} />
                <input required inputMode="decimal" className="form-input sm:col-span-2" value={ligne.prixUnitaireHt} onChange={(e) => modifierLigneAvoir(index, 'prixUnitaireHt', e.target.value)} placeholder="PU HT" aria-label={`Prix unitaire HT ligne avoir ${index + 1}`} />
                <input required inputMode="decimal" className="form-input sm:col-span-1" value={ligne.tauxTva} onChange={(e) => modifierLigneAvoir(index, 'tauxTva', e.target.value)} placeholder="TVA %" aria-label={`TVA ligne avoir ${index + 1}`} />
                <button type="button" className="btn btn-secondary sm:col-span-2" disabled={lignesAvoir.length === 1} onClick={() => supprimerLigneAvoir(index)} aria-label={`Supprimer la ligne d’avoir ${index + 1}`}>
                  <Trash2 size={16} /> Supprimer
                </button>
              </div>
            ))}
          </section>
          <div data-testid="aperçu-avoir" className="grid gap-3 rounded-lg border bg-white p-3 text-sm sm:grid-cols-3">
            <span><strong>Total HT</strong><br />{formatMontant(totauxAvoir.totalHt)}</span>
            <span><strong>TVA</strong><br />{formatMontant(totauxAvoir.totalTva)}</span>
            <span><strong>Total TTC</strong><br />{formatMontant(totauxAvoir.totalTtc)}</span>
          </div>
          <button className="btn btn-primary" type="submit"><Send size={16} /> Créer l’avoir partiel</button>
        </form>
      )}

      {ouvert && (
        <form className="rounded-xl border bg-white p-5 space-y-4" onSubmit={creer}>
          <div className="flex items-center justify-between gap-3">
            <h2 className="font-semibold">Nouveau brouillon</h2>
            <button type="button" className="btn btn-secondary" onClick={() => setOuvert(false)}>Annuler</button>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <select required name="clientId" className="form-input" value={clientSelection} onChange={(e) => setClientSelection(e.target.value)}>
              <option value="">Client…</option>
              {clients.map((client) => <option key={client.id} value={client.id}>{client.raisonSociale}</option>)}
            </select>
            <input required name="dateEmission" defaultValue={dateFrancaiseDuJour(fuseauHoraire)} pattern="\d{2}-\d{2}-\d{4}" className="form-input" placeholder="Émission (JJ-MM-AAAA)" />
            <input required name="dateEcheance" defaultValue={dateFrancaiseDuJour(fuseauHoraire)} pattern="\d{2}-\d{2}-\d{4}" className="form-input" placeholder="Échéance (JJ-MM-AAAA)" />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <select name="origine" className="form-input" value={origine} onChange={(e) => setOrigine(e.target.value as Origine)}>
              <option value="HORS_AFFAIRE">Hors affaire — exception motivée</option>
              <option value="CHANTIER">Chantier / affaire</option>
              <option value="INTERVENTION">Intervention SAV</option>
              <option value="CONTRAT">Contrat de maintenance</option>
            </select>
            {origine === 'HORS_AFFAIRE' ? (
              <input required name="motifHorsAffaire" minLength={3} className="form-input" placeholder="Motif obligatoire" />
            ) : (
              <select required name={origine === 'CHANTIER' ? 'chantierId' : origine === 'INTERVENTION' ? 'interventionId' : 'contratMaintenanceId'} className="form-input">
                <option value="">Rattachement…</option>
                {sources.map((source) => <option key={source.id} value={source.id}>{sourceName(source)}</option>)}
              </select>
            )}
          </div>

          <section className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="font-medium">Lignes de facture</h3>
                <p className="text-sm text-gray-500">Ajoutez prestations et articles. Au moins une ligne est obligatoire.</p>
              </div>
              <button type="button" className="btn btn-secondary" onClick={() => setLignes((lignesActuelles) => [...lignesActuelles, nouvelleLigne()])}>
                <Plus size={16} /> Ajouter une ligne
              </button>
            </div>
            {lignes.map((ligne, index) => (
              <div key={index} className="grid gap-3 rounded-lg border p-3 sm:grid-cols-12">
                <input required className="form-input sm:col-span-4" value={ligne.designation} onChange={(e) => modifierLigne(index, 'designation', e.target.value)} placeholder="Désignation" aria-label={`Désignation ligne ${index + 1}`} />
                <select className="form-input sm:col-span-2" value={ligne.nature} onChange={(e) => modifierLigne(index, 'nature', e.target.value as NatureLigne)} aria-label={`Nature ligne ${index + 1}`}>
                  <option value="PRESTATION">Prestation</option>
                  <option value="ARTICLE">Article</option>
                </select>
                <input required inputMode="decimal" className="form-input sm:col-span-1" value={ligne.quantite} onChange={(e) => modifierLigne(index, 'quantite', e.target.value)} placeholder="Qté" aria-label={`Quantité ligne ${index + 1}`} />
                <input required inputMode="decimal" className="form-input sm:col-span-2" value={ligne.prixUnitaireHt} onChange={(e) => modifierLigne(index, 'prixUnitaireHt', e.target.value)} placeholder="PU HT" aria-label={`Prix unitaire HT ligne ${index + 1}`} />
                <input required inputMode="decimal" className="form-input sm:col-span-1" value={ligne.tauxTva} onChange={(e) => modifierLigne(index, 'tauxTva', e.target.value)} placeholder="TVA %" aria-label={`TVA ligne ${index + 1}`} />
                <button type="button" className="btn btn-secondary sm:col-span-2" disabled={lignes.length === 1} onClick={() => supprimerLigne(index)} title={lignes.length === 1 ? 'Une facture doit conserver au moins une ligne' : 'Supprimer cette ligne'}>
                  <Trash2 size={16} /> Supprimer
                </button>
              </div>
            ))}
          </section>
          <button className="btn btn-primary" type="submit"><Send size={16} /> Créer le brouillon</button>
        </form>
      )}

      <div className="overflow-x-auto rounded-xl border bg-white">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left text-gray-500">
            <tr><th className="p-3">Type / numéro</th><th className="p-3">Client</th><th className="p-3">Émission</th><th className="p-3">Origine</th><th className="p-3">Total TTC</th><th className="p-3">Statut</th><th className="p-3">Actions</th></tr>
          </thead>
          <tbody>
            {factures.map((facture) => (
              <tr key={facture.id} className="border-t">
                <td className="p-3"><strong>{facture.type === 'AVOIR' ? 'Avoir' : 'Facture'}</strong><br />{facture.numero || 'Brouillon'}{facture.factureOrigine?.numero && <span className="block text-xs text-gray-500">Origine : {facture.factureOrigine.numero}</span>}</td>
                <td className="p-3">{facture.client.raisonSociale}</td>
                <td className="p-3">{formatDate(facture.dateEmission)}</td>
                <td className="p-3">{facture.origine === 'HORS_AFFAIRE' ? `Hors affaire — ${facture.motifHorsAffaire || ''}` : facture.origine}</td>
                <td className="p-3">{formatMontant(facture.totalTtc)}</td>
                <td className="p-3">{facture.statut}</td>
                <td className="p-3"><div className="flex flex-wrap gap-2">
                  {facture.type === 'FACTURE' && facture.statut === 'BROUILLON' && <button className="btn btn-secondary" onClick={() => void emettre(facture)}><Send size={16} /> Émettre</button>}
                  {facture.type === 'FACTURE' && ['EMISE', 'REGLEE'].includes(facture.statut) && <button className="btn btn-secondary" onClick={() => ouvrirAvoirPartiel(facture)}><FilePlus2 size={16} /> Créer un avoir partiel</button>}
                  {facture.type === 'FACTURE' && facture.statut === 'EMISE' && <>
                    <button className="btn btn-secondary" onClick={() => void changerStatut(facture, 'regler')}><CheckCircle2 size={16} /> Marquer comme réglée</button>
                    {avoirsPartiels(facture).length
                      ? <span className="self-center text-xs text-gray-500">Annulation totale impossible : {avoirsPartiels(facture).length} avoir(s) partiel(s) déjà émis</span>
                      : <button className="btn btn-secondary" onClick={() => void changerStatut(facture, 'annuler')}><Ban size={16} /> Annuler la facture</button>}
                  </>}
                  {facture.statut !== 'BROUILLON' && <button className="btn btn-secondary" onClick={() => void telechargerDocument(facture)}><Download size={16} /> PDF</button>}
                </div></td>
              </tr>
            ))}
            {!factures.length && <tr><td colSpan={7} className="p-5 text-center text-gray-500">Aucune facture.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
