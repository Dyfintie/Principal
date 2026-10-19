import { cp, mkdir, readFile, rm, stat, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

async function main() {
  console.log('📦 Packaging Principal CLI for distribution...');

  // 1. Ensure build is fresh
  console.log('  • Building TypeScript and recording runtime...');
  execFileSync(process.execPath, [path.join(rootDir, 'scripts', 'workflow.mjs'), 'build'], {
    cwd: rootDir,
    stdio: 'inherit',
  });

  // 2. Read package metadata
  const pkg = JSON.parse(await readFile(path.join(rootDir, 'package.json'), 'utf8'));
  const version = pkg.version || '0.1.0';
  const platform = process.platform;
  const arch = process.arch;

  const distPackageDir = path.join(rootDir, 'dist-package');
  const stagingDir = path.join(distPackageDir, 'staging');
  const bundleDir = path.join(stagingDir, 'principal');

  // Clean staging
  await rm(stagingDir, { recursive: true, force: true });
  await mkdir(bundleDir, { recursive: true });

  console.log(`  • Staging files for ${platform}-${arch} (v${version})...`);

  // 3. Copy essential files
  await cp(path.join(rootDir, 'bin'), path.join(bundleDir, 'bin'), { recursive: true });
  await cp(path.join(rootDir, 'dist'), path.join(bundleDir, 'dist'), { recursive: true });
  await cp(path.join(rootDir, 'runtime'), path.join(bundleDir, 'runtime'), { recursive: true });
  await cp(path.join(rootDir, 'docs'), path.join(bundleDir, 'docs'), { recursive: true });
  await cp(path.join(rootDir, 'package.json'), path.join(bundleDir, 'package.json'));
  await cp(path.join(rootDir, 'README.md'), path.join(bundleDir, 'README.md'));
  
  if (await stat(path.join(rootDir, 'install.sh')).catch(() => null)) {
    await cp(path.join(rootDir, 'install.sh'), path.join(bundleDir, 'install.sh'));
    await chmod(path.join(bundleDir, 'install.sh'), 0o755);
  }

  // 4. Copy production node_modules (excluding typescript and @types dev dependencies)
  console.log('  • Bundling pre-compiled production dependencies (zero-compile install)...');
  const nodeModulesSrc = path.join(rootDir, 'node_modules');
  const nodeModulesDest = path.join(bundleDir, 'node_modules');

  await cp(nodeModulesSrc, nodeModulesDest, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(nodeModulesSrc, src);
      if (!rel) return true;
      if (rel === 'typescript' || rel.startsWith('typescript' + path.sep)) return false;
      if (rel === '@types' || rel.startsWith('@types' + path.sep)) return false;
      if (rel === '.bin' + path.sep + 'tsc') return false;
      if (rel.endsWith('.cache')) return false;
      return true;
    },
  });

  // Ensure binaries in bin/ are executable
  await chmod(path.join(bundleDir, 'bin', 'principal.mjs'), 0o755);
  await chmod(path.join(bundleDir, 'bin', 'principal-mcp.mjs'), 0o755);

  // 5. Create distribution tarball
  const tarballName = `principal-v${version}-${platform}-${arch}.tar.gz`;
  const genericTarballName = `principal-${platform}-${arch}.tar.gz`;
  const tarballPath = path.join(distPackageDir, tarballName);
  const genericTarballPath = path.join(distPackageDir, genericTarballName);

  console.log(`  • Creating compressed tarball: ${tarballName}...`);
  execFileSync('tar', ['-czf', tarballPath, '-C', stagingDir, 'principal']);
  execFileSync('cp', ['-f', tarballPath, genericTarballPath]);

  // Clean staging
  await rm(stagingDir, { recursive: true, force: true });

  // 6. Generate Self-Extracting Standalone Installer Script (principal-installer.sh)
  console.log('  • Creating self-extracting standalone installer (principal-installer.sh)...');
  const installShPath = path.join(rootDir, 'install.sh');
  const installShContent = await readFile(installShPath);
  const tarballBytes = await readFile(tarballPath);
  const selfExtractingPath = path.join(distPackageDir, 'principal-installer.sh');

  const { writeFile } = await import('node:fs/promises');
  await writeFile(
    selfExtractingPath,
    Buffer.concat([
      installShContent,
      Buffer.from('\n__ARCHIVE_MARKER__\n', 'utf8'),
      tarballBytes,
    ]),
  );
  await chmod(selfExtractingPath, 0o755);

  // 7. Copy standalone curlable install.sh into dist-package/
  await cp(installShPath, path.join(distPackageDir, 'install.sh'));
  await chmod(path.join(distPackageDir, 'install.sh'), 0o755);

  // 8. Generate NPM Package Tarball (for npm install -g)
  console.log('  • Building global NPM package (npm pack)...');
  execFileSync('npm', ['pack', '--pack-destination', distPackageDir], {
    cwd: rootDir,
    stdio: 'ignore',
  });

  // 9. Compute checksum and stats
  const fileBytes = await readFile(tarballPath);
  const sha256 = createHash('sha256').update(fileBytes).digest('hex');
  const sizeMb = (fileBytes.length / (1024 * 1024)).toFixed(2);
  const selfExtractMb = (await stat(selfExtractingPath)).size / (1024 * 1024);

  console.log('');
  console.log('================================================================');
  console.log('🎉 Principal Multi-Distribution Packages Created!');
  console.log('================================================================');
  console.log('  [1] Self-Extracting Single-File Script:');
  console.log(`      dist-package/principal-installer.sh (${selfExtractMb.toFixed(2)} MB)`);
  console.log('      Run: bash principal-installer.sh');
  console.log('');
  console.log('  [2] Standalone Tarball (Zero-Compile):');
  console.log(`      dist-package/${tarballName} (${sizeMb} MB)`);
  console.log(`      dist-package/${genericTarballName}`);
  console.log(`      SHA-256: ${sha256}`);
  console.log('');
  console.log('  [3] Global NPM Package (Codex & Claude Code feel):');
  console.log(`      dist-package/principal-cli-${version}.tgz`);
  console.log(`      Run: npm install -g dist-package/principal-cli-${version}.tgz`);
  console.log('');
  console.log('  [4] One-Liner Curl Installer (Antigravity feel):');
  console.log('      curl -fsSL <url>/install.sh | bash');
  console.log('================================================================');
}

main().catch((err) => {
  console.error('Packaging failed:', err);
  process.exit(1);
});
