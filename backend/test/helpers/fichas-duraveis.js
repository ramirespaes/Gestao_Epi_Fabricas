'use strict';

/** R-D45: fichas e registros SINTÉTICOS de destino durável (contas, buckets e ARNs fictícios; nada existe na AWS). */

const congelar = (v) => {
  if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) { Object.freeze(v); for (const f of Object.values(v)) congelar(f); }
  return v;
};
const clonar = (v) => JSON.parse(JSON.stringify(v));

const BASE = Object.freeze({
  HOMOLOGACAO: { id: 'hml-s3-principal', conta: '111111111111', marcador: 'hml', mac: '11111111-1111-4111-8111-111111111111', cifra: '22222222-2222-4222-8222-222222222222', retencao: { modo: 'GOVERNANCE', dias: 7 } },
  PRODUCAO: { id: 'prod-s3-principal', conta: '222222222222', marcador: 'prod', mac: '33333333-3333-4333-8333-333333333333', cifra: '44444444-4444-4444-8444-444444444444', retencao: { modo: 'COMPLIANCE', dias: 30 } },
});

/** Ficha NÃO congelada (para variar campos nos testes); `congelarFicha`/`registro` congelam. */
function fichaDeTeste(ambiente = 'HOMOLOGACAO') {
  const b = BASE[ambiente];
  const identidade = (tipo, nome) => ({ contaId: b.conta, tipo, nome: `safework-${b.marcador}-${nome}` });
  return {
    id: b.id, ambiente, tipo: 'S3', regiao: 'us-east-1', contaId: b.conta,
    bucket: `safework-${b.marcador}-backup-${b.conta}`, prefixo: `${b.marcador}/`,
    chaveMac: `arn:aws:kms:us-east-1:${b.conta}:key/${b.mac}`, chaveCifra: `arn:aws:kms:us-east-1:${b.conta}:key/${b.cifra}`,
    retencao: { ...b.retencao },
    identidades: { publicador: identidade('user', 'publicador'), verificador: identidade('user', 'verificador'), restauracao: identidade('role', 'restauracao') },
  };
}
const registro = (...fichas) => congelar(fichas.map(clonar));
const registroDeTeste = () => registro(fichaDeTeste('HOMOLOGACAO'), fichaDeTeste('PRODUCAO'));
/** Ficha de homologação cujo publicador vive em OUTRA conta (autorização entre contas). */
const fichaEntreContas = () => { const f = fichaDeTeste('HOMOLOGACAO'); f.identidades.publicador = { contaId: '333333333333', tipo: 'role', nome: 'safework-hml-publicador-externo' }; return f; };

module.exports = { fichaDeTeste, fichaEntreContas, registro, registroDeTeste, congelar, clonar, BASE };
