import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
import multer from 'multer';
import archiver from 'archiver';
import path from 'path';
import fs from 'fs';
import { GoogleGenAI } from '@google/genai';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

dotenv.config();

const ai = process.env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) : null;

const app = express();
const prisma = new PrismaClient();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Configuration Multer pour le stockage local des photos
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Servir statiquement le dossier uploads
app.use('/uploads', express.static(uploadDir));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});
const upload = multer({ storage });

// Routes de base
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// Configuration globale
app.get('/api/config', (req, res) => {
  res.json({ aiEnabled: !!process.env.GEMINI_API_KEY });
});

const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_default_key_change_in_prod';

// Auth Login
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await prisma.user.findUnique({ where: { email } });
    
    if (!user || !user.password) {
      return res.status(401).json({ error: 'Identifiants incorrects' });
    }
    
    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) {
      return res.status(401).json({ error: 'Identifiants incorrects' });
    }
    
    const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  } catch (error) {
    res.status(500).json({ error: 'Erreur lors de la connexion' });
  }
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
  } catch (error) {
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
  } catch (error) {
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
  } catch (error) {
    res.status(500).json({ error: 'Error updating chantier' });
  }
});

// Users
app.get('/api/users', async (req, res) => {
  try {
    const users = await prisma.user.findMany({ select: { id: true, name: true, email: true, role: true } });
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: 'Error fetching users' });
  }
});

// Intervenants
app.get('/api/intervenants', async (req, res) => {
  try {
    res.json(await prisma.intervenant.findMany());
  } catch (error) {
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
  } catch (error) {
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
  } catch (error) {
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
  } catch (error) {
    res.status(500).json({ error: 'Error creating achat' });
  }
});

// Pointages (Heures)
app.get('/api/heures', async (req, res) => {
  try {
    res.json(await prisma.pointageHeure.findMany({ include: { chantier: true, intervenant: true } }));
  } catch (error) {
    res.status(500).json({ error: 'Error fetching heures' });
  }
});

app.post('/api/heures', async (req, res) => {
  try {
    const intervenant = await prisma.intervenant.findUnique({ where: { id: req.body.intervenantId } });
    if (!intervenant) return res.status(404).json({ error: 'Intervenant not found' });
    
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
  } catch (error) {
    res.status(500).json({ error: 'Error creating pointage' });
  }
});

// Photos Upload & Purge
app.post('/api/chantiers/:id/photos', upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    
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
  } catch (error) {
    res.status(500).json({ error: 'Error uploading photo' });
  }
});

app.delete('/api/chantiers/:id/photos/purge', async (req, res) => {
  try {
    const photos = await prisma.photoChantier.findMany({ where: { chantierId: req.params.id } });
    for (const p of photos) {
      const filePath = path.join(__dirname, p.url);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
    await prisma.photoChantier.deleteMany({ where: { chantierId: req.params.id } });
    res.json({ message: 'Purge terminée' });
  } catch (error) {
    res.status(500).json({ error: 'Error purging photos' });
  }
});

app.get('/api/chantiers/:id/photos/export', async (req, res) => {
  try {
    const chantier = await prisma.chantier.findUnique({ where: { id: req.params.id } });
    if (!chantier) return res.status(404).json({ error: 'Chantier not found' });

    const photos = await prisma.photoChantier.findMany({ where: { chantierId: req.params.id } });
    
    res.attachment(`photos-${chantier.nom.replace(/\s+/g, '_')}.zip`);
    // @ts-ignore
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.pipe(res);
    
    for (const p of photos) {
      const filePath = path.join(__dirname, p.url);
      if (fs.existsSync(filePath)) {
        archive.file(filePath, { name: path.basename(filePath) });
      }
    }
    await archive.finalize();
  } catch (error) {
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
  } catch (error) {
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

    if (!chantier) return res.status(404).json({ error: 'Chantier introuvable' });

    let heuresRealisees = 0;
    chantier.pointages.forEach((p: any) => heuresRealisees += p.nbrHeures);
    let totalAchats = chantier.achats.reduce((acc: number, a: any) => acc + a.montantHT, 0);

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
  } catch (error) {
    console.error("AI Error:", error);
    res.status(500).json({ error: 'Erreur lors de la génération IA' });
  }
});

// Initialisation BDD (Seeding)
const initDb = async () => {
  const users = await prisma.user.findMany();
  if (users.length === 0) {
    const adminEmail = process.env.ADMIN_EMAIL || 'admin@noxia.com';
    const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
    const hashedPassword = await bcrypt.hash(adminPassword, 10);
    
    await prisma.user.create({ 
      data: { 
        email: adminEmail, 
        name: 'Administrateur', 
        role: 'ADMIN',
        password: hashedPassword
      } 
    });
    console.log(`Compte administrateur créé : ${adminEmail}`);

    // Créer un conducteur factice pour tester
    await prisma.user.create({ 
      data: { 
        email: 'jean@noxia.com', 
        name: 'Jean Dupont (Conducteur)', 
        role: 'CONDUCTEUR_TRAVAUX',
        password: await bcrypt.hash('conducteur123', 10)
      } 
    });
  }
};

app.listen(port, async () => {
  await initDb();
  console.log(`Server running on port ${port}`);
});
