const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

const EMAIL_DESTINO = process.env.EMAIL_DESTINO;
const FIRJAN_DESTINO = process.env.FIRJAN_DESTINO || EMAIL_DESTINO || 'tramitacao@monitorlegislativo.com.br';
const FIRJAN_ASSUNTO_PREFIXO = process.env.FIRJAN_ASSUNTO_PREFIXO || '';
const EMAIL_REMETENTE = process.env.EMAIL_REMETENTE;
const EMAIL_SENHA = process.env.EMAIL_SENHA;
const ARQUIVO_ESTADO = 'estado.json';
const BASE_URL = 'https://aplicnt.camara.rj.gov.br/APL/Legislativos/scpro.nsf';
const LOGO_PATH = path.join(__dirname, 'assets', 'monitor-logo-white.png');
const FIRJAN_LOGO_PATH = path.join(__dirname, 'assets', 'firjan-logo-white.png');
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

const ORDEM_TIPOS_EMAIL = ['PEC', 'PLC', 'PL'];
const TIPOS_RESUMO_EMAIL = new Set(['IND-L', 'IND', 'MOC', 'REQ', 'REQ-I', 'REQ-SN']);
const TIPOS_EXCLUIDOS_EMAIL = new Set(['IND-L', 'IND', 'MOC', 'REQ', 'REQ-I', 'REQ-SN']);

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

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function siglaEmail(sigla) {
  return sigla === 'PELO' ? 'PEC' : sigla;
}

function ordemTipoEmail(sigla) {
  const normalizada = siglaEmail(sigla);
  const prioridade = ORDEM_TIPOS_EMAIL.indexOf(normalizada);
  if (prioridade !== -1) return prioridade;

  const ordemOriginal = TIPOS.findIndex(t => t.sigla === sigla);
  return 100 + (ordemOriginal === -1 ? 999 : ordemOriginal);
}

function ehTipoResumoEmail(sigla) {
  return TIPOS_RESUMO_EMAIL.has(sigla);
}

function deveExcluirDoEmail(sigla) {
  return TIPOS_EXCLUIDOS_EMAIL.has(sigla);
}

function contemDestaqueFirjan(texto) {
  return /FIRJAN|Federa(?:ç|c)ão das Ind(?:ú|u)strias(?: do Estado)? do Rio de Janeiro|Federa(?:ç|c)ão das Ind(?:ú|u)strias do RJ|Federa(?:ç|c)ão das Ind\.? do RJ/i.test(String(texto || ''));
}

function destacarTermosFirjan(texto) {
  let html = escapeHtml(texto);
  [
    /FIRJAN/gi,
    /Federa(?:ç|c)ão das Ind(?:ú|u)strias(?: do Estado)? do Rio de Janeiro/gi,
    /Federa(?:ç|c)ão das Ind(?:ú|u)strias do RJ/gi,
    /Federa(?:ç|c)ão das Ind\.? do RJ/gi,
  ].forEach(regex => {
    html = html.replace(regex, '<strong style="background:#fff3b0;color:#7a4d00;padding:1px 3px;border-radius:3px">$&</strong>');
  });
  return html;
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

function parseDataBR(data) {
  const match = String(data || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return 0;
  return Date.UTC(Number(match[3]), Number(match[2]) - 1, Number(match[1]));
}

function compararDataBR(a, b) {
  return parseDataBR(a) - parseDataBR(b);
}

function obterLimitesSemanaBRT() {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date()).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});

  const hoje = new Date(Date.UTC(Number(partes.year), Number(partes.month) - 1, Number(partes.day)));
  const diaSemana = hoje.getUTCDay() || 7;
  const segunda = new Date(hoje);
  segunda.setUTCDate(hoje.getUTCDate() - diaSemana + 1);
  const sexta = new Date(segunda);
  sexta.setUTCDate(segunda.getUTCDate() + 4);

  return { segunda, sexta };
}

