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

// --- Sécurité : résolution du secret JWT ---
// En production, le secret est OBLIGATOIRE : on refuse de démarrer sinon.
function resolveJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (secret) return secret;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET manquant : définissez-le dans server/.env avant de démarrer en production.');
  }
  console.warn('[AVERTISSEMENT] JWT_SECRET non défini — clé de développement non sécurisée utilisée.');
  return 'dev_only_insecure_secret_change_me';
}
const JWT_SECRET = resolveJwtSecret();

// --- Middlewares d'authentification / autorisation ---
interface AuthRequest extends express.Request {
  user?: { id: string; role: string };
}

const requireAuth: express.RequestHandler = (req, res, next) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentification requise' });
    return;
  }
  try {
    const payload = jwt.verify(header.slice(7), JWT_SECRET) as { id: string; role: string };
    (req as AuthRequest).user = { id: payload.id, role: payload.role };
    next();
  } catch {
    res.status(401).json({ error: 'Session expirée ou invalide' });
  }
};

const requireAdmin: express.RequestHandler = (req, res, next) => {
  if ((req as AuthRequest).user?.role !== 'ADMIN') {
    res.status(403).json({ error: 'Accès réservé aux administrateurs' });
    return;
  }
  next();
};

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
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 Mo max par fichier
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Seules les images sont autorisées.'));
  }
});

// Wrapper pour transformer les erreurs Multer (taille/type) en réponses JSON propres
const uploadPhoto: express.RequestHandler = (req, res, next) => {
  upload.single('photo')(req, res, (err: unknown) => {
    if (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Upload invalide' });
      return;
    }
    next();
  });
};

// Routes de base (publiques)
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// Configuration globale (publique : indique simplement si l'IA est activée)
app.get('/api/config', (req, res) => {
  res.json({ aiEnabled: !!process.env.GEMINI_API_KEY });
});

// Auth Login (publique)
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
app.get('/api/chantiers', requireAuth, async (req, res) => {
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

app.post('/api/chantiers', requireAuth, requireAdmin, async (req, res) => {
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

// Update Chantier (pour le statut, le budget, etc.) — champs en liste blanche (anti mass-assignment)
app.patch('/api/chantiers/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const allowed = ['nom', 'client', 'numeroDevis', 'statut', 'responsableId'];
    const numericFields = ['budgetGlobalVendu', 'budgetMaterielVendu', 'budgetMainOeuvreVendu', 'heuresVendues'];
    const dateFields = ['dateDebut', 'dateFin'];

    const data: Record<string, unknown> = {};
    for (const key of allowed) {
      if (key in req.body) data[key] = req.body[key];
    }
    for (const key of numericFields) {
      if (key in req.body) data[key] = parseFloat(req.body[key]) || 0;
    }
    for (const key of dateFields) {
      if (key in req.body && req.body[key]) data[key] = new Date(req.body[key]).toISOString();
    }

    const chantier = await prisma.chantier.update({
      where: { id: req.params.id },
      data
    });
    res.json(chantier);
  } catch (error) {
    res.status(500).json({ error: 'Error updating chantier' });
  }
});

// Users (administration réservée aux admins)
app.get('/api/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const users = await prisma.user.findMany({ select: { id: true, name: true, email: true, role: true } });
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: 'Error fetching users' });
  }
});

app.patch('/api/users/:id/role', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { role } = req.body;
    if (role !== 'ADMIN' && role !== 'CONDUCTEUR_TRAVAUX') {
      return res.status(400).json({ error: 'Rôle invalide' });
    }
    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: { role },
      select: { id: true, name: true, email: true, role: true }
    });
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: 'Error updating user role' });
  }
});

app.put('/api/users/:id/password', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: 'Le mot de passe doit faire au moins 6 caractères.' });
    }
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({
      where: { id: req.params.id },
      data: { password: hashedPassword }
    });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Error updating password' });
  }
});

