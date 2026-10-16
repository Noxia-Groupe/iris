// Délais de connexion du serveur HTTP (correctif « socket hang up », décision de Nelson du
// 14-10-2026). Node ferme par défaut une connexion keep-alive inactive au bout de 5 s ; un client
// qui la réutilise à cet instant reçoit ECONNRESET. Ces tests ouvrent une vraie connexion TCP,
// sans base de données : /api/health ne lit rien.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';
import test, { describe } from 'node:test';

const { app, reglerDelaisConnexion } = await import('../dist/index.js');

const attendre = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Envoie une requête keep-alive sur la connexion et attend la réponse complète. Une connexion
// fermée ou en erreur avant la réponse fait échouer le test au lieu de le laisser bloqué.
async function demanderSante(socket) {
  const reponse = new Promise((resolve, reject) => {
    let recu = '';
    const arreter = () => {
      socket.off('data', lire);
      socket.off('close', fermee);
      socket.off('error', fermee);
    };
    const lire = (morceau) => {
      recu += morceau.toString();
      if (recu.includes('{"status":"ok"}')) {
        arreter();
        resolve(recu);
      }
    };
    const fermee = (erreur) => {
      arreter();
      reject(erreur instanceof Error ? erreur : new Error('connexion fermée avant la réponse'));
    };
    socket.on('data', lire);
    socket.on('close', fermee);
    socket.on('error', fermee);
  });
  socket.write('GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n');
  return reponse;
}

// Ouvre le serveur sur un port libre, une connexion, une première requête, puis laisse la
// connexion inactive `inactiviteMs` : renvoie si le serveur l'a fermée entre-temps.
async function fermeeApresInactivite(serveur, inactiviteMs) {
  await once(serveur, 'listening');
  const socket = net.connect(serveur.address().port, '127.0.0.1');
  let fermee = false;
  socket.on('end', () => { fermee = true; });
  socket.on('close', () => { fermee = true; });
  socket.on('error', () => { fermee = true; });
  try {
    await once(socket, 'connect');
    assert.match(await demanderSante(socket), /^HTTP\/1\.1 200/);
    await attendre(inactiviteMs);
    if (!fermee) assert.match(await demanderSante(socket), /^HTTP\/1\.1 200/, 'la connexion gardée sert une seconde requête');
    return fermee;
  } finally {
    socket.destroy();
    serveur.closeAllConnections?.();
    await new Promise((resolve) => serveur.close(resolve));
  }
}

// Délai borné : un test bloqué échoue au lieu de suspendre la suite (la CI n'a pas de délai par job).
describe('Délais de connexion du serveur HTTP', { timeout: 20_000 }, () => {
  test('les connexions inactives sont gardées 65 s, et les en-têtes acceptés au-delà', () => {
    const serveur = reglerDelaisConnexion(app.listen(0));
    try {
      assert.equal(serveur.keepAliveTimeout, 65_000);
      assert.equal(serveur.headersTimeout, 66_000);
      assert.ok(serveur.headersTimeout > serveur.keepAliveTimeout, 'headersTimeout reste au-delà de keepAliveTimeout, comme le recommandaient les anciennes versions de Node');
    } finally {
      serveur.close();
    }
  });

  // Témoin : le test sait voir une connexion fermée par le serveur (délai réduit à 0,5 s ; les
  // versions récentes de Node y ajoutent une marge d'une seconde, d'où l'attente de 3 s).
  test('témoin : un serveur au délai court ferme la connexion inactive', async () => {
    const serveur = app.listen(0);
    serveur.keepAliveTimeout = 500;
    assert.equal(await fermeeApresInactivite(serveur, 3_000), true);
  });

  // Au-delà des 5 s par défaut de Node (plus sa marge éventuelle d'une seconde), la connexion
  // reste ouverte et resservable.
  test('une connexion keep-alive inactive depuis 7,5 s reste ouverte et sert la requête suivante', async () => {
    assert.equal(await fermeeApresInactivite(reglerDelaisConnexion(app.listen(0)), 7_500), false);
  });
});
