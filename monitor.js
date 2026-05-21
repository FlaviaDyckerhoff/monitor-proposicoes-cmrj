const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

const EMAIL_DESTINO = process.env.EMAIL_DESTINO;
const FIRJAN_DESTINO = process.env.FIRJAN_DESTINO || EMAIL_DESTINO || 'tramitacao@monitorlegislativo.com.br';
const EMAIL_REMETENTE = process.env.EMAIL_REMETENTE;
const EMAIL_SENHA = process.env.EMAIL_SENHA;
const ARQUIVO_ESTADO = 'estado.json';
const BASE_URL = 'https://aplicnt.camara.rj.gov.br/APL/Legislativos/scpro.nsf';
const LOGO_PATH = path.join(__dirname, 'assets', 'monitor-logo-color.png');
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
let falhasBusca = 0;

const TIPOS = [
  { sigla: 'PL',   label: 'Proj. de Lei',                    form: 'Internet/LeiInt?OpenForm'       },
  { sigla: 'PLC',  label: 'Proj. de Lei Complementar',       form: 'Internet/LeiCompInt?OpenForm'   },
  { sigla: 'PELO', label: 'Proj. Emenda Lei Orgânica',       form: 'Internet/EmendaInt?OpenForm'    },
  { sigla: 'PDL',  label: 'Proj. Decreto Legislativo',       form: 'Internet/DecretoInt?OpenForm'   },
  { sigla: 'PR',   label: 'Proj. de Resolução',              form: 'Internet/ResolucaoInt?OpenForm' },
  { sigla: 'IND',  label: 'Indicação',                       form: 'Internet/IndInt?OpenForm'       },
  { sigla: 'MOC',  label: 'Moção',                           form: 'Internet/mocaoInt?OpenForm'     },
  { sigla: 'REQ-I',label: 'Req. de Informação',              form: 'Internet/ReqInfInt?OpenForm'    },
  { sigla: 'REQ',  label: 'Requerimento',                    form: 'Internet/ReqInt?OpenForm'       },
  { sigla: 'MSG',  label: 'Mensagem do Executivo',           form: 'Internet/MensInt?OpenForm'      },
];

// ─── Estado ───────────────────────────────────────────────────────────────────

function carregarEstado() {
  if (fs.existsSync(ARQUIVO_ESTADO)) {
    return JSON.parse(fs.readFileSync(ARQUIVO_ESTADO, 'utf8'));
  }
  return { proposicoes_vistas: [], ultima_execucao: '' };
}

function salvarEstado(estado) {
  fs.writeFileSync(ARQUIVO_ESTADO, JSON.stringify(estado, null, 2));
}

// ─── Scraping ─────────────────────────────────────────────────────────────────

