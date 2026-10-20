export function AdminModules({ planningActif, modulesMessage, handleModulePlanning }: {
  planningActif: boolean | null;
  modulesMessage: string;
  handleModulePlanning: (actif: boolean) => void;
}) {
  return (
        <div className="card">
          <h2 className="mb-2 text-primary-dark">Modules de l'application</h2>
          <p className="text-sm text-muted mb-6">
            Réglages réservés au <strong>super administrateur</strong>. Désactiver un module le fait disparaître de
            l'application pour <strong>tous les autres comptes, administrateurs compris</strong> : le menu n'apparaît
            plus et les pages correspondantes deviennent inaccessibles. <strong>Aucune donnée n'est supprimée</strong> —
            tout est restitué à l'identique dès la réactivation. Vous conservez, vous, l'accès au module pour le
            préparer ou le consulter pendant sa désactivation.
          </p>

          {modulesMessage && (
            <div className="mb-4 p-3 bg-blue-50 text-blue-800 rounded text-sm">{modulesMessage}</div>
          )}

          {planningActif === null ? (
            <p className="text-sm text-gray-400 italic">Chargement des modules...</p>
          ) : (
            <div className="p-4 rounded border bg-gray-50 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div>
                <div className="font-bold text-gray-800">Planning d'intervention</div>
                <div className="text-sm text-muted mt-0.5">
                  Affectation des techniciens à la semaine, types d'événements et lien de partage public.
                </div>
                <div className="text-sm mt-2">
                  État actuel :{' '}
                  <strong className={planningActif ? 'text-green-700' : 'text-red-700'}>
                    {planningActif ? 'Activé (visible par tous les comptes)' : 'Désactivé (visible du super administrateur uniquement)'}
                  </strong>
                </div>
              </div>
              <div className="flex gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => handleModulePlanning(true)}
                  disabled={planningActif}
                  className={`btn ${planningActif ? 'bg-white' : 'btn-primary'} disabled:opacity-40 disabled:cursor-not-allowed`}
                >
                  Activer
                </button>
                <button
                  type="button"
                  onClick={() => handleModulePlanning(false)}
                  disabled={!planningActif}
                  className="btn bg-red-100 hover:bg-red-200 text-red-700 font-semibold disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Désactiver
                </button>
              </div>
            </div>
          )}

          <p className="text-xs text-muted mt-4">
            Note : le <strong>lien de partage public</strong> du planning (destiné aux techniciens sans compte) garde
            son propre interrupteur, dans le module Planning — désactivez-le séparément si vous souhaitez aussi couper
            cet accès.
          </p>
        </div>
  );
}
