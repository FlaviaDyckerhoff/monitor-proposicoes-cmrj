const nodemailer = require('nodemailer');

const {
  EMAIL_REMETENTE,
  EMAIL_SENHA,
  EMAIL_DESTINO,
  MONITOR_NOME = 'Monitor Proposicoes',
  GITHUB_REPOSITORY,
  GITHUB_RUN_ID,
  GITHUB_SERVER_URL = 'https://github.com',
  GITHUB_WORKFLOW,
  GITHUB_REF_NAME,
} = process.env;

async function main() {
  if (!EMAIL_REMETENTE || !EMAIL_SENHA || !EMAIL_DESTINO) {
    console.error('Sem credenciais/destino para alerta interno de falha.');
    process.exit(0);
  }

  const runUrl = GITHUB_REPOSITORY && GITHUB_RUN_ID
    ? GITHUB_SERVER_URL + '/' + GITHUB_REPOSITORY + '/actions/runs/' + GITHUB_RUN_ID
    : '';

  const html = '<div style="font-family:Arial,sans-serif;max-width:720px">' +
    '<h2 style="color:#b42318;margin-bottom:8px">Falha no ' + MONITOR_NOME + '</h2>' +
    '<p>O workflow de Proposicoes Novas FIRJAN falhou ou rodou sem novidades em dia util nao feriado.</p>' +
    '<p><strong>Workflow:</strong> ' + (GITHUB_WORKFLOW || '-') + '<br>' +
    '<strong>Branch:</strong> ' + (GITHUB_REF_NAME || '-') + '<br>' +
    '<strong>Run:</strong> ' + (runUrl ? '<a href="' + runUrl + '">' + runUrl + '</a>' : '-') + '</p>' +
    '<p style="color:#64748b;font-size:12px">Alerta interno. Nao enviado para FIRJAN.</p>' +
    '</div>';

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: EMAIL_REMETENTE, pass: EMAIL_SENHA },
  });

  await transporter.sendMail({
    from: '"Monitor Legislativo" <' + EMAIL_REMETENTE + '>',
    to: EMAIL_DESTINO,
    subject: '[ALERTA INTERNO] Falha ' + MONITOR_NOME,
    html,
  });

  console.log('Alerta interno de falha enviado para ' + EMAIL_DESTINO);
}

main().catch((err) => {
  console.error('Erro ao enviar alerta interno:', err.message);
  process.exit(0);
});

