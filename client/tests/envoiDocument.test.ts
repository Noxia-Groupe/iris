import assert from 'node:assert/strict';
import test from 'node:test';
import { lienMessagerie } from '../src/lib/envoiDocument.ts';

// Lot 6a-3 : le lien mailto ouvre la messagerie avec le destinataire, l'objet et le texte remplis.

test('une adresse ordinaire reste lisible ; objet et texte encodés, sauts de ligne en CRLF', () => {
  const corps = 'Bonjour,\n\nVeuillez trouver ci-joint notre devis A26-0001 (version 1).\n\nCordialement,\nSociété & Fils';
  assert.equal(
    lienMessagerie('client.principal@exemple.fr', 'Devis A26-0001 version 1 – Société & Fils', corps),
    'mailto:client.principal@exemple.fr?subject=Devis%20A26-0001%20version%201%20%E2%80%93%20Soci%C3%A9t%C3%A9%20%26%20Fils'
      + '&body=Bonjour%2C%0D%0A%0D%0AVeuillez%20trouver%20ci-joint%20notre%20devis%20A26-0001%20(version%201).%0D%0A%0D%0ACordialement%2C%0D%0ASoci%C3%A9t%C3%A9%20%26%20Fils',
  );
});

test('le lien se relit à l’identique : objet et texte décodés comme saisis', () => {
  const objet = 'Facture F2026-0001 – « Société » ?#&=%+';
  const corps = 'Ligne 1\r\nLigne 2\nLigne 3';
  const lien = new URL(lienMessagerie('compta@exemple.fr', objet, corps));
  assert.equal(lien.protocol, 'mailto:');
  assert.equal(lien.pathname, 'compta@exemple.fr');
  // URLSearchParams lit « + » comme une espace : l'objet l'encode, il se relit donc tel quel.
  assert.equal(lien.searchParams.get('subject'), objet);
  assert.equal(lien.searchParams.get('body'), 'Ligne 1\r\nLigne 2\r\nLigne 3');
  assert.deepEqual([...lien.searchParams.keys()], ['subject', 'body']);
});

test('un caractère réservé de l’adresse ne coupe pas le lien et n’ajoute aucun champ', () => {
  const lien = lienMessagerie('a+b?cc=intrus@exemple.fr', 'Objet', 'Texte');
  assert.equal(lien, 'mailto:a%2Bb%3Fcc%3Dintrus@exemple.fr?subject=Objet&body=Texte');
  assert.deepEqual([...new URL(lien).searchParams.keys()], ['subject', 'body']);
});
