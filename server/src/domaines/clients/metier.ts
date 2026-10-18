const EMAIL_SIMPLE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function optionalClientText(value: unknown, field: string, max = 500): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > max) throw new Error(`Champ client invalide : ${field}`);
  return value.trim() || null;
}
function optionalClientEmail(value: unknown): string | null {
  const email = optionalClientText(value, 'email', 254);
  if (email && !EMAIL_SIMPLE.test(email)) throw new Error('Champ client invalide : email');
  return email?.toLowerCase() || null;
}
function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(`Champ client invalide : ${field}`);
  return value;
}
export function clientPayload(body: Record<string, unknown>, creation = false) {
  const raisonSociale = optionalClientText(body.raisonSociale, 'raisonSociale');
  if (creation && !raisonSociale) throw new Error('La raison sociale est obligatoire.');
  // Le SIREN est saisi (et lu sur un Kbis) par groupes de trois : « 123 456 789 ». On le
  // normalise avant de le valider, sinon la mise en forme habituelle serait refusée.
  const sirenSaisi = optionalClientText(body.siren, 'siren', 20);
  const siren = sirenSaisi ? sirenSaisi.replace(/[\s.-]/g, '') : null;
  if (siren && !/^\d{9}$/.test(siren)) throw new Error('Le SIREN doit contenir 9 chiffres.');
  const data: Record<string, unknown> = {};
  if (raisonSociale !== null) data.raisonSociale = raisonSociale;
  for (const field of ['nomCommercial', 'tvaIntra', 'telephone'] as const) {
    if (body[field] !== undefined) data[field] = optionalClientText(body[field], field);
  }
  if (body.siren !== undefined) data.siren = siren;
  if (body.email !== undefined) data.email = optionalClientEmail(body.email);
  const actif = optionalBoolean(body.actif, 'actif');
  if (actif !== undefined) data.actif = actif;
  return data;
}
export function contactPayload(body: Record<string, unknown>, creation = false) {
  const nom = optionalClientText(body.nom, 'nom');
  if (creation && !nom) throw new Error('Le nom du contact est obligatoire.');
  const data: Record<string, unknown> = {};
  if (nom) data.nom = nom;
  for (const field of ['prenom', 'fonction', 'telephone'] as const) {
    if (body[field] !== undefined) data[field] = optionalClientText(body[field], field);
  }
  if (body.email !== undefined) data.email = optionalClientEmail(body.email);
  for (const field of ['principal', 'estDecisionnaire', 'estSignataire'] as const) {
    const value = optionalBoolean(body[field], field);
    if (value !== undefined) data[field] = value;
  }
  return data;
}
export function sitePayload(body: Record<string, unknown>, creation = false) {
  const required = ['nom', 'adresse', 'codePostal', 'ville'] as const;
  const data: Record<string, unknown> = {};
  for (const field of [...required, 'complementAdresse', 'pays'] as const) {
    const value = optionalClientText(body[field], field);
    if (creation && required.includes(field as any) && !value) throw new Error(`Le champ ${field} est obligatoire.`);
    if (value !== null) data[field] = value;
  }
  for (const field of ['estSiegeSocial', 'estSiteFacturation', 'estSiteIntervention', 'principal'] as const) {
    const value = optionalBoolean(body[field], field);
    if (value !== undefined) data[field] = value;
  }
  return data;
}
