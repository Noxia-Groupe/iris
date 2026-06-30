import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
dotenv.config();
const app = express();
const prisma = new PrismaClient();
const port = process.env.PORT || 3001;
app.use(cors());
app.use(express.json());
// Routes
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok' });
});
// Chantiers
app.get('/api/chantiers', async (req, res) => {
    try {
        const chantiers = await prisma.chantier.findMany();
        res.json(chantiers);
    }
    catch (error) {
        res.status(500).json({ error: 'Error fetching chantiers' });
    }
});
app.post('/api/chantiers', async (req, res) => {
    try {
        const chantier = await prisma.chantier.create({
            data: req.body,
        });
        res.json(chantier);
    }
    catch (error) {
        res.status(500).json({ error: 'Error creating chantier' });
    }
});
// Intervenants
app.get('/api/intervenants', async (req, res) => {
    try {
        const intervenants = await prisma.intervenant.findMany();
        res.json(intervenants);
    }
    catch (error) {
        res.status(500).json({ error: 'Error fetching intervenants' });
    }
});
app.post('/api/intervenants', async (req, res) => {
    try {
        const intervenant = await prisma.intervenant.create({
            data: {
                nom: req.body.nom,
                role: req.body.role,
                tauxHoraireCharge: parseFloat(req.body.tauxHoraireCharge)
            }
        });
        res.json(intervenant);
    }
    catch (error) {
        res.status(500).json({ error: 'Error creating intervenant' });
    }
});
// Categories
app.get('/api/categories', async (req, res) => {
    try {
        const categories = await prisma.categorie.findMany();
        res.json(categories);
    }
    catch (error) {
        res.status(500).json({ error: 'Error fetching categories' });
    }
});
app.post('/api/categories', async (req, res) => {
    try {
        const categorie = await prisma.categorie.create({
            data: req.body,
        });
        res.json(categorie);
    }
    catch (error) {
        res.status(500).json({ error: 'Error creating categorie' });
    }
});
// Achats
app.get('/api/achats', async (req, res) => {
    try {
        const achats = await prisma.achatReel.findMany({ include: { chantier: true, categorie: true } });
        res.json(achats);
    }
    catch (error) {
        res.status(500).json({ error: 'Error fetching achats' });
    }
});
app.post('/api/achats', async (req, res) => {
    try {
        const achat = await prisma.achatReel.create({
            data: {
                date: new Date(req.body.date).toISOString(),
                fournisseur: req.body.fournisseur,
                description: req.body.description,
                montantHT: parseFloat(req.body.montantHT),
                chantierId: req.body.chantierId,
                categorieId: req.body.categorieId
            }
        });
        res.json(achat);
    }
    catch (error) {
        res.status(500).json({ error: 'Error creating achat' });
    }
});
// Pointages
app.get('/api/heures', async (req, res) => {
    try {
        const heures = await prisma.pointageHeure.findMany({ include: { chantier: true, intervenant: true } });
        res.json(heures);
    }
    catch (error) {
        res.status(500).json({ error: 'Error fetching heures' });
    }
});
app.post('/api/heures', async (req, res) => {
    try {
        // get intervenant to know taux horaire
        const intervenant = await prisma.intervenant.findUnique({ where: { id: req.body.intervenantId } });
        if (!intervenant)
            return res.status(404).json({ error: 'Intervenant not found' });
        const heure = await prisma.pointageHeure.create({
            data: {
                date: new Date(req.body.date).toISOString(),
                intervenantId: req.body.intervenantId,
                chantierId: req.body.chantierId,
                nbrHeures: parseFloat(req.body.nbrHeures),
                tauxHoraireApplique: intervenant.tauxHoraireCharge
            }
        });
        res.json(heure);
    }
    catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error creating pointage' });
    }
});
// Dashboard Stats
app.get('/api/dashboard/stats', async (req, res) => {
    try {
        // For V1, return some dummy calculated stats or aggregate from db
        const chantiersCount = await prisma.chantier.count();
        res.json({ chantiersCount });
    }
    catch (error) {
        res.status(500).json({ error: 'Error fetching stats' });
    }
});
app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});
