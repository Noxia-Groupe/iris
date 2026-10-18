import type { RefObject } from 'react';
import { isAdminRole, isSuperAdminRole, ROLE_SUPERADMIN, ROLE_TECHNICIEN } from '../roles';
import type { CurrentUser } from '../lib/droits';
import { DROITS_DEVIS, droitsApresBasculeDevis, etatDroitDevis } from '../lib/droitDevis';
import { ChoixResponsable, type CompteResume } from './ChoixResponsable';

const MESSAGE_COMPTE_SUPERADMIN = "Seul un super administrateur peut gérer un compte super administrateur.";

const DROIT_TRAVAUX_CORRECTION = 'chantiers:write';
const DROIT_TRAVAUX_ARCHIVAGE = 'chantiers:archive';
// Droits individuels qu'un technicien ne reçoit pas (miroir du serveur ; l'accès financier, lui,
// est porté par accesFinance).
const DROITS_INTERDITS_TECHNICIEN = ['devis:read', 'devis:write', DROIT_TRAVAUX_CORRECTION, DROIT_TRAVAUX_ARCHIVAGE];

export function AdminUtilisateurs({ user, isSuper, users, newUserRole, setNewUserRole, peutGererCompte, comptesParId, derniereListeOuverte, responsablesProposables, handleRoleChange, handleResponsableHierarchique, handleToggleEstCommercial, handleToggleAccesFinance, handleTogglePermission, enregistrerPermissions, handleToggleActif, handleAddUser, handleDeleteUser }: {
  user: CurrentUser | null;
  isSuper: boolean;
  users: any[];
  newUserRole: string;
  setNewUserRole: React.Dispatch<React.SetStateAction<string>>;
  peutGererCompte: (u: { role: string }) => boolean;
  comptesParId: Map<any, any>;
  derniereListeOuverte: RefObject<(() => void) | null>;
  responsablesProposables: (compteId: string) => CompteResume[];
  handleRoleChange: (userId: string, newRole: string) => void;
  handleResponsableHierarchique: (userId: string, responsableId: string) => void;
  handleToggleEstCommercial: (userId: string, current: boolean) => void;
  handleToggleAccesFinance: (userId: string, current: boolean) => void;
  handleTogglePermission: (userId: string, permissions: string[], permission: string | string[]) => void;
  enregistrerPermissions: (userId: string, suivantes: string[]) => void;
  handleToggleActif: (userId: string, userName: string, current: boolean) => void;
  handleAddUser: (e: React.FormEvent) => void;
  handleDeleteUser: (userId: string, userName: string) => void;
}) {
  return (
        <div className="card">
          <h2 className="mb-2 text-primary-dark">Gestion des Comptes Utilisateurs (SSO & Local)</h2>
          <p className="mb-6 text-sm text-gray-600">
            Cette liste est la <strong>liste blanche d'autorisation</strong> : seuls les comptes présents ici peuvent se
            connecter. Un email connu se connecte via le <strong>SSO Microsoft</strong> avec le rôle défini ci-dessous ;
            toute personne <strong>absente de la liste</strong> se voit refuser l'accès (écran « Accès refusé, contactez
            l'administrateur »). Ajoutez ci-dessous chaque personne autorisée et son rôle.
          </p>
          <p className="mb-6 text-sm text-gray-600">
            <strong>Responsable hiérarchique</strong> : un compte <strong>Responsable</strong> voit les chantiers de toute
            sa branche — ses collaborateurs directs, puis les leurs — et, si la société le laisse (onglet « Marges &amp;
            Commissions »), leur rentabilité. Un compte <strong>Directeur</strong> voit tous les chantiers et, si la
            société le laisse, leur rentabilité ; il clôture tout chantier en cours, sans rien administrer ni modifier
            d'autre sur les chantiers (seule l'administration rouvre un chantier).
          </p>

          <div className="mb-8 p-4 bg-gray-50 border rounded">
            <h3 className="mb-4 text-primary-dark">Autoriser un compte</h3>
            <form onSubmit={handleAddUser} className="grid grid-cols-1 md:grid-cols-4 gap-4 items-end">
              <div className="form-group mb-0">
                <label className="form-label">Email (Microsoft 365)</label>
                <input required type="email" name="email" placeholder="prenom.nom@societe.fr" className="form-input" />
              </div>
              <div className="form-group mb-0">
                <label className="form-label">Nom complet</label>
                <input required name="name" placeholder="Prénom Nom" className="form-input" />
              </div>
              <div className="form-group mb-0">
                <label className="form-label">Rôle d'accès</label>
                <select name="role" value={newUserRole} onChange={(e) => setNewUserRole(e.target.value)} className="form-input">
                  <option value="CONDUCTEUR_TRAVAUX">Conducteur de Travaux</option>
                  <option value="COMMERCIAL">Commercial</option>
                  <option value="ASSISTANTE_COMMERCIALE">Assistante commerciale</option>
                  <option value="TECHNICIEN">Technicien</option>
                  <option value="COMPTABLE">Comptable</option>
                  <option value="DIRECTEUR_COMMERCIAL">Directeur commercial</option>
                  <option value="RESPONSABLE">Responsable</option>
                  <option value="DIRECTEUR">Directeur</option>
                  <option value="ADMIN">Administrateur</option>
                  {/* Seul un super administrateur peut en désigner un autre. */}
                  {isSuper && <option value={ROLE_SUPERADMIN}>Super Administrateur</option>}
                </select>
              </div>
              <div className="form-group mb-0 md:col-span-2 flex flex-wrap gap-3">
                {isAdminRole(newUserRole) && (
                  <label className="flex items-center gap-2 text-sm font-medium px-3 py-2.5 bg-white border border-gray-200 rounded-lg cursor-pointer hover:bg-gray-50 transition-colors w-fit">
                    <input type="checkbox" name="estCommercial" className="w-4 h-4" />
                    Commercial (affectation aux chantiers et statistiques dans « Mes commerciaux »)
                  </label>
                )}
                {/* L'accès au Suivi financier s'accorde à n'importe quel rôle, mais seul un
                    superadmin peut le donner. */}
                {isSuper && (
                  <label className="flex items-center gap-2 text-sm font-medium px-3 py-2.5 bg-white border border-gray-200 rounded-lg cursor-pointer hover:bg-gray-50 transition-colors w-fit">
                    <input type="checkbox" name="accesFinance" className="w-4 h-4" />
                    Finance (accès au Suivi financier)
                  </label>
                )}
              </div>
              <button className="btn btn-primary w-full">Autoriser</button>
            </form>
          </div>

          <h3 className="mb-4 text-primary-dark">Comptes autorisés</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse bg-white border rounded">
              <thead>
                <tr className="bg-gray-50 text-xs uppercase text-gray-500 border-b border-gray-100">
                  <th className="px-4 py-4 font-semibold">Nom</th>
                  <th className="px-4 py-4 font-semibold">Email</th>

                  <th className="px-4 py-4 font-semibold">Rôle d'accès</th>
                  <th className="px-4 py-4 font-semibold">Responsable hiérarchique</th>
                  <th className="px-4 py-4 font-semibold">Commercial</th>
                  <th className="px-4 py-4 font-semibold">Finance</th>
                  <th className="px-4 py-4 font-semibold">Droit devis</th>
                  <th className="px-4 py-4 font-semibold">Corriger Travaux</th>
                  <th className="px-4 py-4 font-semibold">Archiver Travaux</th>
                  <th className="px-4 py-4 font-semibold">Actif</th>
                  <th className="px-4 py-4 font-semibold text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {users.map(u => {
                  const { coche: aLeDroitDevis, vientDuRole: droitDevisVientDuRole } = etatDroitDevis(u.permissions || [], u.permissionsIndividuelles || []);
                  const peutCorrigerTravaux = (u.permissions || []).includes(DROIT_TRAVAUX_CORRECTION);
                  const peutArchiverTravaux = (u.permissions || []).includes(DROIT_TRAVAUX_ARCHIVAGE);
                  const correctionVientDuRole = peutCorrigerTravaux && !(u.permissionsIndividuelles || []).includes(DROIT_TRAVAUX_CORRECTION);
                  const archivageVientDuRole = peutArchiverTravaux && !(u.permissionsIndividuelles || []).includes(DROIT_TRAVAUX_ARCHIVAGE);
                  const responsableActuel = u.responsableHierarchique as CompteResume | null;
                  // Un technicien ne modifie aucune affaire et ne voit aucun montant : ni devis, ni
                  // saisie ou archivage Travaux, ni accès financier (refusés aussi par le serveur).
                  // Ceux enregistrés avant (règle, changement de type) restent affichés « Sans
                  // effet » : ils reprennent effet s'il change de type, et peuvent seulement être retirés.
                  const estTechnicien = u.role === ROLE_TECHNICIEN;
                  const individuels = u.permissionsIndividuelles || [];
                  const sansEffet = (droits: string[]) => estTechnicien && droits.some((droit) => DROITS_INTERDITS_TECHNICIEN.includes(droit) && individuels.includes(droit));
                  const devisSansEffet = sansEffet(DROITS_DEVIS);
                  const correctionSansEffet = sansEffet([DROIT_TRAVAUX_CORRECTION]);
                  const archivageSansEffet = sansEffet([DROIT_TRAVAUX_ARCHIVAGE]);
                  const MESSAGE_TECHNICIEN = 'Ce droit ne s’accorde pas à un compte technicien.';
                  const titreTechnicien = (enregistre: boolean) => enregistre
                    ? `Enregistré, sans effet pour un compte technicien ; il reprend effet si le compte change de type.${isSuper ? ' Décocher pour le retirer.' : ''}`
                    : MESSAGE_TECHNICIEN;
                  // Le retrait ne porte que sur les droits interdits enregistrés : clients:read (annuaire),
                  // permis au technicien par décision de Nelson, est conservé avec le droit devis.
                  const retirer = (droits: string[]) => handleTogglePermission(u.id, individuels, droits.filter((droit) => DROITS_INTERDITS_TECHNICIEN.includes(droit) && individuels.includes(droit)));
                  return (
                  <tr key={u.id} className={`hover:bg-gray-50 transition-colors ${u.actif === false ? 'bg-gray-50 text-gray-400' : ''}`}>
                    <td className="px-4 py-4 font-bold text-gray-800">{u.name}</td>
                    <td className="px-4 py-4 text-sm text-gray-600">{u.email}</td>

                    <td className="px-4 py-4">
                      {/* min-w : avec l'ajout des colonnes Commercial/Finance/Actif, le
                          select se comprimait au point de n'afficher que « Cor… ». */}
                      <select
                        className={`form-input py-1 px-3 text-sm font-semibold rounded min-w-[11rem] ${isAdminRole(u.role) ? 'bg-primary/10 text-primary border-primary' : 'bg-gray-100 text-gray-600 border-gray-300'}`}
                        value={u.role}
                        onChange={(e) => handleRoleChange(u.id, e.target.value)}
                        disabled={u.email === user?.email || !peutGererCompte(u)}
                        title={u.email === user?.email
                          ? "Vous ne pouvez pas modifier votre propre rôle."
                          : !peutGererCompte(u)
                            ? MESSAGE_COMPTE_SUPERADMIN
                            : 'Modifier le rôle'}
                      >
                        <option value="CONDUCTEUR_TRAVAUX">Conducteur de Travaux</option>
                        <option value="COMMERCIAL">Commercial</option>
                  <option value="ASSISTANTE_COMMERCIALE">Assistante commerciale</option>
                  <option value="TECHNICIEN">Technicien</option>
                  <option value="COMPTABLE">Comptable</option>
                  <option value="DIRECTEUR_COMMERCIAL">Directeur commercial</option>
                  <option value="RESPONSABLE">Responsable</option>
                  <option value="DIRECTEUR">Directeur</option>
                        <option value="ADMIN">Administrateur</option>
                        {isSuper && <option value={ROLE_SUPERADMIN}>Super Administrateur</option>}
                      </select>
                    </td>
                    <td className="px-4 py-4">
                      <ChoixResponsable
                        compte={u}
                        responsableActuel={responsableActuel}
                        responsableDesactive={!!responsableActuel && comptesParId.get(responsableActuel.id)?.actif === false}
                        desactive={!peutGererCompte(u)}
                        titre={!peutGererCompte(u) ? MESSAGE_COMPTE_SUPERADMIN : 'Rattacher ce compte à son responsable direct'}
                        proposables={responsablesProposables}
                        onChoix={handleResponsableHierarchique}
                        derniereOuverte={derniereListeOuverte}
                      />
                    </td>
                    <td className="px-4 py-4">
                      {isAdminRole(u.role) ? (
                        <label className="flex items-center gap-2 cursor-pointer w-fit">
                          <input
                            type="checkbox"
                            checked={!!u.estCommercial}
                            disabled={!peutGererCompte(u)}
                            onChange={() => handleToggleEstCommercial(u.id, !!u.estCommercial)}
                            className="w-4 h-4"
                          />
                          <span className="text-xs text-gray-500">{u.estCommercial ? 'Oui' : 'Non'}</span>
                        </label>
                      ) : (
                        <span className="text-gray-300">—</span>
                      )}
                    </td>
                    {/* Accès au Suivi financier : ouvert à tous les rôles, réglable par le
                        seul superadmin — un administrateur le voit sans pouvoir le changer. */}
                    <td className="px-4 py-4">
                      {isSuperAdminRole(u.role) ? (
                        <span className="text-xs text-gray-500" title="Un super administrateur accède toujours au suivi financier.">Oui (par défaut)</span>
                      ) : (
                        <label className={`flex items-center gap-2 w-fit ${isSuper ? 'cursor-pointer' : 'cursor-not-allowed'}`}>
                          <input
                            type="checkbox"
                            aria-label={`Accès financier — ${u.name}`}
                            checked={!!u.accesFinance}
                            disabled={!isSuper || (estTechnicien && !u.accesFinance)}
                            onChange={() => handleToggleAccesFinance(u.id, !!u.accesFinance)}
                            className="w-4 h-4"
                            title={estTechnicien
                              ? titreTechnicien(!!u.accesFinance)
                              : isSuper
                                ? 'Autoriser ce compte à consulter le Suivi financier'
                                : "Seul un super administrateur peut accorder l'accès au suivi financier."}
                          />
                          <span className="text-xs text-gray-500">{u.accesFinance ? (estTechnicien ? 'Sans effet' : 'Oui') : 'Non'}</span>
                        </label>
                      )}
                    </td>
                    <td className="px-4 py-4">
                      <label className={`flex items-center gap-2 w-fit ${isSuper ? 'cursor-pointer' : 'cursor-not-allowed'}`}>
                        <input type="checkbox" aria-label={`Droit devis — ${u.name}`} checked={estTechnicien ? devisSansEffet : aLeDroitDevis} disabled={!isSuper || droitDevisVientDuRole || (estTechnicien && !devisSansEffet)} onChange={() => (estTechnicien ? retirer(DROITS_DEVIS) : enregistrerPermissions(u.id, droitsApresBasculeDevis(individuels, aLeDroitDevis)))} className="w-4 h-4" title={estTechnicien ? titreTechnicien(devisSansEffet) : droitDevisVientDuRole ? 'Droit accordé par le type de compte' : 'Autoriser la consultation et la création de devis'} />
                        <span className="text-xs text-gray-500">{devisSansEffet ? 'Sans effet' : 'Droit devis'}</span>
                      </label>
                    </td>
                    <td className="px-4 py-4">
                      <input type="checkbox" aria-label={`Corriger Travaux — ${u.name}`} checked={estTechnicien ? correctionSansEffet : peutCorrigerTravaux} disabled={!isSuper || correctionVientDuRole || (estTechnicien && !correctionSansEffet)} onChange={() => (estTechnicien ? retirer([DROIT_TRAVAUX_CORRECTION]) : handleTogglePermission(u.id, individuels, DROIT_TRAVAUX_CORRECTION))} className="w-4 h-4" title={estTechnicien ? titreTechnicien(correctionSansEffet) : correctionVientDuRole ? 'Droit accordé par le type de compte' : 'Autoriser la saisie et la correction Travaux'} />
                      {correctionSansEffet && <span className="ml-2 text-xs text-gray-500">Sans effet</span>}
                    </td>
                    <td className="px-4 py-4">
                      <input type="checkbox" aria-label={`Archiver Travaux — ${u.name}`} checked={estTechnicien ? archivageSansEffet : peutArchiverTravaux} disabled={!isSuper || archivageVientDuRole || (estTechnicien && !archivageSansEffet)} onChange={() => (estTechnicien ? retirer([DROIT_TRAVAUX_ARCHIVAGE]) : handleTogglePermission(u.id, individuels, DROIT_TRAVAUX_ARCHIVAGE))} className="w-4 h-4" title={estTechnicien ? titreTechnicien(archivageSansEffet) : archivageVientDuRole ? 'Droit accordé par le type de compte' : 'Autoriser l’archivage des écritures Travaux'} />
                      {archivageSansEffet && <span className="ml-2 text-xs text-gray-500">Sans effet</span>}
                    </td>
                    {/* Compte actif : décocher vaut départ de l'entreprise. La connexion est
                        refusée et le compte sort des listes d'attribution, mais son
                        historique de chantiers reste intact (à l'inverse de « Révoquer »). */}
                    <td className="px-4 py-4">
                      <label className={`flex items-center gap-2 w-fit ${u.email === user?.email || !peutGererCompte(u) ? 'cursor-not-allowed' : 'cursor-pointer'}`}>
                        <input
                          type="checkbox"
                          checked={u.actif !== false}
                          disabled={u.email === user?.email || !peutGererCompte(u)}
                          onChange={() => handleToggleActif(u.id, u.name, u.actif !== false)}
                          className="w-4 h-4"
                          title={u.email === user?.email
                            ? 'Vous ne pouvez pas désactiver votre propre compte.'
                            : !peutGererCompte(u)
                              ? MESSAGE_COMPTE_SUPERADMIN
                              : "Décocher pour désactiver le compte (historique conservé)"}
                        />
                        <span className={`text-xs ${u.actif === false ? 'font-bold text-red-600' : 'text-gray-500'}`}>
                          {u.actif === false ? 'Désactivé' : 'Oui'}
                        </span>
                      </label>
                    </td>
                    <td className="px-4 py-4 text-right whitespace-nowrap">
                      <button
                        onClick={() => handleDeleteUser(u.id, u.name)}
                        disabled={u.email === user?.email || !peutGererCompte(u)}
                        title={u.email === user?.email
                          ? "Vous ne pouvez pas révoquer votre propre compte."
                          : !peutGererCompte(u)
                            ? MESSAGE_COMPTE_SUPERADMIN
                            : "Révoquer l'accès"}
                        className="ml-2 text-sm px-3 py-1 bg-red-100 hover:bg-red-200 text-red-700 font-semibold rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        Révoquer
                      </button>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
  );
}
