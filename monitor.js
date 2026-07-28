const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const nodemailer = require('nodemailer');

const EMAIL_DESTINO = process.env.EMAIL_DESTINO;
const FIRJAN_DESTINO = process.env.FIRJAN_DESTINO || EMAIL_DESTINO || 'tramitacao@monitorlegislativo.com.br';
const FIRJAN_ASSUNTO_PREFIXO = process.env.FIRJAN_ASSUNTO_PREFIXO || '';
const FIRJAN_EMAIL_DISABLED = process.env.FIRJAN_EMAIL_DISABLED === '1';
const EMAIL_REMETENTE = process.env.EMAIL_REMETENTE;
const EMAIL_SENHA = process.env.EMAIL_SENHA;
const RADAR03_URL = process.env.RADAR03_URL || 'https://doe.monitorlegislativo.com.br/controle03/';
const CASA_RADAR03 = process.env.CASA_RADAR03 || 'RJ - Rio de Janeiro';
const CONTROLE03_STATE_URL = process.env.CONTROLE03_STATE_URL || new URL('api/state', RADAR03_URL).toString();
const CONTROLE03_API_USER = process.env.CONTROLE03_API_USER || '';
const CONTROLE03_API_PASS = process.env.CONTROLE03_API_PASS || '';
const CONTROLE03_BASIC_AUTH = process.env.CONTROLE03_BASIC_AUTH || '';

const ARQUIVO_ESTADO = 'estado.json';
const BACKFILL_DAYS = Number(process.env.BACKFILL_DAYS || '10');
const IGNORE_STATE = process.env.IGNORE_STATE === '1';
const BASE_URL = 'https://aplicnt.camara.rj.gov.br/APL/Legislativos/scpro.nsf';
const LOGO_PATH = path.join(__dirname, 'assets', 'monitor-logo-white.png');
const FIRJAN_LOGO_PATH = path.join(__dirname, 'assets', 'firjan-logo-white.png');
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
let falhasBusca = 0;

function detalharErro(err) {
  return [
    err && err.message,
    err && err.code,
    err && err.cause && err.cause.code,
    err && err.cause && err.cause.message,
  ].filter(Boolean).join(' | ') || String(err);
}

function fetchHtmlViaCurl(url) {
  return new Promise((resolve, reject) => {
    execFile('curl', [
      '-k',
      '-L',
      '--fail',
      '--silent',
      '--show-error',
      '--max-time',
      '12',
      '-A',
      'Mozilla/5.0 (compatible; monitor-cmrj/1.0)',
      '-H',
      'Accept: text/html,application/xhtml+xml',
      url,
    ], { maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.message = [err.message, stderr && stderr.trim()].filter(Boolean).join(' | ');
        reject(err);
        return;
      }
      resolve(stdout);
    });
  });
}

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
  if (n1 <= 12) {
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
        ementa = partes[0].trim();

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
    let html;

    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; monitor-cmrj/1.0)',
          'Accept': 'text/html,application/xhtml+xml',
        },
        signal: AbortSignal.timeout(8000),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      html = await response.text();
    } catch (fetchErr) {
      console.warn(`  ⚠️ Fetch Node falhou para ${tipo.sigla}; tentando curl: ${detalharErro(fetchErr)}`);
      html = await fetchHtmlViaCurl(url);
    }

    const lista = extrairProposicoesDaPagina(html, tipo);
    console.log(`  ✅ ${tipo.sigla}: ${lista.length} proposições encontradas`);

    if (lista.length > 0) {
      const p = lista[0];
      console.log(`     Exemplo: ${p.numero} | ${p.data} | ${p.autor.substring(0, 30)} | ${p.ementa.substring(0, 60)}...`);
    }

    return lista;
  } catch (err) {
    console.error(`  ❌ Erro ao buscar ${tipo.sigla}: ${detalharErro(err)}`);
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

function obterLimiteRecenteBRT(dias) {
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
  const inicio = new Date(hoje);
  inicio.setUTCDate(hoje.getUTCDate() - Math.max(0, dias - 1));
  return { inicio: inicio.getTime(), fim: hoje.getTime() };
}

function estaNoPeriodoRecenteBRT(proposicao) {
  const data = parseDataBR(proposicao.data);
  if (!data) return false;
  const { inicio, fim } = obterLimiteRecenteBRT(BACKFILL_DAYS);
  return data >= inicio && data <= fim;
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
        '<td style="padding:' + ementaPadding + ';border-bottom:1px solid ' + borderColor + ';font-size:' + fontSize + ';line-height:1.45;color:#344054;min-width:360px;width:42%">' + renderizarEmentaCliente(p, destacarTermosFirjan) + '</td>' +
        '<td style="padding:' + padding + ';border-bottom:1px solid ' + borderColor + ';font-size:' + metaFontSize + ';color:#667085">' + escapeHtml(p.autor) + '</td>' +
        '<td style="padding:' + padding + ';border-bottom:1px solid ' + borderColor + ';font-size:' + metaFontSize + '">' + statusMonitorBadge(status) + '</td>' +
        '<td style="padding:' + padding + ';border-bottom:1px solid ' + borderColor + ';font-size:' + metaFontSize + ';background:#fcfcfd;min-width:170px">' + campoObservacaoFirjan() + '</td>' +
      '</tr>';
    }).join('');

    return header + rows;
  }).join('');
}


