// Xtractor Production Packager
// Builds a clean, production-ready .zip file for Chrome Web Store & Edge Add-ons deployment.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const crypto = require('crypto');

const ROOT_DIR = __dirname;
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const STAGING_DIR = path.join(DIST_DIR, 'staging');

const manifestPath = path.join(ROOT_DIR, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const version = manifest.version || '1.0.0';
const zipFileName = `xtractor-v${version}.zip`;
const zipFilePath = path.join(DIST_DIR, zipFileName);

// Production directories and files to include
const INCLUDE_ITEMS = [
  'manifest.json',
  'icons',
  'background',
  'content',
  'popup',
  'stream-downloader',
  'recorder',
  'options'
];

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
    fs.readdirSync(src).forEach(child => {
      copyRecursive(path.join(src, child), path.join(dest, child));
    });
  } else {
    fs.copyFileSync(src, dest);
  }
}

function build() {
  console.log(`Packaging Xtractor v${version}...`);

  // 1. Ensure dist directory exists
  if (!fs.existsSync(DIST_DIR)) {
    fs.mkdirSync(DIST_DIR, { recursive: true });
  }

  // 2. Clean old zip and staging
  if (fs.existsSync(zipFilePath)) fs.unlinkSync(zipFilePath);
  if (fs.existsSync(STAGING_DIR)) fs.rmSync(STAGING_DIR, { recursive: true, force: true });

  fs.mkdirSync(STAGING_DIR, { recursive: true });

  // 3. Copy only production files into staging
  INCLUDE_ITEMS.forEach(item => {
    const srcPath = path.join(ROOT_DIR, item);
    const destPath = path.join(STAGING_DIR, item);
    if (fs.existsSync(srcPath)) {
      copyRecursive(srcPath, destPath);
      console.log(`  + Added: ${item}`);
    } else {
      console.warn(`  ! Warning: ${item} not found`);
    }
  });

  // 4. Create ZIP using .NET ZipFile
  const psCmd = `powershell -Command "Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory('${STAGING_DIR}', '${zipFilePath}')"`;
  execSync(psCmd, { stdio: 'inherit' });

  // 5. Cleanup staging
  fs.rmSync(STAGING_DIR, { recursive: true, force: true });

  // 6. Calculate checksum & size
  const zipBuf = fs.readFileSync(zipFilePath);
  const hash = crypto.createHash('sha256').update(zipBuf).digest('hex');
  const sizeKb = (zipBuf.length / 1024).toFixed(1);

  console.log('\n======================================================');
  console.log(`Package created successfully: ${zipFileName}`);
  console.log(`Path: ${zipFilePath}`);
  console.log(`Size: ${sizeKb} KB`);
  console.log(`SHA-256: ${hash}`);
  console.log('======================================================\n');
  console.log('Ready to upload to Chrome Web Store or Edge Add-ons Developer Dashboard!');
}

build();