function obterIntervaloSemanaBRT() {
  const { segunda, sexta } = obterLimitesSemanaBRT();
  const fmt = new Intl.DateTimeFormat('pt-BR', { timeZone: 'UTC' });
  return 'de ' + fmt.format(segunda) + ' a ' + fmt.format(sexta);
}

function estaNaSemanaAtualBRT(proposicao) {
  const data = parseDataBR(proposicao.data);
  if (!data) return false;
  const { segunda, sexta } = obterLimitesSemanaBRT();
  return data >= segunda.getTime() && data <= sexta.getTime();
}

function agruparPorData(proposicoes) {
  return proposicoes.reduce((acc, p) => {
    const data = p.data && p.data !== '-' ? p.data : 'Data não informada';
    if (!acc[data]) acc[data] = [];
    acc[data].push(p);
    return acc;
  }, {});
}

function numeroOrdenavel(numero) {
  const match = String(numero || '').match(/\d+/);
  return match ? Number(match[0]) : 0;
}

function statusMonitorBadge(status) {
  if (status === 'monitorado_firjan') {
    return '<span style="display:inline-block;padding:4px 8px;border-radius:999px;font-size:11px;font-weight:700;background:#eef4ff;color:#3538cd;border:1px solid #c7d7fe;white-space:nowrap">Já FIRJAN</span>';
  }
  if (status === 'monitor_outro_cliente') {
    return '<span style="display:inline-block;padding:4px 8px;border-radius:999px;font-size:11px;font-weight:700;background:#ecfdf3;color:#027a48;border:1px solid #abefc6;white-space:nowrap">No Monitor, não FIRJAN</span>';
  }
  if (status === 'fora_base') {
    return '<span style="display:inline-block;padding:4px 8px;border-radius:999px;font-size:11px;font-weight:700;background:#fffbeb;color:#b54708;border:1px solid #fedf89;white-space:nowrap">Ainda fora da base</span>';
  }
  return '<span style="display:inline-block;padding:4px 8px;border-radius:999px;font-size:11px;font-weight:700;background:#f2f4f7;color:#475467;border:1px solid #d0d5dd;white-space:nowrap">A cruzar</span>';
}

function observacaoFirjan(status) {
  if (status === 'monitorado_firjan') return 'Já incorporado para FIRJAN';
  return '';
}

function observacaoEmail(proposicao, status) {
  const observacoes = [];
  const obsStatus = observacaoFirjan(status);
  if (obsStatus) observacoes.push(obsStatus);
  if (contemDestaqueFirjan(proposicao.ementa)) observacoes.push('Destaque: FIRJAN citada na ementa');
  return observacoes.join(' | ');
}

function campoObservacaoFirjan() {
  return '<div style="min-height:34px;border:1px solid #d0d5dd;background:#ffffff;border-radius:6px">&nbsp;</div>';
}

function normalizarNumeroMonitor(numero) {
  const match = String(numero || '').match(/\d+/);
  return match ? match[0] : String(numero || '');
}

function tipoMonitor(sigla) {
  if (sigla === 'PELO') return 'PEC';
  if (sigla === 'IND-L') return 'IND';
  if (sigla && sigla.startsWith('REQ')) return 'REQ';
  return sigla || '';
}

async function loginMonitor() {
  const user = process.env.MONITOR_USER || '';
  const pass = process.env.MONITOR_PASS || '';
  const monitorUrl = process.env.MONITOR_URL || 'https://monitorlegislativo.com.br';
  if (!user || !pass) return '';

  const resp = await fetch(monitorUrl + '/app/entrar/entra.php', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer': monitorUrl + '/app/entrar/',
    },
    body: new URLSearchParams({ usuario: user, senha: pass }),
    redirect: 'manual',
    signal: AbortSignal.timeout(15000),
  });

  const cookie = resp.headers.get('set-cookie') || '';
  return cookie.split(',').map(part => part.split(';')[0].trim()).filter(Boolean).join('; ');
}

