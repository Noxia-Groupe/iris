import { ROLE_TECHNICIEN } from '../roles';
import { libelleMainOeuvre, mainsOeuvreProposees, type MainOeuvreResumee } from '../lib/mainOeuvre';

export function AdminReferentiels({ activeTab, isAdmin, users, intervenants, fournisseurs, categories, editRow, setEditRow, handleSubmit, editField, saveEdit, relierCompte, mainsOeuvre, rattacherMainOeuvre, deleteEntity }: {
  activeTab: string;
  isAdmin: boolean;
  users: any[];
  intervenants: any[];
  fournisseurs: any[];
  categories: any[];
  editRow: any;
  setEditRow: React.Dispatch<React.SetStateAction<any>>;
  handleSubmit: (e: React.FormEvent<HTMLFormElement>, type: string) => void;
  editField: (field: string, value: string) => void;
  saveEdit: () => void;
  relierCompte: (intervenantId: string, userId: string) => void;
  mainsOeuvre: MainOeuvreResumee[];
  rattacherMainOeuvre: (intervenantId: string, mainOeuvreId: string) => void;
  deleteEntity: (type: string, id: string, label: string) => void;
}) {
  return (
    <>
      {activeTab === 'intervenants' && isAdmin && (
        <div className="card">
          {isAdmin ? (
            <>
              <h2 className="mb-4">Ajouter un intervenant</h2>
              <form onSubmit={(e) => handleSubmit(e, 'intervenants')} className="flex flex-col sm:flex-row gap-4 items-end mb-8">
                <div className="form-group mb-0 flex-1 w-full">
                  <label className="form-label">Nom complet</label>
                  <input required name="nom" className="form-input" />
                </div>
                <div className="form-group mb-0 flex-1 w-full">
                  <label className="form-label">Rôle / Fonction</label>
                  <input required name="role" className="form-input" />
                </div>
                <div className="form-group mb-0 flex-1 w-full">
                  <label className="form-label">Taux Horaire Chargé (€/h)</label>
                  <input required type="number" step="0.1" name="tauxHoraireCharge" className="form-input" />
                </div>
                <button className="btn btn-primary w-full sm:w-auto">Enregistrer</button>
              </form>
            </>
          ) : (
            <div className="mb-8 p-4 bg-yellow-50 text-yellow-800 rounded">
              <p>La création et la modification des intervenants et de leurs taux horaires sont réservées à la Direction.</p>
            </div>
          )}

          <h3 className="mb-4">Liste des Intervenants</h3>
          <div className="overflow-x-auto">
            <table style={{width: '100%', minWidth: '760px', textAlign: 'left', borderCollapse: 'collapse'}}>
              <thead>
                <tr style={{borderBottom: '1px solid var(--color-border)'}}>
                  <th style={{padding: '8px'}}>Nom</th>
                  <th style={{padding: '8px'}}>Rôle / Fonction</th>
                  {isAdmin && <th style={{padding: '8px'}}>Compte technicien</th>}
                  {isAdmin && <th style={{padding: '8px'}}>Main d’œuvre (prix de vente)</th>}
                  {isAdmin && <th style={{padding: '8px'}}>Coût Horaire (€/h)</th>}
                  {isAdmin && <th style={{padding: '8px', textAlign: 'right'}}>Actions</th>}
                </tr>
              </thead>
              <tbody>
                {intervenants.map(i => {
                  const isEditing = editRow?.type === 'intervenant' && editRow.id === i.id;
                  return (
                    <tr key={i.id} style={{borderBottom: '1px solid #eee'}}>
                      <td style={{padding: '8px'}}>
                        {isEditing
                          ? <input className="form-input" value={editRow.nom} onChange={e => editField('nom', e.target.value)} />
                          : <strong>{i.nom}</strong>}
                      </td>
                      <td style={{padding: '8px'}} className="text-muted">
                        {isEditing
                          ? <input className="form-input" value={editRow.role} onChange={e => editField('role', e.target.value)} />
                          : i.role}
                      </td>
                      {isAdmin && (
                        <td style={{padding: '8px'}}>
                          {/* Comptes proposés : techniciens actifs reliés à aucune autre fiche, plus le
                              compte déjà relié (même s'il a changé de type ou été désactivé depuis). */}
                          {/* Compte relié absent de la liste des comptes (que le serveur cache à ce demandeur) :
                              non modifiable ici, et le serveur le refuse aussi. Libellé neutre. */}
                          <select aria-label={`Compte technicien de ${i.nom}`} className="form-input" value={i.userId || ''}
                            disabled={!!i.userId && !users.some(u => u.id === i.userId)}
                            onChange={e => relierCompte(i.id, e.target.value)}>
                            <option value="">Aucun</option>
                            {i.userId && !users.some(u => u.id === i.userId) && <option value={i.userId}>Compte non modifiable ici</option>}
                            {users.filter(u => u.id === i.userId || (u.role === ROLE_TECHNICIEN && u.actif !== false && !intervenants.some(autre => autre.id !== i.id && autre.userId === u.id)))
                              .map(u => <option key={u.id} value={u.id}>{u.name}{u.id === i.userId && (u.role !== ROLE_TECHNICIEN || u.actif === false) ? ' (n’est plus technicien actif)' : ''}</option>)}
                          </select>
                        </td>
                      )}
                      {isAdmin && (
                        <td style={{padding: '8px'}}>
                          {/* Main d'œuvre du catalogue qui valorisera ses heures (prix de vente, lot suivant).
                              Proposées : les actives ; la sienne reste affichée si elle a été désactivée
                              depuis (rattachement gardé), sans pouvoir être choisie à nouveau. */}
                          <select aria-label={`Main d’œuvre de ${i.nom}`} className="form-input" value={i.mainOeuvreId || ''}
                            onChange={e => rattacherMainOeuvre(i.id, e.target.value)}>
                            <option value="">Aucune</option>
                            {mainsOeuvreProposees(mainsOeuvre, i.mainOeuvre ?? null).map(m => (
                              <option key={m.id} value={m.id} disabled={!m.actif}>{libelleMainOeuvre(m)}</option>
                            ))}
                          </select>
                        </td>
                      )}
                      {isAdmin && (
                        <td style={{padding: '8px'}}>
                          {isEditing
                            ? <input type="number" step="0.1" className="form-input" value={editRow.tauxHoraireCharge} onChange={e => editField('tauxHoraireCharge', e.target.value)} />
                            : `${i.tauxHoraireCharge} €`}
                        </td>
                      )}
                      {isAdmin && (
                        <td style={{padding: '8px', textAlign: 'right', whiteSpace: 'nowrap'}}>
                          {isEditing ? (
                            <>
                              <button type="button" onClick={saveEdit} className="text-sm px-3 py-1 bg-primary text-white font-semibold rounded">Enregistrer</button>
                              <button type="button" onClick={() => setEditRow(null)} className="ml-2 text-sm px-3 py-1 bg-gray-200 hover:bg-gray-300 text-gray-700 font-semibold rounded">Annuler</button>
                            </>
                          ) : (
                            <>
                              <button type="button" onClick={() => setEditRow({ type: 'intervenant', id: i.id, nom: i.nom, role: i.role, tauxHoraireCharge: i.tauxHoraireCharge })} className="text-sm px-3 py-1 bg-gray-200 hover:bg-gray-300 text-gray-700 font-semibold rounded">Modifier</button>
                              <button type="button" onClick={() => deleteEntity('intervenant', i.id, i.nom)} className="ml-2 text-sm px-3 py-1 bg-red-100 hover:bg-red-200 text-red-700 font-semibold rounded">Supprimer</button>
                            </>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
                {intervenants.length === 0 && (
                  <tr><td colSpan={6} className="text-muted" style={{padding: '12px', textAlign: 'center'}}>Aucun intervenant.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {activeTab === 'fournisseurs' && (
        <div className="card">
          <h2 className="mb-4">Ajouter un fournisseur</h2>
          <form onSubmit={(e) => handleSubmit(e, 'fournisseurs')} className="flex gap-4 items-end mb-8">
            <div className="form-group mb-0 flex-1">
              <label className="form-label">Nom du fournisseur</label>
              <input required name="nom" className="form-input" />
            </div>
            <div className="form-group mb-0 flex-1">
              <label className="form-label">Contact / Email (Optionnel)</label>
              <input name="contact" className="form-input" />
            </div>
            <button className="btn btn-primary">Enregistrer</button>
          </form>

          <h3 className="mb-4">Base Fournisseurs</h3>
          <div className="overflow-x-auto">
            <table style={{width: '100%', minWidth: '500px', textAlign: 'left', borderCollapse: 'collapse'}}>
              <thead>
                <tr style={{borderBottom: '1px solid var(--color-border)'}}>
                  <th style={{padding: '8px'}}>Nom</th>
                  <th style={{padding: '8px'}}>Contact</th>
                  <th style={{padding: '8px', textAlign: 'right'}}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {fournisseurs.map(f => {
                  const isEditing = editRow?.type === 'fournisseur' && editRow.id === f.id;
                  return (
                    <tr key={f.id} style={{borderBottom: '1px solid #eee'}}>
                      <td style={{padding: '8px'}}>
                        {isEditing
                          ? <input className="form-input" value={editRow.nom} onChange={e => editField('nom', e.target.value)} />
                          : <strong>{f.nom}</strong>}
                      </td>
                      <td style={{padding: '8px'}} className="text-muted">
                        {isEditing
                          ? <input className="form-input" value={editRow.contact || ''} onChange={e => editField('contact', e.target.value)} />
                          : (f.contact || '—')}
                      </td>
                      <td style={{padding: '8px', textAlign: 'right', whiteSpace: 'nowrap'}}>
                        {isEditing ? (
                          <>
                            <button type="button" onClick={saveEdit} className="text-sm px-3 py-1 bg-primary text-white font-semibold rounded">Enregistrer</button>
                            <button type="button" onClick={() => setEditRow(null)} className="ml-2 text-sm px-3 py-1 bg-gray-200 hover:bg-gray-300 text-gray-700 font-semibold rounded">Annuler</button>
                          </>
                        ) : (
                          <>
                            <button type="button" onClick={() => setEditRow({ type: 'fournisseur', id: f.id, nom: f.nom, contact: f.contact || '' })} className="text-sm px-3 py-1 bg-gray-200 hover:bg-gray-300 text-gray-700 font-semibold rounded">Modifier</button>
                            <button type="button" onClick={() => deleteEntity('fournisseur', f.id, f.nom)} className="ml-2 text-sm px-3 py-1 bg-red-100 hover:bg-red-200 text-red-700 font-semibold rounded">Supprimer</button>
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {fournisseurs.length === 0 && (
                  <tr><td colSpan={3} className="text-muted" style={{padding: '12px', textAlign: 'center'}}>Aucun fournisseur.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {activeTab === 'categories' && (
        <div className="card">
          <h2 className="mb-2 text-primary-dark">Catégories d'achats</h2>
          <p className="text-sm text-muted mb-6">
            Les catégories servent à <strong>classer les achats</strong> (Journal des Achats) : matériel, location d'engins,
            sous-traitance, consommables… Elles permettent le suivi des dépenses par poste.
          </p>
          <form onSubmit={(e) => handleSubmit(e, 'categories')} className="flex flex-col sm:flex-row gap-4 items-end mb-8">
            <div className="form-group mb-0 flex-1 w-full">
              <label className="form-label">Nom de la catégorie</label>
              <input required name="nom" className="form-input" placeholder="Ex : Matériel électrique" />
            </div>
            <div className="form-group mb-0 flex-1 w-full">
              <label className="form-label">Description (optionnel)</label>
              <input name="description" className="form-input" />
            </div>
            <button className="btn btn-primary w-full sm:w-auto">Enregistrer</button>
          </form>

          <h3 className="mb-4">Liste des catégories</h3>
          <div className="overflow-x-auto">
            <table style={{width: '100%', minWidth: '500px', textAlign: 'left', borderCollapse: 'collapse'}}>
              <thead>
                <tr style={{borderBottom: '1px solid var(--color-border)'}}>
                  <th style={{padding: '8px'}}>Nom</th>
                  <th style={{padding: '8px'}}>Description</th>
                  <th style={{padding: '8px', textAlign: 'right'}}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {categories.map(cat => {
                  const isEditing = editRow?.type === 'categorie' && editRow.id === cat.id;
                  return (
                    <tr key={cat.id} style={{borderBottom: '1px solid #eee'}}>
                      <td style={{padding: '8px'}}>
                        {isEditing
                          ? <input className="form-input" value={editRow.nom} onChange={e => editField('nom', e.target.value)} />
                          : <strong>{cat.nom}</strong>}
                      </td>
                      <td style={{padding: '8px'}} className="text-muted">
                        {isEditing
                          ? <input className="form-input" value={editRow.description || ''} onChange={e => editField('description', e.target.value)} />
                          : (cat.description || '—')}
                      </td>
                      <td style={{padding: '8px', textAlign: 'right', whiteSpace: 'nowrap'}}>
                        {isEditing ? (
                          <>
                            <button type="button" onClick={saveEdit} className="text-sm px-3 py-1 bg-primary text-white font-semibold rounded">Enregistrer</button>
                            <button type="button" onClick={() => setEditRow(null)} className="ml-2 text-sm px-3 py-1 bg-gray-200 hover:bg-gray-300 text-gray-700 font-semibold rounded">Annuler</button>
                          </>
                        ) : (
                          <>
                            <button type="button" onClick={() => setEditRow({ type: 'categorie', id: cat.id, nom: cat.nom, description: cat.description || '' })} className="text-sm px-3 py-1 bg-gray-200 hover:bg-gray-300 text-gray-700 font-semibold rounded">Modifier</button>
                            <button type="button" onClick={() => deleteEntity('categorie', cat.id, cat.nom)} className="ml-2 text-sm px-3 py-1 bg-red-100 hover:bg-red-200 text-red-700 font-semibold rounded">Supprimer</button>
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {categories.length === 0 && (
                  <tr><td colSpan={3} className="text-muted" style={{padding: '12px', textAlign: 'center'}}>Aucune catégorie. Ajoutez-en une ci-dessus.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
