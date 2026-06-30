"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const dotenv_1 = __importDefault(require("dotenv"));
const client_1 = require("@prisma/client");
const multer_1 = __importDefault(require("multer"));
const archiver_1 = __importDefault(require("archiver"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const genai_1 = require("@google/genai");
dotenv_1.default.config();
const ai = process.env.GEMINI_API_KEY ? new genai_1.GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) : null;
const app = (0, express_1.default)();
const prisma = new client_1.PrismaClient();
const port = process.env.PORT || 3001;
app.use((0, cors_1.default)());
app.use(express_1.default.json());
// Configuration Multer pour le stockage local des photos
const uploadDir = path_1.default.join(__dirname, 'uploads');
if (!fs_1.default.existsSync(uploadDir)) {
    fs_1.default.mkdirSync(uploadDir, { recursive: true });
}
// Servir statiquement le dossier uploads
app.use('/uploads', express_1.default.static(uploadDir));
const storage = multer_1.default.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path_1.default.extname(file.originalname));
    }
});
const upload = (0, multer_1.default)({ storage });
// Routes de base
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
// Configuration globale
app.get('/api/config', (req, res) => {
    res.json({ aiEnabled: !!process.env.GEMINI_API_KEY });
});
// Chantiers
app.get('/api/chantiers', async (req, res) => {
    try {
        const chantiers = await prisma.chantier.findMany({
            include: {
                responsable: true,
                achats: true,
                pointages: true,
                photos: true,
                commissionnement: true
            }
        });
        res.json(chantiers);
    }
    catch (error) {
        res.status(500).json({ error: 'Error fetching chantiers' });
    }
});
app.post('/api/chantiers', async (req, res) => {
    try {
        const chantier = await prisma.chantier.create({
            data: {
                nom: req.body.nom,
                client: req.body.client,
                numeroDevis: req.body.numeroDevis,
                dateDebut: new Date(req.body.dateDebut).toISOString(),
                dateFin: req.body.dateFin ? new Date(req.body.dateFin).toISOString() : null,
                budgetGlobalVendu: parseFloat(req.body.budgetGlobalVendu) || 0,
                budgetMaterielVendu: parseFloat(req.body.budgetMaterielVendu) || 0,
                budgetMainOeuvreVendu: parseFloat(req.body.budgetMainOeuvreVendu) || 0,
                heuresVendues: parseFloat(req.body.heuresVendues) || 0,
                responsableId: req.body.responsableId || null,
                statut: req.body.statut || "EN_COURS"
            },
        });
        // Create default commissionnement
        await prisma.commissionnement.create({
            data: { chantierId: chantier.id }
        });
        res.json(chantier);
    }
    catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error creating chantier' });
    }
});
// Update Chantier (pour le statut)
app.patch('/api/chantiers/:id', async (req, res) => {
    try {
        const chantier = await prisma.chantier.update({
            where: { id: req.params.id },
            data: req.body
        });
        res.json(chantier);
    }
    catch (error) {
        res.status(500).json({ error: 'Error updating chantier' });
    }
});
// Users
app.get('/api/users', async (req, res) => {
    try {
        let users = await prisma.user.findMany();
        if (users.length === 0) {
            await prisma.user.create({ data: { email: 'jean@noxia.com', name: 'Jean Dupont', role: 'CONDUCTEUR_TRAVAUX' } });
            await prisma.user.create({ data: { email: 'marie@noxia.com', name: 'Marie Martin', role: 'ADMIN' } });
            users = await prisma.user.findMany();
        }
        res.json(users);
    }
    catch (error) {
        res.status(500).json({ error: 'Error fetching users' });
    }
});
// Intervenants
app.get('/api/intervenants', async (req, res) => {
    try {
        res.json(await prisma.intervenant.findMany());
    }
    catch (error) {
        res.status(500).json({ error: 'Error fetching intervenants' });
    }
});
app.post('/api/intervenants', async (req, res) => {
    try {
        res.json(await prisma.intervenant.create({
            data: {
                nom: req.body.nom,
                role: req.body.role,
                tauxHoraireCharge: parseFloat(req.body.tauxHoraireCharge)
            }
        }));
    }
    catch (error) {
        res.status(500).json({ error: 'Error creating intervenant' });
    }
});
// Categories & Fournisseurs
app.get('/api/categories', async (req, res) => res.json(await prisma.categorie.findMany()));
app.post('/api/categories', async (req, res) => res.json(await prisma.categorie.create({ data: req.body })));
app.get('/api/fournisseurs', async (req, res) => res.json(await prisma.fournisseur.findMany()));
app.post('/api/fournisseurs', async (req, res) => res.json(await prisma.fournisseur.create({ data: req.body })));
// Achats
app.get('/api/achats', async (req, res) => {
    try {
        res.json(await prisma.achatReel.findMany({ include: { chantier: true, categorie: true, fournisseur: true } }));
    }
    catch (error) {
        res.status(500).json({ error: 'Error fetching achats' });
    }
});
app.post('/api/achats', async (req, res) => {
    try {
        res.json(await prisma.achatReel.create({
            data: {
                date: new Date(req.body.date).toISOString(),
                fournisseurId: req.body.fournisseurId,
                numeroFacture: req.body.numeroFacture || null,
                description: req.body.description,
                montantHT: parseFloat(req.body.montantHT),
                chantierId: req.body.chantierId,
                categorieId: req.body.categorieId
            }
        }));
    }
    catch (error) {
        res.status(500).json({ error: 'Error creating achat' });
    }
});
// Pointages (Heures)
app.get('/api/heures', async (req, res) => {
    try {
        res.json(await prisma.pointageHeure.findMany({ include: { chantier: true, intervenant: true } }));
    }
    catch (error) {
        res.status(500).json({ error: 'Error fetching heures' });
    }
});
app.post('/api/heures', async (req, res) => {
    try {
        const intervenant = await prisma.intervenant.findUnique({ where: { id: req.body.intervenantId } });
        if (!intervenant)
            return res.status(404).json({ error: 'Intervenant not found' });
        res.json(await prisma.pointageHeure.create({
            data: {
                date: new Date(req.body.date).toISOString(),
                intervenantId: req.body.intervenantId,
                chantierId: req.body.chantierId,
                nbrHeures: parseFloat(req.body.nbrHeures),
                tauxHoraireApplique: intervenant.tauxHoraireCharge,
                commentaire: req.body.commentaire || null
            }
        }));
    }
    catch (error) {
        res.status(500).json({ error: 'Error creating pointage' });
    }
});
// Photos Upload & Purge
app.post('/api/chantiers/:id/photos', upload.single('photo'), async (req, res) => {
    try {
        if (!req.file)
            return res.status(400).json({ error: 'No file uploaded' });
        // On limitera côté front ou middleware plus tard si besoin.
        // @ts-ignore
        const url = `/uploads/${req.file.filename}`;
        const photo = await prisma.photoChantier.create({
            data: {
                url,
                // @ts-ignore
                legende: req.body.legende || '',
                chantierId: req.params.id,
                auteurId: req.body.auteurId || null
            }
        });
        res.json(photo);
    }
    catch (error) {
        res.status(500).json({ error: 'Error uploading photo' });
    }
});
app.delete('/api/chantiers/:id/photos/purge', async (req, res) => {
    try {
        const photos = await prisma.photoChantier.findMany({ where: { chantierId: req.params.id } });
        for (const p of photos) {
            const filePath = path_1.default.join(__dirname, p.url);
            if (fs_1.default.existsSync(filePath))
                fs_1.default.unlinkSync(filePath);
        }
        await prisma.photoChantier.deleteMany({ where: { chantierId: req.params.id } });
        res.json({ message: 'Purge terminée' });
    }
    catch (error) {
        res.status(500).json({ error: 'Error purging photos' });
    }
});
app.get('/api/chantiers/:id/photos/export', async (req, res) => {
    try {
        const chantier = await prisma.chantier.findUnique({ where: { id: req.params.id } });
        if (!chantier)
            return res.status(404).json({ error: 'Chantier not found' });
        const photos = await prisma.photoChantier.findMany({ where: { chantierId: req.params.id } });
        res.attachment(`photos-${chantier.nom.replace(/\s+/g, '_')}.zip`);
        // @ts-ignore
        const archive = (0, archiver_1.default)('zip', { zlib: { level: 9 } });
        archive.pipe(res);
        for (const p of photos) {
            const filePath = path_1.default.join(__dirname, p.url);
            if (fs_1.default.existsSync(filePath)) {
                archive.file(filePath, { name: path_1.default.basename(filePath) });
            }
        }
        await archive.finalize();
    }
    catch (error) {
        res.status(500).json({ error: 'Error exporting photos' });
    }
});
// Commissionnement
app.put('/api/chantiers/:id/commissionnement', async (req, res) => {
    try {
        const comm = await prisma.commissionnement.upsert({
            where: { chantierId: req.params.id },
            update: req.body,
            create: { ...req.body, chantierId: req.params.id }
        });
        res.json(comm);
    }
    catch (error) {
        res.status(500).json({ error: 'Error updating commissionnement' });
    }
});
// IA Analysis
app.post('/api/chantiers/:id/analyze', async (req, res) => {
    try {
        if (!ai) {
            return res.status(403).json({ error: "L'IA n'est pas activée (GEMINI_API_KEY manquante)." });
        }
        // Collect all data for the prompt
        const chantier = await prisma.chantier.findUnique({
            where: { id: req.params.id },
            include: { pointages: { include: { intervenant: true } }, achats: true }
        });
        if (!chantier)
            return res.status(404).json({ error: 'Chantier introuvable' });
        let heuresRealisees = 0;
        chantier.pointages.forEach((p) => heuresRealisees += p.nbrHeures);
        let totalAchats = chantier.achats.reduce((acc, a) => acc + a.montantHT, 0);
        const prompt = `En tant qu'expert en gestion de chantier, analyse ce dossier:
Nom: ${chantier.nom} (Client: ${chantier.client})
Statut: ${chantier.statut}
Budget Vendu: ${chantier.budgetGlobalVendu} €
Budget Matériel Prévu: ${chantier.budgetMaterielVendu} € / Réel: ${totalAchats} €
Heures Prévues: ${chantier.heuresVendues} h / Réelles: ${heuresRealisees} h

Rédige un compte-rendu exécutif d'environ 150-200 mots résumant la situation financière (marge brute), l'avancement temporel, et donne 1 ou 2 recommandations concrètes pour le conducteur de travaux. Utilise un formatage Markdown propre et professionnel.`;
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: prompt,
        });
        res.json({ report: response.text });
    }
    catch (error) {
        console.error("AI Error:", error);
        res.status(500).json({ error: 'Erreur lors de la génération IA' });
    }
});
app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});
