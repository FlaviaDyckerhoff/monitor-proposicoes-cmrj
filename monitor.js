const fs = require('fs');
const nodemailer = require('nodemailer');

const EMAIL_DESTINO = process.env.EMAIL_DESTINO;
const EMAIL_REMETENTE = process.env.EMAIL_REMETENTE;
const EMAIL_SENHA = process.env.EMAIL_SENHA;
const ARQUIVO_ESTADO = 'estado.json';
const BASE_URL = 'https://aplicnt.camara.rj.gov.br/APL/Legislativos/scpro.nsf';

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
            data = dataMatch[0];
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

    const rows = grupo.map(p => `
      <tr>
        <td style="padding:8px;border-bottom:1px solid #eee;color:#555;font-size:12px;
          white-space:nowrap">${p.sigla}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;white-space:nowrap">
          <strong>${p.numero}</strong>
        </td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px">${p.autor}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px;
          white-space:nowrap">${p.data}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px">${p.ementa}</td>
      </tr>`).join('');

    return header + rows;
  }).join('');

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:960px;margin:0 auto">
      <h2 style="color:#1a3a5c;border-bottom:2px solid #1a3a5c;padding-bottom:8px">
        🏛️ CMRJ — ${novas.length} nova(s) proposição(ões)
      </h2>
      <p style="color:#666;margin-top:0">
        Monitoramento automático — ${new Date().toLocaleString('pt-BR')}
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
    </div>
  `;

  await transporter.sendMail({
    from: `"Monitor CMRJ" <${EMAIL_REMETENTE}>`,
    to: EMAIL_DESTINO,
    subject: `🏛️ CMRJ: ${novas.length} nova(s) proposição(ões) — ${new Date().toLocaleDateString('pt-BR')}`,
    html,
  });

  console.log(`✅ Email enviado com ${novas.length} proposições novas.`);
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
  }

  estado.proposicoes_vistas = Array.from(idsVistos);
  estado.ultima_execucao = new Date().toISOString();
  salvarEstado(estado);
})();
