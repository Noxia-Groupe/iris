// Vérifications des primitives d'authentification : elles sont appelées pour de vrai, avec
// des valeurs qui doivent passer et des valeurs qui doivent échouer.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test, { describe } from 'node:test';

const { apiKeyHash, secretIdentique, resolveJwtSecret } = await import('../dist/index.js');

describe('Secret JWT de production', () => {
  test('refuse une valeur d’exemple publiée', () => {
    assert.throws(() => resolveJwtSecret('CHANGE_ME_GENERATE_A_LONG_RANDOM_SECRET', 'production'), /valeur d’exemple/);
  });

  test('accepte un secret de production non publié', () => {
    assert.equal(resolveJwtSecret('secret-aleatoire-non-public-et-suffisamment-long', 'production'), 'secret-aleatoire-non-public-et-suffisamment-long');
  });
});

describe('Clés API', () => {
  test("l'empreinte est un SHA-256 stable et non réversible", () => {
    const cle = 'iris_' + crypto.randomBytes(32).toString('base64url');
    const empreinte = apiKeyHash(cle);
    assert.match(empreinte, /^[0-9a-f]{64}$/);
    assert.equal(apiKeyHash(cle), empreinte, 'la même clé doit donner la même empreinte');
    assert.ok(!empreinte.includes(cle.slice(5)), 'le secret ne doit pas apparaître dans son empreinte');
  });

  test('deux clés différentes ne partagent pas la même empreinte', () => {
    assert.notEqual(apiKeyHash('iris_a'), apiKeyHash('iris_b'));
  });
});

describe('Jeton de secours', () => {
  test('un jeton identique est reconnu', () => {
    assert.equal(secretIdentique('un-secret-de-32-caracteres-minimum', 'un-secret-de-32-caracteres-minimum'), true);
  });

  test('un jeton différent est rejeté, quelle que soit sa longueur', () => {
    // Le point sensible : timingSafeEqual lève une exception sur deux tampons de tailles
    // différentes. On compare donc des empreintes, jamais les secrets bruts — ces deux
    // cas doivent renvoyer false, pas planter.
    assert.equal(secretIdentique('court', 'un-secret-de-32-caracteres-minimum'), false);
    assert.equal(secretIdentique('un-secret-de-32-caracteres-minimum-mais-plus-long', 'un-secret-de-32-caracteres-minimum'), false);
    assert.equal(secretIdentique('', 'un-secret-de-32-caracteres-minimum'), false);
  });

  test('une différence sur un seul caractère suffit à rejeter', () => {
    assert.equal(secretIdentique('un-secret-de-32-caracteres-minimuM', 'un-secret-de-32-caracteres-minimum'), false);
  });
});