const CLIENTES_NOMES_PROPRIOS = [
  'FIRJAN', 'Red Bull', 'Sindicerv', 'Boticario',
  'Boticário', 'Grupo Boticario', 'Grupo Boticário', 'O Boticario',
  'O Boticário', 'Abrasel', 'Abrasel PB', 'Abrasel Paraíba',
  'ANBRASEL', 'Ambev', 'Heineken', 'Abralatas',
  'ABIR', 'Coca-Cola', 'Coca Cola', 'Coca-Cola Company',
  'Femsa', 'Solar', 'Grupo Simões', 'Grupo Simoes',
  'Andina', 'CVI', 'iFood', 'Zé Delivery',
  'Ze Delivery', 'Verde Brasil', 'JCRIG', 'Associação dos Cemitérios e Crematórios do Brasil',
  'Associacao dos Cemiterios e Crematorios do Brasil', 'Lalamove', 'Matrix', 'CVC',
  'Rei do Pitaco', 'Maersk', 'Mac Jee', 'Norte Energia',
  'Pacto Pela Fome', 'Sanofi', 'TikTok', 'Minalba',
  'Esmaltec', 'Nacional Gás', 'Nacional Gas', 'Syngenta',
  'Braskem', 'Ypê', 'Ype', 'VTal',
  'V.tal', 'Grupo EPR', 'EPR', 'Natural Energia',
  'DIAGEO', 'Alpargatas', 'Ternium', 'ABRADEE',
  'Eletrobras', 'Eletrobrás', 'MeetKai', 'IPQ',
  'Equatorial', 'EquatorialEnergia', 'Equatorial Energia', 'Equatorial Goiás',
  'Equatorial Goias', 'Equatorial Goiás Distribuidora de Energia', 'Equatorial Goias Distribuidora de Energia', 'CEA Equatorial',
  'CEA Equatorial Energia', 'Equtorial', 'Energisa', 'EnergisaLuz',
  'Neoenergia', 'ENEL', 'Ampla Energia', 'SABESP',
  'COMGAS', 'COMGÁS', 'AEGEA', 'Aegea Saneamento',
  'Águas de Teresina', 'Aguas de Teresina', 'Águas de Timon', 'Aguas de Timon',
  'Águas do Rio', 'Aguas do Rio', 'Águas do Rio 1', 'Águas do Rio 4',
  'Naturgy', 'Agenersa', 'Regenera', 'Comlurb',
  'Hekos', 'Orizon', 'Solvi', 'União Norte',
  'Uniao Norte', 'Vital', 'Eletromidia', 'Eletromídia',
  'AkzoNobel', 'Expedia', 'Hotels.com', 'Vrbo',
  'RTSC', 'Gramado Parks', 'Grupo Wish', 'Huawei',
  'Carrefour', 'Atacadão', 'Atacadao', 'Walmart',
  "Sam's Club", 'Sams Club', 'JBS', 'Friboi',
  'Seara', 'Swift', "Pilgrim's", 'Pilgrims',
  'Wild Fork', 'Ajinomoto', 'Vibra', 'Vibra Energia',
  'BR Distribuidora', 'Raízen', 'Raizen', 'Mindlab',
  'ABVTEX', 'Semove', 'Barcas', 'Seta',
  'Nova Infra', 'BRT', 'Consórcio Maracanã', 'Consorcio Maracana',
  'Maracanã', 'Maracana'
];

