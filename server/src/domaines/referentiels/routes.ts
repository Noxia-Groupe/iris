import type { Express } from 'express';
import { prisma } from '../../db';
import { requireAuth } from '../../http/auth';
import { blockCommercialEtAssimiles, blockTechnicien } from '../../http/gardes';
import { paramId } from '../../http/requete';

export function enregistrerRoutesReferentiels(app: Express): void {
  // --- Categories & Fournisseurs ---
  // Référentiels partagés du Journal des Achats : leur tenue à jour est ouverte aux
  // CONDUCTEURS DE TRAVAUX en plus des administrateurs (ils saisissent les achats au
  // quotidien et ont besoin de créer un fournisseur ou une catégorie manquante sans
  // attendre la Direction), d'où une garde par type de compte plutôt que `requireAdmin` : le
  // commercial et le directeur, dont l'accès est en lecture, en restent exclus, comme le directeur
  // commercial, l'assistante commerciale et le comptable (décision 11, #179 ; blockCommercialEtAssimiles).
  app.get('/api/categories', requireAuth, async (req, res) => res.json(await prisma.categorie.findMany({ orderBy: { nom: 'asc' } })));
  // Un nom vide ou déjà pris est refusé avec un message, comme à la modification : sans cela,
  // la contrainte d'unicité remontait en erreur 500 et le formulaire n'en disait rien.
  app.post('/api/categories', requireAuth, blockCommercialEtAssimiles, blockTechnicien, async (req, res) => {
    const nom = typeof req.body?.nom === 'string' ? req.body.nom.trim() : '';
    if (!nom) return res.status(400).json({ error: 'Le nom de la catégorie est obligatoire.' });
    try {
      res.json(await prisma.categorie.create({ data: { nom, description: req.body.description || null } }));
    } catch (error) {
      if ((error as { code?: string })?.code === 'P2002') return res.status(409).json({ error: 'Une catégorie porte déjà ce nom.' });
      res.status(500).json({ error: 'Error creating categorie' });
    }
  });

  // Modifier une catégorie (nom, description).
  app.put('/api/categories/:id', requireAuth, blockCommercialEtAssimiles, blockTechnicien, async (req, res) => {
    try {
      const data: Record<string, unknown> = {};
      if (typeof req.body.nom === 'string' && req.body.nom.trim()) data.nom = req.body.nom.trim();
      if ('description' in req.body) data.description = req.body.description || null;
      res.json(await prisma.categorie.update({ where: { id: paramId(req) }, data }));
    } catch (error) {
      if ((error as { code?: string })?.code === 'P2002') return res.status(409).json({ error: 'Une catégorie porte déjà ce nom.' });
      res.status(500).json({ error: 'Error updating categorie' });
    }
  });

  // Supprimer une catégorie. Bloqué si des achats ou lignes de budget l'utilisent.
  app.delete('/api/categories/:id', requireAuth, blockCommercialEtAssimiles, blockTechnicien, async (req, res) => {
    try {
      const id = paramId(req);
      const achats = await prisma.achatReel.count({ where: { categorieId: id } });
      const lignes = await prisma.ligneBudgetPrevisionnel.count({ where: { categorieId: id } });
      if (achats + lignes > 0) {
        return res.status(409).json({ error: `Suppression impossible : ${achats} achat(s) et ${lignes} ligne(s) de budget utilisent cette catégorie.` });
      }
      await prisma.categorie.delete({ where: { id } });
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: 'Error deleting categorie' });
    }
  });

  app.get('/api/fournisseurs', requireAuth, async (req, res) => res.json(await prisma.fournisseur.findMany({ orderBy: { nom: 'asc' } })));
  app.post('/api/fournisseurs', requireAuth, blockCommercialEtAssimiles, blockTechnicien, async (req, res) => {
    const nom = typeof req.body?.nom === 'string' ? req.body.nom.trim() : '';
    if (!nom) return res.status(400).json({ error: 'Le nom du fournisseur est obligatoire.' });
    try {
      res.json(await prisma.fournisseur.create({ data: { nom, contact: req.body.contact || null } }));
    } catch (error) {
      if ((error as { code?: string })?.code === 'P2002') return res.status(409).json({ error: 'Un fournisseur porte déjà ce nom.' });
      res.status(500).json({ error: 'Error creating fournisseur' });
    }
  });

  // Modifier un fournisseur (nom, contact).
  app.put('/api/fournisseurs/:id', requireAuth, blockCommercialEtAssimiles, blockTechnicien, async (req, res) => {
    try {
      const data: Record<string, unknown> = {};
      if (typeof req.body.nom === 'string' && req.body.nom.trim()) data.nom = req.body.nom.trim();
      if ('contact' in req.body) data.contact = req.body.contact || null;
      res.json(await prisma.fournisseur.update({ where: { id: paramId(req) }, data }));
    } catch (error) {
      if ((error as { code?: string })?.code === 'P2002') return res.status(409).json({ error: 'Un fournisseur porte déjà ce nom.' });
      res.status(500).json({ error: 'Error updating fournisseur' });
    }
  });

  // Supprimer un fournisseur. Bloqué si des achats ou coûts intervention y sont rattachés (historique préservé).
  app.delete('/api/fournisseurs/:id', requireAuth, blockCommercialEtAssimiles, blockTechnicien, async (req, res) => {
    try {
      const id = paramId(req);
      const usedAchats = await prisma.achatReel.count({ where: { fournisseurId: id } });
      const usedCoutsAchats = await prisma.coutInterventionAchat.count({ where: { fournisseurId: id } });
      const usedTotal = usedAchats + usedCoutsAchats;
      if (usedTotal > 0) {
        return res.status(409).json({ error: `Suppression impossible : ${usedTotal} écriture(s) sont rattachées à ce fournisseur.` });
      }
      await prisma.fournisseur.delete({ where: { id } });
      res.json({ success: true });
    } catch (error) {
      if ((error as { code?: string })?.code === 'P2003') return res.status(409).json({ error: 'Suppression impossible : ce fournisseur vient d’être rattaché à une écriture.' });
      res.status(500).json({ error: 'Error deleting fournisseur' });
    }
  });
}
