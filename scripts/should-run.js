const fs = require('fs');

const FERIADOS_2026 = new Map([
  ['2026-01-01', 'Confraternizacao Universal'],
  ['2026-01-20', 'Sao Sebastiao - Rio de Janeiro'],
  ['2026-02-16', 'Carnaval'],
  ['2026-02-17', 'Carnaval'],
  ['2026-04-03', 'Sexta-feira Santa'],
  ['2026-04-21', 'Tiradentes'],
  ['2026-04-23', 'Sao Jorge - RJ'],
  ['2026-05-01', 'Dia do Trabalho'],
  ['2026-06-04', 'Corpus Christi'],
  ['2026-09-07', 'Independencia do Brasil'],
  ['2026-10-12', 'Nossa Senhora Aparecida'],
  ['2026-11-02', 'Finados'],
  ['2026-11-15', 'Proclamacao da Republica'],
  ['2026-11-20', 'Consciencia Negra'],
  ['2026-12-25', 'Natal'],
]);

function dataBRT() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  }).formatToParts(new Date());

  const get = (type) => parts.find((p) => p.type === type).value;
  return {
    iso: get('year') + '-' + get('month') + '-' + get('day'),
    weekday: get('weekday'),
  };
}

const hoje = dataBRT();
const fimDeSemana = hoje.weekday === 'Sat' || hoje.weekday === 'Sun';
const feriado = FERIADOS_2026.get(hoje.iso);

if (fimDeSemana) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, 'skip=true\n');
  console.log('skip=true reason=fim_de_semana date=' + hoje.iso);
  process.exit(0);
}

if (feriado) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, 'skip=true\n');
  console.log('skip=true reason=feriado date=' + hoje.iso + ' name=' + feriado);
  process.exit(0);
}

if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, 'skip=false\n');
console.log('skip=false date=' + hoje.iso);