// Intervenants
app.get('/api/intervenants', requireAuth, async (req, res) => {
  try {
    res.json(await prisma.intervenant.findMany());
  } catch (error) {
    res.status(500).json({ error: 'Error fetching intervenants' });
  }
});

app.post('/api/intervenants', requireAuth, requireAdmin, async (req, res) => {
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
app.get('/api/categories', requireAuth, async (req, res) => res.json(await prisma.categorie.findMany()));
app.post('/api/categories', requireAuth, requireAdmin, async (req, res) => res.json(await prisma.categorie.create({ data: { nom: req.body.nom, description: req.body.description || null } })));
app.get('/api/fournisseurs', requireAuth, async (req, res) => res.json(await prisma.fournisseur.findMany()));
app.post('/api/fournisseurs', requireAuth, async (req, res) => res.json(await prisma.fournisseur.create({ data: { nom: req.body.nom, contact: req.body.contact || null } })));

// Achats
app.get('/api/achats', requireAuth, async (req, res) => {
  try {
    res.json(await prisma.achatReel.findMany({ include: { chantier: true, categorie: true, fournisseur: true } }));
  } catch (error) {
    res.status(500).json({ error: 'Error fetching achats' });
  }
});

app.post('/api/achats', requireAuth, async (req, res) => {
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
app.get('/api/heures', requireAuth, async (req, res) => {
  try {
    res.json(await prisma.pointageHeure.findMany({ include: { chantier: true, intervenant: true } }));
  } catch (error) {
    res.status(500).json({ error: 'Error fetching heures' });
  }
});

app.post('/api/heures', requireAuth, async (req, res) => {
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
app.post('/api/chantiers/:id/photos', requireAuth, uploadPhoto, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const url = `/uploads/${req.file.filename}`;
    const photo = await prisma.photoChantier.create({
      data: {
        url,
        legende: req.body.legende || '',
        chantierId: req.params.id,
        auteurId: (req as AuthRequest).user?.id || null
      }
    });
    res.json(photo);
  } catch (error) {
    res.status(500).json({ error: 'Error uploading photo' });
  }
});

app.delete('/api/chantiers/:id/photos/purge', requireAuth, requireAdmin, async (req, res) => {
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

app.get('/api/chantiers/:id/photos/export', requireAuth, async (req, res) => {
  try {
    const chantier = await prisma.chantier.findUnique({ where: { id: req.params.id } });
    if (!chantier) return res.status(404).json({ error: 'Chantier not found' });

    const photos = await prisma.photoChantier.findMany({ where: { chantierId: req.params.id } });

    res.attachment(`photos-${chantier.nom.replace(/\s+/g, '_')}.zip`);
    // @ts-ignore — typage de la lib archiver variable selon les versions (export = function)
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

// Commissionnement (réservé aux admins) — champs en liste blanche
app.put('/api/chantiers/:id/commissionnement', requireAuth, requireAdmin, async (req, res) => {
  try {
    const data = {
      mode: req.body.mode === 'DYNAMIQUE' ? 'DYNAMIQUE' : 'FIXE',
      tauxFixe: parseFloat(req.body.tauxFixe) || 0,
      bonusHeure: parseFloat(req.body.bonusHeure) || 0,
      malusHeure: parseFloat(req.body.malusHeure) || 0
    };
    const comm = await prisma.commissionnement.upsert({
      where: { chantierId: req.params.id },
      update: data,
      create: { ...data, chantierId: req.params.id }
    });
    res.json(comm);
  } catch (error) {
    res.status(500).json({ error: 'Error updating commissionnement' });
  }
});

// IA Analysis
app.post('/api/chantiers/:id/analyze', requireAuth, async (req, res) => {
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
    chantier.pointages.forEach((p: { nbrHeures: number }) => heuresRealisees += p.nbrHeures);
    const totalAchats = chantier.achats.reduce((acc: number, a: { montantHT: number }) => acc + a.montantHT, 0);

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