function clientesCitadosNaProposicao(p) {
  const texto = [p.cliente, p.clientes, p.autor, p.autores, p.tipo, p.rotulo, p.titulo, p.identificacao, p.ementa]
    .filter(Boolean)
    .join(' ');
  const achados = [];
  for (const nome of CLIENTES_NOMES_PROPRIOS) {
    const escaped = nome.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('(^|[^A-Za-zÀ-ÿ0-9])' + escaped + '([^A-Za-zÀ-ÿ0-9]|$)', 'i');
    if (re.test(texto) && !achados.some(a => a.toLowerCase() === nome.toLowerCase())) achados.push(nome);
  }
  const interesseMaracana = detectarInteresseConsorcioMaracana(texto);
  if (interesseMaracana && !achados.some(a => /maracan/i.test(normalizarTextoCliente(a)))) {
    achados.push('Consórcio Maracanã (interesse por ementa: ' + interesseMaracana + ')');
  }
  return achados;
}

function normalizarTextoCliente(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function detectarInteresseConsorcioMaracana(texto) {
  const t = normalizarTextoCliente(texto);
  const contextoArena = [
    /\barena(s)?\b/,
    /\bestadio(s)?\b/,
    /\bequipamento(s)? esportivo(s)?\b/,
    /\bpratica(s)? esportiva(s)?\b/,
    /\bevento(s)? (esportivo(s)?|cultural(is)?|de grande porte|realizado(s)?)\b/,
    /\bgrande(s)? evento(s)?\b/,
    /\bshow(s)?\b/,
    /\bespetaculo(s)?\b/,
    /\bestabelecimento(s)? publico(s)? e privado(s)? de uso coletivo\b/,
    /\blocal(is)? publico(s)? e privado(s)?\b/,
    /\bespaco(s)? publico(s)? e privado(s)?\b/,
  ];
  const impactoOperacional = [
    /\bbanheiro(s)?\b/,
    /\bsanitario(s)?\b/,
    /\bacesso universal\b/,
    /\bacessibilidade\b/,
    /\bpessoa(s)? com deficiencia\b/,
    /\bpcd\b/,
    /\bseguranca\b/,
    /\bcontrole de acesso\b/,
    /\bcamarote(s)?\b/,
    /\barea(s)? vip\b/,
    /\bestacionamento\b/,
    /\bbebida(s)? alcoolica(s)?\b/,
    /\bprimeiros socorros\b/,
    /\bdesfibrilador\b/,
    /\bvideomonitoramento\b/,
    /\bresiduo(s)?\b/,
    /\blogistica reversa\b/,
  ];
  if (contextoArena.some(re => re.test(t)) && impactoOperacional.some(re => re.test(t))) {
    if (/\bbanheiro(s)?\b|\bsanitario(s)?\b|\bacesso universal\b/.test(t)) return 'sanitários/acesso em local de uso coletivo';
    if (/\bacessibilidade\b|\bpessoa(s)? com deficiencia\b|\bpcd\b/.test(t)) return 'acessibilidade em arena/evento';
    if (/\bseguranca\b|\bcontrole de acesso\b|\bvideomonitoramento\b/.test(t)) return 'segurança/controle operacional de arena';
    if (/\bcamarote(s)?\b|\barea(s)? vip\b/.test(t)) return 'áreas de acesso restrito em eventos';
    return 'operação de arena/evento';
  }
  return '';
}

function anotarClientesCitados(proposicoes) {
  for (const p of proposicoes || []) {
    const clientes = clientesCitadosNaProposicao(p);
    p.clientesCitados = clientes;
    if (clientes.length && p.ementa && !(String(p.ementa).includes('Cliente citado:') || String(p.ementa).includes('CLIENTE CITADO:'))) {
      p.ementa = String(p.ementa).trim() + ' | 🆘 CLIENTE CITADO: ' + clientes.join(', ');
    }
  }
}

function mlEscapeHtmlClienteDestaque(valor) {
  return String(valor ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function mlEscapeRegExpClienteDestaque(valor) {
  return String(valor).replace(/[.*+?^\${}()|[\]\\]/g, '\\$&');
}

function mlDestacarTermosClienteEmail(texto, clientes) {
  const nomes = Array.from(new Set([...(clientes || []), ...CLIENTES_NOMES_PROPRIOS]))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  if (!nomes.length) return mlEscapeHtmlClienteDestaque(texto);

  const regex = new RegExp('(^|[^A-Za-zÀ-ÿ0-9])(' + nomes.map(mlEscapeRegExpClienteDestaque).join('|') + ')(?=[^A-Za-zÀ-ÿ0-9]|$)', 'gi');
  return mlEscapeHtmlClienteDestaque(texto).replace(regex, (match, prefixo, termo) => {
    return prefixo + '<span style="background:#fff1f2;color:#991b1b;font-weight:800;border:1px solid #fecdd3;border-radius:3px;padding:1px 4px">' + termo + '</span>';
  });
}

function renderizarEmentaCliente(p, renderBase) {
  const texto = String((p && p.ementa) || '-');
  const partes = texto.split(/\s+\|\s+(?:🆘\s*)?CLIENTE CITADO:\s+|\s+\|\s+Cliente citado:\s+/i);
  const ementa = renderBase
    ? renderBase(partes[0])
    : mlDestacarTermosClienteEmail(partes[0], p && p.clientesCitados);
  const clientes = partes.length > 1
    ? partes.slice(1).join(' | 🆘 CLIENTE CITADO: ')
    : ((p && p.clientesCitados) || []).join(', ');

  if (!clientes) return ementa;
  return ementa + '<div style="margin-top:6px">' +
    '<span style="display:inline-block;background:#fff1f2;border:1px solid #fb7185;color:#991b1b;border-radius:999px;padding:4px 9px;font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:0">' +
    '🆘 CLIENTE CITADO: ' + mlDestacarTermosClienteEmail(clientes, p && p.clientesCitados) +
    '</span></div>';
}


function radar03Identificacao(p) {
  return String(p?.identificacao ?? p?.proposicao ?? p?.rotulo ?? p?.titulo ?? '').trim();
}

function radar03Tipo(p) {
  const direto = String(p?.tipo ?? p?.sigla ?? '').trim();
  if (direto) return direto;
  const m = radar03Identificacao(p).match(/^([A-Za-zÀ-ÿ0-9.-]+(?:\s+[A-Za-zÀ-ÿ0-9.-]+){0,2})\s+\d/i);
  return m ? m[1].trim() : '';
}

function clientesCitadosResumoEmail(novas) {
  const nomes = [];
  for (const p of novas || []) {
    for (const nome of (Array.isArray(p && p.clientesCitados) ? p.clientesCitados : [])) {
      if (nome && !nomes.some(n => n.toLowerCase() === String(nome).toLowerCase())) nomes.push(String(nome));
    }
  }
  return nomes;
}

function assuntoEmailClienteCitado(novas, assuntoBase) {
  const nomes = clientesCitadosResumoEmail(novas);
  if (!nomes.length) return assuntoBase;
  const lista = nomes.slice(0, 3).join(', ') + (nomes.length > 3 ? ' +' + (nomes.length - 3) : '');
  const base = String(assuntoBase || '');
  return base.startsWith('🆘') ? base : '🆘 🆘 CLIENTE CITADO: ' + lista + ' | ' + base;
}

function radar03Numero(p) {
  const numero = String(p?.numero ?? p?.numero_proposicao ?? p?.num ?? '').trim();
  const ano = String(p?.ano ?? p?.ano_proposicao ?? '').trim();
  if (numero) {
    if (numero.includes('/') || !ano) return numero;
    return numero + '/' + ano;
  }
  const m = radar03Identificacao(p).match(/(S\/N|\d+\s*\/\s*\d{2,4}|\/\d{2,4}|\d+)/i);
  return m ? m[1].replace(/\s+/g, '') : '';
}


function radar03NumeroPartes(p) {
  const numeroRaw = String(p?.numero ?? p?.numero_proposicao ?? p?.num ?? '').trim();
  const anoRaw = String(p?.ano ?? p?.ano_proposicao ?? '').trim();
  if (!numeroRaw) return null;

  const match = numeroRaw.match(/^(\d+)\s*\/\s*(\d{2,4})$/);
  const numero = match ? match[1] : numeroRaw;
  const ano = match ? match[2] : anoRaw;
  const numeroInt = parseInt(numero, 10);
  if (!Number.isFinite(numeroInt)) return null;

  return {
    numero,
    numeroInt,
    ano: ano && ano.length === 2 ? '20' + ano : ano,
  };
}


function radar03BlocoEmail(novas) {
  return radar03AgruparNovidades(novas)
    .map(item => item.tipo + ' ' + item.numero + (item.ano ? '/' + item.ano : ''))
    .join(' | ');
}

function radar03PrimeiraFonte(novas) {
  const item = (novas || []).find(p => p?.link || p?.url || p?.fonte || p?.projeto_url);
  return item ? String(item.link || item.url || item.fonte || item.projeto_url || '') : '';
}


function radar03TipoControle(tipo) {
  const normal = String(tipo || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
  const mapa = {
    'PROJETO DE LEI': 'PL', 'PROJETO LEI': 'PL', 'PROJETO DE LEI ORDINARIA': 'PL', 'PLO': 'PL', 'PL': 'PL', 'PL - PROJETO DE LEI': 'PL', 'PL PROJETO DE LEI': 'PL',
    'PROJETO DE LEI COMPLEMENTAR': 'PLC', 'PLC': 'PLC', 'PLC - PROJETO DE LEI COMPLEMENTAR': 'PLC', 'PLC PROJETO DE LEI COMPLEMENTAR': 'PLC',
    'PROPOSTA DE EMENDA A CONSTITUICAO': 'PEC', 'PEC': 'PEC', 'PEC - PROPOSTA DE EMENDA CONSTITUCIONAL': 'PEC', 'PEC PROPOSTA DE EMENDA CONSTITUCIONAL': 'PEC',
    'PROJETO DE DECRETO LEGISLATIVO': 'PDL', 'PDL': 'PDL',
    'PROJETO DE RESOLUCAO': 'PR', 'PR': 'PR',
    'PROJETO DE INDICACAO': 'PIL', 'PIL': 'PIL', 'PIL - PROJETO DE INDICACAO': 'PIL', 'PIL PROJETO DE INDICACAO': 'PIL',
    'INDICACAO': 'IND', 'MOCAO': 'MOC', 'REQUERIMENTO': 'REQ', 'REQ.': 'REQ',
    'REQUERIMENTO DE INFORMACAO': 'REQINF', 'RI': 'REQINF', 'VETO': 'VETO',
  };
  return mapa[normal] || String(tipo || '').trim().toUpperCase();
}

function radar03DiaUtilAtual() {
  const w = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', weekday: 'short' }).format(new Date());
  const d = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[w] || 0;
  if (d === 0 || d === 6) return 4;
  return Math.max(0, Math.min(4, d - 1));
}

function radar03AuthHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  const token = CONTROLE03_BASIC_AUTH || (
    CONTROLE03_API_USER && CONTROLE03_API_PASS
      ? Buffer.from(CONTROLE03_API_USER + ':' + CONTROLE03_API_PASS).toString('base64')
      : ''
  );
  if (token) headers.Authorization = token.startsWith('Basic ') ? token : 'Basic ' + token;
  return headers;
}

function radar03AgruparNovidades(novas) {
  const porTipo = new Map();
  (novas || []).forEach(p => {
    const tipo = radar03TipoControle(p?.tipo || p?.sigla || p?.rotulo || '');
    const partes = radar03NumeroPartes(p);
    if (!tipo || !partes) return;
    const itemCaptado = {
      tipo,
      numeroInt: partes.numeroInt,
      numero: partes.numero,
      ano: partes.ano || String(p?.ano || ''),
      id: String(p?.id || p?.codigo || p?.projeto_id || p?.id_proposicao || ''),
      ementa: String(p?.ementa || p?.resumo || p?.titulo || '').trim(),
      link: String(p?.link || p?.url || p?.fonte || p?.projeto_url || '').trim(),
      clienteSugestao: Array.isArray(p?.clientesCitados) ? p.clientesCitados.join(', ') : '',
      clienteCitado: Array.isArray(p?.clientesCitados) && p.clientesCitados.length > 0,
      clienteCitadoNomes: Array.isArray(p?.clientesCitados) ? p.clientesCitados.join(', ') : '',
    };
    let atual = porTipo.get(tipo);
    if (!atual) {
      atual = { ...itemCaptado, itens: [] };
      porTipo.set(tipo, atual);
    }
    atual.itens.push(itemCaptado);
    if (partes.numeroInt > atual.numeroInt) {
      atual.numeroInt = partes.numeroInt;
      atual.numero = partes.numero;
      atual.ano = partes.ano || String(p?.ano || '');
      atual.id = itemCaptado.id;
      atual.ementa = itemCaptado.ementa;
      atual.link = itemCaptado.link;
      atual.clienteSugestao = itemCaptado.clienteSugestao;
    }
  });
  return Array.from(porTipo.values()).map(rec => {
    rec.itens.sort((a, b) => a.numeroInt - b.numeroInt);
    return rec;
  });
}

async function sincronizarRadar03(novas) {
  const resumo = radar03AgruparNovidades(novas);
  if (!resumo.length) return;
  try {
    const getResp = await fetch(CONTROLE03_STATE_URL, { headers: radar03AuthHeaders() });
    if (!getResp.ok) throw new Error('GET ' + getResp.status);
    const state = await getResp.json();
    if (!Array.isArray(state.data)) throw new Error('estado central vazio ou inválido');

    const data = state.data;
    let casa = data.find(item => item && item.casa === CASA_RADAR03);
    if (!casa) {
      casa = { casa: CASA_RADAR03, casaId: CASA_RADAR03, regiao: '', responsavel: '', risco: 'media', status: 'A conferir', week: ['off', 'off', 'off', 'off', 'off'], items: [] };
      data.push(casa);
    }
    if (!Array.isArray(casa.items)) casa.items = [];
    if (!Array.isArray(casa.week)) casa.week = ['off', 'off', 'off', 'off', 'off'];
    while (casa.week.length < 5) casa.week.push('off');

    resumo.forEach(rec => {
      const detalhes = [rec];
      const existentesTipo = casa.items.filter(i => radar03TipoControle(i?.tipo || '') === rec.tipo);
      const baseAtual = existentesTipo.reduce((max, i) => {
        const n = Number.parseInt(String(i?.base || i?.mon || 0), 10) || 0;
        return Math.max(max, n);
      }, 0);

      detalhes.forEach(det => {
        let item = casa.items.find(i =>
          (det.id && i?.radar03Id === det.id) ||
          (radar03TipoControle(i?.tipo || '') === det.tipo &&
            Number.parseInt(String(i?.mon || 0), 10) === det.numeroInt &&
            String(i?.link || '') === String(det.link || ''))
        );
        if (!item) {
          item = casa.items.find(i => radar03TipoControle(i?.tipo || '') === det.tipo);
        }
        if (!item) {
          item = { tipo: det.tipo, base: baseAtual, mon: det.numeroInt, radar03Id: det.id || '' };
          casa.items.push(item);
        }

        const base = Number.parseInt(String(item.base || baseAtual || 0), 10) || 0;
        item.tipo = det.tipo;
        item.mon = det.numeroInt;
        item.delta = det.numeroInt === base ? 0 : 1;
        item.sentido = det.numeroInt === base ? 'bate com o controle' : 'captado individualmente na fonte';
        item.fluxo = item.delta ? 'nao_consultado' : (item.fluxo || 'revisado');
        item.ementa = det.ementa || item.ementa || '';
        item.link = det.link || item.link || '';
        item.clienteSugestao = det.clienteSugestao || item.clienteSugestao || '';
        item.clienteCitado = Boolean(det.clienteCitado || item.clienteCitado);
        item.clienteCitadoNomes = det.clienteCitadoNomes || item.clienteCitadoNomes || item.clienteSugestao || '';
        item.radar03Id = det.id || item.radar03Id || '';
        item.listaReal03 = true;
      });
    });

    casa.status = 'Atualizar 03';
    casa.week[radar03DiaUtilAtual()] = 'leva';
    if (!Array.isArray(casa.obs03)) casa.obs03 = [];
    casa.obs03.push({
      tipo: CASA_RADAR03,
      situacao: 'novo',
      label: 'Rodada sincronizada automaticamente na 03',
      base: resumo.map(item => item.tipo + ' ' + item.numero + (item.ano ? '/' + item.ano : '')).join(' | '),
      fonte: 'monitor-proposicoes',
      at: new Date().toISOString(),
    });

    const postResp = await fetch(CONTROLE03_STATE_URL, {
      method: 'POST', headers: radar03AuthHeaders(), body: JSON.stringify({ data }),
    });
    if (!postResp.ok) throw new Error('POST ' + postResp.status);
    console.log('✅ Radar 03 sincronizado: ' + CASA_RADAR03 + ' · ' + resumo.map(item => item.tipo + ' ' + item.numero + '/' + item.ano).join(' | '));
  } catch (err) {
    console.warn('⚠️ Não foi possível sincronizar o Radar 03 automaticamente: ' + err.message);
  }
}

function radar03ReviewUrl(novas) {
  const params = new URLSearchParams({ casa: CASA_RADAR03, bloco: radar03AgruparNovidades(novas).map(item => item.tipo + ' ' + item.numero + (item.ano ? '/' + item.ano : '')).join(' | '), fonte: radar03PrimeiraFonte(novas) });
  return `${RADAR03_URL}?${params.toString()}`;
}


function radar03SemNovidadeUrl() {
  const params = new URLSearchParams({
    casa: CASA_RADAR03,
    situacao: 'sem_novidade',
    fonte: 'monitor-proposicoes',
  });
  return RADAR03_URL + '?' + params.toString();
}

function radar03Escape(valor) {
  return String(valor ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}


function renderRadar03SemNovidadeEmailButton() {
  return '\n    <div style="background:#f8fafc;border:1px solid #cbd5e1;border-radius:6px;padding:12px 14px;margin:14px 0;color:#334155;font-size:13px">\n      <div style="font-weight:bold;margin-bottom:6px">Radar 03 | Sem novidades</div>\n      <div style="margin-bottom:9px;color:#475569">' + radar03Escape(CASA_RADAR03) + ' · fonte vista sem proposição nova nesta rodada</div>\n      <a href="' + radar03Escape(radar03SemNovidadeUrl()) + '" style="display:inline-block;background:#475569;color:white;text-decoration:none;border-radius:4px;padding:8px 11px;font-size:12px;font-weight:bold">Marcar sem novidade na 03</a>\n      <span style="font-size:12px;color:#64748b;margin-left:8px">abre a 03 pronta para fechar o dia</span>\n    </div>\n  ';
}

function renderRadar03EmailButton(novas) {
  const bloco = radar03BlocoEmail(novas);
  if (!bloco) return renderRadar03SemNovidadeEmailButton();
  return `
    <div style="background:#ecfdf3;border:1px solid #bbf7d0;border-radius:6px;padding:12px 14px;margin:14px 0;color:#14532d;font-size:13px">
      <div style="font-weight:bold;margin-bottom:6px">Radar 03 | Novas Proposições</div>
      <div style="margin-bottom:9px;color:#166534">${radar03Escape(CASA_RADAR03)} · ${radar03Escape(bloco)}</div>
      <a href="${radar03Escape(radar03ReviewUrl(novas))}" style="display:inline-block;background:#166534;color:white;text-decoration:none;border-radius:4px;padding:8px 11px;font-size:12px;font-weight:bold">Revisar no Radar 03</a>
      <span style="font-size:12px;color:#64748b;margin-left:8px">abre preenchido para confirmação</span>
    </div>
  `;
}


async function enviarEmail(novas) {
  const envioInterno = FIRJAN_EMAIL_DISABLED;
  anotarClientesCitados(novas);
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: EMAIL_REMETENTE, pass: EMAIL_SENHA },
  });

  const linhas = montarLinhasPorData(novas);
  const intervaloSemana = obterIntervaloSemanaBRT();
  const destinatario = envioInterno ? (EMAIL_DESTINO || 'tramitacao@monitorlegislativo.com.br') : FIRJAN_DESTINO;
  const titulo = envioInterno ? 'CMRJ — Proposições novas' : 'FIRJAN | CMRJ — Novas proposições';
  const subtitulo = envioInterno ? 'Rodada diária interna' : 'Rodada semanal';
  const instrucao = envioInterno
    ? 'Email operacional para a equipe de tramitação. O consolidado FIRJAN de sexta é produto separado.'
    : 'Marquem os projetos que querem monitorar. Quando o projeto já estiver no Monitor ou já estiver em FIRJAN, o status aparece na linha.';
  const assunto = envioInterno
    ? 'CMRJ | Proposições novas — ' + formatarDataBRT()
    : FIRJAN_ASSUNTO_PREFIXO + 'FIRJAN | Rio de Janeiro - Câmara Municipal — Novas proposições ' + intervaloSemana;

  const html = [
    renderRadar03EmailButton(novas),
    '<div style="font-family:Arial,sans-serif;max-width:1180px;margin:0 auto;background:#ffffff;color:#111827">',
    '<div style="background:#0f3357;padding:16px 22px;border-radius:12px 12px 0 0;color:#ffffff">',
    '<table role="presentation" style="width:100%;border-collapse:collapse"><tr>',
    '<td style="vertical-align:middle;text-align:left"><img src="cid:monitorLogo" alt="Monitor Legislativo" style="height:54px;vertical-align:middle"></td>',
    envioInterno ? '<td></td>' : '<td style="vertical-align:middle;text-align:right"><img src="cid:firjanLogo" alt="Firjan" style="height:42px;vertical-align:middle"></td>',
    '</tr></table>',
    '<div style="font-size:13px;color:#d7e5f2;margin-top:8px">Proposições novas • Câmara Municipal do Rio de Janeiro</div>',
    '</div>',
    '<div style="border:1px solid #d7dde7;border-top:0;padding:18px;border-radius:0 0 12px 12px">',
    '<h2 style="color:#111827;margin:0 0 6px 0;font-size:22px">' + titulo + '</h2>',
    '<p style="color:#526070;margin:0 0 14px 0;font-size:13px">' + subtitulo + ' • ' + intervaloSemana + ' • gerado em ' + formatarDataHoraBRT() + ' BRT</p>',
    '<p style="background:#eef6ff;border:1px solid #c7ddf2;color:#173d63;padding:10px 12px;border-radius:8px;font-weight:bold;margin:0 0 12px 0">' + novas.length + ' proposição(ões) nova(s) localizada(s) na Câmara do Rio, separadas por data de apresentação e status no Monitor</p>',
    '<div style="margin:0 0 12px;color:#526070;font-size:12px;line-height:1.4">' + instrucao + '</div>',
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
    to: destinatario,
    subject: assuntoEmailClienteCitado(novas, assunto),
    html,
    attachments: [
      ...(fs.existsSync(LOGO_PATH) ? [{ filename: 'monitor-logo-white.png', path: LOGO_PATH, cid: 'monitorLogo' }] : []),
      ...(!envioInterno && fs.existsSync(FIRJAN_LOGO_PATH) ? [{ filename: 'firjan-logo-white.png', path: FIRJAN_LOGO_PATH, cid: 'firjanLogo' }] : []),
    ],
  });

  console.log('✅ Email ' + (envioInterno ? 'interno' : 'FIRJAN') + '/CMRJ enviado para ' + destinatario + ' com ' + novas.length + ' proposições novas.');
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
      console.warn(`⚠️ Fonte indisponível: ${falhasBusca} tipo(s) tiveram erro de busca. Encerrando sem alterar estado para evitar alerta vermelho repetido.`);
      process.exit(0);
    }
    process.exit(0);
  }

  // Filtro A: só ano corrente
  const anoAtual = String(new Date().getFullYear());
  const doAnoAtual = todas.filter(p => p.ano === anoAtual);
  console.log(`\n📊 Total encontrado: ${todas.length} | Do ano ${anoAtual}: ${doAnoAtual.length}`);

  const recentes = doAnoAtual.filter(estaNoPeriodoRecenteBRT);
  console.log(`📅 Últimos ${BACKFILL_DAYS} dia(s): ${recentes.length}`);

  const elegiveis = recentes.filter(p => !deveExcluirDoEmail(p.sigla));
  console.log(`🗓️ Elegíveis para envio: ${elegiveis.length}`);

  const pacoteSemanal = elegiveis.filter(p => IGNORE_STATE || !idsVistos.has(p.id));
  console.log(`🆕 Novas ainda não vistas: ${pacoteSemanal.length}`);

  if (pacoteSemanal.length > 0) {
    const pacoteEnriquecido = await enriquecerComMonitor(pacoteSemanal);
    await sincronizarRadar03(novas);
    await enviarEmail(pacoteEnriquecido);
    pacoteSemanal.forEach(p => idsVistos.add(p.id));
  } else {
    console.log('✅ Sem proposições na semana atual. Nada a enviar.');
  }

  elegiveis.forEach(p => idsVistos.add(p.id));
  estado.proposicoes_vistas = Array.from(idsVistos);
  estado.ultima_execucao = new Date().toISOString();
  salvarEstado(estado);
})();
