import { writeFile } from 'node:fs/promises';
const names = [
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'https_proxy',
  'http_proxy',
  'no_proxy',
  'all_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
];
const environment = Object.fromEntries(
  names.filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]]),
);
await writeFile('/run/principal/login-environment.json', JSON.stringify(environment), {
  mode: 0o600,
});