function limparHtml(str) {
  return str
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatarDataHoraBRT() {
  return new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

function formatarDataBRT() {
  return new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

function absolutizarUrl(href) {
  if (!href) return '';
  const limpo = href.replace(/&amp;/g, '&').trim();
  if (/^https?:\/\//i.test(limpo)) return limpo;
  if (limpo.startsWith('/')) return 'https://aplicnt.camara.rj.gov.br' + limpo;
  return BASE_URL + '/' + limpo;
}

function formatarDataBrasil(data) {
  const match = String(data || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return data || '-';

  const [, parte1, parte2, ano] = match;
  const n1 = parseInt(parte1, 10);
  const n2 = parseInt(parte2, 10);

  // A CMRJ/Domino publica no formato americano MM/DD/AAAA.
  if (n1 <= 12 && n2 > 12) {
    return parte2 + '/' + parte1 + '/' + ano;
  }

  return data;
}

function extrairProposicoesDaPagina(html, tipo) {
  const proposicoes = [];

  // Estrutura do Domino da CMRJ (idêntica à ALERJ):
  // <tr>
  //   <td><a href="...">2017/2026</a></td>   ← número/ano + href com hash
  //   <td>→ ícone</td>
  //   <td>EMENTA =>20260302017=> {comissões}</td>
  //   <td>06/04/2026</td>
  //   <td>VEREADOR FULANO</td>
  // </tr>
  //
  // O código de 11 dígitos (ex: 20260302017) aparece na célula de descrição
  // e também pode ser extraído do href do link.
  // Número exibido: 2017/2026 (formato NNNN/AAAA)
  // Ano: últimos 4 dígitos do número exibido

  const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let trMatch;

  while ((trMatch = trRegex.exec(html)) !== null) {
    const linha = trMatch[1];

    // Filtra linhas com código de 11 dígitos
    const codigoMatch = linha.match(/\b(\d{11})\b/);
    if (!codigoMatch) continue;

    const codigo = codigoMatch[1];
    const ano = codigo.substring(0, 4);

    const linkMatch = linha.match(/<a\b[^>]*href=["']([^"']+)["'][^>]*>\s*\d+\/\d{4}\s*<\/a>/i);
    const url = linkMatch ? absolutizarUrl(linkMatch[1]) : '';

    // Extrai células como texto limpo
    const tds = [];
    const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let tdMatch;
    while ((tdMatch = tdRegex.exec(linha)) !== null) {
      tds.push(limparHtml(tdMatch[1]));
    }

    if (tds.length < 3) continue;

    // Número exibido: formato NNNN/AAAA — está na primeira célula não-vazia
    let numeroExibido = '-';
    const numMatch = tds[0] && tds[0].match(/(\d+)\/(\d{4})/);
    if (numMatch) {
      numeroExibido = `${numMatch[1]}/${numMatch[2]}`;
    }

    // Ementa: célula que contém "=>" e o código
    let ementa = '-';
    let data = '-';
    let autor = '-';

    for (let i = 0; i < tds.length; i++) {
      if (tds[i].includes('=>') && tds[i].includes(codigo)) {
        const partes = tds[i].split('=>');
        ementa = partes[0].trim().substring(0, 300);

        for (let j = i + 1; j < tds.length; j++) {
          const dataMatch = tds[j].match(/\d{2}\/\d{2}\/\d{4}/);
          if (dataMatch) {
            data = formatarDataBrasil(dataMatch[0]);
            if (tds[j + 1] && tds[j + 1].trim()) {
              autor = tds[j + 1].substring(0, 200);
            }
            break;
          }
        }
        break;
      }
    }

    proposicoes.push({
      id: `${tipo.sigla}-${codigo}`,
      codigo,
      sigla: tipo.sigla,
      label: tipo.label,
      numero: numeroExibido,
      ano,
      autor,
      data,
      ementa,
      url,
    });
  }

  return proposicoes;
}

async function buscarTipo(tipo) {
  const url = `${BASE_URL}/${tipo.form}`;
  console.log(`  🔍 ${tipo.sigla}`);

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; monitor-cmrj/1.0)',
        'Accept': 'text/html,application/xhtml+xml',
      },
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      console.error(`  ❌ HTTP ${response.status} para ${tipo.sigla}`);
      falhasBusca += 1;
      return [];
    }

    const html = await response.text();
    const lista = extrairProposicoesDaPagina(html, tipo);
    console.log(`  ✅ ${tipo.sigla}: ${lista.length} proposições encontradas`);

    if (lista.length > 0) {
      const p = lista[0];
      console.log(`     Exemplo: ${p.numero} | ${p.data} | ${p.autor.substring(0, 30)} | ${p.ementa.substring(0, 60)}...`);
    }

    return lista;
  } catch (err) {
    console.error(`  ❌ Erro ao buscar ${tipo.sigla}: ${err.message}`);
    falhasBusca += 1;
    return [];
  }
}

async function buscarTodasProposicoes() {
  const todas = [];
  for (const tipo of TIPOS) {
    const lista = await buscarTipo(tipo);
    todas.push(...lista);
    await new Promise(r => setTimeout(r, 1500));
  }
  return todas;
}

// ─── Email ────────────────────────────────────────────────────────────────────

async function enviarEmail(novas) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: EMAIL_REMETENTE, pass: EMAIL_SENHA },
  });

  const porTipo = {};
  novas.forEach(p => {
    if (!porTipo[p.label]) porTipo[p.label] = [];
    porTipo[p.label].push(p);
  });

  const ordemTipos = TIPOS.map(t => t.label);
  const tiposOrdenados = Object.keys(porTipo)
    .sort((a, b) => ordemTipos.indexOf(a) - ordemTipos.indexOf(b));

  const linhas = tiposOrdenados.map(label => {
    const grupo = porTipo[label];
    // Ordena por número decrescente (extrai parte numérica do NNNN/AAAA)
    grupo.sort((a, b) => {
      const na = parseInt(a.numero.split('/')[0]) || 0;
      const nb = parseInt(b.numero.split('/')[0]) || 0;
      return nb - na;
    });

    const header = `
      <tr>
        <td colspan="5" style="padding:10px 8px 4px;background:#e8eef5;font-weight:bold;
          color:#1a3a5c;font-size:13px;border-top:3px solid #1a3a5c">
          ${label} — ${grupo.length} nova(s)
        </td>
      </tr>`;

    const rows = grupo.map(p => {
      const numero = p.url
        ? '<a href="' + p.url + '" style="color:#1a3a5c;text-decoration:none"><strong>' + p.numero + '</strong></a>'
        : '<strong>' + p.numero + '</strong>';

      return `
      <tr>
        <td style="padding:8px;border-bottom:1px solid #eee;color:#555;font-size:12px;
          white-space:nowrap">${p.sigla}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;white-space:nowrap">
          ${numero}
        </td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px">${p.autor}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px;
          white-space:nowrap">${p.data}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px">${p.ementa}</td>
      </tr>`;
    }).join('');

    return header + rows;
  }).join('');

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:960px;margin:0 auto;background:#ffffff;color:#111827">
      <div style="background:#0f3357;padding:22px 24px;border-radius:12px 12px 0 0;color:#ffffff">
        <img src="cid:monitorLogo" alt="Monitor Legislativo" style="height:58px;vertical-align:middle;margin-right:18px">
        <span style="font-size:26px;font-weight:700;vertical-align:middle">Monitor Legislativo</span>
        <div style="font-size:14px;color:#d7e5f2;margin-top:8px">Proposições novas • Câmara Municipal do Rio de Janeiro</div>
      </div>
      <div style="border:1px solid #d7dde7;border-top:0;padding:24px;border-radius:0 0 12px 12px">
      <p style="display:inline-block;background:#e6f1fb;color:#0f3357;padding:6px 14px;border-radius:20px;font-weight:bold;margin:0 0 16px 0">FIRJAN</p>
      <h2 style="color:#111827;margin:0 0 6px 0;font-size:24px">
        FIRJAN | Câmara do Rio — Novas proposições
      </h2>
      <p style="color:#526070;margin:0 0 18px 0">
        Rodada diária • ${formatarDataHoraBRT()} BRT
      </p>
      <p style="background:#eef6ff;border:1px solid #c7ddf2;color:#173d63;padding:12px 14px;border-radius:8px;font-weight:bold">
        ${novas.length} proposição(ões) nova(s) localizada(s) na Câmara do Rio
      </p>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <thead>
          <tr style="background:#1a3a5c;color:white">
            <th style="padding:10px;text-align:left">Sigla</th>
            <th style="padding:10px;text-align:left">Número/Ano</th>
            <th style="padding:10px;text-align:left">Autor(es)</th>
            <th style="padding:10px;text-align:left">Data Publ.</th>
            <th style="padding:10px;text-align:left">Ementa</th>
          </tr>
        </thead>
        <tbody>${linhas}</tbody>
      </table>
      <p style="margin-top:20px;font-size:12px;color:#999">
        Acesse: <a href="https://www.camara.rio/atividade-parlamentar/processo-legislativo/pl">camara.rio</a>
      </p>
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0">
      <p style="font-size:12px;color:#64748b;margin:0">
        Monitor Legislativo — acompanhamento legislativo estadual e municipal. Horário sempre em BRT.
      </p>
      </div>
    </div>
  `;

  await transporter.sendMail({
    from: `"Monitor Legislativo" <${EMAIL_REMETENTE}>`,
    to: FIRJAN_DESTINO,
    subject: `FIRJAN | Câmara do Rio — Novas proposições — ${formatarDataBRT()}`,
    html,
    attachments: fs.existsSync(LOGO_PATH) ? [{ filename: 'monitor-logo-color.png', path: LOGO_PATH, cid: 'monitorLogo' }] : [],
  });

  console.log(`✅ Email FIRJAN/CMRJ enviado para ${FIRJAN_DESTINO} com ${novas.length} proposições novas.`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  console.log('🚀 Iniciando monitor CMRJ...');
  console.log(`⏰ ${new Date().toLocaleString('pt-BR')}`);

  const estado = carregarEstado();
  const idsVistos = new Set(estado.proposicoes_vistas.map(String));

  console.log(`\n📋 Buscando ${TIPOS.length} tipos de proposições...`);
  const todas = await buscarTodasProposicoes();

  if (todas.length === 0) {
    console.log('⚠️ Nenhuma proposição encontrada. Verifique o portal.');
    if (falhasBusca > 0) {
      console.error(`❌ Falha de fonte: ${falhasBusca} tipo(s) tiveram erro de busca.`);
      process.exit(1);
    }
    process.exit(0);
  }

  // Filtro A: só ano corrente
  const anoAtual = String(new Date().getFullYear());
  const doAnoAtual = todas.filter(p => p.ano === anoAtual);
  console.log(`\n📊 Total encontrado: ${todas.length} | Do ano ${anoAtual}: ${doAnoAtual.length}`);

  const novas = doAnoAtual.filter(p => !idsVistos.has(p.id));
  console.log(`🆕 Novas (não vistas antes): ${novas.length}`);

  // Filtro B: primeiro run — marca tudo como visto sem enviar email
  const primeiroRun = idsVistos.size === 0;
  if (primeiroRun) {
    console.log('⚙️ Primeiro run detectado — marcando todas como vistas sem enviar email.');
    doAnoAtual.forEach(p => idsVistos.add(p.id));
  } else if (novas.length > 0) {
    await enviarEmail(novas);
    novas.forEach(p => idsVistos.add(p.id));
  } else {
    console.log('✅ Sem novidades. Nada a enviar.');
    if (process.env.ALERTAR_SEM_NOVIDADES === '1') {
      console.error('❌ Sem proposições novas em dia útil monitorado. Gerando alerta interno.');
      estado.proposicoes_vistas = Array.from(idsVistos);
      estado.ultima_execucao = new Date().toISOString();
      salvarEstado(estado);
      process.exit(2);
    }
  }

  estado.proposicoes_vistas = Array.from(idsVistos);
  estado.ultima_execucao = new Date().toISOString();
  salvarEstado(estado);
})();