async function buscarMonitorItem(item, cookie, codCliente) {
  if (!cookie) return null;

  const monitorUrl = process.env.MONITOR_URL || 'https://monitorlegislativo.com.br';
  const params = new URLSearchParams({
    numero: normalizarNumeroMonitor(item.numero),
    ano: String(item.ano || '').slice(0, 4),
    casa: 'RJ',
    tipo: tipoMonitor(item.sigla),
    texto: '',
    status: '',
    municipio: 'Rio de Janeiro',
    sem_cliente: 'false',
    tempo_real: 'false',
    cod_cliente: codCliente || '',
    order_type: '',
  });

  const resp = await fetch(monitorUrl + '/app/proposicoes2/estados-municipios/lista.php?' + params.toString(), {
    headers: { Cookie: cookie, Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });

  if (!resp.ok) return null;
  const data = await resp.json().catch(() => null);
  return Array.isArray(data) && data.length ? data[0] : null;
}

async function enriquecerComMonitor(proposicoes) {
  let cookie = '';
  try {
    cookie = await loginMonitor();
  } catch (err) {
    console.warn('⚠️ Não foi possível autenticar no Monitor para cruzamento: ' + err.message);
  }

  if (!cookie) {
    console.warn('⚠️ Cruzamento com Monitor não executado: MONITOR_USER/MONITOR_PASS ausentes ou login sem cookie.');
    return proposicoes.map(p => ({ ...p, status_firjan: 'pendente_cruzamento' }));
  }

  const enriquecidas = [];
  for (const item of proposicoes) {
    try {
      const geral = await buscarMonitorItem(item, cookie, '');
      const firjan = await buscarMonitorItem(item, cookie, process.env.FIRJAN_CLIENTE_ID || '57');
      let status = 'fora_base';
      if (firjan) status = 'monitorado_firjan';
      else if (geral) status = 'monitor_outro_cliente';
      enriquecidas.push({ ...item, status_firjan: status, monitor_geral: geral, monitor_firjan: firjan });
    } catch (err) {
      console.warn('⚠️ Falha no cruzamento Monitor para ' + item.sigla + ' ' + item.numero + '/' + item.ano + ': ' + err.message);
      enriquecidas.push({ ...item, status_firjan: 'pendente_cruzamento' });
    }
  }

  return enriquecidas;
}

function montarLinhasPorData(proposicoes) {
  const porData = agruparPorData(proposicoes);
  const datasOrdenadas = Object.keys(porData).sort(compararDataBR);
  let ordinal = 0;

  return datasOrdenadas.map(data => {
    const grupo = porData[data].sort((a, b) => {
      const tipoA = ordemTipoEmail(a.sigla);
      const tipoB = ordemTipoEmail(b.sigla);
      if (tipoA !== tipoB) return tipoA - tipoB;
      return numeroOrdenavel(b.numero) - numeroOrdenavel(a.numero);
    });

    const header = '<tr>' +
      '<td colspan="8" style="padding:12px 10px 6px;background:#e8eef5;font-weight:bold;color:#1a3a5c;font-size:14px;border-top:3px solid #1a3a5c">' +
      'Apresentadas em ' + escapeHtml(data) + ' — ' + grupo.length + ' proposição(ões)' +
      '</td></tr>';

    const rows = grupo.map(p => {
      ordinal += 1;
      const status = p.status_firjan || 'pendente_cruzamento';
      const checked = status === 'monitorado_firjan' ? ' checked disabled' : '';
      const numero = escapeHtml(p.numero);
      const link = p.url ? '<a href="' + escapeHtml(p.url) + '" style="color:#1a3a5c;text-decoration:none"><strong>' + numero + '</strong></a>' : '<strong>' + numero + '</strong>';
      const destaqueFirjan = contemDestaqueFirjan(p.ementa);
      const resumo = ehTipoResumoEmail(p.sigla);
      const rowStyle = destaqueFirjan ? ' style="background:#fffdf3"' : (resumo ? ' style="background:#fbfcfe"' : '');
      const padding = resumo ? '7px 8px' : '8px';
      const ementaPadding = resumo ? '7px 10px' : '10px 12px';
      const fontSize = resumo ? '12px' : '14px';
      const metaFontSize = resumo ? '11px' : '12px';
      const badgeFontSize = resumo ? '10px' : '11px';
      const checkboxSize = resumo ? '17px' : '18px';
      const borderColor = resumo ? '#eef2f6' : '#eee';

      return '<tr' + rowStyle + '>' +
        '<td style="padding:' + padding + ';border-bottom:1px solid ' + borderColor + ';color:#667085;font-size:' + metaFontSize + ';text-align:center;font-weight:bold">' + ordinal + '</td>' +
        '<td style="padding:' + padding + ';border-bottom:1px solid ' + borderColor + ';text-align:center"><input type="checkbox"' + checked + ' style="width:' + checkboxSize + ';height:' + checkboxSize + '"></td>' +
        '<td style="padding:' + padding + ';border-bottom:1px solid ' + borderColor + ';color:#555;font-size:' + metaFontSize + ';white-space:nowrap"><span style="display:inline-block;padding:3px 7px;border-radius:999px;font-size:' + badgeFontSize + ';font-weight:700;background:#eef4ff;color:#3538cd;border:1px solid #c7d7fe;white-space:nowrap">' + escapeHtml(siglaEmail(p.sigla)) + '</span></td>' +
        '<td style="padding:' + padding + ';border-bottom:1px solid ' + borderColor + ';white-space:nowrap;font-size:' + fontSize + '">' + link + '</td>' +
        '<td style="padding:' + ementaPadding + ';border-bottom:1px solid ' + borderColor + ';font-size:' + fontSize + ';line-height:1.45;color:#344054;min-width:360px;width:42%">' + destacarTermosFirjan(p.ementa) + '</td>' +
        '<td style="padding:' + padding + ';border-bottom:1px solid ' + borderColor + ';font-size:' + metaFontSize + ';color:#667085">' + escapeHtml(p.autor) + '</td>' +
        '<td style="padding:' + padding + ';border-bottom:1px solid ' + borderColor + ';font-size:' + metaFontSize + '">' + statusMonitorBadge(status) + '</td>' +
        '<td style="padding:' + padding + ';border-bottom:1px solid ' + borderColor + ';font-size:' + metaFontSize + ';background:#fcfcfd;min-width:170px">' + campoObservacaoFirjan() + '</td>' +
      '</tr>';
    }).join('');

    return header + rows;
  }).join('');
}

async function enviarEmail(novas) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: EMAIL_REMETENTE, pass: EMAIL_SENHA },
  });

  const linhas = montarLinhasPorData(novas);
  const intervaloSemana = obterIntervaloSemanaBRT();

  const html = [
    '<div style="font-family:Arial,sans-serif;max-width:1180px;margin:0 auto;background:#ffffff;color:#111827">',
    '<div style="background:#0f3357;padding:16px 22px;border-radius:12px 12px 0 0;color:#ffffff">',
    '<table role="presentation" style="width:100%;border-collapse:collapse"><tr>',
    '<td style="vertical-align:middle;text-align:left"><img src="cid:monitorLogo" alt="Monitor Legislativo" style="height:54px;vertical-align:middle"></td>',
    '<td style="vertical-align:middle;text-align:right"><img src="cid:firjanLogo" alt="Firjan" style="height:42px;vertical-align:middle"></td>',
    '</tr></table>',
    '<div style="font-size:13px;color:#d7e5f2;margin-top:8px">Proposições novas • Câmara Municipal do Rio de Janeiro</div>',
    '</div>',
    '<div style="border:1px solid #d7dde7;border-top:0;padding:18px;border-radius:0 0 12px 12px">',
    '<h2 style="color:#111827;margin:0 0 6px 0;font-size:22px">FIRJAN | CMRJ — Novas proposições</h2>',
    '<p style="color:#526070;margin:0 0 14px 0;font-size:13px">Rodada semanal • ' + intervaloSemana + ' • gerado em ' + formatarDataHoraBRT() + ' BRT</p>',
    '<p style="background:#eef6ff;border:1px solid #c7ddf2;color:#173d63;padding:10px 12px;border-radius:8px;font-weight:bold;margin:0 0 12px 0">' + novas.length + ' proposição(ões) nova(s) localizada(s) na Câmara do Rio, separadas por data de apresentação e status no Monitor</p>',
    '<div style="margin:0 0 12px;color:#526070;font-size:12px;line-height:1.4">Marquem os projetos que querem monitorar. Quando o projeto já estiver no Monitor ou já estiver em FIRJAN, o status aparece na linha.</div>',
    '<table style="width:100%;border-collapse:collapse;font-size:13px;table-layout:auto">',
    '<thead><tr style="background:#1a3a5c;color:white">',
    '<th style="padding:10px;text-align:left">Item</th>',
    '<th style="padding:10px;text-align:left">Marcar</th>',
    '<th style="padding:10px;text-align:left">Tipo</th>',
    '<th style="padding:10px;text-align:left">Projeto</th>',
    '<th style="padding:10px;text-align:left">Ementa</th>',
    '<th style="padding:10px;text-align:left">Autor</th>',
    '<th style="padding:10px;text-align:left">Status Monitor</th>',
    '<th style="padding:10px;text-align:left">Observação FIRJAN</th>',
    '</tr></thead>',
    '<tbody>' + linhas + '</tbody>',
    '</table>',
    '<p style="margin-top:20px;font-size:12px;color:#999">Acesse: <a href="https://www.camara.rio/atividade-parlamentar/processo-legislativo/pl">camara.rio</a></p>',
    '<hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0">',
    '<p style="font-size:12px;color:#64748b;margin:0">Monitor Legislativo — acompanhamento legislativo estadual e municipal. Horário sempre em BRT.</p>',
    '</div></div>'
  ].join('');

  await transporter.sendMail({
    from: '"Monitor Legislativo" <' + EMAIL_REMETENTE + '>',
    to: FIRJAN_DESTINO,
    subject: FIRJAN_ASSUNTO_PREFIXO + 'FIRJAN | CMRJ — Novas proposições ' + intervaloSemana,
    html,
    attachments: [
      ...(fs.existsSync(LOGO_PATH) ? [{ filename: 'monitor-logo-white.png', path: LOGO_PATH, cid: 'monitorLogo' }] : []),
      ...(fs.existsSync(FIRJAN_LOGO_PATH) ? [{ filename: 'firjan-logo-white.png', path: FIRJAN_LOGO_PATH, cid: 'firjanLogo' }] : []),
    ],
  });

  console.log('✅ Email FIRJAN/CMRJ enviado para ' + FIRJAN_DESTINO + ' com ' + novas.length + ' proposições novas.');
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

  const daSemana = doAnoAtual.filter(estaNaSemanaAtualBRT);
  console.log(`📅 Da semana atual (seg-sex): ${daSemana.length}`);

  const pacoteSemanal = daSemana.filter(p => !deveExcluirDoEmail(p.sigla));
  console.log(`🗓️ Pacote semanal para envio: ${pacoteSemanal.length}`);

  if (pacoteSemanal.length > 0) {
    const pacoteEnriquecido = await enriquecerComMonitor(pacoteSemanal);
    await enviarEmail(pacoteEnriquecido);
    pacoteSemanal.forEach(p => idsVistos.add(p.id));
  } else {
    console.log('✅ Sem proposições na semana atual. Nada a enviar.');
    if (process.env.ALERTAR_SEM_NOVIDADES === '1') {
      console.error('❌ Sem proposições na semana atual em dia útil monitorado. Gerando alerta interno.');
      estado.proposicoes_vistas = Array.from(idsVistos);
      estado.ultima_execucao = new Date().toISOString();
      salvarEstado(estado);
      process.exit(2);
    }
  }

  doAnoAtual.forEach(p => idsVistos.add(p.id));
  estado.proposicoes_vistas = Array.from(idsVistos);
  estado.ultima_execucao = new Date().toISOString();
  salvarEstado(estado);
})();
