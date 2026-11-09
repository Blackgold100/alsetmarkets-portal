// Supported networks, address/hash validation and block-explorer links.
const QRCode = require('qrcode');

const B58 = '[1-9A-HJ-NP-Za-km-z]';
const NETWORKS = {
  TRC20:   { name: 'Tron (TRC20)',            address: new RegExp(`^T${B58}{33}$`),     hash: /^(0x)?[0-9a-fA-F]{64}$/, tx: 'https://tronscan.org/#/transaction/', addr: 'https://tronscan.org/#/address/' },
  ERC20:   { name: 'Ethereum (ERC20)',        address: /^0x[0-9a-fA-F]{40}$/,            hash: /^0x[0-9a-fA-F]{64}$/,    tx: 'https://etherscan.io/tx/', addr: 'https://etherscan.io/address/' },
  BEP20:   { name: 'BNB Smart Chain (BEP20)', address: /^0x[0-9a-fA-F]{40}$/,            hash: /^0x[0-9a-fA-F]{64}$/,    tx: 'https://bscscan.com/tx/', addr: 'https://bscscan.com/address/' },
  POLYGON: { name: 'Polygon',                 address: /^0x[0-9a-fA-F]{40}$/,            hash: /^0x[0-9a-fA-F]{64}$/,    tx: 'https://polygonscan.com/tx/', addr: 'https://polygonscan.com/address/' },
  SOLANA:  { name: 'Solana',                  address: new RegExp(`^${B58}{32,44}$`),   hash: new RegExp(`^${B58}{64,90}$`), tx: 'https://solscan.io/tx/', addr: 'https://solscan.io/account/' },
  BITCOIN: { name: 'Bitcoin',                 address: /^(bc1[02-9ac-hj-np-z]{11,71}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/, hash: /^[0-9a-fA-F]{64}$/, tx: 'https://mempool.space/tx/', addr: 'https://mempool.space/address/' },
};
const ASSETS = ['USDT', 'USDC', 'BTC', 'ETH', 'BNB', 'SOL'];
// Which networks make sense for each asset (used to warn on obvious mistakes)
const ASSET_NETWORKS = {
  USDT: ['TRC20', 'ERC20', 'BEP20', 'POLYGON', 'SOLANA'],
  USDC: ['ERC20', 'BEP20', 'POLYGON', 'SOLANA'],
  BTC: ['BITCOIN'],
  ETH: ['ERC20'],
  BNB: ['BEP20'],
  SOL: ['SOLANA'],
};

function validAddress(network, address) {
  const n = NETWORKS[network];
  return !!(n && typeof address === 'string' && n.address.test(address));
}
function validHash(network, hash) {
  const n = NETWORKS[network];
  return !!(n && typeof hash === 'string' && n.hash.test(hash));
}
function validPair(asset, network) {
  return !!(ASSET_NETWORKS[asset] && ASSET_NETWORKS[asset].includes(network));
}
function txUrl(network, hash) {
  const n = NETWORKS[network];
  return n && hash ? n.tx + encodeURIComponent(hash) : null;
}
function addrUrl(network, address) {
  const n = NETWORKS[network];
  return n && address ? n.addr + encodeURIComponent(address) : null;
}
function networkName(network) {
  return NETWORKS[network] ? NETWORKS[network].name : network;
}
function shortAddr(a) {
  if (!a) return '';
  return a.length > 18 ? a.slice(0, 8) + '…' + a.slice(-6) : a;
}
async function qrDataUri(text) {
  const svg = await QRCode.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#0A1733', light: '#FFFFFF' } });
  return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
}

module.exports = { NETWORKS, ASSETS, ASSET_NETWORKS, validAddress, validHash, validPair, txUrl, addrUrl, networkName, shortAddr, qrDataUri };
