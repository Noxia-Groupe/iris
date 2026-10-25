import { AvisSansPlanCommercial } from './AvisSansPlanCommercial';
import { EditeurBareme } from './EditeurBareme';
import { ReglageTempsPasse } from './ReglageTempsPasse';

export function AdminMarges({ isSuper, parametres, setParametres, remuneration, setRemuneration, erreurRemuneration, messageRemuneration, enregistrerRemuneration, handleParamsSubmit }: {
  isSuper: boolean;
  parametres: any;
  setParametres: React.Dispatch<React.SetStateAction<any>>;
  remuneration: any;
  setRemuneration: React.Dispatch<React.SetStateAction<any>>;
  erreurRemuneration: string;
  messageRemuneration: string;
  enregistrerRemuneration: (e: React.FormEvent) => void;
  handleParamsSubmit: (e: React.FormEvent) => void;
}) {
  return (
        <>
          <div className="card mb-4">
            <h2 className="mb-2 text-primary-dark">Paramètres de la Marge Commerciale</h2>
            <p className="text-sm text-muted mb-4">
              Réglages globaux. La marge commerciale est calculée côté serveur ; elle n'est montrée qu'aux
              administrateurs et aux destinataires choisis ci-dessous.
            </p>
            {/* Formulaire non contrôlé : il n'apparaît qu'une fois les paramètres chargés, sinon une
                saisie faite avant leur arrivée serait effacée par le remplissage des valeurs. */}
            {!parametres ? <p className="text-sm text-gray-400">Chargement des paramètres…</p> : (
            <form onSubmit={handleParamsSubmit} className="space-y-4">
              <label className="flex items-center gap-2 cursor-pointer w-fit">
                <input type="checkbox" name="margeCommercialeActive" defaultChecked={parametres?.margeCommercialeActive ?? true} className="w-4 h-4" />
                <span className="text-sm font-semibold text-gray-700">Activer l'affichage et le calcul de la marge commerciale</span>
              </label>
              {/* Politique d'acompte de la société. Elle ne vit pas dans le code : la
                  changer ici suffit. Elle ne s'applique qu'aux devis émis ENSUITE — chaque
                  devis fige son taux à l'émission, comme les barèmes de commission. */}
              <label className="flex items-center gap-3 w-fit">
                <span className="text-sm font-semibold text-gray-700">Taux d'acompte proposé par défaut</span>
                <input
                  type="number" name="tauxAcompteDefaut" min="0" max="100" step="0.01"
                  defaultValue={parametres?.tauxAcompteDefaut ?? 30}
                  className="form-input w-28" style={{ margin: 0 }}
                  title="Proposé à la création d'un devis exigeant un acompte. Sans effet sur les devis déjà émis."
                />
                <span className="text-sm text-gray-500">% du TTC</span>
              </label>
              {/* Alertes du suivi des chantiers (liste et tableau de bord). Vider le délai désactive
                  l'alerte sans saisie ; vider le seuil le retire, une marge estimée négative restant signalée. */}
              <fieldset className="border border-gray-100 rounded-lg p-4 space-y-3">
                <legend className="text-sm font-bold text-gray-700 px-1">Alertes de suivi des chantiers</legend>
                <label className="flex flex-wrap items-center gap-3 w-fit">
                  <span className="text-sm font-semibold text-gray-700">Marge faible : alerter sous</span>
                  <input
                    type="number" name="seuilMargeFaible" min="0" max="100" step="0.01"
                    defaultValue={parametres?.seuilMargeFaible ?? ''}
                    className="form-input w-28" style={{ margin: 0 }}
                    aria-label="Seuil de marge faible en pourcentage"
                  />
                  <span className="text-sm text-gray-500">% de marge estimée en fin de chantier</span>
                </label>
                <label className="flex flex-wrap items-center gap-3 w-fit">
                  <span className="text-sm font-semibold text-gray-700">Chantier sans saisie : alerter après</span>
                  <input
                    type="number" name="joursSansSaisie" min="1" max="365" step="1"
                    defaultValue={parametres?.joursSansSaisie ?? ''}
                    className="form-input w-28" style={{ margin: 0 }}
                    aria-label="Nombre de jours sans saisie"
                  />
                  <span className="text-sm text-gray-500">jours sans achat ni heure</span>
                </label>
                <p className="text-xs text-gray-500 m-0">
                  Vider le délai désactive l’alerte « sans saisie ». Vider le seuil retire le seuil, mais une marge estimée
                  négative reste signalée. La marge estimée compte, pour chaque poste, le plus élevé du
                  réel déjà dépensé et du coût attendu : heures vendues au coût horaire moyen réellement appliqué, matériel
                  vendu au ratio d’achat observé sur les chantiers terminés (au prix de vente tant qu’aucun n’est terminé).
                </p>
              </fieldset>
              {/* Destinataires de la rentabilité de chaque chantier : montant vendu global, marge du jour,
                  marge estimée, alertes « en perte » et « marge faible », facturation de la fiche, sur la
                  liste, le tableau de bord et la fiche. Les dépassements, l'absence de saisie et les budgets
                  par poste restent visibles de tous ceux qui voient le chantier, sauf du technicien, qui ne
                  reçoit aucun montant (cf. voitMontantsChantier côté serveur). */}
              <fieldset className="border border-gray-100 rounded-lg p-4 space-y-2">
                <legend className="text-sm font-bold text-gray-700 px-1">Qui suit la rentabilité des chantiers&nbsp;?</legend>
                <p className="text-xs text-gray-500 m-0">
                  Montant vendu global, marge du jour, marge estimée, alertes « en perte » ou « marge faible » et
                  facturation de la fiche. Les administrateurs les voient toujours. Les budgets par poste (matériel,
                  main-d’œuvre, heures) restent affichés pour suivre les dépassements : ils permettent d’en déduire le vendu,
                  donc la marge du jour. Exception : les techniciens ne voient aucun montant, ni les alertes de dépassement.
                </p>
                <label className="flex items-center gap-2 cursor-pointer w-fit">
                  <input type="checkbox" name="rentabiliteConducteur" defaultChecked={parametres?.rentabiliteConducteur ?? true} className="w-4 h-4" />
                  <span className="text-sm text-gray-700">Le conducteur (ou responsable) chargé du chantier</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer w-fit">
                  <input type="checkbox" name="rentabiliteHierarchie" defaultChecked={parametres?.rentabiliteHierarchie ?? true} className="w-4 h-4" />
                  <span className="text-sm text-gray-700">Ses responsables hiérarchiques, à tous les niveaux</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer w-fit">
                  <input type="checkbox" name="rentabiliteDirecteurs" defaultChecked={parametres?.rentabiliteDirecteurs ?? true} className="w-4 h-4" />
                  <span className="text-sm text-gray-700">Les directeurs (tous les chantiers)</span>
                </label>
                <p className="text-xs text-gray-500 m-0">
                  La chaîne hiérarchique se règle dans l’onglet « Utilisateurs », compte par compte.
                </p>
              </fieldset>
              <button className="btn btn-primary">Enregistrer</button>
            </form>)}
          </div>

          {/* Pas du temps passé (devis au temps passé) : son propre formulaire, qui n'envoie que ce réglage. */}
          {parametres && <ReglageTempsPasse
            pasTempsPasseMinutes={parametres.pasTempsPasseMinutes ?? null}
            onEnregistre={(pas) => setParametres((actuels: any) => ({ ...actuels, pasTempsPasseMinutes: pas }))}
          />}

          {/* Règles de rémunération commerciale : stockées en base, éditables par un
              superadmin. Elles étaient auparavant écrites en dur dans le serveur, ce qui
              imposait un redéploiement pour changer un taux et livrait à chaque client les
              barèmes d'une autre société. Sans plan commercial, le serveur ne les applique
              plus (décision du 17-10-2026) : seul le libellé du barème réduit sert encore. */}
          <div className="card mb-4">
            <h2 className="mb-2 text-primary-dark">Rémunération commerciale</h2>
            <AvisSansPlanCommercial className="mb-4">
              Ces règles générales ne sont plus appliquées : un commercial sans plan commercial ne touche ni
              commission ni prime, et aucun plan n'est encore attribué. Elles restent enregistrables, sans effet sur
              aucun montant ; seul le libellé du barème réduit reste affiché sur les chantiers.
            </AvisSansPlanCommercial>
            <p className="text-sm text-muted mb-4">
              Non appliqués tant qu'aucun plan commercial n'est attribué : un barème progressif sur la marge cumulée
              du mois (chaque tranche à son propre taux), un second barème pour les chantiers cochés « barème
              réduit », des objectifs et des primes mensuels.
              {!isSuper && <> Seul un super administrateur peut modifier ces règles.</>}
            </p>
            {remuneration ? (
              <form onSubmit={enregistrerRemuneration} className="space-y-5">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <EditeurBareme
                    titre="Barème standard"
                    tranches={remuneration.baremeStandard}
                    modifiable={isSuper}
                    onChange={(t) => setRemuneration({ ...remuneration, baremeStandard: t })}
                  />
                  <EditeurBareme
                    titre={remuneration.libelleBaremeReduit || 'Barème réduit'}
                    tranches={remuneration.baremeReduit}
                    modifiable={isSuper}
                    accent
                    onChange={(t) => setRemuneration({ ...remuneration, baremeReduit: t })}
                  />
                </div>

                <div className="form-group">
                  <label className="form-label">Libellé du barème réduit (affiché sur les chantiers et les écrans commerciaux)</label>
                  <input
                    className="form-input"
                    value={remuneration.libelleBaremeReduit ?? ''}
                    disabled={!isSuper}
                    onChange={(e) => setRemuneration({ ...remuneration, libelleBaremeReduit: e.target.value })}
                    placeholder="Ex. Dossier apporté par la société"
                  />
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {([
                    ['objectifCaMensuel', 'Objectif de CA mensuel (€)'],
                    ['primeObjectifCa', 'Prime si objectif CA atteint (€)'],
                    ['objectifMargeMensuel', 'Objectif de marge mensuel (€)'],
                    ['primeObjectifMarge', 'Prime si objectif marge atteint (€)'],
                    ['primeSuiviAdministratif', 'Prime de suivi administratif (€)'],
                  ] as const).map(([cle, libelle]) => (
                    <div className="form-group" key={cle}>
                      <label className="form-label">{libelle}</label>
                      <input
                        type="number" min="0" step="any" className="form-input"
                        value={remuneration[cle] ?? 0}
                        disabled={!isSuper}
                        onChange={(e) => setRemuneration({ ...remuneration, [cle]: e.target.value })}
                      />
                    </div>
                  ))}
                </div>

                {erreurRemuneration && <p className="text-sm text-red-600">{erreurRemuneration}</p>}
                {messageRemuneration && <p className="text-sm text-emerald-700">{messageRemuneration}</p>}
                {isSuper && <button className="btn btn-primary">Enregistrer les règles</button>}
              </form>
            ) : (
              <p className="text-sm text-gray-400 italic">Chargement des règles…</p>
            )}
          </div>

        </>
  );
}
